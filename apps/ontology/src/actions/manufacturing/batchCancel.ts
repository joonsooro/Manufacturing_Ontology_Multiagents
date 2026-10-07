/**
 * Batch.cancel: stop a queued or fermenting batch and preserve the reason in its audit.
 * Status change and audit succeed or fail together, including when invoked by a proposal.
 */
import { auditParams, withActionTransaction } from '../shared/transaction.ts'
import type { ActionParams, BatchTable, batchCancelDefinition } from '../../schema.ts'
import type { ActionContext } from '../types.ts'

// Derive parameter types from the same definition used to publish action_type metadata.
export type BatchCancelParams = ActionParams<typeof batchCancelDefinition.parameter_schema>

export async function batchCancel(
  batch: BatchTable,
  params: BatchCancelParams | undefined,
  context: ActionContext,
): Promise<BatchTable> {
  if (!params || typeof params.reason !== 'string') {
    throw new Error('Batch.cancel requires reason (string)')
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
    if (currentBatch.status !== 'queued' && currentBatch.status !== 'fermenting') {
      throw new Error(`Batch ${batch.id} cannot be cancelled because its status is ${currentBatch.status}, not queued or fermenting`)
    }

    // Cancellation changes only status; preserve other batch data and put the reason in the audit.
    const updatedBatch = await transaction
      .updateTable('manufacturing.batch')
      .set({ status: 'cancelled' })
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
        params: auditParams(context, { reason: params.reason }),
        result: { id: updatedBatch.id, status: updatedBatch.status },
      })
      .execute()

    return updatedBatch
  })
}
