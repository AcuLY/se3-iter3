import { addActivity, createDraftItinerary, nowIso } from "./itinerary.js";
import type { EvaluationCase, TravelItinerary, TravelSkill } from "./types.js";

export function createSeedItinerary(): TravelItinerary {
  let itinerary = createDraftItinerary({
    title: "杭州三日松弛游",
    destination: "杭州",
    startDate: "2026-07-01",
    dayCount: 3,
    companions: ["朋友"],
    preferences: ["慢节奏", "咖啡", "citywalk"]
  });
  itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
    type: "attraction",
    title: "西湖晨间散步",
    placeName: "西湖",
    startTime: "09:00",
    endTime: "11:00",
    tags: ["慢节奏", "citywalk"],
    description: "沿湖慢走，保留拍照和休息时间。"
  });
  itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
    type: "food",
    title: "湖滨咖啡",
    placeName: "湖滨银泰",
    startTime: "11:30",
    endTime: "12:30",
    tags: ["咖啡"],
    description: "用于承接上午散步后的休息。"
  });
  return {
    ...itinerary,
    manualRevision: 0
  };
}

export function createSeedSkills(): TravelSkill[] {
  const timestamp = nowIso();
  return [
    {
      id: "skill-slow-citywalk",
      name: "slow-citywalk",
      displayName: "慢节奏街区漫步",
      description: "适合慢节奏城市漫步、咖啡、街区观察和轻松拍照。",
      body: "优先安排步行可达的街区、咖啡馆和轻量景点，避免一天内连续高强度换乘。",
      tags: ["慢节奏", "咖啡", "citywalk", "街区"],
      rules: ["每天保留至少一个长休息段", "同一区域内串联活动"],
      forbidden: ["连续三个重体力景点", "早晚跨城奔波"],
      status: "published",
      source: "plaza",
      imports: 24,
      favorites: 18,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "skill-family-museum",
      name: "family-museum",
      displayName: "亲子博物馆路线",
      description: "适合亲子、博物馆、低风险天气备选和午后休息。",
      body: "上午安排重点展馆，下午加入公园、甜品或酒店休整，避免长队和过度步行。",
      tags: ["亲子", "博物馆", "慢节奏"],
      rules: ["重点参观放在上午", "每两小时安排一次休息"],
      forbidden: ["连续长时间排队"],
      status: "published",
      source: "plaza",
      imports: 16,
      favorites: 11,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "skill-seaside-chill",
      name: "seaside-chill",
      displayName: "海边松弛游",
      description: "适合海边、日落、小店探索和不赶路的旅行。",
      body: "围绕海边日落和街区小店安排活动，把交通距离控制在较短范围内。",
      tags: ["海边", "松弛", "citywalk", "日落", "小店"],
      rules: ["日落前后留出完整时段", "减少跨区切换"],
      forbidden: ["午后暴晒时段安排长步行"],
      status: "published",
      source: "plaza",
      imports: 9,
      favorites: 7,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
}

export const evaluationDataset: EvaluationCase[] = [
  {
    id: "normal-hangzhou",
    title: "普通行程生成",
    category: "normal_planning",
    input: "杭州三天，朋友出行，慢节奏，有咖啡和西湖。",
    expected: {
      requiredKeywords: ["杭州", "西湖", "咖啡"],
      styleKeywords: ["慢节奏"],
      minDays: 3,
      preserveActivityIds: [],
      requiredToolNames: ["PlannerAgent", "WeatherAgent", "TransportAgent"]
    },
    output: {
      itineraryText: "杭州三天慢节奏行程：西湖晨间散步、湖滨咖啡和街区探索。",
      days: 3,
      preservedActivityIds: [],
      toolCalls: ["StyleAgent", "PlannerAgent", "WeatherAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "skill-fusion-citywalk",
    title: "Skill 融合",
    category: "skill_fusion",
    input: "导入慢节奏街区漫步 Skill，规划杭州 Day 2 下午。",
    expected: {
      requiredKeywords: ["杭州", "街区"],
      styleKeywords: ["慢节奏", "咖啡"],
      minDays: 1,
      preserveActivityIds: [],
      requiredToolNames: ["StyleAgent", "PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "杭州 Day 2 下午安排慢节奏街区探索，加入咖啡休息，不跨区奔波。",
      days: 1,
      preservedActivityIds: [],
      toolCalls: ["StyleAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "manual-replan",
    title: "手动编辑保护",
    category: "manual_replan",
    input: "保留我锁定的博物馆上午安排，下午补一个轻松咖啡。",
    expected: {
      requiredKeywords: ["博物馆", "咖啡"],
      styleKeywords: ["轻松"],
      minDays: 1,
      preserveActivityIds: ["locked-1"],
      requiredToolNames: ["PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "上午保留博物馆，下午安排轻松咖啡。",
      days: 1,
      preservedActivityIds: ["locked-1"],
      toolCalls: ["PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "extract-internal-skill",
    title: "从系统行程提取 Skill",
    category: "skill_extraction_internal",
    input: "从当前杭州慢节奏行程总结可复用 Skill。",
    expected: {
      requiredKeywords: ["Skill", "慢节奏", "街区"],
      styleKeywords: ["咖啡"],
      minDays: 1,
      preserveActivityIds: [],
      requiredToolNames: ["SkillExtractorAgent"]
    },
    output: {
      itineraryText: "生成 Skill 草稿：慢节奏街区、咖啡休息、减少跨区切换。",
      days: 1,
      preservedActivityIds: [],
      toolCalls: ["SkillExtractorAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "extract-external-skill",
    title: "从外部游记提取 Skill",
    category: "skill_extraction_external",
    input: "外部游记强调海边日落、小店探索和不赶路。",
    expected: {
      requiredKeywords: ["海边", "小店", "日落"],
      styleKeywords: ["松弛"],
      minDays: 1,
      preserveActivityIds: [],
      requiredToolNames: ["SkillExtractorAgent"]
    },
    output: {
      itineraryText: "提取海边日落、小店探索、低切换的松弛旅行 Skill 草稿。",
      days: 1,
      preservedActivityIds: [],
      toolCalls: ["SkillExtractorAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "script-success",
    title: "Skill 脚本成功执行",
    category: "skill_script_success",
    input: "Skill 内置脚本返回每日疲劳度评分。",
    expected: {
      requiredKeywords: ["疲劳度", "评分"],
      styleKeywords: ["慢节奏"],
      minDays: 1,
      preserveActivityIds: [],
      requiredToolNames: ["StyleAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "脚本返回疲劳度评分，Agent 根据评分调整为慢节奏行程。",
      days: 1,
      preservedActivityIds: [],
      toolCalls: ["StyleAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "script-fallback",
    title: "Skill 脚本失败降级",
    category: "skill_script_failure",
    input: "导入含脚本的 Skill，但脚本超时。",
    expected: {
      requiredKeywords: ["降级", "可用"],
      styleKeywords: ["慢节奏"],
      minDays: 1,
      preserveActivityIds: [],
      requiredToolNames: ["StyleAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "脚本超时后降级为规则解析，仍保留慢节奏风格并返回可用行程。",
      days: 1,
      preservedActivityIds: [],
      toolCalls: ["StyleAgent", "CriticAgent"],
      scriptErrors: []
    }
  }
];
