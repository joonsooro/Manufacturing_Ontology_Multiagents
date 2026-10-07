/**
 * Selected-batch inspection: show linked recipe/tank/quality data and action audit history.
 * Tank maintenance is joined separately and compared with the planned fermentation window.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Card, Collapse, Icon, Spinner, Tag } from "@blueprintjs/core";
import { fetchAudit, fetchInstances, fetchObject } from "./api.ts";
import type { AuditEntry } from "./api.ts";
import "./BatchDetailPanel.css";

type Row = Record<string, unknown>;
const courseNow = new Date(import.meta.env.COURSE_NOW || Date.now());
// Database decimal values may arrive as strings; keep absent readings distinct from zero.
const asNumber = (value: unknown) => value === null || value === undefined || value === "" ? null : Number(value);
const formatDate = (value: unknown) => value ? new Date(String(value)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

/** Use the latest recipe checkpoint at/before the fermentation day, with the first point as fallback. */
function targetAtDay(curve: unknown, day: number | null) { const entries = curve && typeof curve === "object" ? Object.entries(curve as Row).map(([key, value]) => [Number(key.replace("day_", "")), Number(value)] as const).filter(([d, v]) => Number.isFinite(d) && Number.isFinite(v)).sort(([a], [b]) => a - b) : []; return entries.length ? [...entries].reverse().find(([d]) => d <= (day ?? 0))?.[1] ?? entries[0][1] : null; }

/** Load the selected batch/links, tank maintenance collection, and its action history in parallel. */
export function BatchDetailPanel({ batchId }: { batchId: string }) {
  const [batch, setBatch] = useState<Row | null>(null);
  const [maintenance, setMaintenance] = useState<Row[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // A batch-selection change may outpace HTTP responses; the flag prevents updating an obsolete panel.
  useEffect(() => { let cancelled = false; setLoading(true); Promise.all([fetchObject("batch", batchId), fetchInstances("maintenanceLog"), fetchAudit("batch", batchId)]).then(([item, logs, auditEntries]) => { if (!cancelled) { setBatch(item); setMaintenance(logs); setAudit(auditEntries); } }).finally(() => !cancelled && setLoading(false)); return () => { cancelled = true; }; }, [batchId]);
  if (loading) return <Card className="batch-detail-card loading-detail" elevation={0}><Spinner /></Card>;
  if (!batch) return null;
  // The detail endpoint has already resolved these relationships using ontology link metadata.
  const links = batch.links as Record<string, { data: Row | Row[] | null }> | undefined;
  const recipe = links?.recipe?.data as Row | null;
  const tank = links?.assignedTank?.data as Row | null;
  const quality = (links?.qualityTests?.data ? (Array.isArray(links.qualityTests.data) ? links.qualityTests.data : [links.qualityTests.data]) : []) as Row[];
  // Compare maintenance timestamps with planned_start plus the recipe's fermentation duration.
  // This is a planned window, not an independently recorded actual start/end interval.
  const days = asNumber(batch.days_fermenting);
  const target = targetAtDay(recipe?.target_sugar_curve, days);
  const sugar = asNumber(batch.current_sugar_level);
  const tankLogs = maintenance.filter((log) => log.target_type === "tank" && log.target_id === (tank?.id ?? batch.assigned_tank_id));
  const start = batch.planned_start ? new Date(String(batch.planned_start)) : null;
  const end = start && recipe?.fermentation_days ? new Date(start.getTime() + Number(recipe.fermentation_days) * 86400000) : null;
  return <div className="batch-detail-panel"><header><Icon icon="cube" /><div><strong>{batchId}</strong><span>{String(recipe?.name ?? batch.recipe_id ?? "Batch")}</span></div></header><DetailSection title="Batch"><DetailRow label="Sugar level">{sugar === null ? "—" : <>{sugar.toFixed(3)} {target !== null && <span className="detail-muted">vs {target.toFixed(3)} target</span>}</>}</DetailRow><DetailRow label="Temperature">{asNumber(batch.current_temperature) === null ? "—" : `${asNumber(batch.current_temperature)} °C`}</DetailRow><DetailRow label="Days fermenting">{days ?? "—"}</DetailRow><DetailRow label="Planned start">{formatDate(batch.planned_start)}</DetailRow><DetailRow label="Last operator note">{String(batch.last_operator_note ?? "—")}</DetailRow></DetailSection><DetailSection title="Recipe"><DetailRow label="Name">{String(recipe?.name ?? "—")}</DetailRow><DetailRow label="Fermentation days">{String(recipe?.fermentation_days ?? "—")}</DetailRow><DetailRow label="Sensitivity notes">{String(recipe?.notes ?? "—")}</DetailRow><Curve curve={recipe?.target_sugar_curve} day={days} target={target} /></DetailSection><DetailSection title="Tank + Maintenance" count={tankLogs.length}><DetailRow label="Tank">{tank ? <>{String(tank.name)} <Tag minimal>{String(tank.status)}</Tag></> : "Unassigned"}</DetailRow>{tankLogs.map((log) => {
    const at = new Date(String(log.completed_at ?? log.started_at));
    const during = !!start && !!end && at >= start && at <= end; return <div className="maintenance-row" key={String(log.id)}><strong>{String(log.type)}</strong><span>{formatDate(log.completed_at ?? log.started_at)}</span>{during && <Tag minimal intent="warning" icon="warning-sign">During fermentation</Tag>}<small>{String(log.notes ?? "")}</small></div>  
})}{!tankLogs.length && <p className="detail-muted">No maintenance records.</p>}</DetailSection><DetailSection title="Quality Tests" count={quality.length}>{quality.length ? quality.map((test) => <div className="quality-row" key={String(test.id)}><strong>{formatDate(test.test_date)}</strong><span>pH {String(test.ph ?? "—")} · sugar {String(test.sugar_level ?? "—")}</span><span>{String(test.tested_by ?? "")}</span><small>{String(test.notes ?? "")}</small></div>) : <p className="detail-muted">No quality tests recorded.</p>}</DetailSection><DetailSection title="Audit" count={audit.length} defaultOpen={false}>{audit.length ? audit.map((entry, index) => <AuditRow key={`${entry.timestamp}-${index}`} entry={entry} />) : <p className="detail-muted">No audit history.</p>}</DetailSection></div>;
}

/** Show recipe checkpoints and emphasize the most recent checkpoint reached by this batch. */
function Curve({ curve, day, target }: { curve: unknown; day: number | null; target: number | null }) { const points = curve && typeof curve === "object" ? Object.entries(curve as Row).map(([key, value]) => [Number(key.replace("day_", "")), Number(value)] as const).sort(([a], [b]) => a - b) : []; return <div className="curve"><strong>Target sugar curve</strong><div>{points.map(([d, value]) => <span key={d} className={d <= (day ?? -1) && (!points.find(([next]) => next > d && next <= (day ?? -1))) ? "active" : ""}>d{d} <b>{value.toFixed(3)}</b></span>)}</div>{target !== null && <small>Target at day {day}: {target.toFixed(3)}</small>}</div>; }
/** Shared inspection label/value layout. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) { return <div className="detail-row"><span>{label}</span><div>{children}</div></div>; }
/** Give each inspection group an independently collapsible state and optional item count. */
function DetailSection({ title, count, defaultOpen = true, children }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) { const [open, setOpen] = useState(defaultOpen); return <section className="detail-section"><Button minimal onClick={() => setOpen((value) => !value)} rightIcon={open ? "chevron-up" : "chevron-down"}>{title}{count !== undefined && <Tag minimal round>{count}</Tag>}</Button><Collapse isOpen={open}>{children}</Collapse></section>; }
/** Keep audit summaries compact; expand the original params/result JSON for investigation. */
function AuditRow({ entry }: { entry: AuditEntry }) { const [open, setOpen] = useState(false); return <div className="audit-row"><Button minimal small onClick={() => setOpen((value) => !value)} rightIcon={open ? "chevron-down" : "chevron-right"}>{entry.action}</Button><span>{entry.actor}</span><small>{formatDate(entry.timestamp)}</small><Collapse isOpen={open}><pre>params: {JSON.stringify(entry.params, null, 2)}{"\n"}result: {JSON.stringify(entry.result, null, 2)}</pre></Collapse></div>; }
