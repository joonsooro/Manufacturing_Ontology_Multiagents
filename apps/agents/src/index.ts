/**
 * Public agent package exports. Import these helpers to define a new domain agent
 * without duplicating runtime setup, ontology context loading, or event streaming.
 */
export { runAgent } from './run-agent.ts'
export type { AgentRunResult, RunAgentInput, RunAgentOptions } from './run-agent.ts'
export { buildSchemaBlock } from './helpers/buildSchemaBlock.ts'
