import type {
  Activity,
  ActivityDraft,
  Coordinates,
  CreateItineraryInput,
  ItineraryDay,
  ItineraryPatch,
  PatchConflict,
  PatchResult,
  Place,
  TransportLeg,
  TravelItinerary,
  WeatherSummary
} from "./types.js";

let localIdCounter = 0;

export function createId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${localIdCounter.toString(36)}-${Date.now().toString(36)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(date: string, offset: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + offset);
  return next.toISOString().slice(0, 10);
}

function inferActivityTypeFromPlace(place?: Pick<Place, "type" | "name" | "address">): Activity["type"] {
  const text = [place?.type, place?.name, place?.address].filter(Boolean).join(" ");
  if (/餐饮|咖啡|茶|美食|饭店|餐厅|小吃|甜品/.test(text)) return "food";
  if (/酒店|住宿|民宿|宾馆|客栈/.test(text)) return "lodging";
  if (/交通|机场|车站|地铁|公交|码头|火车|高铁/.test(text)) return "transport";
  if (/公园|景区|景点|风景|博物馆|寺|馆|文化|展览|古镇|商场|购物|银泰|百货|店/.test(text)) return "attraction";
  return "attraction";
}

function createFirstDestinationActivity(input: CreateItineraryInput): Activity | null {
  const firstDestination = input.firstDestination?.trim() || input.firstDestinationPlace?.name.trim();
  if (!firstDestination) return null;
  const placeName = input.firstDestinationPlace?.name.trim() || firstDestination;
  return normalizeActivity({
    type: inferActivityTypeFromPlace(input.firstDestinationPlace),
    title: firstDestination,
    placeName,
    place: input.firstDestinationPlace,
    tags: ["第一目的地"]
  });
}

export function createDraftItinerary(input: CreateItineraryInput): TravelItinerary {
  const dayCount = Math.max(1, input.dayCount ?? countInclusiveDays(input.startDate, input.endDate ?? input.startDate));
  const days: ItineraryDay[] = Array.from({ length: dayCount }, (_, index) => ({
    id: createId("day"),
    title: `Day ${index + 1}`,
    date: addDays(input.startDate, index),
    activities: [],
    transportLegs: []
  }));
  const firstDestinationActivity = createFirstDestinationActivity(input);
  if (firstDestinationActivity) {
    days[0]?.activities.push(firstDestinationActivity);
  }

  return {
    id: createId("trip"),
    title: input.title,
    destination: input.destination,
    destinationPlace: input.destinationPlace,
    startDate: input.startDate,
    endDate: input.endDate ?? addDays(input.startDate, dayCount - 1),
    companions: input.companions ?? [],
    preferences: input.preferences ?? [],
    budgetCny: input.budgetCny,
    notes: input.notes,
    days,
    importedSkillIds: [],
    manualRevision: 0,
    agentRevision: 0,
    updatedAt: nowIso()
  };
}

export function normalizeActivity(activity: ActivityDraft, source: Activity["source"] = "manual"): Activity {
  return {
    id: activity.id ?? createId("act"),
    type: activity.type,
    title: activity.title,
    placeName: activity.placeName,
    place: activity.place,
    description: activity.description,
    note: activity.note,
    startTime: activity.startTime,
    endTime: activity.endTime,
    tags: activity.tags ?? [],
    budgetCny: activity.budgetCny,
    transportNote: activity.transportNote,
    agentReason: activity.agentReason,
    lockedByUser: activity.lockedByUser ?? false,
    source: activity.source ?? source
  };
}

function touchManual(itinerary: TravelItinerary): TravelItinerary {
  return {
    ...itinerary,
    manualRevision: itinerary.manualRevision + 1,
    updatedAt: nowIso()
  };
}

function touchAgent(itinerary: TravelItinerary): TravelItinerary {
  return {
    ...itinerary,
    agentRevision: itinerary.agentRevision + 1,
    updatedAt: nowIso()
  };
}

export function addActivity(
  itinerary: TravelItinerary,
  dayId: string,
  activity: ActivityDraft,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const nextActivity = normalizeActivity(activity, source);
  const days = itinerary.days.map((day) =>
    day.id === dayId
      ? {
          ...day,
          activities: [...day.activities, nextActivity]
        }
      : day
  );
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function updateActivity(
  itinerary: TravelItinerary,
  activityId: string,
  changes: Partial<Activity>,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const days = itinerary.days.map((day) => {
    let routePlaceChanged = false;
    const activities = day.activities.map((activity) => {
      if (activity.id !== activityId) return activity;
      const nextActivity = {
        ...activity,
        ...changes,
        id: activity.id
      };
      routePlaceChanged = activityRoutePlaceKey(activity) !== activityRoutePlaceKey(nextActivity);
      return nextActivity;
    });
    return {
      ...day,
      activities,
      transportLegs: routePlaceChanged
        ? (day.transportLegs ?? []).filter((leg) => leg.fromActivityId !== activityId && leg.toActivityId !== activityId)
        : day.transportLegs
    };
  });
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function removeActivity(
  itinerary: TravelItinerary,
  activityId: string,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const days = itinerary.days.map((day) =>
    keepAdjacentTransportLegs({
      ...day,
      activities: day.activities.filter((activity) => activity.id !== activityId)
    })
  );
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function reorderActivity(
  itinerary: TravelItinerary,
  dayId: string,
  activityId: string,
  targetIndex: number,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const days = itinerary.days.map((day) => {
    if (day.id !== dayId) return day;
    const currentIndex = day.activities.findIndex((activity) => activity.id === activityId);
    if (currentIndex < 0) return day;
    const activities = [...day.activities];
    const [activity] = activities.splice(currentIndex, 1);
    if (!activity) return day;
    activities.splice(clampIndex(targetIndex, activities.length), 0, activity);
    return keepAdjacentTransportLegs({ ...day, activities });
  });
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function moveActivity(
  itinerary: TravelItinerary,
  activityId: string,
  targetDayId: string,
  targetIndex: number,
  source: Activity["source"] = "manual"
): TravelItinerary {
  let moved: Activity | undefined;
  const without = itinerary.days.map((day) => {
    const nextActivities = day.activities.filter((activity) => {
      if (activity.id === activityId) {
        moved = activity;
        return false;
      }
      return true;
    });
    return keepAdjacentTransportLegs({ ...day, activities: nextActivities });
  });
  if (!moved) return itinerary;

  const days = without.map((day) => {
    if (day.id !== targetDayId) return day;
    const activities = [...day.activities];
    activities.splice(clampIndex(targetIndex, activities.length), 0, moved!);
    return keepAdjacentTransportLegs({ ...day, activities });
  });
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function renameDay(itinerary: TravelItinerary, dayId: string, title: string): TravelItinerary {
  return touchManual({
    ...itinerary,
    days: itinerary.days.map((day) => (day.id === dayId ? { ...day, title } : day))
  });
}

export function addDay(itinerary: TravelItinerary, title?: string): TravelItinerary {
  const date = addDays(itinerary.startDate, itinerary.days.length);
  const nextDay: ItineraryDay = {
    id: createId("day"),
    title: title ?? `Day ${itinerary.days.length + 1}`,
    date,
    activities: [],
    transportLegs: []
  };
  return touchManual({
    ...itinerary,
    endDate: date,
    days: [...itinerary.days, nextDay]
  });
}

export function addDayBefore(itinerary: TravelItinerary, title?: string): TravelItinerary {
  const date = addDays(itinerary.startDate, -1);
  const nextDay: ItineraryDay = {
    id: createId("day"),
    title: title ?? "Day 1",
    date,
    activities: [],
    transportLegs: []
  };
  const days = [nextDay, ...itinerary.days].map((day, index) => ({
    ...day,
    title: /^Day \d+$/.test(day.title) ? `Day ${index + 1}` : day.title
  }));
  return touchManual({
    ...itinerary,
    startDate: date,
    endDate: itinerary.endDate ?? itinerary.days.at(-1)?.date ?? itinerary.startDate,
    days
  });
}

export function resizeItineraryDateRange(
  itinerary: TravelItinerary,
  startDate: string,
  endDate = startDate,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const dayCount = Math.max(1, countInclusiveDays(startDate, endDate));
  const normalizedEndDate = addDays(startDate, dayCount - 1);
  const days: ItineraryDay[] = Array.from({ length: dayCount }, (_, index) => {
    const existing = itinerary.days[index];
    return {
      id: existing?.id ?? createId("day"),
      title: existing?.title ?? `Day ${index + 1}`,
      date: addDays(startDate, index),
      summary: existing?.summary,
      weather: existing?.weather,
      activities: existing?.activities ?? [],
      transportLegs: existing?.transportLegs ?? []
    };
  }).map(keepAdjacentTransportLegs);
  const next = {
    ...itinerary,
    startDate,
    endDate: normalizedEndDate,
    days
  };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export type TransportLegDraft = Omit<
  TransportLeg,
  "id" | "polyline" | "manualOverride" | "routeStatus" | "failureReason" | "steps"
> &
  Partial<Pick<TransportLeg, "id" | "polyline" | "manualOverride" | "routeStatus" | "failureReason" | "steps">>;

export function setTransportLeg(
  itinerary: TravelItinerary,
  dayId: string,
  leg: TransportLegDraft,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const nextLeg: TransportLeg = {
    ...leg,
    id: leg.id ?? createId("leg"),
    manualOverride: leg.manualOverride ?? false,
    routeStatus: leg.routeStatus ?? inferRouteStatus(leg),
    failureReason: leg.failureReason,
    polyline: leg.polyline ?? [],
    steps: leg.steps ?? []
  };
  const days = itinerary.days.map((day) => {
    if (day.id !== dayId) return day;
    const existing = day.transportLegs ?? [];
    const sameConnection = (candidate: TransportLeg) =>
      candidate.fromActivityId === nextLeg.fromActivityId && candidate.toActivityId === nextLeg.toActivityId;
    const replaced = existing.some(sameConnection)
      ? existing.map((candidate) => (sameConnection(candidate) ? nextLeg : candidate))
      : [...existing, nextLeg];
    return {
      ...day,
      transportLegs: replaced
    };
  });
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function removeTransportLeg(
  itinerary: TravelItinerary,
  dayId: string,
  fromActivityId: string,
  toActivityId: string,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const days = itinerary.days.map((day) => {
    if (day.id !== dayId) return day;
    return {
      ...day,
      transportLegs: (day.transportLegs ?? []).filter(
        (leg) => leg.fromActivityId !== fromActivityId || leg.toActivityId !== toActivityId
      )
    };
  });
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function setDayWeather(
  itinerary: TravelItinerary,
  dayId: string,
  weather: WeatherSummary,
  source: Activity["source"] = "manual"
): TravelItinerary {
  const days = itinerary.days.map((day) => (day.id === dayId ? { ...day, weather } : day));
  const next = { ...itinerary, days };
  return source === "agent" ? touchAgent(next) : touchManual(next);
}

export function applyItineraryPatch(itinerary: TravelItinerary, patch: ItineraryPatch): PatchResult {
  const before = itinerary;
  let current = itinerary;
  const conflicts: PatchConflict[] = [];

  for (const operation of patch.operations) {
    if (operation.type === "addActivity") {
      current = addActivity(
        current,
        operation.dayId,
        {
          ...operation.activity,
          agentReason: patch.reason,
          source: patch.source
        },
        patch.source
      );
      continue;
    }

    if (operation.type === "removeActivity") {
      current = removeActivity(current, operation.activityId, patch.source);
      continue;
    }

    if (operation.type === "moveActivity") {
      current = moveActivity(current, operation.activityId, operation.targetDayId, operation.targetIndex, patch.source);
      continue;
    }

    const activity = findActivity(current, operation.activityId);
    if (!activity) continue;

    if (patch.source === "agent" && activity.lockedByUser) {
      const allowedChanges: Partial<Activity> = {};
      for (const [field, proposed] of Object.entries(operation.changes) as Array<[keyof Activity, unknown]>) {
        if (field === "agentReason" || field === "tags") {
          (allowedChanges as Record<string, unknown>)[field] = proposed;
          continue;
        }
        const kept = activity[field];
        if (proposed !== undefined && proposed !== kept) {
          conflicts.push({
            activityId: operation.activityId,
            field,
            kept,
            proposed
          });
        }
      }
      if (Object.keys(allowedChanges).length > 0) {
        current = updateActivity(current, operation.activityId, allowedChanges, patch.source);
      }
    } else {
      current = updateActivity(current, operation.activityId, operation.changes, patch.source);
    }
  }

  return {
    itinerary: current,
    conflicts,
    diff: diffItineraries(before, current)
  };
}

export function findActivity(itinerary: TravelItinerary, activityId: string): Activity | undefined {
  for (const day of itinerary.days) {
    const activity = day.activities.find((candidate) => candidate.id === activityId);
    if (activity) return activity;
  }
  return undefined;
}

export function diffItineraries(before: TravelItinerary, after: TravelItinerary): string[] {
  const beforeDays = new Map(before.days.map((day) => [day.id, day]));
  const beforeActivities = new Map(before.days.flatMap((day) => day.activities.map((activity) => [activity.id, activity])));
  const beforeActivityLocations = new Map(
    before.days.flatMap((day) =>
      day.activities.map((activity, index) => [activity.id, { dayId: day.id, dayTitle: day.title, index }])
    )
  );
  const afterActivities = new Map(after.days.flatMap((day) => day.activities.map((activity) => [activity.id, activity])));
  const diff: string[] = [];

  for (const day of after.days) {
    const previousDay = beforeDays.get(day.id);
    if (!previousDay) {
      diff.push(`新增日期：${day.title}`);
      continue;
    }

    for (const activity of day.activities) {
      const previous = beforeActivities.get(activity.id);
      if (!previous) {
        diff.push(`${day.title} 新增活动：${activity.title}`);
        continue;
      }
      const previousLocation = beforeActivityLocations.get(activity.id);
      if (previousLocation && (previousLocation.dayId !== day.id || previousLocation.index !== day.activities.indexOf(activity))) {
        diff.push(`移动活动：${activity.title} -> ${day.title} 第 ${day.activities.indexOf(activity) + 1} 项`);
      }
      if (
        previous.title !== activity.title ||
        previous.startTime !== activity.startTime ||
        previous.endTime !== activity.endTime ||
        previous.placeName !== activity.placeName
      ) {
        diff.push(`${day.title} 更新活动：${previous.title} -> ${activity.title}`);
      }
    }
  }

  for (const [activityId, activity] of beforeActivities.entries()) {
    if (!afterActivities.has(activityId)) {
      diff.push(`删除活动：${activity.title}`);
    }
  }

  return diff;
}

type ExportDaySummary = {
  activityCount: number;
  activityBudgetCny: number;
  transportLegCount: number;
  pendingTransportLegCount: number;
  distanceMeters: number;
  durationMinutes: number;
  costCny?: number;
};

export type PlanningChecklist = {
  complete: boolean;
  total: number;
  missingPlaces: string[];
  missingTimes: string[];
  pendingTransport: string[];
  missingPlaceItems: PlanningActivityChecklistItem[];
  missingTimeItems: PlanningActivityChecklistItem[];
  pendingTransportItems: PlanningTransportChecklistItem[];
};

export type PlanningActivityChecklistItem = {
  label: string;
  dayId: string;
  activityId: string;
  activityIndex: number;
};

export type PlanningTransportChecklistItem = {
  label: string;
  dayId: string;
  fromActivityId: string;
  toActivityId: string;
  fromActivityIndex: number;
  toActivityIndex: number;
};

export type TransportTimingConflict = {
  fromEndTime: string;
  estimatedArrivalTime: string;
  nextStartTime: string;
  delayMinutes: number;
  message: string;
};

export function detectTransportTimingConflict(
  from: Activity,
  to: Activity,
  leg: Pick<TransportLeg, "durationMinutes">
): TransportTimingConflict | undefined {
  const fromEndMinutes = parseClockMinutes(from.endTime);
  const nextStartMinutes = parseClockMinutes(to.startTime);
  if (fromEndMinutes === undefined || nextStartMinutes === undefined || leg.durationMinutes <= 0) return undefined;

  const estimatedArrivalMinutes = fromEndMinutes + leg.durationMinutes;
  if (estimatedArrivalMinutes <= nextStartMinutes) return undefined;

  const estimatedArrivalTime = formatClockMinutes(estimatedArrivalMinutes);
  const nextStartTime = formatClockMinutes(nextStartMinutes);
  return {
    fromEndTime: formatClockMinutes(fromEndMinutes),
    estimatedArrivalTime,
    nextStartTime,
    delayMinutes: estimatedArrivalMinutes - nextStartMinutes,
    message: `预计 ${estimatedArrivalTime} 到达，晚于 ${nextStartTime}，需调整上一站停留或下一项开始时间。`
  };
}

export function exportItineraryMarkdown(itinerary: TravelItinerary): string {
  const daySummaries = itinerary.days.map((day) => summarizeDayForExport(day));
  const summary = daySummaries.reduce<ExportDaySummary>(
    (total, day) => ({
      activityCount: total.activityCount + day.activityCount,
      activityBudgetCny: total.activityBudgetCny + day.activityBudgetCny,
      transportLegCount: total.transportLegCount + day.transportLegCount,
      pendingTransportLegCount: total.pendingTransportLegCount + day.pendingTransportLegCount,
      distanceMeters: total.distanceMeters + day.distanceMeters,
      durationMinutes: total.durationMinutes + day.durationMinutes,
      costCny: sumOptionalCurrency(total.costCny, day.costCny)
    }),
    {
      activityCount: 0,
      activityBudgetCny: 0,
      transportLegCount: 0,
      pendingTransportLegCount: 0,
      distanceMeters: 0,
      durationMinutes: 0
    }
  );
  const lines: string[] = [
    `# ${itinerary.title}`,
    "",
    `目的地：${itinerary.destination}`,
    `日期：${itinerary.startDate} 至 ${itinerary.endDate ?? itinerary.startDate}`
  ];

  if (itinerary.budgetCny !== undefined) lines.push(`总预算：${itinerary.budgetCny} 元`);
  if (itinerary.notes) lines.push(`备注：${itinerary.notes}`);
  lines.push("");
  lines.push("## 行程总览");
  lines.push("");
  lines.push(`总天数：${itinerary.days.length} 天`);
  lines.push(`总安排：${summary.activityCount} 项`);
  lines.push(`活动预算合计：${summary.activityBudgetCny} 元`);
  lines.push(formatComputedTransportSummary(summary));
  if (summary.pendingTransportLegCount > 0) {
    lines.push(`未计算交通：${summary.pendingTransportLegCount} 段`);
  }
  lines.push("");
  lines.push("## 规划检查");
  lines.push("");
  lines.push(...formatPlanningChecklistLines(itinerary));
  lines.push("");

  for (let dayIndex = 0; dayIndex < itinerary.days.length; dayIndex += 1) {
    const day = itinerary.days[dayIndex]!;
    const daySummary = daySummaries[dayIndex]!;
    lines.push(`## ${day.title}`);
    lines.push("");
    lines.push(`日期：${day.date}`);
    if (day.weather) lines.push(`天气：${formatWeather(day.weather)}`);
    if (day.summary) lines.push(`摘要：${day.summary}`);
    lines.push(`${day.title} 小计：${formatDaySummary(daySummary)}`);
    lines.push("");

    for (let index = 0; index < day.activities.length; index += 1) {
      const activity = day.activities[index]!;
      const timeRange = [activity.startTime, activity.endTime].filter(Boolean).join("-");
      lines.push(`### ${index + 1}. ${formatActivityTitleForExport(activity)}`);
      if (timeRange) lines.push(`时间：${timeRange}`);
      if (activity.placeName) lines.push(`地点：${activity.placeName}`);
      if (activity.place?.address) lines.push(`地址：${activity.place.address}`);
      if (activity.place?.openingHours) lines.push(`营业时间：${activity.place.openingHours}`);
      if (activity.place?.phone) lines.push(`电话：${activity.place.phone}`);
      if (activity.place?.averageCostCny !== undefined) lines.push(`参考人均：${activity.place.averageCostCny} 元`);
      if (activity.place?.coordinates) lines.push(`坐标：${formatCoordinates(activity.place.coordinates)}`);
      if (activity.budgetCny !== undefined) lines.push(`预算：${activity.budgetCny} 元`);
      if (activity.description) lines.push(`说明：${activity.description}`);
      if (activity.note) lines.push(`备注：${activity.note}`);

      const next = day.activities[index + 1];
      if (next) {
        const leg = (day.transportLegs ?? []).find(
          (candidate) => candidate.fromActivityId === activity.id && candidate.toActivityId === next.id
        );
        if (leg) lines.push(...formatTransportLegLines(leg, activity, next));
      }
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

function summarizeDayForExport(day: ItineraryDay): ExportDaySummary {
  const transportLegs = getAdjacentTransportLegsForExport(day);
  const expectedTransportLegCount = countRoutableAdjacentPairsForExport(day);
  const costCny = transportLegs.reduce<number | undefined>(
    (sum, leg) => sumOptionalCurrency(sum, leg.costCny),
    undefined
  );

  return {
    activityCount: day.activities.length,
    activityBudgetCny: day.activities.reduce((sum, activity) => sum + (activity.budgetCny ?? 0), 0),
    transportLegCount: transportLegs.length,
    pendingTransportLegCount: Math.max(0, expectedTransportLegCount - transportLegs.length),
    distanceMeters: transportLegs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
    durationMinutes: transportLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0),
    costCny
  };
}

function getAdjacentTransportLegsForExport(day: ItineraryDay): TransportLeg[] {
  return (day.transportLegs ?? []).filter((leg) =>
    day.activities.some((activity, index) => {
      const next = day.activities[index + 1];
      return next && leg.fromActivityId === activity.id && leg.toActivityId === next.id;
    })
  );
}

function formatActivityTitleForExport(activity: Activity): string {
  return (
    activity.title.trim() ||
    activity.placeName?.trim() ||
    activity.place?.name?.trim() ||
    "待补全安排"
  );
}

function countRoutableAdjacentPairsForExport(day: ItineraryDay): number {
  return day.activities.reduce((count, activity, index) => {
    const next = day.activities[index + 1];
    return next && canExportRouteActivityPair(activity, next) ? count + 1 : count;
  }, 0);
}

function canExportRouteActivityPair(from: Activity, to: Activity): boolean {
  return hasExportRouteEndpoint(from) && hasExportRouteEndpoint(to);
}

export function summarizePlanningChecklist(itinerary: TravelItinerary): PlanningChecklist {
  const missingPlaces: string[] = [];
  const missingTimes: string[] = [];
  const pendingTransport: string[] = [];
  const missingPlaceItems: PlanningActivityChecklistItem[] = [];
  const missingTimeItems: PlanningActivityChecklistItem[] = [];
  const pendingTransportItems: PlanningTransportChecklistItem[] = [];

  for (const day of itinerary.days) {
    day.activities.forEach((activity, index) => {
      const activityLabel = formatPlanningActivityLabel(day, activity, index);
      if (!hasExportPlace(activity)) {
        missingPlaces.push(activityLabel);
        missingPlaceItems.push({
          label: activityLabel,
          dayId: day.id,
          activityId: activity.id,
          activityIndex: index
        });
      }
      if (!activity.startTime || !activity.endTime) {
        missingTimes.push(activityLabel);
        missingTimeItems.push({
          label: activityLabel,
          dayId: day.id,
          activityId: activity.id,
          activityIndex: index
        });
      }

      const next = day.activities[index + 1];
      if (!next || !canExportRouteActivityPair(activity, next)) return;
      const hasLeg = (day.transportLegs ?? []).some(
        (leg) => leg.fromActivityId === activity.id && leg.toActivityId === next.id
      );
      if (!hasLeg) {
        const label = `${day.title} ${formatActivityTitleForExport(activity)} 到 ${formatActivityTitleForExport(next)}`;
        pendingTransport.push(label);
        pendingTransportItems.push({
          label,
          dayId: day.id,
          fromActivityId: activity.id,
          toActivityId: next.id,
          fromActivityIndex: index,
          toActivityIndex: index + 1
        });
      }
    });
  }

  const total = missingPlaces.length + missingTimes.length + pendingTransport.length;
  return {
    complete: total === 0,
    total,
    missingPlaces,
    missingTimes,
    pendingTransport,
    missingPlaceItems,
    missingTimeItems,
    pendingTransportItems
  };
}

function formatPlanningChecklistLines(itinerary: TravelItinerary): string[] {
  const checklist = summarizePlanningChecklist(itinerary);
  const lines: string[] = [];
  if (checklist.complete) {
    return ["状态：已补齐地点、时间和相邻交通。"];
  }
  lines.push(`待补项：${checklist.total} 项`);
  lines.push(...checklist.missingPlaces.map((item) => `待补地点：${item}`));
  lines.push(...checklist.missingTimes.map((item) => `待补时间：${item}`));
  lines.push(...checklist.pendingTransport.map((item) => `待计算交通：${item}`));
  return lines;
}

function formatPlanningActivityLabel(day: ItineraryDay, activity: Activity, index: number): string {
  return `${day.title} 第 ${index + 1} 项 ${formatActivityTitleForExport(activity)}`;
}

function hasExportPlace(activity: Activity): boolean {
  return Boolean(activity.place?.coordinates || activity.placeName?.trim() || activity.place?.name?.trim());
}

function hasExportRouteEndpoint(activity: Activity): boolean {
  return Boolean(
    activity.place?.coordinates ||
      activity.placeName?.trim() ||
      activity.place?.name?.trim() ||
      activity.title.trim()
  );
}

function sumOptionalCurrency(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + next;
}

function formatComputedTransportSummary(summary: ExportDaySummary): string {
  if (summary.transportLegCount === 0) return "已计算交通：0 段";
  const parts = [
    `${summary.transportLegCount} 段`,
    formatDistance(summary.distanceMeters),
    `${summary.durationMinutes} 分钟`
  ];
  if (summary.costCny !== undefined) parts.push(`约 ${summary.costCny} 元`);
  return `已计算交通：${parts.join("，")}`;
}

function formatTransportLegLines(leg: TransportLeg, from?: Activity, to?: Activity): string[] {
  const lines = [formatTransportLegLine(leg)];
  if (from && to) {
    const conflict = detectTransportTimingConflict(from, to, leg);
    if (conflict) lines.push(`时间提醒：${conflict.message}`);
  }
  const routeSteps = formatRouteSteps(leg);
  if (routeSteps) lines.push(routeSteps);
  return lines;
}

function formatTransportLegLine(leg: TransportLeg): string {
  const parts = [
    `交通：${formatTransportMode(leg.mode)}`,
    formatDistance(leg.distanceMeters),
    `${leg.durationMinutes} 分钟`
  ];
  if (leg.costCny !== undefined) parts.push(`约 ${leg.costCny} 元`);

  const detailParts = [
    formatTransportProviderForExport(leg),
    leg.summary,
    leg.manualOverride && leg.note ? `用户调整：${leg.note}` : undefined
  ].filter(Boolean);
  return `${parts.join("，")}${detailParts.length > 0 ? `（${detailParts.join("；")}）` : ""}`;
}

function formatTransportProviderForExport(leg: TransportLeg): string | undefined {
  if (leg.manualOverride) return undefined;
  if (leg.provider === "amap") return "高德路线";
  return "手动路线";
}

function formatRouteSteps(leg: TransportLeg): string | undefined {
  if (!leg.steps.length) return undefined;
  return `路线步骤：${leg.steps
    .map((step, index) => {
      const metrics = [
        step.distanceMeters !== undefined ? formatDistance(step.distanceMeters) : undefined,
        step.durationMinutes !== undefined ? `${step.durationMinutes} 分钟` : undefined
      ].filter(Boolean);
      return `${index + 1}. ${step.instruction}${metrics.length ? `（${metrics.join("，")}）` : ""}`;
    })
    .join("；")}`;
}

function inferRouteStatus(leg: TransportLegDraft): TransportLeg["routeStatus"] {
  if (leg.manualOverride) return "manual";
  if (leg.provider === "amap") return "planned";
  return "manual";
}

function formatDaySummary(summary: ExportDaySummary): string {
  const parts = [`${summary.activityCount} 项安排`, `活动预算 ${summary.activityBudgetCny} 元`];
  if (summary.transportLegCount > 0) {
    const transportParts = [formatDistance(summary.distanceMeters), `${summary.durationMinutes} 分钟`];
    if (summary.costCny !== undefined) transportParts.push(`约 ${summary.costCny} 元`);
    parts.push(`交通 ${transportParts.join(" / ")}`);
  }
  if (summary.pendingTransportLegCount > 0) {
    parts.push(`交通待计算 ${summary.pendingTransportLegCount} 段`);
  }
  return parts.join("，");
}

function formatCoordinates(coordinates: Coordinates): string {
  return `${trimCoordinate(coordinates.lng)},${trimCoordinate(coordinates.lat)}`;
}

function formatWeather(weather: WeatherSummary): string {
  return `${weather.weather}，${weather.temperature}（${weather.city}，${weather.source}）`;
}

function trimCoordinate(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), length);
}

function keepAdjacentTransportLegs(day: ItineraryDay): ItineraryDay {
  const adjacentPairs = new Set(
    day.activities.slice(0, -1).map((activity, index) => {
      const next = day.activities[index + 1]!;
      return `${activity.id}:${next.id}`;
    })
  );
  return {
    ...day,
    transportLegs: (day.transportLegs ?? []).filter((leg) => adjacentPairs.has(`${leg.fromActivityId}:${leg.toActivityId}`))
  };
}

function activityRoutePlaceKey(activity: Activity): string {
  const coordinates = activity.place?.coordinates;
  const coordinateKey = coordinates ? `${trimCoordinate(coordinates.lng)},${trimCoordinate(coordinates.lat)}` : "";
  return [activity.place?.poiId ?? "", coordinateKey, activity.placeName ?? activity.place?.name ?? ""].join("|");
}

function countInclusiveDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.floor((end - start) / 86_400_000) + 1;
}

function parseClockMinutes(value: string | undefined): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function formatClockMinutes(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function formatDistance(distanceMeters: number): string {
  return distanceMeters >= 1000 ? `${Number((distanceMeters / 1000).toFixed(1))} km` : `${distanceMeters} m`;
}

function formatTransportMode(mode: TransportLeg["mode"]): string {
  const labels: Record<TransportLeg["mode"], string> = {
    walking: "步行",
    transit: "公交/地铁",
    driving: "驾车",
    cycling: "骑行"
  };
  return labels[mode];
}
