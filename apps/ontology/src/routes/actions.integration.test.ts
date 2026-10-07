/** Exercise real catalog policy and PostgreSQL access-log writes; all test entries roll back. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { db } from '../db.ts'
import { actionRoutes } from './actions.ts'

await test('action access decisions persist with the correct catalog and caller identity', async () => {
  const originalWithSchema = db.withSchema
  const targetId = `TEST-ACCESS-${randomUUID()}`
  const rollback = new Error('Rollback access-log fixtures')
  try {
    await assert.rejects(db.transaction().execute(async transaction => {
      // Only catalog/log calls are redirected into this fixture transaction. Every body is
      // invalid, so no instance lookup or business handler can mutate production objects.
      db.withSchema = ((schema: string) => transaction.withSchema(schema)) as typeof db.withSchema
      const catalog = transaction.withSchema('manufacturing')
      const policies = await catalog.selectFrom('action_type as a')
        .innerJoin('object_type as o', 'o.id', 'a.object_type_id')
        .select(['a.api_name', 'a.allowed_callers']).where('o.api_name', '=', 'proposal').execute()
      assert.deepEqual(policies.find(action => action.api_name === 'approve')!.allowed_callers,
        ['brewmaster-lee', 'verification-agent'])
      assert.equal(policies.find(action => action.api_name === 'reject')!.allowed_callers, null)

      const attempts: { type: string; action: string; headers: Record<string, string>; status: number; identity: string; decision: string }[] = [
        { type: 'proposal', action: 'approve', headers: { 'x-caller-identity': 'planning-agent' }, status: 403, identity: 'planning-agent', decision: 'denied' },
        { type: 'proposal', action: 'approve', headers: {}, status: 403, identity: 'system', decision: 'denied' },
        { type: 'proposal', action: 'approve', headers: { 'x-actor': 'brewmaster-lee' }, status: 403, identity: 'system', decision: 'denied' },
        { type: 'proposal', action: 'approve', headers: { 'x-caller-identity': 'brewmaster-lee' }, status: 400, identity: 'brewmaster-lee', decision: 'allowed' },
        { type: 'proposal', action: 'approve', headers: { 'x-caller-identity': 'verification-agent' }, status: 400, identity: 'verification-agent', decision: 'allowed' },
        { type: 'batch', action: 'flag', headers: {}, status: 400, identity: 'system', decision: 'allowed' },
      ]
      for (const attempt of attempts) {
        const response = await actionRoutes.request(`/${attempt.type}/${targetId}/actions/${attempt.action}`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...attempt.headers }, body: '{broken JSON',
        })
        assert.equal(response.status, attempt.status)
      }
      const entries = await catalog.selectFrom('access_log').selectAll().where('target_id', '=', targetId).execute()
      assert.equal(entries.length, attempts.length)
      for (const attempt of attempts) {
        assert.ok(entries.some(entry => entry.caller_identity === attempt.identity && entry.decision === attempt.decision
          && entry.action_type === `${attempt.type}.${attempt.action}` && entry.target_type === attempt.type
          && entry.reason.length > 0 && entry.timestamp instanceof Date))
      }
      // Restore before leaving the transaction so no caller retains its soon-invalid query builder.
      db.withSchema = originalWithSchema
      throw rollback
    }), error => error === rollback)
    const remaining = await db.withSchema('manufacturing').selectFrom('access_log').select('id')
      .where('target_id', '=', targetId).execute()
    assert.equal(remaining.length, 0)
  } finally {
    db.withSchema = originalWithSchema
    await db.destroy()
  }
})
