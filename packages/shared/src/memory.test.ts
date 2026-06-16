import { describe, expect, it } from "vitest";
import { createSeedItinerary } from "./fixtures";
import { createDraftItinerary } from "./itinerary";
import { SavedMemorySchema } from "./types";

describe("saved memory contract", () => {
  it("parses flat saved memory records", () => {
    const memory = SavedMemorySchema.parse({
      id: "memory-1",
      content: "避免太赶",
      createdAt: "2026-06-16T08:00:00.000Z",
      updatedAt: "2026-06-16T08:00:00.000Z"
    });

    expect(memory).toMatchObject({
      id: "memory-1",
      content: "避免太赶"
    });
  });

  it("keeps itinerary preferences on draft and seeded itineraries", () => {
    const draft = createDraftItinerary({
      title: "杭州三日松弛游",
      destination: "杭州",
      startDate: "2026-07-01",
      dayCount: 3,
      companions: ["朋友"],
      preferences: ["慢节奏"]
    });
    const seeded = createSeedItinerary();

    expect(draft.preferences).toEqual(["慢节奏"]);
    expect(seeded.preferences).toEqual(["慢节奏", "咖啡", "citywalk"]);
  });
});
