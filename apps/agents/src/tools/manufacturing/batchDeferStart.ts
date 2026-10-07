/**
 * Agent-facing wrapper for the ontology Batch.deferStart action.
 * Zod validates tool inputs locally; the ontology remains responsible for business rules and audit.
 */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { invokeAction } from './invokeAction.ts'

/** Tool input includes a target ID for routing plus the action's business parameters. */
export const batchDeferStartInput = z.object({
  batchId: z.string().min(1).describe('The batch ID, for example B-2122.'),
  newPlannedStart: z.string().datetime({ offset: true }).describe('New planned start as an ISO 8601 datetime with a timezone.'),
})

export type BatchDeferStartInput = z.infer<typeof batchDeferStartInput>

/** Separate target routing from parameters before invoking the server action. */
export async function executeBatchDeferStart(input: BatchDeferStartInput): Promise<unknown> {
  const { batchId, newPlannedStart } = batchDeferStartInput.parse(input)
  return invokeAction('batch', batchId, 'deferStart', { newPlannedStart })
}

// Agents SDK registration reuses the same executor exposed by the MCP bridge.
export const batchDeferStart = tool({
  name: 'batch_defer_start',
  description: 'Postpone a queued batch to a future planned start datetime. Returns the updated batch.',
  parameters: batchDeferStartInput,
  execute: async (input) => JSON.stringify(await executeBatchDeferStart(input)),
})
