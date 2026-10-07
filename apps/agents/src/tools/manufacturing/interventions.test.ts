/** Verify planning tool payloads, provenance, and MCP capability boundaries without live writes. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { executeBatchPlaceOnHold } from './batchPlaceOnHold.ts'
import { executeProposeBatchExtendRest } from './proposeBatchExtendRest.ts'
import { executeProposeBatchScheduleEarlyTransfer } from './proposeBatchScheduleEarlyTransfer.ts'

test('planning tools execute holds directly and persist numeric/rest or datetime/transfer proposals with planning provenance', async () => {
  const originalFetch = globalThis.fetch
  const previous = { url: process.env.ONTOLOGY_URL, identity: process.env.CALLER_IDENTITY, clock: process.env.COURSE_NOW }
  process.env.ONTOLOGY_URL = 'http://ontology.test/'
  process.env.CALLER_IDENTITY = 'planning-agent'
  process.env.COURSE_NOW = '2026-04-30T09:00:00Z'
  const requests: { url: string; body: any; actor: string | null }[] = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)), actor: new Headers(init?.headers).get('x-caller-identity') })
    return Response.json(String(url).endsWith('/proposal') ? { id: requests.length } : { id: 'B/1', status: 'onHold' })
  }
  try {
    assert.deepEqual(await executeBatchPlaceOnHold({ batchId: 'B/1', reason: 'QT-1: "Immediate hold"' }), { id: 'B/1', status: 'onHold' })
    assert.equal(await executeProposeBatchExtendRest({ batch_id: 'B-2', additional_days: 2, rationale: 'QT-2 shows improving conditions; recipe calls for two more days.' }), 2)
    const planned = '2026-05-01T10:00:00+02:00'
    assert.equal(await executeProposeBatchScheduleEarlyTransfer({ batch_id: 'B-3', planned_at: planned, rationale: 'ML-3 and QT-3 show continuing cooling stress before planned transfer.' }), 3)
    assert.equal(requests[0]!.url, 'http://ontology.test/api/objects/batch/B%2F1/actions/placeOnHold')
    assert.deepEqual(requests[0]!.body, { reason: 'QT-1: "Immediate hold"' })
    for (const request of requests.slice(1)) {
      assert.equal(request.url, 'http://ontology.test/api/objects/proposal')
      assert.equal(request.body.status, 'pending')
      assert.equal(request.body.proposedBy, 'planning-agent')
      assert.ok(Date.parse(request.body.proposedAt) >= Date.parse(process.env.COURSE_NOW))
      assert.ok(request.body.rationale.length > 0)
    }
    assert.equal(requests[1]!.body.type, 'batch.extendRest')
    assert.equal(requests[1]!.body.targetId, 'B-2')
    assert.deepEqual(requests[1]!.body.params, { additionalDays: 2 })
    assert.equal(requests[2]!.body.type, 'batch.scheduleEarlyTransfer')
    assert.equal(requests[2]!.body.targetId, 'B-3')
    assert.deepEqual(requests[2]!.body.params, { plannedAt: planned })
    assert.ok(requests.every(request => request.actor === 'planning-agent'))
    await assert.rejects(executeBatchPlaceOnHold({ batchId: 'B-1', reason: ' ' }))
    for (const days of [0, -1, 1.5, Infinity]) {
      await assert.rejects(executeProposeBatchExtendRest({ batch_id: 'B-2', additional_days: days, rationale: 'Rest' }))
    }
    await assert.rejects(executeProposeBatchScheduleEarlyTransfer({ batch_id: 'B-3', planned_at: 'tomorrow', rationale: 'Cooling risk' }))
    assert.equal(requests.length, 3)
    globalThis.fetch = async () => Response.json({ error: 'Batch is completed' }, { status: 400 })
    await assert.rejects(executeBatchPlaceOnHold({ batchId: 'B-1', reason: 'Hold' }), /Batch is completed/)
    await assert.rejects(executeProposeBatchExtendRest({ batch_id: 'B-2', additional_days: 1, rationale: 'Rest' }), /Batch is completed/)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries({ ONTOLOGY_URL: previous.url, CALLER_IDENTITY: previous.identity, COURSE_NOW: previous.clock })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('planning MCP executes its three intervention tools but denies direct schedule changes', () => {
  // Keep actual stdio dispatch and validation, replacing only the external HTTP transport.
  const preload = `globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (new Headers(init.headers).get('x-caller-identity') !== 'planning-agent') throw new Error('Missing caller attribution');
    if (String(url).endsWith('/proposal')) {
      if (body.proposedBy !== 'planning-agent' || body.status !== 'pending') throw new Error('Invalid proposal provenance');
      if (body.type === 'batch.extendRest' && body.params.additionalDays === 2) return Response.json({id: 17});
      if (body.type === 'batch.scheduleEarlyTransfer' && body.params.plannedAt === '2026-05-01T09:00:00Z') return Response.json({id: 18});
      throw new Error('Wrong proposal action or params');
    }
    if (!String(url).endsWith('/batch/B-1/actions/placeOnHold') || body.reason !== 'QT-1 recommends a safety hold') throw new Error('Wrong hold request');
    return Response.json({id: 'B-1', status: 'onHold'});
  };`
  const enabled = ['query_objects', 'get_object', 'batch_place_on_hold', 'propose_batch_extend_rest', 'propose_batch_schedule_early_transfer']
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    new URL('../shared/queryObjectsMcp.ts', import.meta.url).pathname], {
    env: { ...process.env, ONTOLOGY_URL: 'http://ontology.test', CALLER_IDENTITY: 'planning-agent', COURSE_NOW: '2026-04-30T09:00:00Z', ONTOLOGY_ALLOWED_TOOLS: JSON.stringify(enabled) },
    encoding: 'utf8', timeout: 10000,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'batch_place_on_hold', arguments: { batchId: 'B-1', reason: 'QT-1 recommends a safety hold' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_batch_extend_rest', arguments: { batch_id: 'B-2', additional_days: 2, rationale: 'Safe conditions; more time needed' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_batch_schedule_early_transfer', arguments: { batch_id: 'B-3', planned_at: '2026-05-01T09:00:00Z', rationale: 'Continuing cooling stress' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'batch_schedule_early_transfer', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'propose_batch_extend_rest', arguments: { batch_id: 'B-2', additional_days: -1, rationale: 'Rest' } } },
    ].map(request => JSON.stringify(request)).join('\n') + '\n',
  })
  assert.equal(result.status, 0, result.stderr)
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const reply = (id: number) => replies.find(row => row.id === id)
  assert.deepEqual(reply(1).result.tools.map((tool: { name: string }) => tool.name).sort(), enabled.sort())
  assert.deepEqual(reply(2).result.structuredContent, { id: 'B-1', status: 'onHold' })
  assert.equal(reply(3).result.structuredContent, 17)
  assert.equal(reply(4).result.structuredContent, 18)
  assert.match(reply(5).error.message, /Tool is not enabled/)
  assert.equal(reply(6).error.code, -32602)
})
