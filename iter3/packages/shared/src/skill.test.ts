import { describe, expect, it } from "vitest";
import {
  buildExtractedSkillDraftTitle,
  buildSkillMarkdown,
  parseSkillMarkdown,
  recommendSkills,
  summarizeItineraryAsSkill,
  validateSkillMarkdown
} from "./skill";
import { addActivity, createDraftItinerary } from "./itinerary";
import { TravelSkillSchema, type TravelSkill } from "./types";

describe("travel skill helpers", () => {
  it("parses standard SKILL.md frontmatter and body", () => {
    const skill = parseSkillMarkdown(`---
name: slow-citywalk
description: 适合慢节奏城市漫步、咖啡和街区观察的旅行风格
tags: ["慢节奏", "雨天"]
---

# 慢节奏城市漫步
优先安排步行可达的街区、咖啡馆和轻量景点。

## 规划规则
- 每天预留休息时间`);

    expect(skill.name).toBe("slow-citywalk");
    expect(skill.description).toContain("慢节奏城市漫步");
    expect(skill.body).toContain("优先安排");
    expect(skill.tags).toContain("慢节奏");
    expect(skill.tags).toContain("雨天");
  });

  it("validates whether uploaded Skill markdown is ready for travel planning", () => {
    const valid = validateSkillMarkdown(`---
name: rainy-cafe-style
description: 适合雨天、咖啡、室内和不赶路的旅行风格
---

# Rainy Cafe Style

## 规划规则
- 雨天优先室内景点和咖啡休息`);

    expect(valid.valid).toBe(true);
    expect(valid.issues).toEqual([]);
    expect(valid.checks.every((check) => check.passed)).toBe(true);

    const invalid = validateSkillMarkdown(`---
name: loose-notes
---

只是一些游记片段，还没有整理成规划规则。`);

    expect(invalid.valid).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining(["需要填写 description", "至少添加一条规划规则"])
    );
  });

  it("builds a publishable SKILL.md with required frontmatter", () => {
    const markdown = buildSkillMarkdown({
      name: "museum-family",
      description: "适合亲子博物馆旅行",
      body: "保持上午重点参观，下午安排休息。",
      tags: ["亲子", "博物馆"],
      rules: ["每天最多两个重体力景点"],
      forbidden: ["连续三小时无休息"]
    });

    expect(markdown).toContain("name: museum-family");
    expect(markdown).toContain("description: 适合亲子博物馆旅行");
    expect(markdown).toContain("## 规划规则");
    expect(markdown).toContain("- 每天最多两个重体力景点");
  });

  it("keeps version history metadata on travel skills", () => {
    const parsed = TravelSkillSchema.parse({
      id: "skill-versioned-style",
      name: "versioned-style",
      displayName: "版本化旅行风格",
      description: "适合多次迭代维护的旅行风格。",
      body: "根据用户反馈持续更新规划规则。",
      tags: ["慢节奏"],
      rules: ["每天保留休息段"],
      forbidden: [],
      status: "published",
      source: "extracted",
      imports: 0,
      favorites: 0,
      favorited: false,
      versionHistory: [
        {
          version: 1,
          summary: "发布到广场",
          changedFields: ["名称", "说明", "规则"],
          createdAt: "2026-06-15T10:00:00.000Z"
        }
      ],
      createdAt: "2026-06-15T10:00:00.000Z",
      updatedAt: "2026-06-15T10:00:00.000Z"
    });

    expect(parsed.versionHistory?.[0]).toMatchObject({
      version: 1,
      summary: "发布到广场",
      changedFields: ["名称", "说明", "规则"]
    });
  });

  it("builds distinguishable names for extracted skill drafts", () => {
    expect(
      buildExtractedSkillDraftTitle({
        destination: "厦门",
        sourceTitle: "海边松弛游",
        tags: ["海边", "日落"]
      })
    ).toBe("厦门 · 海边松弛游风格草稿");
    expect(buildExtractedSkillDraftTitle({ tags: ["海边", "小店", "日落"] })).toBe("海边、小店、日落风格草稿");
    expect(buildExtractedSkillDraftTitle({})).toBe("旅行风格草稿");
  });

  it("recommends skills by destination, companion, preferences, tags, and itinerary context", () => {
    const skills: TravelSkill[] = [
      {
        id: "s1",
        name: "slow-citywalk",
        displayName: "慢节奏街区",
        description: "城市漫步、咖啡、街区观察",
        body: "适合上海、杭州的 citywalk",
        tags: ["慢节奏", "咖啡", "citywalk"],
        rules: [],
        forbidden: [],
        status: "published",
        source: "plaza",
        imports: 12,
        favorites: 8,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      },
      {
        id: "s2",
        name: "hardcore-hiking",
        displayName: "高强度徒步",
        description: "山野徒步和长距离路线",
        body: "适合高海拔",
        tags: ["徒步"],
        rules: [],
        forbidden: [],
        status: "published",
        source: "plaza",
        imports: 99,
        favorites: 20,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z"
      }
    ];

    const result = recommendSkills(skills, {
      destination: "杭州",
      companions: ["朋友"],
      preferences: ["慢节奏", "咖啡"],
      currentText: "想要 citywalk 和轻松街区"
    });

    expect(result[0]?.skill.id).toBe("s1");
    expect(result[0]?.reasons).toEqual(
      expect.arrayContaining(["匹配偏好：慢节奏", "匹配偏好：咖啡", "匹配当前行程语境"])
    );
  });

  it("summarizes an itinerary into an editable skill draft instead of publishing directly", () => {
    let itinerary = createDraftItinerary({
      title: "厦门松弛海边",
      destination: "厦门",
      startDate: "2026-11-01",
      dayCount: 1,
      preferences: ["海边", "慢节奏"]
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "沙坡尾散步",
      placeName: "沙坡尾",
      tags: ["海边", "citywalk"],
      startTime: "16:00",
      endTime: "18:00"
    });

    const draft = summarizeItineraryAsSkill(itinerary, "用户喜欢不赶路、海边散步和小店探索。");

    expect(draft.status).toBe("draft");
    expect(draft.source).toBe("extracted");
    expect(draft.displayName).toBe("厦门 · 厦门松弛海边风格草稿");
    expect(draft.body).toContain("厦门");
    expect(draft.body).toContain("沙坡尾散步");
  });
});
