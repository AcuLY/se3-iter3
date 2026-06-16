import {
  applyItineraryPatch,
  createId,
  detectTransportTimingConflict,
  nowIso,
  type AgentName,
  type AgentRunEvent,
  type AgentSession,
  type AgentTraceEvent,
  type Activity,
  type ChatMessage,
  type ItineraryDay,
  type ItineraryPatch,
  type ItineraryPatchOperation,
  type MapRouteMode,
  type Place,
  type RouteSummary,
  type RouteStep,
  type SavedMemory,
  type TravelSkill,
  type TravelItinerary
} from "@journey/shared";
import type { JourneyDatabase } from "../db.js";
import {
  readChatCompletionModelConfig,
  readModelReasoning,
  requestChatCompletion,
  type ChatCompletionMessage,
  type ChatCompletionModelConfig,
  type ChatCompletionToolCall
} from "./chatCompletionClient.js";
import { HistoryService } from "./historyService.js";
import { ConversationContextService } from "./conversationContextService.js";
import { ItineraryService } from "./itineraryService.js";
import { MapService, type PoiResult } from "./mapService.js";
import { MemoryService } from "./memoryService.js";
import { SkillService } from "./skillService.js";

export type AgentRunInput = {
  itineraryId: string;
  message: string;
  importedSkillIds?: string[];
  signal?: AbortSignal;
};

export type AgentRunOptions = {
  onEvent?: (event: AgentRunEvent) => void;
};

export type AgentRunResult = {
  itinerary: TravelItinerary;
  message: ChatMessage;
  diff: string[];
  traces: AgentTraceEvent[];
  events: AgentRunEvent[];
  session: AgentSession;
};

type AgentRunContext = {
  sessionId: string;
  events: AgentRunEvent[];
  sequence: number;
  onEvent?: (event: AgentRunEvent) => void;
};

export class AgentRunAbortedError extends Error {
  constructor() {
    super("Agent run aborted");
    this.name = "AbortError";
  }
}

const NATIONAL_POI_SEARCH_CITY = "全国";

export class AgentService {
  private readonly itineraries: ItineraryService;
  private readonly skills: SkillService;
  private readonly maps = new MapService();
  private readonly memories: MemoryService;
  private readonly history: HistoryService;
  private readonly conversationContext: ConversationContextService;

  constructor(private readonly db: JourneyDatabase) {
    this.itineraries = new ItineraryService(db);
    this.skills = new SkillService(db);
    this.memories = new MemoryService(db);
    this.history = new HistoryService(db);
    this.conversationContext = new ConversationContextService(db);
  }

  async run(input: AgentRunInput, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    throwIfAborted(input.signal);
    const chatCompletionConfig = readChatCompletionModelConfig();
    if (!chatCompletionConfig) {
      throw new Error("缺少模型配置，请设置 AGENT_MODEL_API_KEY、OPENAI_API_KEY 或 DEEPSEEK_API_KEY。");
    }
    try {
      return await this.runChatCompletions(input, chatCompletionConfig, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown model error";
      throw new Error(`模型调用失败，请检查模型服务配置后重试。${detail ? ` ${detail}` : ""}`);
    }
  }

  private async runChatCompletions(
    input: AgentRunInput,
    modelConfig: ChatCompletionModelConfig,
    options: AgentRunOptions = {}
  ): Promise<AgentRunResult> {
    throwIfAborted(input.signal);
    const itinerary = this.itineraries.get(input.itineraryId);
    const importedSkillIds = unique([...(itinerary.importedSkillIds ?? []), ...(input.importedSkillIds ?? [])]);
    const importedSkills = importedSkillIds.map((id) => this.skills.get(id)).filter(Boolean);
    const memorySnapshotText = this.memories.buildSnapshotText();
    const sessionId = createId("session");
    const context = this.createRunContext(sessionId, options);
    let compactionEventId: string | undefined;
    const priorContext = await this.conversationContext.build({
      itineraryId: input.itineraryId,
      modelConfig,
      signal: input.signal,
      onProgress: (progress) => {
        if (progress.phase === "started") {
          if (progress.cached) {
            // Cache hit — nothing was actually summarized this round; skip the
            // "压缩中" indicator entirely so the user only sees real work.
            return;
          }
          const event = this.emitRunEvent(
            context,
            0,
            "tool_call",
            "running",
            "压缩历史对话",
            `正在压缩 ${progress.olderSessionCount} 轮对话（约 ${formatTokens(progress.olderTokens)} tokens）以腾出上下文……`,
            "ContextAgent",
            { input: { olderSessions: progress.olderSessionCount, olderTokens: progress.olderTokens } }
          );
          compactionEventId = event.id;
        } else if (progress.phase === "completed") {
          if (!compactionEventId) return;
          this.emitRunEvent(
            context,
            0,
            "tool_result",
            "completed",
            "压缩历史对话完成",
            `已将 ${progress.olderSessionCount} 轮历史压缩为 ${progress.summaryLength} 字摘要，保留近 ${progress.recentSessionCount} 轮原文。`,
            "ContextAgent",
            {
              output: {
                olderSessions: progress.olderSessionCount,
                summaryLength: progress.summaryLength,
                recentSessions: progress.recentSessionCount,
                cached: progress.cached
              }
            }
          );
        } else if (progress.phase === "failed") {
          this.emitRunEvent(
            context,
            0,
            "error",
            "failed",
            "压缩历史对话失败",
            progress.reason,
            "ContextAgent"
          );
        }
      }
    });
    throwIfAborted(input.signal);
    const traces: AgentTraceEvent[] = [
      this.trace(sessionId, "MainAgent", "message", "读取行程上下文", `${itinerary.title} / ${itinerary.days.length} 天`),
      this.trace(sessionId, "MainAgent", "message", "读取已保存记忆", memorySnapshotText),
      this.trace(sessionId, "StyleAgent", "tool_call", "读取已导入 Skill", importedSkills.map((skill) => skill.displayName).join("、") || "未导入 Skill"),
      this.trace(sessionId, "PlannerAgent", "handoff", "准备调用规划工具", "根据模型 tool_calls 操作结构化行程")
    ];
    if (priorContext.messages.length > 0) {
      traces.push(
        this.trace(
          sessionId,
          "MainAgent",
          "message",
          "拼接历史对话",
          priorContext.summary
            ? `已注入 ${priorContext.messages.length} 条历史消息（含摘要）`
            : `已注入 ${priorContext.messages.length} 条历史消息`
        )
      );
    }
    const messages: ChatCompletionMessage[] = [
      {
        role: "system",
        content: [
          "你是旅行规划主 Agent。你必须通过工具调用修改结构化行程，不要只输出文本。",
          "你可以读取导入的旅行风格 Skill、全局已保存记忆和当前行程。",
          "当前行程 JSON 里的 destination 字段是历史命名，语义是出发点；不要把出发点当作行程目的地，也不要因为活动城市不同就建议更正 destination。",
          "系统会直接注入一段全局记忆快照。除非你需要精确编辑某条记忆，否则不要为了感知手动编辑而先调用记忆列表工具。",
          "当用户表达稳定、可长期复用的偏好、禁忌或回答风格时，你可以主动维护 saved memories。",
          "只有当用户明显提到过去、上次、之前、历史里的某个行程或对话时，才调用历史对话工具。",
          "当用户只是询问地点是否存在、路线如何、天气怎样，而没有要求修改行程时，优先使用只读查询工具，不要为了查询创建临时活动或写入画布。",
          "只读查询工具（不会修改画布）：路线/交通时长/跨城高铁/驾车 → preview_transport_modes（自动识别同城与跨城，跨城会返回高铁/动车与驾车方案）；POI 候选 → search_poi；天气 → get_day_weather。用户问“怎么走 / 多远 / 多久 / 是否存在 / 哪天天气”这类问题时，先调这些工具再回答，不要凭训练知识凑答案。",
          "普通用户不需要看到内部 Agent 名称；可以输出简短行动说明，但不要展示内部推理链路。",
          "回复正文只做简短总结，不要列出本轮 diff；系统会在对话末尾追加结构化改动清单。"
        ].join("\n")
      },
      ...priorContext.messages,
      {
        role: "user",
        content: JSON.stringify({
          request: input.message,
          itinerary,
          importedSkills: importedSkills.map((skill) => ({
            id: skill.id,
            name: skill.displayName,
            description: skill.description,
            rules: skill.rules,
            forbidden: skill.forbidden,
            body: skill.body
          })),
          memorySnapshotText
        })
      }
    ];
    const state: ChatCompletionExecutionState = {
      itinerary,
      importedSkillIds,
      traces,
      sessionId,
      diff: [],
      addedStructuredActivity: false,
      usedTransportTool: false
    };
    const seenToolCallIds = new Set<string>();
    let assistantContent = "";
    let stoppedByMaxTurns = false;
    let finalSignalEmitted = false;
    const maxTurns = readAgentMaxTurns();

    for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex += 1) {
      throwIfAborted(input.signal);
      const data = await requestChatCompletion(
        modelConfig,
        {
          messages,
          tools: chatCompletionTools(),
          tool_choice: "auto"
        },
        input.signal
      );
      throwIfAborted(input.signal);
      const message = data.choices?.[0]?.message;
      const toolCalls = message?.tool_calls ?? [];
      const reasoning = readModelReasoning(message);
      if (reasoning) {
        this.emitRunEvent(context, turnIndex, "thought_summary", "completed", "模型思考", reasoning, "MainAgent");
      }
      if (message?.content?.trim()) {
        assistantContent = message.content.trim();
        this.emitRunEvent(context, turnIndex, "assistant_message", "completed", "模型对外输出", assistantContent, "MainAgent");
      }
      if (reasoning || message?.content?.trim()) {
        await this.pauseAfterEventFlush(context, input.signal);
      }
      if (toolCalls.length === 0) {
        this.emitRunEvent(
          context,
          turnIndex,
          "final_signal",
          "completed",
          "模型完成本轮任务",
          assistantContent ? "已生成最终回复，未继续调用工具。" : "模型未继续调用工具，准备结束本轮任务。",
          "CriticAgent"
        );
        finalSignalEmitted = true;
        await this.pauseAfterEventFlush(context, input.signal);
        break;
      }
      messages.push({
        role: "assistant",
        content: message?.content ?? "",
        tool_calls: toolCalls
      });
      let repeatedToolCall = false;
      for (const toolCall of toolCalls) {
        if (seenToolCallIds.has(toolCall.id)) {
          repeatedToolCall = true;
          const detail = `模型重复调用工具 ${toolCall.id}，已停止循环以避免重复修改。`;
          state.traces.push(this.trace(sessionId, toolAgent(toolCall.function.name), "error", "重复工具调用", detail));
          this.emitRunEvent(context, turnIndex, "error", "failed", "重复工具调用", detail, toolAgent(toolCall.function.name));
          this.emitRunEvent(context, turnIndex, "final_signal", "completed", "工具循环已停止", detail, "CriticAgent");
          finalSignalEmitted = true;
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ status: "failed", summary: detail })
          });
          break;
        }
        seenToolCallIds.add(toolCall.id);
        const parsed = parseToolArguments(toolCall.function.arguments);
        const agent = toolAgent(toolCall.function.name);
        state.traces.push(this.trace(sessionId, agent, "tool_call", toolCall.function.name, JSON.stringify(parsed)));
        this.emitRunEvent(context, turnIndex, "tool_call", "running", toolCall.function.name, summarizeToolInput(toolCall.function.name, parsed), agent, {
          input: compactTechnicalValue(parsed)
        });
        const execution = await this.executeChatCompletionToolCall(state, toolCall.function.name, parsed, input.signal);
        this.emitRunEvent(
          context,
          turnIndex,
          execution.status === "failed" ? "error" : "tool_result",
          execution.status,
          execution.title,
          execution.summary,
          agent,
          {
            input: compactTechnicalValue(parsed),
            output: compactTechnicalValue(execution.output)
          }
        );
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            status: execution.status,
            summary: execution.summary,
            diff: execution.diff,
            itinerary: summarizeItineraryForToolObservation(state.itinerary)
          })
        });
      }
      if (repeatedToolCall) break;
      if (turnIndex === maxTurns) {
        stoppedByMaxTurns = true;
      }
    }

    if (stoppedByMaxTurns) {
      assistantContent = `已达到配置的最大模型回合数（${maxTurns}），我先保留已经完成的修改。`;
      this.emitRunEvent(context, maxTurns, "final_signal", "completed", "达到最大模型回合数", assistantContent, "CriticAgent");
      finalSignalEmitted = true;
    }

    if (!finalSignalEmitted) {
      this.emitRunEvent(
        context,
        maxTurns,
        "final_signal",
        "completed",
        "模型工具循环结束",
        assistantContent || "工具循环已结束，进入校验保存。",
        "CriticAgent"
      );
      finalSignalEmitted = true;
      await this.pauseAfterEventFlush(context, input.signal);
    }

    const memoryMutation = this.syncMemoriesFromMessage(input.message, state.traces, sessionId);
    if (memoryMutation.created.length > 0) {
      this.emitRunEvent(
        context,
        maxTurns + 1,
        "state_patch",
        "completed",
        "沉淀全局记忆",
        `新增 ${memoryMutation.created.length} 条记忆`,
        "MainAgent",
        { output: { created: memoryMutation.created.map((memory) => memory.content) } }
      );
    }
    if (state.addedStructuredActivity) {
      const diffStart = state.diff.length;
      state.itinerary = await this.resolveMissingPlaces(state.itinerary, state.traces, sessionId, state.diff, input.signal);
      if (state.diff.length > diffStart) {
        this.emitRunEvent(
          context,
          maxTurns + 1,
          "state_patch",
          "completed",
          "补全地点坐标",
          state.diff.slice(diffStart).join("；"),
          "AttractionAgent",
          { output: { diff: state.diff.slice(diffStart) } }
        );
      }
    }
    const routeCompletionMode =
      state.completeTransportMode ??
      (state.addedStructuredActivity && !state.usedTransportTool && hasRouteCompletionIntent(input.message)
        ? (parseRouteModeFromMessage(input.message) ?? "walking")
        : undefined);
    if (routeCompletionMode) {
      const diffStart = state.diff.length;
      this.emitRunEvent(context, maxTurns + 1, "tool_call", "running", "complete_transport_legs", "补全缺失的相邻交通路线。", "TransportAgent", {
        input: { mode: routeCompletionMode }
      });
      state.itinerary = await this.completeMissingTransportLegs(state.itinerary, routeCompletionMode, state.traces, sessionId, state.diff, input.signal);
      this.emitRunEvent(
        context,
        maxTurns + 1,
        "tool_result",
        "completed",
        "补全交通路线",
        state.diff.slice(diffStart).join("；") || "没有发现需要补全的交通路线。",
        "TransportAgent",
        { output: { diff: state.diff.slice(diffStart) } }
      );
    }

    state.traces.push(this.trace(sessionId, "CriticAgent", "state_patch", "校验并保存行程", state.diff.join("；") || "无结构化变更"));
    this.emitRunEvent(
      context,
      maxTurns + 1,
      "state_patch",
      "completed",
      "校验并保存行程",
      state.diff.join("；") || "无结构化变更",
      "CriticAgent"
    );
    await this.pauseAfterEventFlush(context, input.signal);
    throwIfAborted(input.signal);
    for (const trace of state.traces) this.db.saveTrace(trace);

    const userMessage: ChatMessage = {
      id: createId("msg"),
      role: "user",
      content: input.message,
      createdAt: nowIso()
    };
    const assistantMessage: ChatMessage = {
      id: createId("msg"),
      role: "assistant",
      content: assistantContent || (state.diff.length > 0 ? "已更新行程。" : "当前没有结构变化。"),
      createdAt: nowIso()
    };
    const contextSummary = summarizeSession(input.message, state.itinerary, importedSkills.map((skill) => skill.displayName), memorySnapshotText);
    const session: AgentSession = {
      id: sessionId,
      itineraryId: state.itinerary.id,
      messages: [userMessage, assistantMessage],
      importedSkillIds: state.importedSkillIds,
      traces: state.traces,
      contextSummary,
      historicalContextSummary: priorContext.summary,
      memorySnapshotText,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    throwIfAborted(input.signal);
    this.db.saveSession(session);

    return {
      itinerary: state.itinerary,
      message: assistantMessage,
      diff: state.diff,
      traces: state.traces,
      events: context.events,
      session
    };
  }

  private createRunContext(sessionId: string, options: AgentRunOptions): AgentRunContext {
    return {
      sessionId,
      events: [],
      sequence: 0,
      onEvent: options.onEvent
    };
  }

  private emitRunEvent(
    context: AgentRunContext,
    turnIndex: number,
    type: AgentRunEvent["type"],
    status: AgentRunEvent["status"],
    title: string,
    detail: string,
    agent?: AgentName,
    technical?: AgentRunEvent["technical"]
  ): AgentRunEvent {
    const event: AgentRunEvent = {
      id: createId("event"),
      sessionId: context.sessionId,
      turnIndex,
      sequence: ++context.sequence,
      type,
      status,
      title,
      detail,
      agent,
      technical,
      createdAt: nowIso()
    };
    context.events.push(event);
    context.onEvent?.(event);
    return event;
  }

  private emitTraceEvent(context: AgentRunContext, trace: AgentTraceEvent): AgentRunEvent {
    return this.emitRunEvent(
      context,
      0,
      traceTypeToRunEventType(trace.type),
      trace.type === "error" ? "failed" : "completed",
      trace.title,
      trace.detail,
      trace.agent
    );
  }

  private async pauseAfterEventFlush(context: AgentRunContext, signal?: AbortSignal): Promise<void> {
    if (!context.onEvent) return;
    await new Promise((resolve) => setTimeout(resolve, 120));
    throwIfAborted(signal);
  }

  private async executeChatCompletionToolCall(
    state: ChatCompletionExecutionState,
    toolName: string,
    parsed: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ChatCompletionToolExecutionResult> {
    const diffStart = state.diff.length;
    try {
      if (toolName === "add_activity") {
        state.addedStructuredActivity = true;
        state.itinerary = this.applySinglePatchOperation(
          state.itinerary,
          state.importedSkillIds,
          {
            type: "addActivity",
            dayId: String(parsed.dayId),
            activity: {
              type: parseActivityType(parsed.type),
              title: String(parsed.title),
              placeName: asOptionalString(parsed.placeName),
              startTime: asOptionalString(parsed.startTime),
              endTime: asOptionalString(parsed.endTime),
              description: asOptionalString(parsed.description),
              budgetCny: asOptionalNumber(parsed.budgetCny),
              transportNote: asOptionalString(parsed.transportNote),
              tags: asStringList(parsed.tags)
            }
          },
          state.diff
        );
      } else if (toolName === "add_place_activity") {
        state.addedStructuredActivity = true;
        state.itinerary = await this.applyPlaceActivityTool(
          state.itinerary,
          {
            dayId: String(parsed.dayId),
            query: String(parsed.query ?? parsed.poiName ?? parsed.title ?? ""),
            poiName: asOptionalString(parsed.poiName),
            type: parseActivityType(parsed.type),
            title: String(parsed.title ?? parsed.poiName ?? parsed.query ?? "新的地点"),
            startTime: asOptionalString(parsed.startTime),
            endTime: asOptionalString(parsed.endTime),
            description: asOptionalString(parsed.description),
            budgetCny: asOptionalNumber(parsed.budgetCny),
            tags: asStringList(parsed.tags)
          },
          state.traces,
          state.sessionId,
          state.diff,
          signal
        );
      } else if (toolName === "update_activity_place") {
        state.itinerary = await this.applyPlaceUpdateTool(
          state.itinerary,
          {
            activityId: String(parsed.activityId),
            query: String(parsed.query ?? parsed.poiName ?? parsed.title ?? ""),
            poiName: asOptionalString(parsed.poiName),
            type: parsed.type ? parseActivityType(parsed.type) : undefined,
            title: asOptionalString(parsed.title)
          },
          state.traces,
          state.sessionId,
          state.diff,
          signal
        );
      } else if (toolName === "update_activity") {
        state.itinerary = this.applySinglePatchOperation(
          state.itinerary,
          state.importedSkillIds,
          {
            type: "updateActivity",
            activityId: String(parsed.activityId),
            changes: parsed.changes as Partial<Activity>
          },
          state.diff
        );
      } else if (toolName === "remove_activity") {
        state.itinerary = this.applySinglePatchOperation(
          state.itinerary,
          state.importedSkillIds,
          { type: "removeActivity", activityId: String(parsed.activityId) },
          state.diff
        );
      } else if (toolName === "move_activity") {
        state.itinerary = this.applySinglePatchOperation(
          state.itinerary,
          state.importedSkillIds,
          {
            type: "moveActivity",
            activityId: String(parsed.activityId),
            targetDayId: String(parsed.targetDayId),
            targetIndex: Number(parsed.targetIndex ?? 0)
          },
          state.diff
        );
      } else if (toolName === "set_transport_leg") {
        state.usedTransportTool = true;
        state.itinerary = await this.applyTransportTool(
          state.itinerary,
          {
            dayId: String(parsed.dayId),
            fromActivityId: String(parsed.fromActivityId),
            toActivityId: String(parsed.toActivityId),
            mode: parseRouteMode(parsed.mode)
          },
          state.traces,
          state.sessionId,
          state.diff,
          signal
        );
      } else if (toolName === "compare_transport_modes") {
        state.usedTransportTool = true;
        state.itinerary = await this.applyTransportComparisonTool(
          state.itinerary,
          {
            dayId: String(parsed.dayId),
            fromActivityId: String(parsed.fromActivityId),
            toActivityId: String(parsed.toActivityId),
            modes: parseRouteModesFromTool(parsed.modes),
            strategy: parsed.strategy === "shortest" ? "shortest" : "fastest"
          },
          state.traces,
          state.sessionId,
          state.diff,
          signal
        );
      } else if (toolName === "remove_transport_leg") {
        state.usedTransportTool = true;
        state.itinerary = this.applyTransportRemovalTool(
          state.itinerary,
          {
            dayId: String(parsed.dayId),
            fromActivityId: String(parsed.fromActivityId),
            toActivityId: String(parsed.toActivityId)
          },
          state.traces,
          state.sessionId,
          state.diff
        );
      } else if (toolName === "complete_transport_legs") {
        state.usedTransportTool = true;
        state.completeTransportMode = parseRouteMode(parsed.mode);
        state.itinerary = await this.completeMissingTransportLegs(
          state.itinerary,
          state.completeTransportMode,
          state.traces,
          state.sessionId,
          state.diff,
          signal
        );
      } else if (toolName === "adjust_timing_conflict") {
        state.usedTransportTool = true;
        state.itinerary = this.applyTimingAdjustmentTool(
          state.itinerary,
          {
            dayId: String(parsed.dayId),
            fromActivityId: String(parsed.fromActivityId),
            toActivityId: String(parsed.toActivityId),
            strategy: parseTimingAdjustmentStrategyFromTool(parsed.strategy)
          },
          state.traces,
          state.sessionId,
          state.diff
        );
      } else if (toolName === "import_skill") {
        state.importedSkillIds = unique([...state.importedSkillIds, String(parsed.skillId)]);
        state.itinerary = this.itineraries.save({ ...state.itinerary, importedSkillIds: state.importedSkillIds });
        state.diff.push("已导入风格");
      } else if (toolName === "update_itinerary_details") {
        state.itinerary = this.applyItineraryDetailChanges(state.itinerary, parseItineraryDetailChanges(parsed), state.diff);
      } else if (toolName === "list_saved_memories") {
        return {
          status: "completed",
          title: "list_saved_memories 执行完成",
          summary: "已返回已保存记忆列表。",
          diff: [],
          output: { items: this.memories.list({ query: asOptionalString(parsed.query), limit: asOptionalNumber(parsed.limit) }) }
        };
      } else if (toolName === "create_saved_memory") {
        const memory = this.memories.create(String(parsed.content ?? ""));
        return {
          status: "completed",
          title: "create_saved_memory 执行完成",
          summary: `已新增记忆：${memory.content}`,
          diff: [],
          output: { memory }
        };
      } else if (toolName === "update_saved_memory") {
        const memory = this.memories.update(String(parsed.memoryId ?? ""), String(parsed.content ?? ""));
        return {
          status: "completed",
          title: "update_saved_memory 执行完成",
          summary: `已更新记忆：${memory.content}`,
          diff: [],
          output: { memory }
        };
      } else if (toolName === "delete_saved_memory") {
        this.memories.delete(String(parsed.memoryId ?? ""));
        return {
          status: "completed",
          title: "delete_saved_memory 执行完成",
          summary: "已删除指定记忆。",
          diff: [],
          output: { deleted: true }
        };
      } else if (toolName === "list_itineraries") {
        return {
          status: "completed",
          title: "list_itineraries 执行完成",
          summary: "已返回历史行程列表。",
          diff: [],
          output: { items: this.history.listItineraries({ query: asOptionalString(parsed.query), limit: asOptionalNumber(parsed.limit) }) }
        };
      } else if (toolName === "search_itinerary_conversations") {
        return {
          status: "completed",
          title: "search_itinerary_conversations 执行完成",
          summary: "已返回历史对话搜索结果。",
          diff: [],
          output: {
            items: this.history.searchConversations({
              keyword: String(parsed.keyword ?? ""),
              itineraryQuery: asOptionalString(parsed.itineraryQuery),
              limit: asOptionalNumber(parsed.limit)
            })
          }
        };
      } else if (toolName === "load_itinerary_conversation") {
        return {
          status: "completed",
          title: "load_itinerary_conversation 执行完成",
          summary: "已加载指定行程的完整对话时间线。",
          diff: [],
          output: this.history.loadConversation(String(parsed.itineraryId ?? ""))
        };
      } else if (toolName === "search_poi") {
        const items = await this.maps.searchPoi(String(parsed.query ?? ""), asOptionalString(parsed.city) ?? NATIONAL_POI_SEARCH_CITY);
        const limit = clampPositiveInt(asOptionalNumber(parsed.limit), 5, 20);
        return {
          status: "completed",
          title: "search_poi 执行完成",
          summary: items.length > 0 ? `已找到 ${Math.min(items.length, limit)} 个地点候选。` : "没有找到匹配地点。",
          diff: [],
          output: { items: items.slice(0, limit) }
        };
      } else if (toolName === "preview_transport_modes") {
        const from = await this.resolvePoiQuery(String(parsed.fromQuery ?? parsed.from ?? ""), asOptionalString(parsed.fromPoiName), signal);
        const to = await this.resolvePoiQuery(String(parsed.toQuery ?? parsed.to ?? ""), asOptionalString(parsed.toPoiName), signal);
        const originCity = from.poi.city?.trim() || undefined;
        const destinationCity = to.poi.city?.trim() || undefined;
        const crossCity = Boolean(originCity && destinationCity && originCity !== destinationCity);
        const userSpecifiedModes = Array.isArray(parsed.modes) && parsed.modes.length >= 2;
        // For intercity queries (e.g. 苏州站→上海站) the model usually wants
        // 高铁/动车 (transit with cityd) and driving fallback. Walking/cycling
        // across cities is meaningless and pollutes the comparison.
        const modes =
          crossCity && !userSpecifiedModes
            ? (["transit", "driving"] as MapRouteMode[])
            : parseRouteModesFromTool(parsed.modes);
        const strategy = parsed.strategy === "shortest" ? "shortest" : "fastest";
        const routes: RouteSummary[] = [];
        for (const mode of modes) {
          throwIfAborted(signal);
          routes.push(
            await this.maps.route(from.routePoint, to.routePoint, mode, {
              originCity,
              destinationCity
            })
          );
        }
        const ranked = routes
          .slice()
          .sort((left, right) =>
            strategy === "shortest"
              ? left.distanceMeters - right.distanceMeters || left.durationMinutes - right.durationMinutes
              : left.durationMinutes - right.durationMinutes || left.distanceMeters - right.distanceMeters
          );
        return {
          status: "completed",
          title: "preview_transport_modes 执行完成",
          summary: crossCity
            ? `已返回 ${ranked.length} 种跨城交通方式对比（${originCity ?? "?"} → ${destinationCity ?? "?"}）。`
            : `已返回 ${ranked.length} 种交通方式对比。`,
          diff: [],
          output: {
            from: summarizePoiCandidate(from.poi),
            to: summarizePoiCandidate(to.poi),
            strategy,
            crossCity,
            originCity,
            destinationCity,
            routes: ranked
          }
        };
      } else if (toolName === "get_day_weather") {
        const weather = await this.maps.weather(String(parsed.city ?? ""), String(parsed.date ?? ""));
        return {
          status: "completed",
          title: "get_day_weather 执行完成",
          summary: `已返回 ${weather.city} ${weather.date} 的天气。`,
          diff: [],
          output: { weather }
        };
      } else {
        const detail = `未知工具：${toolName}`;
        state.traces.push(this.trace(state.sessionId, "MainAgent", "error", "未知工具调用", detail));
        return {
          status: "failed",
          title: "工具调用失败",
          summary: detail,
          diff: [],
          output: { error: detail }
        };
      }
      const diff = state.diff.slice(diffStart);
      return {
        status: "completed",
        title: `${toolName} 执行完成`,
        summary: diff.length ? diff.join("；") : "工具已执行，未产生结构化改动。",
        diff,
        output: {
          diff,
          itinerary: summarizeItineraryForToolObservation(state.itinerary)
        }
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "工具执行失败";
      state.traces.push(this.trace(state.sessionId, toolAgent(toolName), "error", `${toolName} 执行失败`, detail));
      return {
        status: "failed",
        title: `${toolName} 执行失败`,
        summary: detail,
        diff: state.diff.slice(diffStart),
        output: { error: detail }
      };
    }
  }

  private applySinglePatchOperation(
    itinerary: TravelItinerary,
    importedSkillIds: string[],
    operation: ItineraryPatchOperation,
    diff: string[]
  ): TravelItinerary {
    const patched = applyItineraryPatch(
      {
        ...itinerary,
        importedSkillIds
      },
      {
        source: "agent",
        reason: "模型工具调用",
        operations: [operation]
      }
    );
    diff.push(...patched.diff);
    return this.itineraries.save(patched.itinerary);
  }

  private async resolveMissingPlaces(
    itinerary: TravelItinerary,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[],
    signal?: AbortSignal
  ): Promise<TravelItinerary> {
    let current = itinerary;
    for (const day of current.days) {
      for (const activity of day.activities) {
        throwIfAborted(signal);
        if (activity.source !== "agent" || !activity.placeName || activity.place?.coordinates) continue;
        const places = await this.maps.searchPoi(activity.placeName, activity.place?.city ?? NATIONAL_POI_SEARCH_CITY);
        throwIfAborted(signal);
        const place = places[0];
        if (!place) continue;
        current = this.itineraries.updateActivity(current.id, activity.id, {
          placeName: place.name,
          place: placeFromPoi(place)
        });
        traces.push(
          this.trace(
            sessionId,
            "AttractionAgent",
            "state_patch",
            "写入地点坐标",
            `${activity.title}：${place.name}，${place.address}`
          )
        );
        diff.push(`已解析地点：${place.name}`);
      }
    }
    return current;
  }

  private async resolvePoiQuery(query: string, poiName?: string, signal?: AbortSignal): Promise<{ poi: PoiResult; routePoint: string }> {
    throwIfAborted(signal);
    const candidates = await this.maps.searchPoi(query, NATIONAL_POI_SEARCH_CITY);
    throwIfAborted(signal);
    const selected =
      (poiName
        ? candidates.find((candidate) => candidate.name === poiName) ??
          candidates.find((candidate) => candidate.name.includes(poiName))
        : undefined) ?? candidates[0];
    if (!selected) throw new Error(`没有找到地点：${query}`);
    return {
      poi: selected,
      routePoint: `${selected.location.lng},${selected.location.lat}`
    };
  }

  private async applyPlaceActivityTool(
    itinerary: TravelItinerary,
    request: PlaceActivityToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[],
    signal?: AbortSignal
  ): Promise<TravelItinerary> {
    throwIfAborted(signal);
    const candidates = await this.maps.searchPoi(request.query, NATIONAL_POI_SEARCH_CITY);
    throwIfAborted(signal);
    const selected =
      (request.poiName
        ? candidates.find((candidate) => candidate.name === request.poiName) ??
          candidates.find((candidate) => candidate.name.includes(request.poiName!))
        : undefined) ?? candidates[0];
    if (!selected) {
      traces.push(this.trace(sessionId, "AttractionAgent", "error", "地点搜索失败", request.query));
      return itinerary;
    }
    const saved = this.itineraries.addActivity(
      itinerary.id,
      request.dayId,
      {
        type: request.type,
        title: request.title,
        placeName: selected.name,
        place: placeFromPoi(selected),
        startTime: request.startTime,
        endTime: request.endTime,
        description: request.description,
        budgetCny: request.budgetCny,
        tags: request.tags
      },
      "agent"
    );
    traces.push(
      this.trace(
        sessionId,
        "AttractionAgent",
        "state_patch",
        "搜索并加入地点",
        `${request.query} -> ${selected.name}，${selected.address}`
      )
    );
    diff.push(`已添加地点：${selected.name}`);
    return saved;
  }

  private async applyPlaceUpdateTool(
    itinerary: TravelItinerary,
    request: PlaceUpdateToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[],
    signal?: AbortSignal
  ): Promise<TravelItinerary> {
    throwIfAborted(signal);
    const candidates = await this.maps.searchPoi(request.query, NATIONAL_POI_SEARCH_CITY);
    throwIfAborted(signal);
    const selected =
      (request.poiName
        ? candidates.find((candidate) => candidate.name === request.poiName) ??
          candidates.find((candidate) => candidate.name.includes(request.poiName!))
        : undefined) ?? candidates[0];
    if (!selected) {
      traces.push(this.trace(sessionId, "AttractionAgent", "error", "地点替换失败", request.query));
      return itinerary;
    }
    const saved = this.itineraries.updateActivity(itinerary.id, request.activityId, {
      title: request.title ?? selected.name,
      type: request.type ?? inferActivityTypeFromPoi(selected, request.query),
      placeName: selected.name,
      place: placeFromPoi(selected)
    });
    traces.push(
      this.trace(
        sessionId,
        "AttractionAgent",
        "state_patch",
        "替换活动地点",
        `${request.query} -> ${selected.name}，${selected.address}`
      )
    );
    diff.push(`已更新地点：${selected.name}`);
    return saved;
  }

  private async applyTransportTool(
    itinerary: TravelItinerary,
    request: TransportToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff?: string[],
    signal?: AbortSignal
  ): Promise<TravelItinerary> {
    throwIfAborted(signal);
    const fromActivity = findActivityInItinerary(itinerary, request.fromActivityId);
    const toActivity = findActivityInItinerary(itinerary, request.toActivityId);
    if (!fromActivity || !toActivity) {
      traces.push(
        this.trace(
          sessionId,
          "TransportAgent",
          "error",
          "路线计算失败",
          `未找到活动：${request.fromActivityId} -> ${request.toActivityId}`
        )
      );
      return itinerary;
    }
    if (!canRouteActivityPair(fromActivity, toActivity)) {
      traces.push(
        this.trace(
          sessionId,
          "TransportAgent",
          "error",
          "路线计算跳过",
          "缺少明确的起点或终点"
        )
      );
      return itinerary;
    }
    const route = await this.maps.route(routePoint(fromActivity)!, routePoint(toActivity)!, request.mode);
    throwIfAborted(signal);
    const fromName = activityDisplayName(fromActivity);
    const toName = activityDisplayName(toActivity);
    const saved = this.itineraries.setTransportLeg(itinerary.id, request.dayId, {
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: route.mode,
      distanceMeters: route.distanceMeters,
      durationMinutes: route.durationMinutes,
      provider: route.source,
      routeStatus: route.status,
      summary: route.summary,
      polyline: route.polyline ?? [],
      steps: localizeRouteSteps(route.steps ?? [], route.source, route.mode, toName)
    });
    traces.push(
      this.trace(
        sessionId,
        "TransportAgent",
        "state_patch",
        "写入交通路线",
        `${fromName} 到 ${toName}：${route.durationMinutes} 分钟，${route.distanceMeters} 米`
      )
    );
    diff?.push(`已更新交通：${fromName} 到 ${toName}`);
    return saved;
  }

  private async applyTransportComparisonTool(
    itinerary: TravelItinerary,
    request: TransportComparisonToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[],
    signal?: AbortSignal
  ): Promise<TravelItinerary> {
    throwIfAborted(signal);
    const fromActivity = findActivityInItinerary(itinerary, request.fromActivityId);
    const toActivity = findActivityInItinerary(itinerary, request.toActivityId);
    if (!fromActivity || !toActivity || !canRouteActivityPair(fromActivity, toActivity)) {
      traces.push(
        this.trace(
          sessionId,
          "TransportAgent",
          "error",
          "交通方式比较失败",
          `无法计算活动路线：${request.fromActivityId} -> ${request.toActivityId}`
        )
      );
      return itinerary;
    }
    const routeCandidates: RouteSummary[] = [];
    for (const mode of request.modes) {
      throwIfAborted(signal);
      routeCandidates.push(await this.maps.route(routePoint(fromActivity)!, routePoint(toActivity)!, mode));
    }
    const selected = routeCandidates
      .slice()
      .sort((left, right) =>
        request.strategy === "shortest"
          ? left.distanceMeters - right.distanceMeters || left.durationMinutes - right.durationMinutes
          : left.durationMinutes - right.durationMinutes || left.distanceMeters - right.distanceMeters
      )[0];
    if (!selected) return itinerary;
    const fromName = activityDisplayName(fromActivity);
    const toName = activityDisplayName(toActivity);
    const saved = this.itineraries.setTransportLeg(itinerary.id, request.dayId, {
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: selected.mode,
      distanceMeters: selected.distanceMeters,
      durationMinutes: selected.durationMinutes,
      provider: selected.source,
      routeStatus: selected.status,
      summary: selected.summary,
      polyline: selected.polyline ?? [],
      steps: localizeRouteSteps(selected.steps ?? [], selected.source, selected.mode, toName)
    });
    traces.push(
      this.trace(
        sessionId,
        "TransportAgent",
        "state_patch",
        "比较交通方式",
        `${fromName} 到 ${toName}：${request.modes.map(formatRouteModeLabel).join("、")} -> ${formatRouteModeLabel(selected.mode)}`
      )
    );
    diff.push(
      `已比较交通方式：${request.modes.map(formatRouteModeLabel).join("、")}，已选择${formatRouteModeLabel(selected.mode)}`
    );
    return saved;
  }

  private applyTransportRemovalTool(
    itinerary: TravelItinerary,
    request: TransportRemovalToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): TravelItinerary {
    const fromActivity = findActivityInItinerary(itinerary, request.fromActivityId);
    const toActivity = findActivityInItinerary(itinerary, request.toActivityId);
    if (!fromActivity || !toActivity) {
      traces.push(
        this.trace(
          sessionId,
          "TransportAgent",
          "error",
          "取消交通失败",
          `未找到活动：${request.fromActivityId} -> ${request.toActivityId}`
        )
      );
      return itinerary;
    }
    const day = itinerary.days.find((candidate) => candidate.id === request.dayId);
    const exists = Boolean(
      day?.transportLegs?.some((leg) => leg.fromActivityId === fromActivity.id && leg.toActivityId === toActivity.id)
    );
    if (!exists) {
      traces.push(
        this.trace(
          sessionId,
          "TransportAgent",
          "message",
          "交通段未找到",
          `${activityDisplayName(fromActivity)} 到 ${activityDisplayName(toActivity)}`
        )
      );
      return itinerary;
    }
    const saved = this.itineraries.removeTransportLeg(itinerary.id, request.dayId, fromActivity.id, toActivity.id, "agent");
    const fromName = activityDisplayName(fromActivity);
    const toName = activityDisplayName(toActivity);
    traces.push(this.trace(sessionId, "TransportAgent", "state_patch", "取消交通段", `${fromName} 到 ${toName}`));
    diff.push(`已取消交通：${fromName} 到 ${toName}`);
    return saved;
  }

  private applyTimingAdjustmentTool(
    itinerary: TravelItinerary,
    request: TimingAdjustmentToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): TravelItinerary {
    const day = itinerary.days.find((candidate) => candidate.id === request.dayId);
    const fromActivity = day?.activities.find((activity) => activity.id === request.fromActivityId);
    const toActivity = day?.activities.find((activity) => activity.id === request.toActivityId);
    const leg = day?.transportLegs?.find(
      (candidate) => candidate.fromActivityId === request.fromActivityId && candidate.toActivityId === request.toActivityId
    );
    if (!day || !fromActivity || !toActivity || !leg) {
      traces.push(
        this.trace(
          sessionId,
          "PlannerAgent",
          "error",
          "时间修复失败",
          `未找到活动或交通段：${request.fromActivityId} -> ${request.toActivityId}`
        )
      );
      return itinerary;
    }
    const conflict = detectTransportTimingConflict(fromActivity, toActivity, leg);
    if (!conflict) {
      traces.push(
        this.trace(
          sessionId,
          "PlannerAgent",
          "message",
          "无需顺延活动",
          `${activityDisplayName(fromActivity)} 到 ${activityDisplayName(toActivity)} 没有晚到冲突`
        )
      );
      return itinerary;
    }
    if (request.strategy === "shorten_previous") {
      const shortenedEndTime = addMinutesToClockValue(toActivity.startTime, -leg.durationMinutes);
      const shortenedEndMinutes = clockValueToMinutes(shortenedEndTime);
      const fromStartMinutes = clockValueToMinutes(fromActivity.startTime);
      if (!shortenedEndTime || (fromStartMinutes !== undefined && shortenedEndMinutes !== undefined && shortenedEndMinutes <= fromStartMinutes)) {
        traces.push(
          this.trace(
            sessionId,
            "PlannerAgent",
            "error",
            "缩短停留失败",
            `${activityDisplayName(fromActivity)} 无法压缩到 ${shortenedEndTime ?? "可用时间"}`
          )
        );
        return itinerary;
      }
      const saved = this.itineraries.updateActivity(itinerary.id, fromActivity.id, {
        endTime: shortenedEndTime
      });
      traces.push(
        this.trace(
          sessionId,
          "PlannerAgent",
          "state_patch",
          "缩短上一站停留",
          `${activityDisplayName(fromActivity)}：${conflict.fromEndTime} -> ${shortenedEndTime}`
        )
      );
      diff.push(`已缩短停留：${activityDisplayName(fromActivity)} 到 ${shortenedEndTime}`);
      return saved;
    }
    if (request.strategy === "shift_downstream") {
      const startIndex = day.activities.findIndex((activity) => activity.id === toActivity.id);
      let current = itinerary;
      let shiftedCount = 0;
      for (const activity of day.activities.slice(Math.max(0, startIndex))) {
        const shiftedStartTime = addMinutesToClockValue(activity.startTime, conflict.delayMinutes);
        const shiftedEndTime = addMinutesToClockValue(activity.endTime, conflict.delayMinutes);
        if (!shiftedStartTime && !shiftedEndTime) continue;
        current = this.itineraries.updateActivity(current.id, activity.id, {
          startTime: shiftedStartTime ?? activity.startTime,
          endTime: shiftedEndTime ?? activity.endTime
        });
        shiftedCount += 1;
      }
      traces.push(
        this.trace(
          sessionId,
          "PlannerAgent",
          "state_patch",
          "顺延后续安排",
          `${activityDisplayName(toActivity)} 起 ${shiftedCount} 项顺延 ${conflict.delayMinutes} 分钟`
        )
      );
      if (shiftedCount > 0) {
        diff.push(`已顺延后续安排：${shiftedCount} 项，${activityDisplayName(toActivity)} 到 ${conflict.estimatedArrivalTime}`);
      }
      return current;
    }
    const shiftedEndTime = addMinutesToClockValue(toActivity.endTime, conflict.delayMinutes) ?? toActivity.endTime;
    const saved = this.itineraries.updateActivity(itinerary.id, toActivity.id, {
      startTime: conflict.estimatedArrivalTime,
      endTime: shiftedEndTime
    });
    traces.push(
      this.trace(
        sessionId,
        "PlannerAgent",
        "state_patch",
        "顺延受影响活动",
        `${activityDisplayName(toActivity)}：${conflict.nextStartTime} -> ${conflict.estimatedArrivalTime}`
      )
    );
    diff.push(`已顺延活动：${activityDisplayName(toActivity)} 到 ${conflict.estimatedArrivalTime}`);
    return saved;
  }

  private applyDeterministicWeather(
    itinerary: TravelItinerary,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): TravelItinerary {
    const day = itinerary.days[0];
    if (!day) return itinerary;
    const weather = {
      city: itinerary.destination,
      date: day.date,
      weather: "多云，适合户外步行",
      temperature: "24-30 C",
      source: "mock" as const
    };
    if (
      day.weather?.weather === weather.weather &&
      day.weather.temperature === weather.temperature &&
      day.weather.source === weather.source
    ) {
      traces.push(this.trace(sessionId, "WeatherAgent", "message", "确认天气摘要", `${day.title} 已有天气摘要`));
      return itinerary;
    }
    const saved = this.itineraries.setDayWeather(itinerary.id, day.id, weather, "agent");
    traces.push(this.trace(sessionId, "WeatherAgent", "state_patch", "写入天气摘要", `${day.title} ${weather.weather}`));
    diff.push(`已更新天气：Day 1 ${weather.weather}`);
    return saved;
  }

  private applyItineraryDetailChanges(
    itinerary: TravelItinerary,
    changes: ItineraryDetailChanges,
    diff: string[]
  ): TravelItinerary {
    const before = itinerary;
    const saved = this.itineraries.update(itinerary.id, changes);
    if (before.startDate !== saved.startDate || before.endDate !== saved.endDate) diff.push("已更新日期范围");
    if (before.destination !== saved.destination) diff.push("已更新出发点");
    if (before.budgetCny !== saved.budgetCny) diff.push("已更新预算");
    if (before.notes !== saved.notes) diff.push("已更新备注");
    if (before.companions.join("|") !== saved.companions.join("|")) diff.push("已更新同行人");
    return saved;
  }

  private syncMemoriesFromMessage(
    message: string,
    traces: AgentTraceEvent[],
    sessionId: string
  ): { created: SavedMemory[] } {
    const learnedPreferences = extractConversationMemories(message);
    if (!learnedPreferences.length) return { created: [] };
    const mutation = this.memories.upsertMany(learnedPreferences);
    if (mutation.created.length > 0) {
      traces.push(
        this.trace(sessionId, "MainAgent", "state_patch", "沉淀全局记忆", mutation.created.map((memory) => memory.content).join("、"))
      );
    }
    return mutation;
  }

  private async completeMissingTransportLegs(
    itinerary: TravelItinerary,
    mode: MapRouteMode,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[],
    signal?: AbortSignal
  ): Promise<TravelItinerary> {
    let current = itinerary;
    let completed = 0;
    for (const day of current.days) {
      for (const pair of getRoutePairsForDay(current, day)) {
        throwIfAborted(signal);
        if (!pair.exists) {
          current = await this.applyTransportTool(
            current,
            {
              dayId: day.id,
              fromActivityId: pair.fromActivity.id,
              toActivityId: pair.toActivity.id,
              mode
            },
            traces,
            sessionId,
            undefined,
            signal
          );
          completed += 1;
        }
      }
    }
    if (completed > 0) {
      diff.push(`已补全交通路线：${completed} 段`);
    }
    return current;
  }

  private trace(
    sessionId: string,
    agent: AgentName,
    type: AgentTraceEvent["type"],
    title: string,
    detail: string
  ): AgentTraceEvent {
    return {
      id: createId("trace"),
      sessionId,
      agent,
      type,
      title,
      detail,
      createdAt: nowIso()
    };
  }
}

type SkillInfluence = {
  skill: TravelSkill;
  rule: string;
};

function traceTypeToRunEventType(type: AgentTraceEvent["type"]): AgentRunEvent["type"] {
  if (type === "message") return "thought_summary";
  if (type === "tool_call") return "tool_call";
  if (type === "state_patch") return "state_patch";
  if (type === "handoff") return "handoff";
  return "error";
}

function chooseActivityTitle(message: string, skills: TravelSkill[], influence?: SkillInfluence): string {
  const ruleText = influence?.rule ?? "";
  if (ruleText.includes("雨天") && ruleText.includes("室内") && ruleText.includes("咖啡")) {
    return "雨天室内咖啡休息";
  }
  if (message.includes("咖啡")) return "街区咖啡与自由探索";
  if (message.includes("博物馆")) return "轻量博物馆与周边休息";
  if (skills.some((skill) => skill.displayName.includes("海边") || skill.rules.some((rule) => rule.includes("海边")))) {
    return "海边日落与小店探索";
  }
  return "慢节奏街区探索";
}

function chooseSkillInfluence(skills: TravelSkill[]): SkillInfluence | undefined {
  for (const skill of skills) {
    const rainCafeRule = skill.rules.find(
      (rule) => rule.includes("雨天") && rule.includes("室内") && rule.includes("咖啡")
    );
    if (rainCafeRule) return { skill, rule: rainCafeRule };
  }
  for (const skill of skills) {
    const firstRule = skill.rules.find(Boolean);
    if (firstRule) return { skill, rule: firstRule };
  }
  return undefined;
}

function chatCompletionTools() {
  return [
    {
      type: "function",
      function: {
        name: "add_activity",
        description: "向某一天添加一个结构化行程活动。",
        parameters: {
          type: "object",
          required: ["dayId", "type", "title"],
          properties: {
            dayId: { type: "string" },
            type: { type: "string", enum: ["lodging", "food", "transport", "attraction", "free_time"] },
            title: { type: "string" },
            placeName: { type: "string" },
            startTime: { type: "string" },
            endTime: { type: "string" },
            description: { type: "string" },
            budgetCny: { type: "number" },
            transportNote: { type: "string" },
            tags: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "add_place_activity",
        description: "搜索 POI 候选并把选中的地点作为活动加入某一天，适合用户要求加入具体景点、餐厅或地点时使用。",
        parameters: {
          type: "object",
          required: ["dayId", "query", "type", "title"],
          properties: {
            dayId: { type: "string" },
            query: { type: "string", description: "用于高德 POI 搜索的关键词" },
            poiName: { type: "string", description: "期望选择的 POI 名称；为空时使用第一个候选" },
            type: { type: "string", enum: ["lodging", "food", "transport", "attraction", "free_time"] },
            title: { type: "string" },
            startTime: { type: "string" },
            endTime: { type: "string" },
            description: { type: "string" },
            budgetCny: { type: "number" },
            tags: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_activity_place",
        description: "搜索 POI 候选并替换一个已有活动的地点、坐标和地点类型；适合用户要求把某个已有活动换成另一个景点、餐厅或地点时使用，不新增活动。",
        parameters: {
          type: "object",
          required: ["activityId", "query"],
          properties: {
            activityId: { type: "string" },
            query: { type: "string", description: "用于高德 POI 搜索的关键词" },
            poiName: { type: "string", description: "期望选择的 POI 名称；为空时使用第一个候选" },
            type: { type: "string", enum: ["lodging", "food", "transport", "attraction", "free_time"] },
            title: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_activity",
        description: "更新一个现有活动。不要覆盖用户锁定内容。",
        parameters: {
          type: "object",
          required: ["activityId", "changes"],
          properties: {
            activityId: { type: "string" },
            changes: { type: "object" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "remove_activity",
        description: "删除一个活动。",
        parameters: {
          type: "object",
          required: ["activityId"],
          properties: { activityId: { type: "string" } }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "move_activity",
        description: "移动一个活动到目标日期和位置。",
        parameters: {
          type: "object",
          required: ["activityId", "targetDayId", "targetIndex"],
          properties: {
            activityId: { type: "string" },
            targetDayId: { type: "string" },
            targetIndex: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "set_transport_leg",
        description: "计算并保存两个相邻活动之间的交通路线、距离和耗时。",
        parameters: {
          type: "object",
          required: ["dayId", "fromActivityId", "toActivityId", "mode"],
          properties: {
            dayId: { type: "string" },
            fromActivityId: { type: "string" },
            toActivityId: { type: "string" },
            mode: { type: "string", enum: ["walking", "transit", "driving", "cycling"] }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "compare_transport_modes",
        description: "比较两个相邻活动之间的多种交通方式，并保存最快或最短的路线；适合用户要求更快路线、比较交通方式或避免晚到时使用。",
        parameters: {
          type: "object",
          required: ["dayId", "fromActivityId", "toActivityId", "modes"],
          properties: {
            dayId: { type: "string" },
            fromActivityId: { type: "string" },
            toActivityId: { type: "string" },
            modes: {
              type: "array",
              items: { type: "string", enum: ["walking", "transit", "driving", "cycling"] },
              description: "候选交通方式；未确定时传入全部四种方式"
            },
            strategy: { type: "string", enum: ["fastest", "shortest"], description: "默认 fastest" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "remove_transport_leg",
        description: "取消两个相邻活动之间已保存的交通路线，但保留这两个活动；适合用户要求取消、删除或清除某一段交通时使用。",
        parameters: {
          type: "object",
          required: ["dayId", "fromActivityId", "toActivityId"],
          properties: {
            dayId: { type: "string" },
            fromActivityId: { type: "string" },
            toActivityId: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "complete_transport_legs",
        description: "补全当前行程中所有缺失的相邻活动交通路线、距离和耗时；适合用户要求检查或完成全程路线时使用。",
        parameters: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["walking", "transit", "driving", "cycling"], description: "默认 walking" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "adjust_timing_conflict",
        description: "当已保存的交通路线会导致到达下一项活动晚到时，按指定策略调整活动时间；需要先存在这两个活动之间的交通段。",
        parameters: {
          type: "object",
          required: ["dayId", "fromActivityId", "toActivityId", "strategy"],
          properties: {
            dayId: { type: "string" },
            fromActivityId: { type: "string" },
            toActivityId: { type: "string" },
            strategy: {
              type: "string",
              enum: ["delay_next", "shorten_previous", "shift_downstream"],
              description: "delay_next 顺延下一项；shorten_previous 缩短上一站；shift_downstream 顺延当天后续安排"
            }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_itinerary_details",
        description: "更新行程级规划信息。可以改出发点、日期范围、预算、备注和同行人；不要改行程名称。",
        parameters: {
          type: "object",
          properties: {
            destination: { type: "string" },
            startDate: { type: "string", description: "YYYY-MM-DD" },
            endDate: { type: "string", description: "YYYY-MM-DD" },
            budgetCny: { type: "number" },
            notes: { type: "string" },
            companions: { type: "array", items: { type: "string" } }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "import_skill",
        description: "将一个 Skill 导入当前行程上下文。",
        parameters: {
          type: "object",
          required: ["skillId"],
          properties: { skillId: { type: "string" } }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_saved_memories",
        description: "列出已保存记忆，可按关键词过滤；仅在需要精确编辑某条记忆时使用。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_saved_memory",
        description: "新增一条全局已保存记忆。",
        parameters: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_saved_memory",
        description: "更新一条已保存记忆的内容。",
        parameters: {
          type: "object",
          required: ["memoryId", "content"],
          properties: {
            memoryId: { type: "string" },
            content: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "delete_saved_memory",
        description: "删除一条已保存记忆。",
        parameters: {
          type: "object",
          required: ["memoryId"],
          properties: {
            memoryId: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_itineraries",
        description: "列出历史行程，适合用户提到过去某次行程但未给出精确标题时使用。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_itinerary_conversations",
        description: "按关键词搜索历史行程里的对话记录；仅在用户明显提到过去、之前、上次或历史内容时使用。",
        parameters: {
          type: "object",
          required: ["keyword"],
          properties: {
            keyword: { type: "string" },
            itineraryQuery: { type: "string" },
            limit: { type: "number" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "load_itinerary_conversation",
        description: "加载某个行程的完整对话时间线；仅在用户明确要求回看历史时使用。",
        parameters: {
          type: "object",
          required: ["itineraryId"],
          properties: {
            itineraryId: { type: "string" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "search_poi",
        description: "只读搜索 POI 候选，不改画布；适合确认地点是否存在、别名是否匹配、地址属于哪里时使用。",
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            city: { type: "string", description: "可选城市；默认全国" },
            limit: { type: "number", description: "默认 5，最大 20" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "preview_transport_modes",
        description: "只读比较两个地点之间的交通方式，不保存路线；适合用户只想查怎么走、哪种更快或更短时使用。",
        parameters: {
          type: "object",
          required: ["fromQuery", "toQuery"],
          properties: {
            fromQuery: { type: "string", description: "起点关键词" },
            fromPoiName: { type: "string", description: "期望选择的起点 POI 名称；为空时使用第一个候选" },
            toQuery: { type: "string", description: "终点关键词" },
            toPoiName: { type: "string", description: "期望选择的终点 POI 名称；为空时使用第一个候选" },
            modes: {
              type: "array",
              items: { type: "string", enum: ["walking", "transit", "driving", "cycling"] },
              description: "候选交通方式；未传时默认四种都比"
            },
            strategy: { type: "string", enum: ["fastest", "shortest"], description: "返回结果排序方式，默认 fastest" }
          }
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_day_weather",
        description: "只读获取某个城市某天的天气，不写入行程。",
        parameters: {
          type: "object",
          required: ["city", "date"],
          properties: {
            city: { type: "string" },
            date: { type: "string", description: "YYYY-MM-DD" }
          }
        }
      }
    }
  ];
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseActivityType(value: unknown): Activity["type"] {
  if (value === "lodging" || value === "food" || value === "transport" || value === "attraction" || value === "free_time") {
    return value;
  }
  return "free_time";
}

function inferActivityTypeFromText(text: string): Activity["type"] | undefined {
  if (/(景点|景区|寺|博物馆|美术馆|公园|展馆|attraction|museum|temple|park)/i.test(text)) return "attraction";
  if (/(餐厅|餐饮|饭店|美食|咖啡|茶|午餐|晚餐|早餐|food|restaurant|cafe|coffee)/i.test(text)) return "food";
  if (/(酒店|民宿|住宿|hotel|lodging)/i.test(text)) return "lodging";
  if (/(车站|机场|码头|地铁站|火车站|transport|station|airport)/i.test(text)) return "transport";
  return undefined;
}

function inferActivityTypeFromPoi(poi: PoiResult, query: string): Activity["type"] {
  const text = `${query} ${poi.name} ${poi.type ?? ""}`;
  return inferActivityTypeFromText(text) ?? "free_time";
}

function parseRouteMode(value: unknown): MapRouteMode {
  if (value === "walking" || value === "transit" || value === "driving" || value === "cycling") return value;
  return "walking";
}

function parseTimingAdjustmentStrategyFromTool(value: unknown): TimingAdjustmentStrategy {
  if (value === "delay_next" || value === "shorten_previous" || value === "shift_downstream") return value;
  return "delay_next";
}

function parseRouteModesFromTool(value: unknown): MapRouteMode[] {
  const modes = Array.isArray(value) ? value.map(parseRouteMode) : [];
  const uniqueModes = modes.filter((mode, index) => modes.indexOf(mode) === index);
  return uniqueModes.length >= 2 ? uniqueModes : ["walking", "transit", "driving", "cycling"];
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPositiveInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) return fallback;
  return Math.min(value, max);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseItineraryDetailChanges(parsed: Record<string, unknown>): ItineraryDetailChanges {
  const changes: ItineraryDetailChanges = {};
  const destination = asOptionalString(parsed.destination);
  const startDate = asOptionalString(parsed.startDate);
  const endDate = asOptionalString(parsed.endDate);
  const notes = asOptionalString(parsed.notes);
  const budgetCny = asOptionalNumber(parsed.budgetCny);
  const companions = asStringList(parsed.companions);
  if (destination) changes.destination = destination;
  if (startDate) changes.startDate = startDate;
  if (endDate) changes.endDate = endDate;
  if (budgetCny !== undefined) changes.budgetCny = budgetCny;
  if (notes) changes.notes = notes;
  if (companions.length > 0) changes.companions = companions;
  return changes;
}

function parseDeterministicItineraryDetails(
  itinerary: TravelItinerary,
  message: string,
  options: { activityScoped?: boolean } = {}
): ItineraryDetailChanges {
  const changes: ItineraryDetailChanges = {};
  const baseYear = Number(itinerary.startDate.slice(0, 4));
  const destination = extractDetailText(message, ["出发点", "起点", "目的地", "城市"]);
  const companions = parseDetailList(extractDetailText(message, ["同行人", "同行", "同伴", "出行人", "旅伴"]));
  const endDate = parseDetailDate(message, ["返回", "结束", "返程"], baseYear);
  const startDate = parseDetailDate(message, ["出发", "开始"], baseYear);
  const budgetMatch = options.activityScoped
    ? message.match(/(?:总预算|行程预算)(?:控制在|改到|改成|改为|设为|设置为|是)?\s*(\d+(?:\.\d+)?)/)
    : message.match(/预算(?:控制在|改到|设为|是)?\s*(\d+(?:\.\d+)?)/);
  const notesMatch = options.activityScoped
    ? message.match(/(?:行程备注|整体备注|总备注)(?:改成|改为|设为|设置为|是|[:：])?\s*([^。]+。?)/)
    : message.match(/备注[:：]?\s*([^。]+。?)/);
  if (destination) changes.destination = destination;
  if (companions.length > 0) changes.companions = companions;
  if (startDate) changes.startDate = startDate;
  if (endDate) changes.endDate = endDate;
  if (budgetMatch?.[1]) changes.budgetCny = Number(budgetMatch[1]);
  if (notesMatch?.[1]) changes.notes = notesMatch[1].trim();
  return changes;
}

function extractDetailText(message: string, labels: string[]): string | undefined {
  const labelPattern = `(?:${labels.join("|")})`;
  const match = new RegExp(`${labelPattern}(?:改成|改为|设为|设置为|是|到)?\\s*([^，。,.；;]+)`).exec(message);
  return sanitizeDetailText(match?.[1]);
}

function sanitizeDetailText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim().replace(/^(一个|一家|一处)\s*/, "").trim();
  return text.length > 0 ? text : undefined;
}

function parseDetailList(value: string | undefined): string[] {
  if (!value) return [];
  return unique(value.split(/、|，|,|\/|和|与|及|\+/).map((item) => item.trim()));
}

function parseDetailDate(message: string, labels: string[], baseYear: number): string | undefined {
  const labelPattern = `(?:${labels.join("|")})日期?`;
  const iso = new RegExp(`${labelPattern}(?:改到|设为|到)?\\s*(20\\d{2}-\\d{2}-\\d{2})`).exec(message)?.[1];
  if (iso) return iso;
  const natural = new RegExp(`${labelPattern}(?:改到|设为|到)?\\s*(?:(20\\d{2})\\s*年\\s*)?(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*(?:日|号)?`).exec(message);
  if (!natural?.[2] || !natural[3]) return undefined;
  const year = Number(natural[1] ?? baseYear);
  const month = Number(natural[2]);
  const day = Number(natural[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDeterministicActivityUpdates(itinerary: TravelItinerary, message: string): ItineraryPatchOperation[] {
  const target = findMentionedActivity(itinerary, message);
  if (!target) return [];
  const changes: Partial<Activity> = {};
  const timeMatch = message.match(/(\d{1,2}:\d{2})\s*(?:-|－|—|~|到|至)\s*(\d{1,2}:\d{2})/);
  const budgetMatch = message.match(/预算(?:控制在|改到|改成|改为|设为|设置为|是)?\s*(\d+(?:\.\d+)?)/);
  const noteMatch = message.match(/备注(?:改成|改为|设为|设置为|是|[:：])?\s*([^。]+。?)/);
  if (timeMatch?.[1] && timeMatch[2]) {
    changes.startTime = normalizeClockTime(timeMatch[1]);
    changes.endTime = normalizeClockTime(timeMatch[2]);
  }
  if (budgetMatch?.[1]) {
    changes.budgetCny = Number(budgetMatch[1]);
  }
  if (noteMatch?.[1]) {
    changes.note = noteMatch[1].trim();
  }
  if (Object.keys(changes).length === 0) return [];
  return [
    {
      type: "updateActivity",
      activityId: target.id,
      changes
    }
  ];
}

function parseDeterministicActivityMoves(itinerary: TravelItinerary, message: string): ItineraryPatchOperation[] {
  if (!/(移到|移动到|挪到|调到|放到|排到)/.test(message)) return [];
  const target = findMentionedActivity(itinerary, message);
  if (!target) return [];
  const targetDay = findTargetDayFromMessage(itinerary, message);
  if (!targetDay) return [];
  const targetIndex = parseTargetIndexFromMessage(message);
  return [
    {
      type: "moveActivity",
      activityId: target.id,
      targetDayId: targetDay.id,
      targetIndex
    }
  ];
}

function parseDeterministicActivityRemovals(itinerary: TravelItinerary, message: string): ItineraryPatchOperation[] {
  if (!/(删除|删掉|去掉|移除|拿掉|取消|不安排|不用安排|delete|remove|cancel)/i.test(message)) return [];
  const mentioned = findMentionedActivitiesInOrder(itinerary, message);
  const transportScoped = mentioned.length >= 2 && /(交通|路线|路段|route|transport|leg)/i.test(message);
  if (transportScoped) return [];
  const target = mentioned.sort((left, right) => right.matchedName.length - left.matchedName.length)[0]?.activity;
  if (!target) return [];
  return [
    {
      type: "removeActivity",
      activityId: target.id
    }
  ];
}

function parseDeterministicPlaceActivityRequests(itinerary: TravelItinerary, message: string): PlaceActivityToolRequest[] {
  if (!hasExplicitActivityCreationIntent(message)) return [];
  const query = extractExplicitPlaceActivityQuery(message);
  if (!query) return [];
  const targetDay = findTargetDayFromMessage(itinerary, message) ?? itinerary.days[0];
  if (!targetDay) return [];
  const timeRange = parseActivityTimeRangeFromMessage(message);
  return [
    {
      dayId: targetDay.id,
      query,
      poiName: query,
      type: inferActivityTypeFromText(`${message} ${query}`) ?? "attraction",
      title: query,
      startTime: timeRange?.startTime,
      endTime: timeRange?.endTime,
      description: "已根据你的描述搜索并加入地点，可继续手动调整。",
      tags: ["地点搜索"]
    }
  ];
}

function extractExplicitPlaceActivityQuery(message: string): string | undefined {
  const patterns = [
    /(?:添加|加入|新增|安排|加上|加)\s*(?:一个|一家|一处)?\s*([^，。,.；;]+)/i,
    /(?:去|到)\s*([^，。,.；;]+?)(?:并|然后|再|顺便|同时|$)/i
  ];
  for (const pattern of patterns) {
    const query = sanitizeExplicitPlaceActivityQuery(pattern.exec(message)?.[1]);
    if (query) return query;
  }
  return undefined;
}

function sanitizeExplicitPlaceActivityQuery(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const query = value
    .split(/(?:并|然后|再|顺便|同时)/)[0]
    ?.replace(/^(一个|一家|一处|去|到)\s*/, "")
    .replace(/(?:景点|地点|活动|备选|候选)$/, "")
    .trim();
  if (!query || query.length < 2) return undefined;
  if (/^(上午|下午|晚上|中午|早上|傍晚|景点|地点|活动|备选|候选)$/.test(query)) return undefined;
  if (/(路线|交通|路程|距离|耗时)$/.test(query)) return undefined;
  return query;
}

function parseActivityTimeRangeFromMessage(message: string): { startTime?: string; endTime?: string } | undefined {
  const range = message.match(/(\d{1,2})(?::(\d{2}))?\s*(?:-|－|—|~|到|至)\s*(\d{1,2})(?::(\d{2}))?/);
  if (range?.[1] && range[3]) {
    return {
      startTime: normalizeClockTime(`${range[1]}:${range[2] ?? "00"}`),
      endTime: normalizeClockTime(`${range[3]}:${range[4] ?? "00"}`)
    };
  }
  if (/早上|上午/.test(message)) return { startTime: "09:00", endTime: "11:00" };
  if (/中午|午餐/.test(message)) return { startTime: "12:00", endTime: "13:30" };
  if (/下午/.test(message)) return { startTime: "15:00", endTime: "17:00" };
  if (/傍晚|日落/.test(message)) return { startTime: "17:30", endTime: "19:00" };
  if (/晚上|晚餐|夜游/.test(message)) return { startTime: "19:00", endTime: "21:00" };
  return undefined;
}

function parseDeterministicPlaceUpdates(itinerary: TravelItinerary, message: string): PlaceUpdateToolRequest[] {
  if (!/(换成|换为|替换成|替换为|改成|改为|改去|换到|replace with|change to)/i.test(message)) return [];
  const target = findMentionedActivity(itinerary, message);
  if (!target) return [];
  const query = extractReplacementPlaceQuery(message);
  if (!query) return [];
  const type = inferActivityTypeFromText(`${message} ${query}`);
  return [
    {
      activityId: target.id,
      query,
      type,
      title: query
    }
  ];
}

function extractReplacementPlaceQuery(message: string): string | undefined {
  const primaryPatterns = [
    /(?:换成|换为|替换成|替换为|改去|换到)\s*([^，。,.；;]+)/i,
    /(?:replace with|change to)\s+([^，。,.；;]+)/i
  ];
  for (const pattern of primaryPatterns) {
    const raw = pattern.exec(message)?.[1]?.trim();
    const query = sanitizeReplacementPlaceQuery(raw);
    if (query) return query;
  }
  if (/(备注|预算|交通|路线|路段|方式)[^，。,.；;]*(?:改成|改为)/.test(message)) return undefined;
  const secondaryRaw = /(?:改成|改为)\s*([^，。,.；;]+)/i.exec(message)?.[1]?.trim();
  const secondaryQuery = sanitizeReplacementPlaceQuery(secondaryRaw);
  if (secondaryQuery && inferActivityTypeFromText(secondaryQuery)) return secondaryQuery;
  return undefined;
}

function sanitizeReplacementPlaceQuery(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const query = value.replace(/^(一个|一家|一处|去|到)\s*/, "").trim();
  if (!query || query.length < 2) return undefined;
  if (/^\d{1,2}:\d{2}/.test(query)) return undefined;
  if (/^(景点|景区|餐厅|餐饮|咖啡|酒店|住宿|自由活动|活动|地点)$/.test(query)) return undefined;
  if (/^(公交|地铁|公交\/地铁|公共交通|步行|走路|驾车|打车|骑行)$/.test(query)) return undefined;
  return query;
}

function findTargetDayFromMessage(itinerary: TravelItinerary, message: string): { id: string; activities: Activity[] } | undefined {
  const dayMatch = message.match(/(?:Day|第)\s*(\d+)\s*(?:天)?/i);
  if (dayMatch?.[1]) {
    return itinerary.days[Number(dayMatch[1]) - 1];
  }
  return itinerary.days.find((day) => message.includes(day.title));
}

function parseTargetIndexFromMessage(message: string): number {
  if (/(第一项|第一个|最前|开头|上午第一项)/.test(message)) return 0;
  if (/(最后|末尾)/.test(message)) return Number.MAX_SAFE_INTEGER;
  const indexMatch = message.match(/第\s*(\d+)\s*(?:项|个|站)/);
  return indexMatch?.[1] ? Math.max(0, Number(indexMatch[1]) - 1) : Number.MAX_SAFE_INTEGER;
}

function parseDeterministicTransportRequests(itinerary: TravelItinerary, message: string): TransportToolRequest[] {
  const mode = parseRouteModeFromMessage(message);
  if (!mode) return [];
  const mentioned = findMentionedActivitiesInOrder(itinerary, message);
  if (mentioned.length < 2) return [];
  const [from, to] = mentioned;
  if (!from || !to) return [];
  const day = itinerary.days.find((candidate) =>
    candidate.activities.some((activity) => activity.id === from.activity.id) &&
    candidate.activities.some((activity) => activity.id === to.activity.id)
  );
  if (!day) return [];
  return [
    {
      dayId: day.id,
      fromActivityId: from.activity.id,
      toActivityId: to.activity.id,
      mode
    }
  ];
}

function parseDeterministicTransportComparisonRequests(itinerary: TravelItinerary, message: string): TransportComparisonToolRequest[] {
  if (!/(比较|对比|选.*(?:最快|最短|更快|更近|合适)|最快|最短|更快|更近|compare|fastest|shortest|best)/i.test(message)) return [];
  if (!/(交通|路线|路段|怎么走|步行|公交|地铁|驾车|骑行|route|transport|walk|bus|metro|drive|bike)/i.test(message)) return [];
  const modes = parseRouteModesFromMessage(message);
  const comparisonModes = modes.length >= 2 ? modes : (["walking", "transit", "driving", "cycling"] satisfies MapRouteMode[]);
  if (comparisonModes.length < 2) return [];
  const mentioned = findMentionedActivitiesInOrder(itinerary, message);
  if (mentioned.length < 2) return [];
  const [from, to] = mentioned;
  if (!from || !to) return [];
  const day = itinerary.days.find((candidate) =>
    candidate.activities.some((activity) => activity.id === from.activity.id) &&
    candidate.activities.some((activity) => activity.id === to.activity.id)
  );
  if (!day) return [];
  return [
    {
      dayId: day.id,
      fromActivityId: from.activity.id,
      toActivityId: to.activity.id,
      modes: comparisonModes,
      strategy: /(最短|更近|距离|shortest)/i.test(message) ? "shortest" : "fastest"
    }
  ];
}

function parseDeterministicTransportRemovalRequests(itinerary: TravelItinerary, message: string): TransportRemovalToolRequest[] {
  if (!/(取消|删除|删掉|去掉|移除|清除|不要|不用|remove|delete|cancel|clear)/i.test(message)) return [];
  if (!/(交通|路线|路段|route|transport|leg)/i.test(message)) return [];
  const mentioned = findMentionedActivitiesInOrder(itinerary, message);
  if (mentioned.length < 2) return [];
  const [from, to] = mentioned;
  if (!from || !to) return [];
  const day = itinerary.days.find((candidate) =>
    candidate.activities.some((activity) => activity.id === from.activity.id) &&
    candidate.activities.some((activity) => activity.id === to.activity.id)
  );
  if (!day) return [];
  return [
    {
      dayId: day.id,
      fromActivityId: from.activity.id,
      toActivityId: to.activity.id
    }
  ];
}

function parseDeterministicTimingAdjustmentRequests(itinerary: TravelItinerary, message: string): TimingAdjustmentToolRequest[] {
  if (!/(晚到|来不及|延后|顺延|推迟|时间冲突|预计到达|迟到|delay|late|conflict)/i.test(message)) return [];
  const mentioned = findMentionedActivitiesInOrder(itinerary, message);
  if (mentioned.length < 2) return [];
  const [from, to] = mentioned;
  if (!from || !to) return [];
  const day = itinerary.days.find((candidate) =>
    candidate.activities.some((activity) => activity.id === from.activity.id) &&
    candidate.activities.some((activity) => activity.id === to.activity.id)
  );
  if (!day) return [];
  return [
    {
      dayId: day.id,
      fromActivityId: from.activity.id,
      toActivityId: to.activity.id,
      strategy: parseTimingAdjustmentStrategy(message)
    }
  ];
}

type RouteConflictProposal = {
  content: string;
  traceDetail: string;
};

function buildRouteConflictProposal(itinerary: TravelItinerary, message: string): RouteConflictProposal | undefined {
  if (!isRouteConflictProposalRequest(message)) return undefined;
  const mentioned = findMentionedActivitiesInOrder(itinerary, message);
  if (mentioned.length < 2) return undefined;
  const [from, to] = mentioned;
  if (!from || !to) return undefined;
  const day = itinerary.days.find((candidate) =>
    candidate.activities.some((activity) => activity.id === from.activity.id) &&
    candidate.activities.some((activity) => activity.id === to.activity.id)
  );
  const leg = day?.transportLegs?.find(
    (candidate) => candidate.fromActivityId === from.activity.id && candidate.toActivityId === to.activity.id
  );
  if (!day || !leg) return undefined;
  const conflict = detectTransportTimingConflict(from.activity, to.activity, leg);
  if (!conflict) return undefined;
  const fromName = activityDisplayName(from.activity);
  const toName = activityDisplayName(to.activity);
  const routeName = `${fromName} 到 ${toName}`;
  return {
    traceDetail: `${routeName}：预计 ${conflict.estimatedArrivalTime} 到达，晚于 ${conflict.nextStartTime}`,
    content: [
      `${routeName} 这段路线会在 ${conflict.estimatedArrivalTime} 左右到达，晚于 ${toName} 的 ${conflict.nextStartTime}。`,
      "",
      "可选方案：",
      `1. 顺延下一项：把 ${toName} 调整到 ${conflict.estimatedArrivalTime} 开始，后续时间不自动改变。`,
      `2. 缩短上一站：把 ${fromName} 提前结束，保留 ${toName} 原开始时间。`,
      "3. 改用更快交通方式：比较步行、公交/地铁、驾车和骑行，选择耗时最短的一种，不改活动时间。",
      "",
      "你选其中一种后，我再更新画布。"
    ].join("\n")
  };
}

function isRouteConflictProposalRequest(message: string): boolean {
  const routeConflict = /(晚到|来不及|时间冲突|预计到达|迟到|late|conflict)/i.test(message);
  const asksForOptions = /(方案|选项|建议|怎么处理|怎么办|如何处理|怎么调整|给我.*(?:几个|多个)|取舍|选择)/i.test(message);
  const explicitlyReadOnly = /(先|暂时|现在)?(?:别|不要|先不|暂时不|不急着).*(改|修改|更新|应用|落地|写入|画布)/.test(message);
  const directMutation = /(帮我|直接|就).*(延后|顺延|推迟|缩短|压缩|换.*更快|改用.*更快|整体顺延)/.test(message);
  return routeConflict && (asksForOptions || explicitlyReadOnly) && !directMutation;
}

function parseTimingAdjustmentStrategy(message: string): TimingAdjustmentStrategy {
  if (/(整体|全部|全都|一起|后续|后面|后面的|接下来|后续安排).*(顺延|延后|后移|推迟)|((顺延|延后|后移|推迟).*(整体|全部|全都|一起|后续|后面|后面的|接下来|后续安排))/.test(message)) {
    return "shift_downstream";
  }
  if (/(缩短|压缩|少待|减少.*停留|提前.*结束|上一站|上一项|前一项|上一个)/.test(message)) return "shorten_previous";
  return "delay_next";
}

function parseRouteModesFromMessage(message: string): MapRouteMode[] {
  const modes: MapRouteMode[] = [];
  const add = (mode: MapRouteMode) => {
    if (!modes.includes(mode)) modes.push(mode);
  };
  if (/(步行|走路|徒步|walk|walking|on foot)/i.test(message)) add("walking");
  if (/(公交|地铁|公共交通|巴士|大巴|bus|metro|subway|transit|public transport)/i.test(message)) add("transit");
  if (/(驾车|开车|打车|出租车|网约车|自驾|drive|driving|taxi|cab|rideshare)/i.test(message)) add("driving");
  if (/(骑行|单车|自行车|bike|bicycle|cycling)/i.test(message)) add("cycling");
  return modes;
}

function parseRouteModeFromMessage(message: string): MapRouteMode | undefined {
  if (/(公交|地铁|公共交通|巴士|大巴)/.test(message)) return "transit";
  if (/(驾车|开车|打车|出租车|网约车|自驾)/.test(message)) return "driving";
  if (/(骑行|单车|自行车)/.test(message)) return "cycling";
  if (/(步行|走路|徒步)/.test(message)) return "walking";
  if (/(bus|metro|subway|transit|public transport)/i.test(message)) return "transit";
  if (/(drive|driving|taxi|cab|rideshare)/i.test(message)) return "driving";
  if (/(bike|bicycle|cycling)/i.test(message)) return "cycling";
  if (/(walk|walking|on foot)/i.test(message)) return "walking";
  return undefined;
}

function findMentionedActivity(itinerary: TravelItinerary, message: string): Activity | undefined {
  return findMentionedActivitiesInOrder(itinerary, message)
    .sort((left, right) => right.matchedName.length - left.matchedName.length)[0]?.activity;
}

function findMentionedActivitiesInOrder(
  itinerary: TravelItinerary,
  message: string
): Array<{ activity: Activity; matchedName: string; position: number }> {
  return itinerary.days
    .flatMap((day) => day.activities)
    .flatMap((activity) => {
      const match = activityMentionMatch(activity, message);
      return match ? [{ activity, ...match }] : [];
    })
    .sort((left, right) => left.position - right.position || right.matchedName.length - left.matchedName.length);
}

function activityMentionMatch(activity: Activity, message: string): { matchedName: string; position: number } | undefined {
  const names = [activity.title, activity.placeName, activity.place?.name]
    .map((name) => name?.trim())
    .filter((name): name is string => typeof name === "string" && name.length >= 2)
    .sort((left, right) => right.length - left.length);
  const matches = names
    .map((name) => ({ matchedName: name, position: message.indexOf(name) }))
    .filter((match) => match.position >= 0)
    .sort((left, right) => left.position - right.position || right.matchedName.length - left.matchedName.length);
  return matches[0];
}

function normalizeClockTime(value: string): string {
  const [hour = "0", minute = "00"] = value.split(":");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function isDeterministicRouteOnlyRequest(message: string): boolean {
  const routeIntent = /(路线|交通|路程|距离|耗时|怎么走|出行|步行|公交|地铁|驾车|骑行|打车)/.test(message);
  const routeScope = /(所有|全部|全程|每段|相邻|景点之间|地点之间|活动之间)/.test(message);
  const routeAction = /(补全|计算|检查|完成|规划|更新|重新计算)/.test(message);
  return routeIntent && (routeScope || routeAction) && !hasExplicitActivityCreationIntent(message);
}

function hasRouteCompletionIntent(message: string): boolean {
  const routeWords =
    /(?:路线|交通|路程|距离|耗时|怎么走|相邻|全程|每段|routes?|transport|legs?|distance|duration|adjacent stops?)/i;
  const completionWords = /(?:补全|完成|计算|规划|检查|更新|重新计算|接上|串联|衔接|complete|fill|connect|plan|calculate|route)/i;
  return routeWords.test(message) && completionWords.test(message);
}

function shouldAddDeterministicActivity(
  message: string,
  detailChanges: ItineraryDetailChanges,
  routeOnlyIntent: boolean,
  editingExistingActivity = false
): boolean {
  if (editingExistingActivity) return false;
  if (routeOnlyIntent) return false;
  const hasDetailChanges = Object.keys(detailChanges).length > 0;
  const detailOnlyAction = hasDetailChanges && !hasExplicitActivityCreationIntent(message);
  if (detailOnlyAction) return false;
  return hasExplicitActivityCreationIntent(message);
}

function hasExplicitActivityCreationIntent(message: string): boolean {
  return (
    /(安排|添加|加入|新增|补一个|补充一个|加一个|推荐一个|找一个).*(活动|景点|博物馆|咖啡|餐厅|小店|citywalk|散步|休息|备选|候选)/i.test(message) ||
    /(备选|候选)/.test(message) ||
    /(?:Day|第)\s*\d+\s*(?:天)?\s*(上午|下午|晚上|中午|早上|傍晚)/i.test(message) ||
    /(室内景点|室内活动)/.test(message)
  );
}

function toolAgent(toolName: string): AgentName {
  if (toolName.includes("skill")) return "StyleAgent";
  if (toolName.includes("weather")) return "WeatherAgent";
  if (toolName.includes("transport") || toolName.includes("route")) return "TransportAgent";
  if (toolName.includes("place") || toolName.includes("poi")) return "AttractionAgent";
  if (toolName.includes("timing") || toolName.includes("conflict")) return "PlannerAgent";
  if (toolName.includes("activity") || toolName.includes("move")) return "PlannerAgent";
  return "MainAgent";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentRunAbortedError();
}

function findActivityInItinerary(itinerary: TravelItinerary, activityId: string): Activity | undefined {
  for (const day of itinerary.days) {
    const activity = day.activities.find((candidate) => candidate.id === activityId);
    if (activity) return activity;
  }
  return undefined;
}

function routePoint(activity: Activity): string | undefined {
  if (activity.place?.coordinates) {
    return `${activity.place.coordinates.lng},${activity.place.coordinates.lat}`;
  }
  return activity.placeName?.trim() || activity.place?.name?.trim() || activity.title.trim() || undefined;
}

function getRoutePairsForDay(
  itinerary: TravelItinerary,
  day: ItineraryDay
): Array<{ fromActivity: Activity; toActivity: Activity; exists: boolean }> {
  const pairs: Array<{ fromActivity: Activity; toActivity: Activity; exists: boolean }> = [];
  const dayIndex = itinerary.days.findIndex((candidate) => candidate.id === day.id);
  const previousDay = dayIndex > 0 ? itinerary.days[dayIndex - 1] : undefined;
  const overnightStart = previousDay?.activities.at(-1);
  const firstActivity = day.activities[0];
  if (overnightStart && firstActivity && canRouteActivityPair(overnightStart, firstActivity)) {
    pairs.push({
      fromActivity: overnightStart,
      toActivity: firstActivity,
      exists: hasTransportLeg(day, overnightStart.id, firstActivity.id)
    });
  }
  day.activities.forEach((activity, index) => {
    const next = day.activities[index + 1];
    if (!next || !canRouteActivityPair(activity, next)) return;
    pairs.push({
      fromActivity: activity,
      toActivity: next,
      exists: hasTransportLeg(day, activity.id, next.id)
    });
  });
  return pairs;
}

function hasTransportLeg(day: ItineraryDay, fromActivityId: string, toActivityId: string): boolean {
  return (day.transportLegs ?? []).some((leg) => leg.fromActivityId === fromActivityId && leg.toActivityId === toActivityId);
}

function canRouteActivityPair(from: Activity, to: Activity): boolean {
  return Boolean(routePoint(from) && routePoint(to));
}

function activityDisplayName(activity: Activity): string {
  return activity.title.trim() || activity.placeName?.trim() || activity.place?.name?.trim() || "未命名活动";
}

function formatRouteModeLabel(mode: MapRouteMode): string {
  const labels: Record<MapRouteMode, string> = {
    walking: "步行",
    transit: "公交/地铁",
    driving: "驾车",
    cycling: "骑行"
  };
  return labels[mode];
}

function addMinutesToClockValue(value: string | undefined, minutes: number): string | undefined {
  if (!value) return undefined;
  const clockMinutes = clockValueToMinutes(value);
  if (clockMinutes === undefined) return undefined;
  const total = ((clockMinutes + minutes) % 1440 + 1440) % 1440;
  const nextHours = Math.floor(total / 60).toString().padStart(2, "0");
  const nextMinutes = (total % 60).toString().padStart(2, "0");
  return `${nextHours}:${nextMinutes}`;
}

function clockValueToMinutes(value: string | undefined): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(mins) || hours > 23 || mins > 59) return undefined;
  return hours * 60 + mins;
}

function localizeRouteSteps(
  steps: RouteStep[],
  source: "amap" | "mock",
  mode: MapRouteMode,
  toTitle: string
): RouteStep[] {
  const normalized = steps.map((step) => ({ ...step, polyline: step.polyline ?? [] }));
  if (source !== "mock" || normalized.length !== 1) return normalized;
  return [
    {
      ...normalized[0]!,
      instruction: `${routeActionLabel(mode)}前往${toTitle}`
    }
  ];
}

function routeActionLabel(mode: MapRouteMode): string {
  const labels: Record<MapRouteMode, string> = {
    walking: "步行",
    transit: "公交/地铁",
    driving: "驾车",
    cycling: "骑行"
  };
  return labels[mode];
}

function placeFromPoi(poi: PoiResult): Place {
  return {
    poiId: poi.id,
    name: poi.name,
    address: poi.address,
    city: poi.city,
    district: poi.district,
    type: poi.type,
    typeCode: poi.typeCode,
    phone: poi.phone,
    openingHours: poi.openingHours,
    averageCostCny: poi.averageCostCny,
    photos: poi.photos,
    coordinates: poi.location
  };
}

function summarizeSession(
  message: string,
  itinerary: TravelItinerary,
  skillNames: string[],
  memorySnapshotText: string
): string {
  return [
    `用户请求：${message}`,
    `当前行程：${itinerary.title}，出发点 ${itinerary.destination}，${itinerary.days.length} 天`,
    skillNames.length ? `已融合 Skill：${skillNames.join("、")}` : "未导入 Skill",
    memorySnapshotText !== "暂无已保存记忆" ? `已注入记忆：${memorySnapshotText}` : undefined
  ]
    .filter(Boolean)
    .join("；");
}

function extractConversationMemories(message: string): string[] {
  if (isPreferenceRemovalRequest(message)) return [];
  const explicit = parseDetailList(extractDetailText(message, ["旅行偏好", "偏好", "喜好", "风格"]));
  const hasPreferenceCue = /(偏好|喜好|喜欢|不喜欢|讨厌|希望|以后|后续|下次|每次|总是|优先|尽量|避免|避开|不要|少一点|多一点)/.test(message);
  const durableTokens = [
    "慢节奏",
    "不赶路",
    "少走路",
    "少排队",
    "亲子",
    "儿童友好",
    "预算敏感",
    "低预算",
    "室内优先",
    "避开人多",
    "轻松",
    "早睡",
    "晚起"
  ];
  const interestTokens = [
    "咖啡",
    "citywalk",
    "博物馆",
    "园林",
    "夜景",
    "海边",
    "日落",
    "小店",
    "拍照",
    "购物",
    "甜品",
    "餐饮休息",
    "雨天室内",
    "室内"
  ];
  const negativeCue = /(不喜欢|讨厌|避免|避开|不要|少一点|少安排)/.test(message);
  const learned = [...explicit];
  for (const token of durableTokens) {
    if (message.includes(token)) learned.push(negativeCue && !token.startsWith("避") && !token.startsWith("少") ? `避免${token}` : token);
  }
  if (hasPreferenceCue) {
    for (const token of interestTokens) {
      if (message.includes(token)) learned.push(negativeCue ? `避免${token}` : token);
    }
  }
  return unique(learned).filter((item) => item.length <= 24);
}

function isPreferenceRemovalRequest(message: string): boolean {
  return /(删除|移除|清除|去掉|取消).{0,8}(偏好|喜好|风格|记忆)/.test(message);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readAgentMaxTurns(): number {
  const configured = Number(process.env.AGENT_MAX_TURNS);
  if (Number.isInteger(configured) && configured > 0) return Math.min(configured, 50);
  return 12;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

function summarizeToolInput(toolName: string, parsed: Record<string, unknown>): string {
  if (toolName === "add_place_activity") return `搜索并加入 ${String(parsed.poiName ?? parsed.query ?? parsed.title ?? "地点")}`;
  if (toolName === "search_poi") return `只读搜索 ${String(parsed.query ?? "地点")}`;
  if (toolName === "preview_transport_modes") {
    return `只读比较 ${String(parsed.fromQuery ?? parsed.from ?? "起点")} 到 ${String(parsed.toQuery ?? parsed.to ?? "终点")}`;
  }
  if (toolName === "get_day_weather") return `只读查询 ${String(parsed.city ?? "城市")} ${String(parsed.date ?? "日期")} 的天气`;
  if (toolName === "add_activity") return `新增 ${String(parsed.title ?? "活动")}`;
  if (toolName === "complete_transport_legs") return `补全交通路线：${String(parsed.mode ?? "walking")}`;
  if (toolName.includes("transport")) return "处理交通路线";
  if (toolName.includes("activity")) return "处理活动";
  return "执行模型工具调用";
}

function summarizePoiCandidate(poi: PoiResult): Record<string, unknown> {
  return {
    id: poi.id,
    name: poi.name,
    address: poi.address,
    city: poi.city,
    district: poi.district,
    type: poi.type,
    openingHours: poi.openingHours,
    averageCostCny: poi.averageCostCny
  };
}

function compactTechnicalValue(value: unknown): unknown {
  let json = "";
  try {
    json = JSON.stringify(value);
  } catch {
    return String(value).slice(0, 1200);
  }
  if (!json || json.length <= 1200) return value;
  return `${json.slice(0, 1200)}...`;
}

function summarizeItineraryForToolObservation(itinerary: TravelItinerary) {
  return {
    title: itinerary.title,
    departurePoint: itinerary.destination,
    days: itinerary.days.map((day) => ({
      title: day.title,
      activities: day.activities.map((activity) => ({
        id: activity.id,
        title: activityDisplayName(activity),
        placeName: activity.placeName ?? activity.place?.name,
        startTime: activity.startTime,
        endTime: activity.endTime
      })),
      transportLegCount: day.transportLegs.length
    }))
  };
}

type ChatCompletionExecutionState = {
  itinerary: TravelItinerary;
  importedSkillIds: string[];
  traces: AgentTraceEvent[];
  sessionId: string;
  diff: string[];
  addedStructuredActivity: boolean;
  usedTransportTool: boolean;
  completeTransportMode?: MapRouteMode;
};

type ChatCompletionToolExecutionResult = {
  status: "completed" | "failed";
  title: string;
  summary: string;
  diff: string[];
  output: unknown;
};

type TransportToolRequest = {
  dayId: string;
  fromActivityId: string;
  toActivityId: string;
  mode: MapRouteMode;
};

type TransportComparisonToolRequest = {
  dayId: string;
  fromActivityId: string;
  toActivityId: string;
  modes: MapRouteMode[];
  strategy: "fastest" | "shortest";
};

type TransportRemovalToolRequest = {
  dayId: string;
  fromActivityId: string;
  toActivityId: string;
};

type TimingAdjustmentToolRequest = {
  dayId: string;
  fromActivityId: string;
  toActivityId: string;
  strategy: TimingAdjustmentStrategy;
};

type TimingAdjustmentStrategy = "delay_next" | "shorten_previous" | "shift_downstream";

type PlaceActivityToolRequest = {
  dayId: string;
  query: string;
  poiName?: string;
  type: Activity["type"];
  title: string;
  startTime?: string;
  endTime?: string;
  description?: string;
  budgetCny?: number;
  tags: string[];
};

type PlaceUpdateToolRequest = {
  activityId: string;
  query: string;
  poiName?: string;
  type?: Activity["type"];
  title?: string;
};

type ItineraryDetailChanges = Partial<
  Pick<TravelItinerary, "destination" | "startDate" | "endDate" | "budgetCny" | "notes" | "companions">
>;
