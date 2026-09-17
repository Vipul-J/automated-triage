import Fastify from "fastify";
import { config } from "../config/index.js";
import { CUSTOMER_TIERS } from "../domain/types.js";
import { loggerFor } from "../infra/logging/logger.js";
import { SimulatorStore, signPayload, type SimTicket } from "./store.js";

const log = loggerFor("simulator");

const WEBHOOK_TIMEOUT_MS = 3_000;

/**
 * Stand-in for the production ticketing platform.
 *
 * It exists so the triage system can be built and exercised end to end - including
 * the escalation clock, which is the hardest thing to test against a live
 * platform - before a vendor is chosen. Swapping in the real thing means writing
 * one more TicketingAdapter; nothing inside the triage system changes.
 */
const store = new SimulatorStore(config.deadlines.escalationWindowMs, (ticket) => {
  log.warn({ ticketId: ticket.id, subject: ticket.subject }, "ESCALATED - nobody acted in time");
});

const app = Fastify({ logger: false });

app.post("/api/tickets", async (request, reply) => {
  const body = request.body as Record<string, unknown>;

  if (typeof body?.subject !== "string" || typeof body?.body !== "string") {
    return reply.code(400).send({ error: "subject and body are required strings" });
  }
  const tier = typeof body.customerTier === "string" ? body.customerTier : undefined;
  if (tier && !CUSTOMER_TIERS.includes(tier as never)) {
    return reply.code(400).send({ error: `customerTier must be one of ${CUSTOMER_TIERS.join(", ")}` });
  }

  const ticket = store.create({
    subject: body.subject,
    body: body.body,
    requester: typeof body.requester === "string" ? body.requester : undefined,
    customerTier: tier as SimTicket["customerTier"] | undefined,
  });

  log.info({ ticketId: ticket.id, deadlineAt: ticket.deadlineAt }, "ticket created, clock started");
  void deliverWebhook(ticket);

  return reply.code(201).send(ticket);
});

app.get("/api/tickets", async () => store.list());

app.get<{ Params: { id: string } }>("/api/tickets/:id", async (request, reply) => {
  const ticket = store.get(request.params.id);
  return ticket ? ticket : reply.code(404).send({ error: "not found" });
});

app.post<{ Params: { id: string } }>("/api/tickets/:id/assign", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  if (typeof body?.team !== "string") {
    return reply.code(400).send({ error: "team is required" });
  }

  const result = store.assign({
    id: request.params.id,
    team: body.team,
    level: typeof body.level === "string" ? body.level : "L2",
    priority: typeof body.priority === "string" ? body.priority : "P3",
    expectedVersion: request.headers["if-match"] as string | undefined,
    idempotencyKey: request.headers["idempotency-key"] as string | undefined,
  });

  if (result === "not-found") return reply.code(404).send({ error: "not found" });
  if (result === "conflict") {
    log.warn({ ticketId: request.params.id }, "assign rejected - ticket changed or already escalated");
    return reply.code(409).send({ error: "version conflict or ticket already escalated" });
  }

  log.info({ ticketId: result.id, team: result.assignedTeam }, "assigned - escalation cancelled");
  return result;
});

app.post<{ Params: { id: string } }>("/api/tickets/:id/comments", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  if (typeof body?.body !== "string") return reply.code(400).send({ error: "body is required" });

  const visibility = body.visibility === "internal" ? "internal" : "public";
  const ticket = store.comment(request.params.id, body.body, visibility);
  if (!ticket) return reply.code(404).send({ error: "not found" });

  log.info({ ticketId: ticket.id, visibility }, "comment added");
  return reply.code(201).send({ ok: true });
});

app.get("/health", async () => ({ ok: true, tickets: store.list().length }));

/**
 * Webhook delivery is fire-and-forget and signed, exactly as a real platform
 * does it - which is why the triage side needs both signature verification and a
 * reconciliation poller for the deliveries that silently fail.
 */
async function deliverWebhook(ticket: SimTicket): Promise<void> {
  const payload = JSON.stringify({ event: "ticket.created", ticket });
  const signature = signPayload(config.http.webhookSecret, payload);

  try {
    const response = await fetch(`${config.http.triageBaseUrl}/webhooks/ticketing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signature },
      body: payload,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    log.info({ ticketId: ticket.id, status: response.status }, "webhook delivered");
  } catch (err) {
    log.error({ err, ticketId: ticket.id }, "webhook delivery failed - reconciliation must catch it");
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
  { port: config.http.simPort, escalationWindowMs: config.deadlines.escalationWindowMs },
  "ticketing simulator listening",
);
