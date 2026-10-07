/** Real PostgreSQL checks; successful fixtures are rolled back and failed writes leave no flag behind. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { db } from '../../db.ts'
import { createObjectRoutes } from '../../routes/objects.ts'
import { batchFlag } from './batchFlag.ts'
import type { ActionContext } from '../types.ts'

process.env.COURSE_NOW = '2026-04-30T09:00:00Z'
await import('../../courseClock.ts')

await test('Batch.flag storage, metadata traversal, unchanged batch, and audit rollback', async () => {
  try {
    const batch = await db.selectFrom('manufacturing.batch').selectAll().executeTakeFirstOrThrow()
    const objectType = await db.withSchema('manufacturing').selectFrom('object_type').selectAll().where('api_name', '=', 'batch').executeTakeFirstOrThrow()
    const action = await db.withSchema('manufacturing').selectFrom('action_type').selectAll()
      .where('object_type_id', '=', objectType.id).where('api_name', '=', 'flag').executeTakeFirstOrThrow()
    const context: ActionContext = {
      database: db, metadataSchema: 'manufacturing', objectTypeId: objectType.id,
      objectTypeApiName: 'batch', actionTypeId: action.id, actionApiName: 'flag',
      actor: 'legacy', callerIdentity: 'flag-reviewer', authorizedByProposal: 142,
    }
    const rollback = new Error('rollback fixture')
    await assert.rejects(db.transaction().execute(async (transaction) => {
      const flag = await batchFlag(batch, { reason: 'Investigate quality concern', severity: 'high' }, { ...context, database: transaction })
      assert.equal(flag.batch_id, batch.id)
      assert.equal(flag.status, 'open')
      assert.equal(flag.flagged_by, 'flag-reviewer')
      assert.equal(flag.resolved_at, null)
      assert.ok(flag.id.startsWith('FL-'))
      assert.ok(Math.abs(flag.flagged_at.valueOf() - Date.now()) < 10000)
      assert.deepEqual(await transaction.selectFrom('manufacturing.batch').selectAll().where('id', '=', batch.id).executeTakeFirstOrThrow(), batch)
      const audit = await transaction.withSchema('manufacturing').selectFrom('audit_log').selectAll()
        .where('action_type_id', '=', action.id).where('target_id', '=', batch.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow()
      assert.equal(audit.actor, 'flag-reviewer')
      assert.deepEqual(audit.params, { reason: 'Investigate quality concern', severity: 'high', authorizedByProposal: 142 })
      assert.equal(audit.created_at.valueOf(), flag.flagged_at.valueOf())
      // Metadata alone enables flag listing and navigation in both directions.
      const app = new Hono().route('/api/objects', createObjectRoutes(transaction))
      const detail = await app.request(`/api/objects/flagLog/${flag.id}`)
      assert.equal(detail.status, 200)
      const body = await detail.json() as any
      assert.equal(body.links.batch.data.id, batch.id)
      const batchDetail = await (await app.request(`/api/objects/batch/${batch.id}`)).json() as any
      assert.ok(batchDetail.links.flags.data.some((row: any) => row.id === flag.id))
      const list = await app.request(`/api/objects/flagLog?batchId=${encodeURIComponent(batch.id)}`)
      assert.equal(list.status, 200)
      assert.ok((await list.json() as any[]).some(row => row.id === flag.id))
      throw rollback
    }), error => error === rollback)
    const count = async () => (await db.selectFrom('manufacturing.flag_log').select('id').execute()).length
    const before = await count()
    await assert.rejects(batchFlag(batch, { reason: 'Audit must fail', severity: 'low' }, { ...context, actionTypeId: '00000000-0000-0000-0000-000000000000' }))
    assert.equal(await count(), before)
    await assert.rejects(batchFlag(batch, { reason: ' ', severity: 'medium' }, context), /non-empty reason/)
    await assert.rejects(batchFlag(batch, { reason: 'Concern', severity: 'critical' as 'high' }, context), /severity/)
  } finally { await db.destroy() }
})
