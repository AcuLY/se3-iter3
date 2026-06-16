import { createId, nowIso, type SavedMemory } from "@journey/shared";
import type { JourneyDatabase } from "../db.js";

type HttpError = Error & { status?: number };

export class MemoryService {
  constructor(private readonly db: JourneyDatabase) {}

  list(options: { query?: string; limit?: number } = {}): SavedMemory[] {
    const normalizedQuery = normalizeQuery(options.query);
    const limit = clampLimit(options.limit, 50);
    const items = this.db.listMemories().filter((memory) =>
      normalizedQuery ? memory.content.toLowerCase().includes(normalizedQuery) : true
    );
    return items.slice(0, limit);
  }

  get(id: string): SavedMemory {
    const memory = this.db.getMemory(id);
    if (!memory) throw httpError(404, `Saved memory not found: ${id}`);
    return memory;
  }

  create(content: string): SavedMemory {
    const normalized = normalizeContent(content);
    this.assertUnique(normalized);
    const timestamp = nowIso();
    return this.db.saveMemory({
      id: createId("memory"),
      content: normalized,
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  update(id: string, content: string): SavedMemory {
    const existing = this.get(id);
    const normalized = normalizeContent(content);
    this.assertUnique(normalized, id);
    if (existing.content === normalized) return existing;
    return this.db.saveMemory({
      ...existing,
      content: normalized,
      updatedAt: nowIso()
    });
  }

  delete(id: string): boolean {
    this.get(id);
    return this.db.deleteMemory(id);
  }

  buildSnapshotText(memories = this.list({ limit: 200 })): string {
    return memories.length ? memories.map((memory) => memory.content).join("\n") : "暂无已保存记忆";
  }

  extractKeywords(memories = this.list({ limit: 200 })): string[] {
    return unique(
      memories.flatMap((memory) =>
        memory.content
          .split(/[\s,，、；;。.!！？:/]+/)
          .map((token) => token.trim())
          .filter((token) => token.length > 1)
      )
    );
  }

  upsertMany(contents: string[]): { created: SavedMemory[] } {
    const created: SavedMemory[] = [];
    for (const content of unique(contents.map((item) => item.trim()).filter(Boolean))) {
      const normalized = normalizeContent(content);
      const duplicate = this.db.listMemories().find((memory) => memory.content === normalized);
      if (duplicate) continue;
      created.push(this.create(normalized));
    }
    return { created };
  }

  private assertUnique(content: string, ignoreId?: string) {
    const duplicate = this.db.listMemories().find((memory) => memory.id !== ignoreId && memory.content === content);
    if (duplicate) throw httpError(409, "Saved memory already exists");
  }
}

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (!normalized) throw httpError(400, "Saved memory content is required");
  return normalized;
}

function normalizeQuery(query?: string): string | undefined {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, fallback);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function httpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.status = status;
  return error;
}
