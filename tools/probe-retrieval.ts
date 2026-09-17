/**
 * Diagnostic: inspect what the retrieval layer returns for a query.
 *
 *   npm run probe -- "stripe webhook timing out"
 *
 * Retrieval quality is the input to routing accuracy, so being able to see the
 * neighbours - and which strategy surfaced each one - is the first thing you
 * need when a route looks wrong.
 */
import { closePool } from "../src/platform/db/pool.js";
import { catalogRepository } from "../src/platform/db/repositories/catalog.repository.js";
import { knowledgeRepository } from "../src/platform/db/repositories/knowledge.repository.js";

const DEFAULT_QUERIES = [
  "Stripe webhook timing out and customers charged twice",
  "I forgot my password and cannot sign in",
  "getting 429 rate limit errors from your API",
  "Salesforce records stopped syncing this weekend",
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const queries = args.length > 0 ? args : DEFAULT_QUERIES;

  const teams = await catalogRepository.activeTeamNames();
  console.log(`live allow-list (${teams.length} teams from DB): ${teams.join(", ")}\n`);

  for (const query of queries) {
    const hits = await knowledgeRepository.search(query, {
      limit: 4,
      kinds: ["ticket", "runbook"],
    });
    console.log(`Q: ${query}`);
    if (hits.length === 0) console.log("   (no matches)");
    for (const hit of hits) {
      const via = hit.via.join("+").padEnd(14);
      const team = (hit.resolvedTeam ?? "-").padEnd(24);
      console.log(`   ${hit.score.toFixed(4)}  [${via}] ${team} ${hit.title.slice(0, 50)}`);
    }
    console.log();
  }
}

try {
  await main();
} finally {
  await closePool();
}
