/**
 * Tank.scheduleMaintenance: take a tank offline now and create a future maintenance record.
 * A currently fermenting batch blocks the action; tank, log, and audit writes are atomic.
 */
import { auditParams, withActionTransaction } from '../shared/transaction.ts'
import { randomUUID } from 'node:crypto'
import type { TankTable } from '../../schema.ts'
import type { ActionContext } from '../types.ts'
import { tankScheduleMaintenanceDefinition, type ActionParams } from '../../schema.ts'

const maintenanceTypes = tankScheduleMaintenanceDefinition.parameter_schema.properties.type.enum

// Derive parameter types from the same definition used to publish action_type metadata.
export type TankScheduleMaintenanceParams = ActionParams<typeof tankScheduleMaintenanceDefinition.parameter_schema>

/** Guard direct calls using the same allowed values published in action metadata. */
function isMaintenanceType(value: unknown): value is TankScheduleMaintenanceParams['type'] {
  return typeof value === 'string' && maintenanceTypes.includes(value as TankScheduleMaintenanceParams['type'])
}

export async function tankScheduleMaintenance(
  tank: TankTable,
  params: TankScheduleMaintenanceParams | undefined,
  context: ActionContext,
): Promise<TankTable> {
  if (!params || !isMaintenanceType(params.type) || typeof params.notes !== 'string') {
    throw new Error('Tank.scheduleMaintenance requires type, plannedAt, and notes')
  }

  const plannedAt = new Date(params.plannedAt)
  if (Number.isNaN(plannedAt.valueOf())) {
    throw new Error('plannedAt must be a valid datetime')
  }

  // Join a proposal approval transaction when present; otherwise execute as a standalone transaction.
  return withActionTransaction(context, async (transaction) => {
    // Taking this tank offline is invalid while any assigned batch is actively fermenting.
    const fermentingBatch = await transaction
      .selectFrom('manufacturing.batch')
      .select('id')
      .where('assigned_tank_id', '=', tank.id)
      .where('status', '=', 'fermenting')
      .executeTakeFirst()

    if (fermentingBatch) {
      throw new Error(`Tank ${tank.id} cannot enter maintenance while batch ${fermentingBatch.id} is fermenting`)
    }

    // Offline starts immediately, even if the maintenance appointment is in the future.
    const updatedTank = await transaction
      .updateTable('manufacturing.tank')
      .set({ status: 'maintenance' })
      .where('id', '=', tank.id)
      .returningAll()
      .executeTakeFirstOrThrow()

    // The random suffix avoids ID collisions for repeated appointments on the same tank/day.
    const maintenanceLog = await transaction
      .insertInto('manufacturing.maintenance_log')
      .values({
        id: `ML-${tank.id.replace(/[^A-Za-z0-9]/g, '')}-${plannedAt.toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`,
        target_type: 'tank',
        target_id: tank.id,
        type: params.type,
        status: 'scheduled',
        planned_at: plannedAt,
        notes: params.notes,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Audit the successful mutation in the same transaction, including proposal authorization when supplied.
    await transaction
      .withSchema(context.metadataSchema)
      .insertInto('audit_log')
      .values({
        action_type_id: context.actionTypeId,
        action_api_name: context.actionApiName,
        target_type_id: context.objectTypeId,
        target_type_api_name: context.objectTypeApiName,
        target_id: tank.id,
        actor: context.callerIdentity ?? context.actor,
        params: auditParams(context, { type: params.type, plannedAt: params.plannedAt, notes: params.notes }),
        result: {
          tank: { id: updatedTank.id, status: updatedTank.status },
          maintenanceLog: {
            id: maintenanceLog.id,
            status: maintenanceLog.status,
            plannedAt: maintenanceLog.planned_at?.toISOString() ?? null,
          },
        },
      })
      .execute()

    return updatedTank
  })
}
