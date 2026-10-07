/**
 * Proposal.approve orchestration. Lock the proposal, resolve and validate its stored action,
 * execute that action as the reviewer, then record approval in the same transaction.
 * Any failure escapes to the transaction owner and rolls back the whole approval.
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import type { Proposal } from '../../schema.ts'
import type { ActionContext, ActionHandler } from '../types.ts'
import { resolveObjectStorage } from './objectStorage.ts'
import { lockReviewableProposal, recordDecision, validateDecisionParams, type ProposalDecisionParams } from './proposalDecision.ts'
import { withActionTransaction } from './transaction.ts'

/** The registry is injected so this shared handler works in any metadata schema. */
export function createProposalApprove(handlers: Record<string, ActionHandler>) {
  return async function proposalApprove(
    instance: Proposal,
    params: ProposalDecisionParams | undefined,
    context: ActionContext,
  ): Promise<Record<string, unknown>> {
    validateDecisionParams(params)
    return withActionTransaction(context, async (transaction) => {
      // Every lookup, inner write, and decision audit uses this one transaction.
      const approvalContext = { ...context, database: transaction }
      const { proposal, storage } = await lockReviewableProposal({ instance, context: approvalContext })
      const reviewedAt = new Date() // Date is pinned by courseClock at server startup.
      // Stored type must exactly match a registry key (for example batch.cancel); do not lowercase it.
      const parts = proposal.type.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1] || !Object.hasOwn(handlers, proposal.type)) {
        throw new Error(`Proposal action ${proposal.type} has no implementation`)
      }
      const [typeApiName, actionApiName] = parts as [string, string]
      const targetStorage = await resolveObjectStorage(approvalContext, typeApiName)
      // The catalog identifies the inner action and the schema against which its stored params are checked.
      const actionType = await transaction.withSchema(context.metadataSchema)
        .selectFrom('action_type').selectAll()
        .where('object_type_id', '=', targetStorage.objectType.id)
        .where('api_name', '=', actionApiName).executeTakeFirst()
      if (!actionType) throw new Error(`Proposal action ${proposal.type} has no metadata`)
      // Proposals may have been stored earlier; validate against the action metadata at review time.
      const validation = new Validator(actionType.parameter_schema as Schema, '2020-12', false)
        .validate(proposal.params)
      if (!validation.valid) throw new Error(`Stored parameters for ${proposal.type} are invalid`)
      // Lock the actual target too, so the action operates on its current state during this approval.
      const target = await transaction
        .selectFrom(transaction.dynamic.table<any>(targetStorage.table).as('target_instance'))
        .selectAll()
        .where(transaction.dynamic.ref(`target_instance.${targetStorage.primaryKey}`), '=', proposal.target_id)
        .forUpdate().executeTakeFirst()
      if (!target) throw new Error(`Target ${typeApiName} ${proposal.target_id} not found`)
      // Attribute the triggered action to the reviewer, not the agent that originally proposed it.
      const actor = context.callerIdentity ?? 'system'
      const result = await handlers[proposal.type]!(target, proposal.params, {
        database: transaction,
        metadataSchema: context.metadataSchema,
        objectTypeId: targetStorage.objectType.id,
        objectTypeApiName: targetStorage.objectType.api_name,
        actionTypeId: actionType.id,
        actionApiName: actionType.api_name,
        actor,
        callerIdentity: actor,
        // The inner handler adds this ID to its audit entry, leaving proposal.params untouched.
        authorizedByProposal: proposal.id,
      })
      // reviewed_by/reviewed_at are written inside recordDecision (proposalDecision.ts).
      // Record approval only after execution succeeds; an error rolls back both actions and both audits.
      await recordDecision({ transaction, context, proposal, storage, status: 'approved', reviewedAt, decisionNote: params?.decisionNote })
      // Approval returns the underlying action result, rather than the updated proposal row.
      return result
    })
  }
}
