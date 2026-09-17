import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { config } from "../config/index.js";
import { LEVELS, type CustomerTier, type Level, type Ticket } from "../domain/types.js";
import { catalogRepository } from "../infra/db/repositories/catalog.repository.js";
import { auditRepository } from "../infra/db/repositories/audit.repository.js";
import { ticketRepository } from "../infra/db/repositories/ticket.repository.js";
import { loggerFor } from "../infra/logging/logger.js";
import { signPayload } from "../simulator/store.js";
import type { HumanDecision, TriageOrchestrator } from "../orchestrator/workflow.js";
import { renderOverview, type IncidentRow } from "./views/overview.js";
import { renderQueue } from "./views/queue.js";
import { renderIncident, type IncidentDetail } from "./views/incident.js";

const log = loggerFor("server");

interface IncidentInsertedWebhook {
  event: string;
  incident: {
    sysId: string; number: string; shortDescription: string; description: string;
    callerId: string; callerEmail: string; callerTier: CustomerTier;
    category: string; contactType: string; openedAt: string; slaDueAt: string;
    escalated: boolean;
  };
}

/** Constant-time comparison: signature checks must not leak timing. */
function signatureMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(orchestrator: TriageOrchestrator): FastifyInstance {
  const app = Fastify({ logger: false });

  // Fastify's own logger is off, so without this an unhandled error returns a
  // bare 500 with nothing written anywhere - the failure is invisible from both
  // ends. Log it with the route that produced it.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    log.error(
      { err: error, method: request.method, url: request.url },
      "unhandled error in request handler",
    );
    reply.code(error.statusCode ?? 500).send({ error: error.message });
  });

  // Raw body is needed to verify the signature over exactly what was sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, { raw: body as string, parsed: JSON.parse(body as string) });
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /**
   * Ingestion gateway. Verifies the signature, enforces idempotency, and returns
   * fast - a slow gateway makes the platform retry, which causes duplicate work.
   * Triage runs detached from the HTTP response.
   */
  app.post("/webhooks/servicenow", async (request, reply) => {
    const { raw, parsed } = request.body as { raw: string; parsed: IncidentInsertedWebhook };

    const expected = signPayload(config.http.webhookSecret, raw);
    if (!signatureMatches(expected, request.headers["x-sn-signature"] as string | undefined)) {
      log.warn("rejected webhook with bad signature");
      return reply.code(401).send({ error: "invalid signature" });
    }
    if (parsed.event !== "incident.inserted") return reply.code(202).send({ ignored: parsed.event });

    const payload = parsed.incident;
    const ticket: Ticket = {
      id: payload.number,
      sysId: payload.sysId,
      subject: payload.shortDescription,
      body: payload.description,
      requester: payload.callerId,
      requesterEmail: payload.callerEmail,
      customerTier: payload.callerTier,
      category: payload.category,
      contactType: payload.contactType,
      createdAt: new Date(payload.openedAt),
      // Deadlines are derived from the incident's own timestamps, never from
      // when we happened to receive the webhook.
      deadlineAt: new Date(payload.slaDueAt),
      status: payload.escalated ? "escalated" : "new",
    };

    const isNew = await ticketRepository.insertIfAbsent(ticket, payload);
    if (!isNew) {
      log.info({ ticketId: ticket.id }, "duplicate delivery ignored");
      return reply.code(200).send({ status: "duplicate" });
    }

    await auditRepository.record(ticket.id, "incident.received", { slaDueAt: payload.slaDueAt });
    void orchestrator.start(ticket);

    return reply.code(202).send({ status: "accepted" });
  });

  /** Reads the incident table directly for the read-only views. */
  const fetchIncidents = async (): Promise<IncidentRow[]> => {
    const response = await fetch(`${config.http.simBaseUrl}/api/now/table/incident`, {
      signal: AbortSignal.timeout(4_000),
    });
    const { result } = (await response.json()) as { result: IncidentRow[] };
    return result;
  };

  app.get("/", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    try {
      return renderOverview(await fetchIncidents(), orchestrator.list());
    } catch {
      return renderOverview([], orchestrator.list());
    }
  });

  app.get("/l1", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderQueue("L1", orchestrator.list());
  });

  app.get("/l2", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderQueue("L2", orchestrator.list());
  });

  app.get<{ Params: { number: string } }>("/incident/:number", async (request, reply) => {
    const response = await fetch(
      `${config.http.simBaseUrl}/api/now/table/incident/${request.params.number}`,
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!response.ok) return reply.code(404).send({ error: "incident not found" });

    const { result } = (await response.json()) as { result: IncidentDetail };
    reply.type("text/html; charset=utf-8");
    return renderIncident(result, orchestrator.get(request.params.number));
  });

  /** Server-sent events: the console re-renders when any workflow changes state. */
  app.get("/events", (_request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const onChange = () => reply.raw.write(`data: change\n\n`);
    orchestrator.on("change", onChange);
    reply.raw.on("close", () => orchestrator.off("change", onChange));
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/decision", async (request, reply) => {
    const { parsed } = request.body as { parsed: Record<string, unknown> };
    const action = parsed?.action;

    if (action !== "approve" && action !== "approve_with_edit" && action !== "reroute" && action !== "escalate") {
      return reply.code(400).send({ error: "unknown action" });
    }

    // A reroute names a team, so it is re-validated against the live catalog.
    // The console is untrusted input like anything else.
    let team: string | undefined;
    let level: Level | undefined;
    if (typeof parsed.team === "string") {
      const entry = await catalogRepository.findByTeam(parsed.team);
      if (!entry) return reply.code(400).send({ error: `unknown team '${parsed.team}'` });
      team = entry.team;
      level = LEVELS.includes(parsed.level as Level) ? (parsed.level as Level) : entry.level;
    }

    const decision: HumanDecision = {
      action,
      actor: typeof parsed.actor === "string" ? parsed.actor : "unknown",
      actorRole: parsed.actorRole === "L2" ? "L2" : "L1",
      ...(team ? { team } : {}),
      ...(level ? { level } : {}),
      ...(typeof parsed.clientResponse === "string" ? { clientResponse: parsed.clientResponse } : {}),
    };

    const delivered = orchestrator.submitDecision(request.params.id, decision);
    if (!delivered) {
      return reply.code(409).send({ error: "no workflow is awaiting a decision for this ticket" });
    }

    log.info({ ticketId: request.params.id, action, actor: decision.actor }, "decision submitted");
    return { status: "accepted" };
  });

  app.get("/health", async () => ({ ok: true, workflows: orchestrator.list().length }));

  return app;
}
