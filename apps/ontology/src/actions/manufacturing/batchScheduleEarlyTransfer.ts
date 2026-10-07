/** Batch.scheduleEarlyTransfer changes a plan; it neither executes transfer nor allocates/checks a vessel. */
import type { ActionParams, BatchTable, batchScheduleEarlyTransferDefinition } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { executeBatchIntervention, requirePlannedTransfer } from './batchIntervention.ts'

export type BatchScheduleEarlyTransferParams = ActionParams<typeof batchScheduleEarlyTransferDefinition.parameter_schema>

export async function batchScheduleEarlyTransfer(batch: BatchTable, params: BatchScheduleEarlyTransferParams | undefined, context: ActionContext): Promise<BatchTable> {
  if (!params || typeof params.plannedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(params.plannedAt)) {
    throw new Error('Batch.scheduleEarlyTransfer requires plannedAt with an explicit timezone')
  }
  const next = new Date(params.plannedAt)
  if (!Number.isFinite(next.valueOf())) throw new Error('plannedAt must be a valid datetime')
  // Compare with the stored plan under the shared lock; approvals may execute long after proposal creation.
  return executeBatchIntervention({ batchId: batch.id, context, params: { plannedAt: params.plannedAt }, change: (current) => {
    const planned = requirePlannedTransfer(current)
    if (next.valueOf() <= Date.now() || next.valueOf() >= planned.valueOf()) {
      throw new Error('Early transfer must be in the future and earlier than the current planned transfer')
    }
    return { planned_transfer_at: next }
  } })
}
