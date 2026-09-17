/**
 * Estimates the per-incident API cost of running triage.
 *
 *   npm run cost
 *
 * Builds the real prompts against the seeded catalog and knowledge base, so the
 * input figures are measured rather than guessed. Output tokens are modelled,
 * because they depend on how much the model thinks - adaptive thinking is on by
 * default and thinking tokens are billed as output.
 */
import { closePool } from "../src/platform/db/pool.js";
import { catalogRepository } from "../src/platform/db/repositories/catalog.repository.js";
import { knowledgeRepository } from "../src/platform/db/repositories/knowledge.repository.js";
import { buildSystemPrompt, buildUserPrompt } from "../src/platform/llm/prompt.js";
import { makeContext, makeTicket } from "../src/testing/fixtures.js";

/** USD per million tokens. */
const PRICING = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
} as const;

/** Cache reads bill at ~10% of input; writes at ~125%. */
const CACHE_READ_MULTIPLIER = 0.1;

/** Roughly 3.7 characters per token for this mix of prose, JSON and identifiers. */
const CHARS_PER_TOKEN = 3.7;
const estimateTokens = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

/** Structured output plus adaptive thinking, which is billed as output. */
const OUTPUT_TOKENS = { low: 700, typical: 1_500, high: 3_000 } as const;

const usd = (value: number) => `$${value.toFixed(4)}`;

async function main(): Promise<void> {
  const catalog = await catalogRepository.listActive();
  const ticket = makeTicket({
    subject: "Customers charged twice when checkout is slow",
    body:
      "Since yesterday several customers report being charged twice. Our logs show the " +
      "Stripe webhook handler timing out after 10s and Stripe retrying. Charge IDs " +
      "ch_3Ab and ch_3Ac are duplicates for order 88121.",
  });

  const documents = await knowledgeRepository.search(`${ticket.subject} ${ticket.body}`, {
    limit: 8,
  });

  const system = buildSystemPrompt(catalog);
  const user = buildUserPrompt({
    ticket,
    context: makeContext(),
    documents,
    deterministicHint: {
      team: "Payments-Engineering-L3",
      reason: "catalog keywords matched: stripe, charge",
    },
  });

  const systemTokens = estimateTokens(system);
  const userTokens = estimateTokens(user);

  console.log("\nMEASURED INPUT (one incident)");
  console.log(`  system prompt, cacheable : ${String(systemTokens).padStart(6)} tokens`);
  console.log(`  user prompt, per call    : ${String(userTokens).padStart(6)} tokens`);
  console.log(`  retrieved documents      : ${String(documents.length).padStart(6)}`);
  console.log(`  total input              : ${String(systemTokens + userTokens).padStart(6)} tokens`);

  for (const [model, price] of Object.entries(PRICING)) {
    console.log(`\n${model}  ($${price.input}/$${price.output} per MTok)`);
    for (const [label, outputTokens] of Object.entries(OUTPUT_TOKENS)) {
      const cold = ((systemTokens + userTokens) * price.input) / 1e6;
      const warm =
        (systemTokens * CACHE_READ_MULTIPLIER * price.input + userTokens * price.input) / 1e6;
      const out = (outputTokens * price.output) / 1e6;
      console.log(
        `  ${label.padEnd(8)} out=${String(outputTokens).padStart(5)}tok` +
          `   cold ${usd(cold + out)}   cached ${usd(warm + out)}` +
          `   per 1000 incidents $${((warm + out) * 1000).toFixed(2)}`,
      );
    }
  }

  console.log(
    "\nThinking tokens dominate output cost and cannot be measured without a key.\n" +
      "Treat 'typical' as the planning number and 'high' as the pessimistic case.\n",
  );
}

try {
  await main();
} finally {
  await closePool();
}
