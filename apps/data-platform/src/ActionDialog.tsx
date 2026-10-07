/**
 * Build an action form from its metadata JSON Schema and submit parameter-only JSON.
 * Client checks improve feedback; the ontology server performs authoritative validation.
 */
import { useMemo, useState } from "react";
import { Button, Callout, Dialog, FormGroup, HTMLSelect, InputGroup, NumericInput } from "@blueprintjs/core";
import { DateInput } from "@blueprintjs/datetime";
import enUS from "date-fns/locale/en-US/index.js";
import "@blueprintjs/datetime/lib/css/blueprint-datetime.css";
import { postAction } from "./api.ts";
import type { Action, JsonSchema } from "./api.ts";

type Values = Record<string, string | number | null>;

/** Choose a control from supported JSON Schema types, formats, and enum values. */
function inputKind(schema: JsonSchema): "datetime" | "string" | "enum" | "number" {
  if (schema.format === "date-time" || schema.type === "datetime") return "datetime";
  if (schema.enum) return "enum";
  if (schema.type === "number" || schema.type === "integer") return "number";
  return "string";
}

/** An action's metadata determines its fields; no batch/tank/proposal-specific form is needed. */
export function ActionDialog({ action, type, id, onClose, onComplete }: { action: Action; type: string; id: string; onClose: () => void; onComplete: () => void }) {
  // The schema's required list controls client feedback; optional fields may be omitted entirely.
  const fields = useMemo(() => Object.entries(action.parameter_schema.properties ?? {}), [action]);
  const required = new Set(action.parameter_schema.required ?? []);
  const [values, setValues] = useState<Values>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  /** Validate required values locally, omit empty optional fields, then invoke and refresh the object. */
  async function submit() {
    const missing = [...required].find((name) => values[name] === undefined || values[name] === null || values[name] === "");
    if (missing) { setError(`${missing} is required.`); return; }
    // Target type/ID/action are separate routing args; only populated field values become the body.
    const payload = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
    setSubmitting(true); setError(null);
    try { const response = await postAction(type, id, action.api_name, payload); setResult(response); onComplete(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Action failed"); }
    finally { setSubmitting(false); }
  }

  return <Dialog isOpen title={action.name} icon="play" onClose={onClose} className="action-dialog">
    <div className="bp5-dialog-body">
      {action.description && <p className="action-dialog-description">{action.description}</p>}
      {fields.map(([name, schema]) => <FormGroup key={name} label={name} labelInfo={required.has(name) ? "(required)" : "(optional)"}>{field(name, schema, values[name], (value) => setValues((current) => ({ ...current, [name]: value })))}</FormGroup>)}
      {!fields.length && <p className="bp5-text-muted">This action has no parameters.</p>}
      {error && <Callout intent="danger" icon="error">{error}</Callout>}
      {result && <Callout intent="success" icon="tick"><strong>Action completed</strong><pre>{JSON.stringify(result, null, 2)}</pre></Callout>}
    </div>
    <div className="bp5-dialog-footer"><div className="bp5-dialog-footer-actions"><Button onClick={onClose}>Close</Button><Button intent="primary" icon="play" onClick={submit} loading={submitting}>Run action</Button></div></div>
  </Dialog>;
}

/** Bind metadata-selected controls to the dialog's shared value map. */
function field(name: string, schema: JsonSchema, value: Values[string] | undefined, update: (value: Values[string]) => void) {
  switch (inputKind(schema)) {
    case "datetime": return <DateInput fill locale={enUS} value={typeof value === "string" ? value : null} onChange={(date) => update(toRfc3339(date))} placeholder="Select date and time" timePrecision="minute" />;
    case "enum": return <HTMLSelect fill value={typeof value === "string" ? value : ""} onChange={(event) => update(event.target.value)}><option value="">Select a value…</option>{schema.enum?.map((option) => <option key={option} value={option}>{option}</option>)}</HTMLSelect>;
    case "number": return <NumericInput fill value={typeof value === "number" ? value : undefined} onValueChange={(number) => update(Number.isFinite(number) ? number : null)} placeholder="Enter a number" />;
    default: return <InputGroup value={typeof value === "string" ? value : ""} onChange={(event) => update(event.target.value)} placeholder={`Enter ${name}`} />;
  }
}

/** Normalize date-picker output to an ISO datetime that the server schema can validate. */
function toRfc3339(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
