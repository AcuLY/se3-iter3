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
