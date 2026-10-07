/**
 * Resolve a public object type to its instance table and primary key from metadata.
 * Shared proposal handlers use this instead of hardcoding manufacturing tables.
 */
import type { ActionContext } from '../types.ts'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/** Resolve storage through the current catalog, without manufacturing-specific names. */
export async function resolveObjectStorage(context: ActionContext, apiName: string) {
  if (!IDENTIFIER.test(context.metadataSchema)) throw new Error('Invalid metadata schema')
  const metadata = context.database.withSchema(context.metadataSchema)
  const objectType = await metadata.selectFrom('object_type').selectAll()
    .where('api_name', '=', apiName).executeTakeFirst()
  if (!objectType) throw new Error(`Object type ${apiName} not found`)
  // Keep dynamically resolved storage inside the current catalog schema and validate SQL identifiers.
  if (objectType.schema !== context.metadataSchema || !IDENTIFIER.test(objectType.datasource_table)) {
    throw new Error(`Object type ${apiName} has invalid instance storage`)
  }
  // Public type names need not match table names, and primary keys need not be named id.
  const key = await metadata.selectFrom('property').select('datasource_column')
    .where('object_type_id', '=', objectType.id).where('is_primary_key', '=', true).executeTakeFirst()
  if (!key || !IDENTIFIER.test(key.datasource_column)) {
    throw new Error(`Object type ${apiName} has no valid primary key metadata`)
  }
  return {
    objectType,
    table: `${objectType.schema}.${objectType.datasource_table}`,
    primaryKey: key.datasource_column,
  }
}
