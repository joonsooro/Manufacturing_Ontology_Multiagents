/** Batch.placeOnHold is an immediate safety stop; reason lives in the immutable action audit. */
import type { ActionParams, BatchTable, batchPlaceOnHoldDefinition } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { executeBatchIntervention } from './batchIntervention.ts'

export type BatchPlaceOnHoldParams = ActionParams<typeof batchPlaceOnHoldDefinition.parameter_schema>

export async function batchPlaceOnHold(batch: BatchTable, params: BatchPlaceOnHoldParams | undefined, context: ActionContext): Promise<BatchTable> {
  if (!params || typeof params.reason !== 'string' || !params.reason.trim()) {
    throw new Error('Batch.placeOnHold requires a non-empty reason')
  }
  // The shared boundary locks and checks current status, then commits status and audit together.
  return executeBatchIntervention({ batchId: batch.id, context, params: { reason: params.reason }, change: () => ({ status: 'onHold' }) })
}
