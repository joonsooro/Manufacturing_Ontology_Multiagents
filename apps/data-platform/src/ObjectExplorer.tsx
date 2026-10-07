/**
 * Generic object browser driven by properties, links, and actions from metadata.
 * Local route history supports following links and returning to previous objects.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Card, Icon, InputGroup, NonIdealState, Spinner, Switch, Tag, Tooltip } from "@blueprintjs/core";
import type { IconName } from "@blueprintjs/icons";
import { fetchInstances, fetchObject, fetchTypeDetail } from "./api.ts";
import type { ObjectType, Property, TypeDetail } from "./api.ts";
import "./ObjectExplorer.css";
import "./ObjectSearch.css";
import { ActionDialog } from "./ActionDialog.tsx";

// This view's navigation state is local to the component; stack stores prior list/detail locations.
type Route = { kind: "list"; type: string } | { kind: "detail"; type: string; id: string };
type SearchGroup = { type: ObjectType; metadata: TypeDetail; instances: Record<string, unknown>[] };
const valueIcons: Record<string, IconName> = { string: "citation", number: "numerical", datetime: "calendar", json: "code", enum: "properties", "string[]": "th-list" };

/** Format generic property values using their declared ontology data type. */
function displayValue(value: unknown, type: string) {
  if (value === null || value === undefined) return <span className="empty-value">—</span>;
  if (type === "datetime") return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(String(value)));
  if (type === "json") return <code>{JSON.stringify(value)}</code>;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/** Coordinate type selection, instance/detail loads, searches, and navigation history. */
export function ObjectExplorer({ types }: { types: ObjectType[] }) {
  const [route, setRoute] = useState<Route>({ kind: "list", type: types[0]?.api_name ?? "" });
  const [stack, setStack] = useState<Route[]>([]);
  const [metadata, setMetadata] = useState<TypeDetail | null>(null);
  const [instances, setInstances] = useState<Record<string, unknown>[]>([]);
  const [object, setObject] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  // Increment after an action succeeds to reload the currently displayed object.
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [searchAll, setSearchAll] = useState(false);
  const [allTypeResults, setAllTypeResults] = useState<SearchGroup[]>([]);
  const [allTypesLoading, setAllTypesLoading] = useState(false);
  const selectedType = types.find((type) => type.api_name === route.type) ?? null;
  const typesById = useMemo(() => new Map(types.map((type) => [type.id, type])), [types]);

  // Load metadata and the selected data view together whenever navigation or refresh changes.
  useEffect(() => {
    if (!route.type) return;
    setLoading(true); setObject(null);
    Promise.all([fetchTypeDetail(route.type), route.kind === "list" ? fetchInstances(route.type) : fetchObject(route.type, route.id)])
      .then(([type, data]) => { setMetadata(type); route.kind === "list" ? setInstances(data as Record<string, unknown>[]) : setObject(data as Record<string, unknown>); })
      .finally(() => setLoading(false));
  }, [route, refresh]);

  // Cross-type search currently fetches rows into the browser and filters locally; it is not server-side search.
  useEffect(() => {
    if (!searchAll || !query.trim()) { setAllTypeResults([]); return; }
    // Ignore a completed search response after a newer query or unmount makes it stale.
    let cancelled = false;
    setAllTypesLoading(true);
    Promise.all(types.map(async (type) => ({ type, metadata: await fetchTypeDetail(type.api_name), instances: await fetchInstances(type.api_name) })))
      .then((groups) => { if (!cancelled) setAllTypeResults(groups.map((group) => ({ ...group, instances: filterInstances(group.instances, group.metadata.properties, query) })).filter((group) => group.instances.length)); })
      .finally(() => { if (!cancelled) setAllTypesLoading(false); });
    return () => { cancelled = true; };
  }, [searchAll, query, types]);

  /** Following an object/link preserves the current location for the Back button. */
  function navigate(next: Route) { setStack((current) => [...current, route]); setRoute(next); }
  /** Choosing a type starts a new list context rather than extending prior object-link history. */
  function selectType(type: string) { setStack([]); setRoute({ kind: "list", type }); }
  /** Restore the last local route when history is available. */
  function back() {
    const previous = stack.at(-1);
    if (previous) { setStack((current) => current.slice(0, -1)); setRoute(previous); }
  }

  return <><aside className="type-rail"><div className="type-rail-heading">Object types <Tag minimal round>{types.length}</Tag></div><div className="type-list">{types.map((type) => <button key={type.id} className={`type-item${type.api_name === route.type ? " is-selected" : ""}`} onClick={() => selectType(type.api_name)}><Icon icon="cube" size={16} /><span><strong>{type.display_name}</strong><small>{type.instance_count.toLocaleString()} objects</small></span></button>)}</div></aside><main className="manager-main explorer-main">{loading || !metadata || !selectedType ? <div className="loading"><Spinner /></div> : route.kind === "list" ? <SearchableInstances type={selectedType} metadata={metadata} instances={instances} query={query} setQuery={setQuery} searchAll={searchAll} setSearchAll={setSearchAll} allTypeResults={allTypeResults} allTypesLoading={allTypesLoading} open={navigate} /> : object ? <ObjectDetail type={selectedType} metadata={metadata} object={object} id={route.id} typesById={typesById} back={back} canBack={stack.length > 0} open={navigate} refresh={() => setRefresh((current) => current + 1)} /> : <NonIdealState icon="error" title="Object unavailable" />}</main></>;
}

/** Switch between this type's local results and grouped cross-type results. */
function SearchableInstances({ type, metadata, instances, query, setQuery, searchAll, setSearchAll, allTypeResults, allTypesLoading, open }: { type: ObjectType; metadata: TypeDetail; instances: Record<string, unknown>[]; query: string; setQuery: (value: string) => void; searchAll: boolean; setSearchAll: (value: boolean) => void; allTypeResults: SearchGroup[]; allTypesLoading: boolean; open: (route: Route) => void }) {
  const filtered = useMemo(() => filterInstances(instances, metadata.properties, query), [instances, metadata.properties, query]);
  return <div className="explorer-content"><div className="explorer-search"><InputGroup leftIcon="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${type.display_name} objects…`} /><Switch checked={searchAll} onChange={(event) => setSearchAll(event.currentTarget.checked)} label="Search all types" /></div>{searchAll && query.trim() ? allTypesLoading ? <div className="search-loading"><Spinner size={20} /> Searching all types…</div> : <AllTypeResults groups={allTypeResults} open={open} /> : <InstanceList type={type} metadata={metadata} instances={filtered} open={(id) => open({ kind: "detail", type: type.api_name, id })} />}</div>;
}

/** Group local matches by type and use each group's metadata-defined title/primary key. */
function AllTypeResults({ groups, open }: { groups: SearchGroup[]; open: (route: Route) => void }) {
  const total = groups.reduce((count, group) => count + group.instances.length, 0);
  return <div className="all-results"><header><h1>Search results</h1><p>{total} matching {total === 1 ? "object" : "objects"}</p></header>{groups.length ? groups.map((group) => {
    const title = group.metadata.properties.find((property) => property.is_title) ?? group.metadata.properties[0];
    const primary = group.metadata.properties.find((property) => property.is_primary_key); return <Card className="instance-card result-group" elevation={0} key={group.type.id}><header><Icon icon="cube" /><h2>{group.type.display_name}</h2><Tag minimal round>{group.instances.length}</Tag></header>{group.instances.map((instance, index) => { const id = primary ? String(instance[primary.datasource_column]) : String(index); return <button key={id} onClick={() => open({ kind: "detail", type: group.type.api_name, id })}><span>{title ? displayValue(instance[title.datasource_column], title.data_type) : id}</span><Icon icon="chevron-right" /></button>; })}</Card>;
  }) : <NonIdealState icon="search" title="No matching objects" description="Try a different search term." />}</div>;
}

/** Generic instance table with clickable IDs and metadata-selected display titles. */
function InstanceList({ type, metadata, instances, open }: { type: ObjectType; metadata: TypeDetail; instances: Record<string, unknown>[]; open: (id: string) => void }) {
  const title = metadata.properties.find((property) => property.is_title) ?? metadata.properties[0];
  const primary = metadata.properties.find((property) => property.is_primary_key);
  return <div className="explorer-content"><header className="explorer-header"><div className="type-symbol"><Icon icon="cube" size={24} /></div><div><h1>{type.display_name}</h1><p>{instances.length.toLocaleString()} objects</p></div></header><Card className="instance-card" elevation={0}><header><Icon icon="th" /><h2>Objects</h2><Tag minimal round>{instances.length}</Tag></header>{instances.length ? <table className="instance-table"><thead><tr><th>{title?.name ?? "Object"}</th><th>Status</th><th>ID</th></tr></thead><tbody>{instances.map((instance, index) => { const id = primary ? String(instance[primary.datasource_column]) : String(index); return <tr key={id} onClick={() => open(id)}><td>{title ? displayValue(instance[title.datasource_column], title.data_type) : id}</td><td>{instance.status ? <Tag minimal intent="success">{String(instance.status)}</Tag> : "—"}</td><td><code>{id}</code></td></tr>; })}</tbody></table> : <div className="section-empty">No objects found</div>}</Card></div>;
}

/** Render properties, navigable relationship values, and metadata-generated action forms. */
function ObjectDetail({ type, metadata, object, id, typesById, back, canBack, open, refresh }: { type: ObjectType; metadata: TypeDetail; object: Record<string, unknown>; id: string; typesById: Map<string, ObjectType>; back: () => void; canBack: boolean; open: (route: Route) => void; refresh: () => void }) {
  const [activeAction, setActiveAction] = useState<typeof metadata.actions[number] | null>(null);
  const titleProperty = metadata.properties.find((property) => property.is_title) ?? metadata.properties[0];
  const title = titleProperty ? String(object[titleProperty.datasource_column] ?? "Untitled") : "Object";
  const links = object.links as Record<string, { name: string; data: Record<string, unknown> | Record<string, unknown>[] | null }> | undefined;
  // Metadata supplies relationship labels/direction; object.links supplies the already-resolved related rows.
  const allLinks = [...metadata.links.outbound.map((link) => ({ link, incoming: false })), ...metadata.links.inbound.map((link) => ({ link, incoming: true }))];
  return <div className="explorer-content"><header className="object-header"><Button minimal icon="chevron-left" onClick={back} disabled={!canBack}>Back</Button><div className="type-symbol"><Icon icon="cube" size={24} /></div><div><h1>{title}</h1><p>{type.display_name}</p></div></header><div className="action-strip">{metadata.actions.map((action) => <Tooltip key={action.id} content={action.description ?? action.name}><Button icon="play" outlined onClick={() => setActiveAction(action)}>{action.name}</Button></Tooltip>)}</div><div className="object-grid"><Card className="object-panel" elevation={0}><header><Icon icon="properties" /><h2>Properties</h2></header><div className="detail-properties">{metadata.properties.map((property) => <div key={property.id} className="detail-property"><Icon icon={valueIcons[property.data_type] ?? "property"} /><span>{property.name}</span><strong>{displayValue(object[property.datasource_column], property.data_type)}</strong></div>)}</div></Card><Card className="object-panel" elevation={0}><header><Icon icon="link" /><h2>Links</h2></header>{allLinks.length ? allLinks.map(({ link, incoming }) => {
    const label = incoming ? link.inverse_name : link.name;
    const apiName = incoming ? link.inverse_api_name : link.api_name;
    const raw = links?.[apiName]?.data;
    const values = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    const related = typesById.get(incoming ? link.source_type_id : link.target_type_id); return <section className="link-group" key={link.id}><h3>{label}<Tag minimal round>{values.length}</Tag></h3>{values.length ? values.map((value, index) => { const relatedId = related ? findObjectId(value, related) : null; return <button key={index} onClick={() => related && relatedId && open({ kind: "detail", type: related.api_name, id: relatedId })}><Icon icon="cube" /><span>{objectName(value, related)}</span><Icon icon="chevron-right" /></button>; }) : <div className="empty-links">No linked objects</div>}</section>;
  }) : <div className="section-empty">No links defined</div>}</Card></div>{activeAction && <ActionDialog action={activeAction} type={type.api_name} id={id} onClose={() => setActiveAction(null)} onComplete={refresh} />}</div>;
}

/** Linked rows currently use id or a conventional type_id fallback; stringify numeric IDs for routing. */
function findObjectId(value: Record<string, unknown>, type: ObjectType) { return String(value.id ?? value[`${type.api_name}_id`] ?? "") || null; }
/** Prefer a linked object's name, then its ID, when no richer title metadata is available here. */
function objectName(value: Record<string, unknown>, type?: ObjectType) { if (!type) return "Linked object"; return String(value.name ?? value.id ?? type.display_name); }
/** Case-insensitive substring search across declared non-boolean properties in already-loaded rows. */
function filterInstances(instances: Record<string, unknown>[], properties: Property[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return instances; return instances.filter((instance) => properties.some((property) => property.data_type !== "boolean" && String(instance[property.datasource_column] ?? "").toLocaleLowerCase().includes(normalized)));
}
