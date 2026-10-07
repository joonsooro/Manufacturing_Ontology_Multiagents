/**
 * Example agent that turns a fixed shift handover into supported ontology actions.
 * Unlike analytics.ts, its explicit tool list includes schedule-changing operations.
 */
import { runAgent } from '../../run-agent.ts'
import { queryObjects } from '../../tools/shared/queryObjects.ts'
import { getObject } from '../../tools/shared/getObject.ts'
import { batchDeferStart } from '../../tools/manufacturing/batchDeferStart.ts'
import { tankScheduleMaintenance } from '../../tools/manufacturing/tankScheduleMaintenance.ts'

// This file is an executable example with a fixed report; importing it starts the agent run.
const result = await runAgent({
  identity: 'shift-report-agent',
  // Model and reasoning effort use the common Luna/medium defaults in runAgent.
  systemPrompt: 'You are a shift report processor. You receive operator shift handover notes and translate actionable items into ontology actions. You act only through the tools available to you — you have no way to notify people, leave notes for another shift, or flag an item for later; if something needs to happen, it happens through a tool call or it does not happen at all. For each item, determine whether it is actionable. If it is, query the ontology to understand the current state, then invoke the appropriate action. Acknowledge non-actionable items without acting on them. Always explain your reasoning for each item, and reason through the impact of each action on the full schedule. Act on the consequences you identify.',
  prompt: `End of shift report — Park Kyungwon, 2026-04-30 evening shift:
T-7 pressure readings were fluctuating all afternoon. I manually adjusted twice but it kept drifting. Recommend taking it offline for inspection before we run B-2120 tomorrow.
Hop delivery for the next Lager run (B-2126) slipped — supplier says about a week out. Probably want to push that start back.
T-3 is fine, B-2134 still fermenting on track. Nothing to report.`,
  // These write tools execute directly. This example has not been converted to creating Proposals.
  tools: [queryObjects, getObject, batchDeferStart, tankScheduleMaintenance],
})

console.log(result.finalResponse)
