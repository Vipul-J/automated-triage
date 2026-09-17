# automated-triage

AI-assisted triage for support tickets, built against a hard **3-minute
escalation window**.

A ticket arrives, and within ~20 seconds the system has analysed it, retrieved
similar resolved tickets and runbooks, proposed an owning team and drafted the
customer reply. A support engineer reviews and approves. If nobody responds
before the deadline, a policy tier decides what happens — which for some tickets
is deliberately "let it escalate".

The architecture this implements is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Section references in the code point back to it.

---

## Quick start

Requires Node 22+ and Docker.

```bash
npm install
cp .env.example .env
npm run db:up        # postgres + pgvector
npm run seed         # catalog, routing memory, runbooks, templates
npm run dev          # simulator (:4000) + triage service (:3000)
```

Then in a second terminal:

```bash
npm run demo         # creates five tickets covering every policy tier
open http://localhost:3000
```

**It runs without an API key.** With `ANTHROPIC_API_KEY` unset, a deterministic
stub model stands in, so the whole pipeline — retrieval, confidence scoring,
guardrails, the deadline race, write-back — is exercised honestly and
reproducibly. Set the key to switch to Claude; nothing else changes.

For a fast demo, lower the window:

```bash
ESCALATION_WINDOW_MS=45000 AUTOCOMMIT_MARGIN_MS=15000 npm run dev
```

---

## What happens to a ticket

```
simulator creates ticket ──► signed webhook ──► ingestion gateway
                                                (HMAC + idempotency, <200ms ack)
                                                      │
                          ┌───────────────────────────┘
                          ▼
   enrich ──► redact PII ──► hybrid retrieval ──► pre-classify ──► model
   (parallel,   (reversible   (BM25 + pgvector    (rules, no       (structured
    capped)      tokens)       fused via RRF)      model call)      output)
                          │
                          ▼
   guardrails ──► composite confidence ──► policy tier ──► review console
                                                                │
                                          ┌─────────────────────┴──────────┐
                                          ▼                                ▼
                                  human approves                   deadline fires
                                          └──────────┬─────────────────────┘
                                                     ▼
                                              write-back service
                                     (idempotent, version-checked, allow-listed)
```

### The policy tiers

The tier decides two things: what happens if nobody responds, **and who owns the
decision**. L1 is the default owner; L2 sees only the hard tail.

| Tier | When | Owner | At the deadline |
|---|---|---|---|
| `AUTO` | confidence ≥ 0.85, clean guardrails, full context | L1 | applies |
| `REVIEW` | confidence 0.60–0.85 | L1 | applies, flagged unreviewed |
| `ASSIST` | low confidence, or a guardrail tripped | L1 | posts the acknowledgement only — **no routing claim** |
| `MANUAL` | P1, VIP, security, injection, or a weak downward route | L2 | **escalates**, which is the correct outcome |

`ASSIST` is the interesting one: it separates *stopping the clock with something
true* from *committing to a route*. The first is nearly risk-free; the second is
not.

---

## Design decisions worth knowing

**The model proposes; deterministic code disposes.** The model has no tools and
no write access. It returns JSON whose `recommendedTeam` is an enum built from
the *live* catalog table on every request, so it cannot name a team that does not
exist. A separate service validates against the same allow-list and performs
every write. Ticket bodies are attacker-controlled input — the worst an injection
achieves is a bad proposal, never a bad action.

**Downward routing carries a higher bar.** A wrong route *up* costs specialist
time; a wrong route *down* to L1 bounces and burns the whole window. `L1`
proposals need `CONF_DOWNWARD_L1` (0.90) rather than the normal 0.60.

**Confidence is composite, not self-reported.** The model's own number is one
input at 25% weight. Neighbour agreement — did similar past tickets actually get
resolved by this team — carries the most, because it is the only signal grounded
in what really happened.

**Routing memory is labelled by the resolving team, not the first assignment.**
Training retrieval on first-assignment teaches the model to reproduce today's
misroutes. The gap between those two labels is the value the system adds.

**Every failure path ends where you are today.** Retrieval down → catalog-only
routing. Model down → deterministic rules, flagged for a human. Model refuses →
routed to a human, never silently retried elsewhere. Write-back fails → the
ticket escalates normally. The system is strictly additive.

---

## Layout

```
data/                     versioned JSON: catalog, routing memory, runbooks, templates
db/schema.sql             tables, HNSW vector index, full-text index
docs/ARCHITECTURE.md      the design this implements
src/
  config/                 zod-validated env; invalid config fails at boot
  domain/                 types and the typed error hierarchy
  infra/
    db/repositories/      all SQL lives here
    embeddings/           EmbeddingProvider interface + local implementation
    llm/                  model gateway, schema, prompts, Claude + stub
    logging/              pino
  pipeline/               enrich · redact · retrieve · preclassify · guardrails · confidence · policy
  orchestrator/           the human-signal-vs-timer race, and write-back
  adapters/ticketing/     anti-corruption layer + simulator implementation
  simulator/              mock ticketing platform with the escalation clock
  server/                 webhook, review console, SSE
  scripts/                seed, demo, retrieval probe
```

```bash
npm run typecheck
npm run probe -- "stripe webhook timing out"   # inspect what retrieval returns
```

---

## Honest limitations

These are deliberate for a walking skeleton, and each is isolated behind an
interface so it can be replaced without touching anything else.

- **The embedder is not semantic.** `HashedEmbeddingProvider` hashes word and
  character n-grams. It exercises the real pgvector path with no network call, so
  the system runs offline and deterministically, but it will not relate "card
  declined" to "payment failed". Replace it with a real embedding provider
  (Voyage AI is Anthropic's recommended partner), widen the `vector(256)` column
  to match, and re-seed. Only `src/infra/embeddings/` changes.
- **Orchestration is in-process.** The workflow models the timer/signal race
  correctly but lives in memory: a restart loses in-flight tickets. Production
  wants Temporal, where the timer is durable and the approval is a signal. The
  shape in `orchestrator/workflow.ts` is deliberately identical so the swap is
  mechanical.
- **No queue.** Webhook handling is direct. Kafka or SQS slots in ahead of the
  orchestrator.
- **No reconciliation poller.** Webhooks fail silently in production; the design
  calls for a poller to catch dropped deliveries. Not built yet.
- **PII redaction is illustrative.** The patterns catch common cases. Production
  needs a real detector plus a secret scanner.
- **No incident feed.** `fetchOpenIncident` returns null. A live incident is one
  of the strongest routing signals available — worth wiring early.
- **No clustering.** An incident storm currently runs the full pipeline per
  ticket. Design doc §15.3 covers fingerprinting them into one approval.
- **No tests yet.** The demo scenarios in `src/scripts/demo.ts` cover each tier
  and are the natural seed for a real suite.

---

## Next steps, in order

1. **Set `ANTHROPIC_API_KEY`** and compare routing against the stub on the demo
   scenarios. This is the first honest read on quality.
2. **Replace the embedder.** Retrieval quality is the input to routing accuracy,
   and the placeholder is the single biggest constraint on it right now.
3. **Load real historical tickets** into `data/historical-tickets.json`, labelled
   by resolving team. This matters more than any prompt tuning.
4. **Write the real ticketing adapter** once the platform is chosen — one file.
5. **Move to Temporal** before this handles production traffic.
6. **Run shadow mode** (§17 phase 0): pipeline runs, writes nothing, log
   recommendation vs. what the human actually did. That is the only honest way to
   calibrate the thresholds now sitting in `.env`.
