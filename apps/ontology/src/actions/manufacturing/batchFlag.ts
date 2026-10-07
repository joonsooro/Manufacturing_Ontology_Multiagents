/** Batch.flag records a concern and its audit atomically, without mutating the batch. */
import { randomUUID } from 'node:crypto'
import { batchFlagDefinition, type ActionParams, type BatchTable, type FlagLogTable } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { auditParams, withActionTransaction } from '../shared/transaction.ts'

export type BatchFlagParams = ActionParams<typeof batchFlagDefinition.parameter_schema>

/** Direct calls receive the same reason/severity checks as metadata-validated HTTP invocations. */
export async function batchFlag(batch: BatchTable, params: BatchFlagParams | undefined, context: ActionContext): Promise<FlagLogTable> {
  if (!params || typeof params.reason !== 'string' || !params.reason.trim()
    || !batchFlagDefinition.parameter_schema.properties.severity.enum.includes(params.severity)) {
    throw new Error('Batch.flag requires a non-empty reason and severity (low, medium, or high)')
  }
  // Reuse an approval transaction if supplied so a failed approval cannot leave an orphan flag.
  return withActionTransaction(context, async (transaction) => {
    const actor = context.callerIdentity ?? 'system'
    const flaggedAt = new Date() // Server startup installs the advancing COURSE_NOW clock.
    const flag = await transaction.insertInto('manufacturing.flag_log').values({
      id: `FL-${randomUUID()}`,
      batch_id: batch.id, reason: params.reason, severity: params.severity,
      status: 'open', flagged_by: actor, flagged_at: flaggedAt, resolved_at: null,
    }).returningAll().executeTakeFirstOrThrow()
    // Audit the batch action, with the new flag ID as evidence and proposal authorization when applicable.
    await transaction.withSchema(context.metadataSchema).insertInto('audit_log').values({
      action_type_id: context.actionTypeId, action_api_name: context.actionApiName,
      target_type_id: context.objectTypeId, target_type_api_name: context.objectTypeApiName,
      target_id: batch.id, actor, params: auditParams(context, { reason: params.reason, severity: params.severity }),
      result: { flagLogId: flag.id, batchId: flag.batch_id, status: flag.status, severity: flag.severity },
      created_at: flaggedAt,
    }).execute()
    return flag
  })
}
