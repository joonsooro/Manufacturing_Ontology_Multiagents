/** Direct safety-stop tool; ontology execution owns state validation, row locking, and audit attribution. */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { invokeAction } from './invokeAction.ts'

export const batchPlaceOnHoldInput = z.object({
  batchId: z.string().trim().min(1).describe('The batch to place on hold.'),
  reason: z.string().trim().min(1).describe('The safety-stop reason with source object IDs and supporting evidence.'),
}).strict()

export type BatchPlaceOnHoldInput = z.infer<typeof batchPlaceOnHoldInput>

/** Keep routing outside the action body and delegate caller headers to the shared transport. */
export async function executeBatchPlaceOnHold(input: BatchPlaceOnHoldInput): Promise<unknown> {
  const { batchId, reason } = batchPlaceOnHoldInput.parse(input)
  return invokeAction('batch', batchId, 'placeOnHold', { reason })
}

export const batchPlaceOnHold = tool({
  name: 'batch_place_on_hold',
  description: 'Place a fermenting or conditioning batch on hold immediately and record the reason. Returns the updated batch.',
  parameters: batchPlaceOnHoldInput,
  execute: async (input) => JSON.stringify(await executeBatchPlaceOnHold(input)),
})
