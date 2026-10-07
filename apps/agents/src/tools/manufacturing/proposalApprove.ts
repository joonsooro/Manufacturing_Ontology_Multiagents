/** Direct proposal approval executes the stored business action through the audited ontology route. */
import { tool } from '@openai/agents'
import { invokeAction } from './invokeAction.ts'
import { proposalDecisionInput, proposalDecisionToolInput, type ProposalDecisionInput } from './proposalDecisionInput.ts'

export const proposalApproveInput = proposalDecisionInput

export async function executeProposalApprove(input: ProposalDecisionInput): Promise<unknown> {
  const { proposalId, decisionNote } = proposalApproveInput.parse(input)
  return invokeAction('proposal', String(proposalId), 'approve', decisionNote === null || decisionNote === undefined ? {} : { decisionNote })
}

export const proposalApprove = tool({
  name: 'proposal_approve',
  description: 'Approve a pending or escalated Proposal and atomically execute its stored action. Returns the action result.',
  parameters: proposalDecisionToolInput,
  execute: async (input) => JSON.stringify(await executeProposalApprove(input)),
})
