import { afterEach, describe, expect, it, vi } from "vitest";
import { readChatCompletionModelConfig } from "./chatCompletionClient.js";

describe("chat completion model config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults DeepSeek fallback traffic to DeepSeek V4 Pro", () => {
    vi.stubEnv("AGENT_MODEL_API_KEY", "");
    vi.stubEnv("AGENT_MODEL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("DEEPSEEK_MODEL", "");

    expect(readChatCompletionModelConfig()).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro"
    });
  });
});
