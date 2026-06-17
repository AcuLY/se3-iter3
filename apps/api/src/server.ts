import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JourneyDatabase } from "./db.js";
import { createFileDatabase } from "./db.js";
import { AgentRunAbortedError, AgentService } from "./services/agentService.js";
import { HistoryService } from "./services/historyService.js";
import { ItineraryService } from "./services/itineraryService.js";
import { MapService } from "./services/mapService.js";
import { MemoryService } from "./services/memoryService.js";
import { SkillCreatorAgentService } from "./services/skillCreatorAgentService.js";
import { SkillService } from "./services/skillService.js";
import {
  TravelItinerarySchema,
  type Activity,
  type AgentRunEvent,
  type ItineraryDay,
  type RouteStep,
  type TravelItinerary
} from "@journey/shared";

export type CreateAppOptions = {
  db?: JourneyDatabase;
};

export function createApp(options: CreateAppOptions = {}): Express {
  const db = options.db ?? createFileDatabase();
  const itineraries = new ItineraryService(db);
  const skills = new SkillService(db);
  const skillCreatorAgents = new SkillCreatorAgentService(db);
  const agents = new AgentService(db);
  const maps = new MapService();
  const memories = new MemoryService(db);
  const history = new HistoryService(db);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "travel-skill-agent-workbench" });
  });

  app.get("/api/itineraries", (req, res) => {
    res.json({ items: itineraries.list({ includeArchived: asString(req.query.includeArchived) === "true" }) });
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

  app.post("/api/itineraries/:id/archive", (req, res) => {
    res.json({ itinerary: itineraries.archive(req.params.id) });
  });

  app.delete("/api/itineraries/:id", (req, res) => {
    res.json({ deleted: itineraries.delete(req.params.id) });
  });

  app.post("/api/itineraries/:id/restore", (req, res) => {
    const snapshot = TravelItinerarySchema.parse(req.body?.itinerary);
    if (snapshot.id !== req.params.id) {
      throw new Error("Restored itinerary id must match route id");
    }
    res.json({ itinerary: itineraries.save(snapshot) });
  });

  app.post("/api/itineraries/:id/days/:dayId/activities", (req, res) => {
    const itinerary = itineraries.addActivity(req.params.id, req.params.dayId, req.body);
    res.status(201).json({ itinerary });
  });

  app.post("/api/itineraries/:id/days", (req, res) => {
    const position = req.body?.position === "before" ? "before" : "after";
    const itinerary = itineraries.addDay(req.params.id, asString(req.body?.title), position);
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
      summary,
      note,
      manualOverride,
      polyline: route.polyline ?? [],
      steps: localizeRouteSteps(route.steps ?? [])
    });
    res.json({ itinerary, route });
  });

  app.delete("/api/itineraries/:id/days/:dayId/transport-legs/:fromActivityId/:toActivityId", (req, res) => {
    const itinerary = itineraries.removeTransportLeg(
      req.params.id,
      req.params.dayId,
      req.params.fromActivityId,
      req.params.toActivityId
    );
    res.json({ itinerary });
  });

  app.post("/api/itineraries/:id/transport-legs/complete", async (req, res) => {
    const mode = req.body.mode ?? "walking";
    let itinerary = itineraries.get(req.params.id);
    let completed = 0;
    let skipped = 0;
    for (const day of itinerary.days) {
      for (const pair of getRoutePairsForDay(itinerary, day)) {
        if (!pair.routable) {
          skipped += 1;
          continue;
        }
        if (pair.exists) {
          skipped += 1;
          continue;
        }
        const route = await maps.route(routePoint(pair.fromActivity)!, routePoint(pair.toActivity)!, mode);
        itinerary = itineraries.setTransportLeg(itinerary.id, day.id, {
          fromActivityId: pair.fromActivity.id,
          toActivityId: pair.toActivity.id,
          mode: route.mode,
          distanceMeters: route.distanceMeters,
          durationMinutes: route.durationMinutes,
          provider: route.source,
          routeStatus: route.status,
          summary: route.summary,
          polyline: route.polyline ?? [],
          steps: localizeRouteSteps(route.steps ?? [])
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

  app.get("/api/memories", (req, res) => {
    res.json({
      items: memories.list({
        query: asString(req.query.query),
        limit: readOptionalPositiveInt(req.query.limit)
      })
    });
  });

  app.post("/api/memories", (req, res) => {
    res.status(201).json({ memory: memories.create(asString(req.body?.content) ?? "") });
  });

  app.patch("/api/memories/:id", (req, res) => {
    res.json({ memory: memories.update(req.params.id, asString(req.body?.content) ?? "") });
  });

  app.delete("/api/memories/:id", (req, res) => {
    res.json({ deleted: memories.delete(req.params.id) });
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

  app.post("/api/skills/creator/start", async (req, res) => {
    const itinerary =
      typeof req.body.itineraryId === "string" && req.body.itineraryId
        ? itineraries.get(req.body.itineraryId)
        : undefined;
    const result = await skillCreatorAgents.start({
      sourceText: asString(req.body.sourceText) ?? "",
      itinerary
    });
    res.status(201).json(result);
  });

  app.post("/api/skills/creator/:sessionId/reply", async (req, res) => {
    const result = await skillCreatorAgents.reply({
      sessionId: req.params.sessionId,
      answer: {
        selectedOptionIds: Array.isArray(req.body.selectedOptionIds) ? req.body.selectedOptionIds : [],
        customAnswer: asString(req.body.customAnswer) ?? ""
      }
    });
    res.json(result);
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
    const controller = new AbortController();
    req.on("aborted", () => {
      closed = true;
      controller.abort();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        closed = true;
        controller.abort();
      }
    });

    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const streamedActivities: AgentRunEvent[] = [];
      const result = await agents.run(
        { ...req.body, signal: controller.signal },
        {
          onEvent: (activity) => {
            streamedActivities.push(activity);
            send("activity", activity);
          }
        }
      );
      if (controller.signal.aborted) return;
      send("final", { ...result, events: result.events.length > 0 ? result.events : streamedActivities });
    } catch (error) {
      if (controller.signal.aborted || error instanceof AgentRunAbortedError) return;
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

  app.get("/api/agent/history/itineraries", (req, res) => {
    res.json({
      items: history.listItineraries({
        query: asString(req.query.query),
        limit: readOptionalPositiveInt(req.query.limit)
      })
    });
  });

  app.get("/api/agent/history/conversations/search", (req, res) => {
    res.json({
      items: history.searchConversations({
        keyword: asString(req.query.keyword) ?? "",
        itineraryQuery: asString(req.query.itineraryQuery),
        limit: readOptionalPositiveInt(req.query.limit)
      })
    });
  });

  app.get("/api/agent/history/conversations/:itineraryId", (req, res) => {
    res.json(history.loadConversation(req.params.itineraryId));
  });

  app.delete("/api/agent/sessions", (req, res) => {
    const itineraryId = asString(req.query.itineraryId);
    if (!itineraryId) throw new Error("itineraryId is required");
    res.json({ deleted: db.deleteSessionsForItinerary(itineraryId) });
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


  app.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
    const message = error instanceof Error ? error.message : "Unknown server error";
    const status =
      typeof error === "object" && error && "status" in error && typeof (error as { status?: unknown }).status === "number"
        ? Number((error as { status?: unknown }).status)
        : message.includes("not found") || message.includes("not found")
          ? 404
          : 400;
    const validation =
      typeof error === "object" && error && "validation" in error
        ? (error as { validation?: unknown }).validation
        : undefined;
    res.status(status).json(validation ? { error: message, validation } : { error: message });
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

function readOptionalPositiveInt(value: unknown): number | undefined {
  const raw = typeof value === "string" ? Number(value) : typeof value === "number" ? value : undefined;
  if (raw === undefined || !Number.isInteger(raw) || raw <= 0) return undefined;
  return raw;
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

function getRoutePairsForDay(
  itinerary: TravelItinerary,
  day: ItineraryDay
): Array<{ fromActivity: Activity; toActivity: Activity; exists: boolean; routable: boolean }> {
  const pairs: Array<{ fromActivity: Activity; toActivity: Activity; exists: boolean; routable: boolean }> = [];
  const dayIndex = itinerary.days.findIndex((candidate) => candidate.id === day.id);
  const previousDay = dayIndex > 0 ? itinerary.days[dayIndex - 1] : undefined;
  const overnightStart = previousDay?.activities.at(-1);
  const firstActivity = day.activities[0];
  if (overnightStart && firstActivity) {
    pairs.push({
      fromActivity: overnightStart,
      toActivity: firstActivity,
      exists: hasTransportLeg(day, overnightStart.id, firstActivity.id),
      routable: canRouteActivityPair(overnightStart, firstActivity)
    });
  }
  day.activities.forEach((activity, index) => {
    const next = day.activities[index + 1];
    if (!next) return;
    pairs.push({
      fromActivity: activity,
      toActivity: next,
      exists: hasTransportLeg(day, activity.id, next.id),
      routable: canRouteActivityPair(activity, next)
    });
  });
  return pairs;
}

function hasTransportLeg(day: ItineraryDay, fromActivityId: string, toActivityId: string): boolean {
  return (day.transportLegs ?? []).some((leg) => leg.fromActivityId === fromActivityId && leg.toActivityId === toActivityId);
}

function canRouteActivityPair(from: Activity, to: Activity): boolean {
  return Boolean(routePoint(from) && routePoint(to));
}

function activityDisplayName(activity: Activity): string {
  return activity.title.trim() || activity.placeName?.trim() || activity.place?.name?.trim() || "未命名活动";
}

function localizeRouteSteps(steps: RouteStep[]): RouteStep[] {
  return steps.map((step) => ({ ...step, polyline: step.polyline ?? [] }));
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
