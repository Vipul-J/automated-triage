import "dotenv/config";
import { z } from "zod";

/**
 * Environment is parsed and validated once, at boot. A malformed threshold or a
 * missing DSN fails here with a readable message rather than surfacing as a
 * NaN comparison inside the policy engine at 03:00.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TRIAGE_MODEL: z.string().min(1).default("claude-opus-5"),
    TRIAGE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

    TRIAGE_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    SIM_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    SIM_BASE_URL: z.string().url().default("http://localhost:4000"),
    TRIAGE_BASE_URL: z.string().url().default("http://localhost:3000"),

    ESCALATION_WINDOW_MS: z.coerce.number().int().positive().default(180_000),
    AUTOCOMMIT_MARGIN_MS: z.coerce.number().int().positive().default(30_000),

    CONF_AUTO: z.coerce.number().min(0).max(1).default(0.85),
    CONF_REVIEW: z.coerce.number().min(0).max(1).default(0.6),
    CONF_DOWNWARD_L1: z.coerce.number().min(0).max(1).default(0.9),

    EMBEDDING_PROVIDER: z.enum(["hashed"]).default("hashed"),
    WEBHOOK_SECRET: z.string().min(8),
  })
  // Cross-field invariants the individual schemas cannot express.
  .refine((e) => e.AUTOCOMMIT_MARGIN_MS < e.ESCALATION_WINDOW_MS, {
    message: "AUTOCOMMIT_MARGIN_MS must be smaller than ESCALATION_WINDOW_MS",
    path: ["AUTOCOMMIT_MARGIN_MS"],
  })
  .refine((e) => e.CONF_REVIEW <= e.CONF_AUTO, {
    message: "CONF_REVIEW must be <= CONF_AUTO",
    path: ["CONF_REVIEW"],
  });

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

const env = loadEnv();

export const config = Object.freeze({
  env: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,

  llm: Object.freeze({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.TRIAGE_MODEL,
    effort: env.TRIAGE_EFFORT,
    /** No credential -> the pipeline runs against a deterministic stub model. */
    useMock: env.ANTHROPIC_API_KEY === undefined,
    promptVersion: "triage-v1",
  }),

  db: Object.freeze({ url: env.DATABASE_URL, poolMax: env.DB_POOL_MAX }),

  http: Object.freeze({
    triagePort: env.TRIAGE_PORT,
    simPort: env.SIM_PORT,
    simBaseUrl: env.SIM_BASE_URL,
    triageBaseUrl: env.TRIAGE_BASE_URL,
    webhookSecret: env.WEBHOOK_SECRET,
  }),

  deadlines: Object.freeze({
    escalationWindowMs: env.ESCALATION_WINDOW_MS,
    autoCommitMarginMs: env.AUTOCOMMIT_MARGIN_MS,
  }),

  policy: Object.freeze({
    confAuto: env.CONF_AUTO,
    confReview: env.CONF_REVIEW,
    /** Downward routes to L1 carry a higher bar - a bad one bounces (doc 10.1). */
    confDownwardL1: env.CONF_DOWNWARD_L1,
  }),

  embeddings: Object.freeze({ provider: env.EMBEDDING_PROVIDER }),
});

/** Per-stage latency budget derived from the 3-minute window (doc section 4). */
export const STAGE_BUDGET_MS = Object.freeze({
  enrich: 2_500,
  retrieve: 700,
  infer: 25_000,
  guardrails: 1_500,
  writeback: 5_000,
});

export type Config = typeof config;
