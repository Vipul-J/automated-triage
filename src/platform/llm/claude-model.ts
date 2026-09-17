import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "../../config/index.js";
import { InvalidModelOutputError, ModelRefusalError } from "../../core/errors.js";
import { loggerFor } from "../logging/logger.js";
import { buildRecommendationSchema } from "./schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import type { InferenceRequest, InferenceResponse, TriageModel } from "./types.js";

const log = loggerFor("claude");
const MAX_TOKENS = 4_096;

export class ClaudeTriageModel implements TriageModel {
  readonly isMock = false;
  readonly name: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, model: string = config.llm.model) {
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
    this.name = model;
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const activeTeams = request.catalog.filter((c) => c.active).map((c) => c.team);
    const schema = buildRecommendationSchema(activeTeams);

    const response = await this.client.messages.parse(
      {
        model: this.name,
        max_tokens: MAX_TOKENS,
        // The roster is large and stable; caching it keeps the critical path fast.
        system: [
          {
            type: "text",
            text: buildSystemPrompt(request.catalog),
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: buildUserPrompt({
              ticket: request.ticket,
              context: request.context,
              documents: request.documents,
              deterministicHint: request.deterministicHint,
            }),
          },
        ],
        output_config: {
          format: zodOutputFormat(schema),
          effort: config.llm.effort,
        },
      },
      { signal: request.signal },
    );

    // Fail-safe: a decline routes to a human, it never silently retries elsewhere.
    if (response.stop_reason === "refusal") {
      throw new ModelRefusalError("Model declined to triage this ticket", {
        category: response.stop_details?.category ?? null,
        ticketId: request.ticket.id,
      });
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new InvalidModelOutputError("Model output did not satisfy the routing schema", {
        stopReason: response.stop_reason,
        ticketId: request.ticket.id,
      });
    }

    log.debug(
      { ticketId: request.ticket.id, cacheRead: response.usage.cache_read_input_tokens },
      "inference complete",
    );

    return {
      recommendation: parsed,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens ?? null,
        outputTokens: response.usage.output_tokens ?? null,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
      },
    };
  }
}
