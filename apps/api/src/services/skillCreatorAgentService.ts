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
  type TravelItinerary,
  type TravelSkill
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

const TARGET_CREATOR_QUESTION_COUNT = 5;
const MAX_CREATOR_QUESTION_COUNT = 10;
const TARGET_CREATOR_READY_PROGRESS_PERCENT = 80;
const MAX_CREATOR_TURN_REPAIR_RETRIES = 3;

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
    this.db.deleteSkill(draft.id);
    try {
      const session = createSkillCreatorSession({
        id: createId("skill-creator-session"),
        sourceText,
        itineraryId: input.itinerary?.id,
        draft
      });
      const turn = await this.nextTurn(session);
      const nextDraft = saveSkillCreatorDraftForTurn(this.db, applySkillCreatorDraftPatch(draft, turn.draftPatch), turn);
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
    const savedDraft = saveSkillCreatorDraftForTurn(this.db, patchedDraft, turn);
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
    let parsed = await parseCreatorTurnWithRepair(raw, messages, this.llmClient);
    parsed = completeTurnAtQuestionLimit(session, parsed);
    if (isRepeatedQuestionTurn(session, parsed)) {
      parsed = await requestNonRepeatedTurn({
        session,
        messages,
        attemptedRawTurn: raw,
        attemptedTurn: parsed,
        llmClient: this.llmClient
      });
      parsed = completeTurnAtQuestionLimit(session, parsed);
    }
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

function saveSkillCreatorDraftForTurn(db: JourneyDatabase, draft: TravelSkill, turn: SkillCreatorTurn): TravelSkill {
  if (turn.done) return db.saveSkill(draft);
  db.deleteSkill(draft.id);
  return draft;
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
        answeredQuestionCount: session.history.length,
        targetQuestionCount: TARGET_CREATOR_QUESTION_COUNT,
        maxQuestionCount: MAX_CREATOR_QUESTION_COUNT,
        remainingQuestionBudget: Math.max(0, MAX_CREATOR_QUESTION_COUNT - session.history.length),
        previousQuestions: previousCreatorQuestions(session),
        history: session.history
      })
    }
  ];
}

function previousCreatorQuestions(session: SkillCreatorSession): string[] {
  return [
    ...session.history.map((item) => item.question),
    session.currentTurn?.question
  ].filter((question): question is string => Boolean(question?.trim()));
}

function normalizeQuestionText(question: string | undefined): string {
  return (question ?? "")
    .replace(/[？?。！!，,、\s]/g, "")
    .trim()
    .toLowerCase();
}

function isRepeatedQuestionTurn(session: SkillCreatorSession, turn: SkillCreatorTurn): boolean {
  if (turn.done || !turn.question) return false;
  const nextQuestion = normalizeQuestionText(turn.question);
  if (!nextQuestion) return false;
  return previousCreatorQuestions(session).some((question) => normalizeQuestionText(question) === nextQuestion);
}

function isFinalDraftReady(skill: TravelSkill): boolean {
  return Boolean(
    skill.name.trim() &&
      skill.displayName.trim() &&
      skill.description.trim() &&
      skill.body.trim() &&
      skill.tags.some((tag) => tag.trim()) &&
      skill.rules.some((rule) => rule.trim()) &&
      skill.forbidden.some((item) => item.trim()) &&
      isSkillCreatorDraftReady(skill)
  );
}

function isIncompleteFinalTurn(session: SkillCreatorSession, turn: SkillCreatorTurn): boolean {
  return turn.done && !isFinalDraftReady(applySkillCreatorDraftPatch(session.draft, turn.draftPatch));
}

function missingFinalDraftFields(skill: TravelSkill): string[] {
  const missing: string[] = [];
  if (!skill.name.trim()) missing.push("name");
  if (!skill.displayName.trim()) missing.push("displayName");
  if (!skill.description.trim()) missing.push("description");
  if (!skill.body.trim()) missing.push("body");
  if (!skill.tags.some((tag) => tag.trim())) missing.push("tags");
  if (!skill.rules.some((rule) => rule.trim())) missing.push("rules");
  if (!skill.forbidden.some((item) => item.trim())) missing.push("forbidden");
  return missing;
}

function completeTurnAtQuestionLimit(session: SkillCreatorSession, turn: SkillCreatorTurn): SkillCreatorTurn {
  if (turn.done || session.history.length < TARGET_CREATOR_QUESTION_COUNT) return turn;
  if (!isFinalDraftReady(applySkillCreatorDraftPatch(session.draft, turn.draftPatch))) return turn;
  if (session.history.length < MAX_CREATOR_QUESTION_COUNT) {
    if (turn.progressPercent < TARGET_CREATOR_READY_PROGRESS_PERCENT) return turn;
    return {
      assistantMessage: [turn.assistantMessage, `已完成 ${TARGET_CREATOR_QUESTION_COUNT} 轮问题，当前草稿已经可以进入最终检查。`]
        .filter(Boolean)
        .join("\n"),
      customPlaceholder: turn.customPlaceholder,
      progressPercent: 100,
      draftPatch: turn.draftPatch,
      done: true
    };
  }
  return {
    assistantMessage: [turn.assistantMessage, `已达到 ${MAX_CREATOR_QUESTION_COUNT} 轮问题，当前草稿已经可以进入最终检查。`]
      .filter(Boolean)
      .join("\n"),
    customPlaceholder: turn.customPlaceholder,
    progressPercent: 100,
    draftPatch: turn.draftPatch,
    done: true
  };
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
        missingFinalDraftFields: missingFinalDraftFields(draftAfterAttempt),
        draftAfterAttempt,
        requiredAction:
          "请继续由你主导提出下一道 single 或 multiple 选择题，用用户能理解的旅行语境补齐缺口。只返回新的 JSON 对象；除非合并 draftPatch 后的草稿已经包含 name、displayName、description、body、tags、rules、forbidden 且可发布，否则 done 必须是 false。"
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

async function requestNonRepeatedTurn(input: {
  session: SkillCreatorSession;
  messages: SkillCreatorMessage[];
  attemptedRawTurn: string;
  attemptedTurn: SkillCreatorTurn;
  llmClient: LlmClient;
}): Promise<SkillCreatorTurn> {
  const retryMessages: SkillCreatorMessage[] = [
    ...input.messages,
    { role: "assistant", content: input.attemptedRawTurn },
    {
      role: "user",
      content: JSON.stringify({
        contractIssue: "你刚才返回的问题与 previousQuestions/currentQuestion/history 中已问过的问题重复。",
        repeatedQuestion: input.attemptedTurn.question,
        previousQuestions: previousCreatorQuestions(input.session),
        currentDraft: input.session.draft,
        requiredAction:
          "请换一个尚未确认的信息缺口继续提问。只返回新的 JSON 对象；done 为 false 时必须包含新的 question、mode 和 3 到 5 个 options。"
      })
    }
  ];
  const raw = await input.llmClient(retryMessages);
  const turn = await parseCreatorTurnWithRepair(raw, retryMessages, input.llmClient);
  if (isRepeatedQuestionTurn(input.session, turn)) {
    throw new Error("Creator Agent repeated a previous question");
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
  const completed = record.done === true;
  const normalized = {
    ...record,
    question: completed ? undefined : emptyStringToUndefined(record.question),
    mode: completed ? undefined : record.mode ?? undefined,
    options: completed ? undefined : record.options ?? undefined,
    customPlaceholder: emptyStringToUndefined(record.customPlaceholder)
  };
  if (!Array.isArray(normalized.options)) return normalized;
  return {
    ...normalized,
    options: normalized.options.map(normalizeCreatorOption)
  };
}

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value ?? undefined;
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
  let candidate = raw;
  let repairMessages = messages;
  for (let retryCount = 0; ; retryCount += 1) {
    try {
      return parseCreatorTurn(candidate);
    } catch (error) {
      if (retryCount >= MAX_CREATOR_TURN_REPAIR_RETRIES) throw error;
      repairMessages = [
        ...repairMessages,
        { role: "assistant", content: candidate },
        {
          role: "user",
          content: JSON.stringify({
            contractIssue: "The previous Creator Agent reply failed SkillCreatorTurn schema validation.",
            validationMessage: readCreatorTurnParseErrorMessage(error),
            retryAttempt: retryCount + 1,
            maxRetryAttempts: MAX_CREATOR_TURN_REPAIR_RETRIES,
            requiredAction:
              "Return only one corrected JSON object. Do not include explanations. When done is false, include question, mode, and 3 to 5 options. options must be objects with id and label, and the array must contain no more than 5 items."
          })
        }
      ];
      candidate = await llmClient(repairMessages);
    }
  }
}

function readCreatorTurnParseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  try {
    const serialized = JSON.stringify(error);
    if (serialized) return serialized;
  } catch {
    // Fall through to String(error).
  }
  return String(error);
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
