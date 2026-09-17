import {
  IMPACT_URGENCY_LABEL, PRIORITY_LABEL, STATE_LABEL,
  type ImpactUrgency, type IncidentState, type JournalEntry, type Priority,
} from "../../domain/servicenow.js";
import type { WorkflowRecord } from "../../orchestrator/workflow.js";
import { escapeHtml, page, PRIORITY_COLOUR, TIER_COLOUR } from "./layout.js";

export interface IncidentDetail {
  number: string;
  shortDescription: string;
  description: string;
  callerId: string;
  callerEmail: string;
  callerTier: string;
  contactType: string;
  category: string;
  impact: ImpactUrgency;
  urgency: ImpactUrgency;
  priority: Priority;
  state: IncidentState;
  assignmentGroup: string | null;
  assignedTo: string | null;
  openedAt: string;
  sysUpdatedOn: string;
  slaDueAt: string;
  escalated: boolean;
  escalatedAt: string | null;
  journal: JournalEntry[];
  aiTriaged: boolean;
  aiConfidence: number | null;
  aiTier: string | null;
  aiRunId: string | null;
}

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-GB", { hour12: false });

const field = (label: string, value: string): string =>
  `<div class="f"><span>${escapeHtml(label)}</span>${escapeHtml(value)}</div>`;

/**
 * The incident form as an engineer sees it after triage has run.
 *
 * The point of this view is the outcome banner and the activity stream: what the
 * system did, when, and on what evidence. An assignment nobody can audit is not
 * a decision, it is a guess with a timestamp.
 */
export function renderIncident(
  incident: IncidentDetail,
  record: WorkflowRecord | undefined,
): string {
  const openedMs = Date.parse(incident.openedAt);
  const handledMs = incident.assignmentGroup && !incident.escalated
    ? Date.parse(incident.sysUpdatedOn)
    : null;
  const secondsToHandle = handledMs ? ((handledMs - openedMs) / 1000).toFixed(1) : null;
  const windowSeconds = ((Date.parse(incident.slaDueAt) - openedMs) / 1000).toFixed(0);

  const banner = incident.escalated
    ? `<div class="card pad" style="border-left:3px solid #b91c1c">
         <b class="bad">SLA breached — escalated</b><br>
         <span style="color:var(--muted);font-size:13px">
           Nobody acted within the ${escapeHtml(windowSeconds)}s window.
           ${record?.result?.decision.tier === "MANUAL"
             ? "This incident was MANUAL tier, so escalation is the intended outcome — it was never eligible for automatic assignment."
             : "This is the failure case the system exists to prevent."}
         </span></div>`
    : incident.assignmentGroup
      ? `<div class="card pad" style="border-left:3px solid #15803d">
           <b class="ok">Assigned in ${escapeHtml(secondsToHandle ?? "?")}s — escalation avoided</b><br>
           <span style="color:var(--muted);font-size:13px">
             Routed to <b>${escapeHtml(incident.assignmentGroup)}</b> with
             ${escapeHtml(String(windowSeconds))}s of SLA window available.
             The caller has a reply and the receiving group has the reasoning.
           </span></div>`
      : `<div class="card pad" style="border-left:3px solid #b45309">
           <b class="warnc">Awaiting review</b>
           <span class="clock" data-sla="${Date.parse(incident.slaDueAt)}"></span></div>`;

  const aiBlock = incident.aiTriaged
    ? `<div class="row" style="margin-top:12px">
         <span class="chip" style="background:${TIER_COLOUR[incident.aiTier ?? ""] ?? "#555"}">${escapeHtml(incident.aiTier ?? "")}</span>
         <span class="chip ghost">confidence ${incident.aiConfidence?.toFixed(2) ?? "—"}</span>
         <span class="chip ghost">run ${escapeHtml((incident.aiRunId ?? "").slice(0, 8))}</span>
       </div>`
    : "";

  const body = `
<div class="row" style="margin-bottom:10px">
  <h1 style="margin:0">${escapeHtml(incident.number)}</h1>
  <span class="chip" style="background:${PRIORITY_COLOUR[incident.priority] ?? "#555"}">${escapeHtml(PRIORITY_LABEL[incident.priority])}</span>
  <span class="chip ghost">${escapeHtml(STATE_LABEL[incident.state])}</span>
</div>
<p class="lede">${escapeHtml(incident.shortDescription)}</p>

${banner}

<div class="card pad">
  <div class="grid">
    ${field("Caller", `${incident.callerId} (${incident.callerTier})`)}
    ${field("Email", incident.callerEmail)}
    ${field("Contact type", incident.contactType)}
    ${field("Category", incident.category)}
    ${field("Impact", IMPACT_URGENCY_LABEL[incident.impact])}
    ${field("Urgency", IMPACT_URGENCY_LABEL[incident.urgency])}
    ${field("Priority", `${PRIORITY_LABEL[incident.priority]} (derived)`)}
    ${field("Assignment group", incident.assignmentGroup ?? "— unassigned —")}
    ${field("Assigned to", incident.assignedTo ?? "—")}
    ${field("Opened", time(incident.openedAt))}
    ${field("SLA due", time(incident.slaDueAt))}
    ${field("Updated", time(incident.sysUpdatedOn))}
  </div>
  ${aiBlock}
</div>

<div class="card pad">
  <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Description</div>
  <div style="margin-top:6px;white-space:pre-wrap">${escapeHtml(incident.description)}</div>
</div>

<h1 style="font-size:16px;margin:22px 0 8px">Activity</h1>
<div class="card pad">
  ${incident.journal.map(journalEntry).join("") || `<p class="empty">No activity.</p>`}
</div>

<p style="margin-top:18px"><a class="num" href="/">← back to overview</a></p>`;

  return page({
    title: `${incident.number} — AI Triage`,
    active: "incident",
    body,
    live: !incident.assignmentGroup && !incident.escalated,
  });
}

function journalEntry(entry: JournalEntry): string {
  const isWork = entry.field === "work_notes";
  return `<div class="j ${isWork ? "work" : "cmt"}">
    <div class="meta">${isWork ? "Work notes (internal)" : "Additional comments (caller visible)"} ·
      ${escapeHtml(entry.createdBy)} · ${escapeHtml(time(entry.createdOn))}</div>
    <pre>${escapeHtml(entry.value)}</pre>
  </div>`;
}
