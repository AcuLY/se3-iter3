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
  },
  {
    id: "intent-route-only",
    title: "纯路线补全不新增活动",
    category: "intent_routing",
    input: "帮我补全所有景点之间的交通路线和时间。",
    expected: {
      requiredKeywords: ["交通路线", "2 段", "未新增活动"],
      styleKeywords: [],
      minDays: 2,
      preserveActivityIds: ["day1-poi-1", "day1-poi-2", "day2-poi-1", "day2-poi-2"],
      requiredToolNames: ["TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已补全交通路线：2 段，原有 4 个活动保持不变，未新增活动。",
      days: 2,
      preservedActivityIds: ["day1-poi-1", "day1-poi-2", "day2-poi-1", "day2-poi-2"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-details-only",
    title: "纯行程信息更新不新增活动",
    category: "intent_routing",
    input: "把返回日期改到 2026-07-05，预算 2600，备注每天午后留出休息。",
    expected: {
      requiredKeywords: ["日期范围", "预算", "备注", "未新增活动"],
      styleKeywords: [],
      minDays: 5,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "WeatherAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已更新日期范围、预算和备注；原有活动保持不变，未新增活动。",
      days: 5,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "WeatherAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-natural-date-details",
    title: "中文月日行程信息更新",
    category: "intent_routing",
    input: "把返回日期改到 7 月 5 日，预算 2600，备注每天午后留出休息。",
    expected: {
      requiredKeywords: ["日期范围", "2026-07-05", "预算", "备注", "未新增活动"],
      styleKeywords: [],
      minDays: 5,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "WeatherAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已把返回日期解析为 2026-07-05，并更新日期范围、预算和备注；原有活动保持不变，未新增活动。",
      days: 5,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "WeatherAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-profile-details",
    title: "目的地同行人偏好信息更新",
    category: "intent_routing",
    input: "把目的地改成苏州，同行人改成家人和孩子，偏好改成园林、慢节奏、亲子。",
    expected: {
      requiredKeywords: ["目的地", "苏州", "同行人", "家人", "孩子", "偏好", "亲子", "未新增活动"],
      styleKeywords: ["慢节奏", "亲子"],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "WeatherAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已更新目的地为苏州，同行人为家人、孩子，偏好为园林、慢节奏、亲子；原有活动保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "WeatherAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-activity-update",
    title: "修改已有活动不新增活动",
    category: "intent_routing",
    input: "把西湖晨间散步改到 10:00-11:30，预算 30，备注改成避开早高峰。",
    expected: {
      requiredKeywords: ["更新活动", "10:00", "11:30", "预算 30", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已更新活动：西湖晨间散步，时间 10:00-11:30，预算 30 元，备注避开早高峰；原有活动数量保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-place-replace",
    title: "替换已有活动地点并解析 POI",
    category: "intent_routing",
    input: "把湖滨咖啡换成灵隐寺，改成景点，时间 14:00-16:00。",
    expected: {
      requiredKeywords: ["更新活动", "灵隐寺", "已更新地点", "14:00", "16:00", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["AttractionAgent", "PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已把湖滨咖啡替换为灵隐寺，写入 POI 地点和 14:00-16:00 时间，原活动数量保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "PlannerAgent", "AttractionAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-place-add",
    title: "新增点名地点并解析 POI",
    category: "intent_routing",
    input: "在 Day 1 下午 15:00-17:00 添加灵隐寺景点，并补全步行路线。",
    expected: {
      requiredKeywords: ["已添加地点", "灵隐寺", "已补全交通路线", "未新增泛化活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["AttractionAgent", "TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已添加地点：灵隐寺，并补全交通路线：2 段；新增的是用户点名 POI，未新增泛化活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "AttractionAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-specific-transport-mode",
    title: "指定路段交通方式调整",
    category: "intent_routing",
    input: "把西湖晨间散步到湖滨咖啡这段交通改成公交/地铁。",
    expected: {
      requiredKeywords: ["已更新交通", "公交", "地铁", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已更新交通：西湖晨间散步 到 湖滨咖啡，方式为公交/地铁；原有活动数量保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-transport-compare-fastest",
    title: "比较交通方式并选择最快路线",
    category: "intent_routing",
    input: "比较西湖晨间散步到湖滨咖啡的步行、公交和骑行，选最快的路线。",
    expected: {
      requiredKeywords: ["已比较交通方式", "步行", "公交/地铁", "骑行", "已选择骑行", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已比较交通方式：步行、公交/地铁、骑行，已选择骑行；原有活动保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-route-conflict-faster-mode",
    title: "路线晚到后改用更快交通方式",
    category: "intent_routing",
    input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我换个更快的交通方式，不改活动时间。",
    expected: {
      requiredKeywords: ["已比较交通方式", "步行", "公交/地铁", "驾车", "骑行", "已选择骑行", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已比较交通方式：步行、公交/地铁、驾车、骑行，已选择骑行；活动时间保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-transport-remove",
    title: "取消指定交通段但保留活动",
    category: "intent_routing",
    input: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。",
    expected: {
      requiredKeywords: ["已取消交通", "西湖晨间散步", "湖滨咖啡", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已取消交通：西湖晨间散步 到 湖滨咖啡；两个活动仍保留，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-route-conflict-delay-next",
    title: "路线晚到后顺延下一项活动",
    category: "intent_routing",
    input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。",
    expected: {
      requiredKeywords: ["已顺延活动", "湖滨咖啡", "11:45", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["PlannerAgent", "TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已顺延活动：湖滨咖啡 到 11:45；原路线和两个活动仍保留，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-route-conflict-shorten-previous",
    title: "路线晚到后缩短上一站停留",
    category: "intent_routing",
    input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我缩短上一站停留。",
    expected: {
      requiredKeywords: ["已缩短停留", "西湖晨间散步", "10:45", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["PlannerAgent", "TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已缩短停留：西湖晨间散步 到 10:45；湖滨咖啡时间保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-route-conflict-shift-downstream",
    title: "路线晚到后整体顺延后续安排",
    category: "intent_routing",
    input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我整体顺延后续安排。",
    expected: {
      requiredKeywords: ["已顺延后续安排", "湖滨咖啡", "11:45", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["PlannerAgent", "TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "已顺延后续安排：2 项，湖滨咖啡 到 11:45；后续活动同步后移，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-route-conflict-options",
    title: "路线晚到后先给多方案取舍",
    category: "intent_routing",
    input: "西湖晨间散步到湖滨咖啡这段交通会晚到，先给我几个调整方案，暂时不要改画布。",
    expected: {
      requiredKeywords: ["路线会在", "顺延下一项", "缩短上一站", "改用更快交通方式", "未修改画布"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "TransportAgent", "PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "路线会在 11:45 左右到达，晚于湖滨咖啡的 11:30。可选方案：顺延下一项、缩短上一站、改用更快交通方式；未修改画布，等待用户选择。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-activity-move",
    title: "移动已有活动到另一日",
    category: "intent_routing",
    input: "把湖滨咖啡移到 Day 2 上午第一项。",
    expected: {
      requiredKeywords: ["移动活动", "Day 2", "第 1 项", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "移动活动：湖滨咖啡 -> Day 2 第 1 项；原有活动数量保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "intent-activity-remove",
    title: "删除已有活动不新增活动",
    category: "intent_routing",
    input: "删掉湖滨咖啡，其他活动保持不变。",
    expected: {
      requiredKeywords: ["删除活动", "湖滨咖啡", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake"],
      requiredToolNames: ["PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "删除活动：湖滨咖啡；西湖晨间散步等其他活动保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake"],
      toolCalls: ["MainAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "deepseek-place-replace-tool",
    title: "在线模型通过工具替换已有活动地点",
    category: "intent_routing",
    input: "把湖滨咖啡换成灵隐寺，选正式景区，活动本身保留。",
    expected: {
      requiredKeywords: ["已更新地点", "灵隐寺飞来峰景区", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "AttractionAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "DeepSeek 调用 update_activity_place 后，已更新地点：灵隐寺飞来峰景区；湖滨咖啡活动槽位被替换为正式景区 POI，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "AttractionAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "deepseek-transport-compare-tool",
    title: "在线模型通过工具比较交通方式",
    category: "intent_routing",
    input: "比较西湖晨间散步到湖滨咖啡的交通方式，选最快路线。",
    expected: {
      requiredKeywords: ["已比较交通方式", "步行", "公交/地铁", "驾车", "骑行", "已选择骑行"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "DeepSeek 调用 compare_transport_modes 后，已比较交通方式：步行、公交/地铁、驾车、骑行，已选择骑行。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "deepseek-transport-remove-tool",
    title: "在线模型通过工具取消指定交通段",
    category: "intent_routing",
    input: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。",
    expected: {
      requiredKeywords: ["已取消交通", "西湖晨间散步", "湖滨咖啡", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "TransportAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "DeepSeek 调用 remove_transport_leg 后，已取消交通：西湖晨间散步 到 湖滨咖啡；两个活动保持不变，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "TransportAgent", "CriticAgent"],
      scriptErrors: []
    }
  },
  {
    id: "deepseek-route-conflict-delay-next-tool",
    title: "在线模型通过工具修复路线晚到",
    category: "intent_routing",
    input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。",
    expected: {
      requiredKeywords: ["已顺延活动", "湖滨咖啡", "11:45", "未新增活动"],
      styleKeywords: [],
      minDays: 3,
      preserveActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      requiredToolNames: ["MainAgent", "PlannerAgent", "CriticAgent"]
    },
    output: {
      itineraryText: "DeepSeek 调用 adjust_timing_conflict 后，已顺延活动：湖滨咖啡 到 11:45；原路线和两个活动仍保留，未新增活动。",
      days: 3,
      preservedActivityIds: ["seed-day1-westlake", "seed-day1-cafe"],
      toolCalls: ["MainAgent", "PlannerAgent", "CriticAgent"],
      scriptErrors: []
    }
  }
];
