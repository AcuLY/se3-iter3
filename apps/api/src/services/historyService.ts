import type { JourneyDatabase } from "../db.js";
import type { AgentTraceEvent } from "@journey/shared";

type HistoryItinerarySummary = {
  itineraryId: string;
  title: string;
  destination: string;
  updatedAt: string;
  sessionCount: number;
  lastMessageAt?: string;
};

type ConversationSnippet = {
  sessionId: string;
  messageId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

type HistorySearchResult = {
  itinerary: {
    id: string;
    title: string;
    destination: string;
    updatedAt: string;
  };
  sessionCount: number;
  snippets: ConversationSnippet[];
};

type ConversationTimelineItem =
  | {
      type: "session";
      sessionId: string;
      createdAt: string;
      updatedAt: string;
      traces: AgentTraceEvent[];
    }
  | {
      type: "message";
      sessionId: string;
      messageId: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: string;
    };

export class HistoryService {
  constructor(private readonly db: JourneyDatabase) {}

  listItineraries(options: { query?: string; limit?: number } = {}): HistoryItinerarySummary[] {
    const normalizedQuery = normalizeQuery(options.query);
    const limit = clampLimit(options.limit, 20);
    return this.db
      .listItineraries()
      .filter((itinerary) => {
        if (!normalizedQuery) return true;
        const haystack = `${itinerary.title} ${itinerary.destination}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .map((itinerary) => {
        const sessions = this.db.listSessions().filter((session) => session.itineraryId === itinerary.id);
        return {
          itineraryId: itinerary.id,
          title: itinerary.title,
          destination: itinerary.destination,
          updatedAt: itinerary.updatedAt,
          sessionCount: sessions.length,
          lastMessageAt: sessions.flatMap((session) => session.messages).at(-1)?.createdAt
        };
      })
      .slice(0, limit);
  }

  searchConversations(options: { keyword: string; itineraryQuery?: string; limit?: number }): HistorySearchResult[] {
    const keyword = normalizeRequiredQuery(options.keyword, "keyword is required");
    const itineraryQuery = normalizeQuery(options.itineraryQuery);
    const limit = clampLimit(options.limit, 10);

    return this.db
      .listItineraries()
      .filter((itinerary) => {
        if (!itineraryQuery) return true;
        const haystack = `${itinerary.title} ${itinerary.destination}`.toLowerCase();
        return haystack.includes(itineraryQuery);
      })
      .map((itinerary) => {
        const sessions = this.db.listSessions().filter((session) => session.itineraryId === itinerary.id);
        const snippets = sessions.flatMap((session) =>
          session.messages
            .filter((message) => message.content.toLowerCase().includes(keyword))
            .slice(0, 3)
            .map((message) => ({
              sessionId: session.id,
              messageId: message.id,
              role: message.role,
              content: message.content,
              createdAt: message.createdAt
            }))
        );
        return snippets.length > 0
          ? {
              itinerary: {
                id: itinerary.id,
                title: itinerary.title,
                destination: itinerary.destination,
                updatedAt: itinerary.updatedAt
              },
              sessionCount: sessions.length,
              snippets
            }
          : undefined;
      })
      .filter((item): item is HistorySearchResult => Boolean(item))
      .slice(0, limit);
  }

  loadConversation(itineraryId: string): {
    itinerary: { id: string; title: string; destination: string; updatedAt: string };
    items: ConversationTimelineItem[];
  } {
    const itinerary = this.db.getItinerary(itineraryId);
    if (!itinerary) {
      const error = new Error(`Itinerary not found: ${itineraryId}`) as Error & { status?: number };
      error.status = 404;
      throw error;
    }
    const sessions = this.db
      .listSessions()
      .filter((session) => session.itineraryId === itineraryId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

    const items: ConversationTimelineItem[] = [];
    for (const session of sessions) {
      items.push({
        type: "session",
        sessionId: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        traces: session.traces
      });
      for (const message of session.messages) {
        items.push({
          type: "message",
          sessionId: session.id,
          messageId: message.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt
        });
      }
    }

    return {
      itinerary: {
        id: itinerary.id,
        title: itinerary.title,
        destination: itinerary.destination,
        updatedAt: itinerary.updatedAt
      },
      items
    };
  }
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, fallback);
}

function normalizeQuery(query?: string): string | undefined {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function normalizeRequiredQuery(query: string | undefined, message: string): string {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    const error = new Error(message) as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return normalized;
}
