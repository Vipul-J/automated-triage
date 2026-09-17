import type { EmbeddingProvider } from "./types.js";

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const NGRAM = 4;
const NGRAM_WEIGHT = 0.35;

function fnv1a(input: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Local, dependency-free embedder: hashed word unigrams plus character n-grams,
 * L2-normalised into a fixed-width vector.
 *
 * It exercises the real pgvector path - real vectors, a real HNSW cosine index,
 * real hybrid fusion - with no network call, so the system runs offline and
 * deterministically in tests. It is lexical-ish, NOT semantic: it will not relate
 * "card declined" to "payment failed" the way a trained embedding model does.
 *
 * To upgrade, add a provider implementing EmbeddingProvider, register it in
 * ./index.ts, set EMBEDDING_PROVIDER, update the vector(N) column width to the
 * new dimensionality, and re-run the seed. Nothing outside this directory changes.
 */
export class HashedEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hashed";

  constructor(readonly dimensions: number = 256) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new RangeError(`dimensions must be a positive integer, got ${dimensions}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t));
  }

  private embedSync(text: string): number[] {
    const vector = new Float64Array(this.dimensions);
    const normalised = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

    for (const word of normalised.split(" ")) {
      if (word) this.accumulate(vector, `w:${word}`, 1);
    }
    for (let i = 0; i + NGRAM <= normalised.length; i++) {
      this.accumulate(vector, `g:${normalised.slice(i, i + NGRAM)}`, NGRAM_WEIGHT);
    }

    let magnitude = 0;
    for (const value of vector) magnitude += value * value;
    magnitude = Math.sqrt(magnitude) || 1;

    return Array.from(vector, (value) => value / magnitude);
  }

  private accumulate(vector: Float64Array, token: string, weight: number): void {
    const hash = fnv1a(token);
    const index = hash % this.dimensions;
    // A sign bit from the upper half stops collisions from only ever adding.
    const sign = (hash >>> 16) & 1 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }
}
