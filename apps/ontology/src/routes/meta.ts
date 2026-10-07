/**
 * Ontology catalog endpoints: list types, describe their properties/links/actions,
 * and edit display metadata. These endpoints describe objects rather than mutate instances.
 */
import { Hono } from 'hono'
import { sql } from 'kysely'
import { db } from '../db.ts'

const METADATA_SCHEMAS = ['manufacturing']

/** Find the catalog schema owning the requested public type name. */
async function findObjectType(type: string) {
  for (const schema of METADATA_SCHEMAS) {
    const objectType = await db
      .withSchema(schema)
      .selectFrom('object_type')
      .selectAll()
      .where('api_name', '=', type)
      .executeTakeFirst()

    if (objectType) return { schema, objectType }
  }

  return null
}

export const metaRoutes = new Hono()

// Counts come from instance tables, while labels and storage mappings come from the catalog.
metaRoutes.get('/meta/types', async (context) => {
  const typeLists = await Promise.all(
    METADATA_SCHEMAS.map((schema) => db.withSchema(schema).selectFrom('object_type').selectAll().execute()),
  )

  const types = typeLists.flat()
  const typesWithCounts = await Promise.all(
    types.map(async (type) => {
      // sql.id quotes identifiers; instance tables are resolved from catalog metadata.
      const result = await sql<{ instance_count: number }>`
        SELECT COUNT(*)::int AS instance_count
        FROM ${sql.id(type.schema, type.datasource_table)}
      `.execute(db)

      return { ...type, instance_count: result.rows[0]?.instance_count ?? 0 }
    }),
  )

  return context.json(typesWithCounts)
})

// Return everything needed by generic forms, property panels, and relationship navigation.
metaRoutes.get('/meta/types/:type', async (context) => {
  const found = await findObjectType(context.req.param('type'))
  if (!found) return context.json({ error: 'Object type not found' }, 404)

  const metadataDb = db.withSchema(found.schema)
  const [properties, outboundLinks, inboundLinks, actions] = await Promise.all([
    metadataDb
      .selectFrom('property')
      .selectAll()
      .where('object_type_id', '=', found.objectType.id)
      .execute(),
    metadataDb
      .selectFrom('link')
      .selectAll()
      .where('source_type_id', '=', found.objectType.id)
      .execute(),
    metadataDb
      .selectFrom('link')
      .selectAll()
      .where('target_type_id', '=', found.objectType.id)
      .execute(),
    metadataDb
      .selectFrom('action_type')
      .selectAll()
      .where('object_type_id', '=', found.objectType.id)
      .execute(),
  ])

  return context.json({
    object_type: found.objectType,
    properties,
    links: { outbound: outboundLinks, inbound: inboundLinks },
    actions,
  })
})

// Allow display text edits only; API names and datasource mappings remain stable.
metaRoutes.patch('/meta/types/:type', async (context) => {
  const found = await findObjectType(context.req.param('type'))
  if (!found) return context.json({ error: 'Object type not found' }, 404)

  const body = await context.req.json<{
    display_name?: unknown
    name?: unknown
    description?: unknown
  }>()
  const updates: { name?: string; description?: string | null } = {}
  // Accept the frontend display_name alias while retaining compatibility with the stored name field.
  const displayName = body.display_name ?? body.name

  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || !displayName.trim()) {
      return context.json({ error: 'display_name must be a non-empty string' }, 400)
    }
    updates.name = displayName.trim()
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return context.json({ error: 'description must be a string or null' }, 400)
    }
    updates.description = body.description
  }

  if (!Object.keys(updates).length) {
    return context.json({ error: 'No editable fields supplied' }, 400)
  }

  const updated = await db
    .withSchema(found.schema)
    .updateTable('object_type')
    .set(updates)
    .where('id', '=', found.objectType.id)
    .returningAll()
    .executeTakeFirstOrThrow()

  return context.json({ ...updated, display_name: updated.name })
})
