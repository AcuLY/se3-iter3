import type {
  SkillDraftInput,
  SkillRecommendation,
  SkillRecommendationContext,
  TravelItinerary,
  TravelSkill,
  TravelSkillVersion
} from "./types.js";
import { createId, nowIso } from "./itinerary.js";

export type SkillValidationCheck = {
  id: string;
  label: string;
  passed: boolean;
  message: string;
};

export type SkillValidationResult = {
  valid: boolean;
  checks: SkillValidationCheck[];
  issues: string[];
};

export class SkillValidationError extends Error {
  constructor(readonly validation: SkillValidationResult) {
    super(`旅行风格格式不完整：${validation.issues.join("；")}`);
    this.name = "SkillValidationError";
  }
}

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

type SkillVersionedField = "displayName" | "description" | "body" | "tags" | "rules" | "forbidden" | "status";
type SkillVersionChanges = Partial<Pick<TravelSkill, SkillVersionedField>>;

const SKILL_VERSION_FIELD_LABELS: Record<SkillVersionedField, string> = {
  displayName: "名称",
  description: "说明",
  body: "正文",
  tags: "标签",
  rules: "规则",
  forbidden: "避免项",
  status: "状态"
};

const SKILL_VERSIONED_FIELDS = Object.keys(SKILL_VERSION_FIELD_LABELS) as SkillVersionedField[];

export function parseSkillMarkdown(markdown: string): TravelSkill {
  const validation = validateSkillMarkdown(markdown);
  if (!validation.valid) {
    throw new SkillValidationError(validation);
  }

  const { frontmatter, body } = readSkillMarkdownParts(markdown);
  const name = frontmatterString(frontmatter.name);
  const description = frontmatterString(frontmatter.description);

  const timestamp = nowIso();
  return {
    id: createId("skill"),
    name,
    displayName: titleFromName(name),
    description,
    body,
    tags: uniqueCleanList([...frontmatterStringList(frontmatter.tags), ...extractTags(`${description}\n${body}`)]),
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

export function validateSkillMarkdown(markdown: string): SkillValidationResult {
  const { hasFrontmatter, frontmatter, body } = readSkillMarkdownParts(markdown);
  const name = frontmatterString(frontmatter.name);
  const description = frontmatterString(frontmatter.description);
  const planningRules = extractListSection(body, "规划规则");
  const checks: SkillValidationCheck[] = [
    {
      id: "frontmatter",
      label: "包含格式头",
      passed: hasFrontmatter,
      message: hasFrontmatter ? "已包含格式头" : "需要以 --- 开头并包含格式头"
    },
    {
      id: "name",
      label: "填写 name",
      passed: Boolean(name),
      message: name ? "已填写 name" : "需要填写 name"
    },
    {
      id: "description",
      label: "填写 description",
      passed: Boolean(description),
      message: description ? "已填写 description" : "需要填写 description"
    },
    {
      id: "body",
      label: "包含正文说明",
      passed: Boolean(body.trim()),
      message: body.trim() ? "已包含正文说明" : "需要补充正文说明"
    },
    {
      id: "planning-rules",
      label: "包含规划规则",
      passed: planningRules.length > 0,
      message: planningRules.length > 0 ? "已添加规划规则" : "至少添加一条规划规则"
    }
  ];
  const issues = checks.filter((check) => !check.passed).map((check) => check.message);
  return {
    valid: issues.length === 0,
    checks,
    issues
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

export function normalizeSkillVersionHistory(skill: TravelSkill): TravelSkillVersion[] {
  const explicitHistory = (skill.versionHistory ?? [])
    .filter((version) => Number.isInteger(version.version) && version.version > 0 && version.summary.trim())
    .map((version) => ({
      version: version.version,
      summary: version.summary.trim(),
      changedFields: uniqueCleanList(version.changedFields ?? []),
      createdAt: version.createdAt
    }))
    .sort((left, right) => left.version - right.version);

  if (explicitHistory.length > 0) return explicitHistory;
  if (skill.status !== "published") return [];

  return [
    {
      version: 1,
      summary: "发布到广场",
      changedFields: ["状态"],
      createdAt: skill.createdAt || skill.updatedAt || nowIso()
    }
  ];
}

export function appendSkillVersion(
  skill: TravelSkill,
  changes: SkillVersionChanges,
  options: { summary?: string; createdAt?: string } = {}
): TravelSkill {
  const changedFields = skillVersionChangedFieldLabels(skill, changes);
  const versionHistory = normalizeSkillVersionHistory(skill);
  const nextSkill = {
    ...skill,
    ...changes,
    versionHistory
  };

  if (changedFields.length === 0) return nextSkill;

  const lastVersion = versionHistory[versionHistory.length - 1]?.version ?? 0;
  return {
    ...nextSkill,
    versionHistory: [
      ...versionHistory,
      {
        version: lastVersion + 1,
        summary: options.summary ?? skillVersionChangeSummary(changedFields),
        changedFields,
        createdAt: options.createdAt ?? nowIso()
      }
    ]
  };
}

export function skillVersionChangedFieldLabels(skill: TravelSkill, changes: SkillVersionChanges): string[] {
  const labels: string[] = [];
  for (const field of SKILL_VERSIONED_FIELDS) {
    if (!(field in changes)) continue;
    if (skillFieldValueChanged(skill[field], changes[field])) {
      labels.push(SKILL_VERSION_FIELD_LABELS[field]);
    }
  }
  return labels;
}

function skillVersionChangeSummary(changedFields: string[]): string {
  if (changedFields.length === 0) return "更新内容";
  return `更新${changedFields.slice(0, 3).join("、")}`;
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

function skillFieldValueChanged(previous: unknown, next: unknown): boolean {
  if (Array.isArray(previous) || Array.isArray(next)) {
    return JSON.stringify(previous ?? []) !== JSON.stringify(next ?? []);
  }
  return previous !== next;
}

export function summarizeItineraryAsSkill(itinerary: TravelItinerary, conversationSummary = ""): TravelSkill {
  const timestamp = nowIso();
  const activityLines = itinerary.days.flatMap((day) =>
    day.activities.map((activity) => `- ${day.title} ${activity.title}${activity.placeName ? `（${activity.placeName}）` : ""}`)
  );
  const tags = extractTags(
    [
      itinerary.destination,
      ...itinerary.days.flatMap((day) => day.activities.flatMap((activity) => activity.tags)),
      conversationSummary
    ].join(" ")
  );

  return {
    id: createId("skill"),
    name: `${slugify(itinerary.destination)}-${slugify(itinerary.title)}`.slice(0, 60),
    displayName: buildExtractedSkillDraftTitle({
      destination: itinerary.destination,
      sourceTitle: itinerary.title,
      tags
    }),
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
      "- 新行程需要结合目的地重新适配，而不是机械复制地点。"
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

export function buildExtractedSkillDraftTitle({
  destination,
  sourceTitle,
  tags
}: {
  destination?: string;
  sourceTitle?: string;
  tags?: string[];
}): string {
  const normalizedTags = uniqueCleanList(tags ?? []);
  if (destination && sourceTitle) return `${destination} · ${sourceTitle}风格草稿`;
  if (destination) return `${destination}风格草稿`;
  if (sourceTitle) return `${sourceTitle}风格草稿`;
  if (normalizedTags.length > 0) return `${normalizedTags.slice(0, 3).join("、")}风格草稿`;
  return "旅行风格草稿";
}

type FrontmatterValue = string | string[] | undefined;

function readSkillMarkdownParts(markdown: string): {
  hasFrontmatter: boolean;
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  const match = markdown.trim().match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return {
      hasFrontmatter: false,
      frontmatter: {},
      body: markdown.trim()
    };
  }
  return {
    hasFrontmatter: true,
    frontmatter: parseFrontmatter(match[1] ?? ""),
    body: (match[2] ?? "").trim()
  };
}

function parseFrontmatter(frontmatter: string): Record<string, FrontmatterValue> {
  const entries: Record<string, FrontmatterValue> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const normalizedKey = key.trim();
    const rawValue = rest.join(":").trim();
    entries[normalizedKey] =
      normalizedKey === "tags" ? parseFrontmatterList(rawValue) : rawValue.replace(/^["']|["']$/g, "");
  }
  return entries;
}

function parseFrontmatterList(value: string): string[] {
  const trimmed = value.trim();
  const content = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return uniqueCleanList(content.split(/[,，、]/).map((item) => item.trim().replace(/^["']|["']$/g, "")));
}

function frontmatterString(value: FrontmatterValue): string {
  return typeof value === "string" ? value.trim() : "";
}

function frontmatterStringList(value: FrontmatterValue): string[] {
  if (Array.isArray(value)) return uniqueCleanList(value);
  if (typeof value === "string") return parseFrontmatterList(value);
  return [];
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

function uniqueCleanList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
