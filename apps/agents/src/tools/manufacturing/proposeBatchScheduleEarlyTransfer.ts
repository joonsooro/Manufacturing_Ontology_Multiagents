/** Reviewable earlier exit from current conditions; approval changes only the transfer plan. */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { createProposal } from './createProposal.ts'

export const proposeBatchScheduleEarlyTransferInput = z.object({
  batch_id: z.string().trim().min(1).describe('The batch to schedule for earlier transfer.'),
  planned_at: z.string().datetime({ offset: true }).describe('Earlier planned transfer as an ISO 8601 datetime with a timezone.'),
  rationale: z.string().trim().min(1).describe('Evidence-weighted reason why staying in the current conditions prolongs the risk, citing source object IDs.'),
}).strict()

export type ProposeBatchScheduleEarlyTransferInput = z.infer<typeof proposeBatchScheduleEarlyTransferInput>

/** Translate agent-facing names; the shared proposal transport records planning-agent provenance. */
export async function executeProposeBatchScheduleEarlyTransfer(input: ProposeBatchScheduleEarlyTransferInput): Promise<number> {
  const { batch_id, planned_at, rationale } = proposeBatchScheduleEarlyTransferInput.parse(input)
  return createProposal({ type: 'batch.scheduleEarlyTransfer', targetId: batch_id, params: { plannedAt: planned_at }, rationale,
    proposedBy: process.env.CALLER_IDENTITY ?? 'planning-agent' })
}

export const proposeBatchScheduleEarlyTransfer = tool({
  name: 'propose_batch_schedule_early_transfer',
  description: 'Create a pending proposal to move this batch\'s planned transfer earlier when staying in current conditions prolongs the risk. Returns the Proposal id.',
  parameters: proposeBatchScheduleEarlyTransferInput,
  execute: async (input) => JSON.stringify(await executeProposeBatchScheduleEarlyTransfer(input)),
})
