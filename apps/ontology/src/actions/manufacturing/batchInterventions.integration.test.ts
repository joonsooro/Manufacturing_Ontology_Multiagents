/** Real PostgreSQL action/approval checks; every synthetic batch and business change is rolled back. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Validator, type Schema } from '@cfworker/json-schema'
import type { Transaction } from 'kysely'
import { db } from '../../db.ts'
import type { BatchTable, Database } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { actionHandlers } from '../index.ts'
import { createProposalApprove } from '../shared/proposalApprove.ts'
import { batchPlaceOnHold } from './batchPlaceOnHold.ts'
import { batchExtendRest } from './batchExtendRest.ts'
import { batchScheduleEarlyTransfer } from './batchScheduleEarlyTransfer.ts'

process.env.COURSE_NOW = '2026-04-30T09:00:00Z'
await import('../../courseClock.ts')

await test('batch intervention metadata, batch-local mutations, current-state guards, audit, and approval', async (t) => {
  try {
    const source = await db.selectFrom('manufacturing.batch').selectAll().executeTakeFirstOrThrow()
    const catalog = db.withSchema('manufacturing')
    const batchType = await catalog.selectFrom('object_type').selectAll().where('api_name', '=', 'batch').executeTakeFirstOrThrow()
    const actions = await catalog.selectFrom('action_type').selectAll().where('object_type_id', '=', batchType.id).execute()
    const contextFor = (name: string, transaction: Transaction<Database>): ActionContext => ({
      database: transaction, metadataSchema: 'manufacturing', objectTypeId: batchType.id,
      objectTypeApiName: 'batch', actionTypeId: actions.find(action => action.api_name === name)!.id,
      actionApiName: name, actor: 'legacy', callerIdentity: 'intervention-reviewer', authorizedByProposal: 142,
    })
    type Fixture = { transaction: Transaction<Database>; batch: BatchTable; neighbor: BatchTable }
    const withFixture = async (run: (fixture: Fixture) => Promise<void>) => {
      const rollback = new Error('rollback test fixture')
      await assert.rejects(db.transaction().execute(async (transaction) => {
        const planned = new Date(Date.now() + 10 * 86_400_000)
        const batch = await transaction.insertInto('manufacturing.batch').values({ ...source, id: `B-TEST-${randomUUID()}`, status: 'fermenting', planned_transfer_at: planned }).returningAll().executeTakeFirstOrThrow()
        const neighbor = await transaction.insertInto('manufacturing.batch').values({ ...source, id: `B-TEST-${randomUUID()}`, status: 'conditioning', planned_transfer_at: planned }).returningAll().executeTakeFirstOrThrow()
        await run({ transaction, batch, neighbor })
        throw rollback
      }), error => error === rollback)
    }

    await t.test('metadata publishes all handlers and validates positive integer durations', async () => {
      for (const name of ['placeOnHold', 'extendRest', 'scheduleEarlyTransfer']) {
        assert.ok(actions.find(action => action.api_name === name), `Missing ${name} metadata`)
        assert.ok(actionHandlers[`batch.${name}`], `Missing ${name} handler`)
      }
      const validator = new Validator(actions.find(action => action.api_name === 'extendRest')!.parameter_schema as Schema, '2020-12', false)
      assert.equal(validator.validate({ additionalDays: 2 }).valid, true)
      for (const params of [{ additionalDays: 0 }, { additionalDays: 1.5 }, { additionalDays: '2' }, { additionalDays: 2, rationale: 'extra' }]) {
        assert.equal(validator.validate(params).valid, false)
      }
      const property = await catalog.selectFrom('property').selectAll().where('object_type_id', '=', batchType.id).where('api_name', '=', 'plannedTransferAt').executeTakeFirstOrThrow()
      assert.equal(property.datasource_column, 'planned_transfer_at')
    })

    await t.test('rest and early transfer preserve status/resources and do not cascade; hold preserves schedule', () => withFixture(async ({ transaction, batch, neighbor }) => {
      const rest = await batchExtendRest(batch, { additionalDays: 2 }, contextFor('extendRest', transaction))
      const expected = new Date(batch.planned_transfer_at!.valueOf() + 2 * 86_400_000)
      assert.deepEqual(rest, { ...batch, planned_transfer_at: expected })
      const earlier = new Date(batch.planned_transfer_at!.valueOf() - 86_400_000)
      const transfer = await batchScheduleEarlyTransfer(batch, { plannedAt: earlier.toISOString() }, contextFor('scheduleEarlyTransfer', transaction))
      assert.deepEqual(transfer, { ...batch, planned_transfer_at: earlier })
      assert.deepEqual(await transaction.selectFrom('manufacturing.batch').selectAll().where('id', '=', neighbor.id).executeTakeFirstOrThrow(), neighbor)
      const audit = await transaction.withSchema('manufacturing').selectFrom('audit_log').selectAll().where('target_id', '=', batch.id).where('action_api_name', '=', 'extendRest').executeTakeFirstOrThrow()
      assert.equal(audit.actor, 'intervention-reviewer')
      assert.deepEqual(audit.params, { additionalDays: 2, authorizedByProposal: 142 })
      assert.equal((audit.result as any).plannedTransferAt, expected.toISOString())
      const held = await batchPlaceOnHold(batch, { reason: 'QT-TEST: immediate safety hold recommended' }, contextFor('placeOnHold', transaction))
      assert.deepEqual(held, { ...transfer, status: 'onHold' })
      const holdAudit = await transaction.withSchema('manufacturing').selectFrom('audit_log').selectAll().where('target_id', '=', batch.id).where('action_api_name', '=', 'placeOnHold').executeTakeFirstOrThrow()
      assert.equal(holdAudit.actor, 'intervention-reviewer')
      assert.equal((holdAudit.params as any).reason, 'QT-TEST: immediate safety hold recommended')
      // A stale fermenting snapshot must not bypass the stored onHold status.
      await assert.rejects(batchExtendRest(batch, { additionalDays: 1 }, contextFor('extendRest', transaction)), /status onHold/)
      await assert.rejects(batchScheduleEarlyTransfer(batch, { plannedAt: earlier.toISOString() }, contextFor('scheduleEarlyTransfer', transaction)), /status onHold/)
    }))

    await t.test('conditioning is eligible, while invalid state, missing baseline, and invalid timing are rejected', () => withFixture(async ({ transaction, batch, neighbor }) => {
      const extended = await batchExtendRest(neighbor, { additionalDays: 1 }, contextFor('extendRest', transaction))
      assert.equal(extended.status, 'conditioning')
      await assert.rejects(batchPlaceOnHold(batch, { reason: ' ' }, contextFor('placeOnHold', transaction)), /non-empty reason/)
      for (const additionalDays of [0, -1, 1.5, Infinity]) {
        await assert.rejects(batchExtendRest(batch, { additionalDays }, contextFor('extendRest', transaction)), /positive integer/)
      }
      for (const plannedAt of [new Date(Date.now() - 1000).toISOString(), batch.planned_transfer_at!.toISOString(), new Date(batch.planned_transfer_at!.valueOf() + 1000).toISOString()]) {
        await assert.rejects(batchScheduleEarlyTransfer(batch, { plannedAt }, contextFor('scheduleEarlyTransfer', transaction)), /future and earlier/)
      }
      await assert.rejects(batchScheduleEarlyTransfer(batch, { plannedAt: 'tomorrow' }, contextFor('scheduleEarlyTransfer', transaction)), /timezone/)
      await transaction.updateTable('manufacturing.batch').set({ planned_transfer_at: null }).where('id', '=', batch.id).execute()
      await assert.rejects(batchExtendRest(batch, { additionalDays: 1 }, contextFor('extendRest', transaction)), /no valid planned transfer/)
      await assert.rejects(batchScheduleEarlyTransfer(batch, { plannedAt: new Date(Date.now() + 10000).toISOString() }, contextFor('scheduleEarlyTransfer', transaction)), /no valid planned transfer/)
      await transaction.updateTable('manufacturing.batch').set({ status: 'queued' }).where('id', '=', batch.id).execute()
      await assert.rejects(batchPlaceOnHold(batch, { reason: 'Hold' }, contextFor('placeOnHold', transaction)), /status queued/)
    }))

    await t.test('proposal approval executes numeric rest params as reviewer and records authorization', () => withFixture(async ({ transaction, batch }) => {
      const proposal = await transaction.insertInto('manufacturing.proposal').values({
        type: 'batch.extendRest', target_id: batch.id, params: { additionalDays: 2 }, rationale: 'QT-TEST: conditions improving; additional rest needed',
        status: 'pending', proposed_by: 'planning-agent', proposed_at: new Date(), reviewed_by: null, reviewed_at: null, decision_note: null,
      }).returningAll().executeTakeFirstOrThrow()
      const proposalType = await transaction.withSchema('manufacturing').selectFrom('object_type').selectAll().where('api_name', '=', 'proposal').executeTakeFirstOrThrow()
      const approvalType = await transaction.withSchema('manufacturing').selectFrom('action_type').selectAll().where('object_type_id', '=', proposalType.id).where('api_name', '=', 'approve').executeTakeFirstOrThrow()
      const result = await createProposalApprove(actionHandlers)(proposal, {}, {
        database: transaction, metadataSchema: 'manufacturing', objectTypeId: proposalType.id, objectTypeApiName: 'proposal',
        actionTypeId: approvalType.id, actionApiName: 'approve', actor: 'legacy', callerIdentity: 'approval-reviewer',
      })
      assert.equal((result.planned_transfer_at as Date).valueOf(), batch.planned_transfer_at!.valueOf() + 2 * 86_400_000)
      const approved = await transaction.selectFrom('manufacturing.proposal').selectAll().where('id', '=', proposal.id).executeTakeFirstOrThrow()
      assert.equal(approved.status, 'approved')
      assert.equal(approved.reviewed_by, 'approval-reviewer')
      const audit = await transaction.withSchema('manufacturing').selectFrom('audit_log').selectAll().where('target_id', '=', batch.id).where('action_api_name', '=', 'extendRest').executeTakeFirstOrThrow()
      assert.equal(audit.actor, 'approval-reviewer')
      assert.deepEqual(audit.params, { additionalDays: 2, authorizedByProposal: proposal.id })
    }))

    await t.test('audit failure rolls back each mutation and synthetic batch', async () => {
      for (const name of ['placeOnHold', 'extendRest', 'scheduleEarlyTransfer']) {
        const fixtureId = `B-TEST-${randomUUID()}`
        await assert.rejects(db.transaction().execute(async (transaction) => {
          const batch = await transaction.insertInto('manufacturing.batch').values({ ...source, id: fixtureId, status: 'fermenting', planned_transfer_at: new Date(Date.now() + 10 * 86_400_000) }).returningAll().executeTakeFirstOrThrow()
          const context = { ...contextFor(name, transaction), actionTypeId: '00000000-0000-0000-0000-000000000000' }
          if (name === 'placeOnHold') await batchPlaceOnHold(batch, { reason: 'Hold' }, context)
          if (name === 'extendRest') await batchExtendRest(batch, { additionalDays: 1 }, context)
          if (name === 'scheduleEarlyTransfer') await batchScheduleEarlyTransfer(batch, { plannedAt: new Date(Date.now() + 86_400_000).toISOString() }, context)
        }), (error: any) => error.code === '23503')
        assert.equal(await db.selectFrom('manufacturing.batch').select('id').where('id', '=', fixtureId).executeTakeFirst(), undefined)
        assert.equal(await catalog.selectFrom('audit_log').select('id').where('target_id', '=', fixtureId).executeTakeFirst(), undefined)
      }
    })
  } finally { await db.destroy() }
})
