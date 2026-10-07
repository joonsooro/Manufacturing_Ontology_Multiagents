/**
 * Agent read tool for one ontology instance and its resolved relationships.
 * The executor returns parsed data; the Agents SDK wrapper serializes that data as tool output.
 */
import { tool } from '@openai/agents'
import { z } from 'zod'

/** IDs are passed as strings, including a numeric Proposal ID encoded for the URL. */
export const getObjectInput = z.object({
  type: z.string().min(1).describe("The object type's API name, for example batch."),
  id: z.string().min(1).describe("The object's primary-key value, for example B-2105."),
})

export type GetObjectInput = z.infer<typeof getObjectInput>

/** Fetch the detail endpoint, which returns instance fields plus server-resolved links. */
export async function executeGetObject(input: GetObjectInput): Promise<unknown> {
  const { type, id } = getObjectInput.parse(input)
  const ontologyUrl = process.env.ONTOLOGY_URL
  if (!ontologyUrl) {
    throw new Error('ONTOLOGY_URL must be set to the ontology API base URL')
  }

  const apiBase = ontologyUrl.endsWith('/') ? ontologyUrl.slice(0, -1) : ontologyUrl
  const headers: Record<string, string> = {}
  if (process.env.CALLER_IDENTITY) {
    headers['x-caller-identity'] = process.env.CALLER_IDENTITY
  }
  // Encode both type and ID so special characters cannot change the URL path structure.
  const response = await fetch(
    `${apiBase}/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
    { headers },
  )

  // Preserve useful server errors while tolerating a response that is not valid JSON.
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'error' in result
      ? String(result.error)
      : `Ontology object lookup failed with HTTP ${response.status}`
    throw new Error(message)
  }

  return result
}

/** An OpenAI Agents SDK function tool backed by the ontology object-detail endpoint. */
export const getObject = tool({
  name: 'get_object',
  description: 'Get one ontology object instance and its resolved links by type and primary-key ID.',
  parameters: getObjectInput,
  execute: async (input) => JSON.stringify(await executeGetObject(input)),
})
