/** Batch.extendRest adds whole elapsed days to this batch's existing planned transfer. */
import type { ActionParams, BatchTable, batchExtendRestDefinition } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { executeBatchIntervention, requirePlannedTransfer } from './batchIntervention.ts'

export type BatchExtendRestParams = ActionParams<typeof batchExtendRestDefinition.parameter_schema>

export async function batchExtendRest(batch: BatchTable, params: BatchExtendRestParams | undefined, context: ActionContext): Promise<BatchTable> {
  if (!params || !Number.isSafeInteger(params.additionalDays) || params.additionalDays < 1) {
    throw new Error('Batch.extendRest requires additionalDays to be a positive integer')
  }
  // Recompute under the shared row lock so concurrent extensions do not lose one another's days.
  return executeBatchIntervention({ batchId: batch.id, context, params: { additionalDays: params.additionalDays }, change: (current) => {
    const planned = requirePlannedTransfer(current)
    const next = new Date(planned.valueOf() + params.additionalDays * 86_400_000)
    if (!Number.isFinite(next.valueOf())) {
      throw new Error('Extended planned transfer must be a valid datetime')
    }
    return { planned_transfer_at: next }
  } })
}
