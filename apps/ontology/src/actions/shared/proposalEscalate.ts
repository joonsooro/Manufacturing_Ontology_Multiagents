/** Proposal.escalate records an unresolved concern for human review without running the proposed action. */
import type { ActionParams, Proposal, proposalEscalateDefinition } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { lockReviewableProposal, recordDecision } from './proposalDecision.ts'
import { withActionTransaction } from './transaction.ts'

export type ProposalEscalateParams = ActionParams<typeof proposalEscalateDefinition.parameter_schema>

export async function proposalEscalate(instance: Proposal, params: ProposalEscalateParams | undefined, context: ActionContext): Promise<Proposal> {
  if (!params || typeof params.note !== 'string' || !params.note.trim()) {
    throw new Error('Proposal.escalate requires a non-empty note')
  }
  // Pending-only admission prevents repeated escalations. Final decision handlers admit escalated too.
  // Sharing the transaction/audit helper makes audit failure roll back the status and review fields.
  return withActionTransaction(context, async (transaction) => {
    const { proposal, storage } = await lockReviewableProposal({
      instance, context: { ...context, database: transaction }, eligibleStatuses: ['pending'],
    })
    return recordDecision({ transaction, context, proposal, storage, status: 'escalated', reviewedAt: new Date(), decisionNote: params.note })
  })
}
