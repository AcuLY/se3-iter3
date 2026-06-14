import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "./db.js";
import { createApp } from "./server.js";

describe("travel workbench API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("serves seeded itineraries, skills, recommendations, and evaluation summaries", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const health = await request(app).get("/api/health").expect(200);
    expect(health.body).toMatchObject({ ok: true });

    const itineraries = await request(app).get("/api/itineraries").expect(200);
    expect(itineraries.body.items[0]).toMatchObject({
      title: "杭州三日松弛游",
      destination: "杭州"
    });

    const skills = await request(app).get("/api/skills").expect(200);
    expect(skills.body.items).toHaveLength(3);

    const recommendations = await request(app)
      .get("/api/skills/recommendations")
      .query({ destination: "杭州", preferences: "慢节奏 咖啡", currentText: "想要 citywalk" })
      .expect(200);
    expect(recommendations.body.items[0].skill.id).toBe("skill-slow-citywalk");

    const evaluation = await request(app).get("/api/evaluation/summary").expect(200);
    expect(evaluation.body.after.average.taskSuccess).toBeGreaterThan(0);
  });

  it("creates an itinerary and supports manual activity editing", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "苏州两日园林",
        destination: "苏州",
        startDate: "2026-07-20",
        dayCount: 2,
        companions: ["家人"],
        preferences: ["园林", "慢节奏"]
      })
      .expect(201);

    const dayId = created.body.itinerary.days[0].id;
    const activity = await request(app)
      .post(`/api/itineraries/${created.body.itinerary.id}/days/${dayId}/activities`)
      .send({
        type: "attraction",
        title: "拙政园",
        placeName: "拙政园",
        startTime: "09:00",
        endTime: "11:00",
        lockedByUser: true
      })
      .expect(201);

    const activityId = activity.body.itinerary.days[0].activities[0].id;
    const updated = await request(app)
      .patch(`/api/itineraries/${created.body.itinerary.id}/activities/${activityId}`)
      .send({
        description: "上午进园，避开午后热度。",
        budgetCny: 90
      })
      .expect(200);

    expect(updated.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "拙政园",
      description: "上午进园，避开午后热度。",
      lockedByUser: true
    });
  });

  it("updates itinerary-level budget and notes and includes them in export", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;

    const updated = await request(app)
      .patch(`/api/itineraries/${itineraryId}`)
      .send({
        budgetCny: 2400,
        notes: "每天留出午后休息，避免连续跨区。"
      })
      .expect(200);

    expect(updated.body.itinerary).toMatchObject({
      budgetCny: 2400,
      notes: "每天留出午后休息，避免连续跨区。"
    });

    const exported = await request(app).get(`/api/itineraries/${itineraryId}/export`).expect(200);
    expect(exported.text).toContain("总预算：2400 元");
    expect(exported.text).toContain("备注：每天留出午后休息，避免连续跨区。");
  });

  it("updates the editable day list when itinerary dates change", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "青岛海边",
        destination: "青岛",
        startDate: "2026-09-01",
        endDate: "2026-09-02"
      })
      .expect(201);

    const dayId = created.body.itinerary.days[0].id;
    await request(app)
      .post(`/api/itineraries/${created.body.itinerary.id}/days/${dayId}/activities`)
      .send({
        type: "attraction",
        title: "栈桥散步",
        placeName: "栈桥"
      })
      .expect(201);

    const expanded = await request(app)
      .patch(`/api/itineraries/${created.body.itinerary.id}`)
      .send({
        startDate: "2026-09-03",
        endDate: "2026-09-05"
      })
      .expect(200);

    expect(expanded.body.itinerary.days.map((day: { date: string }) => day.date)).toEqual([
      "2026-09-03",
      "2026-09-04",
      "2026-09-05"
    ]);
    expect(expanded.body.itinerary.days[0].activities[0].title).toBe("栈桥散步");

    const shortened = await request(app)
      .patch(`/api/itineraries/${created.body.itinerary.id}`)
      .send({
        endDate: "2026-09-03"
      })
      .expect(200);

    expect(shortened.body.itinerary.days).toHaveLength(1);
    expect(shortened.body.itinerary.days[0]).toMatchObject({
      title: "Day 1",
      date: "2026-09-03"
    });
  });

  it("reorders activities inside a day and persists the new sequence", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;
    const day = list.body.items[0].days[0];
    const secondActivityId = day.activities[1].id;

    const reordered = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day.id}/activities/${secondActivityId}/reorder`)
      .send({ targetIndex: 0 })
      .expect(200);

    expect(reordered.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual([
      "湖滨咖啡",
      "西湖晨间散步"
    ]);

    const reloaded = await request(app).get(`/api/itineraries/${itineraryId}`).expect(200);
    expect(reloaded.body.itinerary.days[0].activities[0].id).toBe(secondActivityId);
  });

  it("moves an activity to another day and persists the target sequence", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;
    const sourceDay = list.body.items[0].days[0];
    const targetDay = list.body.items[0].days[1];
    const activityId = sourceDay.activities[0].id;

    const moved = await request(app)
      .post(`/api/itineraries/${itineraryId}/activities/${activityId}/move`)
      .send({ targetDayId: targetDay.id, targetIndex: 0 })
      .expect(200);

    expect(moved.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual([
      "湖滨咖啡"
    ]);
    expect(moved.body.itinerary.days[1].activities[0]).toMatchObject({
      id: activityId,
      title: "西湖晨间散步"
    });

    const reloaded = await request(app).get(`/api/itineraries/${itineraryId}`).expect(200);
    expect(reloaded.body.itinerary.days[1].activities[0].id).toBe(activityId);
  });

  it("persists manual planning changes beyond the browser state", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "南京周末手动计划",
        destination: "南京",
        startDate: "2026-08-08",
        dayCount: 1,
        companions: ["朋友"],
        preferences: ["博物馆", "夜景"]
      })
      .expect(201);

    const itineraryId = created.body.itinerary.id;
    const addedDay = await request(app)
      .post(`/api/itineraries/${itineraryId}/days`)
      .send({ title: "Day 2 夜游" })
      .expect(201);
    expect(addedDay.body.itinerary.days).toHaveLength(2);
    expect(addedDay.body.itinerary.days[1]).toMatchObject({ title: "Day 2 夜游", date: "2026-08-09" });

    const activity = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${addedDay.body.itinerary.days[1].id}/activities`)
      .send({
        type: "attraction",
        title: "秦淮河夜景",
        placeName: "秦淮河",
        startTime: "19:00",
        endTime: "21:00"
      })
      .expect(201);

    const activityId = activity.body.itinerary.days[1].activities[0].id;
    await request(app).delete(`/api/itineraries/${itineraryId}/activities/${activityId}`).expect(200);

    const imported = await request(app)
      .post(`/api/itineraries/${itineraryId}/skills/skill-slow-citywalk`)
      .expect(200);
    expect(imported.body.itinerary.importedSkillIds).toContain("skill-slow-citywalk");

    const reloaded = await request(app).get(`/api/itineraries/${itineraryId}`).expect(200);
    expect(reloaded.body.itinerary.days).toHaveLength(2);
    expect(reloaded.body.itinerary.days[1].activities).toHaveLength(0);
    expect(reloaded.body.itinerary.importedSkillIds).toEqual(["skill-slow-citywalk"]);
  });

  it("imports uploaded Skill markdown into the current itinerary and records usage", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州雨天旅行",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-01"
      })
      .expect(201);
    const uploaded = await request(app)
      .post("/api/skills/import")
      .send({
        markdown: [
          "---",
          "name: rainy-cafe-style",
          "description: 适合雨天、咖啡、室内和不赶路的旅行风格",
          "---",
          "",
          "# Rainy Cafe Style",
          "",
          "## 规划规则",
          "- 雨天优先室内景点和咖啡休息",
          "- 每两段活动之间预留休息",
          "",
          "## 禁止模式",
          "- 暴雨时安排长距离户外步行"
        ].join("\n")
      })
      .expect(201);

    const skillId = uploaded.body.skill.id;
    const imported = await request(app)
      .post(`/api/itineraries/${created.body.itinerary.id}/skills/${skillId}`)
      .expect(200);

    expect(imported.body.itinerary.importedSkillIds).toContain(skillId);
    expect(imported.body.skill).toMatchObject({
      id: skillId,
      imports: 1,
      rules: ["雨天优先室内景点和咖啡休息", "每两段活动之间预留休息"],
      forbidden: ["暴雨时安排长距离户外步行"]
    });

    const removed = await request(app)
      .delete(`/api/itineraries/${created.body.itinerary.id}/skills/${skillId}`)
      .expect(200);

    expect(removed.body.itinerary.importedSkillIds).not.toContain(skillId);
    const reloaded = await request(app).get(`/api/itineraries/${created.body.itinerary.id}`).expect(200);
    expect(reloaded.body.itinerary.importedSkillIds).not.toContain(skillId);
    expect((await request(app).get("/api/skills").expect(200)).body.items.find((skill: { id: string }) => skill.id === skillId)).toMatchObject({
      id: skillId,
      imports: 1
    });
  });

  it("supports place search, transport leg persistence, and itinerary export", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州完整规划",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        budgetCny: 1200,
        notes: "控制跨区移动。"
      })
      .expect(201);

    expect(created.body.itinerary.days).toHaveLength(2);
    expect(created.body.itinerary.endDate).toBe("2026-07-02");

    const poi = await request(app).get("/api/maps/poi").query({ keywords: "西湖", city: "杭州" }).expect(200);
    expect(poi.body.items[0]).toMatchObject({
      name: "西湖",
      location: expect.objectContaining({ lng: expect.any(Number), lat: expect.any(Number) })
    });

    const itineraryId = created.body.itinerary.id;
    const dayId = created.body.itinerary.days[0].id;
    const first = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${dayId}/activities`)
      .send({
        type: "attraction",
        title: "西湖晨间散步",
        placeName: "西湖",
        place: {
          poiId: poi.body.items[0].id,
          name: poi.body.items[0].name,
          address: poi.body.items[0].address,
          city: poi.body.items[0].city,
          coordinates: poi.body.items[0].location
        },
        startTime: "09:00",
        endTime: "11:00",
        budgetCny: 0
      })
      .expect(201);
    const second = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${dayId}/activities`)
      .send({
        type: "food",
        title: "湖滨午餐",
        placeName: "湖滨银泰",
        startTime: "12:00",
        endTime: "13:30",
        budgetCny: 120
      })
      .expect(201);

    const fromActivity = first.body.itinerary.days[0].activities[0];
    const toActivity = second.body.itinerary.days[0].activities[1];
    const route = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${dayId}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "transit"
      })
      .expect(200);

    expect(route.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: "transit",
      durationMinutes: expect.any(Number),
      distanceMeters: expect.any(Number),
      routeStatus: "estimated",
      steps: expect.arrayContaining([
        expect.objectContaining({
          instruction: expect.stringContaining("湖滨午餐"),
          mode: "transit",
          durationMinutes: expect.any(Number)
        })
      ])
    });
    expect(route.body.route).toMatchObject({
      status: "estimated",
      fallbackReason: "实时路线不可用时的参考值"
    });

    const exported = await request(app).get(`/api/itineraries/${itineraryId}/export`).expect(200);
    expect(exported.text).toContain("# 杭州完整规划");
    expect(exported.text).toContain("西湖晨间散步");
    expect(exported.text).toContain("交通：");
  });

  it("lets a user save manual transport leg adjustments over a planned route", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州雨天路线",
        destination: "杭州",
        startDate: "2026-07-01"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const dayId = created.body.itinerary.days[0].id;

    const first = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${dayId}/activities`)
      .send({ type: "attraction", title: "西湖", placeName: "西湖" })
      .expect(201);
    const second = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${dayId}/activities`)
      .send({ type: "food", title: "湖滨晚餐", placeName: "湖滨银泰" })
      .expect(201);

    const fromActivity = first.body.itinerary.days[0].activities[0];
    const toActivity = second.body.itinerary.days[0].activities[1];
    const route = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${dayId}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "driving",
        distanceMeters: 2400,
        durationMinutes: 35,
        costCny: 18,
        summary: "打车或网约车",
        manualOverride: true,
        note: "雨天含等车时间"
      })
      .expect(200);

    expect(route.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: "driving",
      distanceMeters: 2400,
      durationMinutes: 35,
      costCny: 18,
      provider: "manual",
      summary: "打车或网约车",
      manualOverride: true,
      note: "雨天含等车时间"
    });
  });

  it("completes missing adjacent transport legs across the full itinerary", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州全程路线",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-02"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const [day1, day2] = created.body.itinerary.days;

    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "attraction", title: "西湖", placeName: "西湖", startTime: "09:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "food", title: "湖滨午餐", placeName: "湖滨银泰", startTime: "12:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "attraction", title: "灵隐寺", placeName: "灵隐寺", startTime: "10:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "food", title: "青芝坞晚餐", placeName: "青芝坞", startTime: "18:00" })
      .expect(201);

    const completed = await request(app)
      .post(`/api/itineraries/${itineraryId}/transport-legs/complete`)
      .send({ mode: "walking" })
      .expect(200);

    expect(completed.body.completed).toBe(2);
    expect(completed.body.itinerary.days[0].transportLegs).toHaveLength(1);
    expect(completed.body.itinerary.days[1].transportLegs).toHaveLength(1);
    expect(completed.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      mode: "walking",
      distanceMeters: expect.any(Number),
      durationMinutes: expect.any(Number),
      polyline: expect.arrayContaining([expect.objectContaining({ lng: expect.any(Number), lat: expect.any(Number) })])
    });

    const repeated = await request(app)
      .post(`/api/itineraries/${itineraryId}/transport-legs/complete`)
      .send({ mode: "walking" })
      .expect(200);
    expect(repeated.body.completed).toBe(0);
  });

  it("skips blank manual activities when completing adjacent transport legs", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州空白草稿",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-01"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const day = created.body.itinerary.days[0];

    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day.id}/activities`)
      .send({ type: "free_time", title: "" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day.id}/activities`)
      .send({ type: "free_time", title: "" })
      .expect(201);

    const completed = await request(app)
      .post(`/api/itineraries/${itineraryId}/transport-legs/complete`)
      .send({ mode: "walking" })
      .expect(200);

    expect(completed.body.completed).toBe(0);
    expect(completed.body.skipped).toBe(1);
    expect(completed.body.itinerary.days[0].transportLegs).toHaveLength(0);
  });

  it("writes daily weather into the itinerary and export", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/weather/weatherInfo");
      return new Response(
        JSON.stringify({
          status: "1",
          forecasts: [
            {
              city: "杭州市",
              casts: [
                {
                  date: "2026-07-02",
                  dayweather: "小雨",
                  nightweather: "阴",
                  daytemp: "28",
                  nighttemp: "22"
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州天气规划",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-02"
      })
      .expect(201);
    const day = created.body.itinerary.days[1];

    const weather = await request(app)
      .post(`/api/itineraries/${created.body.itinerary.id}/days/${day.id}/weather`)
      .send({ city: "杭州" })
      .expect(200);

    expect(weather.body.weather).toEqual({
      city: "杭州市",
      date: "2026-07-02",
      weather: "小雨 / 阴",
      temperature: "22-28 C",
      source: "amap"
    });
    expect(weather.body.itinerary.days[1].weather).toMatchObject({
      weather: "小雨 / 阴",
      temperature: "22-28 C"
    });

    const exported = await request(app).get(`/api/itineraries/${created.body.itinerary.id}/export`).expect(200);
    expect(exported.text).toContain("天气：小雨 / 阴，22-28 C（杭州市，amap）");
  });

  it("runs an agent action that updates the canvas, records traces, and returns a diff", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "导入慢节奏街区风格，帮我补全 Day 2 下午，别太赶。",
        importedSkillIds: ["skill-slow-citywalk"]
      })
      .expect(200);

    expect(result.body.message.content).toContain("已更新行程");
    expect(result.body.diff.length).toBeGreaterThan(0);
    expect(result.body.itinerary.importedSkillIds).toContain("skill-slow-citywalk");
    expect(result.body.itinerary.days[0].weather).toMatchObject({
      weather: "多云，适合户外步行",
      source: "mock"
    });
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toEqual(
      expect.arrayContaining(["MainAgent", "StyleAgent", "WeatherAgent", "PlannerAgent", "CriticAgent"])
    );
    expect(result.body.diff).toEqual(expect.arrayContaining(["已更新天气：Day 1 多云，适合户外步行"]));
  });

  it("uses uploaded Skill rules when the agent fills itinerary gaps", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;
    const uploaded = await request(app)
      .post("/api/skills/import")
      .send({
        markdown: [
          "---",
          "name: rainy-cafe-style",
          "description: 适合雨天、咖啡、室内和不赶路的旅行风格",
          "---",
          "",
          "# Rainy Cafe Style",
          "",
          "## 规划规则",
          "- 雨天优先室内景点和咖啡休息",
          "- 每两段活动之间预留休息",
          "",
          "## 禁止模式",
          "- 暴雨时安排长距离户外步行"
        ].join("\n")
      })
      .expect(201);
    await request(app).post(`/api/itineraries/${itineraryId}/skills/${uploaded.body.skill.id}`).expect(200);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "继续按导入的风格补 Day 2 下午，天气不好也别太赶。",
        importedSkillIds: [uploaded.body.skill.id]
      })
      .expect(200);

    const added = result.body.itinerary.days[1].activities.at(-1);
    expect(added.title).toBe("雨天室内咖啡休息");
    expect(added.description).toContain("雨天优先室内景点和咖啡休息");
    expect(result.body.diff).toEqual(expect.arrayContaining(["已应用风格：Rainy Cafe Style"]));
  });

  it("lets the agent complete every missing adjacent route across the itinerary", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州多日路线",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-02"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const [day1, day2] = created.body.itinerary.days;

    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "attraction", title: "西湖", placeName: "西湖", startTime: "09:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "food", title: "湖滨午餐", placeName: "湖滨银泰", startTime: "12:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "attraction", title: "灵隐寺", placeName: "灵隐寺", startTime: "10:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "food", title: "青芝坞晚餐", placeName: "青芝坞", startTime: "18:00" })
      .expect(201);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "帮我补全所有景点之间的交通路线和时间。"
      })
      .expect(200);

    const pending = result.body.itinerary.days.reduce((sum: number, day: { activities: unknown[]; transportLegs?: unknown[] }) => {
      const expected = Math.max(0, day.activities.length - 1);
      return sum + Math.max(0, expected - (day.transportLegs?.length ?? 0));
    }, 0);
    expect(pending).toBe(0);
    expect(result.body.diff).toEqual(expect.arrayContaining(["已补全交通路线：3 段"]));
  });

  it("persists agent conversation memory and preference summaries for later turns", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;

    const first = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "我喜欢慢节奏和咖啡，Day 2 下午别安排太满。",
        importedSkillIds: ["skill-slow-citywalk"]
      })
      .expect(200);
    expect(first.body.session.contextSummary).toContain("我喜欢慢节奏和咖啡");
    expect(first.body.session.userPreferenceSummary).toContain("慢节奏");

    const second = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "继续按刚才的偏好补一个雨天备选。",
        importedSkillIds: ["skill-slow-citywalk"]
      })
      .expect(200);
    expect(second.body.session.contextSummary).toContain("历史参考");
    expect(second.body.traces.map((trace: { title: string }) => trace.title)).toContain("读取历史偏好");

    const sessions = await request(app).get("/api/agent/sessions").query({ itineraryId }).expect(200);
    expect(sessions.body.items).toHaveLength(2);
    expect(sessions.body.items[0].contextSummary).toContain("继续按刚才的偏好");
    expect(sessions.body.items[0].userPreferenceSummary).toContain("慢节奏");
  });

  it("updates itinerary-level details in deterministic fallback when the user asks directly", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把返回日期改到 2026-07-05，预算 2600，备注每天午后留出休息。"
      })
      .expect(200);

    expect(result.body.itinerary).toMatchObject({
      title: itinerary.title,
      endDate: "2026-07-05",
      budgetCny: 2600,
      notes: "每天午后留出休息。"
    });
    expect(result.body.itinerary.days).toHaveLength(5);
    expect(result.body.diff).toEqual(expect.arrayContaining(["已更新日期范围", "已更新预算", "已更新备注"]));
  });

  it("streams user-facing planning progress before returning the final agent update", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;

    const result = await request(app)
      .post("/api/agent/run-stream")
      .send({
        itineraryId,
        message: "帮我补全 Day 2 下午，节奏轻松一点。",
        importedSkillIds: ["skill-slow-citywalk"]
      })
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);

    expect(result.text).toContain("event: progress");
    expect(result.text).toContain("正在匹配旅行风格");
    expect(result.text).toContain("event: final");
    expect(result.text).toContain("已更新行程");
  });

  it("runs DeepSeek tool calls as itinerary operations when configured", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const dayId = itinerary.days[1].id;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer deepseek-test-key"
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "我会先补全第二天下午。",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "add_activity",
                      arguments: JSON.stringify({
                        dayId,
                        type: "attraction",
                        title: "浙江省博物馆下午参观",
                        placeName: "浙江省博物馆",
                        startTime: "14:00",
                        endTime: "16:00",
                        budgetCny: 0,
                        description: "结合慢节奏 Skill，安排一个室内文化点。"
                      })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "帮我给第二天下午安排一个室内景点",
        importedSkillIds: ["skill-slow-citywalk"]
      })
      .expect(200);

    expect(result.body.itinerary.days[1].activities.at(-1)).toMatchObject({
      title: "浙江省博物馆下午参观",
      source: "agent"
    });
    expect(result.body.session.messages).toHaveLength(2);
    expect(result.body.session.contextSummary).toContain("帮我给第二天下午安排一个室内景点");
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toEqual(
      expect.arrayContaining(["MainAgent", "PlannerAgent"])
    );
  });

  it("resolves POI coordinates for agent-added activities with a place name", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const dayId = itinerary.days[1].id;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.origin + url.pathname === "https://api.deepseek.com/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "已添加一个带地点的室内景点。",
                  tool_calls: [
                    {
                      id: "call-add",
                      type: "function",
                      function: {
                        name: "add_activity",
                        arguments: JSON.stringify({
                          dayId,
                          type: "attraction",
                          title: "浙江省博物馆下午参观",
                          placeName: "浙江省博物馆",
                          startTime: "14:00",
                          endTime: "16:00"
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const keyword = url.searchParams.get("keywords") ?? "未知地点";
      return new Response(
        JSON.stringify({
          status: "1",
          pois: [
            {
              id: keyword === "浙江省博物馆" ? "B0FFGZHJZB" : `mock-${keyword}`,
              name: keyword,
              address: keyword === "浙江省博物馆" ? "浙江省杭州市西湖区孤山路25号" : "杭州市核心区域",
              cityname: "杭州市",
              location: keyword === "浙江省博物馆" ? "120.1452,30.2536" : "120.1551,30.2741"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "帮我给第二天下午安排浙江省博物馆。"
      })
      .expect(200);

    const calledPoiKeywords = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.origin + url.pathname === "https://restapi.amap.com/v3/place/text")
      .map((url) => url.searchParams.get("keywords"));
    expect(calledPoiKeywords).toContain("浙江省博物馆");
    expect(result.body.itinerary.days[1].activities.at(-1)).toMatchObject({
      title: "浙江省博物馆下午参观",
      placeName: "浙江省博物馆",
      place: {
        poiId: "B0FFGZHJZB",
        name: "浙江省博物馆",
        address: "浙江省杭州市西湖区孤山路25号",
        city: "杭州市",
        coordinates: { lng: 120.1452, lat: 30.2536 }
      }
    });
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("AttractionAgent");
    expect(result.body.diff).toContain("已解析地点：浙江省博物馆");
  });

  it("lets DeepSeek search POI candidates and add the selected place as an activity", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const dayId = itinerary.days[1].id;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.origin + url.pathname === "https://api.deepseek.com/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "已选择灵隐寺并加入第二天。",
                  tool_calls: [
                    {
                      id: "call-place",
                      type: "function",
                      function: {
                        name: "add_place_activity",
                        arguments: JSON.stringify({
                          dayId,
                          query: "灵隐寺",
                          poiName: "灵隐寺飞来峰景区",
                          type: "attraction",
                          title: "灵隐寺飞来峰慢游",
                          startTime: "09:30",
                          endTime: "12:00",
                          budgetCny: 75,
                          description: "选择正式景区 POI，上午慢慢逛。"
                        })
                      }
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: "1",
          pois: [
            {
              id: "POI-CAFE",
              name: "灵隐路咖啡",
              address: "杭州市西湖区灵隐路",
              cityname: "杭州市",
              location: "120.1170,30.2400"
            },
            {
              id: "POI-LINGYIN",
              name: "灵隐寺飞来峰景区",
              address: "浙江省杭州市西湖区灵隐路法云弄1号",
              cityname: "杭州市",
              location: "120.1011,30.2404"
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "帮我在 Day 2 上午加入灵隐寺，选正式景区。"
      })
      .expect(200);

    const added = result.body.itinerary.days[1].activities.at(-1);
    expect(added).toMatchObject({
      title: "灵隐寺飞来峰慢游",
      placeName: "灵隐寺飞来峰景区",
      place: {
        poiId: "POI-LINGYIN",
        name: "灵隐寺飞来峰景区",
        address: "浙江省杭州市西湖区灵隐路法云弄1号",
        city: "杭州市",
        coordinates: { lng: 120.1011, lat: 30.2404 }
      },
      source: "agent"
    });
    expect(result.body.diff).toContain("已添加地点：灵隐寺飞来峰景区");
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("AttractionAgent");
  });

  it("lets DeepSeek set a transport leg through a route tool call", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "已计算两站之间的步行路线。",
                tool_calls: [
                  {
                    id: "call-route",
                    type: "function",
                    function: {
                      name: "set_transport_leg",
                      arguments: JSON.stringify({
                        dayId: day.id,
                        fromActivityId: fromActivity.id,
                        toActivityId: toActivity.id,
                        mode: "walking"
                      })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "帮我计算 Day 1 两个地点之间的步行路线。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: "walking",
      durationMinutes: expect.any(Number),
      distanceMeters: expect.any(Number)
    });
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("TransportAgent");
    expect(result.body.diff).toContain("已更新交通：西湖晨间散步 到 湖滨咖啡");
  });

  it("lets DeepSeek complete every missing adjacent route through a route tool call", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "杭州多日路线",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-02"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const [day1, day2] = created.body.itinerary.days;

    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "attraction", title: "西湖", placeName: "西湖", startTime: "09:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "food", title: "湖滨午餐", placeName: "湖滨银泰", startTime: "12:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "attraction", title: "灵隐寺", placeName: "灵隐寺", startTime: "10:00" })
      .expect(201);
    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "food", title: "青芝坞晚餐", placeName: "青芝坞", startTime: "18:00" })
      .expect(201);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "已补全全程相邻地点的步行路线。",
                tool_calls: [
                  {
                    id: "call-complete-routes",
                    type: "function",
                    function: {
                      name: "complete_transport_legs",
                      arguments: JSON.stringify({ mode: "walking" })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "帮我一次性补全所有景点之间的步行路线。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].transportLegs).toHaveLength(1);
    expect(result.body.itinerary.days[1].transportLegs).toHaveLength(1);
    const pending = result.body.itinerary.days.reduce((sum: number, day: { activities: unknown[]; transportLegs?: unknown[] }) => {
      const expected = Math.max(0, day.activities.length - 1);
      return sum + Math.max(0, expected - (day.transportLegs?.length ?? 0));
    }, 0);
    expect(pending).toBe(0);
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("TransportAgent");
    expect(result.body.diff).toEqual(expect.arrayContaining(["已补全交通路线：2 段"]));
  });

  it("lets DeepSeek update itinerary dates, budget, and notes without renaming the trip", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "已更新旅行日期、预算和备注。",
                tool_calls: [
                  {
                    id: "call-details",
                    type: "function",
                    function: {
                      name: "update_itinerary_details",
                      arguments: JSON.stringify({
                        startDate: "2026-07-01",
                        endDate: "2026-07-05",
                        budgetCny: 2600,
                        notes: "每天午后留出休息，不连续跨区。"
                      })
                    }
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把返回日期改到 7 月 5 日，预算 2600，备注每天午后休息。"
      })
      .expect(200);

    expect(result.body.itinerary).toMatchObject({
      title: itinerary.title,
      startDate: "2026-07-01",
      endDate: "2026-07-05",
      budgetCny: 2600,
      notes: "每天午后留出休息，不连续跨区。"
    });
    expect(result.body.itinerary.days.map((day: { date: string }) => day.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05"
    ]);
    expect(result.body.diff).toEqual(expect.arrayContaining(["已更新日期范围", "已更新预算", "已更新备注"]));
    expect(result.body.traces.map((trace: { title: string }) => trace.title)).toContain("update_itinerary_details");
  });

  it("extracts an editable standard Skill draft from text and requires publish confirmation", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const extracted = await request(app)
      .post("/api/skills/extract")
      .send({
        sourceText: "这次厦门旅行最喜欢沙坡尾海边散步、傍晚日落和小店探索，整体不要赶路。",
        itineraryId: null
      })
      .expect(201);

    expect(extracted.body.skill.status).toBe("draft");
    expect(extracted.body.skill.source).toBe("extracted");
    expect(extracted.body.skill.body).toContain("沙坡尾");

    const published = await request(app)
      .post(`/api/skills/${extracted.body.skill.id}/publish`)
      .send({
        displayName: "厦门海边松弛风格",
        description: "适合海边日落、小店探索和不赶路的厦门旅行。"
      })
      .expect(200);

    expect(published.body.skill.status).toBe("published");
    expect(published.body.skill.displayName).toBe("厦门海边松弛风格");
  });

  it("updates skill metadata, toggles my favorite state, and lists favorite skills", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const updated = await request(app)
      .patch("/api/skills/skill-slow-citywalk")
      .send({
        displayName: "慢节奏街区漫步 Plus",
        tags: ["慢节奏", "咖啡", "夜景"]
      })
      .expect(200);

    expect(updated.body.skill).toMatchObject({
      id: "skill-slow-citywalk",
      displayName: "慢节奏街区漫步 Plus",
      tags: ["慢节奏", "咖啡", "夜景"]
    });

    const favorited = await request(app)
      .post("/api/skills/skill-slow-citywalk/favorite")
      .send({ favorited: true })
      .expect(200);
    expect(favorited.body.skill).toMatchObject({
      id: "skill-slow-citywalk",
      favorited: true,
      favorites: 19
    });

    const favorites = await request(app).get("/api/skills").query({ favorite: "true" }).expect(200);
    expect(favorites.body.items.map((skill: { id: string }) => skill.id)).toEqual(["skill-slow-citywalk"]);

    const unfavorited = await request(app)
      .post("/api/skills/skill-slow-citywalk/favorite")
      .send({ favorited: false })
      .expect(200);
    expect(unfavorited.body.skill).toMatchObject({
      id: "skill-slow-citywalk",
      favorited: false,
      favorites: 18
    });
  });

  it("wraps Amap-compatible services with deterministic mock fallbacks", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const poi = await request(app).get("/api/maps/poi").query({ keywords: "西湖", city: "杭州" }).expect(200);
    expect(poi.body.items[0]).toMatchObject({
      name: "西湖",
      city: "杭州",
      source: "mock"
    });

    const route = await request(app)
      .post("/api/maps/route")
      .send({ from: "西湖", to: "湖滨银泰", mode: "walking" })
      .expect(200);
    expect(route.body.route).toMatchObject({
      mode: "walking",
      source: "mock"
    });
  });
});
