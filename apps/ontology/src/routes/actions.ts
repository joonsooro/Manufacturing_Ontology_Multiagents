/**
 * Action invocation pipeline: resolve metadata, log/enforce caller access, validate JSON inputs, locate the target,
 * then dispatch the exact registry key with caller and audit context.
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import { Hono } from 'hono'
import { actionHandlers } from '../actions/index.ts'
import { db } from '../db.ts'

// Only configured ontology schemas can supply instance tables to the HTTP API.
const INSTANCE_SCHEMAS = new Set(['manufacturing'])
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/** Validate catalog-sourced SQL identifiers before constructing a qualified instance table. */
function resolveInstanceTable(schema: string, table: string): string | null {
  if (!INSTANCE_SCHEMAS.has(schema) || !IDENTIFIER.test(schema) || !IDENTIFIER.test(table)) {
    return null
  }
  return `${schema}.${table}`
}

// Dynamic tables preserve metadata-driven dispatch even when the concrete instance type varies.
function dynamicInstanceTable(qualifiedTable: string) {
  return db.dynamic.table<any>(qualifiedTable).as('instance')
}

function dynamicInstanceColumn(column: string) {
  return db.dynamic.ref(`instance.${column}`)
}

export const actionRoutes = new Hono()

// Route flow: type -> action metadata -> access decision -> JSON validation -> instance -> handler.
actionRoutes.post('/:type/:id/actions/:actionName', async (context) => {
  const typeApiName = context.req.param('type')
  const actionApiName = context.req.param('actionName')

  for (const metadataSchema of INSTANCE_SCHEMAS) {
    const metadataDb = db.withSchema(metadataSchema)
    const objectType = await metadataDb
      .selectFrom('object_type')
      .selectAll()
      .where('api_name', '=', typeApiName)
      .executeTakeFirst()

    if (!objectType) continue

    const instanceTable = resolveInstanceTable(objectType.schema, objectType.datasource_table)
    if (!instanceTable) return context.json({ error: 'Object type has an invalid instance schema' }, 400)

    const actionType = await metadataDb
      .selectFrom('action_type')
      .selectAll()
      .where('object_type_id', '=', objectType.id)
      .where('api_name', '=', actionApiName)
      .executeTakeFirst()

    if (!actionType) return context.json({ error: 'Action not found' }, 404)

    // Only x-caller-identity supplies this policy identity; missing headers use system.
    // This checks the supplied identity, not an authenticated login. Header trust belongs
    // to the application boundary, and x-actor cannot bypass the configured caller list.
    const callerIdentity = context.req.header('x-caller-identity') ?? 'system'
    const restricted = Boolean(actionType.allowed_callers?.length)
    const allowed = !restricted || actionType.allowed_callers!.includes(callerIdentity)
    const reason = !restricted ? 'Action has no caller restriction'
      : allowed ? 'Caller is listed in allowed_callers' : 'Caller is not listed in allowed_callers'

    // Admission is logged before reading/validating the body, outside the business-action
    // transaction. It survives later validation/handler failures and denied attempts.
    // Await the write: if logging fails, no handler runs and Hono returns a server error.
    await metadataDb.insertInto('access_log').values({
      caller_identity: callerIdentity,
      action_type: `${objectType.api_name}.${actionType.api_name}`,
      target_type: objectType.api_name,
      target_id: context.req.param('id'),
      decision: allowed ? 'allowed' : 'denied', reason,
      // Keep the same course clock used by review decisions rather than the DB wall clock.
      timestamp: new Date(),
    }).execute()
    if (!allowed) return context.json({ error: 'Caller is not permitted to invoke this action' }, 403)

    let params: unknown
    try {
      params = await context.req.json()
    } catch {
      return context.json({ error: 'Request body must be valid JSON' }, 400)
    }

    // Invalid inputs stop before any handler executes; the metadata schema is the public action contract.
    const validation = new Validator(actionType.parameter_schema as Schema, '2020-12', false).validate(params)
    if (!validation.valid) {
      return context.json({ error: 'Action parameters are invalid', details: validation.errors }, 400)
    }

    // The URL ID is compared with the primary-key column named by this type's metadata.
    const primaryKey = await metadataDb
      .selectFrom('property')
      .select('datasource_column')
      .where('object_type_id', '=', objectType.id)
      .where('is_primary_key', '=', true)
      .executeTakeFirst()

    if (!primaryKey || !IDENTIFIER.test(primaryKey.datasource_column)) {
      return context.json({ error: 'Object type has no valid primary key metadata' }, 500)
    }

    const instance = await db
      .selectFrom(dynamicInstanceTable(instanceTable))
      .selectAll()
      .where(dynamicInstanceColumn(primaryKey.datasource_column), '=', context.req.param('id'))
      .executeTakeFirst()

    if (!instance) return context.json({ error: 'Object instance not found' }, 404)

    // Case matters: batch.deferStart is a different key from batch.deferstart.
    const handler = actionHandlers[`${objectType.api_name}.${actionType.api_name}`]
    if (!handler) return context.json({ error: 'Action has no implementation' }, 501)

    try {
      const result = await handler(instance, params, {
        database: db,
        metadataSchema,
        objectTypeId: objectType.id,
        objectTypeApiName: objectType.api_name,
        actionTypeId: actionType.id,
        actionApiName: actionType.api_name,
        // Use the same identity for admission and business audit attribution.
        actor: callerIdentity,
        callerIdentity,
      })

      return context.json(result)
    // Business-rule failures become a 400 response; transactional rollback belongs to the handler.
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action failed'
      return context.json({ error: message }, 400)
    }
  }

  return context.json({ error: 'Object type not found' }, 404)
})
