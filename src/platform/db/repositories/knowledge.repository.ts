import { pool } from "../pool.js";
import { getEmbeddingProvider, toVectorLiteral } from "../../embeddings/index.js";
import type { KnowledgeDoc, KnowledgeKind, Level, RetrievedDoc } from "../../../core/types.js";

interface KnowledgeRow {
  id: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  resolved_team: string | null;
  resolved_level: Level | null;
  service: string | null;
  rank: string | number;
}

const toDoc = (r: KnowledgeRow): KnowledgeDoc => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  content: r.content,
  resolvedTeam: r.resolved_team,
  resolvedLevel: r.resolved_level,
  service: r.service,
});

/** Reciprocal-rank-fusion constant. 60 is the value from the original RRF paper. */
const RRF_K = 60;

/**
 * Very common words carry no routing signal and, under OR semantics, match
 * everything. Postgres strips English stopwords itself, but these are
 * support-ticket filler that its dictionary keeps.
 */
const NOISE_TERMS = new Set([
  "please",
  "help",
  "issue",
  "problem",
  "getting",
  "cannot",
  "unable",
  "trying",
  "happening",
  "since",
  "when",
  "what",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "customer",
  "user",
  "ticket",
  "hello",
  "team",
  "thanks",
]);

const MIN_TERM_LENGTH = 3;
const MAX_TERMS = 24;

/**
 * Builds an OR tsquery from free text.
 *
 * `websearch_to_tsquery` and `plainto_tsquery` both AND their terms, so a
 * full-sentence ticket body matches almost nothing and the lexical half of the
 * hybrid silently contributes zero. OR semantics restore it: ts_rank still
 * rewards documents matching more of the terms, so ranking stays meaningful
 * while recall becomes useful.
 *
 * Input is reduced to [a-z0-9] tokens before being joined, so no tsquery
 * metacharacter can survive into the parsed query.
 */
export function buildOrTsQuery(query: string): string | null {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= MIN_TERM_LENGTH && !NOISE_TERMS.has(t)),
    ),
  ].slice(0, MAX_TERMS);

  return terms.length > 0 ? terms.join(" | ") : null;
}

export interface RetrievalOptions {
  readonly limit?: number;
  readonly kinds?: readonly KnowledgeKind[];
}

/**
 * Hybrid retrieval: lexical (Postgres full-text) fused with dense (pgvector
 * cosine) via reciprocal rank fusion.
 *
 * Hybrid is not decoration here. Half the signal in a support ticket is exact
 * tokens - error codes, hostnames, `invalid_grant` - which dense retrieval
 * handles badly; the other half is fuzzy prose, which lexical handles badly.
 */
export class KnowledgeRepository {
  async search(query: string, options: RetrievalOptions = {}): Promise<RetrievedDoc[]> {
    const limit = options.limit ?? 8;
    const kinds = options.kinds ?? (["ticket", "runbook", "template"] as const);
    const perStrategy = limit * 3;

    const [lexical, vector] = await Promise.all([
      this.lexicalSearch(query, kinds, perStrategy),
      this.vectorSearch(query, kinds, perStrategy),
    ]);

    return this.fuse(lexical, vector, limit);
  }

  private async lexicalSearch(
    query: string,
    kinds: readonly KnowledgeKind[],
    limit: number,
  ): Promise<KnowledgeDoc[]> {
    const tsQuery = buildOrTsQuery(query);
    if (tsQuery === null) return [];

    const { rows } = await pool.query<KnowledgeRow>(
      `SELECT id, kind, title, content, resolved_team, resolved_level, service,
              ts_rank(to_tsvector('english', title || ' ' || content),
                      to_tsquery('english', $1)) AS rank
         FROM kb_chunks
        WHERE kind = ANY($2)
          AND to_tsvector('english', title || ' ' || content)
              @@ to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $3`,
      [tsQuery, kinds, limit],
    );
    return rows.map(toDoc);
  }

  private async vectorSearch(
    query: string,
    kinds: readonly KnowledgeKind[],
    limit: number,
  ): Promise<KnowledgeDoc[]> {
    const embedding = await getEmbeddingProvider().embed(query);
    const { rows } = await pool.query<KnowledgeRow>(
      `SELECT id, kind, title, content, resolved_team, resolved_level, service,
              1 - (embedding <=> $1::vector) AS rank
         FROM kb_chunks
        WHERE kind = ANY($2) AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $3`,
      [toVectorLiteral(embedding), kinds, limit],
    );
    return rows.map(toDoc);
  }

  /** Reciprocal rank fusion: score = sum over strategies of 1/(k + rank). */
  private fuse(lexical: KnowledgeDoc[], vector: KnowledgeDoc[], limit: number): RetrievedDoc[] {
    const scores = new Map<
      string,
      { doc: KnowledgeDoc; score: number; via: Set<"lexical" | "vector"> }
    >();

    const contribute = (docs: KnowledgeDoc[], via: "lexical" | "vector") => {
      docs.forEach((doc, index) => {
        const existing = scores.get(doc.id);
        const increment = 1 / (RRF_K + index + 1);
        if (existing) {
          existing.score += increment;
          existing.via.add(via);
        } else {
          scores.set(doc.id, { doc, score: increment, via: new Set([via]) });
        }
      });
    };

    contribute(lexical, "lexical");
    contribute(vector, "vector");

    return [...scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ doc, score, via }) => ({ ...doc, score, via: [...via] }));
  }

  async replaceAll(docs: readonly KnowledgeDoc[]): Promise<void> {
    const provider = getEmbeddingProvider();
    const embeddings = await provider.embedBatch(docs.map((d) => `${d.title}\n${d.content}`));

    await pool.query("TRUNCATE kb_chunks");
    for (const [index, doc] of docs.entries()) {
      await pool.query(
        `INSERT INTO kb_chunks
           (id, kind, title, content, resolved_team, resolved_level, service, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          doc.id,
          doc.kind,
          doc.title,
          doc.content,
          doc.resolvedTeam,
          doc.resolvedLevel,
          doc.service,
          toVectorLiteral(embeddings[index] ?? []),
        ],
      );
    }
  }

  async countByKind(): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*)::text AS count FROM kb_chunks GROUP BY kind`,
    );
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]));
  }
}

export const knowledgeRepository = new KnowledgeRepository();
