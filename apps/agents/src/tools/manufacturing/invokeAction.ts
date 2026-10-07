/**
 * Shared HTTP transport for manufacturing write tools.
 * Target IDs stay in the URL; the JSON body contains action-specific parameters only.
 */
/** Execute a business action through the API so server validation and audit logic always run. */
export async function invokeAction(
  type: 'batch' | 'tank' | 'proposal',
  id: string,
  action: string,
  params: Record<string, string>,
): Promise<unknown> {
  const ontologyUrl = process.env.ONTOLOGY_URL
  if (!ontologyUrl) throw new Error('ONTOLOGY_URL must be set to the ontology API base URL')

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // The route prefers x-caller-identity; retain x-actor for older API deployments.
  if (process.env.CALLER_IDENTITY) {
    headers['x-caller-identity'] = process.env.CALLER_IDENTITY
    headers['x-actor'] = process.env.CALLER_IDENTITY
  }
  // Object identity is routing data, so params must not repeat batchId/tankId in the JSON body.
  const response = await fetch(
    `${ontologyUrl.replace(/\/$/, '')}/api/objects/${type}/${encodeURIComponent(id)}/actions/${action}`,
    { method: 'POST', headers, body: JSON.stringify(params) },
  )
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'error' in result
      ? String(result.error)
      : `Ontology action failed with HTTP ${response.status}`
    throw new Error(message)
  }
  return result
}
