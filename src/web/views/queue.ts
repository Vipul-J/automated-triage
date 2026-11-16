import {
  PRIORITY_LABEL,
  severityToImpactUrgency,
  derivePriority,
} from "../../servicenow/incident.js";
import type { WorkflowRecord } from "../../orchestration/workflow.js";
import { escapeHtml, page, PRIORITY_COLOUR, TIER_COLOUR } from "./layout.js";

type Role = "L1" | "L2";

const ROLE_COPY: Record<Role, { title: string; lede: string; tiers: string }> = {
  L1: {
    title: "L1 queue",
    lede: "Use the evidence and investigation steps to choose a route. Unattended tickets follow the ticketing platform’s escalation policy.",
    tiers: "AUTO · REVIEW · ASSIST",
  },
  L2: {
    title: "L2 queue",
    lede:
      "The hard tail only: P1s, VIP and strategic accounts, security reports, suspected " +
      "prompt injection, and downward routes that did not clear the higher L1 bar. " +
      "Nothing here is ever auto-applied — if nobody acts, it escalates, which is correct.",
    tiers: "MANUAL",
  },
};

export function renderQueue(role: Role, records: readonly WorkflowRecord[]): string {
  const mine = records.filter((r) => r.result?.decision.owner === role);
  const waiting = mine.filter((r) => r.state === "awaiting_review");
  const done = mine.filter((r) => r.state !== "awaiting_review");
  const copy = ROLE_COPY[role];

  const body = `
<h1>${copy.title}</h1>
<p class="lede">${escapeHtml(copy.lede)}</p>
<div class="note"><b>Tiers routed here:</b> ${copy.tiers}</div>
${waiting.length ? waiting.map((r) => card(r, role)).join("") : `<p class="empty">Nothing awaiting review.</p>`}
${done.length ? `<h1 style="margin-top:28px;font-size:16px">Already handled</h1>${done.map(handled).join("")}` : ""}`;

  return page({
    title: `${copy.title} — AI Triage`,
    active: role === "L1" ? "l1" : "l2",
    body,
    live: true,
  });
}

function card(record: WorkflowRecord, role: Role): string {
  const result = record.result;
  if (!result) {
    return `<div class="card pad"><div class="row"><span class="num">${escapeHtml(record.ticketId)}</span>
      <span class="chip ghost">analysing…</span></div></div>`;
  }

  const { recommendation: rec, confidence, decision, ticket } = result;
  const { impact, urgency } = severityToImpactUrgency(rec.severity);
  const priority = derivePriority(impact, urgency);

  const evidence = result.evidence
    .filter((e) => e.kind === "ticket" && e.resolvedTeam)
    .slice(0, 3)
    .map((e) => `<li>${escapeHtml(e.title)} → <b>${escapeHtml(e.resolvedTeam!)}</b></li>`)
    .join("");

  const alternatives = rec.alternatives
    .map(
      (item) =>
        `<button data-team="${escapeHtml(item.team)}" title="${escapeHtml(item.why)}" onclick="decide(this.closest('.card').dataset.ticket,'reroute',this.dataset.team)">→ ${escapeHtml(item.team)}</button>`,
    )
    .join("");
  const sources = result.evidence
    .filter((item) => item.kind === "runbook")
    .slice(0, 3)
    .map(
      (item) =>
        `<li>${escapeHtml(item.id)} · ${escapeHtml(item.title)}<details><summary>View excerpt</summary><p>${escapeHtml(item.content.slice(0, 640))}</p></details></li>`,
    )
    .join("");
  const steps = (rec.investigationSteps ?? [])
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join("");
  // ASSIST makes no routing claim, so the primary action is explicitly a choice,
  // not a rubber stamp.
  const primary = decision.ackOnly
    ? `<button class="go" onclick="decide('${escapeHtml(record.ticketId)}','approve')">Confirm route → ${escapeHtml(rec.recommendedTeam)}</button>`
    : `<button class="go" onclick="decide('${escapeHtml(record.ticketId)}','approve')">Approve → ${escapeHtml(rec.recommendedTeam)}</button>`;

  return `<div class="card" id="c-${escapeHtml(record.ticketId)}" data-ticket="${escapeHtml(record.ticketId)}" data-actor="${role === "L1" ? "l1.engineer" : "l2.engineer"}" data-role="${role}">
<div class="pad">
  <div class="row">
    <a class="num" href="/incident/${escapeHtml(record.ticketId)}">${escapeHtml(record.ticketId)}</a>
    <span class="chip" style="background:${TIER_COLOUR[decision.tier] ?? "#555"}">${escapeHtml(decision.tier)}</span>
    <span class="chip" style="background:${PRIORITY_COLOUR[priority] ?? "#555"}">${escapeHtml(PRIORITY_LABEL[priority])}</span>
    ${ticket.customerTier !== "standard" ? `<span class="chip" style="background:#7c3aed">${escapeHtml(ticket.customerTier.toUpperCase())}</span>` : ""}
    <span class="chip ghost">${result.usedMockLlm ? "Deterministic model" : "Live model"}</span>
    <span class="clock" data-sla="${record.deadlineAt.getTime()}"></span>
  </div>

  <div class="sd">${escapeHtml(ticket.subject)}</div>
  <div style="color:var(--muted);font-size:12px">${escapeHtml(ticket.requester)} · ${escapeHtml(ticket.requesterEmail)}</div>

  <div class="why">
    <b>Route to ${escapeHtml(rec.recommendedTeam)}</b> — ${escapeHtml(rec.rationale)}<br>
    <span style="color:var(--muted)">Confidence: ${escapeHtml(confidence.note)}</span><br>
    <span style="color:var(--muted)">Tier because: ${escapeHtml(decision.reasons.join("; "))}</span>
  </div>

  ${evidence ? `<details open><summary style="cursor:pointer;color:var(--muted);font-size:12px">Evidence — similar resolved incidents</summary><ul style="font-size:13px;color:var(--muted);margin:6px 0 0">${evidence}</ul></details>` : ""}

  ${sources ? `<details><summary>Runbooks</summary><ul>${sources}</ul></details>` : ""}
  ${steps ? `<div><b>Suggested checks</b><ol>${steps}</ol></div>` : ""}
  ${rec.missingInformation.length ? `<p class="note">What would help: ${escapeHtml(rec.missingInformation.join("; "))}</p>` : ""}
  <div style="margin-top:12px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Customer response draft</div>
  <textarea>${escapeHtml(rec.clientResponse)}</textarea>

  <div class="acts">
    ${primary}
    ${alternatives}
    <button onclick="decide('${escapeHtml(record.ticketId)}','escalate')">Escalate now</button>
  </div>
</div></div>`;
}

function handled(record: WorkflowRecord): string {
  const group = record.result?.recommendation.recommendedTeam ?? "—";
  return `<div class="card pad" style="opacity:.62">
  <div class="row">
    <a class="num" href="/incident/${escapeHtml(record.ticketId)}">${escapeHtml(record.ticketId)}</a>
    <span class="chip ghost">${escapeHtml(record.state)}</span>
    <span style="color:var(--muted);font-size:13px">${escapeHtml(record.outcome ?? group)}</span>
  </div></div>`;
}
