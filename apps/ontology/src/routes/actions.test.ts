/** Test admission ordering and attribution without live database writes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { db } from '../db.ts'
import { actionHandlers } from '../actions/index.ts'
import { actionRoutes } from './actions.ts'

await test('action route caller policy and access logging', async (t) => {
  const original = { withSchema: db.withSchema, selectFrom: db.selectFrom, handler: actionHandlers['proposal.approve'] }
  let callers: string[] | null | undefined
  let failLog = false, failHandler = false, actionExists = true
  const logs: Record<string, any>[] = [], identities: string[] = [], schemas: string[] = []
  function builder(row: unknown): any {
    const query = { selectAll: () => query, select: () => query, where: () => query, executeTakeFirst: async () => row }
    return query
  }
  // Keep the real HTTP pipeline; replace only persistence and business execution.
  db.withSchema = ((schema: string) => {
    schemas.push(schema)
    return {
      selectFrom: (table: string) => builder({
        object_type: { id: 'proposal-type', api_name: 'proposal', schema: 'manufacturing', datasource_table: 'proposal' },
        action_type: actionExists ? { id: 'approve-action', api_name: 'approve', allowed_callers: callers,
          parameter_schema: { type: 'object', properties: { decisionNote: { type: 'string' } }, additionalProperties: false } } : undefined,
        property: { datasource_column: 'id' },
      }[table]),
      insertInto: (table: string) => {
        assert.equal(table, 'access_log')
        return { values: (row: Record<string, any>) => ({ execute: async () => {
          if (failLog) throw new Error('Access log unavailable')
          logs.push(row)
        } }) }
      },
    }
  }) as unknown as typeof db.withSchema
  db.selectFrom = (() => builder({ id: 42, status: 'pending' })) as typeof db.selectFrom
  actionHandlers['proposal.approve'] = async (_instance, _params, context) => {
    assert.equal(logs.at(-1)!.caller_identity, context.callerIdentity)
    assert.equal(logs.at(-1)!.decision, 'allowed')
    assert.equal(context.actor, context.callerIdentity)
    identities.push(context.callerIdentity!)
    if (failHandler) throw new Error('Batch is no longer queued')
    return { status: 'approved' }
  }
  const invoke = (headers: Record<string, string> = {}, body = '{}') => actionRoutes.request('/proposal/42/actions/approve', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  })
  try {
    await t.test('listed callers execute with matching log and handler identities', async () => {
      callers = ['brewmaster-lee', 'verification-agent']
      for (const identity of callers) {
        assert.equal((await invoke({ 'x-caller-identity': identity, 'x-actor': 'legacy' })).status, 200)
        assert.equal(logs.at(-1)!.reason, 'Caller is listed in allowed_callers')
      }
      assert.deepEqual(identities, callers)
      assert.ok(schemas.every(schema => schema === 'manufacturing'))
      assert.equal(logs[0]!.action_type, 'proposal.approve')
      assert.equal(logs[0]!.target_type, 'proposal')
      assert.equal(logs[0]!.target_id, '42')
      assert.ok(logs[0]!.timestamp instanceof Date)
    })
    await t.test('denial precedes body validation; x-actor cannot grant access', async () => {
      const before = identities.length
      const headersList: Record<string, string>[] = [{ 'x-caller-identity': 'planning-agent' }, {}, { 'x-actor': 'brewmaster-lee' }]
      for (const headers of headersList) {
        const response = await invoke(headers, '{broken JSON')
        assert.equal(response.status, 403)
        assert.deepEqual(await response.json(), { error: 'Caller is not permitted to invoke this action' })
        assert.equal(logs.at(-1)!.decision, 'denied')
      }
      assert.equal(logs.at(-1)!.caller_identity, 'system')
      assert.equal(identities.length, before)
    })
    await t.test('missing, null and empty lists are unrestricted with system as default', async () => {
      for (const policy of [undefined, null, []]) {
        callers = policy
        assert.equal((await invoke()).status, 200)
        assert.equal(identities.at(-1), 'system')
        assert.equal(logs.at(-1)!.decision, 'allowed')
        assert.equal(logs.at(-1)!.reason, 'Action has no caller restriction')
      }
    })
    await t.test('allowed logs persist when input validation or business execution fails', async () => {
      callers = ['brewmaster-lee']
      const before = identities.length
      for (const body of ['{broken JSON', '{"decisionNote":42}']) {
        assert.equal((await invoke({ 'x-caller-identity': 'brewmaster-lee' }, body)).status, 400)
        assert.equal(logs.at(-1)!.decision, 'allowed')
      }
      assert.equal(identities.length, before)
      failHandler = true
      const failed = await invoke({ 'x-caller-identity': 'brewmaster-lee' })
      assert.equal(failed.status, 400)
      assert.deepEqual(await failed.json(), { error: 'Batch is no longer queued' })
      assert.equal(logs.at(-1)!.decision, 'allowed')
      failHandler = false
    })
    await t.test('unknown actions have no admission log; logging failure blocks execution', async () => {
      const beforeLogs = logs.length, beforeHandlers = identities.length
      actionExists = false
      assert.equal((await invoke()).status, 404)
      assert.equal(logs.length, beforeLogs)
      actionExists = true
      failLog = true
      assert.equal((await invoke({ 'x-caller-identity': 'brewmaster-lee' })).status, 500)
      assert.equal(identities.length, beforeHandlers)
      assert.equal(logs.length, beforeLogs)
    })
  } finally {
    db.withSchema = original.withSchema
    db.selectFrom = original.selectFrom
    actionHandlers['proposal.approve'] = original.handler!
    await db.destroy()
  }
})
