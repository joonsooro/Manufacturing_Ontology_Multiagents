/** Review API contracts: exact action URL, reviewer header, pending filter, and readable failures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPendingProposals, fetchReviewableProposals, postAction } from '../src/api.ts';

test('proposal reads and review writes preserve the server contract', async () => {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(init?.method === 'POST' ? { status: 'approved' } : []);
  };
  try {
    await fetchPendingProposals();
    for (const action of ['approve', 'reject']) {
      await postAction('proposal', '42', action, { decisionNote: `Reason for ${action}` }, { callerIdentity: 'brewmaster-lee' });
    }
    assert.equal(requests[0]!.url, '/api/objects/proposal?status=pending');
    for (const [index, action] of ['approve', 'reject'].entries()) {
      const request = requests[index + 1]!;
      assert.equal(request.url, `/api/objects/proposal/42/actions/${action}`);
      assert.equal(new Headers(request.init?.headers).get('x-caller-identity'), 'brewmaster-lee');
      assert.deepEqual(JSON.parse(String(request.init?.body)), { decisionNote: `Reason for ${action}` });
    }
    // Another reviewer reuses the transport without changing implementation or contaminating params.
    await postAction('proposal', '43', 'reject', { decisionNote: 'Reconsider' }, { callerIdentity: 'reviewer-kim' });
    assert.equal(new Headers(requests[3]!.init?.headers).get('x-caller-identity'), 'reviewer-kim');
    assert.deepEqual(JSON.parse(String(requests[3]!.init?.body)), { decisionNote: 'Reconsider' });
    await postAction('proposal', '44', 'reject', {});
    assert.equal(new Headers(requests[4]!.init?.headers).has('x-caller-identity'), false);
    globalThis.fetch = async () => Response.json({ error: 'Batch cannot be cancelled' }, { status: 400 });
    await assert.rejects(postAction('proposal', '42', 'approve', {}, { callerIdentity: 'brewmaster-lee' }), /Batch cannot be cancelled/);
    globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
    await assert.rejects(postAction('proposal', '42', 'approve', {}, { callerIdentity: 'brewmaster-lee' }), /503/);
  } finally { globalThis.fetch = originalFetch; }
});

test('the human queue retrieves both pending and escalated proposals with escalation feedback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), '/api/objects/proposal/query');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      filters: [{ property: 'status', op: 'in', value: ['pending', 'escalated'] }], limit: 1000,
    });
    return Response.json([{ id: 42, status: 'escalated', decision_note: 'Readiness is unsupported', reviewed_by: 'verification-agent' }]);
  };
  try {
    const proposals = await fetchReviewableProposals();
    assert.equal(proposals[0]!.status, 'escalated');
    assert.equal(proposals[0]!.decision_note, 'Readiness is unsupported');
    assert.equal(proposals[0]!.reviewed_by, 'verification-agent');
  } finally { globalThis.fetch = originalFetch; }
});
