/** Shared execution boundary for batch-local holds and transfer schedule interventions. */
import type { BatchTable, JsonValue } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { auditParams, withActionTransaction } from '../shared/transaction.ts'

type InterventionInput = {
  batchId: string
  context: ActionContext
  params: Record<string, JsonValue>
  /** Compute the change from the locked current row, not the route's potentially stale snapshot. */
  change: (current: BatchTable) => { status?: string; planned_transfer_at?: Date }
}

/**
 * Join an approval transaction or start one. The row lock serializes competing
 * interventions, and the target-only update cannot cascade to another batch.
 * Audit failure rolls back the mutation; approval retains ownership of outer commit/rollback.
 */
export async function executeBatchIntervention({ batchId, context, params, change }: InterventionInput): Promise<BatchTable> {
  return withActionTransaction(context, async (transaction) => {
    const current = await transaction.selectFrom('manufacturing.batch').selectAll()
      .where('id', '=', batchId).forUpdate().executeTakeFirst()
    if (!current) throw new Error(`Batch ${batchId} no longer exists`)
    if (current.status !== 'fermenting' && current.status !== 'conditioning') {
      throw new Error(`Batch ${batchId} cannot run ${context.actionApiName} in status ${current.status}; expected fermenting or conditioning`)
    }
    const updated = await transaction.updateTable('manufacturing.batch').set(change(current))
      .where('id', '=', batchId).returningAll().executeTakeFirstOrThrow()
    // Capture before/after evidence and reviewer attribution using the same conventions as existing actions.
    await transaction.withSchema(context.metadataSchema).insertInto('audit_log').values({
      action_type_id: context.actionTypeId, action_api_name: context.actionApiName,
      target_type_id: context.objectTypeId, target_type_api_name: context.objectTypeApiName,
      target_id: batchId, actor: context.callerIdentity ?? 'system',
      params: auditParams(context, params),
      result: {
        id: batchId, status: updated.status, previousStatus: current.status,
        plannedTransferAt: updated.planned_transfer_at?.toISOString() ?? null,
        previousPlannedTransferAt: current.planned_transfer_at?.toISOString() ?? null,
      },
    }).execute()
    return updated
  })
}

/** An absent transfer plan is not a usable baseline for relative schedule changes. */
export function requirePlannedTransfer(batch: BatchTable): Date {
  if (!batch.planned_transfer_at || !Number.isFinite(batch.planned_transfer_at.valueOf())) {
    throw new Error(`Batch ${batch.id} has no valid planned transfer`)
  }
  return batch.planned_transfer_at
}
