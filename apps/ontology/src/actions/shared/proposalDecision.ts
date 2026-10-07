/**
 * Shared decision mechanics: validate review inputs, lock a reviewable proposal,
 * then persist review fields and the decision audit. reviewedBy is written here as reviewed_by.
 */
import type { Transaction } from 'kysely'
import type { ActionParams, Database, Proposal, JsonValue, proposalApproveDefinition } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { auditParams } from './transaction.ts'
import { resolveObjectStorage } from './objectStorage.ts'

export type ProposalDecisionParams = ActionParams<typeof proposalApproveDefinition.parameter_schema>

/** Also validate direct handler calls, which do not pass through the HTTP JSON Schema validator. */
export function validateDecisionParams(params: ProposalDecisionParams | undefined) {
  if (params !== undefined && (params === null || typeof params !== 'object' ||
      (params.decisionNote !== undefined && typeof params.decisionNote !== 'string'))) {
    throw new Error('decisionNote must be a string')
  }
}

/** Re-read under a row lock: the route's earlier snapshot may already have been reviewed. */
export async function lockReviewableProposal({ instance, context, eligibleStatuses = ['pending', 'escalated'] }: {
  instance: Proposal
  context: ActionContext
  /** Escalation admits pending only; final decisions also admit escalated proposals. */
  eligibleStatuses?: readonly Proposal['status'][]
}) {
  const storage = await resolveObjectStorage(context, context.objectTypeApiName)
  const db = context.database
  const table = db.dynamic.table<any>(storage.table).as('proposal_instance')
  const proposal = await db.selectFrom(table).selectAll()
    .where(db.dynamic.ref(`proposal_instance.${storage.primaryKey}`), '=', instance.id)
    // Competing decisions wait here, then re-check status rather than trusting a stale route snapshot.
    .forUpdate().executeTakeFirst() as Proposal | undefined
  if (!proposal) throw new Error(`Proposal ${instance.id} no longer exists`)
  if (!eligibleStatuses.includes(proposal.status)) {
    throw new Error(`Proposal ${instance.id} cannot be reviewed because its status is ${proposal.status}, not ${eligibleStatuses.join(' or ')}`)
  }
  return { proposal, storage }
}

/** Shared persistence for all decisions; the caller owns transaction commit/rollback. */
export async function recordDecision({ transaction, context, proposal, storage, status, reviewedAt, decisionNote }: {
  transaction: Transaction<Database>
  context: ActionContext
  proposal: Proposal
  storage: Awaited<ReturnType<typeof resolveObjectStorage>>
  status: 'approved' | 'rejected' | 'escalated'
  reviewedAt: Date
  decisionNote?: string
}) {
  // Public reviewedBy maps to reviewed_by in PostgreSQL; keep it identical to the decision audit actor.
  const actor = context.callerIdentity ?? 'system'
  const updated = await transaction.updateTable(transaction.dynamic.table<any>(storage.table).as('proposal_instance'))
    .set({ status, reviewed_by: actor, reviewed_at: reviewedAt, decision_note: decisionNote ?? null })
    .where(transaction.dynamic.ref(`proposal_instance.${storage.primaryKey}`), '=', proposal.id)
    .returningAll().executeTakeFirstOrThrow() as Proposal
  // An omitted note is absent from audit params and stored as NULL on the proposal row.
  // The escalate API calls this field note; final decisions call it decisionNote.
  // Preserve that public input name in the audit while sharing decision_note storage.
  const decisionParams: Record<string, JsonValue> = decisionNote === undefined
    ? {} : { [status === 'escalated' ? 'note' : 'decisionNote']: decisionNote }
  await transaction.withSchema(context.metadataSchema).insertInto('audit_log').values({
    action_type_id: context.actionTypeId,
    action_api_name: context.actionApiName,
    target_type_id: context.objectTypeId,
    target_type_api_name: context.objectTypeApiName,
    // audit_log uses text IDs even though Proposal instance IDs are auto-incrementing integers.
    target_id: String(proposal.id),
    actor,
    params: auditParams(context, decisionParams),
    result: {
      id: proposal.id, status, reviewedBy: actor, reviewedAt: reviewedAt.toISOString(),
      decisionNote: decisionNote ?? null, previousStatus: proposal.status,
    },
    // Use the pinned review clock, rather than the database's real-world timestamp default.
    created_at: reviewedAt,
  }).execute()
  return updated
}
