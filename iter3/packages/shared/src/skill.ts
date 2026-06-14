import type {
  SkillDraftInput,
  SkillRecommendation,
  SkillRecommendationContext,
  TravelItinerary,
  TravelSkill
} from "./types.js";
import { createId, nowIso } from "./itinerary.js";

const KNOWN_TAGS = [
  "慢节奏",
  "咖啡",
  "citywalk",
  "亲子",
  "博物馆",
  "海边",
  "徒步",
  "美食",
  "夜景",
  "街区",
  "松弛",
  "小店",
  "日落",
  "高强度"
];

export function parseSkillMarkdown(markdown: string): TravelSkill {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }

  const frontmatter = parseFrontmatter(match[1] ?? "");
  const body = (match[2] ?? "").trim();
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error("SKILL.md frontmatter requires name and description");
  }

  const timestamp = nowIso();
  return {
    id: createId("skill"),
    name: frontmatter.name,
    displayName: titleFromName(frontmatter.name),
    description: frontmatter.description,
    body,
    tags: extractTags(`${frontmatter.description}\n${body}`),
    rules: extractListSection(body, "规划规则"),
    forbidden: extractListSection(body, "禁止模式"),
    status: "draft",
    source: "uploaded",
    imports: 0,
    favorites: 0,
    favorited: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function buildSkillMarkdown(input: SkillDraftInput): string {
  const tags = input.tags?.length ? `\ntags: [${input.tags.map((tag) => `"${tag}"`).join(", ")}]` : "";
  const rules = input.rules?.length ? `\n\n## 规划规则\n${input.rules.map((rule) => `- ${rule}`).join("\n")}` : "";
  const forbidden = input.forbidden?.length
    ? `\n\n## 禁止模式\n${input.forbidden.map((rule) => `- ${rule}`).join("\n")}`
    : "";
  return `---\nname: ${input.name}\ndescription: ${input.description}${tags}\n---\n\n# ${titleFromName(input.name)}\n\n${input.body.trim()}${rules}${forbidden}\n`;
}

export function recommendSkills(
  skills: TravelSkill[],
  context: SkillRecommendationContext
): SkillRecommendation[] {
  const imported = new Set(context.importedSkillIds ?? []);
  return skills
    .filter((skill) => skill.status === "published" && !imported.has(skill.id))
    .map((skill) => {
      const haystack = [skill.name, skill.displayName, skill.description, skill.body, ...skill.tags].join(" ").toLowerCase();
      const reasons: string[] = [];
      let score = 0;

      if (context.destination && haystack.includes(context.destination.toLowerCase())) {
        score += 3;
        reasons.push(`匹配目的地：${context.destination}`);
      }

      for (const preference of context.preferences ?? []) {
        if (haystack.includes(preference.toLowerCase())) {
          score += 4;
          reasons.push(`匹配偏好：${preference}`);
        }
      }

      for (const companion of context.companions ?? []) {
        if (haystack.includes(companion.toLowerCase())) {
          score += 2;
          reasons.push(`匹配同行人：${companion}`);
        }
      }

      if (context.currentText) {
        const currentTokens = tokenize(context.currentText);
        const matched = currentTokens.some((token) => token.length > 1 && haystack.includes(token.toLowerCase()));
        if (matched) {
          score += 3;
          reasons.push("匹配当前行程语境");
        }
      }

      score += Math.min(2, skill.favorites / 10);
      score += Math.min(2, skill.imports / 20);

      return {
        skill,
        score,
        reasons: reasons.length ? reasons : ["通用旅行风格，可作为灵感补充"]
      };
    })
    .sort((a, b) => b.score - a.score || b.skill.favorites - a.skill.favorites);
}

export function summarizeItineraryAsSkill(itinerary: TravelItinerary, conversationSummary = ""): TravelSkill {
  const timestamp = nowIso();
  const activityLines = itinerary.days.flatMap((day) =>
    day.activities.map((activity) => `- ${day.title} ${activity.title}${activity.placeName ? `（${activity.placeName}）` : ""}`)
  );
  const tags = extractTags(
    [
      itinerary.destination,
      ...itinerary.preferences,
      ...itinerary.days.flatMap((day) => day.activities.flatMap((activity) => activity.tags)),
      conversationSummary
    ].join(" ")
  );

  return {
    id: createId("skill"),
    name: `${slugify(itinerary.destination)}-${slugify(itinerary.title)}`.slice(0, 60),
    displayName: `${itinerary.destination}风格草稿`,
    description: `从《${itinerary.title}》提取的旅行风格草稿，需要用户确认后发布。`,
    body: [
      `该 Skill 来自 ${itinerary.destination} 行程和用户对话总结。`,
      "",
      "## 风格摘要",
      conversationSummary || "偏向保留原行程中的节奏、地点类型和活动密度。",
      "",
      "## 行程证据",
      ...activityLines,
      "",
      "## 规划规则",
      "- 保留用户明确喜欢的活动类型和节奏。",
      "- 新行程需要结合目的地和同行人重新适配，而不是机械复制地点。"
    ].join("\n"),
    tags,
    rules: ["保留用户明确喜欢的活动类型和节奏", "结合目的地重新适配"],
    forbidden: ["未经用户确认直接发布"],
    status: "draft",
    source: "extracted",
    imports: 0,
    favorites: 0,
    favorited: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    entries[key.trim()] = rest.join(":").trim().replace(/^["']|["']$/g, "");
  }
  return entries;
}

function extractTags(text: string): string[] {
  const result = new Set<string>();
  for (const tag of KNOWN_TAGS) {
    if (text.toLowerCase().includes(tag.toLowerCase())) {
      result.add(tag);
    }
  }
  return [...result];
}

function extractListSection(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return [];
  const list: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const item = line.trim().replace(/^-\s*/, "");
    if (item) list.push(item);
  }
  return list;
}

function tokenize(text: string): string[] {
  return text
    .split(/[\s,，。；;、]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function titleFromName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "travel-style";
}
