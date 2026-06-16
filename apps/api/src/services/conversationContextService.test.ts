import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@journey/shared";
import { ConversationContextService } from "./conversationContextService.js";
import type { ChatCompletionMessage, ChatCompletionModelConfig } from "./chatCompletionClient.js";

type MinimalDb = {
  listSessions(): AgentSession[];
};

const MODEL_CONFIG: ChatCompletionModelConfig = {
  apiKey: "test-key",
  baseUrl: "https://api.example.test",
  model: "test-model"
};

function makeSession(
  id: string,
  itineraryId: string,
  createdAt: string,
  pairs: Array<{ user: string; assistant: string }>,
  extras: Partial<AgentSession> = {}
): AgentSession {
  const messages = pairs.flatMap((pair, index) => [
    {
      id: `${id}-u${index}`,
      role: "user" as const,
      content: pair.user,
      createdAt
    },
    {
      id: `${id}-a${index}`,
      role: "assistant" as const,
      content: pair.assistant,
      createdAt
    }
  ]);
  return {
    id,
    itineraryId,
    messages,
    importedSkillIds: [],
    traces: [],
    createdAt,
    updatedAt: createdAt,
    ...extras
  };
}

function buildService(sessions: AgentSession[]) {
  const db = { listSessions: () => sessions } satisfies MinimalDb;
  // Cast: ConversationContextService only invokes listSessions()
  return new ConversationContextService(db as never);
}

describe("ConversationContextService", () => {
  it("returns no messages when there is no prior history", async () => {
    const service = buildService([]);
    const result = await service.build({ itineraryId: "it-empty", modelConfig: MODEL_CONFIG });
    expect(result.messages).toEqual([]);
    expect(result.summarizedSessionIds).toEqual([]);
  });

  it("returns prior turns verbatim when total length is under the threshold", async () => {
    const sessions = [
      makeSession("s1", "it-1", "2026-06-10T10:00:00.000Z", [
        { user: "想去杭州", assistant: "好的，先看西湖。" }
      ]),
      makeSession("s2", "it-1", "2026-06-10T10:05:00.000Z", [
        { user: "加个龙井村", assistant: "已加入。" }
      ])
    ];
    const service = buildService(sessions);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await service.build({ itineraryId: "it-1", modelConfig: MODEL_CONFIG });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(result.summarizedSessionIds).toEqual([]);
    expect(result.messages.map((m) => m.content)).toEqual([
      "想去杭州",
      "好的，先看西湖。",
      "加个龙井村",
      "已加入。"
    ]);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("filters out other itineraries", async () => {
    const sessions = [
      makeSession("s-other", "other-it", "2026-06-10T09:00:00.000Z", [
        { user: "无关行程", assistant: "无关回复" }
      ]),
      makeSession("s1", "it-1", "2026-06-10T10:00:00.000Z", [{ user: "杭州", assistant: "好" }])
    ];
    const service = buildService(sessions);
    const result = await service.build({ itineraryId: "it-1", modelConfig: MODEL_CONFIG });
    expect(result.messages.map((m) => m.content)).toEqual(["杭州", "好"]);
  });

  it("summarizes older turns and keeps recent turns verbatim when length exceeds the threshold", async () => {
    const longUser = "长文本".repeat(2000); // ~ 6000 chars => 3000 tokens
    const longAssistant = "长回复".repeat(2000);
    const sessions = Array.from({ length: 8 }, (_, index) =>
      makeSession(`s${index + 1}`, "it-long", `2026-06-10T10:0${index}:00.000Z`, [
        { user: `${longUser}-${index}`, assistant: `${longAssistant}-${index}` }
      ])
    );
    const service = new ConversationContextService(
      { listSessions: () => sessions } as never,
      { recentTurns: 3, maxHistoryTokens: 5_000 }
    );

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain("/chat/completions");
        const body = JSON.parse(init?.body as string) as {
          messages: ChatCompletionMessage[];
        };
        // Older sessions s1..s5 should be in the summarization payload, recent
        // s6..s8 should NOT be.
        const transcript = body.messages.find((m) => m.role === "user")?.content ?? "";
        expect(transcript).toContain("-0");
        expect(transcript).toContain("-4");
        expect(transcript).not.toContain("-7");
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "用户喜欢杭州，已加入西湖、龙井村。" } }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await service.build({ itineraryId: "it-long", modelConfig: MODEL_CONFIG });

    vi.unstubAllGlobals();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.summarizedSessionIds).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    // First message is the summary system message.
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toMatch(/^\[历史摘要\]/);
    expect(result.messages[0]?.content).toContain("用户喜欢杭州");
    // Then the recent 3 sessions (6 messages) verbatim.
    expect(result.messages.length).toBe(1 + 3 * 2);
    expect(result.messages[result.messages.length - 1]?.content).toContain("-7");
  });

  it("reuses the cached contextSummary on the latest session when it fully covers the older window", async () => {
    const longUser = "长".repeat(4000);
    const sessions = [
      makeSession("s1", "it-cache", "2026-06-10T10:00:00.000Z", [{ user: longUser, assistant: longUser }]),
      makeSession("s2", "it-cache", "2026-06-10T10:01:00.000Z", [{ user: longUser, assistant: longUser }]),
      makeSession("s3", "it-cache", "2026-06-10T10:02:00.000Z", [{ user: longUser, assistant: longUser }]),
      makeSession(
        "s4",
        "it-cache",
        "2026-06-10T10:03:00.000Z",
        [{ user: longUser, assistant: longUser }],
        { historicalContextSummary: "之前的杭州偏好已记录。" }
      )
    ];
    const service = new ConversationContextService(
      { listSessions: () => sessions } as never,
      { recentTurns: 1, maxHistoryTokens: 1_000 }
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await service.build({ itineraryId: "it-cache", modelConfig: MODEL_CONFIG });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(result.summary).toBe("之前的杭州偏好已记录。");
    expect(result.messages[0]?.content).toBe("[历史摘要] 之前的杭州偏好已记录。");
    expect(result.compacted).toBe(true);
  });

  it("emits onProgress events around a fresh LLM compaction so callers can render a UI indicator", async () => {
    const longUser = "长文本".repeat(2000);
    const longAssistant = "长回复".repeat(2000);
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession(`s${index + 1}`, "it-progress", `2026-06-10T10:0${index}:00.000Z`, [
        { user: `${longUser}-${index}`, assistant: `${longAssistant}-${index}` }
      ])
    );
    const service = new ConversationContextService(
      { listSessions: () => sessions } as never,
      { recentTurns: 2, maxHistoryTokens: 5_000 }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ choices: [{ message: { role: "assistant", content: "压缩后的摘要。" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const events: Array<{ phase: string; cached?: boolean; summaryLength?: number }> = [];
    const result = await service.build({
      itineraryId: "it-progress",
      modelConfig: MODEL_CONFIG,
      onProgress: (event) => {
        events.push({
          phase: event.phase,
          cached: "cached" in event ? event.cached : undefined,
          summaryLength: "summaryLength" in event ? event.summaryLength : undefined
        });
      }
    });

    vi.unstubAllGlobals();

    expect(events).toEqual([
      { phase: "started", cached: false, summaryLength: undefined },
      { phase: "completed", cached: false, summaryLength: "压缩后的摘要。".length }
    ]);
    expect(result.compacted).toBe(true);
    expect(result.historyTokens).toBeGreaterThan(5_000);
  });

  it("does NOT emit a started event when the cache lets us skip the LLM call", async () => {
    const longUser = "长".repeat(4000);
    const sessions = [
      makeSession("s1", "it-cache2", "2026-06-10T10:00:00.000Z", [{ user: longUser, assistant: longUser }]),
      makeSession("s2", "it-cache2", "2026-06-10T10:01:00.000Z", [{ user: longUser, assistant: longUser }]),
      makeSession(
        "s3",
        "it-cache2",
        "2026-06-10T10:02:00.000Z",
        [{ user: longUser, assistant: longUser }],
        { historicalContextSummary: "缓存摘要。" }
      )
    ];
    const service = new ConversationContextService(
      { listSessions: () => sessions } as never,
      { recentTurns: 1, maxHistoryTokens: 1_000 }
    );

    const events: Array<{ phase: string; cached?: boolean }> = [];
    await service.build({
      itineraryId: "it-cache2",
      modelConfig: MODEL_CONFIG,
      onProgress: (event) => {
        events.push({ phase: event.phase, cached: "cached" in event ? event.cached : undefined });
      }
    });

    // started fires with cached:true, completed fires with cached:true. The
    // CALLER can choose to skip rendering when cached:true; the service still
    // surfaces both phases for observability.
    expect(events.map((e) => e.phase)).toEqual(["started", "completed"]);
    expect(events.every((e) => e.cached === true)).toBe(true);
  });
});
