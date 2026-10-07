/** Direct proposal rejection changes review status without executing the stored business action. */
import { tool } from '@openai/agents'
import { invokeAction } from './invokeAction.ts'
import { proposalDecisionInput, proposalDecisionToolInput, type ProposalDecisionInput } from './proposalDecisionInput.ts'

export const proposalRejectInput = proposalDecisionInput

export async function executeProposalReject(input: ProposalDecisionInput): Promise<unknown> {
  const { proposalId, decisionNote } = proposalRejectInput.parse(input)
  return invokeAction('proposal', String(proposalId), 'reject', decisionNote === null || decisionNote === undefined ? {} : { decisionNote })
}

export const proposalReject = tool({
  name: 'proposal_reject',
  description: 'Reject a pending or escalated Proposal and record review feedback without executing its action. Returns the updated Proposal.',
  parameters: proposalDecisionToolInput,
  execute: async (input) => JSON.stringify(await executeProposalReject(input)),
})
