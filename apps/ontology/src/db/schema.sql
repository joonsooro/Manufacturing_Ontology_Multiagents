-- Add the Brewery object type to an existing manufacturing ontology.
-- Run from the repository root:
--   pnpm run-sql apps/ontology/src/db/schema.sql
-- This extends the schema and catalog; it does not reset production data.
-- All changes commit together. A failed constraint or missing catalog type rolls back everything.
BEGIN;

-- Serialize repeat/concurrent applications before creating the table or registering links.
-- Asset writers also wait here so none can insert an unassigned row during the backfill.
-- The ontology's link table has no unique-name constraint; this lock protects its existence checks.
LOCK TABLE manufacturing.object_type, manufacturing.property, manufacturing.link,
  manufacturing.tank, manufacturing.line IN SHARE ROW EXCLUSIVE MODE;

-- A brewery represents the site that owns tanks and packaging lines.
-- Instance IDs are stable text domain IDs; UUIDs are used only for catalog row IDs.
CREATE TABLE IF NOT EXISTS manufacturing.brewery (
  id text PRIMARY KEY,
  name text NOT NULL
);

-- Preserve edits to the original brewery's display name on subsequent applications.
-- PLANT-1000 is an illustrative ERP-style plant identifier, not a verified external record.
INSERT INTO manufacturing.brewery (id, name)
VALUES ('PLANT-1000', 'Original Brewery')
ON CONFLICT (id) DO NOTHING;

-- Add nullable first so populated tables can be upgraded before enforcing ownership.
ALTER TABLE manufacturing.tank ADD COLUMN IF NOT EXISTS brewery_id text;
ALTER TABLE manufacturing.line ADD COLUMN IF NOT EXISTS brewery_id text;

-- The first application assigns all existing assets to the original site. Subsequent
-- applications fill missing assignments without overwriting moves to another brewery.
UPDATE manufacturing.tank SET brewery_id = 'PLANT-1000' WHERE brewery_id IS NULL;
UPDATE manufacturing.line SET brewery_id = 'PLANT-1000' WHERE brewery_id IS NULL;

-- Each asset belongs to exactly one brewery. New assets must supply that ownership
-- explicitly; a silent column default could misassign future assets at another site.
ALTER TABLE manufacturing.tank ALTER COLUMN brewery_id SET NOT NULL;
ALTER TABLE manufacturing.line ALTER COLUMN brewery_id SET NOT NULL;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Check each named FK on its own
-- table, so rerunning this file neither duplicates constraints nor changes their IDs.
-- Default NO ACTION behavior prevents deleting a brewery while it still owns assets.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'manufacturing.tank'::regclass AND conname = 'tank_brewery_id_fkey'
  ) THEN
    ALTER TABLE manufacturing.tank ADD CONSTRAINT tank_brewery_id_fkey
      FOREIGN KEY (brewery_id) REFERENCES manufacturing.brewery(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'manufacturing.line'::regclass AND conname = 'line_brewery_id_fkey'
  ) THEN
    ALTER TABLE manufacturing.line ADD CONSTRAINT line_brewery_id_fkey
      FOREIGN KEY (brewery_id) REFERENCES manufacturing.brewery(id);
  END IF;
END $$;

-- PostgreSQL does not automatically index the referencing side of a foreign key.
-- These indexes support querying a brewery's tanks/lines and ownership checks.
CREATE INDEX IF NOT EXISTS tank_brewery_id_idx ON manufacturing.tank (brewery_id);
CREATE INDEX IF NOT EXISTS line_brewery_id_idx ON manufacturing.line (brewery_id);

-- Register storage so the generic API/UI can discover the new type.
-- Upserts preserve catalog IDs, keeping existing metadata references valid.
INSERT INTO manufacturing.object_type (api_name, name, description, schema, datasource_table)
VALUES ('brewery', 'Brewery', 'A production site that owns tanks and packaging lines.', 'manufacturing', 'brewery')
ON CONFLICT (api_name) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  schema = EXCLUDED.schema, datasource_table = EXCLUDED.datasource_table;

-- Fail explicitly rather than silently omitting asset properties or relationships.
DO $$ BEGIN
  IF (SELECT count(*) FROM manufacturing.object_type
      WHERE api_name IN ('tank', 'line') AND schema = 'manufacturing'
        AND datasource_table = api_name) <> 2 THEN
    RAISE EXCEPTION 'Brewery requires tank and line catalog types mapped to their manufacturing tables';
  END IF;
END $$;

-- Public names map to physical columns. Name is the display title; id is the PK.
INSERT INTO manufacturing.property
  (object_type_id, api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
SELECT t.id, p.*
FROM manufacturing.object_type t
CROSS JOIN (VALUES
  ('id', 'ID', 'string', true, false, true, 'id'),
  ('name', 'Name', 'string', true, true, false, 'name')
) AS p(api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
WHERE t.api_name = 'brewery'
ON CONFLICT (object_type_id, api_name) DO UPDATE SET
  name = EXCLUDED.name, data_type = EXCLUDED.data_type, required = EXCLUDED.required,
  is_title = EXCLUDED.is_title, is_primary_key = EXCLUDED.is_primary_key,
  datasource_column = EXCLUDED.datasource_column;

INSERT INTO manufacturing.property
  (object_type_id, api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
SELECT t.id, 'breweryId', 'Brewery ID', 'string', true, false, false, 'brewery_id'
FROM manufacturing.object_type t WHERE t.api_name IN ('tank', 'line')
ON CONFLICT (object_type_id, api_name) DO UPDATE SET
  name = EXCLUDED.name, data_type = EXCLUDED.data_type, required = EXCLUDED.required,
  is_title = EXCLUDED.is_title, is_primary_key = EXCLUDED.is_primary_key,
  datasource_column = EXCLUDED.datasource_column;

-- Tank.brewery / Line.brewery resolve through breweryId. The inverse relationships
-- expose Brewery.tanks / Brewery.lines without storing duplicate asset lists.
-- Update existing links in place, then insert missing ones under the lock above.
WITH desired AS (
  SELECT source.id AS source_type_id, brewery.id AS target_type_id, p.id AS via_property_id,
    CASE source.api_name WHEN 'tank' THEN 'tanks' ELSE 'lines' END AS inverse_api_name,
    CASE source.api_name WHEN 'tank' THEN 'Tanks' ELSE 'Lines' END AS inverse_name
  FROM manufacturing.object_type source
  JOIN manufacturing.property p ON p.object_type_id = source.id AND p.api_name = 'breweryId'
  CROSS JOIN manufacturing.object_type brewery
  WHERE source.api_name IN ('tank', 'line') AND brewery.api_name = 'brewery'
), updated AS (
  UPDATE manufacturing.link l SET
    name = 'Brewery', inverse_api_name = d.inverse_api_name, inverse_name = d.inverse_name,
    target_type_id = d.target_type_id, via_property_id = d.via_property_id, cardinality = 'many_to_one'
  FROM desired d WHERE l.source_type_id = d.source_type_id AND l.api_name = 'brewery'
  RETURNING l.id
)
INSERT INTO manufacturing.link
  (api_name, name, inverse_api_name, inverse_name, source_type_id, target_type_id, via_property_id, cardinality)
SELECT 'brewery', 'Brewery', d.inverse_api_name, d.inverse_name,
  d.source_type_id, d.target_type_id, d.via_property_id, 'many_to_one'
FROM desired d
WHERE NOT EXISTS (
  SELECT 1 FROM manufacturing.link l WHERE l.source_type_id = d.source_type_id AND l.api_name = 'brewery'
);

COMMIT;
