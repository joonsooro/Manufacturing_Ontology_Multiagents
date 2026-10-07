/** Propose a batch schedule deferral for review; approval is required to execute it. */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { createProposal } from './createProposal.ts'

/** Snake-case names form the agent-facing contract; action params retain their handler names. */
export const proposeBatchDeferStartInput = z.object({
  batch_id: z.string().min(1).describe('The batch ID, for example B-2122.'),
  new_planned_start: z.string().datetime({ offset: true }).describe('New planned start as an ISO 8601 datetime with a timezone.'),
  rationale: z.string().min(1).describe("The agent's case for proposing this action."),
})

export type ProposeBatchDeferStartInput = z.infer<typeof proposeBatchDeferStartInput>

/** Keep the routing ID and reasoning outside the stored action-specific params. */
export async function executeProposeBatchDeferStart(input: ProposeBatchDeferStartInput): Promise<number> {
  const { batch_id, new_planned_start, rationale } = proposeBatchDeferStartInput.parse(input)
  return createProposal({ type: 'batch.deferStart', targetId: batch_id, params: { newPlannedStart: new_planned_start }, rationale,
    proposedBy: process.env.CALLER_IDENTITY ?? 'ingredient-delivery-disruption-agent' })
}

/** Return only the generated Proposal id so callers can refer to it during review. */
export const proposeBatchDeferStart = tool({
  name: 'propose_batch_defer_start',
  description: 'Create a pending proposal to defer a batch start. Returns the Proposal id.',
  parameters: proposeBatchDeferStartInput,
  execute: async (input) => JSON.stringify(await executeProposeBatchDeferStart(input)),
})
