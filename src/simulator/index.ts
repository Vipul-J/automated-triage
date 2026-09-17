import Fastify from "fastify";
import { config } from "../config/index.js";
import type { ContactType, ImpactUrgency } from "../domain/servicenow.js";
import { loggerFor } from "../infra/logging/logger.js";
import { IncidentStore, signPayload, type StoredIncident } from "./store.js";

const log = loggerFor("servicenow-sim");

const WEBHOOK_TIMEOUT_MS = 3_000;

/**
 * Stand-in for a ServiceNow instance.
 *
 * Exposes the subset of the Table API the triage system uses, so the escalation
 * clock - the hardest thing to exercise against a live instance - can be tested
 * honestly. Swapping in the real instance means one more TicketingAdapter.
 */
const store = new IncidentStore(config.deadlines.escalationWindowMs, (incident) => {
  log.warn(
    { number: incident.number, shortDescription: incident.shortDescription },
    "SLA BREACHED - auto-escalated to Escalation-Queue",
  );
});

const app = Fastify({ logger: false });

app.post("/api/now/table/incident", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const shortDescription = body?.short_description;
  const description = body?.description;

  if (typeof shortDescription !== "string" || typeof description !== "string") {
    return reply.code(400).send({
      error: { message: "short_description and description are required" },
    });
  }

  const incident = store.create({
    shortDescription,
    description,
    callerId: typeof body.caller_id === "string" ? body.caller_id : undefined,
    callerEmail: typeof body.caller_email === "string" ? body.caller_email : undefined,
    contactType: typeof body.contact_type === "string" ? (body.contact_type as ContactType) : undefined,
    category: typeof body.category === "string" ? body.category : undefined,
    impact: typeof body.impact === "number" ? (body.impact as ImpactUrgency) : undefined,
    urgency: typeof body.urgency === "number" ? (body.urgency as ImpactUrgency) : undefined,
    callerTier: body.caller_tier === "vip" || body.caller_tier === "strategic"
      ? body.caller_tier
      : undefined,
  });

  log.info(
    { number: incident.number, priority: incident.priority, slaDueAt: incident.slaDueAt },
    "incident opened, SLA clock started",
  );
  void deliverWebhook(incident);

  return reply.code(201).send({ result: incident });
});

app.get("/api/now/table/incident", async () => ({ result: store.list() }));

app.get<{ Params: { number: string } }>("/api/now/table/incident/:number", async (request, reply) => {
  const incident = store.get(request.params.number);
  return incident ? { result: incident } : reply.code(404).send({ error: { message: "not found" } });
});

/** Assignment + derived priority in one write, as a ServiceNow update would be. */
app.patch<{ Params: { number: string } }>("/api/now/table/incident/:number", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  if (typeof body?.assignment_group !== "string") {
    return reply.code(400).send({ error: { message: "assignment_group is required" } });
  }

  const result = store.assign({
    number: request.params.number,
    assignmentGroup: body.assignment_group,
    assignedTo: typeof body.assigned_to === "string" ? body.assigned_to : null,
    impact: typeof body.impact === "number" ? (body.impact as ImpactUrgency) : 2,
    urgency: typeof body.urgency === "number" ? (body.urgency as ImpactUrgency) : 2,
    category: typeof body.category === "string" ? body.category : "inquiry",
    expectedVersion: request.headers["if-match"] as string | undefined,
    idempotencyKey: request.headers["idempotency-key"] as string | undefined,
    aiConfidence: typeof body.u_ai_confidence === "number" ? body.u_ai_confidence : null,
    aiTier: typeof body.u_ai_tier === "string" ? body.u_ai_tier : null,
    aiRunId: typeof body.u_ai_run_id === "string" ? body.u_ai_run_id : null,
  });

  if (result === "not-found") return reply.code(404).send({ error: { message: "not found" } });
  if (result === "conflict") {
    log.warn({ number: request.params.number }, "update rejected - stale version or already handled");
    return reply.code(409).send({ error: { message: "version conflict or already handled" } });
  }

  log.info(
    { number: result.number, assignmentGroup: result.assignmentGroup, priority: result.priority },
    "assigned - SLA clock stopped",
  );
  return { result };
});

/** Journal write: work_notes (internal) or comments (visible to the caller). */
app.post<{ Params: { number: string } }>("/api/now/table/incident/:number/journal", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  if (typeof body?.value !== "string") {
    return reply.code(400).send({ error: { message: "value is required" } });
  }

  const field = body.field === "work_notes" ? "work_notes" : "comments";
  const incident = store.addJournal(
    request.params.number, field, body.value,
    typeof body.created_by === "string" ? body.created_by : "system",
  );
  if (!incident) return reply.code(404).send({ error: { message: "not found" } });

  log.info({ number: incident.number, field }, "journal entry added");
  return reply.code(201).send({ result: { ok: true } });
});

app.get("/health", async () => ({ ok: true, incidents: store.list().length }));

async function deliverWebhook(incident: StoredIncident): Promise<void> {
  const payload = JSON.stringify({ event: "incident.inserted", incident });
  const signature = signPayload(config.http.webhookSecret, payload);

  try {
    const response = await fetch(`${config.http.triageBaseUrl}/webhooks/servicenow`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sn-signature": signature },
      body: payload,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    log.info({ number: incident.number, status: response.status }, "business rule fired webhook");
  } catch (err) {
    log.error({ err, number: incident.number }, "webhook delivery failed - reconciliation must catch it");
  }
}

const shutdown = async () => {
  store.stopAll();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.http.simPort, host: "0.0.0.0" });
log.info(
  { port: config.http.simPort, slaWindowMs: config.deadlines.escalationWindowMs },
  "ServiceNow simulator listening",
);
