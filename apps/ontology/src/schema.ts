/**
 * Ontology storage types and runtime action metadata.
 * The table interfaces describe database rows; action definitions describe public inputs.
 * SQL builders keep Proposal and FlagLog storage and metadata reproducible through run-sql.
 */
import type { Generated, Selectable } from 'kysely'

/** JSON accepted in stored parameters, action schemas, and audit snapshots. */
export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

// Instance tables hold operational facts. Their snake_case fields match PostgreSQL column names.
export interface TankTable {
  id: string
  name: string
  capacity: number
  status: string
  current_temperature: number | null
  commissioned_at: Date
}

/** Packaging line availability used by bottling-run relationships. */
interface LineTable {
  id: string
  name: string
  status: string
  commissioned_at: Date
}

/** Production batch: scheduling/status, current fermentation readings, and assigned-resource IDs. */
export interface BatchTable {
  id: string
  recipe_id: string
  target_volume: number | null
  status: string
  planned_start: Date | null
  // Planned exit from the current stage, not evidence of an actual transfer or vessel reservation.
  // NULL means no transfer has been scheduled; intervention handlers must not invent a baseline.
  planned_transfer_at: Date | null
  current_sugar_level: number | null
  current_temperature: number | null
  days_fermenting: number | null
  assigned_tank_id: string | null
  assigned_operator_id: string | null
  last_operator_note: string | null
}

/** A batch concern has its own lifecycle; opening a flag does not change production status. */
export interface FlagLogTable {
  // Text domain ID (FL-...) follows instance identifier conventions and supports repeated flags per batch.
  id: string
  batch_id: string
  reason: string
  severity: 'low' | 'medium' | 'high'
  status: 'open' | 'resolved' | 'dismissed'
  flagged_by: string
  flagged_at: Date
  // NULL while open (and for dismissed flags); future resolution workflows supply a completion time.
  resolved_at: Date | null
}

/** Stored agent recommendation. Escalation requests human review without executing the action. */
export interface ProposalTable {
  // Generated marks an ID that PostgreSQL supplies on insert; reads receive a plain number.
  id: Generated<number>
  // Exact handler key (batch.cancel) and target ID are routing data, separate from action params.
  type: string
  target_id: string
  // params contains business inputs only; rationale explains why the agent proposes the action.
  params: JsonValue
  rationale: string
  status: 'pending' | 'escalated' | 'approved' | 'rejected'
  proposed_by: string
  proposed_at: Date
  // Latest review (including escalation). A later human decision replaces these fields;
  // append-only audits retain the earlier escalation note and reviewer attribution.
  reviewed_by: string | null
  reviewed_at: Date | null
  decision_note: string | null
}

/** Selectable unwraps Generated so handler inputs describe a row already read from the database. */
export type Proposal = Selectable<ProposalTable>

/** Planned packaging run linking a production batch to a bottling line/operator. */
interface BottlingRunTable {
  id: string
  batch_id: string
  line_id: string
  planned_start: Date | null
  status: string
  assigned_operator_id: string | null
}

/** Maintenance evidence for a typed target, with planned and actual lifecycle timestamps. */
interface MaintenanceLogTable {
  id: string
  target_type: string
  target_id: string
  type: string
  status: string
  planned_at: Date | null
  started_at: Date | null
  completed_at: Date | null
  notes: string | null
}

/** Operator scheduling and certifications used to interpret production assignments. */
interface OperatorTable {
  id: string
  name: string
  certifications: string[] | null
  shift: string
}

/** Recipe targets, fermentation duration, ingredient requirements, and operational notes. */
interface RecipeTable {
  id: string
  name: string
  target_sugar_curve: JsonValue
  fermentation_days: number
  required_ingredients: string[] | null
  notes: string | null
}

/** Recorded batch quality measurements and the operator responsible for the test. */
interface QualityTestTable {
  id: string
  batch_id: string
  test_date: Date
  ph: number | null
  sugar_level: number | null
  notes: string | null
  tested_by: string | null
}

// Catalog tables describe how public ontology names map to storage, properties, links, and actions.
interface ObjectTypeTable {
  id: Generated<string>
  api_name: string
  name: string
  description: string | null
  status: string
  visibility: string
  point_of_contact: string | null
  edits_enabled: boolean
  schema: string
  datasource_table: string
}

/** datasource_column bridges a public property API name to the actual instance-table column. */
interface PropertyTable {
  id: Generated<string>
  api_name: string
  name: string
  object_type_id: string
  data_type: string
  required: boolean
  is_title: boolean
  is_primary_key: boolean
  datasource_column: string
}

/** A link resolves through via_property_id; inverse names expose the same relationship in reverse. */
interface LinkTable {
  id: Generated<string>
  api_name: string
  name: string
  inverse_api_name: string
  inverse_name: string
  source_type_id: string
  target_type_id: string
  via_property_id: string
  cardinality: string
}

/** Metadata half of an action: runtime dispatch separately requires a handler registry entry. */
interface ActionTypeTable {
  id: Generated<string>
  api_name: string
  name: string
  object_type_id: string
  description: string | null
  parameter_schema: JsonValue
  // NULL/empty means unrestricted; omitted inserts use PostgreSQL's NULL default.
  allowed_callers: Generated<string[] | null>
}

/** Access decisions are separate from successful business-action audits, including rejected attempts. */
interface AccessLogTable {
  id: Generated<string>
  caller_identity: string
  // Store qualified action API names (proposal.approve) and target API names (proposal).
  action_type: string
  target_type: string
  target_id: string
  decision: 'allowed' | 'denied'
  reason: string
  timestamp: Generated<Date>
}

/** Append-only action evidence: actor, original business inputs, authorization, and result snapshot. */
interface AuditLogTable {
  id: Generated<string>
  action_type_id: string
  action_api_name: string
  target_type_id: string
  target_type_api_name: string
  target_id: string
  actor: string
  params: JsonValue | null
  result: JsonValue | null
  created_at: Generated<Date>
}

/**
 * Metadata tables are deliberately schema-agnostic. Callers use
 * `db.withSchema(schema)` to address each ontology's metadata catalog.
 */
export interface Database {
  object_type: ObjectTypeTable
  property: PropertyTable
  link: LinkTable
  action_type: ActionTypeTable
  audit_log: AuditLogTable
  access_log: AccessLogTable
  proposal: ProposalTable
  'manufacturing.proposal': ProposalTable
  'manufacturing.tank': TankTable
  'manufacturing.line': LineTable
  'manufacturing.flag_log': FlagLogTable
  'manufacturing.batch': BatchTable
  'manufacturing.bottling_run': BottlingRunTable
  'manufacturing.maintenance_log': MaintenanceLogTable
  'manufacturing.operator': OperatorTable
  'manufacturing.recipe': RecipeTable
  'manufacturing.quality_test': QualityTestTable
}

// Runtime action definitions. Applied to Neon by apply-schema.ts through run-sql.
// Action inputs include string fields, datetime formats, string enums, and positive integer durations.
type StringProperty = { readonly type: 'string'; readonly minLength?: number; readonly format?: 'date-time'; readonly enum?: readonly string[] }
type ParameterProperty = StringProperty | { readonly type: 'integer'; readonly minimum?: number }
type ParameterSchema = {
  readonly type: 'object'
  readonly properties: Record<string, ParameterProperty>
  readonly required: readonly string[]
  readonly additionalProperties?: boolean
}

// Preserve numeric action parameters instead of coercing integer durations into strings.
// Required JSON Schema properties become required TS fields; enum arrays become literal unions.
type ParameterValue<P extends ParameterProperty> = P extends { readonly type: 'integer' } ? number
  : P extends { readonly enum: readonly (infer E)[] } ? E : string
export type ActionParams<S extends ParameterSchema> = {
  -readonly [K in keyof S['properties'] as K extends S['required'][number] ? K : never]:
    ParameterValue<S['properties'][K]>
} & {
  -readonly [K in keyof S['properties'] as K extends S['required'][number] ? never : K]?:
    ParameterValue<S['properties'][K]>
}

/** Public action metadata published by the SQL builder below. */
type ActionDefinition = {
  objectType: string
  api_name: string
  name: string
  description: string
  parameter_schema: ParameterSchema
  allowed_callers?: readonly string[] | null
}

// Both the API validator and the domain handler consume this same input contract.
export const batchDeferStartDefinition = {
  objectType: 'batch',
  api_name: 'deferStart',
  name: 'Defer Start',
  description: "Postpone the batch's planned start date",
  parameter_schema: {
    type: 'object',
    properties: { newPlannedStart: { type: 'string', format: 'date-time' } },
    required: ['newPlannedStart'],
  },
} as const satisfies ActionDefinition

export const tankScheduleMaintenanceDefinition = {
  objectType: 'tank',
  api_name: 'scheduleMaintenance',
  name: 'Schedule Maintenance',
  description: 'Take the tank offline and create a scheduled maintenance log.',
  parameter_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['inspection', 'preventive', 'corrective', 'cleaning'] },
      plannedAt: { type: 'string', format: 'date-time' },
      notes: { type: 'string' },
    },
    required: ['type', 'plannedAt', 'notes'],
  },
} as const satisfies ActionDefinition

export const batchCancelDefinition = {
  objectType: 'batch',
  api_name: 'cancel',
  name: 'Cancel',
  description: 'Cancel a queued or fermenting batch and record the reason.',
  parameter_schema: {
    type: 'object',
    properties: { reason: { type: 'string' } },
    required: ['reason'],
  },
} as const satisfies ActionDefinition

/** Flagging records a concern at any batch stage, without advancing or stopping production. */
export const batchFlagDefinition = {
  objectType: 'batch',
  api_name: 'flag',
  name: 'Flag',
  description: 'Create an open flag for the batch without changing its status.',
  parameter_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', minLength: 1 },
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['reason', 'severity'],
    additionalProperties: false,
  },
} as const satisfies ActionDefinition

/** Safety stop: retain resources and scheduling evidence while changing the batch lifecycle state. */
export const batchPlaceOnHoldDefinition = {
  objectType: 'batch', api_name: 'placeOnHold', name: 'Place On Hold',
  description: 'Place a fermenting or conditioning batch on hold and record the reason.',
  parameter_schema: {
    type: 'object', properties: { reason: { type: 'string', minLength: 1 } },
    required: ['reason'], additionalProperties: false,
  },
} as const satisfies ActionDefinition

/** Extra rest shifts only this batch\'s existing transfer plan; no downstream cascade is implied. */
export const batchExtendRestDefinition = {
  objectType: 'batch', api_name: 'extendRest', name: 'Extend Rest',
  description: "Add rest days to this batch's planned transfer without rescheduling other batches.",
  parameter_schema: {
    type: 'object', properties: { additionalDays: { type: 'integer', minimum: 1 } },
    required: ['additionalDays'], additionalProperties: false,
  },
} as const satisfies ActionDefinition

/** A schedule change toward the next stage; physical transfer and resource allocation are separate. */
export const batchScheduleEarlyTransferDefinition = {
  objectType: 'batch', api_name: 'scheduleEarlyTransfer', name: 'Schedule Early Transfer',
  description: 'Schedule an earlier exit from current conditions. Does not execute transfer or validate vessel availability.',
  parameter_schema: {
    type: 'object', properties: { plannedAt: { type: 'string', format: 'date-time' } },
    required: ['plannedAt'], additionalProperties: false,
  },
} as const satisfies ActionDefinition

// Review inputs are optional; the underlying action inputs come from the stored proposal.
export const proposalApproveDefinition = {
  objectType: 'proposal',
  api_name: 'approve',
  name: 'Approve',
  description: 'Approve a pending or escalated proposal and execute its underlying action atomically.',
  allowed_callers: ['brewmaster-lee', 'verification-agent'],
  parameter_schema: {
    type: 'object',
    properties: { decisionNote: { type: 'string' } },
    required: [],
    additionalProperties: false,
  },
} as const satisfies ActionDefinition

export const proposalRejectDefinition = {
  ...proposalApproveDefinition,
  api_name: 'reject',
  name: 'Reject',
  description: 'Reject a pending or escalated proposal without executing its underlying action.',
  // Approval's restriction is not inherited by rejection.
  allowed_callers: null,
} as const satisfies ActionDefinition

/** Escalation records a review concern; a human can still approve or reject the same proposal later. */
export const proposalEscalateDefinition = {
  objectType: 'proposal', api_name: 'escalate', name: 'Escalate',
  description: 'Escalate a pending proposal for human review without executing its underlying action.',
  parameter_schema: {
    type: 'object', properties: { note: { type: 'string', minLength: 1 } },
    required: ['note'], additionalProperties: false,
  },
} as const satisfies ActionDefinition

// Adding an action requires a definition here AND an implementation in actions/index.ts.
export const actionDefinitions = [
  batchDeferStartDefinition, tankScheduleMaintenanceDefinition, batchCancelDefinition, batchFlagDefinition,
  batchPlaceOnHoldDefinition, batchExtendRestDefinition, batchScheduleEarlyTransferDefinition,
  proposalApproveDefinition, proposalRejectDefinition, proposalEscalateDefinition,
]

/**
 * Proposal SQL fragment, applied inside the action-metadata transaction below:
 * 1. Create the enum/table if absent; widen legacy text status checks for escalation.
 *    New tables require params to be a JSON object.
 * 2. Upsert the public Proposal type and its manufacturing.proposal storage mapping.
 * 3. Upsert each property, mapping API names like reviewedBy to reviewed_by.
 *
 * proposed_at is required from the writer; PostgreSQL has no knowledge of COURSE_NOW.
 * Review fields are nullable until the first decision; escalations remain reviewable.
 */
// This returns a SQL fragment; buildActionMetadataSql wraps it with action metadata in one transaction.
// Metadata exposes camelCase API names while storage retains snake_case columns.
export function buildProposalSchemaSql(): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'manufacturing' AND t.typname = 'proposal_status'
  ) THEN
    CREATE TYPE manufacturing.proposal_status AS ENUM ('pending', 'escalated', 'approved', 'rejected');
  END IF;
END $$;
-- Existing installations need the enum value too. This transaction does not write an
-- escalated instance: new enum values become usable only after the schema transaction commits.
ALTER TYPE manufacturing.proposal_status ADD VALUE IF NOT EXISTS 'escalated';
CREATE TABLE IF NOT EXISTS manufacturing.proposal (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  target_id text NOT NULL,
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  rationale text NOT NULL,
  status manufacturing.proposal_status NOT NULL DEFAULT 'pending',
  proposed_by text NOT NULL,
  proposed_at timestamptz NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  decision_note text
);
-- Earlier installations use text with a named status check rather than the enum.
-- Keep that storage type and widen its existing guard without changing proposal rows.
-- Enum-backed installations are already guarded by proposal_status above.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'manufacturing' AND table_name = 'proposal'
      AND column_name = 'status' AND data_type IN ('text', 'character varying')
  ) THEN
    ALTER TABLE manufacturing.proposal DROP CONSTRAINT IF EXISTS proposal_status_check;
    ALTER TABLE manufacturing.proposal ADD CONSTRAINT proposal_status_check
      CHECK (status IN ('pending', 'escalated', 'approved', 'rejected'));
  END IF;
END $$;
INSERT INTO manufacturing.object_type (api_name, name, description, schema, datasource_table)
VALUES ('proposal', 'Proposal', 'An agent proposal awaiting a human decision.', 'manufacturing', 'proposal')
ON CONFLICT (api_name) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  schema = EXCLUDED.schema, datasource_table = EXCLUDED.datasource_table;
INSERT INTO manufacturing.property
  (object_type_id, api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
SELECT t.id, p.api_name, p.name, p.data_type, p.required, p.is_title, p.is_primary_key, p.datasource_column
FROM manufacturing.object_type t
CROSS JOIN (VALUES
  ('id', 'ID', 'number', true, false, true, 'id'),
  ('type', 'Type', 'string', true, true, false, 'type'),
  ('targetId', 'Target ID', 'string', true, false, false, 'target_id'),
  ('params', 'Parameters', 'json', true, false, false, 'params'),
  ('rationale', 'Rationale', 'string', true, false, false, 'rationale'),
  ('status', 'Status', 'enum', true, false, false, 'status'),
  ('proposedBy', 'Proposed By', 'string', true, false, false, 'proposed_by'),
  ('proposedAt', 'Proposed At', 'datetime', true, false, false, 'proposed_at'),
  ('reviewedBy', 'Reviewed By', 'string', false, false, false, 'reviewed_by'),
  ('reviewedAt', 'Reviewed At', 'datetime', false, false, false, 'reviewed_at'),
  ('decisionNote', 'Decision Note', 'string', false, false, false, 'decision_note')
) AS p(api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
WHERE t.api_name = 'proposal'
ON CONFLICT (object_type_id, api_name) DO UPDATE SET
  name = EXCLUDED.name, data_type = EXCLUDED.data_type, required = EXCLUDED.required,
  is_title = EXCLUDED.is_title, is_primary_key = EXCLUDED.is_primary_key,
  datasource_column = EXCLUDED.datasource_column;
`
}

/**
 * Build one transaction containing Proposal/FlagLog storage, batch transfer mapping, and action metadata.
 * The temporary table turns serialized definitions into typed SQL rows. Missing
 * object types fail the transaction; conflicts update metadata while keeping its
 * existing IDs, so earlier audit references remain valid.
 * Execution is delegated to apply-schema.ts/run-sql.ts, not performed here.
 */
export function buildActionMetadataSql(): string {
  // Escape SQL string literals after JSON serialization; catalog names stay data inside the JSON payload.
  const json = JSON.stringify(actionDefinitions).replaceAll("'", "''")
  return `BEGIN;
SET LOCAL standard_conforming_strings = on;
${buildActionAccessSchemaSql({ metadataSchema: 'manufacturing' })}
${buildProposalSchemaSql()}
${buildFlagLogSchemaSql()}
${buildBatchInterventionSchemaSql()}
CREATE TEMP TABLE action_definitions ON COMMIT DROP AS
SELECT * FROM jsonb_to_recordset('${json}'::jsonb)
AS definition("objectType" text, api_name text, name text, description text, parameter_schema jsonb, allowed_callers text[]);
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM action_definitions d
    LEFT JOIN manufacturing.object_type t ON t.api_name = d."objectType"
    WHERE t.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Action metadata requires existing ontology object types';
  END IF;
END $$;
INSERT INTO manufacturing.action_type (object_type_id, api_name, name, description, parameter_schema, allowed_callers)
SELECT t.id, d.api_name, d.name, d.description, d.parameter_schema, d.allowed_callers
FROM action_definitions d
JOIN manufacturing.object_type t ON t.api_name = d."objectType"
ON CONFLICT (object_type_id, api_name) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  parameter_schema = EXCLUDED.parameter_schema,
  allowed_callers = EXCLUDED.allowed_callers;
COMMIT;
`
}

/** Each metadata catalog owns its access policy/log; runtime uses db.withSchema for both. */
export function buildActionAccessSchemaSql({ metadataSchema }: { metadataSchema: string }): string {
  // SQL identifiers cannot be bind parameters; validate the configuration before interpolating it.
  if (!/^[a-z_][a-z0-9_]*$/.test(metadataSchema)) throw new Error('Invalid metadata schema')
  return `
ALTER TABLE ${metadataSchema}.action_type ADD COLUMN IF NOT EXISTS allowed_callers text[];
-- Unlike audit_log, this records admission attempts even when validation/execution later fails.
-- API names are text snapshots so access history does not depend on a catalog row surviving.
CREATE TABLE IF NOT EXISTS ${metadataSchema}.access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_identity text NOT NULL,
  action_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allowed', 'denied')),
  reason text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`
}

/** Storage plus catalog registration makes flags discoverable through all generic object routes.
 * API camelCase fields map explicitly to snake_case storage. Each flag belongs to one batch;
 * a batch can have many independent flags, exposed by the inverse flags relationship.
 */
export function buildFlagLogSchemaSql(): string {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='manufacturing' AND t.typname='flag_severity') THEN
    CREATE TYPE manufacturing.flag_severity AS ENUM ('low', 'medium', 'high');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='manufacturing' AND t.typname='flag_status') THEN
    CREATE TYPE manufacturing.flag_status AS ENUM ('open', 'resolved', 'dismissed');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS manufacturing.flag_log (
  id text PRIMARY KEY,
  batch_id text NOT NULL REFERENCES manufacturing.batch(id),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  severity manufacturing.flag_severity NOT NULL,
  status manufacturing.flag_status NOT NULL DEFAULT 'open',
  flagged_by text NOT NULL,
  flagged_at timestamptz NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS flag_log_batch_id_idx ON manufacturing.flag_log(batch_id);
INSERT INTO manufacturing.object_type (api_name, name, description, schema, datasource_table)
VALUES ('flagLog', 'Flag Log', 'A batch concern tracked independently of production status.', 'manufacturing', 'flag_log')
ON CONFLICT (api_name) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
  schema=EXCLUDED.schema, datasource_table=EXCLUDED.datasource_table;
INSERT INTO manufacturing.property
  (object_type_id, api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
SELECT t.id, p.* FROM manufacturing.object_type t CROSS JOIN (VALUES
  ('id', 'ID', 'string', true, false, true, 'id'),
  ('batchId', 'Batch ID', 'string', true, false, false, 'batch_id'),
  ('reason', 'Reason', 'string', true, true, false, 'reason'),
  ('severity', 'Severity', 'enum', true, false, false, 'severity'),
  ('status', 'Status', 'enum', true, false, false, 'status'),
  ('flaggedBy', 'Flagged By', 'string', true, false, false, 'flagged_by'),
  ('flaggedAt', 'Flagged At', 'datetime', true, false, false, 'flagged_at'),
  ('resolvedAt', 'Resolved At', 'datetime', false, false, false, 'resolved_at')
) p(api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
WHERE t.api_name='flagLog'
ON CONFLICT (object_type_id, api_name) DO UPDATE SET name=EXCLUDED.name, data_type=EXCLUDED.data_type,
  required=EXCLUDED.required, is_title=EXCLUDED.is_title, is_primary_key=EXCLUDED.is_primary_key,
  datasource_column=EXCLUDED.datasource_column;
-- link has no unique-name constraint: test existence to keep repeated metadata application idempotent.
INSERT INTO manufacturing.link
  (api_name, name, inverse_api_name, inverse_name, source_type_id, target_type_id, via_property_id, cardinality)
SELECT 'batch', 'Batch', 'flags', 'Flags', f.id, b.id, p.id, 'many_to_one'
FROM manufacturing.object_type f JOIN manufacturing.property p ON p.object_type_id=f.id AND p.api_name='batchId'
CROSS JOIN manufacturing.object_type b
WHERE f.api_name='flagLog' AND b.api_name='batch'
  AND NOT EXISTS (SELECT 1 FROM manufacturing.link l WHERE l.source_type_id=f.id AND l.api_name='batch');
`
}

/** Reproduce the existing transfer field/catalog mapping on installations missing it; do not backfill plans. */
export function buildBatchInterventionSchemaSql(): string {
  return `
ALTER TABLE manufacturing.batch ADD COLUMN IF NOT EXISTS planned_transfer_at timestamptz;
INSERT INTO manufacturing.property
  (object_type_id, api_name, name, data_type, required, is_title, is_primary_key, datasource_column)
SELECT id, 'plannedTransferAt', 'Planned Transfer At', 'datetime', false, false, false, 'planned_transfer_at'
FROM manufacturing.object_type WHERE api_name = 'batch'
ON CONFLICT (object_type_id, api_name) DO UPDATE SET
  name = EXCLUDED.name, data_type = EXCLUDED.data_type, required = EXCLUDED.required,
  is_title = EXCLUDED.is_title, is_primary_key = EXCLUDED.is_primary_key,
  datasource_column = EXCLUDED.datasource_column;
`
}
