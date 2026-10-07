/**
 * Data-platform shell with metadata management, object exploration, and batch investigation.
 * The manager edits type labels/descriptions, while the other views inspect instance data.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Card, EditableText, Icon, Intent, NonIdealState, Spinner, Tag } from "@blueprintjs/core";
import type { IconName } from "@blueprintjs/icons";
import "@blueprintjs/core/lib/css/blueprint.css";
import "@blueprintjs/icons/lib/css/blueprint-icons.css";
import { fetchTypeDetail, fetchTypes, patchType } from "./api.ts";
import type { ObjectType, TypeDetail } from "./api.ts";
import { ObjectExplorer } from "./ObjectExplorer.tsx";
import { BatchInvestigation } from "./BatchInvestigation.tsx";
import { ProposalsQueue } from "./ProposalsQueue.tsx";
import "./App.css";

// Generic property icons come from metadata types, not the current domain's table names.
const typeIcons: Record<string, IconName> = { string: "citation", number: "numerical", datetime: "calendar", enum: "properties", json: "code" };
const objectLabel = (count: number) => `${count.toLocaleString()} ${count === 1 ? "object" : "objects"}`;

/** Keep a local edit draft; failed saves restore the last persisted value. */
function Editable({ value, placeholder, multiline, save }: { value: string; placeholder?: string; multiline?: boolean; save: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <EditableText value={draft} onChange={setDraft} onConfirm={(next) => next !== value ? save(next).catch(() => setDraft(value)) : undefined} placeholder={placeholder} multiline={multiline} minLines={1} maxLines={3} selectAllOnFocus />;
}

/** Own the shared catalog and choose the active workspace without a separate router. */
export function App() {
  const [types, setTypes] = useState<ObjectType[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TypeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [app, setApp] = useState<"manager" | "explorer" | "investigation" | "proposals">("manager");
  // First load selects the first available type; subsequent detail loads follow selection changes.
  useEffect(() => { fetchTypes().then((result) => { setTypes(result); setSelected(result[0]?.api_name ?? null); }).catch(() => setError("Could not load ontology metadata.")).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!selected) return; setLoadingDetail(true); fetchTypeDetail(selected).then(setDetail).catch(() => setError("Could not load object type details.")).finally(() => setLoadingDetail(false)); }, [selected]);
  const selectedType = types.find((type) => type.api_name === selected) ?? null;
  // Relationship metadata stores UUID references, so resolve related labels through this lookup.
  const typesById = useMemo(() => new Map(types.map((type) => [type.id, type])), [types]);
  // Synchronize the type rail and current detail panel after a successful metadata edit.
  async function save(updates: { display_name?: string; description?: string | null }) {
    if (!selectedType) return;
    const updated = await patchType(selectedType.api_name, updates); setTypes((current) => current.map((type) => type.id === updated.id ? updated : type)); setDetail((current) => current ? { ...current, object_type: { ...current.object_type, name: updated.display_name, description: updated.description } } : null);
  }
  if (loading) return <div className="loading"><Spinner /></div>;
  if (!selectedType) return <NonIdealState icon="cube" title="No object types" description={error ?? "No ontology metadata is available."} />;
  return <div className="ontology-shell"><nav className="app-rail"><Button minimal icon="cube" active={app === "manager"} onClick={() => setApp("manager")} aria-label="Ontology Manager" /><Button minimal icon="search-template" active={app === "explorer"} onClick={() => setApp("explorer")} aria-label="Object Explorer" /><Button minimal icon="timeline-events" active={app === "investigation"} onClick={() => setApp("investigation")} aria-label="Batch Investigation" /><Button minimal icon="inbox" active={app === "proposals"} onClick={() => setApp("proposals")} aria-label="Proposals Queue" title="Proposals Queue" /></nav>{app === "proposals" ? <ProposalsQueue /> : app === "investigation" ? <BatchInvestigation /> : app === "explorer" ? <ObjectExplorer types={types} /> : <><aside className="type-rail"><div className="type-rail-heading">Object types <Tag minimal round>{types.length}</Tag></div><div className="type-list">{types.map((type) => <button key={type.id} className={`type-item${selected === type.api_name ? " is-selected" : ""}`} onClick={() => setSelected(type.api_name)}><Icon icon="cube" size={16} /><span><strong>{type.display_name}</strong><small>{objectLabel(type.instance_count)}</small></span></button>)}</div></aside><main className="manager-main">{error && <div className="error-banner">{error}</div>}{loadingDetail || !detail ? <div className="loading"><Spinner /></div> : <TypePage type={selectedType} detail={detail} typesById={typesById} save={save} />}</main></>}</div>;
}

/** Metadata-manager view; property/action/link rows are descriptions, not instance execution controls. */
function TypePage({ type, detail, typesById, save }: { type: ObjectType; detail: TypeDetail; typesById: Map<string, ObjectType>; save: (changes: { display_name?: string; description?: string | null }) => Promise<void> }) {
  // Show each relationship from this type's perspective, using inverse labels for incoming links.
  const links = [...detail.links.outbound.map((link) => ({ link, incoming: false })), ...detail.links.inbound.map((link) => ({ link, incoming: true }))];
  return <div className="manager-content"><header className="type-header"><div className="type-symbol"><Icon icon="cube" size={28} /></div><div><div className="type-title"><Editable value={type.display_name} save={(value) => value.trim() ? save({ display_name: value.trim() }) : Promise.resolve()} /></div><p>Object type · {objectLabel(type.instance_count)}</p></div><div className="header-actions"><Button outlined rightIcon="caret-down">Actions</Button><Button outlined rightIcon="caret-down">Open in</Button></div></header><Card className="metadata-card" elevation={0}><div className="metadata-column"><Row label="Display name"><Editable value={type.display_name} save={(value) => value.trim() ? save({ display_name: value.trim() }) : Promise.resolve()} /></Row><Row label="Description"><Editable value={type.description ?? ""} placeholder="Add a description…" multiline save={(value) => save({ description: value || null })} /></Row>{type.point_of_contact && <Row label="Point of contact">{type.point_of_contact}</Row>}<Row label="API name"><code>{type.api_name}</code></Row><Row label="Datasource"><code>{type.schema}.{type.datasource_table}</code></Row></div><div className="metadata-column metadata-status"><Row label="Status"><Tag minimal intent={type.status === "active" ? Intent.SUCCESS : Intent.NONE}>{type.status}</Tag></Row><Row label="Visibility"><Tag minimal intent={Intent.PRIMARY} icon="eye-open">{type.visibility}</Tag></Row><Row label="Edits"><Tag minimal intent={type.edits_enabled ? Intent.SUCCESS : Intent.WARNING}>{type.edits_enabled ? "Enabled" : "Disabled"}</Tag></Row><Row label="ID"><code>{type.id}</code></Row></div></Card><div className="lower-grid"><Section title="Properties" count={detail.properties.length}>{detail.properties.map((property) => <div className="property-row" key={property.id}><Icon icon={typeIcons[property.data_type] ?? "property"} /><span>{property.name}</span>{property.is_title && <Tag minimal intent={Intent.SUCCESS}>Title</Tag>}{property.is_primary_key && <Tag minimal intent={Intent.PRIMARY}>Primary key</Tag>}</div>)}</Section><Section title="Action types" count={detail.actions.length}>{detail.actions.map((action) => <div className="action-row" key={action.id}><Icon icon="play" intent="primary" /><div><strong>{action.name}</strong>{action.description && <small>{action.description}</small>}</div></div>)}</Section></div><Section title="Link types" count={links.length}>{links.length > 0 && <table className="links-table"><thead><tr><th>Direction</th><th>Link name</th><th>Related type</th><th>Cardinality</th></tr></thead><tbody>{links.map(({ link, incoming }) => <tr key={`${incoming}-${link.id}`}><td><Icon icon={incoming ? "arrow-left" : "arrow-right"} /></td><td>{incoming ? link.inverse_name : link.name}</td><td>{typesById.get(incoming ? link.source_type_id : link.target_type_id)?.display_name ?? "Unknown type"}</td><td><Tag minimal>{link.cardinality.replaceAll("_", " ")}</Tag></td></tr>)}</tbody></table>}</Section></div>;
}
/** Shared label/value layout for type metadata. */
function Row({ label, children }: { label: string; children: React.ReactNode }) { return <div className="meta-row"><span>{label}</span><div>{children}</div></div>; }
/** Render a catalog collection with its count and an explicit empty state. */
function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) { return <section className="section-card"><header><h2>{title}</h2><Tag minimal round>{count}</Tag></header><div>{count ? children : <div className="section-empty">No {title.toLowerCase()} defined</div>}</div></section>; }
