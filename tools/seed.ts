import { migrate } from "../src/platform/db/migrate.js";
import { closePool } from "../src/platform/db/pool.js";
import { loggerFor } from "../src/platform/logging/logger.js";
import { catalogRepository } from "../src/platform/db/repositories/catalog.repository.js";
import { knowledgeRepository } from "../src/platform/db/repositories/knowledge.repository.js";
import {
  loadCatalog,
  loadHistoricalTickets,
  loadResponseTemplates,
  loadRunbooks,
} from "../src/platform/seed-data/loader.js";
import type { KnowledgeDoc } from "../src/core/types.js";

const log = loggerFor("seed");

async function seed(): Promise<void> {
  await migrate();

  const [catalog, historical, runbooks, templates] = await Promise.all([
    loadCatalog(),
    loadHistoricalTickets(),
    loadRunbooks(),
    loadResponseTemplates(),
  ]);

  // Referential check the JSON files cannot express on their own: every
  // historical ticket and runbook must point at a team that still exists.
  const activeTeams = new Set(catalog.filter((c) => c.active).map((c) => c.team));
  const orphans = [
    ...historical
      .filter((h) => !activeTeams.has(h.resolvedTeam))
      .map((h) => `${h.id} -> ${h.resolvedTeam}`),
    ...runbooks.filter((r) => !activeTeams.has(r.team)).map((r) => `${r.id} -> ${r.team}`),
  ];
  if (orphans.length > 0) {
    throw new Error(`Corpus references teams absent from the catalog:\n  ${orphans.join("\n  ")}`);
  }

  await catalogRepository.replaceAll(catalog);
  log.info({ teams: catalog.length }, "service catalog loaded");

  const docs: KnowledgeDoc[] = [
    ...historical.map((h): KnowledgeDoc => ({
      id: h.id,
      kind: "ticket",
      title: h.title,
      content: h.content,
      resolvedTeam: h.resolvedTeam,
      resolvedLevel: h.resolvedLevel,
      service: h.service,
    })),
    ...runbooks.map((r): KnowledgeDoc => ({
      id: r.id,
      kind: "runbook",
      title: r.title,
      content: r.content,
      resolvedTeam: r.team,
      resolvedLevel: null,
      service: r.service,
    })),
    ...templates.map((t): KnowledgeDoc => ({
      id: t.id,
      kind: "template",
      title: t.title,
      content: t.content,
      resolvedTeam: null,
      resolvedLevel: null,
      service: null,
    })),
  ];

  await knowledgeRepository.replaceAll(docs);
  log.info(await knowledgeRepository.countByKind(), "knowledge base indexed");
}

try {
  await seed();
  loggerFor("seed").info("done");
} catch (err) {
  log.error({ err }, "seed failed");
  process.exitCode = 1;
} finally {
  await closePool();
}
