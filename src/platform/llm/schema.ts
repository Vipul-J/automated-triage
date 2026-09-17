import { z } from "zod";
import { LEVELS, SEVERITIES } from "../../core/types.js";

/**
 * The model's output contract.
 *
 * `recommendedTeam` is built as an enum from the LIVE service catalog on every
 * request, so the model physically cannot name a team that does not exist. This
 * is the primary prompt-injection defence (design doc 13.1): ticket bodies are
 * attacker-controlled text, and the worst an injection can achieve is a bad
 * proposal inside this schema - never a bad action, because the model has no
 * tools and a separate service performs every write.
 */
export function buildRecommendationSchema(activeTeams: readonly string[]) {
  if (activeTeams.length === 0) {
    throw new Error("Cannot build a routing schema with an empty team allow-list");
  }
  const teamEnum = z.enum(activeTeams as [string, ...string[]]);

  return z.object({
    summary: z.string().describe("One-line internal summary of the problem."),
    category: z.string().describe("Short category slug, e.g. 'payment-failure'."),
    affectedService: z.string().nullable().describe("Service from the catalog, or null."),
    severity: z.enum(SEVERITIES),
    recommendedTeam: teamEnum.describe("Owning team. Must be one of the listed teams."),
    recommendedLevel: z.enum(LEVELS),
    alternatives: z
      .array(z.object({ team: teamEnum, why: z.string() }))
      .max(2)
      .describe("Up to two runner-up teams, so a reviewer can reroute in one click."),
    confidence: z.number().min(0).max(1).describe("Your own confidence in this routing."),
    rationale: z.string().describe("One or two lines. Why this team. Shown to the reviewer."),
    evidence: z
      .array(z.string())
      .describe("IDs of the supplied reference documents that support this routing."),
    clientResponse: z.string().describe("Customer-facing text, adapted from an approved template."),
    needsHuman: z.boolean().describe("True if a human must decide this one."),
    missingInformation: z
      .array(z.string())
      .describe("What extra detail would have made this call more certain."),
  });
}

export type RecommendationSchema = ReturnType<typeof buildRecommendationSchema>;
export type RawRecommendation = z.infer<RecommendationSchema>;
