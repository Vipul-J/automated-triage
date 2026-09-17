export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}

/** pgvector accepts the literal form `[a,b,c]`. */
export const toVectorLiteral = (v: readonly number[]): string => `[${v.join(",")}]`;
