import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSeedItinerary, createSeedSkills, evaluationDataset } from "@journey/shared";
import type { AgentSession, AgentTraceEvent, EvaluationCase, TravelItinerary, TravelSkill } from "@journey/shared";

type TableName = "itineraries" | "skills" | "sessions" | "traces" | "evaluation_cases";

export class JourneyDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(resolve(filename)), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    this.initialize();
  }

  listItineraries(): TravelItinerary[] {
    return this.listJson<TravelItinerary>("itineraries");
  }

  getItinerary(id: string): TravelItinerary | undefined {
    return this.getJson<TravelItinerary>("itineraries", id);
  }

  saveItinerary(itinerary: TravelItinerary): TravelItinerary {
    this.saveJson("itineraries", itinerary.id, itinerary);
    return itinerary;
  }

  listSkills(): TravelSkill[] {
    return this.listJson<TravelSkill>("skills");
  }

  getSkill(id: string): TravelSkill | undefined {
    return this.getJson<TravelSkill>("skills", id);
  }

  saveSkill(skill: TravelSkill): TravelSkill {
    this.saveJson("skills", skill.id, skill);
    return skill;
  }

  deleteSkill(id: string): void {
    this.deleteJson("skills", id);
  }

  listSessions(): AgentSession[] {
    return this.listJson<AgentSession>("sessions");
  }

  getSession(id: string): AgentSession | undefined {
    return this.getJson<AgentSession>("sessions", id);
  }

  saveSession(session: AgentSession): AgentSession {
    this.saveJson("sessions", session.id, session);
    return session;
  }

  listTraces(sessionId?: string): AgentTraceEvent[] {
    const traces = this.listJson<AgentTraceEvent>("traces");
    return sessionId ? traces.filter((trace) => trace.sessionId === sessionId) : traces;
  }

  saveTrace(trace: AgentTraceEvent): AgentTraceEvent {
    this.saveJson("traces", trace.id, trace);
    return trace;
  }

  listEvaluationCases(): EvaluationCase[] {
    return this.listJson<EvaluationCase>("evaluation_cases");
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS itineraries (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluation_cases (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.seedIfEmpty();
  }

  private seedIfEmpty(): void {
    if (this.count("itineraries") === 0) {
      this.saveItinerary(createSeedItinerary());
    }
    for (const skill of createSeedSkills()) {
      if (!this.getSkill(skill.id)) {
        this.saveSkill(skill);
      }
    }
    for (const evaluationCase of evaluationDataset) {
      this.saveJson("evaluation_cases", evaluationCase.id, evaluationCase);
    }
  }

  private count(table: TableName): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  private listJson<T>(table: TableName): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${table} ORDER BY updated_at DESC`).all() as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as T);
  }

  private getJson<T>(table: TableName, id: string): T | undefined {
    const row = this.db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  private saveJson<T>(table: TableName, id: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (id, json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
      )
      .run(id, JSON.stringify(value), new Date().toISOString());
  }

  private deleteJson(table: TableName, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }
}

export function createInMemoryDatabase(): JourneyDatabase {
  return new JourneyDatabase(":memory:");
}

export function createFileDatabase(filename = process.env.DATABASE_PATH ?? "./data/journey.sqlite"): JourneyDatabase {
  return new JourneyDatabase(filename);
}
