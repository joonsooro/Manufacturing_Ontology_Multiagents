/** Human review queue: pending and escalated lanes both retain approve/reject actions. */
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, Callout, FormGroup, HTMLTable, NonIdealState, Spinner, Tag, TextArea } from "@blueprintjs/core";
import { fetchReviewableProposals, postAction } from "./api.ts";
import type { ActionRequestOptions, Proposal } from "./api.ts";
import "./ProposalsQueue.css";

// The queue owns its current reviewer context; the transport accepts any caller identity.
// This is a local demo value until the application supplies a signed-in user context.
const reviewerContext: ActionRequestOptions = { callerIdentity: "brewmaster-lee" };

/** Keep mutation errors per proposal so one failed review does not obscure the remaining queue. */
export function ProposalsQueue() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<number, string | undefined>>({});
  // Drafts belong to each proposal and survive failed decisions so reviewers can amend and retry.
  const [decisionNotes, setDecisionNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  // A synchronous guard prevents duplicate decisions before React paints the disabled buttons.
  const inFlight = useRef(new Set<number>());
  const generation = useRef(0);

  /** Ignore stale reads so a previous refresh cannot restore a row already decided by the server. */
  async function refresh() {
    const request = ++generation.current;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchReviewableProposals();
      if (request === generation.current) setProposals(rows);
    } catch (error) {
      if (request === generation.current) setLoadError(error instanceof Error ? error.message : "Could not load proposals.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);

  /** Approval runs the inner action atomically on the server; never optimistically mark it approved. */
  async function decide(proposal: Proposal, action: "approve" | "reject") {
    if (inFlight.current.has(proposal.id)) return;
    inFlight.current.add(proposal.id);
    setBusy((current) => ({ ...current, [proposal.id]: true }));
    setErrors((current) => ({ ...current, [proposal.id]: undefined }));
    try {
      const decisionNote = (decisionNotes[proposal.id] ?? "").trim();
      // Keep human feedback on the decision; it is not a parameter of the proposed batch action.
      await postAction("proposal", String(proposal.id), action, decisionNote ? { decisionNote } : {}, reviewerContext);
      // Only a confirmed final decision removes the row from either reviewable lane.
      generation.current++;
      setProposals((current) => current.filter((row) => row.id !== proposal.id));
      setDecisionNotes((current) => {
        const remaining = { ...current };
        delete remaining[proposal.id];
        return remaining;
      });
      await refresh();
    } catch (error) {
      // Keep the row in its current lane when invocation fails, including inner-action failures.
      setErrors((current) => ({ ...current, [proposal.id]: error instanceof Error ? error.message : "Review failed." }));
    } finally {
      inFlight.current.delete(proposal.id);
      setBusy((current) => ({ ...current, [proposal.id]: false }));
    }
  }

  /** Render both states with the same decision mechanics so escalation never strands a proposal. */
  function renderLane(status: "pending" | "escalated", title: string, description: string) {
    const rows = proposals.filter((proposal) => proposal.status === status);
    return <section className="proposal-lane" aria-label={`${title} proposals`} key={status}>
      <header><h2>{title} <Tag minimal intent={status === "escalated" ? "danger" : "warning"}>{rows.length}</Tag></h2><p>{description}</p></header>
      {!loading && rows.length === 0 && <NonIdealState icon="inbox" title={`No ${status} proposals`} />}
      {rows.length > 0 && <div className="proposals-table-scroll"><HTMLTable striped bordered className="proposals-table">
      <thead><tr>{["Type", "Target", "Proposed By", "Proposed At", "Rationale", "Parameters", "Status", "Review"].map((label) => <th key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((proposal) => <Fragment key={proposal.id}>
        <tr>
          <td><strong>Proposal {proposal.id}</strong><br /><code>{proposal.type}</code></td><td>{proposal.target_id}</td><td>{proposal.proposed_by}</td>
          <td><time dateTime={proposal.proposed_at}>{proposal.proposed_at}</time></td>
          <td className="proposal-rationale">{proposal.rationale}</td><td><pre>{JSON.stringify(proposal.params, null, 2)}</pre></td>
          <td><Tag intent={status === "escalated" ? "danger" : "warning"}>{proposal.status}</Tag></td>
          <td className="proposal-review">
            {status === "escalated" && <Callout intent="warning" title="Escalation reason" className="proposal-escalation">
              <p>{proposal.decision_note ?? "No escalation note recorded."}</p>
              <small>{proposal.reviewed_by ?? "Unknown reviewer"}{proposal.reviewed_at && <> · <time dateTime={proposal.reviewed_at}>{proposal.reviewed_at}</time></>}</small>
            </Callout>}
            <FormGroup label="Decision feedback" labelFor={`decision-note-${proposal.id}`} labelInfo="(optional)"
              helperText="Saved with approval or rejection for the proposing agent to read.">
              <TextArea id={`decision-note-${proposal.id}`} fill rows={3}
                placeholder="Explain your decision or suggest what the agent should consider next time…"
                value={decisionNotes[proposal.id] ?? ""} disabled={busy[proposal.id]}
                onChange={(event) => setDecisionNotes((current) => ({ ...current, [proposal.id]: event.target.value }))} />
            </FormGroup>
            <div className="proposal-buttons">
            <Button intent="success" onClick={() => void decide(proposal, "approve")} disabled={busy[proposal.id]} aria-label={`Approve proposal ${proposal.id}`}>Approve</Button>
            <Button intent="danger" onClick={() => void decide(proposal, "reject")} disabled={busy[proposal.id]} aria-label={`Reject proposal ${proposal.id}`}>Reject</Button>
          </div></td>
        </tr>
        {errors[proposal.id] && <tr><td colSpan={8}><Callout intent="danger" role="alert">{errors[proposal.id]}</Callout></td></tr>}
      </Fragment>)}</tbody>
    </HTMLTable></div>}
    </section>;
  }

  return <main className="proposals-queue">
    <header><div><h1>Proposals Queue</h1><p>Review pending and escalated proposals as {reviewerContext.callerIdentity}.</p></div>
      <Button icon="refresh" onClick={() => void refresh()} disabled={loading || Object.values(busy).some(Boolean)}>Refresh</Button>
    </header>
    {loadError && <Callout intent="danger" role="alert">{loadError}</Callout>}
    {loading && <Spinner size={24} aria-label="Loading proposals" />}
    {!loadError && <>
      {renderLane("pending", "Pending", "Proposals awaiting verification or review.")}
      {renderLane("escalated", "Escalated", "Unresolved concerns requiring human review. You can approve or reject these proposals.")}
    </>}
  </main>;
}
