import {
  appendSkillVersion,
  buildSkillMarkdown,
  buildExtractedSkillDraftTitle,
  normalizeSkillVersionHistory,
  nowIso,
  parseSkillMarkdown,
  recommendSkills,
  summarizeItineraryAsSkill,
  type SkillRecommendation,
  type SkillRecommendationContext,
  type TravelItinerary,
  type TravelSkill
} from "@journey/shared";
import type { JourneyDatabase } from "../db.js";

type SkillUpdate = Partial<
  Pick<TravelSkill, "displayName" | "description" | "body" | "tags" | "rules" | "forbidden" | "status">
>;

export class SkillService {
  constructor(private readonly db: JourneyDatabase) {}

  list(options: { favoriteOnly?: boolean } = {}): TravelSkill[] {
    const skills = this.db.listSkills().map(normalizeSkill);
    return options.favoriteOnly ? skills.filter((skill) => skill.favorited) : skills;
  }

  get(id: string): TravelSkill {
    const skill = this.db.getSkill(id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    return normalizeSkill(skill);
  }

  recommend(context: SkillRecommendationContext): SkillRecommendation[] {
    return recommendSkills(this.list(), context);
  }

  importMarkdown(markdown: string): TravelSkill {
    const skill = parseSkillMarkdown(markdown);
    return this.db.saveSkill(skill);
  }

  extract(sourceText: string, itinerary?: TravelItinerary): TravelSkill {
    let skill: TravelSkill;
    if (itinerary) {
      skill = summarizeItineraryAsSkill(itinerary, sourceText);
    } else {
      const timestamp = nowIso();
      const tags = inferTags(sourceText);
      const markdown = buildSkillMarkdown({
        name: "extracted-travel-style",
        description: "从用户粘贴内容中提取的旅行风格草稿，需要确认后发布。",
        body: [
          "该 Skill 从外部游记或攻略文本中提取。",
          "",
          "## 风格摘要",
          sourceText,
          "",
          "## 规划规则",
          "- 保留文本中反复出现的节奏、地点类型和禁忌。",
          "- 根据新目的地重新适配，不直接复制全部地点。"
        ].join("\n"),
        tags,
        rules: ["根据新目的地重新适配", "保留原文本偏好的节奏"],
        forbidden: ["未经用户确认直接发布"]
      });
      skill = {
        ...parseSkillMarkdown(markdown),
        id: `skill-extracted-${Date.now().toString(36)}`,
        displayName: buildExtractedSkillDraftTitle({ tags }),
        status: "draft",
        source: "extracted",
        createdAt: timestamp,
        updatedAt: timestamp
      };
    }

    return this.db.saveSkill(skill);
  }

  update(id: string, changes: SkillUpdate): TravelSkill {
    const skill = this.get(id);
    const timestamp = nowIso();
    return this.db.saveSkill({
      ...appendSkillVersion(skill, cleanSkillChanges(changes), { createdAt: timestamp }),
      updatedAt: timestamp
    });
  }

  publish(id: string, changes: SkillUpdate): TravelSkill {
    const skill = this.get(id);
    const timestamp = nowIso();
    const cleaned = cleanSkillChanges({
      ...changes,
      status: "published"
    });
    return this.db.saveSkill({
      ...appendSkillVersion(skill, cleaned, { summary: "发布到广场", createdAt: timestamp }),
      updatedAt: timestamp
    });
  }

  unpublish(id: string): TravelSkill {
    const skill = this.get(id);
    const timestamp = nowIso();
    return this.db.saveSkill({
      ...appendSkillVersion(skill, { status: "draft" }, { summary: "转回草稿", createdAt: timestamp }),
      updatedAt: timestamp
    });
  }

  favorite(id: string, favorited = true): TravelSkill {
    const skill = this.get(id);
    const nextFavorited = Boolean(favorited);
    const favorites =
      nextFavorited === skill.favorited
        ? skill.favorites
        : Math.max(0, skill.favorites + (nextFavorited ? 1 : -1));
    return this.db.saveSkill({
      ...skill,
      favorited: nextFavorited,
      favorites,
      updatedAt: nowIso()
    });
  }

  recordImport(id: string): TravelSkill {
    const skill = this.get(id);
    return this.db.saveSkill({
      ...skill,
      imports: skill.imports + 1,
      updatedAt: nowIso()
    });
  }

  delete(id: string): void {
    this.db.deleteSkill(id);
  }
}

function inferTags(text: string): string[] {
  const known = ["慢节奏", "咖啡", "citywalk", "亲子", "博物馆", "海边", "松弛", "小店", "日落"];
  return known.filter((tag) => text.includes(tag));
}

function normalizeSkill(skill: TravelSkill): TravelSkill {
  return {
    ...skill,
    tags: skill.tags ?? [],
    rules: skill.rules ?? [],
    forbidden: skill.forbidden ?? [],
    imports: skill.imports ?? 0,
    favorites: skill.favorites ?? 0,
    favorited: skill.favorited ?? false,
    versionHistory: normalizeSkillVersionHistory(skill)
  };
}

function cleanSkillChanges(changes: SkillUpdate): SkillUpdate {
  const cleaned: SkillUpdate = {};
  if (typeof changes.displayName === "string") cleaned.displayName = changes.displayName.trim();
  if (typeof changes.description === "string") cleaned.description = changes.description.trim();
  if (typeof changes.body === "string") cleaned.body = changes.body.trim();
  if (Array.isArray(changes.tags)) cleaned.tags = uniqueCleanList(changes.tags);
  if (Array.isArray(changes.rules)) cleaned.rules = uniqueCleanList(changes.rules);
  if (Array.isArray(changes.forbidden)) cleaned.forbidden = uniqueCleanList(changes.forbidden);
  if (changes.status) cleaned.status = changes.status;
  return cleaned;
}

function uniqueCleanList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
