import { config } from "./config/index.js";
import { ServiceNowAdapter } from "./adapters/ticketing/servicenow.adapter.js";
import { closePool, waitForDatabase } from "./infra/db/pool.js";
import { catalogRepository } from "./infra/db/repositories/catalog.repository.js";
import { getTriageModel } from "./infra/llm/index.js";
import { loggerFor } from "./infra/logging/logger.js";
import { TriageOrchestrator } from "./orchestrator/workflow.js";
import { WritebackService } from "./orchestrator/writeback.js";
import { ServiceNowEnrichmentSources } from "./pipeline/enrichment-sources.js";
import { buildServer } from "./server/app.js";

const log = loggerFor("boot");

const adapter = new ServiceNowAdapter(config.http.simBaseUrl);
const orchestrator = new TriageOrchestrator(new WritebackService(adapter), {
  enrichmentSources: new ServiceNowEnrichmentSources(adapter, config.http.simBaseUrl),
});

await waitForDatabase();

// Fail fast at boot rather than on the first ticket: an empty catalog means
// there is no routing allow-list and nothing can be triaged safely.
const teams = await catalogRepository.activeTeamNames();
if (teams.length === 0) {
  log.fatal("service catalog is empty - run `npm run seed` first");
  process.exit(1);
}

const model = getTriageModel();
const app = buildServer(orchestrator);

await app.listen({ port: config.http.triagePort, host: "0.0.0.0" });

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
  await closePool();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
