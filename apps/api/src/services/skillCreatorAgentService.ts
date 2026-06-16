import {
  SkillCreatorAnswerSchema,
  SkillCreatorTurnSchema,
  applySkillCreatorDraftPatch,
  createId,
  createSkillCreatorSession,
  isSkillCreatorDraftReady,
  nowIso,
  recordSkillCreatorAnswer,
  type SkillCreatorAnswer,
  type SkillCreatorSession,
  type SkillCreatorTurn,
  type TravelItinerary
} from "@journey/shared";
import type { JourneyDatabase } from "../db.js";
import {
  readChatCompletionModelConfig,
  requestChatCompletion,
  type ChatCompletionMessage
} from "./chatCompletionClient.js";
import { SkillService } from "./skillService.js";
import { SKILL_CREATOR_AGENT_SYSTEM_PROMPT } from "./skillCreatorAgentPrompt.js";

type SkillCreatorMessage = ChatCompletionMessage & { role: "system" | "user" | "assistant"; content: string };
type LlmClient = (messages: SkillCreatorMessage[]) => Promise<string>;

export type SkillCreatorStartInput = {
  sourceText: string;
  itinerary?: TravelItinerary;
};

export type SkillCreatorStartResult = {
  session: SkillCreatorSession;
  turn: SkillCreatorTurn;
};

export type SkillCreatorReplyInput = {
  sessionId: string;
  answer: SkillCreatorAnswer;
};

export type SkillCreatorReplyResult = {
  session: SkillCreatorSession;
  turn: SkillCreatorTurn;
};

export class SkillCreatorAgentService {
  private readonly skills: SkillService;

  constructor(
    private readonly db: JourneyDatabase,
    private readonly llmClient: LlmClient = callSkillCreatorAgent
  ) {
    this.skills = new SkillService(db);
  }

  async start(input: SkillCreatorStartInput): Promise<SkillCreatorStartResult> {
    const sourceText = input.sourceText.trim();
    if (!sourceText) throw new Error("sourceText is required");
    const draft = this.skills.extract(sourceText, input.itinerary);
    try {
      const session = createSkillCreatorSession({
        id: createId("skill-creator-session"),
        sourceText,
        itineraryId: input.itinerary?.id,
        draft
      });
      const turn = await this.nextTurn(session);
      const nextDraft = this.db.saveSkill(applySkillCreatorDraftPatch(draft, turn.draftPatch));
      const saved = this.db.saveSkillCreatorSession({
        ...session,
        draft: nextDraft,
        currentTurn: turn,
        status: turn.done ? "ready" : "active",
        updatedAt: nowIso()
      });
      return { session: saved, turn };
    } catch (error) {
      this.db.deleteSkill(draft.id);
      throw error;
    }
  }

  async reply(input: SkillCreatorReplyInput): Promise<SkillCreatorReplyResult> {
    const session = this.db.getSkillCreatorSession(input.sessionId);
    if (!session) throw new Error(`Skill creator session not found: ${input.sessionId}`);
    if (!session.currentTurn || session.currentTurn.done || session.status === "ready") {
      throw new Error("Skill creator session is not accepting answers");
    }
    const answer = SkillCreatorAnswerSchema.parse(input.answer);
    const answeredSession = recordSkillCreatorAnswer(session, answer);
    const turn = await this.nextTurn(answeredSession);
    const patchedDraft = applySkillCreatorDraftPatch(answeredSession.draft, turn.draftPatch);
    const savedDraft = this.db.saveSkill(patchedDraft);
    const savedSession = this.db.saveSkillCreatorSession({
      ...answeredSession,
      draft: savedDraft,
      currentTurn: turn,
      status: turn.done ? "ready" : "active",
      updatedAt: nowIso()
    });
    return { session: savedSession, turn };
  }

  private async nextTurn(session: SkillCreatorSession): Promise<SkillCreatorTurn> {
    const messages = buildCreatorMessages(session);
    const raw = await this.llmClient(messages);
    const parsed = await parseCreatorTurnWithRepair(raw, messages, this.llmClient);
    if (isIncompleteFinalTurn(session, parsed)) {
      return requestContinuationTurn({
        session,
        messages,
        attemptedRawTurn: raw,
        attemptedTurn: parsed,
        llmClient: this.llmClient
      });
    }
    return parsed;
  }
}

function buildCreatorMessages(session: SkillCreatorSession): SkillCreatorMessage[] {
  return [
    { role: "system", content: SKILL_CREATOR_AGENT_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        sourceText: session.sourceText,
        currentDraft: session.draft,
        currentQuestion: session.currentTurn,
        history: session.history
      })
    }
  ];
}

function isFinalTurnPatchReady(turn: SkillCreatorTurn): boolean {
  const patch = turn.draftPatch;
  return Boolean(
    patch.name?.trim() &&
      patch.displayName?.trim() &&
      patch.description?.trim() &&
      patch.body?.trim() &&
      patch.tags?.some((tag) => tag.trim()) &&
      patch.rules?.some((rule) => rule.trim()) &&
      patch.forbidden?.some((item) => item.trim())
  );
}

function isIncompleteFinalTurn(session: SkillCreatorSession, turn: SkillCreatorTurn): boolean {
  return (
    turn.done &&
    (!isFinalTurnPatchReady(turn) || !isSkillCreatorDraftReady(applySkillCreatorDraftPatch(session.draft, turn.draftPatch)))
  );
}

function missingFinalTurnPatchFields(turn: SkillCreatorTurn): string[] {
  const patch = turn.draftPatch;
  const missing: string[] = [];
  if (!patch.name?.trim()) missing.push("name");
  if (!patch.displayName?.trim()) missing.push("displayName");
  if (!patch.description?.trim()) missing.push("description");
  if (!patch.body?.trim()) missing.push("body");
  if (!patch.tags?.some((tag) => tag.trim())) missing.push("tags");
  if (!patch.rules?.some((rule) => rule.trim())) missing.push("rules");
  if (!patch.forbidden?.some((item) => item.trim())) missing.push("forbidden");
  return missing;
}

async function requestContinuationTurn(input: {
  session: SkillCreatorSession;
  messages: SkillCreatorMessage[];
  attemptedRawTurn: string;
  attemptedTurn: SkillCreatorTurn;
  llmClient: LlmClient;
}): Promise<SkillCreatorTurn> {
  const draftAfterAttempt = applySkillCreatorDraftPatch(input.session.draft, input.attemptedTurn.draftPatch);
  const continuationMessages: SkillCreatorMessage[] = [
    ...input.messages,
    { role: "assistant", content: input.attemptedRawTurn },
    {
      role: "user",
      content: JSON.stringify({
        contractIssue: "你刚才返回 done: true，但最终草稿还没有达到可发布条件。",
        missingFinalDraftPatchFields: missingFinalTurnPatchFields(input.attemptedTurn),
        draftAfterAttempt,
        requiredAction:
          "请继续由你主导提出下一道 single 或 multiple 选择题，用用户能理解的旅行语境补齐缺口。只返回新的 JSON 对象；除非 draftPatch 同时包含 name、displayName、description、body、tags、rules、forbidden 且可发布，否则 done 必须是 false。"
      })
    }
  ];
  const raw = await input.llmClient(continuationMessages);
  const turn = await parseCreatorTurnWithRepair(raw, continuationMessages, input.llmClient);
  if (isIncompleteFinalTurn(input.session, turn)) {
    throw new Error("Creator Agent returned an incomplete final draft");
  }
  return turn;
}

function parseCreatorTurn(raw: string): SkillCreatorTurn {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return SkillCreatorTurnSchema.parse(normalizeCreatorTurnJson(JSON.parse(cleaned)));
}

function normalizeCreatorTurnJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.options)) return record;
  return {
    ...record,
    options: record.options.map(normalizeCreatorOption)
  };
}

function normalizeCreatorOption(option: unknown, index: number): unknown {
  if (typeof option === "string") {
    const label = option.trim();
    return label ? { id: optionIdFromLabel(label, index), label } : option;
  }
  if (!option || typeof option !== "object" || Array.isArray(option)) return option;
  const record = option as Record<string, unknown>;
  const label = firstNonEmptyString(record.label, record.text, record.title, record.name, record.content, record.value, record.id);
  const id = firstNonEmptyString(record.id, record.key, record.value) ?? (label ? optionIdFromLabel(label, index) : undefined);
  return {
    ...record,
    ...(id ? { id } : {}),
    ...(label ? { label } : {})
  };
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function optionIdFromLabel(label: string, index: number): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `option-${index + 1}`;
}

async function parseCreatorTurnWithRepair(
  raw: string,
  messages: SkillCreatorMessage[],
  llmClient: LlmClient
): Promise<SkillCreatorTurn> {
  try {
    return parseCreatorTurn(raw);
  } catch {
    const repaired = await llmClient([
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content:
          '上一条回复不是符合契约的 JSON。只返回一个修复后的 JSON 对象，不要添加解释。特别注意 options 必须是 [{"id":"lowercase-kebab-case","label":"用户可读选项"}]，不要用 text、title、name、value 或字符串数组代替 label。'
      }
    ]);
    return parseCreatorTurn(repaired);
  }
}

async function callSkillCreatorAgent(messages: SkillCreatorMessage[]): Promise<string> {
  const modelConfig = readChatCompletionModelConfig();
  if (!modelConfig) {
    throw new Error("缺少模型配置，请设置 AGENT_MODEL_API_KEY、OPENAI_API_KEY 或 DEEPSEEK_API_KEY。");
  }
  const data = await requestChatCompletion(modelConfig, {
    messages,
    temperature: 0.3
  });
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Creator Agent returned empty content");
  return content;
}
