# Skill Creator Agent Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current form-like Skill creator with an Agent-led question flow driven by a project-specific Creator Agent system prompt and structured LLM output.

**Architecture:** Add a shared Creator Agent contract in `@journey/shared`, then implement backend session persistence, DeepSeek-backed Creator Agent turns, and strict JSON validation in the API. The frontend renders only the current question during the interview and reveals `SKILL.md`, frontmatter, and field editing only inside collapsed final review.

**Tech Stack:** TypeScript, Zod, Express, Vitest, React, Vite, Testing Library, DeepSeek chat completions.

---

## File Structure

- Create `packages/shared/src/skillCreator.ts`: shared Zod schemas, TypeScript types, draft merge helper, and readiness helper for Creator Agent turns and sessions.
- Modify `packages/shared/src/index.ts`: export the new shared Creator Agent contract.
- Create `packages/shared/src/skillCreator.test.ts`: contract tests for turn validation, draft patch merging, completion readiness, and progress rollback.
- Modify `apps/api/src/db.ts`: add a `skill_creator_sessions` JSON table with list/get/save helpers.
- Create `apps/api/src/services/skillCreatorAgentPrompt.ts`: project-specific Creator Agent system prompt.
- Create `apps/api/src/services/skillCreatorAgentService.ts`: session start/reply orchestration, DeepSeek calls, repair attempt, draft persistence, and validation.
- Modify `apps/api/src/server.ts`: replace the old creator reply route with `POST /api/skills/creator/start` and `POST /api/skills/creator/:sessionId/reply`.
- Modify `apps/api/src/server.test.ts`: API tests for real LLM calls, system prompt usage, JSON repair, invalid completion blocking, and progress rollback.
- Modify `apps/web/src/api/client.ts`: add a strict JSON API helper for Creator Agent calls that throws instead of falling back to fake data.
- Modify `apps/web/src/App.tsx`: replace the Creator conversation/artifact two-column UI with source entry, current question card, and final review.
- Modify `apps/web/src/App.test.tsx`: frontend tests for question-only interview, single/multi-select answers, custom input, error retry, and collapsed final review.

---

### Task 1: Shared Creator Agent Contract

**Files:**
- Create: `packages/shared/src/skillCreator.ts`
- Create: `packages/shared/src/skillCreator.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing shared contract tests**

Create `packages/shared/src/skillCreator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SkillCreatorTurnSchema,
  applySkillCreatorDraftPatch,
  isSkillCreatorDraftReady
} from "./skillCreator";
import type { TravelSkill } from "./types";

const baseSkill: TravelSkill = {
  id: "skill-creator-test",
  name: "creator-test-style",
  displayName: "旅行风格草稿",
  description: "从用户材料整理的旅行风格。",
  body: "保留用户喜欢的节奏。",
  tags: ["松弛"],
  rules: ["每天保留休息段"],
  forbidden: [],
  status: "draft",
  source: "extracted",
  imports: 0,
  favorites: 0,
  favorited: false,
  createdAt: "2026-06-16T00:00:00.000Z",
  updatedAt: "2026-06-16T00:00:00.000Z"
};

describe("skill creator contract", () => {
  it("accepts an in-progress question turn with choice options and progress", () => {
    const parsed = SkillCreatorTurnSchema.parse({
      assistantMessage: "我先确认哪些体验最重要。",
      question: "这套旅行风格换到新城市时，哪些体验必须保留？",
      mode: "multiple",
      options: [
        { id: "sunset", label: "傍晚留给散步和日落" },
        { id: "shops", label: "优先找小店和街区" },
        { id: "light", label: "每天最多两个核心点" }
      ],
      customPlaceholder: "也可以写自己的答案",
      progressPercent: 52,
      draftPatch: {
        tags: ["松弛", "小店"],
        rules: ["傍晚时段优先保留低强度体验"]
      },
      done: false
    });

    expect(parsed.mode).toBe("multiple");
    expect(parsed.progressPercent).toBe(52);
    expect(parsed.options).toHaveLength(3);
  });

  it("rejects unfinished turns without a question, mode, and at least three options", () => {
    const result = SkillCreatorTurnSchema.safeParse({
      progressPercent: 30,
      draftPatch: {},
      done: false
    });

    expect(result.success).toBe(false);
  });

  it("allows completed turns without another question", () => {
    const parsed = SkillCreatorTurnSchema.parse({
      assistantMessage: "这版已经可以进入最终检查。",
      progressPercent: 100,
      draftPatch: {
        displayName: "海边小店松弛风格",
        description: "适合复用海边散步、小店探索和慢节奏的旅行风格。",
        body: "将原始游记里的慢节奏体验复用到新目的地。",
        tags: ["海边", "小店", "松弛"],
        rules: ["每天最多两个核心安排"],
        forbidden: ["连续跨区赶路"]
      },
      done: true
    });

    expect(parsed.done).toBe(true);
    expect(parsed.question).toBeUndefined();
  });

  it("merges draft patches without replacing omitted fields", () => {
    const merged = applySkillCreatorDraftPatch(baseSkill, {
      tags: ["小店", "松弛"],
      rules: ["傍晚留给日落散步"],
      forbidden: ["午后暴晒长距离步行"]
    });

    expect(merged.displayName).toBe("旅行风格草稿");
    expect(merged.tags).toEqual(["松弛", "小店"]);
    expect(merged.rules).toEqual(["每天保留休息段", "傍晚留给日落散步"]);
    expect(merged.forbidden).toEqual(["午后暴晒长距离步行"]);
  });

  it("requires a complete draft before final review", () => {
    expect(isSkillCreatorDraftReady(baseSkill)).toBe(true);
    expect(isSkillCreatorDraftReady({ ...baseSkill, rules: [] })).toBe(false);
    expect(isSkillCreatorDraftReady({ ...baseSkill, description: "" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run shared tests to verify they fail**

Run:

```bash
npm run test -w @journey/shared -- skillCreator
```

Expected: fail because `packages/shared/src/skillCreator.ts` does not exist.

- [ ] **Step 3: Add shared Creator Agent contract**

Create `packages/shared/src/skillCreator.ts`:

```ts
import { z } from "zod";
import { nowIso } from "./itinerary.js";
import { buildSkillMarkdown, validateSkillMarkdown } from "./skill.js";
import { TravelSkillSchema, type TravelSkill } from "./types.js";

export const SkillCreatorOptionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1)
});

export type SkillCreatorOption = z.infer<typeof SkillCreatorOptionSchema>;

export const SkillCreatorDraftPatchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    rules: z.array(z.string().trim().min(1)).optional(),
    forbidden: z.array(z.string().trim().min(1)).optional()
  })
  .strict();

export type SkillCreatorDraftPatch = z.infer<typeof SkillCreatorDraftPatchSchema>;

export const SkillCreatorTurnSchema = z
  .object({
    assistantMessage: z.string().trim().optional().default(""),
    question: z.string().trim().min(1).optional(),
    mode: z.enum(["single", "multiple"]).optional(),
    options: z.array(SkillCreatorOptionSchema).min(3).max(5).optional(),
    customPlaceholder: z.string().trim().optional().default("也可以写自己的答案"),
    progressPercent: z.number().int().min(0).max(100),
    draftPatch: SkillCreatorDraftPatchSchema.default({}),
    done: z.boolean()
  })
  .superRefine((turn, context) => {
    if (turn.done) return;
    if (!turn.question) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["question"], message: "question is required until done is true" });
    }
    if (!turn.mode) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["mode"], message: "mode is required until done is true" });
    }
    if (!turn.options || turn.options.length < 3) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["options"], message: "at least three options are required until done is true" });
    }
  });

export type SkillCreatorTurn = z.infer<typeof SkillCreatorTurnSchema>;

export const SkillCreatorAnswerSchema = z.object({
  selectedOptionIds: z.array(z.string().trim().min(1)).default([]),
  customAnswer: z.string().trim().default("")
});

export type SkillCreatorAnswer = z.infer<typeof SkillCreatorAnswerSchema>;

export const SkillCreatorHistoryItemSchema = z.object({
  question: z.string(),
  mode: z.enum(["single", "multiple"]),
  options: z.array(SkillCreatorOptionSchema),
  selectedOptionIds: z.array(z.string()),
  customAnswer: z.string(),
  progressPercent: z.number().int().min(0).max(100),
  createdAt: z.string()
});

export type SkillCreatorHistoryItem = z.infer<typeof SkillCreatorHistoryItemSchema>;

export const SkillCreatorSessionSchema = z.object({
  id: z.string(),
  sourceText: z.string(),
  itineraryId: z.string().optional(),
  draft: TravelSkillSchema,
  currentTurn: SkillCreatorTurnSchema.optional(),
  history: z.array(SkillCreatorHistoryItemSchema),
  status: z.enum(["active", "ready"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type SkillCreatorSession = z.infer<typeof SkillCreatorSessionSchema>;

export function createSkillCreatorSession(input: {
  id: string;
  sourceText: string;
  itineraryId?: string;
  draft: TravelSkill;
  currentTurn?: SkillCreatorTurn;
}): SkillCreatorSession {
  const timestamp = nowIso();
  return {
    id: input.id,
    sourceText: input.sourceText,
    itineraryId: input.itineraryId,
    draft: input.draft,
    currentTurn: input.currentTurn,
    history: [],
    status: input.currentTurn?.done ? "ready" : "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function applySkillCreatorDraftPatch(skill: TravelSkill, patch: SkillCreatorDraftPatch): TravelSkill {
  const timestamp = nowIso();
  return {
    ...skill,
    name: patch.name ?? skill.name,
    displayName: patch.displayName ?? skill.displayName,
    description: patch.description ?? skill.description,
    body: patch.body ?? skill.body,
    tags: patch.tags ? unique([...skill.tags, ...patch.tags]) : skill.tags,
    rules: patch.rules ? unique([...skill.rules, ...patch.rules]) : skill.rules,
    forbidden: patch.forbidden ? unique([...skill.forbidden, ...patch.forbidden]) : skill.forbidden,
    updatedAt: timestamp
  };
}

export function isSkillCreatorDraftReady(skill: TravelSkill): boolean {
  const markdown = buildSkillMarkdown({
    name: skill.name,
    description: skill.description,
    body: skill.body,
    tags: skill.tags,
    rules: skill.rules,
    forbidden: skill.forbidden
  });
  return validateSkillMarkdown(markdown).valid;
}

export function recordSkillCreatorAnswer(
  session: SkillCreatorSession,
  answer: SkillCreatorAnswer
): SkillCreatorSession {
  if (!session.currentTurn || session.currentTurn.done) return session;
  const timestamp = nowIso();
  return {
    ...session,
    history: [
      ...session.history,
      {
        question: session.currentTurn.question ?? "",
        mode: session.currentTurn.mode ?? "single",
        options: session.currentTurn.options ?? [],
        selectedOptionIds: answer.selectedOptionIds,
        customAnswer: answer.customAnswer,
        progressPercent: session.currentTurn.progressPercent,
        createdAt: timestamp
      }
    ],
    updatedAt: timestamp
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
```

- [ ] **Step 4: Export the contract**

Modify `packages/shared/src/index.ts`:

```ts
export * from "./types.js";
export * from "./fixtures.js";
export * from "./itinerary.js";
export * from "./skill.js";
export * from "./skillCreator.js";
export * from "./evaluation.js";
```

- [ ] **Step 5: Run shared tests**

Run:

```bash
npm run test -w @journey/shared -- skillCreator
```

Expected: pass.

- [ ] **Step 6: Commit shared contract**

```bash
git add packages/shared/src/skillCreator.ts packages/shared/src/skillCreator.test.ts packages/shared/src/index.ts
git commit -m "feat: add skill creator agent contract"
```

---

### Task 2: API Persistence and Creator Agent Service

**Files:**
- Modify: `apps/api/src/db.ts`
- Create: `apps/api/src/services/skillCreatorAgentPrompt.ts`
- Create: `apps/api/src/services/skillCreatorAgentService.ts`

- [ ] **Step 1: Extend the database for creator sessions**

Modify `apps/api/src/db.ts` imports and table type:

```ts
import type {
  AgentSession,
  AgentTraceEvent,
  EvaluationCase,
  SkillCreatorSession,
  TravelItinerary,
  TravelSkill
} from "@journey/shared";

type TableName = "itineraries" | "skills" | "sessions" | "traces" | "evaluation_cases" | "skill_creator_sessions";
```

Add methods inside `JourneyDatabase` after the existing Skill methods:

```ts
  listSkillCreatorSessions(): SkillCreatorSession[] {
    return this.listJson<SkillCreatorSession>("skill_creator_sessions");
  }

  getSkillCreatorSession(id: string): SkillCreatorSession | undefined {
    return this.getJson<SkillCreatorSession>("skill_creator_sessions", id);
  }

  saveSkillCreatorSession(session: SkillCreatorSession): SkillCreatorSession {
    this.saveJson("skill_creator_sessions", session.id, session);
    return session;
  }
```

Add the table in `initialize()`:

```sql
      CREATE TABLE IF NOT EXISTS skill_creator_sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
```

- [ ] **Step 2: Add the project-specific system prompt**

Create `apps/api/src/services/skillCreatorAgentPrompt.ts`:

```ts
export const SKILL_CREATOR_AGENT_SYSTEM_PROMPT = [
  "你是本项目的旅行风格 Skill 创作助手。",
  "你的任务不是泛泛写一个 Skill，而是通过多轮选择题，把用户给出的游记、攻略、当前行程或自由描述整理成可复用的旅行风格 Skill。",
  "",
  "产品语境：",
  "- Skill 是旅行风格能力包，会发布到 Skill 广场，也可以导入未来的行程规划。",
  "- 最终草稿会映射到 TravelSkill：name、displayName、description、body、tags、rules、forbidden。",
  "- 最终系统会生成标准 SKILL.md，但用户在访谈中不需要看到 frontmatter、字段编辑或 SKILL.md。",
  "",
  "提问原则：",
  "- 每次只问一个问题。",
  "- 优先输出 single 或 multiple 选择题。",
  "- 每题必须提供 3 到 5 个选项，并允许用户自定义补充。",
  "- 不要问“这个 Skill 什么时候触发”“需要什么 frontmatter”“需要什么 bundled resources”这类元问题。",
  "- 你要把内部需要确认的信息翻译成旅行语境里的自然问题。",
  "- 好问题示例：这套旅行风格换到新城市时，哪些体验必须保留？",
  "- 好问题示例：如果目的地没有海边，优先用什么体验替代？",
  "- 好问题示例：生成行程时，哪些安排一出现就算跑偏？",
  "",
  "进度原则：",
  "- progressPercent 表示你判断这个 Skill 离最终检查还有多远。",
  "- progressPercent 可以前进，也可以在发现矛盾或信息不足时回退。",
  "- 不要把 progressPercent 当成题号或固定步骤。",
  "",
  "草稿原则：",
  "- 每轮根据答案返回 draftPatch，只包含本轮确定要新增或改写的字段。",
  "- rules 必须能影响行程生成，例如节奏、地点类型、路线取舍、留白方式。",
  "- forbidden 必须描述不希望 Agent 生成的安排，例如赶路、连续跨区、暴晒长距离步行、塞满日程。",
  "- description 要适合 Skill 广场浏览和推荐，不要写成长段分析。",
  "- body 要解释这个旅行风格如何复用，保持简洁。",
  "",
  "停止原则：",
  "- 只有当 displayName、description、body、tags、rules 至少都有可用内容时，才能返回 done: true。",
  "- 如果 forbidden 为空但用户材料没有明显禁忌，可以继续问一个关于跑偏安排的问题。",
  "- 如果用户回答互相矛盾，降低 progressPercent 并提出澄清题。",
  "",
  "输出格式：",
  "- 只返回 JSON 对象，不要使用 Markdown 代码块。",
  "- JSON 必须符合：assistantMessage、question、mode、options、customPlaceholder、progressPercent、draftPatch、done。",
  "- done 为 false 时必须包含 question、mode 和 3 到 5 个 options。",
  "- done 为 true 时不要继续返回 question。",
  "- options 的 id 使用 lowercase kebab-case。"
].join("\\n");
```

- [ ] **Step 3: Add the Creator Agent service**

Create `apps/api/src/services/skillCreatorAgentService.ts`:

```ts
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
  }

  async reply(input: SkillCreatorReplyInput): Promise<SkillCreatorReplyResult> {
    const session = this.db.getSkillCreatorSession(input.sessionId);
    if (!session) throw new Error(`Skill creator session not found: ${input.sessionId}`);
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
    if (parsed.done && !isSkillCreatorDraftReady(applySkillCreatorDraftPatch(session.draft, parsed.draftPatch))) {
      return {
        assistantMessage: "这版还差一个能稳定影响规划的规则，我需要再确认一次。",
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

function parseCreatorTurn(raw: string): SkillCreatorTurn {
  const cleaned = raw.trim().replace(/^```json\\s*/i, "").replace(/^```\\s*/i, "").replace(/```$/i, "").trim();
  return SkillCreatorTurnSchema.parse(JSON.parse(cleaned));
}

async function parseCreatorTurnWithRepair(raw: string, messages: DeepSeekMessage[], llmClient: LlmClient): Promise<SkillCreatorTurn> {
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
```

- [ ] **Step 4: Run API typecheck to expose integration failures**

Run:

```bash
npm run typecheck -w @journey/app-api
```

Expected: fail if imports are not exported from `@journey/shared`; after Task 1 is complete, it should move to route-related failures only.

- [ ] **Step 5: Commit persistence and service**

```bash
git add apps/api/src/db.ts apps/api/src/services/skillCreatorAgentPrompt.ts apps/api/src/services/skillCreatorAgentService.ts
git commit -m "feat: add skill creator agent service"
```

---

### Task 3: Creator Agent API Routes and Tests

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/server.test.ts`
- Modify: `apps/api/src/services/skillService.ts`

- [ ] **Step 1: Write failing API tests for the new start and reply routes**

Append these tests near the existing Skill creator tests in `apps/api/src/server.test.ts`:

```ts
  it("starts a Skill creator session through the project-specific Creator Agent prompt", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assistantMessage: "我先确认这套风格最该保留什么。",
                    question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                    mode: "multiple",
                    options: [
                      { id: "sunset", label: "傍晚留给散步和日落" },
                      { id: "shops", label: "优先找小店和街区" },
                      { id: "light", label: "每天最多两个核心点" }
                    ],
                    customPlaceholder: "也可以补充自己的说法",
                    progressPercent: 52,
                    draftPatch: {
                      tags: ["松弛", "小店"],
                      rules: ["傍晚时段优先保留低强度体验"]
                    },
                    done: false
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const result = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "喜欢海边散步、傍晚小店和松弛节奏。" })
      .expect(201);

    expect(result.body.session.id).toMatch(/^skill-creator-session-/);
    expect(result.body.turn.question).toBe("这套旅行风格换到新城市时，哪些体验必须保留？");
    expect(result.body.turn.progressPercent).toBe(52);
    expect(result.body.session.draft.rules).toEqual(expect.arrayContaining(["傍晚时段优先保留低强度体验"]));
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
    expect(body.messages[0].content).toContain("旅行风格 Skill 创作助手");
    expect(body.messages[0].content).not.toContain("Skill Creation Process");
  });

  it("records creator answers and allows Agent progress to move backward", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        const content =
          callCount === 1
            ? {
                question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                mode: "multiple",
                options: [
                  { id: "sunset", label: "傍晚留给散步和日落" },
                  { id: "shops", label: "优先找小店和街区" },
                  { id: "light", label: "每天最多两个核心点" }
                ],
                progressPercent: 70,
                draftPatch: { rules: ["每天最多两个核心点"] },
                done: false
              }
            : {
                question: "你刚才又想密集打卡，哪一种优先级更高？",
                mode: "single",
                options: [
                  { id: "relaxed", label: "保留松弛节奏" },
                  { id: "coverage", label: "优先覆盖更多景点" },
                  { id: "mixed", label: "每天只允许一个密集时段" }
                ],
                progressPercent: 55,
                draftPatch: { forbidden: ["为了打卡塞满每天行程"] },
                done: false
              };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const started = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "喜欢松弛节奏，但也想多看几个点。" })
      .expect(201);

    const reply = await request(app)
      .post(`/api/skills/creator/${started.body.session.id}/reply`)
      .send({
        selectedOptionIds: ["sunset"],
        customAnswer: "但我又有点想多打卡。"
      })
      .expect(200);

    expect(reply.body.turn.progressPercent).toBe(55);
    expect(reply.body.session.history).toHaveLength(1);
    expect(reply.body.session.draft.forbidden).toEqual(expect.arrayContaining(["为了打卡塞满每天行程"]));
  });

  it("blocks done when the Agent returns an incomplete final draft", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assistantMessage: "可以结束。",
                    progressPercent: 100,
                    draftPatch: { rules: [] },
                    done: true
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const result = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "只是喜欢慢慢逛。" })
      .expect(201);

    expect(result.body.turn.done).toBe(false);
    expect(result.body.turn.question).toBe("生成行程时，哪些安排一出现就算跑偏？");
    expect(result.body.turn.progressPercent).toBeLessThan(100);
  });

  it("repairs malformed Creator Agent JSON once before returning the turn", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        const content =
          callCount === 1
            ? "我想先问：这套风格最重要什么？"
            : JSON.stringify({
                question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                mode: "multiple",
                options: [
                  { id: "sunset", label: "傍晚留给散步和日落" },
                  { id: "shops", label: "优先找小店和街区" },
                  { id: "light", label: "每天最多两个核心点" }
                ],
                progressPercent: 45,
                draftPatch: { tags: ["松弛"] },
                done: false
              });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const result = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "喜欢傍晚散步和小店。" })
      .expect(201);

    expect(callCount).toBe(2);
    expect(result.body.turn.question).toBe("这套旅行风格换到新城市时，哪些体验必须保留？");
  });
```

- [ ] **Step 2: Run the API tests to verify they fail**

Run:

```bash
npm run test -w @journey/app-api -- server.test.ts -t "Skill creator"
```

Expected: fail because `/api/skills/creator/start` and `/api/skills/creator/:sessionId/reply` are not wired.

- [ ] **Step 3: Wire the new routes**

Modify imports in `apps/api/src/server.ts`:

```ts
import { SkillCreatorAgentService } from "./services/skillCreatorAgentService.js";
```

Instantiate the service inside `createApp`:

```ts
  const skillCreatorAgents = new SkillCreatorAgentService(db);
```

Replace the old creator reply route:

```ts
  app.post("/api/skills/creator/start", async (req, res) => {
    const itinerary =
      typeof req.body.itineraryId === "string" && req.body.itineraryId
        ? itineraries.get(req.body.itineraryId)
        : undefined;
    const result = await skillCreatorAgents.start({
      sourceText: asString(req.body.sourceText) ?? "",
      itinerary
    });
    res.status(201).json(result);
  });

  app.post("/api/skills/creator/:sessionId/reply", async (req, res) => {
    const result = await skillCreatorAgents.reply({
      sessionId: req.params.sessionId,
      answer: {
        selectedOptionIds: Array.isArray(req.body.selectedOptionIds) ? req.body.selectedOptionIds : [],
        customAnswer: asString(req.body.customAnswer) ?? ""
      }
    });
    res.json(result);
  });
```

Remove the legacy route:

```ts
  app.post("/api/skills/creator/reply", (req, res) => {
    res.json(skills.creatorReply(req.body));
  });
```

- [ ] **Step 4: Remove deterministic creator reply code from SkillService**

Modify `apps/api/src/services/skillService.ts`:

- Remove `SkillCreatorMessage`, `SkillCreatorReplyInput`, and `SkillCreatorReply`.
- Remove the `creatorReply` method.
- Remove helper functions used only by `creatorReply`: `updateSkillFromCreatorAnswer`, `buildCreatorAgentReply`, `buildCreatorNextQuestion`, `appendSentence`, `appendCreatorNote`, `compactCreatorAnswer`, and `splitCreatorLines`.

Keep `extract`, `update`, `publish`, `unpublish`, and recommendation behavior unchanged.

- [ ] **Step 5: Run API tests**

Run:

```bash
npm run test -w @journey/app-api -- server.test.ts -t "Skill creator"
```

Expected: pass.

- [ ] **Step 6: Run API typecheck**

Run:

```bash
npm run typecheck -w @journey/app-api
```

Expected: pass.

- [ ] **Step 7: Commit API routes**

```bash
git add apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/services/skillService.ts
git commit -m "feat: expose skill creator agent routes"
```

---

### Task 4: Strict Frontend API Helper

**Files:**
- Modify: `apps/web/src/api/client.ts`

- [ ] **Step 1: Add a strict JSON helper**

Modify `apps/web/src/api/client.ts`:

```ts
export async function apiPostStrict<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
```

Place it after `apiPost`.

- [ ] **Step 2: Run web typecheck**

Run:

```bash
npm run typecheck -w @journey/app-web
```

Expected: pass.

- [ ] **Step 3: Commit strict API helper**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat: add strict API helper for creator agent"
```

---

### Task 5: Frontend Question-Only Creator Flow

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write failing frontend tests for question-only Creator UX**

Replace the existing creator conversation tests in `apps/web/src/App.test.tsx` with tests that use `/api/skills/creator/start` and `/api/skills/creator/:sessionId/reply`:

```ts
  it("shows only the current Agent question during Skill creation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          return new Response(
            JSON.stringify({
              session: {
                id: "skill-creator-session-test",
                sourceText: "海边散步和傍晚小店",
                draft: testTravelSkill("skill-question-only"),
                currentTurn: {
                  question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                  mode: "multiple",
                  options: [
                    { id: "sunset", label: "傍晚留给散步和日落" },
                    { id: "shops", label: "优先找小店和街区" },
                    { id: "light", label: "每天最多两个核心点" }
                  ],
                  customPlaceholder: "也可以补充自己的说法",
                  progressPercent: 52,
                  draftPatch: {},
                  done: false
                },
                history: [],
                status: "active",
                createdAt: "2026-06-16T00:00:00.000Z",
                updatedAt: "2026-06-16T00:00:00.000Z"
              },
              turn: {
                question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                mode: "multiple",
                options: [
                  { id: "sunset", label: "傍晚留给散步和日落" },
                  { id: "shops", label: "优先找小店和街区" },
                  { id: "light", label: "每天最多两个核心点" }
                ],
                customPlaceholder: "也可以补充自己的说法",
                progressPercent: 52,
                draftPatch: {},
                done: false
              }
            }),
            { status: 201, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.clear(screen.getByLabelText("来源材料"));
    await user.type(screen.getByLabelText("来源材料"), "海边散步和傍晚小店");
    await user.click(screen.getByRole("button", { name: "开始创作" }));

    expect(await screen.findByText("这套旅行风格换到新城市时，哪些体验必须保留？")).toBeInTheDocument();
    expect(screen.getByText("52%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "傍晚留给散步和日落" })).toBeInTheDocument();
    expect(screen.queryByText("第 1 题")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("最终 Skill 产物")).not.toBeInTheDocument();
    expect(screen.queryByText("frontmatter")).not.toBeInTheDocument();
    expect(screen.queryByText("SKILL.md")).not.toBeInTheDocument();
  });

  it("submits selected options and custom input to the Creator Agent reply route", async () => {
    const replyBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          return new Response(JSON.stringify(startCreatorFixture("skill-creator-session-submit")), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills/creator/skill-creator-session-submit/reply")) {
          replyBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({
              session: {
                ...startCreatorFixture("skill-creator-session-submit").session,
                currentTurn: {
                  question: "生成行程时，哪些安排一出现就算跑偏？",
                  mode: "multiple",
                  options: [
                    { id: "packed", label: "每天塞满太多景点" },
                    { id: "transfer", label: "连续跨区折返" },
                    { id: "hot-walk", label: "午后暴晒长距离步行" }
                  ],
                  progressPercent: 68,
                  draftPatch: {},
                  done: false
                }
              },
              turn: {
                question: "生成行程时，哪些安排一出现就算跑偏？",
                mode: "multiple",
                options: [
                  { id: "packed", label: "每天塞满太多景点" },
                  { id: "transfer", label: "连续跨区折返" },
                  { id: "hot-walk", label: "午后暴晒长距离步行" }
                ],
                progressPercent: 68,
                draftPatch: {},
                done: false
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );

    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.click(screen.getByRole("button", { name: "开始创作" }));
    await user.click(await screen.findByRole("button", { name: "傍晚留给散步和日落" }));
    await user.click(screen.getByRole("button", { name: "优先找小店和街区" }));
    await user.type(screen.getByLabelText("补充答案"), "还要保留临时发现小店的随机感");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => expect(replyBodies).toHaveLength(1));
    expect(replyBodies[0]).toEqual({
      selectedOptionIds: ["sunset", "shops"],
      customAnswer: "还要保留临时发现小店的随机感"
    });
  });

  it("keeps final Skill details collapsed until final review is expanded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          return new Response(JSON.stringify(doneCreatorFixture()), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );

    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.click(screen.getByRole("button", { name: "开始创作" }));

    expect(await screen.findByText("海边小店松弛风格")).toBeInTheDocument();
    expect(screen.queryByText("name: seaside-shop-style")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开最终 Skill 产物" }));
    expect(screen.getByText("name: seaside-shop-style")).toBeInTheDocument();
  });

  it("shows a retryable error and preserves the answer when Creator Agent reply fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          return new Response(JSON.stringify(startCreatorFixture("skill-creator-session-error")), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills/creator/skill-creator-session-error/reply")) {
          return new Response(JSON.stringify({ message: "Creator Agent failed" }), {
            status: 502,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );

    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.click(screen.getByRole("button", { name: "开始创作" }));
    await user.click(await screen.findByRole("button", { name: "傍晚留给散步和日落" }));
    await user.type(screen.getByLabelText("补充答案"), "还要保留随机发现小店的感觉");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(await screen.findByText("创作助手没有返回可用问题，请重试本题。")).toBeInTheDocument();
    expect(screen.getByLabelText("补充答案")).toHaveValue("还要保留随机发现小店的感觉");
  });
```

Add helpers near other test helpers in `apps/web/src/App.test.tsx`:

```ts
function testTravelSkill(id: string) {
  return {
    id,
    name: "seaside-shop-style",
    displayName: "海边小店松弛风格",
    description: "适合保留海边散步、小店探索和慢节奏的旅行风格。",
    body: "把用户喜欢的海边散步、小店和日落体验复用到新目的地。",
    tags: ["海边", "小店", "松弛"],
    rules: ["每天最多两个核心安排"],
    forbidden: ["连续跨区赶路"],
    status: "draft",
    source: "extracted",
    imports: 0,
    favorites: 0,
    favorited: false,
    createdAt: "2026-06-16T00:00:00.000Z",
    updatedAt: "2026-06-16T00:00:00.000Z"
  };
}

function startCreatorFixture(sessionId: string) {
  return {
    session: {
      id: sessionId,
      sourceText: "海边散步和傍晚小店",
      draft: testTravelSkill("skill-question-fixture"),
      currentTurn: {
        question: "这套旅行风格换到新城市时，哪些体验必须保留？",
        mode: "multiple",
        options: [
          { id: "sunset", label: "傍晚留给散步和日落" },
          { id: "shops", label: "优先找小店和街区" },
          { id: "light", label: "每天最多两个核心点" }
        ],
        customPlaceholder: "也可以补充自己的说法",
        progressPercent: 52,
        draftPatch: {},
        done: false
      },
      history: [],
      status: "active",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    },
    turn: {
      question: "这套旅行风格换到新城市时，哪些体验必须保留？",
      mode: "multiple",
      options: [
        { id: "sunset", label: "傍晚留给散步和日落" },
        { id: "shops", label: "优先找小店和街区" },
        { id: "light", label: "每天最多两个核心点" }
      ],
      customPlaceholder: "也可以补充自己的说法",
      progressPercent: 52,
      draftPatch: {},
      done: false
    }
  };
}

function doneCreatorFixture() {
  return {
    session: {
      id: "skill-creator-session-done",
      sourceText: "海边散步和傍晚小店",
      draft: testTravelSkill("skill-done-fixture"),
      currentTurn: {
        assistantMessage: "这版已经可以进入最终检查。",
        progressPercent: 100,
        draftPatch: {},
        done: true
      },
      history: [],
      status: "ready",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:00.000Z"
    },
    turn: {
      assistantMessage: "这版已经可以进入最终检查。",
      progressPercent: 100,
      draftPatch: {},
      done: true
    }
  };
}
```

- [ ] **Step 2: Run frontend tests to verify they fail**

Run:

```bash
npm run test -w @journey/app-web -- App.test.tsx -t "Skill creation"
```

Expected: fail because the Creator UI still renders the old conversation and final artifact panel.

- [ ] **Step 3: Import shared Creator types and strict API helper**

Modify the import from `@journey/shared` in `apps/web/src/App.tsx` to include:

```ts
  buildSkillMarkdown,
  type SkillCreatorSession,
  type SkillCreatorTurn,
  type SkillCreatorOption
```

Modify the API import:

```ts
import { ApiStreamEventError, apiDelete, apiEventStream, apiGet, apiPost, apiPostStrict, apiPatch, apiText } from "@/api/client";
```

Replace local creator response types near the other type declarations:

```ts
type SkillCreatorStartResponse = {
  session: SkillCreatorSession;
  turn: SkillCreatorTurn;
};
type SkillCreatorReplyResponse = SkillCreatorStartResponse;
```

- [ ] **Step 4: Replace creator API functions in App**

Replace `extractSkill` and `replyToSkillCreator` in `apps/web/src/App.tsx` with:

```ts
  async function startSkillCreatorSession(): Promise<SkillCreatorStartResponse> {
    const useItineraryContext = creatorSourceMode === "itinerary" || creatorSourceMode === "conversation";
    const result = await apiPostStrict<SkillCreatorStartResponse>(
      "/skills/creator/start",
      useItineraryContext ? { sourceText: creatorText, itineraryId: itinerary.id } : { sourceText: creatorText }
    );
    setSkills((current) => [result.session.draft, ...current.filter((skill) => skill.id !== result.session.draft.id)]);
    setCreatorDraft(result.session.draft);
    return result;
  }

  async function replyToSkillCreator(sessionId: string, answer: { selectedOptionIds: string[]; customAnswer: string }): Promise<SkillCreatorReplyResponse> {
    const result = await apiPostStrict<SkillCreatorReplyResponse>(`/skills/creator/${sessionId}/reply`, answer);
    setSkills((current) => [result.session.draft, ...current.filter((skill) => skill.id !== result.session.draft.id)]);
    setCreatorDraft(result.session.draft);
    return result;
  }
```

Update the `SkillCreator` call site:

```tsx
              <SkillCreator
                sourceText={creatorText}
                onSourceTextChange={setCreatorText}
                onUseCurrentItinerary={useCurrentItineraryAsSkillSource}
                onStart={startSkillCreatorSession}
                onCreatorReply={replyToSkillCreator}
                onPublish={publishSkill}
              />
```

- [ ] **Step 5: Replace the Creator UI with question-only flow**

Replace `SkillCreator`, `SkillDraftEditor`, `SkillCreatorConversation`, `SkillCreatorArtifactPanel`, `initialSkillCreatorMessage`, `nextSkillCreatorMessage`, `buildCreatorDraftFromFields`, and `buildFallbackSkillCreatorReply` in `apps/web/src/App.tsx` with:

```tsx
function SkillCreator({
  sourceText,
  onSourceTextChange,
  onUseCurrentItinerary,
  onStart,
  onCreatorReply,
  onPublish
}: {
  sourceText: string;
  onSourceTextChange: (value: string) => void;
  onUseCurrentItinerary: () => void;
  onStart: () => Promise<SkillCreatorStartResponse>;
  onCreatorReply: (sessionId: string, answer: { selectedOptionIds: string[]; customAnswer: string }) => Promise<SkillCreatorReplyResponse>;
  onPublish: (changes: Partial<TravelSkill>) => void;
}) {
  const [session, setSession] = useState<SkillCreatorSession | null>(null);
  const [turn, setTurn] = useState<SkillCreatorTurn | null>(null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [customAnswer, setCustomAnswer] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceText.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onStart();
      setSession(result.session);
      setTurn(result.turn);
      setSelectedOptionIds([]);
      setCustomAnswer("");
      setAdvancedOpen(false);
    } catch {
      setError("创作助手暂时无法开始，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !turn || busy) return;
    if (!customAnswer.trim() && selectedOptionIds.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await onCreatorReply(session.id, {
        selectedOptionIds,
        customAnswer: customAnswer.trim()
      });
      setSession(result.session);
      setTurn(result.turn);
      setSelectedOptionIds([]);
      setCustomAnswer("");
      setAdvancedOpen(false);
    } catch {
      setError("创作助手没有返回可用问题，请重试本题。");
    } finally {
      setBusy(false);
    }
  }

  function toggleOption(option: SkillCreatorOption) {
    if (!turn?.mode) return;
    setSelectedOptionIds((current) => {
      if (turn.mode === "single") return current.includes(option.id) ? [] : [option.id];
      return current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id];
    });
  }

  return (
    <main className="mx-auto flex h-[calc(100dvh-32px)] max-w-5xl flex-col gap-4 overflow-hidden p-4 md:p-6">
      <div className="shrink-0">
        <h2 className="text-3xl font-black">创作 Skill</h2>
        <p className="text-muted-foreground">把旅行经验交给创作助手，由它主持问题并生成可发布的旅行风格。</p>
      </div>

      {!session || !turn ? (
        <form className="grid min-h-0 flex-1 gap-4 rounded-xl border border-border bg-white p-4" onSubmit={handleStart}>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" className="rounded-xl" onClick={onUseCurrentItinerary}>
              <MapPinned data-icon="inline-start" />
              使用当前行程
            </Button>
          </div>
          <label className="grid min-h-0 gap-2 text-sm font-black text-foreground">
            来源材料
            <Textarea
              value={sourceText}
              onChange={(event) => onSourceTextChange(event.target.value)}
              className="min-h-[300px] bg-white text-base leading-7"
              aria-label="来源材料"
              placeholder="粘贴游记、攻略，或描述想沉淀的旅行风格。"
              disabled={busy}
            />
          </label>
          {error && <p className="text-sm font-bold text-destructive">{error}</p>}
          <Button type="submit" className="rounded-xl" disabled={!sourceText.trim() || busy}>
            <Sparkles data-icon="inline-start" />
            {busy ? "正在开始..." : "开始创作"}
          </Button>
        </form>
      ) : turn.done ? (
        <SkillCreatorFinalReview
          session={session}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
          onPublish={onPublish}
        />
      ) : (
        <form className="flex min-h-0 flex-1 flex-col gap-5 rounded-xl border border-border bg-white p-5" onSubmit={handleSubmitAnswer}>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-black text-muted-foreground">创作助手</div>
            <div className="flex min-w-48 items-center gap-2" aria-label={`创作进度 ${turn.progressPercent}%`}>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary" style={{ width: `${turn.progressPercent}%` }} />
              </div>
              <span className="text-sm font-black">{turn.progressPercent}%</span>
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-black text-muted-foreground">{turn.mode === "multiple" ? "多选，也可以补充自己的说法" : "单选，也可以补充自己的说法"}</p>
            <h3 className="text-3xl font-black leading-tight">{turn.question}</h3>
          </div>
          <div className="grid gap-3">
            {(turn.options ?? []).map((option) => {
              const selected = selectedOptionIds.includes(option.id);
              return (
                <Button
                  key={option.id}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  className="h-auto justify-start rounded-xl px-4 py-4 text-left text-base leading-6"
                  onClick={() => toggleOption(option)}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          <label className="grid gap-2 text-sm font-black text-muted-foreground">
            补充答案
            <Input
              value={customAnswer}
              onChange={(event) => setCustomAnswer(event.target.value)}
              aria-label="补充答案"
              placeholder={turn.customPlaceholder ?? "也可以写自己的答案"}
              disabled={busy}
            />
          </label>
          {error && <p className="text-sm font-bold text-destructive">{error}</p>}
          <div className="mt-auto flex justify-end border-t border-border pt-4">
            <Button type="submit" className="rounded-xl" disabled={busy || (!customAnswer.trim() && selectedOptionIds.length === 0)}>
              <Send data-icon="inline-start" />
              {busy ? "提交中..." : "提交回答"}
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}

function SkillCreatorFinalReview({
  session,
  advancedOpen,
  onToggleAdvanced,
  onPublish
}: {
  session: SkillCreatorSession;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  onPublish: (changes: Partial<TravelSkill>) => void;
}) {
  const draft = session.draft;
  const preview = buildSkillMarkdown({
    name: draft.name,
    description: draft.description,
    body: draft.body,
    tags: draft.tags,
    rules: draft.rules,
    forbidden: draft.forbidden
  });
  const validation = validateSkillMarkdown(preview);

  return (
    <section className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-white p-5" aria-label="最终检查">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black text-muted-foreground">创作完成</p>
          <h3 className="mt-2 text-2xl font-black">{draft.displayName}</h3>
          <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-muted-foreground">{draft.description}</p>
        </div>
        <Badge className="bg-accent text-accent-foreground">可发布</Badge>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {draft.tags.map((tag) => (
          <Badge key={tag} className="bg-secondary text-foreground">
            {tag}
          </Badge>
        ))}
      </div>
      <div className="mt-5 grid gap-3 rounded-xl bg-[#fbfbf9] p-4">
        <h4 className="text-sm font-black">会影响行程的规则</h4>
        <ul className="grid gap-2 text-sm font-semibold leading-6">
          {draft.rules.map((rule) => (
            <li key={rule}>- {rule}</li>
          ))}
        </ul>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Button className="rounded-xl" disabled={!validation.valid} onClick={() => onPublish(draft)}>
          <Sparkles data-icon="inline-start" />
          发布到广场
        </Button>
        <Button type="button" variant="outline" className="rounded-xl" onClick={onToggleAdvanced}>
          {advancedOpen ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
          {advancedOpen ? "收起最终 Skill 产物" : "展开最终 Skill 产物"}
        </Button>
      </div>
      {advancedOpen && (
        <div className="mt-5 grid gap-4 border-t border-border pt-5">
          {!validation.valid && <SkillValidationSummary title="发布检查" validation={validation} />}
          <p className="text-xs font-bold text-muted-foreground">frontmatter、字段编辑和 SKILL.md 预览只在最终检查里展示。</p>
          <pre className="max-h-80 overflow-auto rounded-xl bg-secondary p-4 text-xs leading-6">{preview}</pre>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Remove old creator fallback helpers**

Delete these functions from `apps/web/src/App.tsx` if they remain:

```ts
function nextSkillCreatorMessage(stage: number): string
function buildFallbackSkillCreatorReply(skill: TravelSkill, messages: SkillCreatorConversationMessage[], answer: string): SkillCreatorReplyResponse
function mergeCreatorDescription(current: string, answer: string): string
function mergeCreatorTags(current: string, additions: string[]): string
function mergeCreatorBodyNote(body: string, title: string, answer: string): string
function compactCreatorAnswer(answer: string): string
```

Remove the unused `SkillCreatorConversationMessage` type if nothing else references it.

- [ ] **Step 7: Run frontend Creator tests**

Run:

```bash
npm run test -w @journey/app-web -- App.test.tsx -t "Skill creation"
```

Expected: pass.

- [ ] **Step 8: Run web typecheck**

Run:

```bash
npm run typecheck -w @journey/app-web
```

Expected: pass.

- [ ] **Step 9: Commit frontend flow**

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat: redesign skill creator as agent question flow"
```

---

### Task 6: Full Verification and Browser QA

**Files:**
- No source edits expected unless verification reveals a defect.

- [ ] **Step 1: Run shared tests**

Run:

```bash
npm run test -w @journey/shared
```

Expected: pass.

- [ ] **Step 2: Run API tests**

Run:

```bash
npm run test -w @journey/app-api
```

Expected: pass.

- [ ] **Step 3: Run web tests**

Run:

```bash
npm run test -w @journey/app-web
```

Expected: pass.

- [ ] **Step 4: Run repository typecheck**

Run:

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Run production build**

Run:

```bash
npm run build
```

Expected: pass.

- [ ] **Step 6: Start the dev server**

Run:

```bash
npm run dev
```

Expected: API and web dev servers start. Use the printed web URL.

- [ ] **Step 7: Browser QA in the in-app browser**

Open `/creator` in the in-app browser and verify:

- Initial screen shows `来源材料`, `使用当前行程`, and `开始创作`.
- After starting, the page shows one Agent question, options, custom input, submit button, and a percentage.
- The interview screen does not show a question number, assistant judgment panel, final artifact panel, `frontmatter`, field editing, or `SKILL.md`.
- Multi-select options can be toggled without layout shift.
- A Creator Agent failure shows a retryable error and preserves the answer.
- When the Agent returns `done: true`, final review shows a human-readable summary.
- `SKILL.md` appears only after clicking `展开最终 Skill 产物`.

- [ ] **Step 8: Commit verification fixes if needed**

If verification required fixes, commit only those touched files:

```bash
git add packages/shared/src/skillCreator.ts packages/shared/src/skillCreator.test.ts packages/shared/src/index.ts apps/api/src/db.ts apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/services/skillService.ts apps/api/src/services/skillCreatorAgentPrompt.ts apps/api/src/services/skillCreatorAgentService.ts apps/web/src/api/client.ts apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "fix: stabilize skill creator agent flow"
```

If no fixes were needed, do not create an empty commit.
