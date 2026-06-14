import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JourneyDatabase } from "./db.js";
import { createFileDatabase } from "./db.js";
import { AgentService } from "./services/agentService.js";
import { EvaluationService } from "./services/evaluationService.js";
import { ItineraryService } from "./services/itineraryService.js";
import { MapService } from "./services/mapService.js";
import { SkillService } from "./services/skillService.js";
import type { Activity, MapRouteMode, RouteStep } from "@journey/shared";

export type CreateAppOptions = {
  db?: JourneyDatabase;
};

export function createApp(options: CreateAppOptions = {}): Express {
  const db = options.db ?? createFileDatabase();
  const itineraries = new ItineraryService(db);
  const skills = new SkillService(db);
  const agents = new AgentService(db);
  const maps = new MapService();
  const evaluation = new EvaluationService(db);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "travel-skill-agent-workbench" });
  });

  app.get("/api/itineraries", (_req, res) => {
    res.json({ items: itineraries.list() });
  });

  app.get("/api/itineraries/:id", (req, res) => {
    res.json({ itinerary: itineraries.get(req.params.id) });
  });

  app.post("/api/itineraries", (req, res) => {
    const itinerary = itineraries.create(req.body);
    res.status(201).json({ itinerary });
  });

  app.patch("/api/itineraries/:id", (req, res) => {
    res.json({ itinerary: itineraries.update(req.params.id, req.body) });
  });

  app.post("/api/itineraries/:id/days/:dayId/activities", (req, res) => {
    const itinerary = itineraries.addActivity(req.params.id, req.params.dayId, req.body);
    res.status(201).json({ itinerary });
  });

  app.post("/api/itineraries/:id/days", (req, res) => {
    const itinerary = itineraries.addDay(req.params.id, asString(req.body?.title));
    res.status(201).json({ itinerary });
  });

  app.patch("/api/itineraries/:id/activities/:activityId", (req, res) => {
    const itinerary = itineraries.updateActivity(req.params.id, req.params.activityId, req.body);
    res.json({ itinerary });
  });

  app.post("/api/itineraries/:id/days/:dayId/activities/:activityId/reorder", (req, res) => {
    const targetIndex = Number(req.body?.targetIndex ?? 0);
    const itinerary = itineraries.reorderActivity(req.params.id, req.params.dayId, req.params.activityId, targetIndex);
    res.json({ itinerary });
  });

  app.post("/api/itineraries/:id/activities/:activityId/move", (req, res) => {
    const targetDayId = asString(req.body?.targetDayId);
    if (!targetDayId) throw new Error("targetDayId is required");
    const targetIndex = Number(req.body?.targetIndex ?? 0);
    const itinerary = itineraries.moveActivity(req.params.id, req.params.activityId, targetDayId, targetIndex);
    res.json({ itinerary });
  });

  app.delete("/api/itineraries/:id/activities/:activityId", (req, res) => {
    const itinerary = itineraries.removeActivity(req.params.id, req.params.activityId);
    res.json({ itinerary });
  });

  app.post("/api/itineraries/:id/days/:dayId/transport-legs", async (req, res) => {
    const fromActivity = itineraries.findActivity(req.params.id, req.body.fromActivityId);
    const toActivity = itineraries.findActivity(req.params.id, req.body.toActivityId);
    if (!fromActivity || !toActivity) throw new Error("Transport leg activity not found");
    if (!canRouteActivityPair(fromActivity, toActivity)) throw new Error("Transport leg requires named start and end locations");
    const mode = req.body.mode ?? "walking";
    const route = await maps.route(routePoint(fromActivity)!, routePoint(toActivity)!, mode);
    const manualOverride = Boolean(req.body.manualOverride);
    const distanceMeters = readOptionalNonNegativeNumber(req.body.distanceMeters) ?? route.distanceMeters;
    const durationMinutes = readOptionalNonNegativeNumber(req.body.durationMinutes) ?? route.durationMinutes;
    const costCny = readOptionalNonNegativeNumber(req.body.costCny);
    const summary = asString(req.body.summary) ?? route.summary;
    const note = asString(req.body.note);
    const itinerary = itineraries.setTransportLeg(req.params.id, req.params.dayId, {
      fromActivityId: fromActivity.id,
      toActivityId: toActivity.id,
      mode: route.mode,
      distanceMeters,
      durationMinutes,
      costCny,
      provider: manualOverride ? "manual" : route.source,
      routeStatus: manualOverride ? "manual" : route.status,
      failureReason: route.fallbackReason,
      summary,
      note,
      manualOverride,
      polyline: route.polyline ?? [],
      steps: localizeRouteSteps(route.steps ?? [], route.source, route.mode, activityDisplayName(toActivity))
    });
    res.json({ itinerary, route });
  });

  app.post("/api/itineraries/:id/transport-legs/complete", async (req, res) => {
    const mode = req.body.mode ?? "walking";
    let itinerary = itineraries.get(req.params.id);
    let completed = 0;
    let skipped = 0;
    for (const day of itinerary.days) {
      for (let index = 0; index < day.activities.length - 1; index += 1) {
        const fromActivity = day.activities[index];
        const toActivity = day.activities[index + 1];
        if (!fromActivity || !toActivity) continue;
        const existing = (day.transportLegs ?? []).some(
          (leg) => leg.fromActivityId === fromActivity.id && leg.toActivityId === toActivity.id
        );
        if (existing) {
          skipped += 1;
          continue;
        }
        if (!canRouteActivityPair(fromActivity, toActivity)) {
          skipped += 1;
          continue;
        }
        const route = await maps.route(routePoint(fromActivity)!, routePoint(toActivity)!, mode);
        itinerary = itineraries.setTransportLeg(itinerary.id, day.id, {
          fromActivityId: fromActivity.id,
          toActivityId: toActivity.id,
          mode: route.mode,
          distanceMeters: route.distanceMeters,
          durationMinutes: route.durationMinutes,
          provider: route.source,
          routeStatus: route.status,
          failureReason: route.fallbackReason,
          summary: route.summary,
          polyline: route.polyline ?? [],
          steps: localizeRouteSteps(route.steps ?? [], route.source, route.mode, activityDisplayName(toActivity))
        });
        completed += 1;
      }
    }
    res.json({ itinerary, completed, skipped });
  });

  app.post("/api/itineraries/:id/days/:dayId/weather", async (req, res) => {
    const itinerary = itineraries.get(req.params.id);
    const day = itinerary.days.find((candidate) => candidate.id === req.params.dayId);
    if (!day) throw new Error(`Day not found: ${req.params.dayId}`);
    const weather = await maps.weather(asString(req.body?.city) ?? itinerary.destination, day.date);
    const saved = itineraries.setDayWeather(req.params.id, req.params.dayId, weather);
    res.json({ itinerary: saved, weather });
  });

  app.get("/api/itineraries/:id/export", (req, res) => {
    res.type("text/markdown").send(itineraries.exportMarkdown(req.params.id));
  });

  app.post("/api/itineraries/:id/skills/:skillId", (req, res) => {
    const skill = skills.recordImport(req.params.skillId);
    const itinerary = itineraries.importSkill(req.params.id, req.params.skillId);
    res.json({ itinerary, skill });
  });

  app.delete("/api/itineraries/:id/skills/:skillId", (req, res) => {
    const itinerary = itineraries.removeImportedSkill(req.params.id, req.params.skillId);
    res.json({ itinerary });
  });

  app.get("/api/skills", (req, res) => {
    res.json({ items: skills.list({ favoriteOnly: asString(req.query.favorite) === "true" }) });
  });

  app.get("/api/skills/recommendations", (req, res) => {
    res.json({
      items: skills.recommend({
        destination: asString(req.query.destination),
        companions: splitList(req.query.companions),
        preferences: splitList(req.query.preferences),
        currentText: asString(req.query.currentText),
        importedSkillIds: splitList(req.query.importedSkillIds)
      })
    });
  });

  app.post("/api/skills/import", (req, res) => {
    res.status(201).json({ skill: skills.importMarkdown(req.body.markdown) });
  });

  app.post("/api/skills/extract", (req, res) => {
    const itinerary =
      typeof req.body.itineraryId === "string" && req.body.itineraryId
        ? itineraries.get(req.body.itineraryId)
        : undefined;
    res.status(201).json({ skill: skills.extract(req.body.sourceText, itinerary) });
  });

  app.post("/api/skills/:id/publish", (req, res) => {
    res.json({ skill: skills.publish(req.params.id, req.body) });
  });

  app.patch("/api/skills/:id", (req, res) => {
    res.json({ skill: skills.update(req.params.id, req.body) });
  });

  app.post("/api/skills/:id/unpublish", (req, res) => {
    res.json({ skill: skills.unpublish(req.params.id) });
  });

  app.post("/api/skills/:id/favorite", (req, res) => {
    res.json({ skill: skills.favorite(req.params.id, req.body?.favorited !== false) });
  });

  app.delete("/api/skills/:id", (req, res) => {
    skills.delete(req.params.id);
    res.status(204).end();
  });

  app.post("/api/agent/run", async (req, res) => {
    res.json(await agents.run(req.body));
  });

  app.post("/api/agent/run-stream", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    let closed = false;
    req.on("aborted", () => {
      closed = true;
    });

    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for (const message of [
        "正在理解你的需求",
        "正在匹配旅行风格",
        "正在检查地点和路线",
        "正在更新行程"
      ]) {
        send("progress", { message });
      }
      const result = await agents.run(req.body);
      send("final", result);
    } catch (error) {
      send("error", { message: error instanceof Error ? error.message : "助手暂时无法完成这次规划" });
    } finally {
      if (!closed && !res.writableEnded) res.end();
    }
  });

  app.get("/api/agent/traces", (req, res) => {
    res.json({ items: db.listTraces(asString(req.query.sessionId)) });
  });

  app.get("/api/agent/sessions", (req, res) => {
    const itineraryId = asString(req.query.itineraryId);
    const items = itineraryId
      ? db.listSessions().filter((session) => session.itineraryId === itineraryId)
      : db.listSessions();
    res.json({ items });
  });

  app.get("/api/maps/poi", async (req, res) => {
    res.json({
      items: await maps.searchPoi(asString(req.query.keywords) ?? "", asString(req.query.city) ?? "杭州")
    });
  });

  app.post("/api/maps/route", async (req, res) => {
    res.json({ route: await maps.route(req.body.from, req.body.to, req.body.mode) });
  });

  app.get("/api/maps/weather", async (req, res) => {
    res.json({
      weather: await maps.weather(asString(req.query.city) ?? "杭州", asString(req.query.date) ?? new Date().toISOString().slice(0, 10))
    });
  });

  app.get("/api/evaluation/cases", (_req, res) => {
    res.json({ items: evaluation.listCases() });
  });

  app.get("/api/evaluation/summary", (_req, res) => {
    res.json(evaluation.summary());
  });

  app.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
    const message = error instanceof Error ? error.message : "Unknown server error";
    const status = message.includes("not found") || message.includes("not found") ? 404 : 400;
    res.status(status).json({ error: message });
  });

  return app;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function readOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function splitList(value: unknown): string[] {
  const raw = asString(value);
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function routePoint(activity: Activity): string | undefined {
  if (activity.place?.coordinates) {
    return `${activity.place.coordinates.lng},${activity.place.coordinates.lat}`;
  }
  return activity.placeName?.trim() || activity.place?.name?.trim() || activity.title.trim() || undefined;
}

function canRouteActivityPair(from: Activity, to: Activity): boolean {
  return Boolean(routePoint(from) && routePoint(to));
}

function activityDisplayName(activity: Activity): string {
  return activity.title.trim() || activity.placeName?.trim() || activity.place?.name?.trim() || "未命名活动";
}

function localizeRouteSteps(
  steps: RouteStep[],
  source: "amap" | "mock",
  mode: MapRouteMode,
  toTitle: string
): RouteStep[] {
  const normalized = steps.map((step) => ({ ...step, polyline: step.polyline ?? [] }));
  if (source !== "mock" || normalized.length !== 1) return normalized;
  return [
    {
      ...normalized[0]!,
      instruction: `${routeActionLabel(mode)}前往${toTitle}`
    }
  ];
}

function routeActionLabel(mode: MapRouteMode): string {
  const labels: Record<MapRouteMode, string> = {
    walking: "步行",
    transit: "公交/地铁",
    driving: "驾车",
    cycling: "骑行"
  };
  return labels[mode];
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (entry) {
  loadLocalEnv();
  const port = Number(process.env.API_PORT ?? 4317);
  createApp().listen(port, () => {
    console.log(`Travel Skill Agent API listening on http://localhost:${port}`);
  });
}

function loadLocalEnv(): void {
  for (const filename of [".env", ".env.local", "../../.env", "../../.env.local"]) {
    const path = resolve(process.cwd(), filename);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    const name = key?.trim();
    if (name && !process.env[name]) {
      process.env[name] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}
}
