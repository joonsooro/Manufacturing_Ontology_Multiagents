/**
 * Agent-facing Batch.flag tool. It records a concern, while the ontology handler
 * owns FlagLog creation, caller attribution, and the atomic audit write.
 */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { invokeAction } from './invokeAction.ts'

/** batchId routes the request; only reason and severity belong to the action body. */
export const batchFlagInput = z.object({
  batchId: z.string().trim().min(1).describe('The batch ID to flag.'),
  reason: z.string().trim().min(1).describe('Supported concern with source IDs, sugar comparison, and quoted recommendations or caveats as evidence.'),
  severity: z.enum(['low', 'medium', 'high']).describe('low: acceptable watch-only drift; medium: likely needs process intervention; high: confirmed contamination, active safety hold, or a current operator/expert recommendation for a safety hold or urgent protective safety escalation. A recommended hold does not require confirmed contamination or an implemented hold.'),
}).strict()

export type BatchFlagInput = z.infer<typeof batchFlagInput>

/** Use the shared action transport so server-side validation and audit guarantees apply. */
export async function executeBatchFlag(input: BatchFlagInput): Promise<unknown> {
  const { batchId, reason, severity } = batchFlagInput.parse(input)
  return invokeAction('batch', batchId, 'flag', { reason, severity })
}

export const batchFlag = tool({
  name: 'batch_flag',
  description: 'Create an open FlagLog for a supported batch concern without changing production status or prescribing an intervention. Returns the new FlagLog.',
  parameters: batchFlagInput,
  execute: async (input) => JSON.stringify(await executeBatchFlag(input)),
})
