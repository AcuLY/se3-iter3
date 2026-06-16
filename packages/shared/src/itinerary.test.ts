import { describe, expect, it } from "vitest";
import {
  addActivity,
  addDay,
  addDayBefore,
  applyItineraryPatch,
  createDraftItinerary,
  detectTransportTimingConflict,
  diffItineraries,
  exportItineraryMarkdown,
  moveActivity,
  removeActivity,
  removeTransportLeg,
  renameDay,
  reorderActivity,
  resizeItineraryDateRange,
  setDayWeather,
  setTransportLeg,
  summarizePlanningChecklist,
  updateActivity
} from "./itinerary";

describe("itinerary editing helpers", () => {
  it("creates a draft itinerary with the requested number of editable days", () => {
    const draft = createDraftItinerary({
      title: "杭州三日松弛游",
      destination: "杭州",
      startDate: "2026-07-01",
      dayCount: 3,
      companions: ["朋友"]
    });

    expect(draft.days).toHaveLength(3);
    expect(draft.days[0]?.title).toBe("Day 1");
    expect(draft.destination).toBe("杭州");
    expect(draft.manualRevision).toBe(0);
  });

  it("creates days from a departure and return date range", () => {
    const draft = createDraftItinerary({
      title: "厦门四日海边",
      destination: "厦门",
      startDate: "2026-07-01",
      endDate: "2026-07-04"
    });

    expect(draft.days.map((day) => day.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04"
    ]);
    expect(draft.endDate).toBe("2026-07-04");
  });

  it("creates the first planned place from the first destination without replacing the departure point", () => {
    const draft = createDraftItinerary({
      title: "跨城周末",
      destination: "上海虹桥站",
      firstDestination: "西湖",
      firstDestinationPlace: {
        name: "西湖",
        address: "龙井路",
        city: "杭州",
        district: "西湖区",
        type: "风景名胜",
        coordinates: { lng: 120.141, lat: 30.259 }
      },
      startDate: "2026-07-01",
      endDate: "2026-07-02"
    });

    expect(draft.destination).toBe("上海虹桥站");
    expect(draft.days[0]?.activities).toHaveLength(1);
    expect(draft.days[0]?.activities[0]).toMatchObject({
      title: "西湖",
      placeName: "西湖",
      place: {
        name: "西湖",
        coordinates: { lng: 120.141, lat: 30.259 }
      }
    });
  });

  it("adds a day before the current trip without moving existing plans", () => {
    let itinerary = createDraftItinerary({
      title: "苏州园林",
      destination: "苏州",
      startDate: "2026-07-01",
      endDate: "2026-07-02"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "拙政园",
      placeName: "拙政园"
    });

    itinerary = addDayBefore(itinerary);

    expect(itinerary.startDate).toBe("2026-06-30");
    expect(itinerary.endDate).toBe("2026-07-02");
    expect(itinerary.days.map((day) => day.title)).toEqual(["Day 1", "Day 2", "Day 3"]);
    expect(itinerary.days.map((day) => day.date)).toEqual(["2026-06-30", "2026-07-01", "2026-07-02"]);
    expect(itinerary.days[0]!.activities).toHaveLength(0);
    expect(itinerary.days[1]!.activities[0]?.title).toBe("拙政园");
  });

  it("resizes itinerary days when the date range changes while preserving in-range plans", () => {
    let itinerary = createDraftItinerary({
      title: "成都周末",
      destination: "成都",
      startDate: "2026-08-01",
      endDate: "2026-08-02"
    });

    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "宽窄巷子午餐",
      placeName: "宽窄巷子"
    });

    itinerary = resizeItineraryDateRange(itinerary, "2026-08-03", "2026-08-05");

    expect(itinerary.startDate).toBe("2026-08-03");
    expect(itinerary.endDate).toBe("2026-08-05");
    expect(itinerary.days.map((day) => day.date)).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(itinerary.days[0]!.activities[0]?.title).toBe("宽窄巷子午餐");
    expect(itinerary.days[1]!.title).toBe("Day 2");
    expect(itinerary.days[2]!.activities).toHaveLength(0);

    itinerary = resizeItineraryDateRange(itinerary, "2026-08-03", "2026-08-03");

    expect(itinerary.days).toHaveLength(1);
    expect(itinerary.days[0]!.date).toBe("2026-08-03");
    expect(itinerary.days[0]!.activities[0]?.title).toBe("宽窄巷子午餐");
  });

  it("adds, updates, reorders, moves, renames, and removes activity blocks", () => {
    let itinerary = createDraftItinerary({
      title: "上海周末",
      destination: "上海",
      startDate: "2026-08-08",
      dayCount: 2
    });

    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "武康路城市漫步",
      placeName: "武康路",
      startTime: "09:30",
      endTime: "11:30",
      description: "梧桐树和老建筑为主。",
      tags: ["citywalk"],
      budgetCny: 0,
      transportNote: "地铁到交通大学站"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "衡山路 brunch",
      placeName: "衡山路",
      startTime: "12:00",
      endTime: "13:30"
    });

    const firstActivityId = itinerary.days[0]!.activities[0]!.id;
    const secondActivityId = itinerary.days[0]!.activities[1]!.id;

    itinerary = updateActivity(itinerary, firstActivityId, {
      budgetCny: 80,
      lockedByUser: true
    });
    itinerary = reorderActivity(itinerary, itinerary.days[0]!.id, secondActivityId, 0);
    itinerary = moveActivity(itinerary, secondActivityId, itinerary.days[1]!.id, 0);
    itinerary = renameDay(itinerary, itinerary.days[1]!.id, "到达与街区");
    itinerary = removeActivity(itinerary, firstActivityId);
    itinerary = addDay(itinerary, "返程预留");

    expect(itinerary.days).toHaveLength(3);
    expect(itinerary.days[0]!.activities).toHaveLength(0);
    expect(itinerary.days[1]!.title).toBe("到达与街区");
    expect(itinerary.days[1]!.activities[0]?.id).toBe(secondActivityId);
    expect(itinerary.days[2]!.date).toBe("2026-08-10");
    expect(itinerary.manualRevision).toBeGreaterThanOrEqual(6);
  });

  it("stores place coordinates, transport legs, budget notes, and exports a complete itinerary", () => {
    let itinerary = createDraftItinerary({
      title: "杭州西湖周末",
      destination: "杭州",
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      budgetCny: 1800,
      notes: "尽量少走回头路。"
    });

    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "西湖晨间散步",
      placeName: "西湖",
      place: {
        poiId: "B023B0A8Y8",
        name: "西湖风景名胜区",
        city: "杭州",
        address: "浙江省杭州市西湖区",
        coordinates: { lng: 120.141, lat: 30.259 },
        phone: "0571-12345678",
        openingHours: "08:30-17:00",
        averageCostCny: 68
      },
      startTime: "09:00",
      endTime: "11:00",
      budgetCny: 0,
      note: "避开中午人流。"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "湖滨午餐",
      placeName: "湖滨银泰",
      place: {
        poiId: "B023B12XYZ",
        name: "湖滨银泰in77",
        city: "杭州",
        address: "延安路",
        coordinates: { lng: 120.165, lat: 30.255 }
      },
      startTime: "12:00",
      endTime: "13:30",
      budgetCny: 160
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "attraction",
      title: "灵隐寺慢游",
      placeName: "灵隐寺",
      place: {
        poiId: "B023B0Z9K1",
        name: "灵隐寺",
        city: "杭州",
        address: "法云弄1号",
        coordinates: { lng: 120.102, lat: 30.24 }
      },
      startTime: "09:30",
      endTime: "11:30",
      budgetCny: 45
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "food",
      title: "法云安缦午餐",
      placeName: "法云安缦",
      startTime: "12:00",
      endTime: "13:30",
      budgetCny: 75
    });

    const [from, to] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: from!.id,
      toActivityId: to!.id,
      mode: "transit",
      distanceMeters: 3200,
      durationMinutes: 28,
      costCny: 4,
      provider: "amap",
      summary: "地铁 1 号线到龙翔桥",
      routeStatus: "planned",
      steps: [
        {
          instruction: "步行至龙翔桥站",
          mode: "walking",
          distanceMeters: 600,
          durationMinutes: 8
        },
        {
          instruction: "乘坐地铁 1 号线",
          mode: "transit",
          distanceMeters: 2600,
          durationMinutes: 20
        }
      ]
    });

    expect(itinerary.days[0]!.transportLegs).toEqual([
      expect.objectContaining({
        fromActivityId: from!.id,
        toActivityId: to!.id,
        mode: "transit",
        durationMinutes: 28
      })
    ]);
    expect(exportItineraryMarkdown(itinerary)).toContain("## Day 1");
    expect(exportItineraryMarkdown(itinerary)).toContain("西湖晨间散步");
    expect(exportItineraryMarkdown(itinerary)).toContain("交通：公交/地铁，3.2 km，28 分钟，约 4 元");
    expect(exportItineraryMarkdown(itinerary)).toContain(
      "路线步骤：1. 步行至龙翔桥站（600 m，8 分钟）；2. 乘坐地铁 1 号线（2.6 km，20 分钟）"
    );
    expect(exportItineraryMarkdown(itinerary)).toContain("总预算：1800 元");
    expect(exportItineraryMarkdown(itinerary)).toContain("营业时间：08:30-17:00");
    expect(exportItineraryMarkdown(itinerary)).toContain("电话：0571-12345678");
    expect(exportItineraryMarkdown(itinerary)).toContain("参考人均：68 元");
    expect(exportItineraryMarkdown(itinerary)).toContain("## 行程总览");
    expect(exportItineraryMarkdown(itinerary)).toContain("总安排：4 项");
    expect(exportItineraryMarkdown(itinerary)).toContain("活动预算合计：280 元");
    expect(exportItineraryMarkdown(itinerary)).toContain("已计算交通：1 段，3.2 km，28 分钟，约 4 元");
    expect(exportItineraryMarkdown(itinerary)).toContain("未计算交通：1 段");
    expect(exportItineraryMarkdown(itinerary)).toContain("Day 1 小计：2 项安排，活动预算 160 元，交通 3.2 km / 28 分钟 / 约 4 元");
    expect(exportItineraryMarkdown(itinerary)).toContain("Day 2 小计：2 项安排，活动预算 120 元，交通待计算 1 段");
    expect(exportItineraryMarkdown(itinerary)).toContain("坐标：120.141,30.259");
  });

  it("removes one transport leg by adjacent activity pair", () => {
    let itinerary = createDraftItinerary({
      title: "杭州一日路线",
      destination: "杭州",
      startDate: "2026-07-01",
      dayCount: 1
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "湖滨咖啡",
      placeName: "湖滨银泰"
    });
    const [from, to] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: from!.id,
      toActivityId: to!.id,
      mode: "walking",
      distanceMeters: 1300,
      durationMinutes: 18,
      provider: "mock",
      summary: "步行路线"
    });

    const updated = removeTransportLeg(itinerary, itinerary.days[0]!.id, from!.id, to!.id);

    expect(updated.days[0]!.activities.map((activity) => activity.title)).toEqual(["西湖", "湖滨咖啡"]);
    expect(updated.days[0]!.transportLegs).toEqual([]);
  });

  it("includes manually adjusted transport leg details in itinerary export", () => {
    let itinerary = createDraftItinerary({
      title: "杭州雨天路线",
      destination: "杭州",
      startDate: "2026-07-01"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "湖滨晚餐",
      placeName: "湖滨银泰"
    });

    const [from, to] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: from!.id,
      toActivityId: to!.id,
      mode: "driving",
      distanceMeters: 2400,
      durationMinutes: 35,
      costCny: 18,
      provider: "manual",
      summary: "打车或网约车",
      manualOverride: true,
      note: "雨天含等车时间，避免步行过久"
    });

    expect(exportItineraryMarkdown(itinerary)).toContain(
      "交通：驾车，2.4 km，35 分钟，约 18 元（打车或网约车；用户调整：雨天含等车时间，避免步行过久）"
    );
  });

  it("does not report pending transport for blank draft activities in exports", () => {
    let itinerary = createDraftItinerary({
      title: "杭州空白草稿",
      destination: "杭州",
      startDate: "2026-07-01"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "free_time",
      title: "",
      description: "",
      tags: ["手动"]
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "free_time",
      title: "",
      description: "",
      tags: ["手动"]
    });

    const markdown = exportItineraryMarkdown(itinerary);

    expect(markdown).toContain("总安排：2 项");
    expect(markdown).not.toContain("未计算交通：1 段");
    expect(markdown).not.toContain("交通待计算 1 段");
    expect(markdown).toContain("已计算交通：0 段");
    expect(markdown).toContain("### 1. 待补全安排");
    expect(markdown).not.toContain("### 1. \n");
  });

  it("exports a planning checklist for missing places, times, and routable transport gaps", () => {
    let itinerary = createDraftItinerary({
      title: "苏州周末规划",
      destination: "苏州",
      startDate: "2026-07-04",
      dayCount: 2
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "拙政园",
      placeName: "拙政园",
      startTime: "09:00",
      endTime: "11:00"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "free_time",
      title: "",
      description: ""
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "attraction",
      title: "苏州博物馆",
      placeName: "苏州博物馆",
      startTime: "10:00",
      endTime: "12:00"
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "food",
      title: "平江路午餐",
      placeName: "平江路",
      startTime: "12:30",
      endTime: "13:30"
    });

    const markdown = exportItineraryMarkdown(itinerary);

    expect(markdown).toContain("## 规划检查");
    expect(markdown).toContain("待补地点：Day 1 第 2 项 待补全安排");
    expect(markdown).toContain("待补时间：Day 1 第 2 项 待补全安排");
    expect(markdown).toContain("待计算交通：Day 2 苏州博物馆 到 平江路午餐");
  });

  it("clears adjacent transport legs when an activity place changes", () => {
    let itinerary = createDraftItinerary({
      title: "杭州一日路线",
      destination: "杭州",
      startDate: "2026-07-01"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖",
      place: {
        name: "西湖",
        address: "西湖区",
        coordinates: { lng: 120.141, lat: 30.259 }
      }
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "湖滨午餐",
      placeName: "湖滨银泰",
      place: {
        name: "湖滨银泰",
        address: "上城区",
        coordinates: { lng: 120.165, lat: 30.255 }
      }
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "南山路",
      placeName: "南山路",
      place: {
        name: "南山路",
        address: "上城区",
        coordinates: { lng: 120.155, lat: 30.246 }
      }
    });
    const [first, middle, last] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: first!.id,
      toActivityId: middle!.id,
      mode: "walking",
      distanceMeters: 1300,
      durationMinutes: 18,
      provider: "amap"
    });
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: middle!.id,
      toActivityId: last!.id,
      mode: "walking",
      distanceMeters: 900,
      durationMinutes: 14,
      provider: "amap"
    });

    const noteOnly = updateActivity(itinerary, middle!.id, { note: "避开午高峰" });
    expect(noteOnly.days[0]!.transportLegs).toHaveLength(2);

    const replacedPlace = updateActivity(itinerary, middle!.id, {
      placeName: "灵隐寺",
      place: {
        name: "灵隐寺",
        address: "法云弄1号",
        coordinates: { lng: 120.102, lat: 30.24 }
      }
    });

    expect(replacedPlace.days[0]!.activities).toHaveLength(3);
    expect(replacedPlace.days[0]!.activities[1]!.id).toBe(middle!.id);
    expect(replacedPlace.days[0]!.transportLegs).toEqual([]);
  });

  it("summarizes planning checklist gaps for result previews", () => {
    let itinerary = createDraftItinerary({
      title: "苏州周末规划",
      destination: "苏州",
      startDate: "2026-07-04",
      dayCount: 2
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "free_time",
      title: "",
      description: ""
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "attraction",
      title: "苏州博物馆",
      placeName: "苏州博物馆",
      startTime: "10:00",
      endTime: "12:00"
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "food",
      title: "平江路午餐",
      placeName: "平江路",
      startTime: "12:30",
      endTime: "13:30"
    });

    expect(summarizePlanningChecklist(itinerary)).toEqual({
      complete: false,
      total: 3,
      missingPlaces: ["Day 1 第 1 项 待补全安排"],
      missingTimes: ["Day 1 第 1 项 待补全安排"],
      pendingTransport: ["Day 2 苏州博物馆 到 平江路午餐"],
      missingPlaceItems: [
        {
          label: "Day 1 第 1 项 待补全安排",
          dayId: itinerary.days[0]!.id,
          activityId: itinerary.days[0]!.activities[0]!.id,
          activityIndex: 0
        }
      ],
      missingTimeItems: [
        {
          label: "Day 1 第 1 项 待补全安排",
          dayId: itinerary.days[0]!.id,
          activityId: itinerary.days[0]!.activities[0]!.id,
          activityIndex: 0
        }
      ],
      pendingTransportItems: [
        {
          label: "Day 2 苏州博物馆 到 平江路午餐",
          dayId: itinerary.days[1]!.id,
          fromActivityId: itinerary.days[1]!.activities[0]!.id,
          toActivityId: itinerary.days[1]!.activities[1]!.id,
          fromActivityIndex: 0,
          toActivityIndex: 1
        }
      ]
    });
  });

  it("marks fallback transport legs as local estimates in itinerary export", () => {
    let itinerary = createDraftItinerary({
      title: "杭州路线来源",
      destination: "杭州",
      startDate: "2026-07-01"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "湖滨咖啡",
      placeName: "湖滨银泰"
    });

    const [from, to] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: from!.id,
      toActivityId: to!.id,
      mode: "walking",
      distanceMeters: 1300,
      durationMinutes: 18,
      provider: "mock",
      summary: "步行路线建议"
    });

    expect(exportItineraryMarkdown(itinerary)).toContain(
      "交通：步行，1.3 km，18 分钟（本地估算；步行路线建议）"
    );
  });

  it("detects when transport time pushes arrival past the next activity start", () => {
    const conflict = detectTransportTimingConflict(
      {
        id: "from",
        type: "attraction",
        title: "西湖",
        startTime: "09:00",
        endTime: "10:30",
        tags: [],
        lockedByUser: false,
        source: "manual"
      },
      {
        id: "to",
        type: "food",
        title: "湖滨午餐",
        startTime: "11:00",
        tags: [],
        lockedByUser: false,
        source: "manual"
      },
      {
        id: "leg",
        fromActivityId: "from",
        toActivityId: "to",
        mode: "transit",
        distanceMeters: 4200,
        durationMinutes: 45,
        provider: "amap",
        routeStatus: "planned",
        manualOverride: false,
        polyline: [],
        steps: []
      }
    );

    expect(conflict).toEqual({
      fromEndTime: "10:30",
      estimatedArrivalTime: "11:15",
      nextStartTime: "11:00",
      delayMinutes: 15,
      message: "预计 11:15 到达，晚于 11:00，需调整上一站停留或下一项开始时间。"
    });
  });

  it("does not flag timing when the route arrives before the next activity starts", () => {
    const conflict = detectTransportTimingConflict(
      {
        id: "from",
        type: "attraction",
        title: "西湖",
        endTime: "10:00",
        tags: [],
        lockedByUser: false,
        source: "manual"
      },
      {
        id: "to",
        type: "food",
        title: "湖滨午餐",
        startTime: "11:00",
        tags: [],
        lockedByUser: false,
        source: "manual"
      },
      {
        id: "leg",
        fromActivityId: "from",
        toActivityId: "to",
        mode: "transit",
        distanceMeters: 4200,
        durationMinutes: 45,
        provider: "amap",
        routeStatus: "planned",
        manualOverride: false,
        polyline: [],
        steps: []
      }
    );

    expect(conflict).toBeUndefined();
  });

  it("includes route timing conflicts in itinerary export", () => {
    let itinerary = createDraftItinerary({
      title: "杭州赶场路线",
      destination: "杭州",
      startDate: "2026-07-01"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖",
      endTime: "10:30"
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "food",
      title: "湖滨午餐",
      placeName: "湖滨银泰",
      startTime: "11:00"
    });

    const [from, to] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, itinerary.days[0]!.id, {
      fromActivityId: from!.id,
      toActivityId: to!.id,
      mode: "transit",
      distanceMeters: 4200,
      durationMinutes: 45,
      provider: "amap",
      routeStatus: "planned"
    });

    expect(exportItineraryMarkdown(itinerary)).toContain(
      "时间提醒：预计 11:15 到达，晚于 11:00，需调整上一站停留或下一项开始时间。"
    );
  });

  it("stores daily weather and includes it in itinerary export", () => {
    let itinerary = createDraftItinerary({
      title: "杭州雨天备选",
      destination: "杭州",
      startDate: "2026-07-01",
      endDate: "2026-07-02"
    });

    itinerary = setDayWeather(itinerary, itinerary.days[1]!.id, {
      city: "杭州市",
      date: "2026-07-02",
      weather: "小雨 / 阴",
      temperature: "22-28 C",
      source: "amap"
    });

    expect(itinerary.days[1]!.weather).toMatchObject({
      city: "杭州市",
      date: "2026-07-02",
      weather: "小雨 / 阴"
    });
    expect(itinerary.manualRevision).toBe(1);
    expect(exportItineraryMarkdown(itinerary)).toContain("天气：小雨 / 阴，22-28 C（杭州市，amap）");
  });

  it("removes stale transport legs when activities are reordered", () => {
    let itinerary = createDraftItinerary({
      title: "杭州半日",
      destination: "杭州",
      startDate: "2026-07-01",
      dayCount: 1
    });
    const dayId = itinerary.days[0]!.id;
    itinerary = addActivity(itinerary, dayId, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖"
    });
    itinerary = addActivity(itinerary, dayId, {
      type: "food",
      title: "湖滨咖啡",
      placeName: "湖滨银泰"
    });
    itinerary = addActivity(itinerary, dayId, {
      type: "free_time",
      title: "武林夜逛",
      placeName: "武林广场"
    });

    const [first, second, third] = itinerary.days[0]!.activities;
    itinerary = setTransportLeg(itinerary, dayId, {
      fromActivityId: first!.id,
      toActivityId: second!.id,
      mode: "walking",
      distanceMeters: 900,
      durationMinutes: 12,
      provider: "manual"
    });
    expect(itinerary.days[0]!.transportLegs).toHaveLength(1);

    itinerary = reorderActivity(itinerary, dayId, second!.id, 2);
    expect(itinerary.days[0]!.activities.map((activity) => activity.title)).toEqual(["西湖", "武林夜逛", "湖滨咖啡"]);
    expect(itinerary.days[0]!.transportLegs).toHaveLength(0);
  });

  it("applies agent patches without overwriting locked manual activity content", () => {
    let itinerary = createDraftItinerary({
      title: "北京博物馆",
      destination: "北京",
      startDate: "2026-09-01",
      dayCount: 1
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "attraction",
      title: "国家博物馆",
      placeName: "中国国家博物馆",
      startTime: "10:00",
      endTime: "12:00",
      lockedByUser: true
    });

    const lockedId = itinerary.days[0]!.activities[0]!.id;
    const patched = applyItineraryPatch(itinerary, {
      source: "agent",
      reason: "避开午间排队",
      operations: [
        {
          type: "updateActivity",
          activityId: lockedId,
          changes: { title: "天安门广场", startTime: "08:30" }
        },
        {
          type: "addActivity",
          dayId: itinerary.days[0]!.id,
          activity: {
            type: "food",
            title: "前门午餐",
            placeName: "前门",
            startTime: "12:30",
            endTime: "13:30"
          }
        }
      ]
    });

    expect(patched.itinerary.days[0]!.activities[0]?.title).toBe("国家博物馆");
    expect(patched.itinerary.days[0]!.activities[0]?.startTime).toBe("10:00");
    expect(patched.itinerary.days[0]!.activities).toHaveLength(2);
    expect(patched.conflicts).toEqual([
      {
        activityId: lockedId,
        field: "title",
        kept: "国家博物馆",
        proposed: "天安门广场"
      },
      {
        activityId: lockedId,
        field: "startTime",
        kept: "10:00",
        proposed: "08:30"
      }
    ]);
  });

  it("summarizes itinerary differences for the conversation end diff", () => {
    const before = createDraftItinerary({
      title: "成都",
      destination: "成都",
      startDate: "2026-10-01",
      dayCount: 1
    });
    const after = addActivity(before, before.days[0]!.id, {
      type: "attraction",
      title: "人民公园茶馆",
      placeName: "人民公园",
      startTime: "15:00",
      endTime: "17:00"
    });

    expect(diffItineraries(before, after)).toEqual(["Day 1 新增活动：人民公园茶馆"]);
  });

  it("summarizes moved activities for the conversation end diff", () => {
    let before = createDraftItinerary({
      title: "杭州",
      destination: "杭州",
      startDate: "2026-10-01",
      dayCount: 2
    });
    before = addActivity(before, before.days[0]!.id, {
      type: "food",
      title: "湖滨咖啡",
      placeName: "湖滨咖啡"
    });

    const activityId = before.days[0]!.activities[0]!.id;
    const after = moveActivity(before, activityId, before.days[1]!.id, 0, "agent");

    expect(diffItineraries(before, after)).toEqual(["移动活动：湖滨咖啡 -> Day 2 第 1 项"]);
  });
});
