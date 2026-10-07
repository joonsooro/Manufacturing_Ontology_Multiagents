/**
 * Batch.deferStart: postpone a queued batch to a future start time.
 * The updated schedule and audit entry share the caller's transaction.
 */
import { auditParams, withActionTransaction } from '../shared/transaction.ts'
import type { BatchTable } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import type { ActionParams, batchDeferStartDefinition } from '../../schema.ts'

// Derive parameter types from the same definition used to publish action_type metadata.
export type BatchDeferStartParams = ActionParams<typeof batchDeferStartDefinition.parameter_schema>

export async function batchDeferStart(
  batch: BatchTable,
  params: BatchDeferStartParams | undefined,
  context: ActionContext,
): Promise<BatchTable> {
  if (!params) {
    throw new Error('Batch.deferStart requires newPlannedStart')
  }

  // Date.now() follows the course clock installed at server startup, not the machine calendar.
  const newPlannedStart = new Date(params.newPlannedStart)
  if (Number.isNaN(newPlannedStart.valueOf())) {
    throw new Error('newPlannedStart must be a valid datetime')
  }
  if (newPlannedStart.valueOf() <= Date.now()) {
    throw new Error('newPlannedStart must be in the future')
  }

  // Join a proposal approval transaction when present; otherwise execute as a standalone transaction.
  return withActionTransaction(context, async (transaction) => {
    // Check current stored status under a lock instead of trusting the instance loaded by the route.
    const currentBatch = await transaction
      .selectFrom('manufacturing.batch')
      .selectAll()
      .where('id', '=', batch.id)
      .forUpdate()
      .executeTakeFirst()

    if (!currentBatch) {
      throw new Error(`Batch ${batch.id} no longer exists`)
    }
    if (currentBatch.status !== 'queued') {
      throw new Error(`Batch ${batch.id} cannot be deferred because its status is ${currentBatch.status}, not queued`)
    }

    // Deferral changes scheduling only; the batch remains queued.
    const updatedBatch = await transaction
      .updateTable('manufacturing.batch')
      .set({ planned_start: newPlannedStart })
      .where('id', '=', batch.id)
      .returningAll()
      .executeTakeFirstOrThrow()

    // Audit the successful mutation in the same transaction, including proposal authorization when supplied.
    await transaction
      .withSchema(context.metadataSchema)
      .insertInto('audit_log')
      .values({
        action_type_id: context.actionTypeId,
        action_api_name: context.actionApiName,
        target_type_id: context.objectTypeId,
        target_type_api_name: context.objectTypeApiName,
        target_id: updatedBatch.id,
        // Caller identity may be an approving reviewer; absent identity falls back to system.
        actor: context.callerIdentity ?? 'system',
        params: auditParams(context, { newPlannedStart: params.newPlannedStart }),
        result: {
          id: updatedBatch.id,
          plannedStart: updatedBatch.planned_start?.toISOString() ?? null,
          status: updatedBatch.status,
        },
      })
      .execute()

    return updatedBatch
  })
}
