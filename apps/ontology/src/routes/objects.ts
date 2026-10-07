/**
 * Metadata-driven instance creation, reads, filtered queries, link resolution, and audit history.
 * Public property names map to database columns through the catalog, not caller-supplied SQL.
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import { Hono } from 'hono'
import { sql, type Kysely } from 'kysely'
import { db as defaultDb } from '../db.ts'
import type { Database } from '../schema.ts'

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

type ObjectType = {
  id: string
  api_name: string
  schema: string
  datasource_table: string
  edits_enabled: boolean
}

type Property = {
  api_name: string
  datasource_column: string
  is_primary_key: boolean
  data_type: string
  required: boolean
}

/** Supplement the public metadata with the column's generation, nullability, and enum facts. */
type Column = {
  column_name: string
  column_default: string | null
  is_identity: string
  is_generated: string
  is_nullable: string
  data_type: string
  enum_values: string[] | null
}

/** Both identity/serial IDs and computed columns must be supplied by PostgreSQL. */
function isGenerated(column: Column): boolean {
  return column.is_identity === 'YES' || column.is_generated !== 'NEVER' ||
    /^nextval\(/.test(column.column_default ?? '')
}

/** Translate metadata into the same JSON Schema validation mechanism used for actions. */
function propertySchema(property: Property, column: Column): Schema {
  let schema: Schema
  switch (property.data_type) {
    case 'string': schema = { type: 'string' }; break
    // Text-based enums still rely on their storage CHECK constraints; native enums expose their labels here.
    case 'enum': schema = column.enum_values ? { type: 'string', enum: column.enum_values } : { type: 'string' }; break
    case 'number':
      schema = { type: ['smallint', 'integer', 'bigint'].includes(column.data_type) ? 'integer' : 'number' }
      break
    case 'boolean': schema = { type: 'boolean' }; break
    case 'datetime': schema = { type: 'string', format: 'date-time' }; break
    case 'string[]': schema = { type: 'array', items: { type: 'string' } }; break
    // JSON properties preserve arbitrary structured inputs. Nested action params are validated by the action itself.
    case 'json': schema = { not: { type: 'null' } }; break
    default: throw new Error(`Unsupported property type: ${property.data_type}`)
  }
  // Explicit null is valid only for optional, nullable properties; omission can instead request a default.
  return !property.required && column.is_nullable === 'YES'
    ? { anyOf: [schema, { type: 'null' }] } : schema
}

// The public query language is a small operator allowlist, not arbitrary SQL.
const FILTER_OPERATORS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'isNull',
  'isNotNull',
])

type QueryFilter = {
  property: string
  op: string
  value?: unknown
}

type ResolvedTable = {
  schema: string
  table: string
  qualifiedTable: string
}

/** Build the shared object router; tests can supply an isolated catalog without changing global state. */
export function createObjectRoutes(
  db: Kysely<Database> = defaultDb,
  instanceSchemas: ReadonlySet<string> = new Set(['manufacturing']),
) {
  const INSTANCE_SCHEMAS = instanceSchemas

  /** Restrict instance access to configured schemas and valid catalog identifiers. */
  function resolveInstanceTable(schema: string, table: string): ResolvedTable | null {
    if (
      !INSTANCE_SCHEMAS.has(schema) ||
      !IDENTIFIER.test(schema) ||
      !IDENTIFIER.test(table)
    ) {
      return null
    }

    return { schema, table, qualifiedTable: `${schema}.${table}` }
  }

  function isSafeColumn(column: string): boolean {
    return IDENTIFIER.test(column)
  }

  function dynamicInstanceTable(qualifiedTable: string) {
    return db.dynamic.table<any>(qualifiedTable).as('instance')
  }

  function dynamicInstanceColumn(column: string) {
    return db.dynamic.ref(`instance.${column}`)
  }

  /** Resolve a public type to its owning catalog and storage metadata. */
  async function findObjectType(type: string) {
    for (const schema of INSTANCE_SCHEMAS) {
      const objectType = await db
        .withSchema(schema)
        .selectFrom('object_type')
        .select(['id', 'api_name', 'schema', 'datasource_table', 'edits_enabled'])
        .where('api_name', '=', type)
        .executeTakeFirst()

      if (objectType) {
        return { metadataSchema: schema, objectType: objectType satisfies ObjectType }
      }
    }

    return null
  }

  /** One property lookup serves creation validation, filters, and link traversal. */
  async function getProperties(metadataSchema: string, objectTypeId: string) {
    return db
      .withSchema(metadataSchema)
      .selectFrom('property')
      .select(['api_name', 'datasource_column', 'is_primary_key', 'data_type', 'required'])
      .where('object_type_id', '=', objectTypeId)
      .execute() as Promise<Property[]>
  }

  /** Cardinality reverses for inbound links: the parent of many_to_one sees a collection. */
  function isCollection(cardinality: string, direction: 'outbound' | 'inbound'): boolean {
    if (cardinality === 'many_to_many') return true
    if (cardinality === 'many_to_one') return direction === 'inbound'
    if (cardinality === 'one_to_many') return direction === 'outbound'
    return false
  }

  const objectRoutes = new Hono()

  // Creation accepts public property names; metadata validation and storage defaults determine the inserted row.
  objectRoutes.post('/:type', async (context) => {
    const found = await findObjectType(context.req.param('type'))
    if (!found) return context.json({ error: 'Object type not found' }, 404)
    const objectType = found.objectType
    // Reuse the same catalog-storage boundary as instance reads and filtered queries.
    const instanceTable = resolveInstanceTable(objectType.schema, objectType.datasource_table)
    if (!instanceTable) return context.json({ error: 'Object type has an invalid instance schema' }, 500)
    if (!objectType.edits_enabled) return context.json({ error: 'Object type does not allow edits' }, 403)

    let body: unknown
    try { body = await context.req.json() }
    catch { return context.json({ error: 'Request body must be valid JSON' }, 400) }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return context.json({ error: 'Request body must be a JSON object' }, 400)
    }

    const properties = await getProperties(found.metadataSchema, objectType.id)
    // A primary-key flag alone cannot distinguish required text IDs from Proposal's generated integer ID.
    const { rows: columns } = await sql<Column>`
      SELECT c.column_name, c.column_default, c.is_identity, c.is_generated,
             c.is_nullable, c.data_type,
             (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
              FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
              JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE n.nspname = c.udt_schema AND t.typname = c.udt_name) AS enum_values
      FROM information_schema.columns c
      WHERE c.table_schema = ${objectType.schema} AND c.table_name = ${objectType.datasource_table}
    `.execute(db)
    const columnsByName = new Map(columns.map(column => [column.column_name, column]))
    const propertyByName = new Map(properties.map(property => [property.api_name, property]))
    if (!properties.length || properties.some(property => !IDENTIFIER.test(property.datasource_column) ||
        !columnsByName.has(property.datasource_column)) ||
        new Set(properties.map(property => property.datasource_column)).size !== properties.length) {
      return context.json({ error: 'Object type has invalid property metadata' }, 500)
    }
    for (const [name, value] of Object.entries(body)) {
      const property = propertyByName.get(name)
      if (!property) return context.json({ error: `Unknown property: ${name}` }, 400)
      if (isGenerated(columnsByName.get(property.datasource_column)!)) {
        return context.json({ error: `${name} is generated by the database and must be omitted` }, 400)
      }
      // JSON.parse accepts overflowing exponents as Infinity; do not pass those off as valid readings.
      if (typeof value === 'number' && !Number.isFinite(value)) {
        return context.json({ error: `${name} must be a finite number` }, 400)
      }
    }

    let schemaProperties: Record<string, Schema>
    try {
      schemaProperties = Object.fromEntries(properties.map(property => [
        property.api_name, propertySchema(property, columnsByName.get(property.datasource_column)!),
      ]))
    } catch {
      return context.json({ error: 'Object type has an unsupported property data type' }, 500)
    }
    const required = properties.filter(property => {
      const column = columnsByName.get(property.datasource_column)!
      // Defaults fulfill required metadata without client input; absent non-nullable columns still need a value.
      return !isGenerated(column) && column.column_default === null &&
        (property.required || column.is_nullable === 'NO')
    }).map(property => property.api_name)
    const validation = new Validator({ type: 'object', properties: schemaProperties, required, additionalProperties: false }, '2020-12', false)
      .validate(body)
    if (!validation.valid) {
      return context.json({ error: 'Object properties are invalid', details: validation.errors }, 400)
    }

    const values = Object.fromEntries(Object.entries(body).map(([name, value]) => {
      const property = propertyByName.get(name)!
      // pg treats JS arrays as SQL arrays. Serialize JSON properties so JSON arrays/scalars round-trip correctly too.
      return [property.datasource_column, property.data_type === 'json' && value !== null ? JSON.stringify(value) : value]
    }))
    // Metadata has validated this dynamic table/column shape; no single domain interface can describe every type.
    const instanceDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
    let insert = instanceDb.insertInto(instanceTable.qualifiedTable)
    insert = Object.keys(values).length ? insert.values(values) : insert.defaultValues()
    try {
      // One INSERT is atomic; return the stored row including generated IDs/defaults, like the existing read APIs.
      return context.json(await insert.returningAll().executeTakeFirstOrThrow(), 201)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === '23505') return context.json({ error: 'Object conflicts with an existing instance' }, 409)
      // Constraints cover relationships, text-enum labels, and checks not represented by the property catalog.
      if (code?.startsWith('23') || code?.startsWith('22')) {
        return context.json({ error: 'Object violates its storage constraints' }, 400)
      }
      throw error
    }
  })

  // Structured queries address public property names; metadata translates them to physical columns.
  objectRoutes.post('/:type/query', async (context) => {
    const found = await findObjectType(context.req.param('type'))
    if (!found) return context.json({ error: 'Object type not found' }, 404)

    const instanceTable = resolveInstanceTable(found.objectType.schema, found.objectType.datasource_table)
    if (!instanceTable) return context.json({ error: 'Object type has an invalid instance schema' }, 400)

    let body: { filters?: unknown; limit?: unknown }
    try {
      body = await context.req.json()
    } catch {
      return context.json({ error: 'Request body must be valid JSON' }, 400)
    }

    if (body.filters !== undefined && !Array.isArray(body.filters)) {
      return context.json({ error: 'filters must be an array' }, 400)
    }

    const filters = (body.filters ?? []) as QueryFilter[]
    if (!filters.every((filter) => (
      filter &&
      typeof filter.property === 'string' &&
      typeof filter.op === 'string' &&
      FILTER_OPERATORS.has(filter.op)
    ))) {
      return context.json({ error: 'One or more filters are invalid' }, 400)
    }

    // Bound query size before building SQL so a single tool call cannot request an unlimited result set.
    const limit = body.limit ?? 100
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 1_000) {
      return context.json({ error: 'limit must be an integer between 1 and 1000' }, 400)
    }

    const properties = await getProperties(found.metadataSchema, found.objectType.id)
    const propertyByApiName = new Map(properties.map((property) => [property.api_name, property]))
    let query: any = db
      .selectFrom(dynamicInstanceTable(instanceTable.qualifiedTable))
      .selectAll()

    // Treat filter values as bound parameters and SQL columns as validated catalog identifiers.
    for (const filter of filters) {
      const property = propertyByApiName.get(filter.property)
      if (!property || !isSafeColumn(property.datasource_column)) {
        return context.json({ error: `Unknown filter property: ${filter.property}` }, 400)
      }

      const column = dynamicInstanceColumn(property.datasource_column)
      switch (filter.op) {
        case 'eq':
          query = query.where(column, '=', filter.value)
          break
        case 'neq':
          query = query.where(column, '!=', filter.value)
          break
        case 'gt':
          query = query.where(column, '>', filter.value)
          break
        case 'gte':
          query = query.where(column, '>=', filter.value)
          break
        case 'lt':
          query = query.where(column, '<', filter.value)
          break
        case 'lte':
          query = query.where(column, '<=', filter.value)
          break
        case 'in':
          if (!Array.isArray(filter.value)) {
            return context.json({ error: `Filter ${filter.property} with op in requires an array value` }, 400)
          }
          query = query.where(column, 'in', filter.value)
          break
        // String matching is case-insensitive; cast values to text for this operator.
        case 'contains':
          if (typeof filter.value !== 'string') {
            return context.json({ error: `Filter ${filter.property} with op contains requires a string value` }, 400)
          }
          query = query.where(sql`cast(${column} as text)`, 'ilike', `%${filter.value}%`)
          break
        case 'isNull':
          query = query.where(column, 'is', null)
          break
        case 'isNotNull':
          query = query.where(column, 'is not', null)
          break
      }
    }

    return context.json(await query.limit(limit as number).execute())
  })

  // Convenience list endpoint: URL query parameters represent equality filters by public property name.
  objectRoutes.get('/:type', async (context) => {
    const found = await findObjectType(context.req.param('type'))
    if (!found) return context.json({ error: 'Object type not found' }, 404)

    const instanceTable = resolveInstanceTable(found.objectType.schema, found.objectType.datasource_table)
    if (!instanceTable) return context.json({ error: 'Object type has an invalid instance schema' }, 400)

    const properties = await getProperties(found.metadataSchema, found.objectType.id)
    const propertyByApiName = new Map(properties.map((property) => [property.api_name, property]))
    let query = db.selectFrom(dynamicInstanceTable(instanceTable.qualifiedTable)).selectAll()

    for (const [apiName, value] of Object.entries(context.req.query())) {
      const property = propertyByApiName.get(apiName)
      if (!property || !isSafeColumn(property.datasource_column)) {
        return context.json({ error: `Unknown filter: ${apiName}` }, 400)
      }
      query = query.where(dynamicInstanceColumn(property.datasource_column), '=', value)
    }

    return context.json(await query.execute())
  })

  // Return action history in the UI contract, newest first; even numeric object IDs are stored as audit text.
  objectRoutes.get('/:type/:id/audit', async (context) => {
    const found = await findObjectType(context.req.param('type'))
    if (!found) return context.json({ error: 'Object type not found' }, 404)

    const entries = await db
      .withSchema(found.metadataSchema)
      .selectFrom('audit_log')
      .select(['action_api_name', 'actor', 'params', 'result', 'created_at'])
      .where('target_type_id', '=', found.objectType.id)
      .where('target_id', '=', context.req.param('id'))
      .orderBy('created_at', 'desc')
      .execute()

    return context.json(entries.map((entry) => ({
      action: entry.action_api_name,
      actor: entry.actor,
      params: entry.params,
      result: entry.result,
      timestamp: entry.created_at,
    })))
  })

  // Object detail combines the raw instance row with resolved outbound and inbound relationships.
  objectRoutes.get('/:type/:id', async (context) => {
    const found = await findObjectType(context.req.param('type'))
    if (!found) return context.json({ error: 'Object type not found' }, 404)

    const instanceTable = resolveInstanceTable(found.objectType.schema, found.objectType.datasource_table)
    if (!instanceTable) return context.json({ error: 'Object type has an invalid instance schema' }, 400)

    const properties = await getProperties(found.metadataSchema, found.objectType.id)
    const primaryKey = properties.find((property) => property.is_primary_key)
    if (!primaryKey || !isSafeColumn(primaryKey.datasource_column)) {
      return context.json({ error: 'Object type has no valid primary key metadata' }, 500)
    }

    const instance = await db
      .selectFrom(dynamicInstanceTable(instanceTable.qualifiedTable))
      .selectAll()
      .where(dynamicInstanceColumn(primaryKey.datasource_column), '=', context.req.param('id'))
      .executeTakeFirst()

    if (!instance) return context.json({ error: 'Object instance not found' }, 404)

    const metadataDb = db.withSchema(found.metadataSchema)
    const outboundLinks = await metadataDb
      .selectFrom('link')
      .innerJoin('object_type as target_type', 'target_type.id', 'link.target_type_id')
      .innerJoin('property as via_property', 'via_property.id', 'link.via_property_id')
      .select([
        'link.api_name',
        'link.name',
        'link.cardinality',
        'target_type.id as target_type_id',
        'target_type.schema as target_schema',
        'target_type.datasource_table as target_datasource_table',
        'via_property.datasource_column as via_datasource_column',
      ])
      .where('link.source_type_id', '=', found.objectType.id)
      .execute()

    const inboundLinks = await metadataDb
      .selectFrom('link')
      .innerJoin('object_type as source_type', 'source_type.id', 'link.source_type_id')
      .innerJoin('property as via_property', 'via_property.id', 'link.via_property_id')
      .select([
        'link.inverse_api_name',
        'link.inverse_name',
        'link.cardinality',
        'source_type.schema as source_schema',
        'source_type.datasource_table as source_datasource_table',
        'via_property.datasource_column as via_datasource_column',
      ])
      .where('link.target_type_id', '=', found.objectType.id)
      .execute()

    const links: Record<string, unknown> = {}

    // Outbound traversal reads a foreign-key value on this instance and resolves its target object.
    for (const link of outboundLinks) {
      const targetTable = resolveInstanceTable(link.target_schema, link.target_datasource_table)
      if (!targetTable || !isSafeColumn(link.via_datasource_column)) continue

      const foreignKey = instance[link.via_datasource_column]
      let related: unknown = null
      if (typeof foreignKey === 'string') {
        const targetProperties = await getProperties(found.metadataSchema, link.target_type_id)
        const targetPrimaryKey = targetProperties.find((property) => property.is_primary_key)
        if (targetPrimaryKey && isSafeColumn(targetPrimaryKey.datasource_column)) {
          related = await db
            .selectFrom(dynamicInstanceTable(targetTable.qualifiedTable))
            .selectAll()
            .where(dynamicInstanceColumn(targetPrimaryKey.datasource_column), '=', foreignKey)
            .executeTakeFirst() ?? null
        }
      }

      links[link.api_name] = {
        api_name: link.api_name,
        name: link.name,
        cardinality: link.cardinality,
        data: isCollection(link.cardinality, 'outbound') ? (related ? [related] : []) : related,
      }
    }

    // Domain IDs are usually text; Proposal uses a generated integer, which is also valid for traversal.
    const currentId = instance[primaryKey.datasource_column]
    if (typeof currentId !== 'string' && typeof currentId !== 'number') {
      return context.json({ error: 'Object instance has an invalid primary key value' }, 500)
    }

    // Inbound traversal finds other instances whose link column points at this object's primary key.
    for (const link of inboundLinks) {
      const sourceTable = resolveInstanceTable(link.source_schema, link.source_datasource_table)
      if (!sourceTable || !isSafeColumn(link.via_datasource_column)) continue

      const related = await db
        .selectFrom(dynamicInstanceTable(sourceTable.qualifiedTable))
        .selectAll()
        .where(dynamicInstanceColumn(link.via_datasource_column), '=', currentId)
        .execute()

      links[link.inverse_api_name] = {
        api_name: link.inverse_api_name,
        name: link.inverse_name,
        cardinality: link.cardinality,
        data: isCollection(link.cardinality, 'inbound') ? related : (related[0] ?? null),
      }
    }

    return context.json({ ...instance, links })
  })

  return objectRoutes
}

// Production uses the configured database and manufacturing catalog for every object endpoint.
export const objectRoutes = createObjectRoutes()
