/** Verify proposal payload boundaries and clock attribution without writing live manufacturing data. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeProposeBatchCancel } from './proposeBatchCancel.ts'
import { executeProposeBatchDeferStart } from './proposeBatchDeferStart.ts'

test('proposal tools create pending requests with exact handler keys and return only IDs', async () => {
  const originalFetch = globalThis.fetch
  const oldUrl = process.env.ONTOLOGY_URL
  const oldClock = process.env.COURSE_NOW
  process.env.ONTOLOGY_URL = 'http://ontology.test/'
  process.env.COURSE_NOW = '2026-08-01T12:00:00Z'
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://ontology.test/api/objects/proposal')
    assert.equal(init?.method, 'POST')
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ id: 42 }, { status: 201 })
  }
  try {
    assert.equal(await executeProposeBatchCancel({ batch_id: 'B-1', reason: 'Missing ingredients', rationale: 'Delivery failed' }), 42)
    const planned = '2026-08-02T09:00:00+02:00'
    assert.equal(await executeProposeBatchDeferStart({ batch_id: 'B-2', new_planned_start: planned, rationale: 'Delivery delayed' }), 42)
    assert.equal(bodies[0]!.type, 'batch.cancel')
    assert.equal(bodies[1]!.type, 'batch.deferStart')
    assert.equal(bodies[0]!.targetId, 'B-1')
    assert.equal(bodies[1]!.targetId, 'B-2')
    assert.deepEqual(bodies[0]!.params, { reason: 'Missing ingredients' })
    assert.deepEqual(bodies[1]!.params, { newPlannedStart: planned })
    assert.equal(bodies[0]!.rationale, 'Delivery failed')
    for (const body of bodies) {
      assert.equal(body.status, 'pending')
      assert.equal(body.proposedBy, 'ingredient-delivery-disruption-agent')
      const elapsed = Date.parse(String(body.proposedAt)) - Date.parse(process.env.COURSE_NOW)
      assert.ok(elapsed >= 0 && elapsed < 60000)
      assert.equal('reviewedBy' in body, false)
    }
    await assert.rejects(executeProposeBatchDeferStart({ batch_id: 'B-2', new_planned_start: 'tomorrow', rationale: 'Delay' }))
    assert.equal(bodies.length, 2)
    // Missing course configuration must fail before making a request.
    delete process.env.COURSE_NOW
    await assert.rejects(executeProposeBatchCancel({ batch_id: 'B-1', reason: 'Missing', rationale: 'Delay' }), /COURSE_NOW/)
    process.env.COURSE_NOW = '2026-08-01T12:00:00Z'
    globalThis.fetch = async () => Response.json({ error: 'Creation disabled' }, { status: 403 })
    await assert.rejects(executeProposeBatchCancel({ batch_id: 'B-1', reason: 'Missing', rationale: 'Delay' }), /Creation disabled/)
    globalThis.fetch = async () => Response.json({})
    await assert.rejects(executeProposeBatchCancel({ batch_id: 'B-1', reason: 'Missing', rationale: 'Delay' }), /Proposal id/)
  } finally {
    globalThis.fetch = originalFetch
    if (oldUrl === undefined) delete process.env.ONTOLOGY_URL
    else process.env.ONTOLOGY_URL = oldUrl
    if (oldClock === undefined) delete process.env.COURSE_NOW
    else process.env.COURSE_NOW = oldClock
  }
})
