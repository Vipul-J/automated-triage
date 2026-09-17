-- AI-assisted triage: schema (design doc section 9)
CREATE EXTENSION IF NOT EXISTS vector;

-- Service / ownership catalog. The routing allow-list and the source of the
-- `recommended_team` enum handed to the model. Design doc section 8.1 corpus C.
CREATE TABLE IF NOT EXISTS service_catalog (
  id            SERIAL PRIMARY KEY,
  service       TEXT NOT NULL,
  team          TEXT NOT NULL UNIQUE,
  level         TEXT NOT NULL CHECK (level IN ('L1','L2','L3')),
  charter       TEXT NOT NULL,
  keywords      TEXT[] NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lightweight mirror of the ticketing system. It remains the source of truth.
CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,           -- incident number, e.g. INC0010001
  sys_id        TEXT,
  subject       TEXT NOT NULL,              -- short_description
  body          TEXT NOT NULL,              -- description
  requester     TEXT,                       -- caller_id
  requester_email TEXT,
  category      TEXT,
  contact_type  TEXT,
  customer_tier TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  deadline_at   TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new',
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per pipeline attempt: per-stage timings, model/prompt version, cost.
CREATE TABLE IF NOT EXISTS triage_runs (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  stage_timings JSONB NOT NULL DEFAULT '{}'::jsonb,
  model         TEXT,
  prompt_version TEXT,
  input_tokens  INT,
  output_tokens INT,
  cache_read_tokens INT,
  degraded      TEXT[] NOT NULL DEFAULT '{}',
  outcome       TEXT
);

CREATE TABLE IF NOT EXISTS recommendations (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES triage_runs(id) ON DELETE CASCADE,
  ticket_id         TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  summary           TEXT NOT NULL,
  category          TEXT NOT NULL,
  affected_service  TEXT,
  severity          TEXT NOT NULL,
  recommended_team  TEXT NOT NULL,
  recommended_level TEXT NOT NULL,
  alternatives      JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_confidence  REAL NOT NULL,
  composite_confidence REAL NOT NULL,
  confidence_parts  JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale         TEXT NOT NULL,
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  client_response   TEXT NOT NULL,
  needs_human       BOOLEAN NOT NULL DEFAULT FALSE,
  missing_information TEXT[] NOT NULL DEFAULT '{}',
  guardrails        JSONB NOT NULL DEFAULT '[]'::jsonb,
  tier              TEXT NOT NULL,
  owner_role        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who approved what, and the diff if they edited. Feedback flywheel (11.4).
CREATE TABLE IF NOT EXISTS approvals (
  id             SERIAL PRIMARY KEY,
  ticket_id      TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  actor          TEXT NOT NULL,
  actor_role     TEXT NOT NULL,
  action         TEXT NOT NULL,
  final_team     TEXT,
  final_level    TEXT,
  response_edited BOOLEAN NOT NULL DEFAULT FALSE,
  response_before TEXT,
  response_after  TEXT,
  time_to_decision_ms INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions (
  id             SERIAL PRIMARY KEY,
  ticket_id      TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  applied_team   TEXT,
  applied_level  TEXT,
  auto_applied   BOOLEAN NOT NULL DEFAULT FALSE,
  result         TEXT NOT NULL,
  detail         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit trail (design doc section 13.4).
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  ticket_id  TEXT,
  event      TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RAG corpora. kind: 'ticket' (routing memory), 'runbook', 'template'.
CREATE TABLE IF NOT EXISTS kb_chunks (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- For kind='ticket' this is the FINAL RESOLVING team, never the first
  -- assignment (design doc section 8.1) - that distinction is the whole point.
  resolved_team TEXT,
  resolved_level TEXT,
  service       TEXT,
  embedding     vector(256),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive migrations.
--
-- CREATE TABLE IF NOT EXISTS is a no-op once the table exists, so editing a
-- CREATE block above does NOT migrate a database that already has the table -
-- the new column is simply absent and the first INSERT that references it fails
-- at runtime. Every column added after the initial release therefore needs an
-- explicit, idempotent ALTER here.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sys_id          TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_email TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category        TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS contact_type    TEXT;

CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx
  ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS kb_chunks_fts_idx
  ON kb_chunks USING gin (to_tsvector('english', title || ' ' || content));
CREATE INDEX IF NOT EXISTS kb_chunks_kind_idx ON kb_chunks (kind);
CREATE INDEX IF NOT EXISTS recommendations_ticket_idx ON recommendations (ticket_id);
CREATE INDEX IF NOT EXISTS tickets_deadline_idx ON tickets (deadline_at);
