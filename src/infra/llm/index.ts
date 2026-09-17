import { config } from "../../config/index.js";
import { loggerFor } from "../logging/logger.js";
import { ClaudeTriageModel } from "./claude-model.js";
import { MockTriageModel } from "./mock-model.js";
import type { TriageModel } from "./types.js";

const log = loggerFor("model-gateway");

let instance: TriageModel | undefined;

/**
 * Model gateway. The one place provider choice is made, so failover, budgets and
 * prompt versioning have a single home as this grows (design doc 7.4).
 */
export function getTriageModel(): TriageModel {
  if (!instance) {
    if (config.llm.apiKey) {
      instance = new ClaudeTriageModel(config.llm.apiKey, config.llm.model);
      log.info({ model: instance.name, effort: config.llm.effort }, "using Claude");
    } else {
      instance = new MockTriageModel();
      log.warn(
        "ANTHROPIC_API_KEY is not set - using the deterministic stub model. " +
          "The pipeline runs end to end, but routing quality is not representative.",
      );
    }
  }
  return instance;
}

export type { TriageModel, InferenceRequest, InferenceResponse } from "./types.js";
