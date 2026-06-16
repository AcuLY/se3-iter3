import {
  addActivity,
  addDay,
  addDayBefore,
  createDraftItinerary,
  exportItineraryMarkdown,
  findActivity,
  moveActivity,
  nowIso,
  removeActivity,
  removeTransportLeg,
  reorderActivity,
  resizeItineraryDateRange,
  setDayWeather,
  setTransportLeg,
  updateActivity,
  PlaceSchema,
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

  list(options: { includeArchived?: boolean } = {}): TravelItinerary[] {
    const items = this.db.listItineraries();
    return options.includeArchived ? items : items.filter((itinerary) => !itinerary.archivedAt);
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

  update(itineraryId: string, changes: ItineraryDetailChanges): TravelItinerary {
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

  archive(itineraryId: string): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary({
      ...itinerary,
      archivedAt: itinerary.archivedAt ?? nowIso(),
      updatedAt: nowIso()
    });
  }

  delete(itineraryId: string): boolean {
    this.get(itineraryId);
    this.db.deleteSessionsForItinerary(itineraryId);
    return this.db.deleteItinerary(itineraryId);
  }

  addActivity(itineraryId: string, dayId: string, activity: ActivityDraft, source: Activity["source"] = "manual"): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(addActivity(itinerary, dayId, activity, source));
  }

  addDay(itineraryId: string, title?: string, position: "after" | "before" = "after"): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(position === "before" ? addDayBefore(itinerary, title) : addDay(itinerary, title));
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

  removeTransportLeg(
    itineraryId: string,
    dayId: string,
    fromActivityId: string,
    toActivityId: string,
    source: Activity["source"] = "manual"
  ): TravelItinerary {
    const itinerary = this.get(itineraryId);
    return this.db.saveItinerary(removeTransportLeg(itinerary, dayId, fromActivityId, toActivityId, source));
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

type ItineraryDetailChanges = Partial<
  Pick<
    TravelItinerary,
    "title" | "destination" | "destinationPlace" | "startDate" | "endDate" | "budgetCny" | "notes" | "preferences" | "companions"
  >
>;

function cleanItineraryChanges(changes: ItineraryDetailChanges): ItineraryDetailChanges {
  const cleaned: ItineraryDetailChanges = {};
  if (typeof changes.title === "string") cleaned.title = changes.title.trim();
  if (typeof changes.destination === "string") cleaned.destination = changes.destination.trim();
  if ("destinationPlace" in changes) {
    const parsedPlace = PlaceSchema.safeParse(changes.destinationPlace);
    cleaned.destinationPlace = parsedPlace.success ? parsedPlace.data : undefined;
  } else if (typeof changes.destination === "string") {
    cleaned.destinationPlace = undefined;
  }
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
