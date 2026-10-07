/**
 * Manufacturing dashboard: join batches to recipes/tanks, compare sugar with recipe targets,
 * and highlight recent tank maintenance before opening a detailed batch inspection.
 */
import { useEffect, useMemo, useState } from "react";
import { Card, HTMLSelect, Icon, NonIdealState, Spinner, Switch, Tag } from "@blueprintjs/core";
import { fetchInstances } from "./api.ts";
import { BatchDetailPanel } from "./BatchDetailPanel.tsx";
import "./BatchInvestigation.css";

type Row = Record<string, unknown>;
type BatchRow = Row & { id: string; recipe_id: string; status: string; current_sugar_level: string | number | null; days_fermenting: number | null; assigned_tank_id: string | null };

// Recent-maintenance windows use the injected course date, falling back to browser time if absent.
const courseNow = new Date(import.meta.env.COURSE_NOW || Date.now());

/** Recipe curves are stepwise checkpoints: use the latest day_N value at/before the batch's day. */
function targetAtDay(curve: unknown, day: number | null): number | null {
  if (!curve || typeof curve !== "object") return null;
  const entries = Object.entries(curve as Record<string, unknown>).map(([key, value]) => [Number(key.replace("day_", "")), Number(value)] as const).filter(([key, value]) => Number.isFinite(key) && Number.isFinite(value)).sort(([a], [b]) => a - b);
  if (!entries.length) return null;
  const currentDay = day ?? 0;
  return [...entries].reverse().find(([curveDay]) => curveDay <= currentDay)?.[1] ?? entries[0][1];
}

/** Match this tank and keep completed/started maintenance inside the previous seven course days. */
function maintenanceIsRecent(log: Row, tankId: string | null) {
  if (!tankId || log.target_type !== "tank" || log.target_id !== tankId) return false;
  const maintenanceAt = new Date(String(log.completed_at ?? log.started_at));
  const sevenDaysAgo = new Date(courseNow.getTime() - 7 * 24 * 60 * 60 * 1000);
  return !Number.isNaN(maintenanceAt.getTime()) && maintenanceAt >= sevenDaysAgo && maintenanceAt <= courseNow;
}

/** Load the four collections once and derive dashboard/filter rows locally. */
export function BatchInvestigation() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [recipes, setRecipes] = useState<Row[]>([]);
  const [tanks, setTanks] = useState<Row[]>([]);
  const [maintenance, setMaintenance] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("all");
  const [tank, setTank] = useState("all");
  const [behindOnly, setBehindOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // Independent collections are fetched together; the maps below join them by domain IDs.
  useEffect(() => { Promise.all([fetchInstances("batch"), fetchInstances("recipe"), fetchInstances("tank"), fetchInstances("maintenanceLog")]).then(([batchRows, recipeRows, tankRows, maintenanceRows]) => { setBatches(batchRows as BatchRow[]); setRecipes(recipeRows); setTanks(tankRows); setMaintenance(maintenanceRows); }).finally(() => setLoading(false)); }, []);
  const recipeById = useMemo(() => new Map(recipes.map((recipe) => [String(recipe.id), recipe])), [recipes]);
  const tankById = useMemo(() => new Map(tanks.map((item) => [String(item.id), item])), [tanks]);
  // Higher residual sugar than the recipe target means fermentation is behind; missing values stay unknown.
  const enriched = useMemo(() => batches.map((batch) => {
    const recipe = recipeById.get(batch.recipe_id);
    const target = targetAtDay(recipe?.target_sugar_curve, batch.days_fermenting);
    const sugar = batch.current_sugar_level === null ? null : Number(batch.current_sugar_level);
    const delta = sugar === null || target === null ? null : sugar - target;
    const recentMaintenance = maintenance.some((log) => maintenanceIsRecent(log, batch.assigned_tank_id)); return { batch, recipe, target, sugar, delta, recentMaintenance };
  }), [batches, recipeById, maintenance]);
  const fermenting = enriched.filter(({ batch }) => batch.status === "fermenting");
  // The headline counts only fermenting batches with a sugar delta of at least 0.008.
  const behind = fermenting.filter(({ delta }) => delta !== null && delta >= 0.008);
  const maintenanceCount = fermenting.filter(({ recentMaintenance }) => recentMaintenance).length;
  // Table filters are independent of headline counts; behind-only applies to any listed status with a delta.
  const filtered = enriched.filter(({ batch, delta }) => (status === "all" || batch.status === status) && (tank === "all" || batch.assigned_tank_id === tank) && (!behindOnly || (delta !== null && delta >= 0.008)));
  if (loading) return <main className="manager-main"><div className="loading"><Spinner /></div></main>;
  return <main className="manager-main batch-main"><div className="batch-workspace"><header className="batch-header"><div className="type-symbol"><Icon icon="timeline-events" size={24} /></div><div><h1>Batch Investigation</h1><p>Fermentation health and operations</p></div></header><div className="metric-grid"><Metric icon="timeline-events" label="Fermenting Batches" value={fermenting.length} intent="primary" /><Metric icon="warning-sign" label="Behind Target" value={behind.length} intent="danger" /><Metric icon="wrench" label="Recent Tank Maintenance" value={maintenanceCount} intent="warning" /></div><div className="batch-layout"><section className="batch-list"><div className="batch-filters"><HTMLSelect value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{[...new Set(batches.map((batch) => batch.status))].map((value) => <option key={value}>{value}</option>)}</HTMLSelect><HTMLSelect value={tank} onChange={(event) => setTank(event.target.value)}><option value="all">All tanks</option>{tanks.map((item) => <option key={String(item.id)} value={String(item.id)}>{String(item.name ?? item.id)}</option>)}</HTMLSelect><Switch checked={behindOnly} onChange={(event) => setBehindOnly(event.currentTarget.checked)} label="Behind target only" /></div><Card className="batch-table-card" elevation={0}><table><thead><tr><th>Batch</th><th>Recipe</th><th>Sugar level vs target</th><th>Days</th><th>Tank</th><th>Status</th></tr></thead><tbody>{filtered.map(({ batch, recipe, sugar, target, delta }) => <tr key={batch.id} className={selected === batch.id ? "selected" : ""} onClick={() => setSelected(batch.id)}><td><strong>{batch.id}</strong></td><td>{String(recipe?.name ?? batch.recipe_id)}</td><td><Sugar delta={delta} sugar={sugar} target={target} /></td><td>{batch.days_fermenting ?? "—"}</td><td>{String(tankById.get(batch.assigned_tank_id ?? "")?.name ?? batch.assigned_tank_id ?? "Unassigned")}</td><td><Tag minimal intent={batch.status === "fermenting" ? "success" : "none"}>{batch.status}</Tag></td></tr>)}</tbody></table>{!filtered.length && <NonIdealState icon="filter" title="No batches match these filters" />}</Card></section><aside className="batch-detail">{selected ? <BatchDetailPanel batchId={selected} /> : <Card elevation={0}><Icon icon="selection" size={30} /><h2>Select a batch</h2><p>Choose a row to inspect its fermentation status.</p></Card>}</aside></div></div></main>;
}

/** Reusable headline count card with the dashboard's semantic color/icon. */
function Metric({ icon, label, value, intent }: { icon: "timeline-events" | "warning-sign" | "wrench"; label: string; value: number; intent: "primary" | "danger" | "warning" }) { return <Card className={`metric-card metric-${intent}`} elevation={0}><Icon icon={icon} size={22} /><div><strong>{value}</strong><span>{label}</span></div></Card>; }
/** Display thresholds: green <= 0.005, amber < 0.008, red otherwise; unknown targets remain neutral. */
function Sugar({ delta, sugar, target }: { delta: number | null; sugar: number | null; target: number | null }) {
  if (delta === null || sugar === null || target === null) return <span className="bp5-text-muted">No target</span>;
  const tone = delta <= .005 ? "green" : delta < .008 ? "amber" : "red"; return <div className={`sugar-${tone}`}><strong>{sugar.toFixed(3)}</strong><span>target {target.toFixed(3)} · {delta >= 0 ? "+" : ""}{delta.toFixed(3)}</span></div>;
}
