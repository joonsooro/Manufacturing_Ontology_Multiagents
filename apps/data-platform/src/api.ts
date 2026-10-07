/**
 * Browser API contracts and HTTP helpers for ontology metadata, instances, actions, and audit.
 * Rows use datasource column names; metadata supplies the public names shown in the UI.
 */
const META = "/api/objects/meta";

/** Server metadata payload: name is its display label, distinct from the stable api_name. */
type RawObjectType = {
  id: string;
  api_name: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  point_of_contact: string | null;
  edits_enabled: boolean;
  schema: string;
  datasource_table: string;
  instance_count?: number;
};

/** UI-friendly catalog row with a normalized display label and always-present count. */
export type ObjectType = Omit<RawObjectType, "name"> & {
  display_name: string;
  instance_count: number;
};

// These metadata contracts let UI components render arbitrary ontology types without domain-specific forms.
export type Property = { id: string; api_name: string; name: string; data_type: string; required: boolean; is_title: boolean; is_primary_key: boolean; datasource_column: string };
export type Link = { id: string; api_name: string; name: string; inverse_api_name: string; inverse_name: string; source_type_id: string; target_type_id: string; cardinality: string };
export type Action = { id: string; api_name: string; name: string; description: string | null; parameter_schema: JsonSchema };
export type TypeDetail = { object_type: RawObjectType; properties: Property[]; links: { outbound: Link[]; inbound: Link[] }; actions: Action[] };
export type JsonSchema = { type?: string; format?: string; enum?: string[]; required?: string[]; properties?: Record<string, JsonSchema> };

/** Normalize server metadata once so components do not repeat name/count fallback logic. */
function toObjectType(type: RawObjectType): ObjectType { return { ...type, display_name: type.name, instance_count: type.instance_count ?? 0 }; }
/** Common JSON transport; non-2xx responses reject instead of becoming valid component data. */
async function request<T>(url: string, options?: RequestInit): Promise<T> { const response = await fetch(url, options); if (!response.ok) {
  // Preserve business-rule errors so review failures explain why the proposal stays pending.
  const result: unknown = await response.json().catch(() => null);
  throw new Error(typeof result === "object" && result !== null && "error" in result ? String(result.error) : `Request failed (${response.status})`);
} return response.json() as Promise<T>; }

/** Load the type rail, including server-calculated instance counts. */
export async function fetchTypes(): Promise<ObjectType[]> { return (await request<RawObjectType[]>(`${META}/types`)).map(toObjectType); }
/** Load the properties, links, and action schemas needed to render a type. */
export function fetchTypeDetail(type: string): Promise<TypeDetail> { return request(`${META}/types/${encodeURIComponent(type)}`); }
/** Update display metadata without changing the public API name or underlying table mapping. */
export async function patchType(type: string, updates: { display_name?: string; description?: string | null }): Promise<ObjectType> { const updated = await request<RawObjectType>(`${META}/types/${encodeURIComponent(type)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updates) }); return toObjectType(updated); }
/** Read raw instance rows; displayed names are resolved through property metadata. */
export function fetchInstances(type: string): Promise<Record<string, unknown>[]> { return request(`/api/objects/${encodeURIComponent(type)}`); }
/** Read one row together with relationships resolved by the ontology server. */
export function fetchObject(type: string, id: string): Promise<Record<string, unknown>> { return request(`/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}`); }
/** Request context stays separate from business parameters and can grow without positional arguments. */
export type ActionRequestOptions = { callerIdentity?: string };

/** Map caller context to HTTP headers; only action-specific values belong in the JSON body. */
export function postAction(
  type: string,
  id: string,
  action: string,
  values: Record<string, unknown>,
  options: ActionRequestOptions = {},
): Promise<Record<string, unknown>> {
  return request(`/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.callerIdentity ? { "x-caller-identity": options.callerIdentity } : {}),
    },
    body: JSON.stringify(values),
  });
}
/** Presentation shape returned by the object-audit endpoint, not the raw audit_log row. */
export type AuditEntry = { action: string; actor: string; params: unknown; result: unknown; timestamp: string };
/** Read newest-first action evidence for one object. */
export function fetchAudit(type: string, id: string): Promise<AuditEntry[]> { return request(`/api/objects/${encodeURIComponent(type)}/${encodeURIComponent(id)}/audit`); }

/** Proposal reads use storage column names, matching the generic instance endpoint. */
export type Proposal = {
  id: number; type: string; target_id: string; proposed_by: string; proposed_at: string;
  rationale: string; params: unknown; status: "pending" | "escalated" | "approved" | "rejected";
  // Latest review fields include escalation; a final human decision replaces them while audit keeps history.
  reviewed_by: string | null; reviewed_at: string | null; decision_note: string | null;
};
/** Filter on the server so completed proposals do not crowd the review queue. */
export function fetchPendingProposals(): Promise<Proposal[]> {
  return request("/api/objects/proposal?status=pending");
}

/** Both unfinished states belong in the human queue; completed decisions stay out. */
export function fetchReviewableProposals(): Promise<Proposal[]> {
  return request("/api/objects/proposal/query", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters: [{ property: "status", op: "in", value: ["pending", "escalated"] }], limit: 1000 }),
  });
}
