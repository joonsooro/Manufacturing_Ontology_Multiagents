/**
 * Agent read tool for metadata-backed property filters.
 * The HTTP contract accepts optional fields; the SDK wrapper adapts nullable model inputs to it.
 */
import { tool } from '@openai/agents'
import { z } from 'zod'

// Keep operators aligned with the server's allowlist in ontology/routes/objects.ts.
const filterOperators = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'isNull',
  'isNotNull',
] as const

// Values may be scalar or lists (for in); absence is useful for null-check operators.
const filterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
])

/** Public executor/MCP input contract. Property names refer to ontology API names, not SQL columns. */
export const queryObjectsInput = z.object({
  type: z.string().min(1).describe("The object type's API name, for example batch."),
  filters: z.array(z.object({
    property: z.string().min(1),
    op: z.enum(filterOperators),
    value: filterValueSchema.optional(),
  })).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
})

export type QueryObjectsInput = z.infer<typeof queryObjectsInput>

// OpenAI Responses function tools require every object property to be present.
// Nullable fields preserve the optional public tool contract for the model.
const queryObjectsToolInput = z.object({
  type: z.string().min(1).describe("The object type's API name, for example batch."),
  filters: z.array(z.object({
    property: z.string().min(1),
    op: z.enum(filterOperators),
    value: filterValueSchema.nullable(),
  })).nullable(),
  limit: z.number().int().min(1).max(1_000).nullable(),
})

/** Validate input, send structured filters to the ontology, and propagate its error message. */
export async function executeQueryObjects(input: QueryObjectsInput): Promise<unknown> {
  const { type, filters, limit } = queryObjectsInput.parse(input)
  const honoUrl = process.env.HONO_URL
  if (!honoUrl) {
    throw new Error('HONO_URL must be set to the ontology API base URL')
  }

  const apiBase = honoUrl.endsWith('/') ? honoUrl.slice(0, -1) : honoUrl
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (process.env.CALLER_IDENTITY) {
    headers['x-caller-identity'] = process.env.CALLER_IDENTITY
  }
  // The type is in the URL; only filters/limit are sent in the POST body.
  const response = await fetch(`${apiBase}/api/objects/${encodeURIComponent(type)}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ filters, limit }),
  })

  // An HTTP failure is a failed tool call, rather than a successful answer containing an error object.
  const result: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof result === 'object' && result !== null && 'error' in result
      ? String(result.error)
      : `Ontology query failed with HTTP ${response.status}`
    throw new Error(message)
  }

  return result
}

/** An OpenAI Agents SDK function tool backed by the ontology query endpoint. */
export const queryObjects = tool({
  name: 'query_objects',
  description: 'Query instances of an ontology object type using metadata-backed property filters.',
  parameters: queryObjectsToolInput,
  // Convert the SDK's null placeholders back to omitted optional HTTP fields.
  execute: async (input) => JSON.stringify(await executeQueryObjects({
    type: input.type,
    filters: input.filters ?? undefined,
    limit: input.limit ?? undefined,
  })),
})
