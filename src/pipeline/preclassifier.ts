import type { CatalogEntry, Ticket } from "../domain/types.js";

export interface DeterministicMatch {
  readonly team: string;
  readonly reason: string;
  readonly strength: number;
}

/**
 * Stage 0: rules and catalog lookup, no model call (design doc 7.1).
 *
 * Fast, free, perfectly predictable and auditable. Every ticket it settles is
 * latency and cost saved, and a class of route that cannot be hallucinated. It
 * also becomes the entire routing path when the model is unavailable.
 */
export function preclassify(
  ticket: Ticket,
  catalog: readonly CatalogEntry[],
): DeterministicMatch | null {
  const haystack = `${ticket.subject}\n${ticket.body}`.toLowerCase();

  const scored = catalog
    .filter((entry) => entry.active)
    .map((entry) => {
      const hits = entry.keywords.filter((kw) => haystack.includes(kw.toLowerCase()));
      return { entry, hits };
    })
    .filter((s) => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);

  const best = scored[0];
  if (!best) return null;

  // An ambiguous match is not a match: if a second team scores equally, the
  // keywords are not discriminating and the model should decide.
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.hits.length === best.hits.length) return null;

  return {
    team: best.entry.team,
    reason: `catalog keywords matched: ${best.hits.slice(0, 4).join(", ")}`,
    strength: Math.min(1, best.hits.length / 3),
  };
}
