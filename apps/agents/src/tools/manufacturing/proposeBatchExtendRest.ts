/** Reviewable rest extension; creating a proposal does not change the batch's transfer schedule. */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { createProposal } from './createProposal.ts'

export const proposeBatchExtendRestInput = z.object({
  batch_id: z.string().trim().min(1).describe('The batch whose rest should be extended.'),
  additional_days: z.number().int().positive().describe('Whole additional rest days to add to this batch\'s planned transfer.'),
  rationale: z.string().trim().min(1).describe('Evidence-weighted reason for adding rest time, citing source object IDs.'),
}).strict()

export type ProposeBatchExtendRestInput = z.infer<typeof proposeBatchExtendRestInput>

/** Map tool names to handler inputs; provenance and rationale remain outside params. */
export async function executeProposeBatchExtendRest(input: ProposeBatchExtendRestInput): Promise<number> {
  const { batch_id, additional_days, rationale } = proposeBatchExtendRestInput.parse(input)
  return createProposal({ type: 'batch.extendRest', targetId: batch_id, params: { additionalDays: additional_days }, rationale,
    proposedBy: process.env.CALLER_IDENTITY ?? 'planning-agent' })
}

export const proposeBatchExtendRest = tool({
  name: 'propose_batch_extend_rest',
  description: 'Create a pending proposal to add rest days to this batch\'s planned transfer without rescheduling other batches. Returns the Proposal id.',
  parameters: proposeBatchExtendRestInput,
  execute: async (input) => JSON.stringify(await executeProposeBatchExtendRest(input)),
})
