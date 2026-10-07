/**
 * HTTP/PostgreSQL coverage for metadata-driven creation, including Proposal's
 * generated ID and API-to-column mapping. All rows live in a unique test schema.
 * Schema setup/cleanup uses run-sql, just like other schema changes in this repo.
 * Run: node --env-file=.env --test apps/ontology/src/routes/objectsCreate.integration.test.ts
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Hono } from 'hono'
import { sql } from 'kysely'
import { db } from '../db.ts'
import { createObjectRoutes } from './objects.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
// This internally generated name is the only identifier interpolated into fixture SQL.
const schema = `object_create_test_${randomUUID().replaceAll('-', '')}`

/** Apply test DDL through the standard SQL-file runner, and always remove the temporary file. */
async function runSql(text: string) {
  const directory = await mkdtemp(join(tmpdir(), 'object-create-test-'))
  const path = join(directory, 'fixture.sql')
  try {
    await writeFile(path, text, { mode: 0o600 })
    const result = spawnSync('pnpm', ['run-sql', path], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
  } finally {
    await unlink(path)
    await rmdir(directory)
  }
}

await test('generic object create route on PostgreSQL', async (t) => {
  let initialized = false
  try {
    // DDL and fixture metadata are one transaction, so setup cannot leave half a test catalog behind.
    await runSql(`BEGIN;
CREATE SCHEMA ${schema};
CREATE TABLE ${schema}.object_type (LIKE manufacturing.object_type INCLUDING ALL);
CREATE TABLE ${schema}.property (LIKE manufacturing.property INCLUDING ALL);
CREATE TABLE ${schema}.link (LIKE manufacturing.link INCLUDING ALL);
CREATE TABLE ${schema}.proposal (LIKE manufacturing.proposal INCLUDING ALL);
CREATE TYPE ${schema}.widget_state AS ENUM ('pending', 'approved', 'rejected');
CREATE TABLE ${schema}.owner (id text PRIMARY KEY);
INSERT INTO ${schema}.owner VALUES ('owner-1');
CREATE TABLE ${schema}.widget (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text NOT NULL UNIQUE,
  amount numeric NOT NULL CHECK (amount >= 0),
  doubled numeric GENERATED ALWAYS AS (amount * 2) STORED,
  enabled boolean NOT NULL DEFAULT true,
  state ${schema}.widget_state NOT NULL DEFAULT 'pending',
  legacy_state text NOT NULL DEFAULT 'open' CHECK (legacy_state IN ('open', 'closed')),
  observed_at timestamptz NOT NULL,
  tags text[], payload jsonb, note text, owner_id text REFERENCES ${schema}.owner(id)
);
CREATE TABLE ${schema}.text_item (id text PRIMARY KEY, label text);
CREATE TABLE ${schema}.default_only (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'new');
INSERT INTO ${schema}.object_type (api_name, name, schema, datasource_table, edits_enabled) VALUES
  ('widget', 'Widget', '${schema}', 'widget', true),
  ('textItem', 'Text Item', '${schema}', 'text_item', true),
  ('defaultOnly', 'Defaults', '${schema}', 'default_only', true),
  ('proposal', 'Proposal', '${schema}', 'proposal', true),
  ('locked', 'Locked', '${schema}', 'widget', false),
  ('badStorage', 'Invalid mapping', 'public', 'widget', true),
  ('badColumn', 'Invalid column', '${schema}', 'widget', true),
  ('badType', 'Invalid type', '${schema}', 'widget', true);
INSERT INTO ${schema}.property (object_type_id, api_name, name, data_type, required, is_primary_key, datasource_column)
SELECT o.id, p.api_name, p.api_name, p.data_type, p.required, p.is_primary_key, p.datasource_column
FROM ${schema}.object_type o
CROSS JOIN (VALUES
  ('id', 'number', true, true, 'id'),
  ('displayName', 'string', true, false, 'display_name'),
  ('amount', 'number', true, false, 'amount'),
  ('doubled', 'number', true, false, 'doubled'),
  ('enabled', 'boolean', true, false, 'enabled'),
  ('state', 'enum', true, false, 'state'),
  ('legacyState', 'enum', true, false, 'legacy_state'),
  ('observedAt', 'datetime', true, false, 'observed_at'),
  ('tags', 'string[]', false, false, 'tags'),
  ('payload', 'json', false, false, 'payload'),
  ('note', 'string', false, false, 'note'),
  ('ownerId', 'string', false, false, 'owner_id')
) p(api_name, data_type, required, is_primary_key, datasource_column)
WHERE o.api_name = 'widget';
INSERT INTO ${schema}.property (object_type_id, api_name, name, data_type, required, is_primary_key, datasource_column)
SELECT o.id, p.api_name, p.api_name, p.data_type, p.required, p.is_primary_key, p.datasource_column
FROM ${schema}.object_type o
CROSS JOIN (VALUES ('id', 'string', true, true, 'id'), ('label', 'string', false, false, 'label'))
p(api_name, data_type, required, is_primary_key, datasource_column)
WHERE o.api_name = 'textItem';
INSERT INTO ${schema}.property (object_type_id, api_name, name, data_type, required, is_primary_key, datasource_column)
SELECT o.id, p.api_name, p.api_name, p.data_type, true, p.api_name = 'id', p.api_name
FROM ${schema}.object_type o
CROSS JOIN (VALUES ('id', 'number'), ('status', 'string')) p(api_name, data_type)
WHERE o.api_name = 'defaultOnly';
INSERT INTO ${schema}.property (object_type_id, api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
SELECT dest.id, p.api_name, p.name, p.data_type, p.required, p.is_title, p.is_primary_key, p.datasource_column
FROM manufacturing.property p JOIN manufacturing.object_type src ON src.id = p.object_type_id
CROSS JOIN ${schema}.object_type dest WHERE src.api_name = 'proposal' AND dest.api_name = 'proposal';
INSERT INTO ${schema}.property (object_type_id, api_name, name, data_type, required, datasource_column)
SELECT id, 'bad', 'Bad', CASE WHEN api_name = 'badType' THEN 'unsupported' ELSE 'string' END,
 false, CASE WHEN api_name = 'badType' THEN 'note' ELSE 'not_a_column' END
FROM ${schema}.object_type WHERE api_name IN ('badColumn', 'badType');
COMMIT;`)
    initialized = true

    // Use the production route implementation with a second catalog; no global db/schema monkeypatch is needed.
    const routes = createObjectRoutes(db, new Set([schema]))
    const app = new Hono().route('/api/objects', routes)
    const basic = () => ({ displayName: randomUUID(), amount: 2.5, observedAt: '2026-04-30T12:00:00Z' })
    const post = (type: string, body: unknown) => app.request(`/api/objects/${type}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const count = async () => {
      const { rows } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM ${sql.id(schema, 'widget')}`.execute(db)
      return rows[0]!.count
    }

    await t.test('maps public names, generates IDs/computed values, preserves defaults, and inserts real rows', async () => {
      const body = { ...basic(), tags: ['a', 'b'], payload: { nested: ['x', 2] }, note: null, ownerId: 'owner-1' }
      const response = await post('widget', body)
      assert.equal(response.status, 201, await response.clone().text())
      const row = await response.json()
      assert.equal(typeof row.id, 'number')
      assert.equal(row.display_name, body.displayName)
      assert.equal(Number(row.amount), 2.5)
      assert.equal(Number(row.doubled), 5)
      assert.equal(row.state, 'pending')
      assert.equal(row.legacy_state, 'open')
      assert.equal(row.enabled, true)
      assert.equal(row.observed_at, '2026-04-30T12:00:00.000Z')
      assert.deepEqual(row.tags, ['a', 'b'])
      assert.deepEqual(row.payload, body.payload)
      assert.equal(row.note, null)
      assert.equal('displayName' in row, false)
      assert.equal(await count(), 1)
      // Creation now shares the router with reads/queries; verify their public-property mappings still work.
      const list = await app.request(`/api/objects/widget?displayName=${encodeURIComponent(body.displayName)}`)
      assert.equal(list.status, 200)
      assert.deepEqual(await list.json(), [row])
      const detail = await app.request(`/api/objects/widget/${row.id}`)
      assert.equal(detail.status, 200)
      assert.deepEqual(await detail.json(), { ...row, links: {} })
      const query = await post('widget/query', { filters: [{ property: 'displayName', op: 'eq', value: body.displayName }] })
      assert.equal(query.status, 200)
      assert.deepEqual(await query.json(), [row])
    })
    await t.test('round-trips JSON arrays/scalars and explicit false/zero values', async () => {
      for (const payload of [['a', { reason: 'test' }], 'a JSON string', false, 0]) {
        const response = await post('widget', { ...basic(), amount: 0, enabled: false, payload })
        assert.equal(response.status, 201, await response.clone().text())
        const row = await response.json()
        assert.deepEqual(row.payload, payload)
        assert.equal(row.enabled, false)
        assert.equal(Number(row.amount), 0)
      }
    })
    await t.test('creates Proposal using its existing metadata, omitting generated id and default status', async () => {
      const body = { type: 'batch.cancel', targetId: 'B-test', params: { reason: 'Quality issue' },
        rationale: 'Test recommendation', proposedBy: 'test-agent', proposedAt: '2026-04-30T12:00:00Z' }
      const response = await post('proposal', body)
      assert.equal(response.status, 201, await response.clone().text())
      const row = await response.json()
      assert.equal(typeof row.id, 'number')
      assert.equal(row.target_id, 'B-test')
      assert.deepEqual(row.params, body.params)
      assert.equal(row.status, 'pending')
      assert.equal(row.proposed_by, 'test-agent')
      assert.equal(row.reviewed_by, null)
      assert.equal(row.reviewed_at, null)
    })
    await t.test('requires caller-supplied text IDs and supports a defaults-only insert', async () => {
      assert.equal((await post('textItem', {})).status, 400)
      const response = await post('textItem', { id: 'DOMAIN-1', label: 'Example' })
      assert.equal(response.status, 201)
      assert.deepEqual(await response.json(), { id: 'DOMAIN-1', label: 'Example' })
      assert.equal((await post('textItem', { id: 'DOMAIN-1' })).status, 409)
      const generated = await post('defaultOnly', {})
      assert.equal(generated.status, 201, await generated.clone().text())
      const row = await generated.json()
      assert.equal(typeof row.id, 'number')
      assert.equal(row.status, 'new')
    })
    await t.test('rejects missing/unknown fields, incorrect types, null required fields, invalid dates/enums, and generated writes', async () => {
      const previous = await count()
      for (const body of [
        {}, { ...basic(), extra: true }, { ...basic(), display_name: 'raw column' },
        { ...basic(), displayName: null }, { ...basic(), amount: '2' },
        { ...basic(), enabled: 'false' }, { ...basic(), enabled: null },
        { ...basic(), tags: ['a', 2] }, { ...basic(), state: 'invalid' },
        { ...basic(), observedAt: 'tomorrow' }, { ...basic(), observedAt: '2026-02-30T12:00:00Z' },
        { ...basic(), id: 42 }, { ...basic(), doubled: 99 },
      ]) {
        const response = await post('widget', body)
        assert.equal(response.status, 400, await response.text())
      }
      assert.equal(await count(), previous, 'invalid input must not insert any rows')
    })
    await t.test('rejects malformed JSON, non-object JSON, and non-finite numbers', async () => {
      for (const body of [null, [], 'text', 5, true]) assert.equal((await post('widget', body)).status, 400)
      for (const body of ['{broken', '{"amount":1e999}']) {
        const response = await app.request('/api/objects/widget', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body,
        })
        assert.equal(response.status, 400)
      }
    })
    await t.test('enforces uniqueness, foreign keys, CHECK constraints, and text-enum values without partial inserts', async () => {
      const body = basic()
      assert.equal((await post('widget', body)).status, 201)
      const previous = await count()
      for (const [candidate, status] of [
        [body, 409], [{ ...basic(), amount: -1 }, 400], [{ ...basic(), ownerId: 'missing' }, 400],
        [{ ...basic(), legacyState: 'invalid' }, 400],
      ] as [unknown, number][]) {
        assert.equal((await post('widget', candidate)).status, status)
      }
      assert.equal(await count(), previous)
    })
    await t.test('returns explicit errors for unknown types, disabled edits, and broken metadata/storage mappings', async () => {
      assert.equal((await post('unknown', {})).status, 404)
      assert.equal((await post('locked', basic())).status, 403)
      for (const type of ['badStorage', 'badColumn', 'badType']) {
        assert.equal((await post(type, {})).status, 500)
      }
    })
  } finally {
    // Drop only this internally generated fixture schema; existing manufacturing instances remain untouched.
    try { if (initialized) await runSql(`DROP SCHEMA ${schema} CASCADE;`) }
    finally { await db.destroy() }
  }
})
