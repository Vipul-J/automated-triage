import type { CatalogEntry, GuardrailResult, Recommendation } from "../core/types.js";

/** Phrases the customer-facing text must never contain. */
const FORBIDDEN_COMMITMENTS: readonly RegExp[] = [
  /\bwithin \d+\s*(?:minute|hour|day|week)/i,
  /\b(?:we|i)(?:'ll| will) (?:fix|resolve|have this (?:fixed|resolved))\b/i,
  /\bguarantee/i,
  /\brefund (?:has been |is )?(?:approved|issued|processed)/i,
  /\bby (?:tomorrow|today|end of day|eod)\b/i,
];

/** Internal vocabulary that should never reach a customer. */
const INTERNAL_LEAKS: readonly RegExp[] = [
  /\b(?:L1|L2|L3)\b/,
  /\brunbook\b/i,
  /\bticket[_-]?id\b/i,
  /\btriage\b/i,
  /\bconfidence\b/i,
  /-(?:L1|L2|L3)\b/,
];

// Allows _ and - inside the token: real keys look like sk_live_abcd..., and a
// class without those separators matches only the "sk_live" prefix and then
// fails the length requirement. This is the backstop behind redaction, so it
// must not be narrower than the redaction pattern it backs up.
const RESIDUAL_SECRET = /\b(?:sk|pk|ghp|xox[baprs])[_-][A-Za-z0-9_-]{12,}\b/i;
const MIN_RESPONSE_CHARS = 60;
const MAX_RESPONSE_CHARS = 900;

/**
 * Stage 2: deterministic validation of the model's proposal (design doc 7.1).
 *
 * A tripped guardrail downgrades the policy tier; it never silently rewrites the
 * output. A trip means something is off, and that ticket deserves a human.
 */
export function runGuardrails(args: {
  recommendation: Recommendation;
  catalog: readonly CatalogEntry[];
}): GuardrailResult[] {
  const { recommendation: rec, catalog } = args;
  const results: GuardrailResult[] = [];
  const check = (name: string, passed: boolean, detail?: string) =>
    results.push(detail === undefined ? { name, passed } : { name, passed, detail });

  const entry = catalog.find((c) => c.team === rec.recommendedTeam && c.active);

  check(
    "team-in-allow-list",
    entry !== undefined,
    entry ? undefined : `'${rec.recommendedTeam}' is not an active catalog team`,
  );

  check(
    "level-matches-catalog",
    entry === undefined || entry.level === rec.recommendedLevel,
    entry && entry.level !== rec.recommendedLevel
      ? `catalog says ${entry.level}, model said ${rec.recommendedLevel}`
      : undefined,
  );

  check(
    "alternatives-in-allow-list",
    rec.alternatives.every((a) => catalog.some((c) => c.team === a.team && c.active)),
  );

  const commitment = FORBIDDEN_COMMITMENTS.find((p) => p.test(rec.clientResponse));
  check(
    "no-time-or-outcome-commitment",
    commitment === undefined,
    commitment ? `matched ${commitment}` : undefined,
  );

  const leak = INTERNAL_LEAKS.find((p) => p.test(rec.clientResponse));
  check("no-internal-vocabulary", leak === undefined, leak ? `matched ${leak}` : undefined);

  check("no-residual-secret", !RESIDUAL_SECRET.test(rec.clientResponse));

  const length = rec.clientResponse.trim().length;
  check(
    "response-length-sane",
    length >= MIN_RESPONSE_CHARS && length <= MAX_RESPONSE_CHARS,
    `${length} chars`,
  );

  check("rationale-present", rec.rationale.trim().length > 0);

  // A P1 with no evidence behind it is exactly the kind of confident-sounding
  // routing that should never be auto-applied.
  check(
    "severity-supported-by-evidence",
    rec.severity !== "P1" || rec.evidence.length > 0,
    rec.severity === "P1" && rec.evidence.length === 0 ? "P1 with no cited evidence" : undefined,
  );

  return results;
}

export const allGuardrailsPassed = (results: readonly GuardrailResult[]): boolean =>
  results.every((r) => r.passed);
