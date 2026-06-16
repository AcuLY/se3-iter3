import type { AgentSession, ChatMessage } from "@journey/shared";
import type { JourneyDatabase } from "../db.js";
import {
  type ChatCompletionMessage,
  type ChatCompletionModelConfig,
  requestChatCompletion
} from "./chatCompletionClient.js";

const DEFAULT_RECENT_TURNS = 10;
const DEFAULT_MAX_HISTORY_TOKENS = 120_000;
const SUMMARY_PREFIX = "[历史摘要] ";

export type ConversationContextOptions = {
  recentTurns?: number;
  maxHistoryTokens?: number;
};

export type CompactionProgressEvent =
  | {
      phase: "started";
      olderSessionCount: number;
      olderTokens: number;
      recentSessionCount: number;
      cached: boolean;
    }
  | {
      phase: "completed";
      olderSessionCount: number;
      olderTokens: number;
      recentSessionCount: number;
      cached: boolean;
      summaryLength: number;
    }
  | {
      phase: "failed";
      olderSessionCount: number;
      olderTokens: number;
      recentSessionCount: number;
      reason: string;
    };

export type BuildContextResult = {
  messages: ChatCompletionMessage[];
  summarizedSessionIds: string[];
  summary?: string;
  /** Total token estimate of all prior turns, before any compaction. */
  historyTokens: number;
  /** Whether compaction (cache hit OR fresh LLM summary) was applied. */
  compacted: boolean;
};

/**
 * Builds the prior-turn context to prepend before the current user message in
 * a chat-completions call. Strategy:
 *   - Pull all prior sessions for the itinerary in chronological order.
 *   - If everything fits within MAX_HISTORY_TOKENS, return all turns verbatim.
 *   - Otherwise, keep the most recent N turns as-is and summarize the rest.
 *     If the latest session already cached a contextSummary that covers the
 *     same trailing-old portion, reuse it instead of re-summarizing.
 *
 * Token estimation is intentionally simple (text.length / 2) — good enough
 * for Chinese-heavy travel chat. Tune later if the model is more sensitive.
 */
export class ConversationContextService {
  constructor(
    private readonly db: JourneyDatabase,
    private readonly options: ConversationContextOptions = {}
  ) {}

  async build(input: {
    itineraryId: string;
    modelConfig: ChatCompletionModelConfig;
    signal?: AbortSignal;
    onProgress?: (event: CompactionProgressEvent) => void;
  }): Promise<BuildContextResult> {
    const sessions = this.loadPriorSessions(input.itineraryId);
    if (sessions.length === 0) {
      return { messages: [], summarizedSessionIds: [], historyTokens: 0, compacted: false };
    }

    const recentTurns = this.options.recentTurns ?? DEFAULT_RECENT_TURNS;
    const maxTokens = this.options.maxHistoryTokens ?? DEFAULT_MAX_HISTORY_TOKENS;

    const allMessages = sessions.flatMap((session) => session.messages);
    const totalTokens = estimateTokens(allMessages);

    if (totalTokens <= maxTokens) {
      return {
        messages: allMessages.map(toCompletionMessage),
        summarizedSessionIds: [],
        historyTokens: totalTokens,
        compacted: false
      };
    }

    // Split into "old" (to summarize) + "recent" (verbatim). Recent slice is
    // counted by user turns — each session here is exactly one user/assistant
    // pair (see agentService.runChatCompletions: messages saved as 2 items).
    const recentSessions = sessions.slice(-recentTurns);
    const olderSessions = sessions.slice(0, sessions.length - recentSessions.length);

    if (olderSessions.length === 0) {
      // Nothing left to summarize after carving out the recent window.
      return {
        messages: recentSessions.flatMap((session) => session.messages.map(toCompletionMessage)),
        summarizedSessionIds: [],
        historyTokens: totalTokens,
        compacted: false
      };
    }

    const summarizedIds = olderSessions.map((session) => session.id);
    const cachedSummary = findCachedSummary(sessions, summarizedIds);
    const olderTokens = estimateTokens(olderSessions.flatMap((session) => session.messages));

    input.onProgress?.({
      phase: "started",
      olderSessionCount: olderSessions.length,
      olderTokens,
      recentSessionCount: recentSessions.length,
      cached: Boolean(cachedSummary)
    });

    let summary: string;
    try {
      summary = cachedSummary ?? (await this.summarize(olderSessions, input.modelConfig, input.signal));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知错误";
      input.onProgress?.({
        phase: "failed",
        olderSessionCount: olderSessions.length,
        olderTokens,
        recentSessionCount: recentSessions.length,
        reason
      });
      throw error;
    }

    input.onProgress?.({
      phase: "completed",
      olderSessionCount: olderSessions.length,
      olderTokens,
      recentSessionCount: recentSessions.length,
      cached: Boolean(cachedSummary),
      summaryLength: summary.length
    });

    const messages: ChatCompletionMessage[] = [
      { role: "system", content: `${SUMMARY_PREFIX}${summary}` },
      ...recentSessions.flatMap((session) => session.messages.map(toCompletionMessage))
    ];

    return {
      messages,
      summarizedSessionIds: summarizedIds,
      summary,
      historyTokens: totalTokens,
      compacted: true
    };
  }

  private loadPriorSessions(itineraryId: string): AgentSession[] {
    return this.db
      .listSessions()
      .filter((session) => session.itineraryId === itineraryId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  private async summarize(
    sessions: AgentSession[],
    modelConfig: ChatCompletionModelConfig,
    signal?: AbortSignal
  ): Promise<string> {
    const transcript = sessions
      .flatMap((session) =>
        session.messages.map((message) => `${labelRole(message.role)}: ${message.content}`)
      )
      .join("\n");

    const response = await requestChatCompletion(
      modelConfig,
      {
        messages: [
          {
            role: "system",
            content:
              "你将一段旅行规划的多轮对话压缩成不超过 600 字的中文摘要。要求：保留用户偏好/已确定的安排/未解决的待办；不要罗列具体工具名；不要使用列表或 markdown，只用连续段落。"
          },
          {
            role: "user",
            content: transcript
          }
        ]
      },
      signal
    );

    const summary = response.choices?.[0]?.message?.content?.trim();
    if (!summary) {
      // Fallback so we still produce *some* context rather than nothing.
      return sessions
        .map((session) => session.contextSummary)
        .filter((value): value is string => Boolean(value))
        .join(" ") || "（早前对话内容已省略）";
    }
    return summary;
  }
}

function findCachedSummary(allSessions: AgentSession[], summarizedIds: string[]): string | undefined {
  // The most recent prior session caches a summary covering everything strictly
  // older than itself. Reuse only when the cached summary's coverage matches
  // exactly the older window we want to summarize this round.
  const latest = allSessions[allSessions.length - 1];
  if (!latest) return undefined;
  const cached = latest.historicalContextSummary?.trim();
  if (!cached) return undefined;
  // The cached summary on `latest` covers all sessions before `latest`, i.e.
  // sessions[0..length-2]. summarizedIds is the older window we're trying to
  // summarize this round; they match iff we're summarizing exactly that prefix.
  const coveredEverythingBeforeLatest =
    summarizedIds.length === allSessions.length - 1 &&
    summarizedIds.every((id, index) => id === allSessions[index]?.id);
  return coveredEverythingBeforeLatest ? cached : undefined;
}

function estimateTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + Math.ceil(message.content.length / 2), 0);
}

function toCompletionMessage(message: ChatMessage): ChatCompletionMessage {
  return {
    role: message.role === "system" ? "system" : message.role,
    content: message.content
  };
}

function labelRole(role: ChatMessage["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "助手";
  return "系统";
}

export const __testing__ = {
  SUMMARY_PREFIX,
  DEFAULT_RECENT_TURNS,
  DEFAULT_MAX_HISTORY_TOKENS
};
