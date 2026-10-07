/** Propose a batch cancellation for review; approval is required to execute it. */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { createProposal } from './createProposal.ts'

/** Snake-case names form the agent-facing contract; action params retain their handler names. */
export const proposeBatchCancelInput = z.object({
  batch_id: z.string().min(1).describe('The batch ID, for example B-2122.'),
  reason: z.string().min(1).describe('Why this batch should be cancelled.'),
  rationale: z.string().min(1).describe("The agent's case for proposing this action."),
})

export type ProposeBatchCancelInput = z.infer<typeof proposeBatchCancelInput>

/** Keep the routing ID and reasoning outside the stored action-specific params. */
export async function executeProposeBatchCancel(input: ProposeBatchCancelInput): Promise<number> {
  const { batch_id, reason, rationale } = proposeBatchCancelInput.parse(input)
  return createProposal({ type: 'batch.cancel', targetId: batch_id, params: { reason }, rationale,
    proposedBy: process.env.CALLER_IDENTITY ?? 'ingredient-delivery-disruption-agent' })
}

/** Return only the generated Proposal id so callers can refer to it during review. */
export const proposeBatchCancel = tool({
  name: 'propose_batch_cancel',
  description: 'Create a pending proposal to cancel a batch. Returns the Proposal id.',
  parameters: proposeBatchCancelInput,
  execute: async (input) => JSON.stringify(await executeProposeBatchCancel(input)),
})
