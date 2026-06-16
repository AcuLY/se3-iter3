import request from "supertest";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "./db.js";
import { createApp } from "./server.js";

type RouteCountDay = {
  activities: unknown[];
  transportLegs?: unknown[];
};

function expectedCompleteRouteCount(days: RouteCountDay[]): number {
  return days.reduce((sum, day, index) => {
    const sameDayRoutes = Math.max(0, day.activities.length - 1);
    const crossDayStartRoute = index > 0 && (days[index - 1]?.activities.length ?? 0) > 0 && day.activities.length > 0 ? 1 : 0;
    return sum + sameDayRoutes + crossDayStartRoute;
  }, 0);
}

function actualRouteCount(days: RouteCountDay[]): number {
  return days.reduce((sum, day) => sum + (day.transportLegs?.length ?? 0), 0);
}

function parseSseEvents(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      const event = chunk
        .split(/\r?\n/)
        .find((line) => line.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const data = chunk
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (!event) return [];
      try {
        return [{ event, data: JSON.parse(data) }];
      } catch {
        return [{ event, data }];
      }
    });
}

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

  it("archives itineraries out of the default history and can delete them permanently", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "重复测试行程",
        destination: "杭州",
        startDate: "2026-07-01",
        endDate: "2026-07-03"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;

    const archived = await request(app).post(`/api/itineraries/${itineraryId}/archive`).expect(200);
    expect(archived.body.itinerary.archivedAt).toEqual(expect.any(String));

    const visible = await request(app).get("/api/itineraries").expect(200);
    expect(visible.body.items.map((item: { id: string }) => item.id)).not.toContain(itineraryId);

    const withArchived = await request(app).get("/api/itineraries").query({ includeArchived: "true" }).expect(200);
    expect(withArchived.body.items.map((item: { id: string }) => item.id)).toContain(itineraryId);

    await request(app).delete(`/api/itineraries/${itineraryId}`).expect(200).expect((res) => {
      expect(res.body.deleted).toBe(true);
    });

    await request(app).get(`/api/itineraries/${itineraryId}`).expect(404);
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

  it("can add an empty day before the current first day without shifting existing activities", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "苏州验收",
        destination: "苏州",
        startDate: "2026-07-01",
        endDate: "2026-07-02"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const firstDayId = created.body.itinerary.days[0].id;

    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${firstDayId}/activities`)
      .send({
        type: "attraction",
        title: "拙政园",
        placeName: "拙政园"
      })
      .expect(201);

    const prepended = await request(app)
      .post(`/api/itineraries/${itineraryId}/days`)
      .send({ position: "before" })
      .expect(201);

    expect(prepended.body.itinerary.startDate).toBe("2026-06-30");
    expect(prepended.body.itinerary.days.map((day: { title: string }) => day.title)).toEqual(["Day 1", "Day 2", "Day 3"]);
    expect(prepended.body.itinerary.days.map((day: { date: string }) => day.date)).toEqual(["2026-06-30", "2026-07-01", "2026-07-02"]);
    expect(prepended.body.itinerary.days[0].activities).toHaveLength(0);
    expect(prepended.body.itinerary.days[1].activities[0].title).toBe("拙政园");
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

  it("rejects uploaded travel styles that are not ready Skill markdown", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const rejected = await request(app)
      .post("/api/skills/import")
      .send({
        markdown: [
          "---",
          "name: loose-travel-notes",
          "---",
          "",
          "只是一些旅行记录，还没有整理出规划规则。"
        ].join("\n")
      })
      .expect(400);

    expect(rejected.body.error).toContain("旅行风格格式不完整");
    expect(rejected.body.validation).toMatchObject({
      valid: false,
      issues: expect.arrayContaining(["需要填写 description", "至少添加一条规划规则"])
    });
    expect(db.listSkills().map((skill) => skill.name)).not.toContain("loose-travel-notes");
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

  it("lets a user remove a saved transport leg without removing activities", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    const routed = await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking"
      })
      .expect(200);
    expect(routed.body.itinerary.days[0].transportLegs).toHaveLength(1);

    const removed = await request(app)
      .delete(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs/${fromActivity.id}/${toActivity.id}`)
      .expect(200);

    expect(removed.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual([
      "西湖晨间散步",
      "湖滨咖啡"
    ]);
    expect(removed.body.itinerary.days[0].transportLegs).toEqual([]);
    expect(removed.body.itinerary.manualRevision).toBeGreaterThan(itinerary.manualRevision);
  });

  it("invalidates adjacent transport legs when an activity place is replaced", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    const routed = await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking"
      })
      .expect(200);
    expect(routed.body.itinerary.days[0].transportLegs).toHaveLength(1);

    const noteOnly = await request(app)
      .patch(`/api/itineraries/${itinerary.id}/activities/${fromActivity.id}`)
      .send({ note: "上午避开旅行团" })
      .expect(200);
    expect(noteOnly.body.itinerary.days[0].transportLegs).toHaveLength(1);

    const replaced = await request(app)
      .patch(`/api/itineraries/${itinerary.id}/activities/${fromActivity.id}`)
      .send({
        title: "灵隐寺",
        placeName: "灵隐寺",
        place: {
          name: "灵隐寺",
          address: "法云弄1号",
          city: "杭州",
          coordinates: { lng: 120.102, lat: 30.24 }
        }
      })
      .expect(200);

    expect(replaced.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual([
      "灵隐寺",
      "湖滨咖啡"
    ]);
    expect(replaced.body.itinerary.days[0].transportLegs).toEqual([]);
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

    expect(completed.body.completed).toBe(expectedCompleteRouteCount(completed.body.itinerary.days));
    expect(completed.body.itinerary.days[0].transportLegs).toHaveLength(1);
    expect(completed.body.itinerary.days[1].transportLegs).toHaveLength(2);
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

  it("uses the previous day's final activity as the next day's route start", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });

    const created = await request(app)
      .post("/api/itineraries")
      .send({
        title: "江南跨城两日",
        destination: "上海虹桥站",
        startDate: "2026-07-01",
        endDate: "2026-07-02"
      })
      .expect(201);
    const itineraryId = created.body.itinerary.id;
    const [day1, day2] = created.body.itinerary.days;

    await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "attraction", title: "西湖", placeName: "西湖", startTime: "14:00" })
      .expect(201);
    const cafe = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day1.id}/activities`)
      .send({ type: "food", title: "湖滨咖啡", placeName: "湖滨银泰", startTime: "11:30", endTime: "12:30" })
      .expect(201);
    const museum = await request(app)
      .post(`/api/itineraries/${itineraryId}/days/${day2.id}/activities`)
      .send({ type: "attraction", title: "苏州博物馆", placeName: "苏州博物馆", startTime: "10:00" })
      .expect(201);
    const cafeId = cafe.body.itinerary.days[0].activities.at(-1).id;
    const museumId = museum.body.itinerary.days[1].activities[0].id;

    const completed = await request(app)
      .post(`/api/itineraries/${itineraryId}/transport-legs/complete`)
      .send({ mode: "driving" })
      .expect(200);

    expect(completed.body.completed).toBe(2);
    expect(completed.body.itinerary.days[0].transportLegs).toHaveLength(1);
    expect(completed.body.itinerary.days[1].transportLegs).toHaveLength(1);
    expect(completed.body.itinerary.days[1].transportLegs[0]).toMatchObject({
      fromActivityId: cafeId,
      toActivityId: museumId,
      mode: "driving"
    });
    expect(completed.body.itinerary.days[1].transportLegs[0].fromActivityId).not.toBe(
      completed.body.itinerary.days[0].activities[0].id
    );
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

  it("restores a previous itinerary snapshot so agent undo survives refresh", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const before = list.body.items[0];

    const agentResult = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: before.id,
        message: "帮我补全 Day 2 下午，别太赶。",
        importedSkillIds: []
      })
      .expect(200);

    expect(agentResult.body.itinerary.days[1].activities.length).toBeGreaterThan(before.days[1].activities.length);

    const restored = await request(app)
      .post(`/api/itineraries/${before.id}/restore`)
      .send({ itinerary: before })
      .expect(200);

    expect(restored.body.itinerary.days[1].activities).toHaveLength(before.days[1].activities.length);
    const persisted = await request(app).get(`/api/itineraries/${before.id}`).expect(200);
    expect(persisted.body.itinerary.days[1].activities).toHaveLength(before.days[1].activities.length);
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
    expect(result.body.message.content).toContain("Rainy Cafe Style");
    expect(result.body.diff).toEqual(expect.arrayContaining(["已应用风格：Rainy Cafe Style"]));
  });

  it("lets the deterministic agent search and add an explicit POI without DeepSeek", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "在 Day 1 下午 15:00-17:00 添加灵隐寺景点，并补全步行路线。"
      })
      .expect(200);

    const added = result.body.itinerary.days[0].activities.at(-1);
    expect(added).toMatchObject({
      title: "灵隐寺",
      type: "attraction",
      placeName: "灵隐寺",
      startTime: "15:00",
      endTime: "17:00",
      source: "agent"
    });
    expect(added.place).toMatchObject({
      name: "灵隐寺",
      coordinates: { lng: expect.any(Number), lat: expect.any(Number) }
    });
    expect(result.body.itinerary.days[0].transportLegs).toHaveLength(2);
    expect(result.body.diff).toEqual(expect.arrayContaining(["已添加地点：灵隐寺", "已补全交通路线：2 段"]));
    expect(result.body.diff.join(" ")).not.toContain("慢节奏街区探索");
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("AttractionAgent");
  });

  it("lets the agent complete every missing adjacent and cross-day route across the itinerary", async () => {
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

    expect(result.body.itinerary.days[0].activities).toHaveLength(2);
    expect(result.body.itinerary.days[1].activities).toHaveLength(2);
    expect(actualRouteCount(result.body.itinerary.days)).toBe(expectedCompleteRouteCount(result.body.itinerary.days));
    expect(result.body.diff).toEqual(expect.arrayContaining(["已补全交通路线：3 段"]));
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent update a specific transport mode without adding activities", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把西湖晨间散步到湖滨咖啡这段交通改成公交/地铁。"
      })
      .expect(200);

    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual(originalActivityCounts);
    expect(result.body.itinerary.days[0].transportLegs).toHaveLength(1);
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: itinerary.days[0].activities[0].id,
      toActivityId: itinerary.days[0].activities[1].id,
      mode: "transit",
      durationMinutes: expect.any(Number),
      distanceMeters: expect.any(Number)
    });
    expect(result.body.diff).toContain("已更新交通：西湖晨间散步 到 湖滨咖啡");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
    expect(result.body.diff.join(" ")).not.toContain("已补全交通路线");
  });

  it("lets the deterministic agent compare transport modes and choose the fastest route", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "比较西湖晨间散步到湖滨咖啡的步行、公交和骑行，选最快的路线。"
      })
      .expect(200);

    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual(originalActivityCounts);
    expect(result.body.itinerary.days[0].transportLegs).toHaveLength(1);
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: itinerary.days[0].activities[0].id,
      toActivityId: itinerary.days[0].activities[1].id,
      mode: "cycling",
      durationMinutes: 10,
      distanceMeters: expect.any(Number)
    });
    expect(result.body.diff).toContain("已比较交通方式：步行、公交/地铁、骑行，已选择骑行");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent move an existing activity to another day", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const totalActivitiesBefore = itinerary.days.reduce((sum: number, day: { activities: unknown[] }) => sum + day.activities.length, 0);
    const cafeActivityId = itinerary.days[0].activities[1].id;

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把湖滨咖啡移到 Day 2 上午第一项。"
      })
      .expect(200);

    const totalActivitiesAfter = result.body.itinerary.days.reduce((sum: number, day: { activities: unknown[] }) => sum + day.activities.length, 0);
    expect(totalActivitiesAfter).toBe(totalActivitiesBefore);
    expect(result.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual(["西湖晨间散步"]);
    expect(result.body.itinerary.days[1].activities[0]).toMatchObject({
      id: cafeActivityId,
      title: "湖滨咖啡"
    });
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
    expect(result.body.diff.join(" ")).toContain("移动");
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

  it("lets a user clear agent memory for the current itinerary", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itineraryId = list.body.items[0].id;

    await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId,
        message: "我喜欢慢节奏和咖啡，记住这个偏好。",
        importedSkillIds: ["skill-slow-citywalk"]
      })
      .expect(200);

    await request(app)
      .delete("/api/agent/sessions")
      .query({ itineraryId })
      .expect(200)
      .expect((res) => {
        expect(res.body.deleted).toBe(1);
      });

    const sessions = await request(app).get("/api/agent/sessions").query({ itineraryId }).expect(200);
    expect(sessions.body.items).toEqual([]);

    const traces = await request(app).get("/api/agent/traces").expect(200);
    expect(traces.body.items).toEqual([]);
  });

  it("updates itinerary-level details in deterministic fallback when the user asks directly", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

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
    expect(result.body.itinerary.days.slice(0, originalActivityCounts.length).map((day: { activities: unknown[] }) => day.activities.length)).toEqual(
      originalActivityCounts
    );
    expect(result.body.diff).toEqual(expect.arrayContaining(["已更新日期范围", "已更新预算", "已更新备注"]));
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("expands natural month-day detail updates in deterministic fallback", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把返回日期改到 7 月 5 日，预算 2600，备注每天午后留出休息。"
      })
      .expect(200);

    expect(result.body.itinerary).toMatchObject({
      title: itinerary.title,
      endDate: "2026-07-05",
      budgetCny: 2600,
      notes: "每天午后留出休息。"
    });
    expect(result.body.itinerary.days).toHaveLength(5);
    expect(result.body.itinerary.days.slice(0, originalActivityCounts.length).map((day: { activities: unknown[] }) => day.activities.length)).toEqual(
      originalActivityCounts
    );
    expect(result.body.diff).toEqual(expect.arrayContaining(["已更新日期范围", "已更新预算", "已更新备注"]));
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("updates the departure point, companions, and preferences in deterministic fallback without adding activities", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把目的地改成苏州，同行人改成家人和孩子，偏好改成园林、慢节奏、亲子。"
      })
      .expect(200);

    expect(result.body.itinerary).toMatchObject({
      title: itinerary.title,
      destination: "苏州",
      companions: ["家人", "孩子"],
      preferences: ["园林", "慢节奏", "亲子"]
    });
    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual(originalActivityCounts);
    expect(result.body.diff).toEqual(expect.arrayContaining(["已更新出发点", "已更新偏好", "已更新同行人"]));
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
    expect(result.body.session.userPreferenceSummary).toContain("亲子");
  });

  it("updates an existing activity in deterministic fallback without adding a new activity", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "把西湖晨间散步改到 10:00-11:30，预算 30，备注改成避开早高峰。"
      })
      .expect(200);

    const updatedActivity = result.body.itinerary.days[0].activities[0];
    expect(updatedActivity).toMatchObject({
      title: "西湖晨间散步",
      startTime: "10:00",
      endTime: "11:30",
      budgetCny: 30,
      note: "避开早高峰。"
    });
    expect(result.body.itinerary.budgetCny).toBe(itinerary.budgetCny);
    expect(result.body.itinerary.notes).toBe(itinerary.notes);
    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual(originalActivityCounts);
    expect(result.body.diff).toEqual(expect.arrayContaining(["Day 1 更新活动：西湖晨间散步 -> 西湖晨间散步"]));
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("replaces an existing activity with a searched place in deterministic fallback", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);
    const cafeActivityId = itinerary.days[0].activities[1].id;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/place/text");
      return new Response(
        JSON.stringify({
          status: "1",
          pois: [
            {
              id: "POI-LINGYIN",
              name: "灵隐寺飞来峰景区",
              address: "浙江省杭州市西湖区灵隐路法云弄1号",
              cityname: "杭州市",
              adname: "西湖区",
              type: "风景名胜;风景名胜相关;旅游景点",
              typecode: "110000",
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
        message: "把湖滨咖啡换成灵隐寺，改成景点，时间 14:00-16:00。"
      })
      .expect(200);

    const calledPoiKeywords = fetchMock.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("keywords"));
    expect(calledPoiKeywords).toContain("灵隐寺");
    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual(originalActivityCounts);
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      id: cafeActivityId,
      type: "attraction",
      title: "灵隐寺",
      placeName: "灵隐寺飞来峰景区",
      startTime: "14:00",
      endTime: "16:00",
      place: {
        poiId: "POI-LINGYIN",
        name: "灵隐寺飞来峰景区",
        address: "浙江省杭州市西湖区灵隐路法云弄1号",
        city: "杭州市",
        district: "西湖区",
        coordinates: { lng: 120.1011, lat: 30.2404 }
      }
    });
    expect(result.body.diff.join(" ")).toContain("更新活动");
    expect(result.body.diff).toContain("已更新地点：灵隐寺飞来峰景区");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("removes an existing activity in deterministic fallback without adding a new activity", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "删掉湖滨咖啡，其他活动保持不变。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).not.toContain("湖滨咖啡");
    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual([
      originalActivityCounts[0] - 1,
      ...originalActivityCounts.slice(1)
    ]);
    expect(result.body.diff).toEqual(expect.arrayContaining(["删除活动：湖滨咖啡"]));
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("does not remove activities when a cancellation request targets a transport leg", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const originalActivityTitles = itinerary.days.map((day: { activities: Array<{ title: string }> }) =>
      day.activities.map((activity) => activity.title)
    );

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。"
      })
      .expect(200);

    expect(result.body.itinerary.days.map((day: { activities: Array<{ title: string }> }) => day.activities.map((activity) => activity.title))).toEqual(
      originalActivityTitles
    );
    expect(result.body.diff.join(" ")).not.toContain("删除活动");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent clear a specific transport leg without removing activities", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    const routed = await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking"
      })
      .expect(200);
    expect(routed.body.itinerary.days[0].transportLegs).toHaveLength(1);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual([
      "西湖晨间散步",
      "湖滨咖啡"
    ]);
    expect(result.body.itinerary.days[0].transportLegs).toEqual([]);
    expect(result.body.diff).toContain("已取消交通：西湖晨间散步 到 湖滨咖啡");
    expect(result.body.diff.join(" ")).not.toContain("删除活动");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent propose route conflict options without changing the canvas", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking",
        manualOverride: true,
        durationMinutes: 45,
        distanceMeters: 1300,
        summary: "步行含等待"
      })
      .expect(200);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "西湖晨间散步到湖滨咖啡这段交通会晚到，先给我几个调整方案，暂时不要改画布。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "西湖晨间散步",
      startTime: "09:00",
      endTime: "11:00"
    });
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      title: "湖滨咖啡",
      startTime: "11:30",
      endTime: "12:30"
    });
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: "walking",
      durationMinutes: 45,
      manualOverride: true
    });
    expect(result.body.diff).toEqual([]);
    expect(result.body.message.content).toContain("路线会在 11:45 左右到达");
    expect(result.body.message.content).toContain("顺延下一项");
    expect(result.body.message.content).toContain("缩短上一站");
    expect(result.body.message.content).toContain("改用更快交通方式");
    expect(result.body.traces.map((trace: { title: string }) => trace.title)).toContain("提出路线修复方案");
  });

  it("lets the deterministic agent delay the next activity when a transport leg arrives late", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking",
        manualOverride: true,
        durationMinutes: 45,
        distanceMeters: 1300,
        summary: "步行含等待"
      })
      .expect(200);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "西湖晨间散步",
      startTime: "09:00",
      endTime: "11:00"
    });
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      title: "湖滨咖啡",
      startTime: "11:45",
      endTime: "12:45"
    });
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      durationMinutes: 45
    });
    expect(result.body.diff).toContain("已顺延活动：湖滨咖啡 到 11:45");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent switch to a faster transport mode when a route would arrive late", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking",
        manualOverride: true,
        durationMinutes: 45,
        distanceMeters: 1300,
        summary: "步行含等待"
      })
      .expect(200);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我换个更快的交通方式，不改活动时间。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "西湖晨间散步",
      startTime: "09:00",
      endTime: "11:00"
    });
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      title: "湖滨咖啡",
      startTime: "11:30",
      endTime: "12:30"
    });
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: "cycling",
      durationMinutes: 10
    });
    expect(result.body.diff).toContain("已比较交通方式：步行、公交/地铁、驾车、骑行，已选择骑行");
    expect(result.body.diff.join(" ")).not.toContain("已顺延活动");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent shorten the previous activity when a transport leg arrives late", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking",
        manualOverride: true,
        durationMinutes: 45,
        distanceMeters: 1300,
        summary: "步行含等待"
      })
      .expect(200);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我缩短上一站停留。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "西湖晨间散步",
      startTime: "09:00",
      endTime: "10:45"
    });
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      title: "湖滨咖啡",
      startTime: "11:30",
      endTime: "12:30"
    });
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      durationMinutes: 45
    });
    expect(result.body.diff).toContain("已缩短停留：西湖晨间散步 到 10:45");
    expect(result.body.diff.join(" ")).not.toContain("已顺延活动");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("lets the deterministic agent shift downstream activities when a route conflict affects the rest of the day", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    const withThirdActivity = await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/activities`)
      .send({
        type: "attraction",
        title: "运河夜游",
        placeName: "武林门码头",
        startTime: "13:00",
        endTime: "14:00"
      })
      .expect(201);
    expect(withThirdActivity.body.itinerary.days[0].activities).toHaveLength(3);

    await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking",
        manualOverride: true,
        durationMinutes: 45,
        distanceMeters: 1300,
        summary: "步行含等待"
      })
      .expect(200);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我整体顺延后续安排。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "西湖晨间散步",
      startTime: "09:00",
      endTime: "11:00"
    });
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      title: "湖滨咖啡",
      startTime: "11:45",
      endTime: "12:45"
    });
    expect(result.body.itinerary.days[0].activities[2]).toMatchObject({
      title: "运河夜游",
      startTime: "13:15",
      endTime: "14:15"
    });
    expect(result.body.diff).toContain("已顺延后续安排：2 项，湖滨咖啡 到 11:45");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
  });

  it("streams public agent activity before returning the final agent update", async () => {
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

    const events = parseSseEvents(result.text);
    expect(events.filter((event) => event.event === "activity").length).toBeGreaterThan(0);
    expect(events.map((event) => event.event)).toContain("final");
    expect(result.text).not.toContain("event: thought");
    expect(result.text).not.toContain("event: action");
    expect(result.text).not.toContain("event: tool_call");
    expect(result.text).toContain("event: final");
    expect(result.text).toContain("已更新行程");
  });

  it("streams chat-completion tool calls, tool observations, and final replies without mock thinking", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("AGENT_MAX_TURNS", "4");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const dayId = itinerary.days[1].id;
    const chatCompletionBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      chatCompletionBodies.push(body);
      if (chatCompletionBodies.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "我先搜索并加入浙江大学。",
                  tool_calls: [
                    {
                      id: "call-place",
                      type: "function",
                      function: {
                        name: "add_place_activity",
                        arguments: JSON.stringify({
                          dayId,
                          query: "浙江大学",
                          poiName: "浙江大学",
                          type: "attraction",
                          title: "浙江大学校园漫步",
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
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "我已经根据搜索结果加入浙江大学，并完成本轮更新。"
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run-stream")
      .send({
        itineraryId: itinerary.id,
        message: "帮我把 Day 2 下午改成浙江大学。",
        importedSkillIds: []
      })
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chatCompletionBodies[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-place"
        })
      ])
    );
    expect(JSON.stringify(chatCompletionBodies[1]?.messages)).toContain("浙江大学");
    const events = parseSseEvents(result.text);
    const activityEvents = events
      .filter((event) => event.event === "activity")
      .map((event) => event.data as { type: string; title: string; detail?: string });
    const types = activityEvents.map((event) => event.type);
    const firstAssistantMessageIndex = types.indexOf("assistant_message");
    const toolCallIndex = types.indexOf("tool_call");
    const toolResultIndex = types.indexOf("tool_result");
    const finalAssistantMessageIndex = types.lastIndexOf("assistant_message");
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantMessageIndex).toBeGreaterThanOrEqual(0);
    expect(firstAssistantMessageIndex).toBeLessThan(toolCallIndex);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
    expect(finalAssistantMessageIndex).toBeGreaterThan(toolResultIndex);
    expect(types).toContain("final_signal");
    expect(types).not.toContain("thought_summary");
    expect(result.text).not.toContain("准备规划工具循环");
    expect(result.text).not.toContain("AGENT_MAX_TURNS");
    expect(result.text).not.toContain("分析用户请求");
    expect(result.text).not.toContain("分析工具结果");
    const finalSignal = activityEvents.find((event) => event.type === "final_signal");
    expect(finalSignal?.detail).not.toContain("我已经根据搜索结果加入浙江大学");
    expect(result.text).toContain("我已经根据搜索结果加入浙江大学");
    const finalEvent = events.find((event) => event.event === "final")?.data as { events?: unknown[]; diff?: string[] };
    expect(finalEvent.events?.length).toBeGreaterThanOrEqual(activityEvents.length);
    expect(finalEvent.diff).toContain("已添加地点：浙江大学");
  });

  it("emits real model reasoning when a chat-completion response includes a reasoning field", async () => {
    vi.stubEnv("AGENT_MODEL_API_KEY", "agent-model-key");
    vi.stubEnv("AGENT_MODEL_BASE_URL", "https://llm.example.test/v1");
    vi.stubEnv("AGENT_MODEL", "compatible-reasoning-model");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://llm.example.test/v1/chat/completions");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer agent-model-key"
      });
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBe("compatible-reasoning-model");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                reasoning: "我需要先判断这次请求是否要修改结构化行程。",
                content: "我先检查当前行程是否需要新增地点。"
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run-stream")
      .send({
        itineraryId: itinerary.id,
        message: "帮我看看 Day 2 下午怎么安排。",
        importedSkillIds: []
      })
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);

    const events = parseSseEvents(result.text);
    const activityEvents = events
      .filter((event) => event.event === "activity")
      .map((event) => event.data as { type: string; title: string; detail?: string });
    expect(activityEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thought_summary",
          title: "模型思考",
          detail: "我需要先判断这次请求是否要修改结构化行程。"
        })
      ])
    );
    expect(activityEvents.map((event) => event.type)).toContain("assistant_message");
    expect(result.text).not.toContain("用户想要「");
  });

  it("honors AGENT_MAX_TURNS instead of using a hard-coded model loop limit", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("AGENT_MAX_TURNS", "2");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const dayId = itinerary.days[1].id;
    let loopCallNumber = 0;
    const fetchMock = vi.fn(async () => {
      loopCallNumber += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: `继续第 ${loopCallNumber} 轮工具调用。`,
                tool_calls: [
                  {
                    id: `call-loop-${loopCallNumber}`,
                    type: "function",
                    function: {
                      name: "add_activity",
                      arguments: JSON.stringify({
                        dayId,
                        type: "free_time",
                        title: `第 ${loopCallNumber} 轮活动`,
                        startTime: "14:00",
                        endTime: "15:00"
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
        message: "持续补充活动，直到达到配置上限。"
      })
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.body.message.content).toContain("已达到配置的最大模型回合数（2）");
    expect(result.body.events.map((event: { type: string }) => event.type)).toContain("final_signal");
    expect(result.body.events.map((event: { title: string }) => event.title)).toContain("达到最大模型回合数");
  });

  it("stops a streamed agent request without persisting hidden background changes", async () => {
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const itinerary = db.listItineraries()[0]!;
    const initialDayTwoCount = itinerary.days[1]?.activities.length ?? 0;
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/run-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          itineraryId: itinerary.id,
          message: "帮我补全 Day 2 下午，节奏轻松一点。"
        }),
        signal: controller.signal
      });
      expect(response.ok).toBe(true);
      expect(response.body).toBeTruthy();

      const reader = response.body!.getReader();
      const firstChunk = await reader.read();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("activity");
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 180));

      expect(db.listSessions()).toHaveLength(0);
      expect(db.listTraces()).toHaveLength(0);
      expect(db.getItinerary(itinerary.id)?.days[1]?.activities.length ?? 0).toBe(initialDayTwoCount);
    } finally {
      controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("completes adjacent routes when DeepSeek adds a place and the user asks to connect the route", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "I added Lingyin Temple and will connect the route.",
                tool_calls: [
                  {
                    id: "call-add-lingyin",
                    type: "function",
                    function: {
                      name: "add_activity",
                      arguments: JSON.stringify({
                        dayId: day.id,
                        type: "attraction",
                        title: "Lingyin Temple visit",
                        placeName: "Lingyin Temple",
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await request(app)
      .post("/api/agent/run")
      .send({
        itineraryId: itinerary.id,
        message: "Please add Lingyin Temple to Day 1 afternoon and complete the route between adjacent stops."
      })
      .expect(200);

    const updatedDay = result.body.itinerary.days[0];
    const added = updatedDay.activities.at(-1);
    expect(added).toMatchObject({
      title: "Lingyin Temple visit",
      placeName: "Lingyin Temple",
      source: "agent",
      place: {
        coordinates: { lng: 120.1551, lat: 30.2741 }
      }
    });
    expect(updatedDay.transportLegs).toHaveLength(day.activities.length);
    expect(updatedDay.transportLegs.at(-1)).toMatchObject({
      fromActivityId: day.activities.at(-1).id,
      toActivityId: added.id,
      mode: "walking",
      provider: "mock",
      routeStatus: "estimated"
    });
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("TransportAgent");
    expect(
      result.body.diff.some((item: string) => item.includes("\u5df2\u8865\u5168\u4ea4\u901a\u8def\u7ebf") && item.includes("2"))
    ).toBe(true);
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

  it("lets DeepSeek replace an existing activity with a searched POI", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const cafeActivity = itinerary.days[0].activities[1];
    const originalActivityCounts = itinerary.days.map((day: { activities: unknown[] }) => day.activities.length);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.origin + url.pathname === "https://api.deepseek.com/chat/completions") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "已把咖啡活动替换成灵隐寺景区。",
                  tool_calls: [
                    {
                      id: "call-update-place",
                      type: "function",
                      function: {
                        name: "update_activity_place",
                        arguments: JSON.stringify({
                          activityId: cafeActivity.id,
                          query: "灵隐寺",
                          poiName: "灵隐寺飞来峰景区",
                          type: "attraction",
                          title: "灵隐寺"
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
              id: "POI-LINGYIN",
              name: "灵隐寺飞来峰景区",
              address: "浙江省杭州市西湖区灵隐路法云弄1号",
              cityname: "杭州市",
              adname: "西湖区",
              type: "风景名胜;风景名胜相关;旅游景点",
              typecode: "110000",
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
        message: "把湖滨咖啡换成灵隐寺，选正式景区，活动本身保留。"
      })
      .expect(200);

    const calledPoiKeywords = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)).searchParams.get("keywords"))
      .filter(Boolean);
    expect(calledPoiKeywords).toContain("灵隐寺");
    expect(result.body.itinerary.days.map((day: { activities: unknown[] }) => day.activities.length)).toEqual(originalActivityCounts);
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      id: cafeActivity.id,
      type: "attraction",
      title: "灵隐寺",
      placeName: "灵隐寺飞来峰景区",
      place: {
        poiId: "POI-LINGYIN",
        name: "灵隐寺飞来峰景区",
        address: "浙江省杭州市西湖区灵隐路法云弄1号",
        city: "杭州市",
        district: "西湖区",
        coordinates: { lng: 120.1011, lat: 30.2404 }
      }
    });
    expect(result.body.diff).toContain("已更新地点：灵隐寺飞来峰景区");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
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

  it("lets DeepSeek compare transport modes and save the fastest route", async () => {
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
                content: "已比较几种交通方式，并选择最快路线。",
                tool_calls: [
                  {
                    id: "call-compare-routes",
                    type: "function",
                    function: {
                      name: "compare_transport_modes",
                      arguments: JSON.stringify({
                        dayId: day.id,
                        fromActivityId: fromActivity.id,
                        toActivityId: toActivity.id,
                        modes: ["walking", "transit", "driving", "cycling"],
                        strategy: "fastest"
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
        message: "比较西湖晨间散步到湖滨咖啡的交通方式，选最快路线。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: "cycling",
      durationMinutes: 10,
      distanceMeters: expect.any(Number)
    });
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("TransportAgent");
    expect(result.body.diff).toContain("已比较交通方式：步行、公交/地铁、驾车、骑行，已选择骑行");
  });

  it("lets DeepSeek remove a specific transport leg without removing activities", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    const routed = await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking"
      })
      .expect(200);
    expect(routed.body.itinerary.days[0].transportLegs).toHaveLength(1);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "已取消这段交通，两个活动保持不变。",
                tool_calls: [
                  {
                    id: "call-remove-route",
                    type: "function",
                    function: {
                      name: "remove_transport_leg",
                      arguments: JSON.stringify({
                        dayId: day.id,
                        fromActivityId: fromActivity.id,
                        toActivityId: toActivity.id
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
        message: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities.map((activity: { title: string }) => activity.title)).toEqual([
      "西湖晨间散步",
      "湖滨咖啡"
    ]);
    expect(result.body.itinerary.days[0].transportLegs).toEqual([]);
    expect(result.body.diff).toContain("已取消交通：西湖晨间散步 到 湖滨咖啡");
    expect(result.body.diff.join(" ")).not.toContain("删除活动");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("TransportAgent");
  });

  it("lets DeepSeek adjust activity timing after a route conflict", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const list = await request(app).get("/api/itineraries").expect(200);
    const itinerary = list.body.items[0];
    const day = itinerary.days[0];
    const [fromActivity, toActivity] = day.activities;

    await request(app)
      .post(`/api/itineraries/${itinerary.id}/days/${day.id}/transport-legs`)
      .send({
        fromActivityId: fromActivity.id,
        toActivityId: toActivity.id,
        mode: "walking",
        manualOverride: true,
        durationMinutes: 45,
        distanceMeters: 1300,
        summary: "步行含等待"
      })
      .expect(200);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "这段路线会晚到，我会顺延下一项。",
                tool_calls: [
                  {
                    id: "call-adjust-time",
                    type: "function",
                    function: {
                      name: "adjust_timing_conflict",
                      arguments: JSON.stringify({
                        dayId: day.id,
                        fromActivityId: fromActivity.id,
                        toActivityId: toActivity.id,
                        strategy: "delay_next"
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
        message: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。"
      })
      .expect(200);

    expect(result.body.itinerary.days[0].activities[0]).toMatchObject({
      title: "西湖晨间散步",
      startTime: "09:00",
      endTime: "11:00"
    });
    expect(result.body.itinerary.days[0].activities[1]).toMatchObject({
      title: "湖滨咖啡",
      startTime: "11:45",
      endTime: "12:45"
    });
    expect(result.body.itinerary.days[0].transportLegs[0]).toMatchObject({
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      durationMinutes: 45
    });
    expect(result.body.diff).toContain("已顺延活动：湖滨咖啡 到 11:45");
    expect(result.body.diff.join(" ")).not.toContain("已新增活动");
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("PlannerAgent");
  });

  it("lets DeepSeek complete every missing adjacent and cross-day route through a route tool call", async () => {
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
    expect(result.body.itinerary.days[1].transportLegs).toHaveLength(2);
    expect(actualRouteCount(result.body.itinerary.days)).toBe(expectedCompleteRouteCount(result.body.itinerary.days));
    expect(result.body.traces.map((trace: { agent: string }) => trace.agent)).toContain("TransportAgent");
    expect(result.body.diff).toEqual(expect.arrayContaining(["已补全交通路线：3 段"]));
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
    expect(extracted.body.skill.displayName).toBe("海边、小店、日落风格草稿");
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
    expect(published.body.skill.versionHistory).toEqual([
      expect.objectContaining({
        version: 1,
        summary: "发布到广场",
        changedFields: expect.arrayContaining(["名称", "说明", "状态"])
      })
    ]);

    const revised = await request(app)
      .patch(`/api/skills/${extracted.body.skill.id}`)
      .send({
        rules: ["减少跨区切换", "日落前后留出完整时段"]
      })
      .expect(200);

    expect(revised.body.skill.versionHistory).toEqual([
      expect.objectContaining({ version: 1, summary: "发布到广场" }),
      expect.objectContaining({
        version: 2,
        summary: "更新规则",
        changedFields: ["规则"]
      })
    ]);

    const listed = await request(app).get("/api/skills").expect(200);
    const persisted = listed.body.items.find((skill: { id: string }) => skill.id === extracted.body.skill.id);
    expect(persisted.versionHistory).toHaveLength(2);
  });

  it("starts a Skill creator session through the project-specific Creator Agent prompt", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assistantMessage: "我先确认这套风格最该保留什么。",
                    question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                    mode: "multiple",
                    options: [
                      { id: "sunset", label: "傍晚留给散步和日落" },
                      { id: "shops", label: "优先找小店和街区" },
                      { id: "light", label: "每天最多两个核心点" }
                    ],
                    customPlaceholder: "也可以补充自己的说法",
                    progressPercent: 52,
                    draftPatch: {
                      tags: ["松弛", "小店"],
                      rules: ["傍晚时段优先保留低强度体验"]
                    },
                    done: false
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const result = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "喜欢海边散步、傍晚小店和松弛节奏。" })
      .expect(201);

    expect(result.body.session.id).toMatch(/^skill-creator-session-/);
    expect(result.body.turn.question).toBe("这套旅行风格换到新城市时，哪些体验必须保留？");
    expect(result.body.turn.progressPercent).toBe(52);
    expect(result.body.session.draft.rules).toEqual(expect.arrayContaining(["傍晚时段优先保留低强度体验"]));
    const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
    expect(body.messages[0].content).toContain("旅行风格 Skill 创作助手");
    expect(body.messages[0].content).not.toContain("Skill Creation Process");
  });

  it("records creator answers and allows Agent progress to move backward", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        const content =
          callCount === 1
            ? {
                question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                mode: "multiple",
                options: [
                  { id: "sunset", label: "傍晚留给散步和日落" },
                  { id: "shops", label: "优先找小店和街区" },
                  { id: "light", label: "每天最多两个核心点" }
                ],
                progressPercent: 70,
                draftPatch: { rules: ["每天最多两个核心点"] },
                done: false
              }
            : {
                question: "你刚才又想密集打卡，哪一种优先级更高？",
                mode: "single",
                options: [
                  { id: "relaxed", label: "保留松弛节奏" },
                  { id: "coverage", label: "优先覆盖更多景点" },
                  { id: "mixed", label: "每天只允许一个密集时段" }
                ],
                progressPercent: 55,
                draftPatch: { forbidden: ["为了打卡塞满每天行程"] },
                done: false
              };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const started = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "喜欢松弛节奏，但也想多看几个点。" })
      .expect(201);

    const reply = await request(app)
      .post(`/api/skills/creator/${started.body.session.id}/reply`)
      .send({
        selectedOptionIds: ["sunset"],
        customAnswer: "但我又有点想多打卡。"
      })
      .expect(200);

    expect(reply.body.turn.progressPercent).toBe(55);
    expect(reply.body.session.history).toHaveLength(1);
    expect(reply.body.session.draft.forbidden).toEqual(expect.arrayContaining(["为了打卡塞满每天行程"]));
  });

  it("blocks done when the Agent returns an incomplete final draft", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assistantMessage: "可以结束。",
                    progressPercent: 100,
                    draftPatch: { rules: [] },
                    done: true
                  })
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const result = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "只是喜欢慢慢逛。" })
      .expect(201);

    expect(result.body.turn.done).toBe(false);
    expect(result.body.turn.question).toBe("生成行程时，哪些安排一出现就算跑偏？");
    expect(result.body.turn.progressPercent).toBeLessThan(100);
  });

  it("repairs malformed Creator Agent JSON once before returning the turn", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "deepseek-test-key");
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        const content =
          callCount === 1
            ? "我想先问：这套风格最重要什么？"
            : JSON.stringify({
                question: "这套旅行风格换到新城市时，哪些体验必须保留？",
                mode: "multiple",
                options: [
                  { id: "sunset", label: "傍晚留给散步和日落" },
                  { id: "shops", label: "优先找小店和街区" },
                  { id: "light", label: "每天最多两个核心点" }
                ],
                progressPercent: 45,
                draftPatch: { tags: ["松弛"] },
                done: false
              });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      })
    );

    const db = createInMemoryDatabase();
    const app = createApp({ db });
    const result = await request(app)
      .post("/api/skills/creator/start")
      .send({ sourceText: "喜欢傍晚散步和小店。" })
      .expect(201);

    expect(callCount).toBe(2);
    expect(result.body.turn.question).toBe("这套旅行风格换到新城市时，哪些体验必须保留？");
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
