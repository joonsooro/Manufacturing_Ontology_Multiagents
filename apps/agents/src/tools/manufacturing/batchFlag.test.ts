/** Exercise the new write capability without invoking a model or mutating live ontology data. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { executeBatchFlag } from './batchFlag.ts'

test('batch_flag routes the target separately, preserves evidence and identity, and propagates failures', async () => {
  const originalFetch = globalThis.fetch
  const oldUrl = process.env.ONTOLOGY_URL
  const oldIdentity = process.env.CALLER_IDENTITY
  process.env.ONTOLOGY_URL = 'http://ontology.test/'
  process.env.CALLER_IDENTITY = 'monitoring-agent'
  const reason = 'B/1 day 3: sugar 1.04 vs REC-1 target 1.02 (+0.02). QT-1: "Recoverable; corrective attention needed."'
  const flag = { id: 'FL-test', batch_id: 'B/1', reason, severity: 'medium', status: 'open' }
  let requests = 0
  globalThis.fetch = async (url, init) => {
    requests++
    assert.equal(String(url), 'http://ontology.test/api/objects/batch/B%2F1/actions/flag')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { reason, severity: 'medium' })
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('x-caller-identity'), 'monitoring-agent')
    assert.equal(headers.get('x-actor'), 'monitoring-agent')
    return Response.json(flag)
  }
  try {
    assert.deepEqual(await executeBatchFlag({ batchId: 'B/1', reason, severity: 'medium' }), flag)
    // Invalid local inputs must never reach the action endpoint.
    await assert.rejects(executeBatchFlag({ batchId: ' ', reason, severity: 'medium' }))
    await assert.rejects(executeBatchFlag({ batchId: 'B/1', reason: ' ', severity: 'low' }))
    await assert.rejects(executeBatchFlag({ batchId: 'B/1', reason, severity: 'critical' as 'high' }))
    assert.equal(requests, 1)
    globalThis.fetch = async () => Response.json({ error: 'Batch no longer exists' }, { status: 404 })
    await assert.rejects(executeBatchFlag({ batchId: 'B/1', reason, severity: 'medium' }), /Batch no longer exists/)
  } finally {
    globalThis.fetch = originalFetch
    if (oldUrl === undefined) delete process.env.ONTOLOGY_URL
    else process.env.ONTOLOGY_URL = oldUrl
    if (oldIdentity === undefined) delete process.env.CALLER_IDENTITY
    else process.env.CALLER_IDENTITY = oldIdentity
  }
})

test('monitoring MCP allowlist advertises and dispatches batch_flag but rejects operational actions', () => {
  // Preload a fake HTTP transport in the real MCP subprocess, preserving its parsing and dispatch paths.
  const preload = `globalThis.fetch = async (url, init) => Response.json({
    id: 'FL-mcp-test', url: String(url), method: init.method,
    actor: new Headers(init.headers).get('x-caller-identity'), params: JSON.parse(init.body)
  });`
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    new URL('../shared/queryObjectsMcp.ts', import.meta.url).pathname,
  ], {
    env: {
      ...process.env,
      ONTOLOGY_URL: 'http://ontology.test',
      CALLER_IDENTITY: 'monitoring-agent',
      ONTOLOGY_ALLOWED_TOOLS: JSON.stringify(['query_objects', 'get_object', 'batch_flag']),
    },
    encoding: 'utf8',
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'batch_flag', arguments: { batchId: 'B-1', reason: 'QT-1: "Safety hold confirmed."', severity: 'high' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'batch_flag', arguments: { batchId: 'B-1', reason: 'Concern', severity: 'critical' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tank_schedule_maintenance', arguments: {} } },
    ].map((request) => JSON.stringify(request)).join('\n') + '\n',
    timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr)
  // Calls are handled asynchronously; correlate replies by ID rather than assuming output order.
  const replies = result.stdout.trim().split('\n').map((line) => JSON.parse(line))
  const tools = replies.find((reply) => reply.id === 1).result.tools
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name).sort(), ['batch_flag', 'get_object', 'query_objects'])
  const flagSchema = tools.find((tool: { name: string }) => tool.name === 'batch_flag').inputSchema
  assert.deepEqual(flagSchema.properties.severity.enum, ['low', 'medium', 'high'])
  assert.deepEqual(replies.find((reply) => reply.id === 2).result.structuredContent, {
    id: 'FL-mcp-test', url: 'http://ontology.test/api/objects/batch/B-1/actions/flag', method: 'POST',
    actor: 'monitoring-agent', params: { reason: 'QT-1: "Safety hold confirmed."', severity: 'high' },
  })
  assert.equal(replies.find((reply) => reply.id === 3).error.code, -32602)
  assert.match(replies.find((reply) => reply.id === 4).error.message, /Tool is not enabled/)
})
