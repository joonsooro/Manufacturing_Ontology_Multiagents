/** Shared review-tool contract; optional feedback belongs to the proposal decision, not the batch action. */
import { z } from 'zod'

export const proposalDecisionInput = z.object({
  proposalId: z.number().int().positive().describe('The Proposal ID to review.'),
  decisionNote: z.string().nullable().optional().describe('Evidence-backed review feedback, or null when omitted.'),
}).strict()

export type ProposalDecisionInput = z.infer<typeof proposalDecisionInput>

// SDK function tools require all fields; MCP/executor callers may omit the optional note.
export const proposalDecisionToolInput = proposalDecisionInput.extend({ decisionNote: z.string().nullable() })
