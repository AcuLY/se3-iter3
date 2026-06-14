import {
  addActivity,
  addDay,
  createDraftItinerary,
  exportItineraryMarkdown,
  findActivity,
  moveActivity,
  nowIso,
  removeActivity,
  reorderActivity,
  resizeItineraryDateRange,
  setDayWeather,
  setTransportLeg,
  updateActivity,
  type ActivityDraft,
  type Activity,
  type CreateItineraryInput,
  type TransportLegDraft,
  type TravelItinerary,
  type WeatherSummary
} from "@journey/shared";
import type { JourneyDatabase } from "../db.js";

export class ItineraryService {
  constructor(private readonly db: JourneyDatabase) {}

  list(): TravelItinerary[] {
    return this.db.listItineraries();
  }

  get(id: string): TravelItinerary {
    const itinerary = this.db.getItinerary(id);
    if (!itinerary) throw new Error(`Itinerary not found: ${id}`);
    return itinerary;
  }

  create(input: CreateItineraryInput): TravelItinerary {
    const itinerary = createDraftItinerary(input);
    return this.db.saveItinerary(itinerary);
  }

  update(
    itineraryId: string,
    changes: Partial<Pick<TravelItinerary, "title" | "destination" | "startDate" | "endDate" | "budgetCny" | "notes" | "preferences" | "companions">>
  ): TravelItinerary {
    const itinerary = this.get(itineraryId);
    const cleaned = cleanItineraryChanges(changes);
    const dateAdjusted =
      cleaned.startDate !== undefined || cleaned.endDate !== undefined
        ? resizeItineraryDateRange(
            itinerary,
            cleaned.startDate ?? itinerary.startDate,
            cleaned.endDate ?? itinerary.endDate ?? cleaned.startDate ?? itinerary.startDate
          )
        : itinerary;
    return this.db.saveItinerary({
      ...dateAdjusted,
      ...cleaned,
      startDate: dateAdjusted.startDate,
      endDate: dateAdjusted.endDate,
      days: dateAdjusted.days,
      updatedAt: nowIso()
    });
  }

  addActivity(itineraryId: string, dayId: string, activity: ActivityDraft, source: Activity["source"] = "manual"): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(addActivity(itinerary, dayId, activity, source));
  }

  addDay(itineraryId: string, title?: string): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(addDay(itinerary, title));
  }

  updateActivity(itineraryId: string, activityId: string, changes: Partial<Activity>): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(updateActivity(itinerary, activityId, changes));
  }

  removeActivity(itineraryId: string, activityId: string): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(removeActivity(itinerary, activityId));
  }

  reorderActivity(itineraryId: string, dayId: string, activityId: string, targetIndex: number): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(reorderActivity(itinerary, dayId, activityId, targetIndex));
  }

  moveActivity(itineraryId: string, activityId: string, targetDayId: string, targetIndex: number): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(moveActivity(itinerary, activityId, targetDayId, targetIndex));
  }

  setTransportLeg(itineraryId: string, dayId: string, leg: TransportLegDraft): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(setTransportLeg(itinerary, dayId, leg));
  }

  setDayWeather(itineraryId: string, dayId: string, weather: WeatherSummary, source: Activity["source"] = "manual"): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(setDayWeather(itinerary, dayId, weather, source));
  }

  findActivity(itineraryId: string, activityId: string) {
    return findActivity(this.get(itineraryId), activityId);
  }

  exportMarkdown(itineraryId: string): string {
    return exportItineraryMarkdown(this.get(itineraryId));
  }

  importSkill(itineraryId: string, skillId: string): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary({
      ...itinerary,
      importedSkillIds: [...new Set([...itinerary.importedSkillIds, skillId])],
      updatedAt: nowIso()
    });
  }

  removeImportedSkill(itineraryId: string, skillId: string): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary({
      ...itinerary,
      importedSkillIds: itinerary.importedSkillIds.filter((id) => id !== skillId),
      updatedAt: nowIso()
    });
  }

  save(itinerary: TravelItinerary): TravelItinerary {
    return this.db.saveItinerary({
      ...itinerary,
      updatedAt: nowIso()
    });
  }
}

function cleanItineraryChanges(
  changes: Partial<Pick<TravelItinerary, "title" | "destination" | "startDate" | "endDate" | "budgetCny" | "notes" | "preferences" | "companions">>
): Partial<Pick<TravelItinerary, "title" | "destination" | "startDate" | "endDate" | "budgetCny" | "notes" | "preferences" | "companions">> {
  const cleaned: Partial<Pick<TravelItinerary, "title" | "destination" | "startDate" | "endDate" | "budgetCny" | "notes" | "preferences" | "companions">> = {};
  if (typeof changes.title === "string") cleaned.title = changes.title.trim();
  if (typeof changes.destination === "string") cleaned.destination = changes.destination.trim();
  if (typeof changes.startDate === "string") cleaned.startDate = changes.startDate;
  if (typeof changes.endDate === "string") cleaned.endDate = changes.endDate;
  if (typeof changes.budgetCny === "number") cleaned.budgetCny = changes.budgetCny;
  if (typeof changes.notes === "string") cleaned.notes = changes.notes.trim();
  if (Array.isArray(changes.preferences)) cleaned.preferences = cleanList(changes.preferences);
  if (Array.isArray(changes.companions)) cleaned.companions = cleanList(changes.companions);
  return cleaned;
}

function cleanList(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
