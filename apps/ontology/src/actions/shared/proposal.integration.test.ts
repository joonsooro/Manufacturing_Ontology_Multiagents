/**
 * PostgreSQL integration coverage for proposal decisions, rollback, and competing reviewers.
 * Most fixtures live in an isolated schema; manufacturing fixtures are rolled back explicitly.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'kysely'
import { db } from '../../db.ts'
import { actionHandlers } from '../index.ts'
import type { Proposal, JsonValue } from '../../schema.ts'
import { defineActionHandler, type ActionContext, type ActionHandler } from '../types.ts'
import { createProposalApprove } from './proposalApprove.ts'
import { proposalReject } from './proposalReject.ts'
import { proposalEscalate } from './proposalEscalate.ts'
import { auditParams, withActionTransaction } from './transaction.ts'

// Run explicitly with: node --env-file=.env --test apps/ontology/src/actions/shared/proposal.integration.test.ts
// Fixtures live only in a unique schema, which is removed in finally.
// Pin a known test date so review-time assertions detect accidental use of the database/wall clock.
process.env.COURSE_NOW = '2026-08-01T12:00:00.000Z'
await import('../../courseClock.ts')

// Unique schema names let competing transactions use real PostgreSQL locks without sharing test rows.
const schema = `proposal_test_${randomUUID().replaceAll('-', '')}`

await test('Proposal decisions on PostgreSQL', async (t) => {
  try {
    await sql`create schema ${sql.id(schema)}`.execute(db)
    // Clone table structures and defaults; all fixture metadata and most instances remain in this schema.
    for (const name of ['object_type', 'property', 'action_type', 'audit_log', 'proposal']) {
      await sql`create table ${sql.id(schema, name)} (like ${sql.id('manufacturing', name)} including all)`.execute(db)
    }
    await sql`create table ${sql.id(schema, 'widget')} (id text primary key, value integer not null)`.execute(db)
    // Seed a second ontology catalog to prove the shared handlers do not hardcode manufacturing storage.
    const catalog = db.withSchema(schema)
    const proposalType = await catalog.insertInto('object_type').values({
      api_name: 'proposal', name: 'Proposal', description: null, status: 'active', visibility: 'visible',
      point_of_contact: null, edits_enabled: true, schema, datasource_table: 'proposal',
    }).returningAll().executeTakeFirstOrThrow()
    const widgetType = await catalog.insertInto('object_type').values({
      api_name: 'Widget', name: 'Widget', description: null, status: 'active', visibility: 'visible',
      point_of_contact: null, edits_enabled: true, schema, datasource_table: 'widget',
    }).returningAll().executeTakeFirstOrThrow()
    for (const objectType of [proposalType, widgetType]) {
      await catalog.insertInto('property').values({
        object_type_id: objectType.id, api_name: 'id', name: 'ID', data_type: 'string',
        required: true, is_title: true, is_primary_key: true, datasource_column: 'id',
      }).execute()
    }
    const approveType = await catalog.insertInto('action_type').values({
      object_type_id: proposalType.id, api_name: 'approve', name: 'Approve', description: null,
      parameter_schema: { type: 'object', properties: { decisionNote: { type: 'string' } } },
    }).returningAll().executeTakeFirstOrThrow()
    const rejectType = await catalog.insertInto('action_type').values({
      object_type_id: proposalType.id, api_name: 'reject', name: 'Reject', description: null,
      parameter_schema: { type: 'object', properties: { decisionNote: { type: 'string' } } },
    }).returningAll().executeTakeFirstOrThrow()
    const escalateType = await catalog.insertInto('action_type').values({
      object_type_id: proposalType.id, api_name: 'escalate', name: 'Escalate', description: null,
      parameter_schema: { type: 'object', properties: { note: { type: 'string', minLength: 1 } }, required: ['note'], additionalProperties: false },
    }).returningAll().executeTakeFirstOrThrow()
    for (const name of ['increment', 'fail']) {
      await catalog.insertInto('action_type').values({
        object_type_id: widgetType.id, api_name: name, name, description: null,
        parameter_schema: { type: 'object', properties: { amount: { type: 'string' } }, required: ['amount'], additionalProperties: false },
      }).execute()
    }
    await sql`insert into ${sql.id(schema, 'widget')} values ('target-1', 0)`.execute(db)

    // Test action handlers mutate a counter and emit a real audit inside the approval transaction.
    const handlers: Record<string, ActionHandler> = {}
    const increment: ActionHandler = async (instance, params, context) => withActionTransaction(context, async (tx) => {
      assert.equal(tx.isTransaction, true)
      assert.deepEqual(Object.keys(params as object), ['amount'])
      assert.equal(context.callerIdentity, context.actor)
      const amount = Number((params as { amount: string }).amount)
      const result = await sql<{ id: string; value: number }>`update ${sql.id(schema, 'widget')}
        set value = value + ${amount} where id = ${instance.id} returning *`.execute(tx)
      const updated = result.rows[0]!
      await tx.withSchema(schema).insertInto('audit_log').values({
        action_type_id: context.actionTypeId, action_api_name: context.actionApiName,
        target_type_id: context.objectTypeId, target_type_api_name: context.objectTypeApiName,
        target_id: updated.id, actor: context.callerIdentity ?? 'system',
        params: auditParams(context, params as Record<string, JsonValue>), result: updated,
      }).execute()
      return updated
    })
    handlers['Widget.increment'] = increment
    // Fail AFTER a target mutation and inner audit to prove rollback covers more than validation errors.
    handlers['Widget.fail'] = async (...args) => {
      await increment(...args)
      throw new Error('Inner action failed after mutation and audit')
    }
    const approve = createProposalApprove(handlers)
    handlers['proposal.approve'] = defineActionHandler(approve)
    handlers['proposal.reject'] = defineActionHandler(proposalReject)
    /** Build the same dispatch context the HTTP action route supplies to a decision handler. */
    function context(action: 'approve' | 'reject' | 'escalate', callerIdentity?: string): ActionContext {
      return {
        database: db, metadataSchema: schema, objectTypeId: proposalType.id,
        objectTypeApiName: 'proposal', actionTypeId: { approve: approveType.id, reject: rejectType.id, escalate: escalateType.id }[action],
        actionApiName: action, actor: 'legacy-actor', callerIdentity,
      }
    }
    /** Persist a recommendation with business-only params and no review attribution yet. */
    async function propose(type = 'Widget.increment', params: JsonValue = { amount: '1' }, targetId = 'target-1') {
      return catalog.insertInto('proposal').values({
        type, target_id: targetId, params, rationale: 'Integration test rationale', status: 'pending',
        proposed_by: 'test-agent', proposed_at: new Date(), reviewed_by: null, reviewed_at: null, decision_note: null,
      }).returningAll().executeTakeFirstOrThrow()
    }
    /** Reload rather than trusting the stale object originally passed into the handler. */
    async function current(proposal: Proposal) {
      return catalog.selectFrom('proposal').selectAll().where('id', '=', proposal.id).executeTakeFirstOrThrow()
    }
    /** Observe committed target state from a connection outside the decision transaction. */
    async function widgetValue() {
      const result = await sql<{ value: number }>`select value from ${sql.id(schema, 'widget')} where id = 'target-1'`.execute(db)
      return result.rows[0]!.value
    }
    /** Count both decision and triggered-action audits to detect partial commits. */
    async function auditCount() {
      return (await catalog.selectFrom('audit_log').select('id').execute()).length
    }
    /** Shared failure invariant: pending proposal, empty review fields, unchanged target, no new audits. */
    async function assertPending(proposal: Proposal, value: number, audits: number) {
      const row = await current(proposal)
      assert.equal(row.status, 'pending')
      assert.equal(row.reviewed_by, null)
      assert.equal(row.reviewed_at, null)
      assert.equal(await widgetValue(), value)
      assert.equal(await auditCount(), audits)
    }

    await t.test('approve returns target result, pins review time, and links two audits to the approving user', async () => {
      const proposal = await propose()
      const result = await approve(proposal, { decisionNote: 'Approved for test' }, context('approve', 'reviewer-1'))
      assert.deepEqual(result, { id: 'target-1', value: 1 })
      const row = await current(proposal)
      assert.equal(row.status, 'approved')
      assert.equal(row.reviewed_by, 'reviewer-1')
      assert.equal(row.decision_note, 'Approved for test')
      assert.ok(Math.abs(row.reviewed_at!.valueOf() - Date.now()) < 10_000)
      const audits = await catalog.selectFrom('audit_log').selectAll().execute()
      assert.equal(audits.length, 2)
      assert.ok(audits.every(a => a.actor === 'reviewer-1'))
      assert.deepEqual(audits.find(a => a.action_api_name === 'increment')!.params,
        { amount: '1', authorizedByProposal: proposal.id })
      assert.equal(audits.find(a => a.action_api_name === 'approve')!.target_id, String(proposal.id))
      assert.deepEqual((await current(proposal)).params, { amount: '1' })
    })
    await t.test('inner failure rolls back target, inner audit, review fields, and approve audit', async () => {
      const proposal = await propose('Widget.fail')
      const value = await widgetValue(), audits = await auditCount()
      await assert.rejects(approve(proposal, undefined, context('approve', 'reviewer-2')), /Inner action failed/)
      await assertPending(proposal, value, audits)
    })
    await t.test('reject never resolves or executes an invalid underlying action; defaults actor to system', async () => {
      const proposal = await propose('unknown.action')
      const value = await widgetValue(), audits = await auditCount()
      const row = await proposalReject(proposal, undefined, context('reject'))
      assert.equal(row.status, 'rejected')
      assert.equal(row.reviewed_by, 'system')
      assert.equal(row.decision_note, null)
      assert.ok(Math.abs(row.reviewed_at!.valueOf() - Date.now()) < 10_000)
      assert.equal(await widgetValue(), value)
      assert.equal(await auditCount(), audits + 1)
      const audit = await catalog.selectFrom('audit_log').selectAll().where('target_id', '=', String(proposal.id)).executeTakeFirstOrThrow()
      assert.equal(audit.actor, 'system')
      assert.equal(audit.action_api_name, 'reject')
    })
    await t.test('exact case, malformed keys, absent handlers, invalid params, and missing targets leave pending', async () => {
      for (const [type, params, target] of [
        ['widget.increment', { amount: '1' }, 'target-1'],
        ['Widget.Increment', { amount: '1' }, 'target-1'],
        ['Widget.increment.extra', { amount: '1' }, 'target-1'],
        ['Widget.noHandler', { amount: '1' }, 'target-1'],
        ['Widget.increment', { amount: 1 }, 'target-1'],
        ['Widget.increment', { amount: '1', authorizedByProposal: 99 }, 'target-1'],
        ['Widget.increment', { amount: '1' }, 'missing'],
      ] as [string, JsonValue, string][]) {
        const proposal = await propose(type, params, target)
        const value = await widgetValue(), audits = await auditCount()
        await assert.rejects(approve(proposal, {}, context('approve')))
        await assertPending(proposal, value, audits)
      }
    })
    await t.test('two concurrent approvals execute exactly once; repeated decisions are rejected', async () => {
      const proposal = await propose()
      const value = await widgetValue(), audits = await auditCount()
      const results = await Promise.allSettled([
        approve(proposal, {}, context('approve', 'reviewer-a')),
        approve(proposal, {}, context('approve', 'reviewer-b')),
      ])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      assert.equal(results.filter(r => r.status === 'rejected').length, 1)
      assert.equal(await widgetValue(), value + 1)
      assert.equal(await auditCount(), audits + 2)
      await assert.rejects(proposalReject(proposal, {}, context('reject')), /not pending/)
      await assert.rejects(approve(proposal, {}, context('approve')), /not pending/)
    })
    await t.test('concurrent approval/rejection produce one decision and a consistent target', async () => {
      const proposal = await propose()
      const value = await widgetValue(), audits = await auditCount()
      const results = await Promise.allSettled([
        approve(proposal, {}, context('approve', 'reviewer-a')),
        proposalReject(proposal, {}, context('reject', 'reviewer-b')),
      ])
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
      const row = await current(proposal)
      assert.equal(await widgetValue(), value + (row.status === 'approved' ? 1 : 0))
      assert.equal(await auditCount(), audits + (row.status === 'approved' ? 2 : 1))
    })
    await t.test('missing proposal and invalid decision notes cannot mutate anything', async () => {
      const proposal = await propose()
      const value = await widgetValue(), audits = await auditCount()
      await assert.rejects(approve({ ...proposal, id: -1 }, {}, context('approve')), /no longer exists/)
      await assert.rejects(approve(proposal, { decisionNote: 5 } as any, context('approve')), /must be a string/)
      await assert.rejects(proposalReject(proposal, { decisionNote: null } as any, context('reject')), /must be a string/)
      await assertPending(proposal, value, audits)
    })
    await t.test('all manufacturing handlers join approval transactions and preserve the actor/proposal audit chain', async () => {
      // Exercise actual manufacturing handlers, but deliberately abort the enclosing fixture transaction.
      const rollback = new Error('Rollback manufacturing integration fixtures')
      // The sentinel is the expected rejection; any earlier handler/assertion failure still fails the test.
      await assert.rejects(db.transaction().execute(async (tx) => {
        const seedBatch = await tx.selectFrom('manufacturing.batch').selectAll().executeTakeFirstOrThrow()
        const seedTank = await tx.selectFrom('manufacturing.tank').selectAll().executeTakeFirstOrThrow()
        const productionCatalog = tx.withSchema('manufacturing')
        const productionProposalType = await productionCatalog.selectFrom('object_type').selectAll()
          .where('api_name', '=', 'proposal').executeTakeFirstOrThrow()
        const productionApproveType = await productionCatalog.selectFrom('action_type').selectAll()
          .where('object_type_id', '=', productionProposalType.id).where('api_name', '=', 'approve').executeTakeFirstOrThrow()
        for (const key of ['batch.cancel', 'batch.deferStart', 'tank.scheduleMaintenance']) {
          const targetId = `TEST-PROPOSAL-${randomUUID()}`
          let actionParams: JsonValue
          if (key === 'tank.scheduleMaintenance') {
            await tx.insertInto('manufacturing.tank').values({ ...seedTank, id: targetId, status: 'idle' }).execute()
            actionParams = { type: 'inspection', plannedAt: new Date(Date.now() + 86400000).toISOString(), notes: 'Integration test' }
          } else {
            await tx.insertInto('manufacturing.batch').values({ ...seedBatch, id: targetId, status: 'queued', assigned_tank_id: null }).execute()
            actionParams = key === 'batch.cancel' ? { reason: 'Integration test' }
              : { newPlannedStart: new Date(Date.now() + 86400000).toISOString() }
          }
          const proposal = await productionCatalog.insertInto('proposal').values({
            type: key, target_id: targetId, params: actionParams, rationale: 'Integration test',
            status: 'pending', proposed_by: 'test-agent', proposed_at: new Date(),
            reviewed_by: null, reviewed_at: null, decision_note: null,
          }).returningAll().executeTakeFirstOrThrow()
          const result = await actionHandlers['proposal.approve']!(proposal as unknown as Record<string, unknown>, {}, {
            database: tx, metadataSchema: 'manufacturing', objectTypeId: productionProposalType.id,
            objectTypeApiName: 'proposal', actionTypeId: productionApproveType.id,
            actionApiName: 'approve', actor: 'legacy-actor', callerIdentity: 'test-reviewer',
          })
          assert.equal(result.id, targetId)
          if (key === 'batch.cancel') assert.equal(result.status, 'cancelled')
          if (key === 'tank.scheduleMaintenance') assert.equal(result.status, 'maintenance')
          const audit = await productionCatalog.selectFrom('audit_log').selectAll()
            .where('target_id', '=', targetId).executeTakeFirstOrThrow()
          assert.equal(audit.actor, 'test-reviewer')
          assert.deepEqual(audit.params, { ...(actionParams as object), authorizedByProposal: proposal.id })
          const reviewed = await productionCatalog.selectFrom('proposal').selectAll()
            .where('id', '=', proposal.id).executeTakeFirstOrThrow()
          assert.equal(reviewed.status, 'approved')
        }
        // None of these production-schema fixture rows, maintenance logs, or audits are committed.
        throw rollback
      }), error => error === rollback)
    })
    await t.test('reject records a supplied decision note and user; rejected proposals cannot be approved', async () => {
      const proposal = await propose()
      await proposalReject(proposal, { decisionNote: 'Insufficient evidence' }, context('reject', 'reviewer-3'))
      const row = await current(proposal)
      assert.equal(row.decision_note, 'Insufficient evidence')
      assert.equal(row.reviewed_by, 'reviewer-3')
      await assert.rejects(approve(proposal, {}, context('approve')), /not pending/)
    })
    await t.test('escalation does not execute; later approval replaces review fields but retains both audits', async () => {
      const proposal = await propose()
      const value = await widgetValue(), audits = await auditCount()
      const note = 'QT-1 does not establish readiness; the safer-transfer claim is unsupported'
      const escalated = await proposalEscalate(proposal, { note }, context('escalate', 'verification-agent'))
      assert.equal(escalated.status, 'escalated')
      assert.equal(escalated.decision_note, note)
      assert.equal(escalated.reviewed_by, 'verification-agent')
      assert.deepEqual(escalated.params, proposal.params)
      assert.equal(await widgetValue(), value)
      assert.equal(await auditCount(), audits + 1)
      await assert.rejects(proposalEscalate(proposal, { note }, context('escalate')), /not pending/)
      // Pass the original pending snapshot: the lock must reload the escalated row before approval.
      await approve(proposal, { decisionNote: 'Human confirmed readiness' }, context('approve', 'brewmaster-lee'))
      const resolved = await current(proposal)
      assert.equal(resolved.status, 'approved')
      assert.equal(resolved.reviewed_by, 'brewmaster-lee')
      assert.equal(resolved.decision_note, 'Human confirmed readiness')
      assert.equal(await widgetValue(), value + 1)
      const history = await catalog.selectFrom('audit_log').selectAll().where('target_id', '=', String(proposal.id)).execute()
      assert.equal(history.length, 2)
      const escalation = history.find(row => row.action_api_name === 'escalate')!
      assert.equal(escalation.actor, 'verification-agent')
      assert.deepEqual(escalation.params, { note })
      assert.equal((history.find(row => row.action_api_name === 'approve')!.result as any).previousStatus, 'escalated')
    })
    await t.test('escalated invalid actions can be rejected without dispatch; invalid notes leave pending', async () => {
      const proposal = await propose('unknown.action')
      const value = await widgetValue(), audits = await auditCount()
      await assert.rejects(proposalEscalate(proposal, { note: ' ' }, context('escalate')), /note/)
      await assertPending(proposal, value, audits)
      await proposalEscalate(proposal, { note: 'Unknown underlying action' }, context('escalate', 'verification-agent'))
      const rejected = await proposalReject(proposal, { decisionNote: 'Invalid action' }, context('reject', 'brewmaster-lee'))
      assert.equal(rejected.status, 'rejected')
      assert.equal(await widgetValue(), value)
      assert.equal(await auditCount(), audits + 2)
      await assert.rejects(proposalEscalate(proposal, { note: 'Try again' }, context('escalate')), /not pending/)
    })
    await t.test('a failed approval of an escalated proposal preserves the escalation and target state', async () => {
      const proposal = await propose('Widget.fail')
      await proposalEscalate(proposal, { note: 'Needs human review' }, context('escalate', 'verification-agent'))
      const value = await widgetValue(), audits = await auditCount()
      await assert.rejects(approve(proposal, {}, context('approve', 'brewmaster-lee')), /Inner action failed/)
      const row = await current(proposal)
      assert.equal(row.status, 'escalated')
      assert.equal(row.decision_note, 'Needs human review')
      assert.equal(row.reviewed_by, 'verification-agent')
      assert.equal(await widgetValue(), value)
      assert.equal(await auditCount(), audits)
    })
  } finally {
    // Cleanup runs on both pass and failure; never leave the isolated catalog or its sequences behind.
    await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
    await db.destroy()
  }
})
