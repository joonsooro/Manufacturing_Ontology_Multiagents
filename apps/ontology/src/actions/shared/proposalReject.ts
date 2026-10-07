/**
 * Proposal.reject records the reviewer, review time, optional note, and decision audit.
 * It intentionally does not resolve or execute the proposal's underlying action.
 */
import type { Proposal } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { lockReviewableProposal, recordDecision, validateDecisionParams, type ProposalDecisionParams } from './proposalDecision.ts'
import { withActionTransaction } from './transaction.ts'

export async function proposalReject(
  instance: Proposal,
  params: ProposalDecisionParams | undefined,
  context: ActionContext,
): Promise<Proposal> {
  validateDecisionParams(params)
  return withActionTransaction(context, async (transaction) => {
    const { proposal, storage } = await lockReviewableProposal({ instance, context: { ...context, database: transaction } })
    // Either reviewable state can be rejected, even when its underlying action cannot be resolved.
    return recordDecision({ transaction, context, proposal, storage, status: 'rejected', reviewedAt: new Date(), decisionNote: params?.decisionNote })
  })
}
