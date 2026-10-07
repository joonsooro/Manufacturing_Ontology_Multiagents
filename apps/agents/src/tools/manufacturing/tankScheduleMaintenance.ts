/**
 * Agent-facing wrapper for Tank.scheduleMaintenance.
 * The tool describes the immediate offline transition as well as the scheduled maintenance log.
 */
import { tool } from '@openai/agents'
import { z } from 'zod'
import { invokeAction } from './invokeAction.ts'

/** Tool input includes a target ID for routing plus the action's business parameters. */
export const tankScheduleMaintenanceInput = z.object({
  tankId: z.string().min(1).describe('The tank ID, for example T-8.'),
  type: z.enum(['inspection', 'preventive', 'corrective', 'cleaning']),
  plannedAt: z.string().datetime({ offset: true }).describe('Planned maintenance as an ISO 8601 datetime with a timezone.'),
  notes: z.string().describe('Notes describing the planned maintenance.'),
})

export type TankScheduleMaintenanceInput = z.infer<typeof tankScheduleMaintenanceInput>

/** Separate target routing from parameters before invoking the server action. */
export async function executeTankScheduleMaintenance(input: TankScheduleMaintenanceInput): Promise<unknown> {
  const { tankId, type, plannedAt, notes } = tankScheduleMaintenanceInput.parse(input)
  return invokeAction('tank', tankId, 'scheduleMaintenance', { type, plannedAt, notes })
}

// Agents SDK registration reuses the same executor exposed by the MCP bridge.
export const tankScheduleMaintenance = tool({
  name: 'tank_schedule_maintenance',
  description: 'Takes the tank offline immediately by setting its status to maintenance and creates a scheduled maintenance log. Rejects tanks with a fermenting batch. Returns the updated tank.',
  parameters: tankScheduleMaintenanceInput,
  execute: async (input) => JSON.stringify(await executeTankScheduleMaintenance(input)),
})
