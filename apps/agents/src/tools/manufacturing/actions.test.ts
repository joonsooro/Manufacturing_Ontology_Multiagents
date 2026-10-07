/**
 * Test action HTTP wrappers with a fake fetch, and the MCP bridge as a child process.
 * This verifies request contracts and tool restrictions without changing ontology data.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { executeBatchDeferStart } from './batchDeferStart.ts'
import { executeTankScheduleMaintenance } from './tankScheduleMaintenance.ts'

test('action wrappers send parameter-only bodies, preserve identity, and reject invalid inputs/errors', async () => {
  const originalFetch = globalThis.fetch
  const oldUrl = process.env.ONTOLOGY_URL
  const oldIdentity = process.env.CALLER_IDENTITY
  process.env.ONTOLOGY_URL = 'http://ontology.test/'
  process.env.CALLER_IDENTITY = 'test-agent'
  const requests: { url: string; init: RequestInit }[] = []
  // Capture outgoing requests without reaching a live ontology or performing domain mutations.
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! })
    return Response.json({ status: 'updated' })
  }
  try {
    const datetime = '2026-05-01T09:00:00Z'
    assert.deepEqual(await executeBatchDeferStart({ batchId: 'B/2122', newPlannedStart: datetime }), { status: 'updated' })
    await executeTankScheduleMaintenance({ tankId: 'T-8', type: 'inspection', plannedAt: datetime, notes: 'Inspect tank.' })
    assert.equal(requests[0]!.url, 'http://ontology.test/api/objects/batch/B%2F2122/actions/deferStart')
    assert.equal(requests[1]!.url, 'http://ontology.test/api/objects/tank/T-8/actions/scheduleMaintenance')
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { newPlannedStart: datetime })
    assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { type: 'inspection', plannedAt: datetime, notes: 'Inspect tank.' })
    for (const request of requests) {
      assert.equal(request.init.method, 'POST')
      const headers = new Headers(request.init.headers)
      assert.equal(headers.get('x-caller-identity'), 'test-agent')
      assert.equal(headers.get('x-actor'), 'test-agent')
    }
    await assert.rejects(executeBatchDeferStart({ batchId: 'B-2122', newPlannedStart: 'tomorrow' }))
    await assert.rejects(executeTankScheduleMaintenance({ tankId: 'T-8', type: 'invalid' as 'inspection', plannedAt: datetime, notes: '' }))
    assert.equal(requests.length, 2)
    globalThis.fetch = async () => Response.json({ error: 'Tank has a fermenting batch' }, { status: 400 })
    await assert.rejects(executeTankScheduleMaintenance({ tankId: 'T-8', type: 'inspection', plannedAt: datetime, notes: '' }), /Tank has a fermenting batch/)
  // Tests mutate process globals; restore them so later cases do not inherit this fixture.
  } finally {
    globalThis.fetch = originalFetch
    if (oldUrl === undefined) delete process.env.ONTOLOGY_URL
    else process.env.ONTOLOGY_URL = oldUrl
    if (oldIdentity === undefined) delete process.env.CALLER_IDENTITY
    else process.env.CALLER_IDENTITY = oldIdentity
  }
})

test('MCP bridge exposes only explicitly enabled tools and rejects a disabled write tool', () => {
  // Run the real stdio bridge with one write tool enabled and attempt to call a different, disabled tool.
  const result = spawnSync(process.execPath, [new URL('../shared/queryObjectsMcp.ts', import.meta.url).pathname], {
    env: { ...process.env, ONTOLOGY_ALLOWED_TOOLS: JSON.stringify(['batch_defer_start']) },
    encoding: 'utf8',
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tank_schedule_maintenance', arguments: {} } },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n',
    timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(replies.find((reply) => reply.id === 1).result.tools.map((tool: { name: string }) => tool.name), ['batch_defer_start'])
  assert.match(replies.find((reply) => reply.id === 2).error.message, /Tool is not enabled/)
})
