import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LiveIncidentId, toLiveTicket, type LiveServiceNow } from "../servicenow/live.js";
import { listProofs, verifyProof } from "../platform/ledger/anchor.js";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { config } from "../config/index.js";
import { CUSTOMER_TIERS, type Level, type Ticket } from "../core/types.js";
import { catalogRepository } from "../platform/db/repositories/catalog.repository.js";
import { ticketRepository } from "../platform/db/repositories/ticket.repository.js";
import { loggerFor } from "../platform/logging/logger.js";
import { signPayload } from "../../tools/simulator/store.js";
import type { HumanDecision, TriageOrchestrator } from "../orchestration/workflow.js";
import { renderOverview, type IncidentRow } from "./views/overview.js";
import { renderQueue } from "./views/queue.js";
import { renderIncident, type IncidentDetail } from "./views/incident.js";

const log = loggerFor("server");

const SimWebhook = z.object({
  event: z.literal("incident.inserted"),
  incident: z.object({
    sysId: LiveIncidentId,
    number: z.string().regex(/^INC\d+$/i),
    shortDescription: z.string(),
    description: z.string(),
    callerId: z.string(),
    callerEmail: z.string(),
    callerTier: z.enum(CUSTOMER_TIERS),
    category: z.string(),
    contactType: z.string(),
    openedAt: z.iso.datetime(),
    slaDueAt: z.iso.datetime(),
    escalated: z.boolean(),
    priority: z.number().int().min(1).max(5).optional(),
  }),
});

/** Constant-time comparison: signature checks must not leak timing. */
function signatureMatches(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(
  orchestrator: TriageOrchestrator,
  live?: LiveServiceNow,
): FastifyInstance {
  const app = Fastify({ logger: false });

  // Fastify's own logger is off, so without this an unhandled error returns a
  // bare 500 with nothing written anywhere - the failure is invisible from both
  // ends. Log it with the route that produced it.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    log.error(
      { err: error, method: request.method, url: request.url },
      "unhandled error in request handler",
    );
    const status = error.statusCode ?? 500;
    reply.code(status).send({ error: status >= 500 ? "request failed" : error.message });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.consoleAuth ||
      request.routeOptions.url === "/health" ||
      request.routeOptions.url === "/webhooks/servicenow"
    )
      return;
    const value = request.headers.authorization;
    if (!signatureMatches(`Basic ${config.consoleAuth}`, value)) {
      return reply
        .header("WWW-Authenticate", 'Basic realm="Triage console"')
        .code(401)
        .send({ error: "authentication required" });
    }
  });

  async function ingest(ticket: Ticket, raw: unknown): Promise<boolean> {
    if (!(await ticketRepository.insertIfAbsent(ticket, raw))) return false;
    void orchestrator.start(ticket);
    return true;
  }

  // Raw body is needed to verify the signature over exactly what was sent.
  // The raw body is kept alongside the parsed one so the HMAC can be verified
  // over exactly the bytes that were sent, not over a re-serialised object.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      const raw = body as string;
      done(null, { raw, parsed: JSON.parse(raw) as unknown });
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
    const body = request.body as { raw: string; parsed: unknown } | undefined;
    if (!body) return reply.code(400).send({ error: "JSON body required" });
    if (live && config.serviceNow) {
      if (
        !signatureMatches(`Bearer ${config.serviceNow.webhookToken}`, request.headers.authorization)
      ) {
        return reply.code(401).send({ error: "invalid webhook token" });
      }
      const payload = z.object({ sys_id: LiveIncidentId }).safeParse(body.parsed);
      if (!payload.success) return reply.code(400).send({ error: "valid sys_id required" });
      const incident = await live.read(payload.data.sys_id);
      if (!incident) return reply.code(404).send({ error: "incident not found" });
      const ticket = toLiveTicket(incident);
      if (
        ticket.status !== "new" ||
        incident.assignmentGroup ||
        incident.assignedTo ||
        ticket.deadlineAt.getTime() <= Date.now()
      )
        return reply.code(202).send({ status: "ineligible" });
      const accepted = await ingest(ticket, { source: "servicenow", sysId: ticket.sysId });
      return reply.code(accepted ? 202 : 200).send({ status: accepted ? "accepted" : "duplicate" });
    }

    const expected = signPayload(config.http.webhookSecret, body.raw);
    const supplied = request.headers["x-sn-signature"];
    if (!signatureMatches(expected, typeof supplied === "string" ? supplied : undefined)) {
      return reply.code(401).send({ error: "invalid signature" });
    }
    const parsed = SimWebhook.safeParse(body.parsed);
    if (!parsed.success) return reply.code(400).send({ error: "invalid simulator event" });
    const payload = parsed.data.incident;
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
      priority: payload.priority,
    };

    const accepted = await ingest(ticket, payload);
    return reply.code(accepted ? 202 : 200).send({ status: accepted ? "accepted" : "duplicate" });
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
    if (live) return renderOverview([], orchestrator.list(), true);
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
    const number = request.params.number;
    if (!/^INC\d+$/i.test(number)) return reply.code(404).send({ error: "incident not found" });

    let incident: IncidentDetail | null;
    if (live) {
      const ticket = await ticketRepository.findById(number);
      incident = ticket ? await live.read(ticket.sysId) : null;
    } else {
      const response = await fetch(`${config.http.simBaseUrl}/api/now/table/incident/${number}`, {
        signal: AbortSignal.timeout(4_000),
      });
      incident = response.ok
        ? ((await response.json()) as { result: IncidentDetail }).result
        : null;
    }
    if (!incident) return reply.code(404).send({ error: "incident not found" });
    reply.type("text/html; charset=utf-8");
    return renderIncident(
      incident,
      orchestrator.get(number),
      await listProofs(number),
      Boolean(live),
    );
  });

  /** Server-sent events: the console re-renders when any workflow changes state. */
  const eventStreams = new Set<import("node:http").ServerResponse>();
  app.addHook("preClose", (done) => {
    for (const stream of eventStreams) stream.end();
    done();
  });
  app.get("/events", (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    eventStreams.add(reply.raw);
    reply.raw.write(": connected\n\n");
    const onChange = () => reply.raw.write(`data: change\n\n`);
    orchestrator.on("change", onChange);
    reply.raw.on("close", () => {
      eventStreams.delete(reply.raw);
      orchestrator.off("change", onChange);
    });
  });

  app.post<{ Params: { id: string } }>("/api/incidents/:id/decision", async (request, reply) => {
    const { parsed } = (request.body ?? {}) as { parsed?: Record<string, unknown> };
    if (!parsed || !/^INC\d+$/i.test(request.params.id)) {
      return reply.code(400).send({ error: "invalid decision request" });
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "cross-site decision rejected" });
    }
    const action = parsed.action;

    if (
      action !== "approve" &&
      action !== "approve_with_edit" &&
      action !== "reroute" &&
      action !== "escalate"
    ) {
      return reply.code(400).send({ error: "unknown action" });
    }

    // A reroute names a team, so it is re-validated against the live catalog.
    // The console is untrusted input like anything else.
    let team: string | undefined;
    let level: Level | undefined;
    if (action !== "escalate") {
      const recommendation = orchestrator.get(request.params.id)?.result?.recommendation;
      const requestedTeam = action === "reroute" ? parsed.team : recommendation?.recommendedTeam;
      const entry =
        typeof requestedTeam === "string"
          ? await catalogRepository.findByTeam(requestedTeam)
          : undefined;
      if (!entry) return reply.code(400).send({ error: "select a team from the active catalog" });
      team = entry.team;
      level = entry.level;
    }

    const decision: HumanDecision = {
      action,
      actor: process.env.CONSOLE_USER ?? (parsed.actorRole === "L2" ? "l2.demo" : "l1.demo"),
      actorRole: parsed.actorRole === "L2" ? "L2" : "L1",
      ...(team ? { team } : {}),
      ...(level ? { level } : {}),
      ...(typeof parsed.clientResponse === "string"
        ? { clientResponse: parsed.clientResponse.slice(0, 4000) }
        : {}),
    };

    const delivered = orchestrator.submitDecision(request.params.id, decision);
    if (!delivered) {
      return reply.code(409).send({ error: "no workflow is awaiting a decision for this ticket" });
    }

    log.info({ ticketId: request.params.id, action, actor: decision.actor }, "decision submitted");
    return { status: "accepted" };
  });

  app.get<{ Params: { id: string; approval: string } }>(
    "/api/incidents/:id/proofs/:approval",
    async (request, reply) => {
      const { id, approval } = request.params;
      if (!/^INC\d+$/i.test(id) || !/^[1-9]\d{0,8}$/.test(approval))
        return reply.code(400).send({ error: "invalid proof id" });
      return (
        (await verifyProof(id, Number(approval))) ??
        reply.code(404).send({ error: "proof not found" })
      );
    },
  );

  app.get("/health", async () => ({ ok: true, workflows: orchestrator.list().length }));

  return app;
}
