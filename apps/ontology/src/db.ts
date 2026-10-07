/**
 * Shared PostgreSQL query builder for the ontology API.
 * One pool is reused across requests; handlers can pass a transaction as the same database interface.
 */
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Database } from './schema.ts'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error('DATABASE_URL must be set')
}

// Table typing comes from schema.ts; this does not create or migrate database tables.
export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString }),
  }),
})
