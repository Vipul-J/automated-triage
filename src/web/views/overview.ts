import {
  PRIORITY_LABEL,
  STATE_LABEL,
  type Priority,
  type IncidentState,
} from "../../servicenow/incident.js";
import type { WorkflowRecord } from "../../orchestration/workflow.js";
import { escapeHtml, page, PRIORITY_COLOUR, TIER_COLOUR } from "./layout.js";

export interface IncidentRow {
  number: string;
  shortDescription: string;
  priority: Priority;
  state: IncidentState;
  assignmentGroup: string | null;
  escalated: boolean;
  openedAt: string;
  sysUpdatedOn: string;
  slaDueAt: string;
  aiTier: string | null;
  aiTriaged: boolean;
}

/**
 * The outcome view.
 *
 * The question this page answers is not "did the AI run" but "did the process
 * hold": was anything escalated that should not have been, and was anything
 * auto-assigned that should have had a human. Those two numbers are the ones
 * worth arguing about, so they are the ones shown largest.
 */
export function renderOverview(
  incidents: readonly IncidentRow[],
  records: readonly WorkflowRecord[],
): string {
  const tierOf = new Map(
    records.filter((r) => r.result).map((r) => [r.ticketId, r.result!.decision.tier]),
  );

  const assigned = incidents.filter((i) => i.assignmentGroup && !i.escalated);
  const breached = incidents.filter((i) => i.escalated);
  // An escalation is only a failure when the incident was eligible for
  // automatic handling. A MANUAL incident escalating is the design working.
  const intended = breached.filter((i) => tierOf.get(i.number) === "MANUAL");
  const unintended = breached.filter((i) => tierOf.get(i.number) !== "MANUAL");

  const handleTimes = assigned
    .map((i) => (Date.parse(i.sysUpdatedOn) - Date.parse(i.openedAt)) / 1000)
    .sort((a, b) => a - b);
  const median = handleTimes.length
    ? handleTimes[Math.floor(handleTimes.length / 2)]!.toFixed(1)
    : null;

  const body = `
<h1>Triage overview</h1>
<p class="lede">Every incident opens with a 3-minute SLA window. The system analyses it,
proposes a routing and a caller reply, and a human approves. What matters is whether the
process holds under the clock — and whether anything reached a human that should not have,
or bypassed one that should have seen it.</p>

<div class="stats">
  <div class="stat"><b>${incidents.length}</b><span>incidents opened</span></div>
  <div class="stat"><b class="ok">${assigned.length}</b><span>assigned before SLA</span></div>
  <div class="stat"><b class="${unintended.length ? "bad" : "ok"}">${unintended.length}</b>
    <span>unintended escalations</span></div>
  <div class="stat"><b class="warnc">${intended.length}</b>
    <span>escalated by design (MANUAL)</span></div>
  ${median ? `<div class="stat"><b>${escapeHtml(median)}s</b><span>median time to assign</span></div>` : ""}
</div>

<div class="note">
  <b>Reading this:</b> "escalated by design" is not a failure. Security reports, P1s,
  VIP and strategic accounts, suspected prompt injection, and weak downward routes are
  MANUAL tier — never auto-applied. If no engineer acts on those, escalation is the correct
  and intended outcome. The number to watch is <b>unintended escalations</b>: incidents the
  system was allowed to handle and did not.
</div>

<div class="card">
  <table>
    <thead><tr>
      <th>Number</th><th>Short description</th><th>Priority</th>
      <th>Tier</th><th>Assignment group</th><th>State</th><th>Handled in</th>
    </tr></thead>
    <tbody>${
      incidents.length
        ? incidents.map((i) => row(i, tierOf.get(i.number) ?? null)).join("")
        : `<tr><td colspan="7" class="empty">No incidents yet — run <code>npm run demo</code>.</td></tr>`
    }</tbody>
  </table>
</div>

<p class="lede" style="margin-top:16px">
  Open any number to see the full incident: fields, the caller reply, and the work note
  carrying the reasoning and evidence behind the assignment.
</p>`;

  return page({ title: "Triage overview", active: "overview", body, live: true });
}

function row(incident: IncidentRow, tier: string | null): string {
  const seconds =
    incident.assignmentGroup && !incident.escalated
      ? `${((Date.parse(incident.sysUpdatedOn) - Date.parse(incident.openedAt)) / 1000).toFixed(1)}s`
      : incident.escalated
        ? `<span class="${tier === "MANUAL" ? "warnc" : "bad"}">breached</span>`
        : `<span class="clock" data-sla="${Date.parse(incident.slaDueAt)}"></span>`;

  return `<tr>
    <td><a class="num" href="/incident/${escapeHtml(incident.number)}">${escapeHtml(incident.number)}</a></td>
    <td>${escapeHtml(incident.shortDescription)}</td>
    <td><span class="chip" style="background:${PRIORITY_COLOUR[incident.priority] ?? "#555"}">${escapeHtml(PRIORITY_LABEL[incident.priority])}</span></td>
    <td>${tier ? `<span class="chip" style="background:${TIER_COLOUR[tier] ?? "#555"}">${escapeHtml(tier)}</span>` : `<span class="chip ghost">—</span>`}</td>
    <td>${escapeHtml(incident.assignmentGroup ?? "—")}</td>
    <td>${escapeHtml(STATE_LABEL[incident.state])}</td>
    <td>${seconds}</td>
  </tr>`;
}
