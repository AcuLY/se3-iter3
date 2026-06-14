import {
  applyItineraryPatch,
  createId,
  nowIso,
  type AgentName,
  type AgentSession,
  type AgentTraceEvent,
  type Activity,
  type ChatMessage,
  type ItineraryPatch,
  type ItineraryPatchOperation,
  type MapRouteMode,
  type Place,
  type RouteStep,
  type TravelSkill,
  type TravelItinerary,
  type WeatherSummary
} from "@journey/shared";
import type { JourneyDatabase } from "../db.js";
import { ItineraryService } from "./itineraryService.js";
import { MapService, type PoiResult } from "./mapService.js";
import { SkillService } from "./skillService.js";

export type AgentRunInput = {
  itineraryId: string;
  message: string;
  importedSkillIds?: string[];
};

export type AgentRunResult = {
  itinerary: TravelItinerary;
  message: ChatMessage;
  diff: string[];
  traces: AgentTraceEvent[];
  session: AgentSession;
};

export class AgentService {
  private readonly itineraries: ItineraryService;
  private readonly skills: SkillService;
  private readonly maps = new MapService();

  constructor(private readonly db: JourneyDatabase) {
    this.itineraries = new ItineraryService(db);
    this.skills = new SkillService(db);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        return await this.runDeepSeek(input);
      } catch (error) {
        const fallback = await this.runDeterministic(input);
        fallback.traces.unshift(
          this.trace(fallback.session.id, "MainAgent", "error", "模型调用失败，已降级", error instanceof Error ? error.message : "Unknown DeepSeek error")
        );
        return fallback;
      }
    }
    return this.runDeterministic(input);
  }

  private async runDeepSeek(input: AgentRunInput): Promise<AgentRunResult> {
    const itinerary = this.itineraries.get(input.itineraryId);
    const importedSkillIds = unique([...(itinerary.importedSkillIds ?? []), ...(input.importedSkillIds ?? [])]);
    const importedSkills = importedSkillIds.map((id) => this.skills.get(id)).filter(Boolean);
    const previousSessions = this.db
      .listSessions()
      .filter((session) => session.itineraryId === itinerary.id)
      .slice(0, 5);
    const preferenceSummary = inferPreferenceSummary(
      itinerary.preferences,
      importedSkills.map((skill) => skill.displayName),
      previousSessions,
      input.message
    );
    const sessionId = createId("session");
    const traces: AgentTraceEvent[] = [
      this.trace(sessionId, "MainAgent", "message", "读取行程上下文", `${itinerary.title} / ${itinerary.days.length} 天`),
      this.trace(
        sessionId,
        "MainAgent",
        "message",
        "读取历史偏好",
        previousSessions.length ? preferenceSummary : "还没有历史会话，使用当前行程偏好。"
      ),
      this.trace(sessionId, "StyleAgent", "tool_call", "读取已导入 Skill", importedSkills.map((skill) => skill.displayName).join("、") || "未导入 Skill"),
      this.trace(sessionId, "PlannerAgent", "handoff", "准备调用规划工具", "根据模型 tool_calls 操作结构化行程")
    ];

    const response = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
        messages: [
          {
            role: "system",
            content: [
              "你是旅行规划主 Agent。你必须通过工具调用修改结构化行程，不要只输出文本。",
              "你可以读取导入的旅行风格 Skill、历史会话摘要和当前行程。",
              "普通用户不需要看到内部 Agent 名称，但 trace 会用于开发后台。",
              "回复正文只做简短总结，不要列出本轮 diff；系统会在对话末尾追加结构化改动清单。"
            ].join("\n")
          },
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
              previousMessages: previousSessions.flatMap((session) => session.messages).slice(-12),
              previousSessionSummaries: previousSessions.map((session) => session.contextSummary).filter(Boolean),
              userPreferenceSummary: preferenceSummary
            })
          }
        ],
        tools: deepSeekTools(),
        tool_choice: "auto"
      })
    });
    if (!response.ok) throw new Error(`DeepSeek request failed: ${response.status}`);
    const data = (await response.json()) as DeepSeekChatResponse;
    const message = data.choices?.[0]?.message;
    const toolCalls = message?.tool_calls ?? [];

    const patchOperations: ItineraryPatchOperation[] = [];
    const transportRequests: TransportToolRequest[] = [];
    const placeActivityRequests: PlaceActivityToolRequest[] = [];
    const itineraryDetailChanges: ItineraryDetailChanges[] = [];
    let completeTransportMode: MapRouteMode | undefined;
    const placeDiff: string[] = [];
    const transportDiff: string[] = [];
    let currentImportedSkillIds = importedSkillIds;
    for (const toolCall of toolCalls) {
      const parsed = parseToolArguments(toolCall.function.arguments);
      traces.push(
        this.trace(sessionId, toolAgent(toolCall.function.name), "tool_call", toolCall.function.name, JSON.stringify(parsed))
      );
      if (toolCall.function.name === "add_activity") {
        patchOperations.push({
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
        });
      }
      if (toolCall.function.name === "add_place_activity") {
        placeActivityRequests.push({
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
        });
      }
      if (toolCall.function.name === "update_activity") {
        patchOperations.push({
          type: "updateActivity",
          activityId: String(parsed.activityId),
          changes: parsed.changes as Partial<Activity>
        });
      }
      if (toolCall.function.name === "remove_activity") {
        patchOperations.push({ type: "removeActivity", activityId: String(parsed.activityId) });
      }
      if (toolCall.function.name === "move_activity") {
        patchOperations.push({
          type: "moveActivity",
          activityId: String(parsed.activityId),
          targetDayId: String(parsed.targetDayId),
          targetIndex: Number(parsed.targetIndex ?? 0)
        });
      }
      if (toolCall.function.name === "set_transport_leg") {
        transportRequests.push({
          dayId: String(parsed.dayId),
          fromActivityId: String(parsed.fromActivityId),
          toActivityId: String(parsed.toActivityId),
          mode: parseRouteMode(parsed.mode)
        });
      }
      if (toolCall.function.name === "complete_transport_legs") {
        completeTransportMode = parseRouteMode(parsed.mode);
      }
      if (toolCall.function.name === "import_skill") {
        currentImportedSkillIds = unique([...currentImportedSkillIds, String(parsed.skillId)]);
      }
      if (toolCall.function.name === "update_itinerary_details") {
        itineraryDetailChanges.push(parseItineraryDetailChanges(parsed));
      }
    }

    const patch: ItineraryPatch = {
      source: "agent",
      reason: message?.content || input.message,
      operations: patchOperations
    };
    const patched = applyItineraryPatch(
      {
        ...itinerary,
        importedSkillIds: currentImportedSkillIds
      },
      patch
    );
    let saved = this.itineraries.save(patched.itinerary);
    const detailDiff: string[] = [];
    for (const changes of itineraryDetailChanges) {
      saved = this.applyItineraryDetailChanges(saved, changes, detailDiff);
    }
    const weatherDiff: string[] = [];
    saved = await this.updateWeatherForDays(saved, traces, sessionId, weatherDiff);
    for (const request of placeActivityRequests) {
      saved = await this.applyPlaceActivityTool(saved, request, traces, sessionId, placeDiff);
    }
    saved = await this.resolveMissingPlaces(saved, traces, sessionId, placeDiff);
    for (const request of transportRequests) {
      saved = await this.applyTransportTool(saved, request, traces, sessionId, transportDiff);
    }
    if (completeTransportMode) {
      saved = await this.completeMissingTransportLegs(saved, completeTransportMode, traces, sessionId, transportDiff);
    }
    const resultDiff = [...patched.diff, ...detailDiff, ...weatherDiff, ...placeDiff, ...transportDiff];
    traces.push(this.trace(sessionId, "CriticAgent", "state_patch", "校验并保存行程", resultDiff.join("；") || "无结构化变更"));
    for (const trace of traces) this.db.saveTrace(trace);

    const userMessage: ChatMessage = {
      id: createId("msg"),
      role: "user",
      content: input.message,
      createdAt: nowIso()
    };
    const assistantMessage: ChatMessage = {
      id: createId("msg"),
      role: "assistant",
      content: message?.content || (resultDiff.length > 0 ? "已更新行程。" : "当前没有结构变化。"),
      createdAt: nowIso()
    };
    const contextSummary = summarizeSession(input.message, saved, importedSkills.map((skill) => skill.displayName), previousSessions);
    const session: AgentSession = {
      id: sessionId,
      itineraryId: saved.id,
      messages: [userMessage, assistantMessage],
      importedSkillIds: currentImportedSkillIds,
      traces,
      contextSummary,
      userPreferenceSummary: preferenceSummary,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.db.saveSession(session);

    return {
      itinerary: saved,
      message: assistantMessage,
      diff: resultDiff,
      traces,
      session
    };
  }

  private async runDeterministic(input: AgentRunInput): Promise<AgentRunResult> {
    const itinerary = this.itineraries.get(input.itineraryId);
    const importedSkillIds = unique([...(itinerary.importedSkillIds ?? []), ...(input.importedSkillIds ?? [])]);
    const importedSkills = importedSkillIds.map((id) => this.skills.get(id)).filter(Boolean);
    const previousSessions = this.db
      .listSessions()
      .filter((session) => session.itineraryId === itinerary.id)
      .slice(0, 5);
    const preferenceSummary = inferPreferenceSummary(
      itinerary.preferences,
      importedSkills.map((skill) => skill.displayName),
      previousSessions,
      input.message
    );
    const sessionId = createId("session");
    const traces: AgentTraceEvent[] = [
      this.trace(sessionId, "MainAgent", "message", "理解用户目标", input.message),
      this.trace(
        sessionId,
        "MainAgent",
        "message",
        "读取历史偏好",
        previousSessions.length ? preferenceSummary : "还没有历史会话，使用当前行程偏好。"
      ),
      this.trace(
        sessionId,
        "StyleAgent",
        "tool_call",
        "融合旅行风格 Skill",
        importedSkills.length ? importedSkills.map((skill) => skill.displayName).join("、") : "未导入 Skill，使用用户偏好。"
      ),
      this.trace(sessionId, "WeatherAgent", "tool_call", "检查天气约束", "使用高德天气服务，演示环境返回 mock 天气。"),
      this.trace(sessionId, "TransportAgent", "tool_call", "检查路线可行性", "使用高德路线服务，演示环境返回 mock 路线。"),
      this.trace(sessionId, "AttractionAgent", "tool_call", "补充景点候选", "根据目的地和风格补充轻量活动。"),
      this.trace(sessionId, "PlannerAgent", "state_patch", "生成结构化行程补丁", "补全空白时段，并保留用户锁定内容。"),
      this.trace(sessionId, "CriticAgent", "handoff", "检查需求覆盖", "确认慢节奏、交通和手动编辑保护。")
    ];

    const targetDay = itinerary.days[1] ?? itinerary.days[0];
    if (!targetDay) throw new Error("Itinerary has no editable day");
    const skillInfluence = chooseSkillInfluence(importedSkills);

    const patch: ItineraryPatch = {
      source: "agent",
      reason: "根据用户对话和导入 Skill 补全空白时段",
      operations: [
        {
          type: "addActivity",
          dayId: targetDay.id,
          activity: {
            type: "free_time",
            title: chooseActivityTitle(input.message, importedSkills, skillInfluence),
            startTime: "15:00",
            endTime: "17:00",
            description: skillInfluence
              ? `已应用「${skillInfluence.skill.displayName}」规则：${skillInfluence.rule}。可在行程中继续手动调整。`
              : "已根据你的要求补充，可在行程中继续手动调整。",
            tags: skillInfluence ? ["风格规则", "可调整"] : ["慢节奏", "可调整"],
            budgetCny: 80,
            transportNote: "同区域内移动，避免跨城奔波。"
          }
        }
      ]
    };

    const patched = applyItineraryPatch(
      {
        ...itinerary,
        importedSkillIds
      },
      patch
    );
    let saved = this.itineraries.save(patched.itinerary);
    const detailDiff: string[] = [];
    const deterministicDetails = parseDeterministicItineraryDetails(input.message);
    if (Object.keys(deterministicDetails).length > 0) {
      saved = this.applyItineraryDetailChanges(saved, deterministicDetails, detailDiff);
    }
    const weatherDiff: string[] = [];
    saved = await this.updateWeatherForDays(saved, traces, sessionId, weatherDiff);
    const placeDiff: string[] = [];
    saved = await this.resolveMissingPlaces(saved, traces, sessionId, placeDiff);
    const transportDiff: string[] = [];
    saved = await this.completeMissingTransportLegs(saved, "walking", traces, sessionId, transportDiff);
    const styleDiff = skillInfluence ? [`已应用风格：${skillInfluence.skill.displayName}`] : [];
    const resultDiff = [...patched.diff, ...styleDiff, ...detailDiff, ...weatherDiff, ...placeDiff, ...transportDiff];
    for (const trace of traces) this.db.saveTrace(trace);

    const userMessage: ChatMessage = {
      id: createId("msg"),
      role: "user",
      content: input.message,
      createdAt: nowIso()
    };
    const assistantMessage: ChatMessage = {
      id: createId("msg"),
      role: "assistant",
      content: resultDiff.length > 0 ? "已更新行程。" : "当前没有结构变化。",
      createdAt: nowIso()
    };
    const session: AgentSession = {
      id: sessionId,
      itineraryId: saved.id,
      messages: [userMessage, assistantMessage],
      importedSkillIds,
      traces,
      contextSummary: summarizeSession(input.message, saved, importedSkills.map((skill) => skill.displayName), previousSessions),
      userPreferenceSummary: preferenceSummary,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.db.saveSession(session);

    return {
      itinerary: saved,
      message: assistantMessage,
      diff: resultDiff,
      traces,
      session
    };
  }

  private async resolveMissingPlaces(
    itinerary: TravelItinerary,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): Promise<TravelItinerary> {
    let current = itinerary;
    for (const day of current.days) {
      for (const activity of day.activities) {
        if (activity.source !== "agent" || !activity.placeName || activity.place?.coordinates) continue;
        const places = await this.maps.searchPoi(activity.placeName, activity.place?.city ?? current.destination);
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

  private async updateWeatherForDays(
    itinerary: TravelItinerary,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): Promise<TravelItinerary> {
    let current = itinerary;
    for (const day of current.days) {
      const weather = await this.maps.weather(current.destination, day.date);
      if (!hasSameWeather(day.weather, weather)) {
        current = this.itineraries.setDayWeather(current.id, day.id, weather, "agent");
        traces.push(
          this.trace(
            sessionId,
            "WeatherAgent",
            "state_patch",
            "写入每日天气",
            `${day.title}：${weather.weather}，${weather.temperature}`
          )
        );
        diff.push(`已更新天气：${day.title} ${weather.weather}`);
      }
    }
    return current;
  }

  private async applyPlaceActivityTool(
    itinerary: TravelItinerary,
    request: PlaceActivityToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): Promise<TravelItinerary> {
    const candidates = await this.maps.searchPoi(request.query, itinerary.destination);
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

  private async applyTransportTool(
    itinerary: TravelItinerary,
    request: TransportToolRequest,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff?: string[]
  ): Promise<TravelItinerary> {
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
      failureReason: route.fallbackReason,
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

  private applyItineraryDetailChanges(
    itinerary: TravelItinerary,
    changes: ItineraryDetailChanges,
    diff: string[]
  ): TravelItinerary {
    const before = itinerary;
    const saved = this.itineraries.update(itinerary.id, changes);
    if (before.startDate !== saved.startDate || before.endDate !== saved.endDate) diff.push("已更新日期范围");
    if (before.destination !== saved.destination) diff.push("已更新目的地");
    if (before.budgetCny !== saved.budgetCny) diff.push("已更新预算");
    if (before.notes !== saved.notes) diff.push("已更新备注");
    if (before.preferences.join("|") !== saved.preferences.join("|")) diff.push("已更新偏好");
    if (before.companions.join("|") !== saved.companions.join("|")) diff.push("已更新同行人");
    return saved;
  }

  private async completeMissingTransportLegs(
    itinerary: TravelItinerary,
    mode: MapRouteMode,
    traces: AgentTraceEvent[],
    sessionId: string,
    diff: string[]
  ): Promise<TravelItinerary> {
    let current = itinerary;
    let completed = 0;
    for (const day of current.days) {
      for (let index = 0; index < day.activities.length - 1; index += 1) {
        const fromActivity = day.activities[index]!;
        const toActivity = day.activities[index + 1]!;
        const exists = (day.transportLegs ?? []).some(
          (leg) => leg.fromActivityId === fromActivity.id && leg.toActivityId === toActivity.id
        );
        if (!exists && canRouteActivityPair(fromActivity, toActivity)) {
          current = await this.applyTransportTool(
            current,
            {
              dayId: day.id,
              fromActivityId: fromActivity.id,
              toActivityId: toActivity.id,
              mode
            },
            traces,
            sessionId
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

function deepSeekTools() {
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
        name: "update_itinerary_details",
        description: "更新行程级规划信息。可以改目的地、日期范围、预算、备注、偏好和同行人；不要改行程名称。",
        parameters: {
          type: "object",
          properties: {
            destination: { type: "string" },
            startDate: { type: "string", description: "YYYY-MM-DD" },
            endDate: { type: "string", description: "YYYY-MM-DD" },
            budgetCny: { type: "number" },
            notes: { type: "string" },
            preferences: { type: "array", items: { type: "string" } },
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

function parseRouteMode(value: unknown): MapRouteMode {
  if (value === "walking" || value === "transit" || value === "driving" || value === "cycling") return value;
  return "walking";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const preferences = asStringList(parsed.preferences);
  const companions = asStringList(parsed.companions);
  if (destination) changes.destination = destination;
  if (startDate) changes.startDate = startDate;
  if (endDate) changes.endDate = endDate;
  if (budgetCny !== undefined) changes.budgetCny = budgetCny;
  if (notes) changes.notes = notes;
  if (preferences.length > 0) changes.preferences = preferences;
  if (companions.length > 0) changes.companions = companions;
  return changes;
}

function parseDeterministicItineraryDetails(message: string): ItineraryDetailChanges {
  const changes: ItineraryDetailChanges = {};
  const endDateMatch = message.match(/(?:返回|结束|返程)日期?(?:改到|设为|到)?\s*(20\d{2}-\d{2}-\d{2})/);
  const startDateMatch = message.match(/(?:出发|开始)日期?(?:改到|设为|到)?\s*(20\d{2}-\d{2}-\d{2})/);
  const budgetMatch = message.match(/预算(?:控制在|改到|设为|是)?\s*(\d+(?:\.\d+)?)/);
  const notesMatch = message.match(/备注[:：]?\s*([^。]+。?)/);
  if (startDateMatch?.[1]) changes.startDate = startDateMatch[1];
  if (endDateMatch?.[1]) changes.endDate = endDateMatch[1];
  if (budgetMatch?.[1]) changes.budgetCny = Number(budgetMatch[1]);
  if (notesMatch?.[1]) changes.notes = notesMatch[1].trim();
  return changes;
}

function toolAgent(toolName: string): AgentName {
  if (toolName.includes("skill")) return "StyleAgent";
  if (toolName.includes("transport") || toolName.includes("route")) return "TransportAgent";
  if (toolName.includes("activity") || toolName.includes("move")) return "PlannerAgent";
  return "MainAgent";
}

function findActivityInItinerary(itinerary: TravelItinerary, activityId: string): Activity | undefined {
  for (const day of itinerary.days) {
    const activity = day.activities.find((candidate) => candidate.id === activityId);
    if (activity) return activity;
  }
  return undefined;
}

function hasSameWeather(current: WeatherSummary | undefined, next: WeatherSummary): boolean {
  return Boolean(
    current &&
      current.city === next.city &&
      current.date === next.date &&
      current.weather === next.weather &&
      current.temperature === next.temperature &&
      current.source === next.source
  );
}

function routePoint(activity: Activity): string | undefined {
  if (activity.place?.coordinates) {
    return `${activity.place.coordinates.lng},${activity.place.coordinates.lat}`;
  }
  return activity.placeName?.trim() || activity.place?.name?.trim() || activity.title.trim() || undefined;
}

function canRouteActivityPair(from: Activity, to: Activity): boolean {
  return Boolean(routePoint(from) && routePoint(to));
}

function activityDisplayName(activity: Activity): string {
  return activity.title.trim() || activity.placeName?.trim() || activity.place?.name?.trim() || "未命名活动";
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
  previousSessions: AgentSession[] = []
): string {
  const latestHistory = previousSessions.find((session) => session.contextSummary || session.userPreferenceSummary);
  return [
    `用户请求：${message}`,
    `当前行程：${itinerary.title}，${itinerary.destination}，${itinerary.days.length} 天`,
    skillNames.length ? `已融合 Skill：${skillNames.join("、")}` : "未导入 Skill",
    latestHistory
      ? `历史参考：${latestHistory.userPreferenceSummary ?? latestHistory.contextSummary}`
      : undefined
  ]
    .filter(Boolean)
    .join("；");
}

function inferPreferenceSummary(
  preferences: string[],
  skillNames: string[],
  previousSessions: AgentSession[] = [],
  message = ""
): string {
  const previousTokens = previousSessions.flatMap((session) =>
    splitPreferenceText([session.userPreferenceSummary, session.contextSummary].filter(Boolean).join("、"))
  );
  const messageTokens = splitPreferenceText(message);
  return unique([...preferences, ...skillNames, ...previousTokens, ...messageTokens]).join("、") || "暂无稳定偏好";
}

function splitPreferenceText(text: string): string[] {
  const known = ["慢节奏", "咖啡", "citywalk", "亲子", "博物馆", "海边", "日落", "小店", "雨天", "室内", "夜景", "不赶路"];
  return known.filter((token) => text.includes(token));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

type DeepSeekChatResponse = {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
};

type TransportToolRequest = {
  dayId: string;
  fromActivityId: string;
  toActivityId: string;
  mode: MapRouteMode;
};

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

type ItineraryDetailChanges = Partial<
  Pick<TravelItinerary, "destination" | "startDate" | "endDate" | "budgetCny" | "notes" | "preferences" | "companions">
>;
