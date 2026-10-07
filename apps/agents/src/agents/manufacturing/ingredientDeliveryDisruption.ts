/** Proposal-only manufacturing agent; instructions and supplier notices are supplied as configuration. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { runAgent } from '../../run-agent.ts'
import type { RunAgentOptions } from '../../run-agent.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'
import { getObject } from '../../tools/shared/getObject.ts'
import { proposeBatchCancel } from '../../tools/manufacturing/proposeBatchCancel.ts'
import { proposeBatchDeferStart } from '../../tools/manufacturing/proposeBatchDeferStart.ts'

/** Validate file-supplied text before starting a model run or creating any proposals. */
export const disruptionConfigSchema = z.object({
  systemPrompt: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
}).strict()

export type IngredientDeliveryDisruptionInput = z.infer<typeof disruptionConfigSchema> & {
  options?: RunAgentOptions
}

/** Callers provide scenario text and model choices; this agent owns its identity and permitted tools. */
export async function runIngredientDeliveryDisruption(input: IngredientDeliveryDisruptionInput) {
  const config = disruptionConfigSchema.parse({ systemPrompt: input.systemPrompt, prompt: input.prompt })
  return runAgent({
    ...config,
    options: input.options,
    identity: 'ingredient-delivery-disruption-agent',
    // The MCP allowlist enforces proposal-only capability independently of the configurable instructions.
    tools: [queryObjects, getObject, proposeBatchCancel, proposeBatchDeferStart],
  })
}

// Importing this module exposes the reusable function without launching an agent.
// The CLI loads the supplied JSON file, or the provided Citra example when no path is given.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configFile = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL('./ingredientDeliveryDisruption.config.json', import.meta.url)
  const config = disruptionConfigSchema.parse(JSON.parse(await readFile(configFile, 'utf8')))
  const result = await runIngredientDeliveryDisruption(config)
  console.log(result.finalResponse)
}
