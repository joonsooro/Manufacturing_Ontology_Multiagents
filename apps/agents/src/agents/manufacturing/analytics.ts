/**
 * Read-only manufacturing agent entry point. The CLI question is answered using
 * query/get tools; the selected tool list does not grant manufacturing write actions.
 */
import { runAgent } from '../../run-agent.ts'
import { getObject } from '../../tools/shared/getObject.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'

// Join CLI words into the user question; model/tool runtime setup is centralized in runAgent.
const question = process.argv.slice(2).join(' ').trim()

if (!question) {
  console.error('Usage: node --env-file=../../.env src/agents/manufacturing/index.ts "<question>"')
  process.exitCode = 1
} else {
  const result = await runAgent({
    identity: 'analytics-agent',
    systemPrompt: [
      'You are a brewery operations analyst. You help operators understand the current state of production by querying the ontology.',
      'Always cite specific object IDs when answering.',
      "Don't speculate about data you haven't queried.",
      "If you can't answer with the available tools, say so.",
    ].join(' '),
    prompt: question,
    // Capability is enforced through this read-only tool selection, not solely by the prompt text.
    tools: [queryObjects, getObject],
  })

  console.log(result.finalResponse)
}
