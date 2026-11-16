import { config } from "./config/index.js";
import { LiveServiceNow } from "./servicenow/live.js";
import { startAnchorWorker } from "./platform/ledger/anchor.js";
import { ServiceNowAdapter } from "./servicenow/adapter.js";
import { closePool, waitForDatabase } from "./platform/db/pool.js";
import { ticketRepository } from "./platform/db/repositories/ticket.repository.js";
import { catalogRepository } from "./platform/db/repositories/catalog.repository.js";
import { getTriageModel } from "./platform/llm/index.js";
import { loggerFor } from "./platform/logging/logger.js";
import { TriageOrchestrator } from "./orchestration/workflow.js";
import { WritebackService } from "./orchestration/writeback.js";
import { ServiceNowEnrichmentSources } from "./servicenow/enrichment-sources.js";
import { buildServer } from "./web/server.js";

const log = loggerFor("boot");

const adapter = new ServiceNowAdapter(config.http.simBaseUrl);
const live = config.serviceNow ? new LiveServiceNow(config.serviceNow) : undefined;
const enrichment = new ServiceNowEnrichmentSources(adapter, config.http.simBaseUrl);
const orchestrator = new TriageOrchestrator(
  new WritebackService(adapter),
  {
    enrichmentSources: live
      ? {
          fetchCustomerTier: (ticket) => Promise.resolve(ticket.customerTier),
          fetchRecentTicketCount: () =>
            Promise.reject(new Error("Caller history is not configured")),
          fetchOpenIncident: () => Promise.reject(new Error("Incident manager is not configured")),
        }
      : enrichment,
  },
  live ? (ticket, note) => live.writeInternalNote(ticket, note) : undefined,
);

await waitForDatabase();

// Fail fast at boot rather than on the first ticket: an empty catalog means
// there is no routing allow-list and nothing can be triaged safely.
const teams = await catalogRepository.activeTeamNames();
if (teams.length === 0) {
  log.fatal("service catalog is empty - run `npm run seed` first");
  process.exit(1);
}

const model = getTriageModel();
const pending = await ticketRepository.findPending();
const app = buildServer(orchestrator, live);
const stopAnchor = startAnchorWorker();

await app.listen({ port: config.http.triagePort, host: config.http.triageHost });
for (const ticket of pending) void orchestrator.start(ticket);

log.info(
  {
    port: config.http.triagePort,
    model: model.name,
    teams: teams.length,
    escalationWindowMs: config.deadlines.escalationWindowMs,
    autoCommitMarginMs: config.deadlines.autoCommitMarginMs,
  },
  `triage service listening - console at ${config.http.triageBaseUrl}`,
);

const shutdown = async () => {
  log.info("shutting down");
  orchestrator.stopAll();
  await app.close();
  await stopAnchor();
  await closePool();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
