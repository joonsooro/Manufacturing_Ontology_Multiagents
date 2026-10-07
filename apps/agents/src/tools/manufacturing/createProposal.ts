/** Shared proposal transport: persist a pending request without executing its business action. */
const startedAt = process.hrtime.bigint()

/** Routing and provenance are caller configuration, separate from the eventual action's business inputs. */
export type CreateProposalInput = {
  type: 'batch.cancel' | 'batch.deferStart' | 'batch.extendRest' | 'batch.scheduleEarlyTransfer'
  targetId: string
  params: Record<string, string | number>
  rationale: string
  proposedBy: string
}

/** Match the server's advancing course clock without shifting tracing or SDK wall-clock time. */
function courseCurrentTime(): string {
  const configured = process.env.COURSE_NOW
  if (!configured) throw new Error('COURSE_NOW must be set')
  const anchor = Date.parse(configured)
  if (!Number.isFinite(anchor)) throw new Error('COURSE_NOW must be a valid date')
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  return new Date(anchor + elapsedMs).toISOString()
}

/** Only params belong to the eventual action; rationale and identity belong to the proposal. */
export async function createProposal({ type, targetId, params, rationale, proposedBy }: CreateProposalInput): Promise<number> {
  const ontologyUrl = process.env.ONTOLOGY_URL
  if (!ontologyUrl) throw new Error('ONTOLOGY_URL must be set to the ontology API base URL')
  const response = await fetch(`${ontologyUrl.replace(/\/$/, '')}/api/objects/proposal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-caller-identity': proposedBy },
    body: JSON.stringify({
      type, targetId, params, rationale, status: 'pending',
      proposedBy,
      proposedAt: courseCurrentTime(),
    }),
  })
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'error' in result
      ? String(result.error)
      : `Proposal creation failed with HTTP ${response.status}`
    throw new Error(message)
  }
  // The generic create route returns the inserted row, including its generated integer primary key.
  if (typeof result !== 'object' || result === null || !('id' in result)
    || typeof result.id !== 'number' || !Number.isSafeInteger(result.id) || result.id <= 0) {
    throw new Error('Proposal creation response is missing a valid Proposal id')
  }
  return result.id
}
