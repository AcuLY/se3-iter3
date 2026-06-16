export type ChatCompletionModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type ChatCompletionToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ChatCompletionMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
};

export type ChatCompletionAssistantMessage = {
  role?: string;
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  thinking?: string;
  tool_calls?: ChatCompletionToolCall[];
};

export type ChatCompletionResponse = {
  choices?: Array<{
    message?: ChatCompletionAssistantMessage;
  }>;
};

export function readChatCompletionModelConfig(): ChatCompletionModelConfig | undefined {
  const agentApiKey = readEnv("AGENT_MODEL_API_KEY");
  const openAiApiKey = readEnv("OPENAI_API_KEY");
  const deepSeekApiKey = readEnv("DEEPSEEK_API_KEY");
  const apiKey = agentApiKey ?? openAiApiKey ?? deepSeekApiKey;
  if (!apiKey) return undefined;
  const usesDeepSeekFallback = !agentApiKey && !openAiApiKey && Boolean(deepSeekApiKey);
  return {
    apiKey,
    baseUrl:
      readEnv("AGENT_MODEL_BASE_URL") ??
      readEnv("OPENAI_BASE_URL") ??
      (usesDeepSeekFallback ? readEnv("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com" : "https://api.openai.com/v1"),
    model:
      readEnv("AGENT_MODEL") ??
      readEnv("OPENAI_MODEL") ??
      (usesDeepSeekFallback ? readEnv("DEEPSEEK_MODEL") ?? "deepseek-chat" : "gpt-4o-mini")
  };
}

export async function requestChatCompletion(
  modelConfig: ChatCompletionModelConfig,
  body: {
    messages: ChatCompletionMessage[];
    tools?: unknown[];
    tool_choice?: "auto";
    temperature?: number;
  },
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${trimTrailingSlash(modelConfig.baseUrl)}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modelConfig.apiKey}`
    },
    body: JSON.stringify({
      model: modelConfig.model,
      ...body
    })
  });
  if (!response.ok) throw new Error(`Chat completion request failed: ${response.status}`);
  return (await response.json()) as ChatCompletionResponse;
}

export function readModelReasoning(message?: ChatCompletionAssistantMessage): string | undefined {
  return firstNonEmptyString(message?.reasoning, message?.reasoning_content, message?.thinking);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function firstNonEmptyString(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
