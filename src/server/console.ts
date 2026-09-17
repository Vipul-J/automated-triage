import type { WorkflowRecord } from "../orchestrator/workflow.js";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const TIER_COLOURS: Record<string, string> = {
  AUTO: "#0f7b3d", REVIEW: "#8a5a00", ASSIST: "#8a2f00", MANUAL: "#8a0f2f",
};

/**
 * The reviewer has roughly two minutes and is probably handling several tickets,
 * so the interface is as much of an engineering problem as the pipeline.
 *
 * What that dictates here: the countdown is the most prominent element, the
 * recommendation reads as one sentence, evidence is visible without a click, and
 * alternatives are one-click buttons so a reroute costs no thinking. Confidence
 * is shown as reasoning, never as a bare number - "0.78" means nothing at 2am.
 */
export function renderConsole(records: readonly WorkflowRecord[]): string {
  const cards = records.length
    ? records.map(renderCard).join("\n")
    : `<p class="empty">No tickets yet. Create one with <code>npm run demo</code>.</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Triage review console</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfa; --fg:#1a1a18; --muted:#6b6b66;
          --line:#e3e3df; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16161a; --fg:#ececea; --muted:#9a9a95; --line:#2c2c32; --card:#1e1e23; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg);
         font:14px/1.55 ui-sans-serif,-apple-system,system-ui,sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 20px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
          padding:16px; margin-bottom:14px; }
  .top { display:flex; gap:12px; align-items:baseline; flex-wrap:wrap; }
  .id { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted); }
  .tier { font-size:11px; font-weight:650; letter-spacing:.04em; padding:2px 7px;
          border-radius:4px; color:#fff; }
  .clock { margin-left:auto; font-variant-numeric:tabular-nums; font-weight:650; }
  .clock.warn { color:#b4690e; } .clock.crit { color:#c0392b; }
  .headline { font-size:16px; font-weight:620; margin:10px 0 2px; }
  .subject { color:var(--muted); margin-bottom:10px; }
  .why { border-left:3px solid var(--line); padding-left:10px; margin:10px 0; }
  .why b { font-weight:620; }
  details { margin:8px 0; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
  ul.ev { margin:6px 0 0; padding-left:18px; color:var(--muted); font-size:13px; }
  textarea { width:100%; min-height:82px; padding:9px; border:1px solid var(--line);
             border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; resize:vertical; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  button { font:inherit; padding:7px 13px; border-radius:6px; border:1px solid var(--line);
           background:var(--card); color:var(--fg); cursor:pointer; }
  button.primary { background:#1a6b3c; border-color:#1a6b3c; color:#fff; font-weight:600; }
  button.alt { font-size:13px; }
  .state { color:var(--muted); font-size:13px; margin-top:8px; }
  .done { opacity:.62; }
  .empty { color:var(--muted); }
  code { font-family:ui-monospace,monospace; font-size:12px; }
</style></head>
<body><div class="wrap">
<h1>Triage review console</h1>
<p class="sub">L1 owns AUTO, REVIEW and ASSIST. L2 sees the MANUAL tail. The clock is the product.</p>
${cards}
</div>
<script>
  // The countdown runs client-side so it stays smooth; SSE pushes state changes.
  function tick() {
    for (const el of document.querySelectorAll("[data-deadline]")) {
      const left = Math.max(0, Math.floor((+el.dataset.deadline - Date.now()) / 1000));
      el.textContent = left > 0
        ? Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") + " to escalation"
        : "escalated";
      el.classList.toggle("warn", left <= 90 && left > 30);
      el.classList.toggle("crit", left <= 30);
    }
  }
  setInterval(tick, 1000); tick();

  async function act(ticketId, action, team, level) {
    const card = document.getElementById("card-" + ticketId);
    const body = {
      action, actor: "l1.engineer", actorRole: "L1",
      clientResponse: card?.querySelector("textarea")?.value,
    };
    if (team) { body.team = team; body.level = level; }
    await fetch("/api/tickets/" + ticketId + "/decision", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  new EventSource("/events").onmessage = () => location.reload();
</script></body></html>`;
}

function renderCard(record: WorkflowRecord): string {
  const { result } = record;
  const clock = `<span class="clock" data-deadline="${record.deadlineAt.getTime()}"></span>`;

  if (!result) {
    return `<div class="card"><div class="top"><span class="id">${escapeHtml(record.ticketId)}</span>
      <span class="state">analysing…</span>${clock}</div></div>`;
  }

  const { recommendation: rec, confidence, decision } = result;
  const awaiting = record.state === "awaiting_review";
  const colour = TIER_COLOURS[decision.tier] ?? "#555";

  const evidence = result.evidence
    .filter((e) => e.kind === "ticket" && e.resolvedTeam)
    .slice(0, 3)
    .map((e) => `<li>${escapeHtml(e.title)} → resolved by <b>${escapeHtml(e.resolvedTeam!)}</b></li>`)
    .join("");

  const alternatives = rec.alternatives
    .map(
      (a) =>
        `<button class="alt" onclick="act('${record.ticketId}','reroute','${escapeHtml(a.team)}','${
          escapeHtml(levelOf(a.team))
        }')">→ ${escapeHtml(a.team)}</button>`,
    )
    .join("");

  const controls = awaiting
    ? `<textarea>${escapeHtml(rec.clientResponse)}</textarea>
       <div class="actions">
         <button class="primary" onclick="act('${record.ticketId}','approve')">Approve → ${escapeHtml(rec.recommendedTeam)}</button>
         ${alternatives}
         <button onclick="act('${record.ticketId}','escalate')">Escalate now</button>
       </div>`
    : `<div class="state">${escapeHtml(record.state)}${record.outcome ? " — " + escapeHtml(record.outcome) : ""}</div>`;

  return `<div class="card ${awaiting ? "" : "done"}" id="card-${escapeHtml(record.ticketId)}">
  <div class="top">
    <span class="id">${escapeHtml(record.ticketId)}</span>
    <span class="tier" style="background:${colour}">${escapeHtml(decision.tier)} · ${escapeHtml(decision.owner)}</span>
    ${clock}
  </div>
  <div class="headline">${escapeHtml(rec.recommendedTeam)} · ${escapeHtml(rec.severity)} · ${escapeHtml(rec.summary)}</div>
  <div class="subject">${escapeHtml(result.ticket.subject)}</div>
  <div class="why"><b>Why:</b> ${escapeHtml(rec.rationale)}<br>
    <b>Confidence:</b> ${escapeHtml(confidence.note)}</div>
  ${evidence ? `<details open><summary>Evidence</summary><ul class="ev">${evidence}</ul></details>` : ""}
  ${controls}
</div>`;
}

// The console only ever offers teams the model already proposed, and every
// action is re-validated against the live catalog server-side before it applies.
function levelOf(team: string): string {
  const match = /-(L[123])$/.exec(team);
  return match?.[1] ?? "L2";
}
