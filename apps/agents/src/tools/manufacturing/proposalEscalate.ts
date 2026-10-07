/** Direct escalation preserves the submitted plan for a later human approve/reject decision. */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { invokeAction } from './invokeAction.ts'

export const proposalEscalateInput = z.object({
  proposalId: z.number().int().positive().describe('Pending Proposal ID to escalate.'),
  note: z.string().trim().min(1).describe('Material unsupported assumptions or unresolved concerns requiring human review, with source IDs.'),
}).strict()

export type ProposalEscalateInput = z.infer<typeof proposalEscalateInput>

export async function executeProposalEscalate(input: ProposalEscalateInput): Promise<unknown> {
  const { proposalId, note } = proposalEscalateInput.parse(input)
  return invokeAction('proposal', String(proposalId), 'escalate', { note })
}

export const proposalEscalate = tool({
  name: 'proposal_escalate',
  description: 'Escalate a pending Proposal for human review with a note. Does not execute its action; the Proposal remains available for later approval or rejection.',
  parameters: proposalEscalateInput,
  execute: async (input) => JSON.stringify(await executeProposalEscalate(input)),
})
