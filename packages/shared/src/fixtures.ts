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
    }
  ];
}
