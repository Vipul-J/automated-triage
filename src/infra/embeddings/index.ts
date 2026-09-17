import { config } from "../../config/index.js";
import { HashedEmbeddingProvider } from "./hashed.js";
import type { EmbeddingProvider } from "./types.js";

const PROVIDERS: Record<string, () => EmbeddingProvider> = {
  hashed: () => new HashedEmbeddingProvider(256),
};

let instance: EmbeddingProvider | undefined;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!instance) {
    const factory = PROVIDERS[config.embeddings.provider];
    if (!factory) {
      throw new Error(
        `Unknown embedding provider '${config.embeddings.provider}'. ` +
          `Known: ${Object.keys(PROVIDERS).join(", ")}`,
      );
    }
    instance = factory();
  }
  return instance;
}

export { toVectorLiteral } from "./types.js";
export type { EmbeddingProvider } from "./types.js";
