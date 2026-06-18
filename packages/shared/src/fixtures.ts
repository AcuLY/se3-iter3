import { addActivity, createDraftItinerary, nowIso } from "./itinerary.js";
import type { TravelItinerary, TravelSkill } from "./types.js";

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
    },
    {
      id: "skill-rainy-cafe-indoor",
      name: "rainy-cafe-indoor",
      displayName: "雨天咖啡室内线",
      description: "适合雨天、咖啡、展馆和少走路的城市行程。",
      body: "把室内展馆、书店和咖啡休息串成轻路线，雨势大时减少露天步行。",
      tags: ["雨天", "咖啡", "室内", "慢节奏"],
      rules: ["雨天优先室内景点和咖啡休息", "同一区域内安排短距离移动"],
      forbidden: ["暴雨时安排露天长步行"],
      status: "published",
      source: "plaza",
      imports: 18,
      favorites: 14,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "skill-garden-teahouse-halfday",
      name: "garden-teahouse-halfday",
      displayName: "园林茶馆半日游",
      description: "适合园林、茶馆、午后休息和家人同行的半日安排。",
      body: "上午安排核心园林或历史街区，午后用茶馆、点心和短距离散步承接。",
      tags: ["园林", "茶馆", "家人", "慢节奏"],
      rules: ["核心景点集中在半天内完成", "午后保留茶馆或酒店休息"],
      forbidden: ["午后继续排满重体力景点"],
      status: "published",
      source: "plaza",
      imports: 13,
      favorites: 12,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "skill-night-market-light",
      name: "night-market-light",
      displayName: "夜景小吃轻路线",
      description: "适合夜景、小吃、短距离散步和不压缩白天休息。",
      body: "白天保留恢复时间，傍晚后把夜景、街边小吃和回酒店路线放在同一区域。",
      tags: ["夜景", "小吃", "citywalk", "松弛"],
      rules: ["夜间活动控制在同一区域", "第二天上午避免安排过早出发"],
      forbidden: ["深夜后继续跨区赶场"],
      status: "published",
      source: "plaza",
      imports: 11,
      favorites: 9,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: "skill-morning-photo-walk",
      name: "morning-photo-walk",
      displayName: "清晨拍照散步线",
      description: "适合清晨光线、城市地标、轻量步行和慢速取景。",
      body: "把拍照点放在早晨，午前结束主要步行，下午安排咖啡、小店或自由活动。",
      tags: ["清晨", "拍照", "citywalk", "小店"],
      rules: ["拍照点优先安排在早晨", "午后减少连续步行"],
      forbidden: ["正午暴晒时段安排长距离外景"],
      status: "published",
      source: "plaza",
      imports: 10,
      favorites: 8,
      favorited: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
}
