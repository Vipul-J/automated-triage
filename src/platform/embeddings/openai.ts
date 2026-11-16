import { z } from "zod";
import type { EmbeddingProvider } from "./types.js";

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai:text-embedding-3-small";
  readonly dimensions = 256;

  constructor(private readonly apiKey: string) {}

  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0]!;
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += 32) {
      const input = texts
        .slice(offset, offset + 32)
        .map((text) => text.trim().slice(0, 8000) || " ");
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          input,
          dimensions: this.dimensions,
          model: "text-embedding-3-small",
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`Embedding request failed (HTTP ${response.status})`);
      const { data } = z
        .object({
          data: z.array(
            z.object({
              index: z.number().int(),
              embedding: z.array(z.number()).length(this.dimensions),
            }),
          ),
        })
        .parse(await response.json());
      data.sort((a, b) => a.index - b.index);
      if (data.length !== input.length || data.some((item, index) => item.index !== index)) {
        throw new Error("Embedding response indexes do not match the request");
      }
      vectors.push(...data.map((item) => item.embedding));
    }
    return vectors;
  }
}
