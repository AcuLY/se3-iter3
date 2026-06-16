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
import { SkillService } from "./skillService.js";
import { SKILL_CREATOR_AGENT_SYSTEM_PROMPT } from "./skillCreatorAgentPrompt.js";

type DeepSeekMessage = { role: "system" | "user" | "assistant"; content: string };
type LlmClient = (messages: DeepSeekMessage[]) => Promise<string>;

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
    private readonly llmClient: LlmClient = callDeepSeekCreatorAgent
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
    if (
      parsed.done &&
      (!isFinalTurnPatchReady(parsed) || !isSkillCreatorDraftReady(applySkillCreatorDraftPatch(session.draft, parsed.draftPatch)))
    ) {
      return {
        assistantMessage: "这版还差完整的可发布字段，我需要再确认一次。",
        question: "生成行程时，哪些安排一出现就算跑偏？",
        mode: "multiple",
        options: [
          { id: "too-many-spots", label: "每天塞满太多景点" },
          { id: "long-transfer", label: "连续跨区或长距离折返" },
          { id: "hot-walking", label: "午后暴晒下长距离步行" }
        ],
        customPlaceholder: "也可以写其他不希望出现的安排",
        progressPercent: Math.min(parsed.progressPercent, 80),
        draftPatch: parsed.draftPatch,
        done: false
      };
    }
    return parsed;
  }
}

function buildCreatorMessages(session: SkillCreatorSession): DeepSeekMessage[] {
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

function parseCreatorTurn(raw: string): SkillCreatorTurn {
  const cleaned = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return SkillCreatorTurnSchema.parse(JSON.parse(cleaned));
}

async function parseCreatorTurnWithRepair(
  raw: string,
  messages: DeepSeekMessage[],
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
        content: "上一条回复不是符合契约的 JSON。只返回一个修复后的 JSON 对象，不要添加解释。"
      }
    ]);
    return parseCreatorTurn(repaired);
  }
}

async function callDeepSeekCreatorAgent(messages: DeepSeekMessage[]): Promise<string> {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("Creator Agent requires DEEPSEEK_API_KEY");
  }
  const response = await fetch(`${process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      messages,
      temperature: 0.3
    })
  });
  if (!response.ok) throw new Error(`Creator Agent request failed: ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Creator Agent returned empty content");
  return content;
}
