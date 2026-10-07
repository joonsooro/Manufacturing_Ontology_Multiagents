/** Check review attribution, action payloads, and the verifier's actual MCP capability boundary. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { executeProposalApprove } from './proposalApprove.ts'
import { executeProposalReject } from './proposalReject.ts'
import { executeProposalEscalate } from './proposalEscalate.ts'

test('decision tools send business-only params with the active reviewer identity and propagate failures', async () => {
  const previous = { fetch: globalThis.fetch, url: process.env.ONTOLOGY_URL, identity: process.env.CALLER_IDENTITY }
  process.env.ONTOLOGY_URL = 'http://ontology.test/'
  process.env.CALLER_IDENTITY = 'verification-agent'
  const requests: { url: string; body: unknown }[] = []
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, 'POST')
    assert.equal(new Headers(init?.headers).get('x-caller-identity'), 'verification-agent')
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return Response.json({ id: 42, status: String(url).endsWith('/escalate') ? 'escalated' : 'approved' })
  }
  try {
    await executeProposalApprove({ proposalId: 42, decisionNote: 'QT-1 supports the rest rationale' })
    await executeProposalReject({ proposalId: 43, decisionNote: null })
    const result = await executeProposalEscalate({ proposalId: 44, note: '  QT-2 does not establish readiness  ' })
    assert.deepEqual(result, { id: 42, status: 'escalated' })
    assert.deepEqual(requests, [
      { url: 'http://ontology.test/api/objects/proposal/42/actions/approve', body: { decisionNote: 'QT-1 supports the rest rationale' } },
      { url: 'http://ontology.test/api/objects/proposal/43/actions/reject', body: {} },
      { url: 'http://ontology.test/api/objects/proposal/44/actions/escalate', body: { note: 'QT-2 does not establish readiness' } },
    ])
    await assert.rejects(executeProposalEscalate({ proposalId: 44, note: ' ' }))
    await assert.rejects(executeProposalApprove({ proposalId: -1 }))
    await assert.rejects(executeProposalReject({ proposalId: 1.5 }))
    assert.equal(requests.length, 3)
    globalThis.fetch = async () => Response.json({ error: 'Proposal already approved' }, { status: 400 })
    await assert.rejects(executeProposalEscalate({ proposalId: 42, note: 'Review needed' }), /already approved/)
  } finally {
    globalThis.fetch = previous.fetch
    for (const [key, value] of Object.entries({ ONTOLOGY_URL: previous.url, CALLER_IDENTITY: previous.identity })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('verification MCP exposes only reads and decisions, dispatches decisions, and denies replanning', () => {
  // Exercise the real stdio server; only the network transport is replaced, so no live decisions occur.
  const preload = `globalThis.fetch = async (url, init) => {
    if (new Headers(init.headers).get('x-caller-identity') !== 'verification-agent') throw new Error('Missing reviewer');
    const body = JSON.parse(init.body);
    const action = String(url).split('/').at(-1);
    if (action === 'escalate' && body.note !== 'QT-1 readiness unsupported') throw new Error('Wrong escalation note');
    if (action === 'approve' && body.decisionNote !== 'Sound rationale') throw new Error('Wrong decision note');
    if (action === 'reject' && Object.keys(body).length !== 0) throw new Error('Null note not omitted');
    return Response.json({id: 42, status: {approve: 'approved', reject: 'rejected', escalate: 'escalated'}[action]});
  };`
  const enabled = ['query_objects', 'get_object', 'proposal_approve', 'proposal_reject', 'proposal_escalate']
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    new URL('../shared/queryObjectsMcp.ts', import.meta.url).pathname], {
    env: { ...process.env, ONTOLOGY_URL: 'http://ontology.test', CALLER_IDENTITY: 'verification-agent', ONTOLOGY_ALLOWED_TOOLS: JSON.stringify(enabled) },
    encoding: 'utf8', timeout: 10000,
    input: [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'proposal_approve', arguments: { proposalId: 42, decisionNote: 'Sound rationale' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'proposal_reject', arguments: { proposalId: 42, decisionNote: null } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'proposal_escalate', arguments: { proposalId: 42, note: 'QT-1 readiness unsupported' } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'propose_batch_extend_rest', arguments: {} } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'proposal_escalate', arguments: { proposalId: 42, note: '' } } },
    ].map(request => JSON.stringify(request)).join('\n') + '\n',
  })
  assert.equal(result.status, 0, result.stderr)
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const reply = (id: number) => replies.find(row => row.id === id)
  assert.deepEqual(reply(1).result.tools.map((tool: { name: string }) => tool.name).sort(), enabled.sort())
  for (const [id, status] of [[2, 'approved'], [3, 'rejected'], [4, 'escalated']] as const) {
    assert.deepEqual(reply(id).result.structuredContent, { id: 42, status })
  }
  assert.match(reply(5).error.message, /Tool is not enabled/)
  assert.equal(reply(6).error.code, -32602)
})
