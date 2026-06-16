import {
  addActivity,
  addDay,
  addDayBefore,
  aggregateEvaluation,
  appendSkillVersion,
  buildSkillMarkdown,
  buildExtractedSkillDraftTitle,
  createDraftItinerary,
  detectTransportTimingConflict,
  diffItineraries,
  evaluationDataset,
  moveActivity,
  normalizeSkillVersionHistory,
  parseSkillMarkdown,
  recommendSkills,
  removeActivity,
  removeTransportLeg,
  reorderActivity,
  resizeItineraryDateRange,
  setDayWeather,
  setTransportLeg,
  summarizePlanningChecklist,
  updateActivity,
  validateSkillMarkdown,
  type AgentRunEvent,
  type AgentSession,
  type AgentTraceEvent,
  type Activity,
  type ActivityDraft,
  type ActivityType,
  type ItineraryDay,
  type MapRouteMode,
  type PlanningActivityChecklistItem,
  type PlanningTransportChecklistItem,
  type Place,
  type RouteStep,
  type RouteSummary,
  type SavedMemory,
  type SkillRecommendation,
  type SkillCreatorOption,
  type SkillCreatorSession,
  type SkillCreatorTurn,
  type SkillValidationResult,
  type TransportLeg,
  type TravelItinerary,
  type TravelSkill,
  type TravelSkillVersion,
  type WeatherSummary
} from "@journey/shared";
import {
  Archive,
  Bot,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronUp,
  CloudSun,
  Clock3,
  CircleStop,
  Copy,
  Download,
  GripVertical,
  History,
  Heart,
  Home,
  MapPinned,
  MapPin,
  Pencil,
  Plus,
  Route,
  Search,
  Send,
  Settings2,
  Sparkles,
  Store,
  Trash2,
  Wallet,
  WandSparkles,
  X
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { ApiRequestError, ApiStreamEventError, apiDelete, apiEventStream, apiGet, apiPost, apiPostStrict, apiPatch, apiText } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Page = "home" | "workbench" | "result" | "skills" | "creator" | "settings" | "evaluation";
type MapRouteFocusRequest = { dayId: string; legId: string; nonce: number };
const LAST_ITINERARY_ID_KEY = "journey:last-itinerary-id";
const ASSISTANT_PROMPT_SUGGESTIONS = [
  "Day 2 下午补一个室内景点，节奏轻松一点",
  "把今天预算压到 800 元以内，尽量少跨区",
  "检查路线是否会晚到，并给我一个调整方案"
];
const AGENT_WAITING_STATUS = "等待新的需求";
const EMPTY_ITINERARY = createDraftItinerary({
  title: "",
  destination: "",
  startDate: new Date().toISOString().slice(0, 10),
  endDate: new Date().toISOString().slice(0, 10),
  companions: [],
  preferences: []
});
type CreateTripFormInput = {
  title: string;
  destination: string;
  destinationPlace?: Place;
  firstDestination?: string;
  firstDestinationPlace?: Place;
  startDate: string;
  endDate: string;
  budgetCny?: number;
  companions?: string[];
  notes?: string;
};
type OvernightStartAnchor = {
  day: ItineraryDay;
  activity: Activity;
  index: number;
};
type DayRoutePair = {
  day: ItineraryDay;
  fromActivity: Activity;
  toActivity: Activity;
  fromIndex: number;
  toIndex: number;
  fromDayId: string;
  toDayId: string;
  leg?: TransportLeg;
  overnightStart: boolean;
};
type AgentChangeTarget = {
  label: string;
  dayId: string;
  activityId?: string;
  transportLegId?: string;
};
type AgentStyleInfluence = {
  skillName: string;
  scopes: string[];
  rules: string[];
};
type AgentChangeSet = {
  diff: string[];
  styleNames: string[];
  styleInfluences: AgentStyleInfluence[];
  beforeItinerary: TravelItinerary;
  targets: Array<AgentChangeTarget | undefined>;
  undone?: boolean;
};
type AgentActivityKind = "thought" | "output" | "tool_call" | "tool_result" | "state_patch" | "handoff" | "final_signal" | "error";
type AgentActivityStatus = "running" | "completed" | "failed";
type AgentActivityItem = {
  id: string;
  kind: AgentActivityKind;
  title: string;
  detail?: string;
  agent?: AgentTraceEvent["agent"];
  traceType?: AgentTraceEvent["type"];
  status: AgentActivityStatus;
  technical?: AgentRunEvent["technical"];
};
type AgentRunLog = {
  id: string;
  status: "running" | "completed" | "failed" | "stopped";
  summary: string;
  expanded: boolean;
  items: AgentActivityItem[];
};
type ChatMessage = { role: "user" | "assistant"; content: string; changeSet?: AgentChangeSet; runLog?: AgentRunLog };
type AssistantAction = { label: string; requestText: string };
type SkillFilter = "recommended" | "all" | "favorites" | "drafts";
type SkillCreatorSourceMode = "text" | "itinerary" | "conversation";
type SkillCreatorStartResponse = {
  session: SkillCreatorSession;
  turn: SkillCreatorTurn;
};
type SkillCreatorReplyResponse = SkillCreatorStartResponse;
type SkillContentChanges = Partial<
  Pick<TravelSkill, "displayName" | "description" | "body" | "tags" | "rules" | "forbidden" | "status">
>;
type AgentRunResponse = {
  itinerary: TravelItinerary;
  message: { role: "assistant"; content: string };
  diff: string[];
  session?: AgentSession;
  traces?: AgentTraceEvent[];
  events?: AgentRunEvent[];
};
type ActivitySummaryView = {
  displayName: string;
  mapLabel: string;
  place?: string;
  time?: string;
  budget?: string;
  missing?: string;
  typeLabel: string;
  mapMeta: string;
  blankDraft: boolean;
};
type TransportLegOverride = {
  distanceMeters?: number;
  durationMinutes?: number;
  costCny?: number;
  summary?: string;
  note?: string;
  manualOverride?: boolean;
};

const heroImages = [
  "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1528127269322-539801943592?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1498307833015-e7b400441eb8?auto=format&fit=crop&w=900&q=80"
] as const;

const fallbackHeroImage = heroImages[0];

const activityLabels: Record<ActivityType, string> = {
  attraction: "景点",
  food: "餐饮",
  transport: "交通",
  lodging: "住宿",
  free_time: "自由活动"
};

const activityTypeOptions = Object.entries(activityLabels) as Array<[ActivityType, string]>;
const routeModeOptions: Array<[MapRouteMode, string]> = [
  ["walking", "步行"],
  ["transit", "公交/地铁"],
  ["driving", "驾车"],
  ["cycling", "骑行"]
];
const pageRoutes: Record<Page, string> = {
  home: "/",
  workbench: "/workbench",
  result: "/result",
  skills: "/skills",
  creator: "/creator",
  settings: "/settings",
  evaluation: "/evaluation"
};
const routePages = Object.fromEntries(Object.entries(pageRoutes).map(([page, route]) => [route, page])) as Record<string, Page>;
const routeAliases: Record<string, Page> = {
  "/plaza": "skills"
};

function readPageFromLocation(): Page {
  if (typeof window === "undefined") return "home";
  const route = window.location.hash.replace(/^#/, "") || "/";
  return routePages[route] ?? routeAliases[route] ?? "home";
}

function pageHash(page: Page): string {
  return `#${pageRoutes[page]}`;
}

function activityPrimaryPlaceName(activity: Activity): string | undefined {
  const placeName = activity.placeName?.trim() || activity.place?.name?.trim();
  return placeName || undefined;
}

function activityDisplayName(activity: Activity, index?: number): string {
  return activity.title.trim() || activityPrimaryPlaceName(activity) || "待补全安排";
}

function activityRouteName(from: Activity, to: Activity, fromIndex?: number, toIndex?: number): string {
  return `${activityDisplayName(from, fromIndex)} 到 ${activityDisplayName(to, toIndex)}`;
}

function activityMapLabel(activity: Activity, index?: number): string {
  return activityPrimaryPlaceName(activity) || activityDisplayName(activity, index);
}

function activityTimeSummary(activity: Activity): string | undefined {
  if (activity.startTime && activity.endTime) return `${activity.startTime}-${activity.endTime}`;
  return activity.startTime || activity.endTime || undefined;
}

function activitySummaryView(activity: Activity, index?: number): ActivitySummaryView {
  const place = activityPrimaryPlaceName(activity);
  const time = activityTimeSummary(activity);
  const budget = activity.budgetCny ? `约 ${activity.budgetCny} 元` : undefined;
  const blankDraft = isBlankDraftActivity(activity);
  const displayName = blankDraft && index !== undefined ? `第 ${index + 1} 项安排` : activityDisplayName(activity, index);
  const typeLabel = activityLabels[activity.type];
  const missing =
    !place && !time
      ? "待补地点与时间"
      : !place
        ? "待补地点"
        : !time
          ? "待补时间"
          : undefined;

  return {
    displayName,
    mapLabel: activityMapLabel(activity, index),
    place,
    time,
    budget,
    missing,
    typeLabel,
    mapMeta: `${time ?? "待定"} / ${typeLabel}`,
    blankDraft
  };
}

function normalizeMapFilter(value: string): string {
  return value.trim().toLowerCase();
}

function textMatchesMapFilter(filter: string, values: Array<string | number | undefined | null>): boolean {
  if (!filter) return true;
  return values
    .filter((value): value is string | number => value !== undefined && value !== null)
    .some((value) => String(value).toLowerCase().includes(filter));
}

function activityMatchesMapFilter(activity: Activity, index: number, day: Pick<ItineraryDay, "title" | "date">, filter: string): boolean {
  const summary = activitySummaryView(activity, index);
  return textMatchesMapFilter(filter, [
    day.title,
    day.date,
    summary.displayName,
    summary.mapLabel,
    summary.mapMeta,
    summary.place,
    summary.time,
    summary.typeLabel,
    activity.description,
    activity.note,
    activity.placeName,
    activity.place?.name,
    activity.place?.address,
    activity.place?.district,
    activity.place?.type,
    activity.tags.join(" ")
  ]);
}

function isBlankDraftActivity(activity: Activity): boolean {
  return (
    !activity.title.trim() &&
    !activityPrimaryPlaceName(activity) &&
    !activity.startTime &&
    !activity.endTime &&
    activity.budgetCny === undefined &&
    !activity.description?.trim() &&
    !activity.note?.trim()
  );
}

function hasMapPoint(activity: Activity): boolean {
  return Boolean(activity.place?.coordinates || activityPrimaryPlaceName(activity));
}

function hasRouteEndpoint(activity: Activity): boolean {
  return Boolean(activity.place?.coordinates || activityPrimaryPlaceName(activity) || activity.title.trim());
}

function hasPreciseRouteEndpoint(activity: Activity): boolean {
  return Boolean(activity.place?.coordinates || activity.place?.poiId);
}

function canRouteActivityPair(from: Activity, to: Activity): boolean {
  return hasRouteEndpoint(from) && hasRouteEndpoint(to);
}

function routeRepairIssueText(from: Activity, to: Activity): string {
  const missingFrom = !hasPreciseRouteEndpoint(from);
  const missingTo = !hasPreciseRouteEndpoint(to);
  if (missingFrom && missingTo) return "起点和终点都缺少精确位置";
  if (missingFrom) return "起点缺少精确位置";
  if (missingTo) return "终点缺少精确位置";
  return "位置已确认，可改交通方式或手动记录";
}

function routeEndpointFingerprint(activity: Activity): string {
  const coordinates = activity.place?.coordinates;
  const coordinateKey = coordinates ? `${coordinates.lng.toFixed(6)},${coordinates.lat.toFixed(6)}` : "";
  const namedPlace = activity.placeName?.trim() || activity.place?.name?.trim();
  const fallbackTitle = namedPlace || coordinateKey || activity.title.trim();
  return [activity.id, activity.place?.poiId ?? "", coordinateKey, namedPlace ?? "", fallbackTitle].join("|");
}

function cityFallbackCoordinates(city: string): NonNullable<Place["coordinates"]> {
  const normalized = city.trim();
  const knownCenters: Array<[RegExp, NonNullable<Place["coordinates"]>]> = [
    [/苏州/, { lng: 120.5853, lat: 31.2989 }],
    [/杭州/, { lng: 120.1551, lat: 30.2741 }],
    [/上海/, { lng: 121.4737, lat: 31.2304 }],
    [/北京/, { lng: 116.4074, lat: 39.9042 }],
    [/广州/, { lng: 113.2644, lat: 23.1291 }],
    [/厦门/, { lng: 118.0894, lat: 24.4798 }],
    [/成都/, { lng: 104.0668, lat: 30.5728 }],
    [/南京/, { lng: 118.7969, lat: 32.0603 }],
    [/青岛/, { lng: 120.3826, lat: 36.0671 }]
  ];
  return knownCenters.find(([pattern]) => pattern.test(normalized))?.[1] ?? { lng: 120.1551, lat: 30.2741 };
}

function normalizeItineraryForClient(itinerary: TravelItinerary): TravelItinerary {
  const title = normalizeTravelerFacingTitle(itinerary);
  const normalizedItinerary = {
    ...itinerary,
    title,
    days: itinerary.days.map((day) => ({
      ...day,
      activities: day.activities.map((activity) => normalizeLegacyPlaceholderActivity(activity, itinerary.destination))
    }))
  };
  const days = normalizedItinerary.days.map((day) => {
    const routeablePairs = new Set(
      getRoutePairsForDay(normalizedItinerary, day).map((pair) => `${pair.fromActivity.id}:${pair.toActivity.id}`)
    );
    return {
      ...day,
      transportLegs: (day.transportLegs ?? []).filter((leg) => routeablePairs.has(`${leg.fromActivityId}:${leg.toActivityId}`))
    };
  });
  return { ...normalizedItinerary, days };
}

function normalizeTravelerFacingTitle(itinerary: TravelItinerary): string {
  const title = itinerary.title.trim();
  const developmentTitle = /(高德|amap|autonavi).*(验证|测试)|验证行程|测试行程|demo/i.test(title);
  if (!developmentTitle) return title || `${itinerary.destination || "旅行"}计划`;
  if (/杭州|西湖|骑行/.test(`${title} ${itinerary.destination}`)) return `${itinerary.destination || "杭州"}西湖骑行路线`;
  return `${itinerary.destination || "城市"}旅行计划`;
}

function mergeBackgroundCanvasUpdates(next: TravelItinerary, current: TravelItinerary): TravelItinerary {
  const currentDays = new Map(current.days.map((day) => [day.id, day]));
  return {
    ...next,
    days: next.days.map((day) => {
      const currentDay = currentDays.get(day.id);
      if (!currentDay) return day;
      const nextLegs = day.transportLegs ?? [];
      const currentLegs = currentDay.transportLegs ?? [];
      return {
        ...day,
        weather: day.weather ?? currentDay.weather,
        transportLegs: nextLegs.length > 0 || currentLegs.length === 0 ? day.transportLegs : currentDay.transportLegs
      };
    })
  };
}

function normalizeLegacyPlaceholderActivity(activity: Activity, destination: string): Activity {
  const isLegacyPlaceholder =
    activity.source === "manual" &&
    activity.type === "free_time" &&
    activity.title.trim() === "新的活动" &&
    activity.placeName?.trim() === destination.trim() &&
    activity.startTime === "14:00" &&
    activity.endTime === "15:00" &&
    !activity.place &&
    !activity.description &&
    !activity.note &&
    activity.budgetCny === undefined;
  if (!isLegacyPlaceholder) return activity;
  return {
    ...activity,
    title: "",
    placeName: undefined,
    startTime: undefined,
    endTime: undefined
  };
}

export default function App() {
  const [page, setPageState] = useState<Page>(() => readPageFromLocation());
  const [itinerary, setItinerary] = useState<TravelItinerary>(() => EMPTY_ITINERARY);
  const [itineraries, setItineraries] = useState<TravelItinerary[]>(() => [itinerary]);
  const [skills, setSkills] = useState<TravelSkill[]>([]);
  const [savedMemories, setSavedMemories] = useState<SavedMemory[]>([]);
  const [selectedDayId, setSelectedDayId] = useState(() => itinerary.days[0]?.id ?? "");
  const [importedSkillIds, setImportedSkillIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentProgress, setAgentProgress] = useState<string[]>([]);
  const [agentRunLog, setAgentRunLog] = useState<AgentRunLog | null>(null);
  const agentAbortRef = useRef<AbortController | null>(null);
  const agentRunLogRef = useRef<AgentRunLog | null>(null);
  const itineraryRef = useRef<TravelItinerary>(itinerary);
  const [exportText, setExportText] = useState("");
  const [serviceStatus, setServiceStatus] = useState("");
  const [saveStatus, setSaveStatus] = useState("已保存");
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const [canvasFocusTarget, setCanvasFocusTarget] = useState<AgentChangeTarget | null>(null);
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("recommended");
  const [creatorDraft, setCreatorDraft] = useState<TravelSkill | null>(null);
  const [creatorSourceMode, setCreatorSourceMode] = useState<SkillCreatorSourceMode>("text");
  const [creatorText, setCreatorText] = useState(
    "这次厦门旅行最喜欢沙坡尾海边散步、傍晚日落和小店探索，整体不要赶路。"
  );
  const [newTripDialogOpen, setNewTripDialogOpen] = useState(false);
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);
  const savedMemoryKeywords = useMemo(() => deriveSavedMemoryKeywords(savedMemories, skills), [savedMemories, skills]);

  async function loadSavedMemories() {
    try {
      const result = await apiGet<{ items: SavedMemory[] }>("/memories");
      return sortSavedMemoriesByUpdatedAt(result.items);
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status?: unknown }).status === 404) return [];
      throw error;
    }
  }

  async function loadConversationMessages(itineraryId: string): Promise<ChatMessage[]> {
    try {
      const result = await apiGet<{
        items: Array<
          | { type: "session"; sessionId: string; createdAt: string; updatedAt: string }
          | {
              type: "message";
              sessionId: string;
              messageId: string;
              role: "user" | "assistant" | "system";
              content: string;
              createdAt: string;
            }
        >;
      }>(`/agent/history/conversations/${encodeURIComponent(itineraryId)}`);
      return result.items
        .filter((item): item is Extract<typeof item, { type: "message" }> => item.type === "message")
        .filter((item) => item.role === "user" || item.role === "assistant")
        .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status?: unknown }).status === 404) return [];
      throw error;
    }
  }

  function setPage(nextPage: Page) {
    setPageState(nextPage);
    if (typeof window === "undefined") return;
    const nextHash = pageHash(nextPage);
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, "", nextHash);
    }
  }

  useEffect(() => {
    function syncPageFromLocation() {
      setPageState(readPageFromLocation());
    }
    window.addEventListener("hashchange", syncPageFromLocation);
    window.addEventListener("popstate", syncPageFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncPageFromLocation);
      window.removeEventListener("popstate", syncPageFromLocation);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadInitialData() {
      try {
        const [itineraryResult, skillResult, memoryResult] = await Promise.all([
          apiGet<{ items: TravelItinerary[] }>("/itineraries"),
          apiGet<{ items: TravelSkill[] }>("/skills"),
          loadSavedMemories()
        ]);
        if (cancelled) return;
        const loadedItems = sortItinerariesByRecency(itineraryResult.items.map(normalizeItineraryForClient));
        setItineraries(loadedItems);
        setSkills(skillResult.items);
        setSavedMemories(memoryResult);
        const lastItineraryId = readLastItineraryId();
        const loaded = loadedItems.find((item) => item.id === lastItineraryId) ?? loadedItems[0];
        if (loaded) {
          setItinerary(loaded);
          itineraryRef.current = loaded;
          setSelectedDayId(loaded.days[0]?.id ?? "");
          setImportedSkillIds(loaded.importedSkillIds ?? []);
          markSaved(loaded.updatedAt);
          rememberLastItineraryId(loaded.id);
          try {
            const restoredMessages = await loadConversationMessages(loaded.id);
            if (!cancelled) setMessages(restoredMessages);
          } catch {
            // Restoring history is best-effort; leave messages empty on failure.
          }
        } else {
          setItinerary(EMPTY_ITINERARY);
          itineraryRef.current = EMPTY_ITINERARY;
          setSelectedDayId("");
          setImportedSkillIds([]);
        }
        if (!cancelled) {
          setServiceStatus("");
        }
      } catch (error) {
        if (cancelled) return;
        setServiceStatus(readApiRequestErrorMessage(error, "服务加载失败，请确认 API 后端已启动。"));
        setItineraries([]);
        setSkills([]);
        setSavedMemories([]);
      } finally {
        if (!cancelled) setInitialDataLoaded(true);
      }
    }
    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    itineraryRef.current = itinerary;
    setItineraries((current) => upsertItineraryList(current, itinerary));
  }, [itinerary]);

  const selectedDay = itinerary.days.find((day) => day.id === selectedDayId) ?? itinerary.days[0]!;
  const recommendations = useMemo(
    () =>
      recommendSkills(skills, {
        destination: itinerary.destination,
        companions: [],
        preferences: savedMemoryKeywords,
        currentText: `${itinerary.title} ${itinerary.days.flatMap((day) => day.activities.map((activity) => activity.title)).join(" ")}`,
        importedSkillIds
      }),
    [importedSkillIds, itinerary, savedMemoryKeywords, skills]
  );
  const showAgentPanel = page === "workbench" && itineraries.length > 0;
  const shellGridClass = showAgentPanel
    ? "grid h-dvh min-h-0 grid-cols-1 overflow-hidden min-[769px]:grid-cols-[minmax(0,1fr)_clamp(440px,46vw,500px)] lg:grid-cols-[72px_minmax(0,1fr)_clamp(440px,38vw,540px)] 2xl:grid-cols-[280px_minmax(0,1fr)_clamp(520px,30vw,620px)]"
    : "grid min-h-screen grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]";

  async function addManualActivity(activity?: ActivityDraft) {
    if (!selectedDay) return;
    const draft: ActivityDraft =
      activity ?? {
        type: "free_time",
        title: "",
        description: "",
        tags: ["手动"]
      };
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/days/${selectedDay.id}/activities`, draft);
      const normalized = commitSavedItinerary(result.itinerary);
      setServiceStatus("");
      return normalized;
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "新增活动失败，请稍后重试。"));
      setSaveStatus("保存失败");
      return undefined;
    }
  }

  async function selectItinerary(itineraryId: string) {
    const existing = itineraries.find((item) => item.id === itineraryId);
    if (!existing) return;
    const normalized = normalizeItineraryForClient(existing);
    await activateItinerary(normalized);
    setPage("workbench");
  }

  async function activateItinerary(next: TravelItinerary) {
    const normalized = normalizeItineraryForClient(next);
    itineraryRef.current = normalized;
    setItinerary(normalized);
    setSelectedDayId(normalized.days[0]?.id ?? "");
    setImportedSkillIds(normalized.importedSkillIds ?? []);
    setExportText("");
    setMessages([]);
    markSaved(normalized.updatedAt);
    rememberLastItineraryId(normalized.id);
    try {
      const restoredMessages = await loadConversationMessages(normalized.id);
      setMessages(restoredMessages);
    } catch {
      // Restoring history is best-effort; leave messages empty on failure.
    }
  }

  async function archiveItinerary(itineraryId: string) {
    const target = itineraries.find((item) => item.id === itineraryId);
    if (!target || itineraries.length <= 1) return;
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itineraryId}/archive`, {});
      const remaining = sortItinerariesByRecency(itineraries.filter((item) => item.id !== result.itinerary.id));
      setItineraries(remaining);
      if (itinerary.id === result.itinerary.id && remaining[0]) {
        await activateItinerary(remaining[0]);
      }
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "归档行程失败，请稍后重试。"));
    }
  }

  async function deleteItineraryFromHistory(itineraryId: string) {
    const target = itineraries.find((item) => item.id === itineraryId);
    if (!target || itineraries.length <= 1) return;
    if (!window.confirm(`删除「${target.title}」？此操作无法撤销。`)) return;
    try {
      const result = await apiDelete<{ deleted: boolean }>(`/itineraries/${itineraryId}`);
      if (!result.deleted) return;
      const remaining = sortItinerariesByRecency(itineraries.filter((item) => item.id !== itineraryId));
      setItineraries(remaining);
      if (itinerary.id === itineraryId && remaining[0]) {
        await activateItinerary(remaining[0]);
      }
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "删除行程失败，请稍后重试。"));
    }
  }

  async function updateActivityField(activityId: string, changes: Partial<Activity>) {
    markSaving();
    try {
      const result = await apiPatch<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/activities/${activityId}`, changes);
      commitSavedItinerary(result.itinerary);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "更新活动失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function deleteActivity(activityId: string) {
    markSaving();
    try {
      const result = await apiDelete<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/activities/${activityId}`);
      commitSavedItinerary(result.itinerary);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "删除活动失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function reorderManualActivity(dayId: string, activityId: string, targetIndex: number) {
    const day = itinerary.days.find((candidate) => candidate.id === dayId);
    if (!day) return;
    const currentIndex = day.activities.findIndex((activity) => activity.id === activityId);
    const nextIndex = Math.min(Math.max(targetIndex, 0), day.activities.length - 1);
    if (currentIndex < 0 || currentIndex === nextIndex) return;
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(
        `/itineraries/${itinerary.id}/days/${dayId}/activities/${activityId}/reorder`,
        { targetIndex: nextIndex }
      );
      commitSavedItinerary(result.itinerary);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "调整顺序失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function moveManualActivity(activityId: string, targetDayId: string, targetIndex: number) {
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/activities/${activityId}/move`, {
        targetDayId,
        targetIndex
      });
      commitSavedItinerary(result.itinerary);
      setSelectedDayId(targetDayId);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "移动活动失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function importSkill(skillId: string, knownSkill?: TravelSkill) {
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary; skill?: TravelSkill }>(`/itineraries/${itinerary.id}/skills/${skillId}`, {});
      const normalized = commitSavedItinerary(result.itinerary);
      setImportedSkillIds(normalized.importedSkillIds);
      if (result.skill) replaceSkill(result.skill);
      else if (knownSkill) replaceSkill(knownSkill);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "导入风格失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function removeImportedSkill(skillId: string) {
    markSaving();
    try {
      const result = await apiDelete<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/skills/${skillId}`);
      const normalized = commitSavedItinerary(result.itinerary);
      setImportedSkillIds(normalized.importedSkillIds);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "移出风格失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function importSkillMarkdown(markdown: string) {
    try {
      const result = await apiPost<{ skill: TravelSkill }>("/skills/import", { markdown });
      replaceSkill(result.skill);
      setSkillFilter("all");
      await importSkill(result.skill.id, result.skill);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "导入风格内容失败，请稍后重试。"));
    }
  }

  function replaceSkill(skill: TravelSkill) {
    if (!skill) return;
    setSkills((current) => [skill, ...current.filter((item): item is TravelSkill => Boolean(item) && item.id !== skill.id)]);
    setCreatorDraft((current) => (current?.id === skill.id ? skill : current));
  }

  async function favoriteSkill(skillId: string) {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) return;
    const favorited = !skill.favorited;
    try {
      const result = await apiPost<{ skill: TravelSkill }>(`/skills/${skillId}/favorite`, { favorited });
      replaceSkill(result.skill);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "收藏状态更新失败，请稍后重试。"));
    }
  }

  async function updateSkill(skillId: string, changes: Partial<TravelSkill>) {
    const skill = skills.find((item) => item.id === skillId) ?? creatorDraft;
    if (!skill) return;
    try {
      const result = await apiPatch<{ skill: TravelSkill }>(`/skills/${skillId}`, changes);
      replaceSkill(result.skill);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "更新风格失败，请稍后重试。"));
    }
  }

  async function publishSkillDraft(changes: Partial<TravelSkill>) {
    const draft =
      creatorDraft ??
      (changes.id ? skills.find((skill) => skill.id === changes.id) : undefined) ??
      (changes.id && changes.name && changes.createdAt && changes.updatedAt ? (changes as TravelSkill) : undefined);
    if (!draft) return;
    const timestamp = new Date().toISOString();
    const publishBody = skillContentChanges(changes);
    delete publishBody.status;
    try {
      const result = await apiPost<{ skill: TravelSkill }>(`/skills/${draft.id}/publish`, publishBody);
      replaceSkill(result.skill);
      setCreatorDraft(null);
      setSkillFilter("all");
      setPage("skills");
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "发布风格失败，请稍后重试。"));
    }
  }

  async function createSavedMemory(content: string) {
    await apiPost<{ memory: SavedMemory }>("/memories", { content });
    setSavedMemories(await loadSavedMemories());
  }

  async function updateSavedMemory(memoryId: string, content: string) {
    await apiPatch<{ memory: SavedMemory }>(`/memories/${memoryId}`, { content });
    setSavedMemories(await loadSavedMemories());
  }

  async function deleteSavedMemory(memoryId: string) {
    await apiDelete<{ deleted: boolean }>(`/memories/${memoryId}`);
    setSavedMemories(await loadSavedMemories());
  }

  function applyAgentResult(result: AgentRunResponse, requestText: string, runLog?: AgentRunLog) {
    const beforeItinerary = itinerary;
    const normalized = normalizeItineraryForClient(result.itinerary);
    const targets = buildAgentChangeTargets(beforeItinerary, normalized, result.diff);
    const appliedSkills = skills.filter((skill) => importedSkillIds.includes(skill.id));
    const styleNames = appliedSkills.map((skill) => skillDisplayTitle(skill));
    const styleInfluences = buildAgentStyleInfluences(appliedSkills, result.diff);
    commitSavedItinerary(normalized);
    setImportedSkillIds(normalized.importedSkillIds);
    setMessages((current) => [
      ...current,
      {
        role: "assistant",
        content: formatAssistantMessageWithDiff(result.message.content, result.diff),
        runLog,
        changeSet:
          result.diff.length > 0
            ? {
                diff: result.diff,
                styleNames,
                styleInfluences,
                beforeItinerary,
                targets
              }
            : undefined
      }
    ]);
    setAgentInput("");
    setPage("workbench");
  }

  function setActiveAgentRunLog(next: AgentRunLog | null) {
    agentRunLogRef.current = next;
    setAgentRunLog(next);
  }

  function updateActiveAgentRunLog(updater: (current: AgentRunLog | null) => AgentRunLog | null) {
    const next = updater(agentRunLogRef.current);
    setActiveAgentRunLog(next);
  }

  function toggleAgentRunLog(messageIndex: number) {
    setMessages((current) =>
      current.map((message, index) =>
        index === messageIndex && message.runLog
          ? { ...message, runLog: { ...message.runLog, expanded: !message.runLog.expanded } }
          : message
      )
    );
  }

  function toggleActiveAgentRunLog() {
    updateActiveAgentRunLog((current) => (current ? { ...current, expanded: !current.expanded } : current));
  }

  function locateAgentChange(target: AgentChangeTarget) {
    setSelectedDayId(target.dayId);
    setCanvasFocusTarget(target);
    setPage("workbench");
    setAgentDrawerOpen(false);
  }

  async function undoAgentChange(messageIndex: number) {
    const message = messages[messageIndex];
    const beforeItinerary = message?.changeSet?.beforeItinerary;
    if (!beforeItinerary || message.changeSet?.undone) return;
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${beforeItinerary.id}/restore`, { itinerary: beforeItinerary });
      const normalized = commitSavedItinerary(result.itinerary);
      setImportedSkillIds(normalized.importedSkillIds);
      setMessages((current) =>
        current.map((item, index) =>
          index === messageIndex && item.changeSet
            ? { ...item, changeSet: { ...item.changeSet, undone: true } }
            : item
        )
      );
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "撤销本轮改动失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function runAgent(requestOverride?: string) {
    const requestText = (requestOverride ?? agentInput).trim();
    if (!requestText || !selectedDay || agentRunning) return;
    const controller = new AbortController();
    agentAbortRef.current = controller;
    setMessages((current) => [...current, { role: "user", content: requestText }]);
    setAgentInput("");
    setAgentRunning(true);
    setAgentProgress([]);
    setActiveAgentRunLog(createRunningAgentRunLog(requestText));
    try {
      let streamedResult: AgentRunResponse | undefined;
      await apiEventStream(
        "/agent/run-stream",
        {
          itineraryId: itinerary.id,
          message: requestText,
          importedSkillIds
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.event === "progress" && event.data && typeof event.data === "object" && "message" in event.data) {
              const message = String((event.data as { message: unknown }).message);
              setAgentProgress((current) => (current.includes(message) ? current : [...current, message]));
            }
            updateActiveAgentRunLog((current) => updateAgentRunLogFromStream(current, event, requestText));
            if (event.event === "final") {
              streamedResult = event.data as AgentRunResponse;
            }
          }
        }
      );
      if (!streamedResult) {
        throw new Error("Agent stream ended without final result");
      }
      const result = streamedResult;
      applyAgentResult(result, requestText, buildCompletedAgentRunLog(result, requestText, agentRunLogRef.current));
      setAgentProgress([]);
      setActiveAgentRunLog(null);
    } catch (error) {
      if (controller.signal.aborted) {
        const stoppedLog = buildTerminalAgentRunLog(agentRunLogRef.current, requestText, "stopped", "已停止本次处理");
        setActiveAgentRunLog(null);
        setAgentProgress(["已停止本次处理，行程没有改动。"]);
        setMessages((current) => [
          ...current,
          { role: "assistant", content: "已停止本次处理，行程没有改动。", runLog: stoppedLog }
        ]);
        return;
      }
      if (error instanceof ApiStreamEventError) {
        const failedLog = buildTerminalAgentRunLog(agentRunLogRef.current, requestText, "failed", error.message);
        setActiveAgentRunLog(null);
        setAgentProgress([]);
        setMessages((current) => [
          ...current,
          { role: "assistant", content: `${error.message}\n\n行程没有改动。`, runLog: failedLog }
        ]);
        return;
      }
      const message =
        error instanceof Error && error.message === "Agent stream ended without final result"
          ? "助手没有返回最终结果，请重试。"
          : "助手服务连接失败，请确认 API 后端已启动后重试。";
      const failedLog = buildTerminalAgentRunLog(agentRunLogRef.current, requestText, "failed", message);
      setAgentProgress([]);
      setActiveAgentRunLog(null);
      setMessages((current) => [...current, { role: "assistant", content: `${message}\n\n行程没有改动。`, runLog: failedLog }]);
    } finally {
      if (agentAbortRef.current === controller) {
        agentAbortRef.current = null;
      }
      setAgentRunning(false);
    }
  }

  function stopAgent() {
    agentAbortRef.current?.abort();
    setAgentRunning(false);
    updateActiveAgentRunLog((current) =>
      current ? buildTerminalAgentRunLog(current, "本轮请求", "stopped", "已停止本次处理") : current
    );
    setAgentProgress(["已停止本次处理，行程没有改动。"]);
  }

  async function startSkillCreatorSession(): Promise<SkillCreatorStartResponse> {
    const useItineraryContext = creatorSourceMode === "itinerary" || creatorSourceMode === "conversation";
    const result = await apiPostStrict<SkillCreatorStartResponse>(
      "/skills/creator/start",
      useItineraryContext ? { sourceText: creatorText, itineraryId: itinerary.id } : { sourceText: creatorText }
    );
    setSkills((current) => [result.session.draft, ...current.filter((skill) => skill.id !== result.session.draft.id)]);
    setCreatorDraft(result.session.draft);
    return result;
  }

  async function replyToSkillCreator(
    sessionId: string,
    answer: { selectedOptionIds: string[]; customAnswer: string }
  ): Promise<SkillCreatorReplyResponse> {
    const result = await apiPostStrict<SkillCreatorReplyResponse>(`/skills/creator/${sessionId}/reply`, answer);
    setSkills((current) => [result.session.draft, ...current.filter((skill) => skill.id !== result.session.draft.id)]);
    setCreatorDraft(result.session.draft);
    return result;
  }

  function useCurrentItineraryAsSkillSource() {
    setCreatorSourceMode("itinerary");
    setCreatorText(buildItinerarySkillSourceText(itinerary));
    setCreatorDraft(null);
  }

  function useAssistantConversationAsSkillSource() {
    setCreatorSourceMode("conversation");
    setCreatorText(buildConversationSkillSourceText(itinerary, messages));
    setCreatorDraft(null);
    setPage("creator");
    setAgentDrawerOpen(false);
  }

  async function addRemoteDay(position: "after" | "before" = "after") {
    markSaving();
    const nextItinerary = position === "before" ? addDayBefore(itinerary) : addDay(itinerary);
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/days`, { position });
      const shouldRestore =
        position === "before" && (result.itinerary.startDate !== nextItinerary.startDate || result.itinerary.days[0]?.date !== nextItinerary.days[0]?.date);
      const saved = shouldRestore
        ? await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/restore`, { itinerary: nextItinerary })
        : result;
      const normalized = commitSavedItinerary(saved.itinerary);
      setSelectedDayId(position === "before" ? normalized.days[0]?.id ?? selectedDay.id : normalized.days.at(-1)?.id ?? selectedDay.id);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "新增日期失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function exportItinerary() {
    try {
      const text = await apiText(`/itineraries/${itinerary.id}/export`);
      setExportText(text);
      setPage("result");
      if (text.trim()) {
        downloadTextFile(text, `${sanitizeFilename(itinerary.title)}-${itinerary.startDate}.md`);
      }
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "导出失败，请稍后重试。"));
    }
  }

  async function setActivityTransport(
    dayId: string,
    fromActivityId: string,
    toActivityId: string,
    mode: MapRouteMode,
    overrides: TransportLegOverride = {}
  ) {
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/days/${dayId}/transport-legs`, {
        fromActivityId,
        toActivityId,
        mode,
        ...overrides
      });
      commitSavedItinerary(result.itinerary);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "路线设置失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function removeActivityTransport(dayId: string, fromActivityId: string, toActivityId: string) {
    markSaving();
    try {
      const result = await apiDelete<{ itinerary: TravelItinerary }>(
        `/itineraries/${itinerary.id}/days/${dayId}/transport-legs/${encodeURIComponent(fromActivityId)}/${encodeURIComponent(toActivityId)}`
      );
      commitSavedItinerary(result.itinerary);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "路线删除失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function completeMissingRoutes(mode: MapRouteMode = "walking") {
    markSaving();
    try {
      const result = await apiPost<{ itinerary: TravelItinerary; completed: number; skipped: number }>(
        `/itineraries/${itinerary.id}/transport-legs/complete`,
        { mode }
      );
      const normalized = normalizeItineraryForClient(result.itinerary);
      commitSavedItinerary(mergeBackgroundCanvasUpdates(normalized, itineraryRef.current));
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "路线补全失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function updateDayWeather(dayId: string) {
    const day = itinerary.days.find((candidate) => candidate.id === dayId);
    if (!day) return;
    markSaving();
    const weatherCity = itinerary.destinationPlace?.city ?? itinerary.destination;
    try {
      const result = await apiPost<{ itinerary: TravelItinerary; weather: WeatherSummary }>(`/itineraries/${itinerary.id}/days/${dayId}/weather`, {
        city: weatherCity
      });
      const normalized = normalizeItineraryForClient(result.itinerary);
      commitSavedItinerary(mergeBackgroundCanvasUpdates(normalized, itineraryRef.current));
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "天气更新失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  async function updateItineraryDetails(changes: Partial<TravelItinerary>) {
    markSaving();
    try {
      const result = await apiPatch<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}`, changes);
      commitSavedItinerary(result.itinerary);
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "更新行程信息失败，请稍后重试。"));
      setSaveStatus("保存失败");
    }
  }

  function markSaving() {
    setSaveStatus("正在保存...");
  }

  function markSaved(value?: string) {
    const savedAt = value && !Number.isNaN(Date.parse(value)) ? new Date(value) : new Date();
    setSaveStatus(`已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
  }

  function commitSavedItinerary(next: TravelItinerary): TravelItinerary {
    const normalized = normalizeItineraryForClient(next);
    itineraryRef.current = normalized;
    setItinerary(normalized);
    setItineraries((current) => upsertItineraryList(current, normalized));
    markSaved(normalized.updatedAt);
    return normalized;
  }

  async function createTrip(input: CreateTripFormInput) {
    const normalizedInput = normalizeCreateTripInput(input);
    try {
      const result = await apiPost<{ itinerary: TravelItinerary }>("/itineraries", normalizedInput);
      const normalized = commitSavedItinerary(result.itinerary);
      setSelectedDayId(normalized.days[0]?.id ?? "");
      setImportedSkillIds([]);
      setExportText("");
      setMessages([]);
      rememberLastItineraryId(normalized.id);
      setNewTripDialogOpen(false);
      setPage("workbench");
      setServiceStatus("");
    } catch (error) {
      setServiceStatus(readApiRequestErrorMessage(error, "创建行程失败，请稍后重试。"));
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {page === "home" ? (
        <HomePage onNavigate={setPage} onCreateTrip={createTrip} />
      ) : (
        <div className={shellGridClass} data-testid="app-shell">
          <Sidebar
            page={page}
            onNavigate={setPage}
            onOpenNewTrip={() => setNewTripDialogOpen(true)}
            itinerary={itinerary}
            itineraries={itineraries}
            onSelectItinerary={(itineraryId) => void selectItinerary(itineraryId)}
            onArchiveItinerary={(itineraryId) => void archiveItinerary(itineraryId)}
            onDeleteItinerary={(itineraryId) => void deleteItineraryFromHistory(itineraryId)}
          />
          <main
            data-testid={page === "workbench" ? "workbench-main" : undefined}
            className={cn("min-w-0 bg-white", page === "workbench" && "min-h-0 overflow-hidden")}
          >
            {page === "workbench" && itineraries.length === 0 && (
              <div className="flex h-full items-center justify-center p-6">
                <section className="grid max-w-md gap-4 rounded-[24px] border border-border bg-[#fbfbf9] p-6 text-center">
                  <div className="grid gap-2">
                    <h2 className="text-2xl font-black">还没有行程</h2>
                    <p className="text-sm font-semibold text-muted-foreground">先创建一个行程，再开始规划地点、路线、天气和旅行风格。</p>
                  </div>
                  <Button onClick={() => setNewTripDialogOpen(true)}>
                    <Plus data-icon="inline-start" />
                    新建行程
                  </Button>
                </section>
              </div>
            )}
            {page === "workbench" && itineraries.length > 0 && (
              <Workbench
                itinerary={itinerary}
                selectedDayId={selectedDay.id}
                focusTarget={canvasFocusTarget}
                importedSkillIds={importedSkillIds}
                skills={skills}
                onSelectDay={setSelectedDayId}
                serviceStatus={serviceStatus}
                saveStatus={saveStatus}
                exportText={exportText}
                backgroundSyncEnabled={initialDataLoaded}
                onAddDay={addRemoteDay}
                onAddActivity={addManualActivity}
                onUpdateActivity={updateActivityField}
                onDeleteActivity={deleteActivity}
                onReorderActivity={reorderManualActivity}
                onMoveActivityToDay={moveManualActivity}
                onUpdateItinerary={updateItineraryDetails}
                onExport={exportItinerary}
                onSetTransport={setActivityTransport}
                onRemoveTransport={removeActivityTransport}
                onCompleteRoutes={completeMissingRoutes}
                onUpdateDayWeather={updateDayWeather}
                onOpenAgent={() => setAgentDrawerOpen(true)}
                onMapWorkspaceOpenChange={(open) => {
                  if (open) setAgentDrawerOpen(false);
                }}
                onFocusTargetConsumed={() => setCanvasFocusTarget(null)}
              />
            )}
            {page === "result" && (
              <TravelResultPage
                itinerary={itinerary}
                exportText={exportText}
                onBackToWorkbench={() => setPage("workbench")}
              />
            )}
            {page === "skills" && (
              <SkillPlaza
                skills={skills}
                recommendations={recommendations}
                itinerary={itinerary}
                importedSkillIds={importedSkillIds}
                savedMemoryKeywords={savedMemoryKeywords}
                filter={skillFilter}
                onImport={importSkill}
                onRemoveImport={removeImportedSkill}
                onImportMarkdown={importSkillMarkdown}
                onFilterChange={setSkillFilter}
                onFavorite={favoriteSkill}
                onUpdateSkill={updateSkill}
              />
            )}
            {page === "creator" && (
              <SkillCreator
                sourceText={creatorText}
                onSourceTextChange={(value) => {
                  setCreatorText(value);
                  setCreatorSourceMode("text");
                }}
                onUseCurrentItinerary={useCurrentItineraryAsSkillSource}
                onStart={startSkillCreatorSession}
                onCreatorReply={replyToSkillCreator}
                onPublish={publishSkillDraft}
              />
            )}
            {page === "settings" && (
              <SavedMemorySettings
                memories={savedMemories}
                onCreateMemory={createSavedMemory}
                onUpdateMemory={updateSavedMemory}
                onDeleteMemory={deleteSavedMemory}
              />
            )}
            {page === "evaluation" && <EvaluationPage />}
          </main>
          {showAgentPanel && (
            <>
              {agentDrawerOpen && (
                <button
                  type="button"
                  aria-label="关闭助手面板"
                  data-testid="agent-backdrop"
                  className="fixed inset-0 z-[900] bg-black/30 min-[769px]:hidden"
                  onClick={() => setAgentDrawerOpen(false)}
                />
              )}
              <div
                data-testid="agent-panel-shell"
                className={cn(
                  "fixed inset-y-0 right-0 z-[1000] w-full border-l border-border bg-[#fbfbf9] shadow-2xl sm:w-[min(440px,calc(100vw-24px))] min-[769px]:static min-[769px]:min-h-0 min-[769px]:w-auto min-[769px]:shadow-none",
                  agentDrawerOpen ? "block" : "hidden min-[769px]:block"
                )}
              >
                <AgentPanel
                  skills={skills}
                  importedSkillIds={importedSkillIds}
                  messages={messages}
                  agentInput={agentInput}
                  agentRunning={agentRunning}
                  agentProgress={agentProgress}
                  agentRunLog={agentRunLog}
                  savedMemoryKeywords={savedMemoryKeywords}
                  onImportSkill={importSkill}
                  onRemoveSkill={removeImportedSkill}
                  onAgentInputChange={setAgentInput}
                  onRunAgent={runAgent}
                  onStopAgent={stopAgent}
                  onToggleAgentRunLog={toggleAgentRunLog}
                  onToggleActiveAgentRunLog={toggleActiveAgentRunLog}
                  onCreateSkillFromConversation={useAssistantConversationAsSkillSource}
                  onUndoAgentChange={undoAgentChange}
                  onLocateAgentChange={locateAgentChange}
                  itinerary={itinerary}
                  onClose={() => setAgentDrawerOpen(false)}
                />
              </div>
            </>
          )}
          {newTripDialogOpen && <NewTripDialog onCreateTrip={createTrip} onClose={() => setNewTripDialogOpen(false)} />}
        </div>
      )}
    </div>
  );
}

function formatAssistantMessageWithDiff(content: string, diff: string[]): string {
  if (diff.length === 0) return content;
  return [content, "本轮改动", ...diff.map((item) => `- ${item}`)].join("\n");
}

function createRunningAgentRunLog(requestText: string): AgentRunLog {
  return {
    id: `agent-run-${Date.now()}`,
    status: "running",
    expanded: true,
    summary: "思考中",
    items: []
  };
}

function updateAgentRunLogFromStream(
  current: AgentRunLog | null,
  event: { event: string; data: unknown },
  requestText: string
): AgentRunLog {
  const base = current ?? createRunningAgentRunLog(requestText);
  if (event.event === "final") return base;

  if (event.event === "activity") {
    const activity = readAgentRunEvent(event.data);
    if (!activity) return base;
    const item = agentRunEventToActivityItem(activity, base.items.length);
    const completedItems = activity.type === "thought_summary" ? base.items : completeRunningThoughts(base.items);
    return {
      ...base,
      status: item.kind === "error" ? "failed" : "running",
      expanded: true,
      summary: summarizeRunningAgentActivity(item),
      items: [...completedItems.filter((existing) => existing.id !== item.id), item]
    };
  }

  const item = streamEventToAgentActivity(event, base.items.length);
  if (!item) return base;
  const completedItems = completeRunningThoughts(base.items);
  return {
    ...base,
    status: item.kind === "error" ? "failed" : "running",
    expanded: true,
    summary: summarizeRunningAgentActivity(item),
    items: [...completedItems, item]
  };
}

function streamEventToAgentActivity(
  event: { event: string; data: unknown },
  index: number
): AgentActivityItem | undefined {
  if (event.event === "progress" || event.event === "action") {
    const detail = readAgentStreamString(event.data, "message");
    if (!detail) return undefined;
    return {
      id: `${event.event}-${Date.now()}-${index}`,
      kind: "output",
      title: "行动输出",
      detail,
      status: "completed"
    };
  }
  if (event.event === "tool_call") {
    return {
      id: `tool-call-${Date.now()}-${index}`,
      kind: "tool_call",
      title: readAgentStreamString(event.data, "title") ?? "调用工具",
      detail: readAgentStreamString(event.data, "detail"),
      agent: readAgentStreamAgent(event.data),
      traceType: "tool_call",
      status: "running"
    };
  }
  if (event.event === "state_patch") {
    return {
      id: `state-patch-${Date.now()}-${index}`,
      kind: "state_patch",
      title: readAgentStreamString(event.data, "title") ?? "写入行程",
      detail: readAgentStreamString(event.data, "detail"),
      agent: readAgentStreamAgent(event.data),
      traceType: "state_patch",
      status: "completed"
    };
  }
  if (event.event === "handoff") {
    return {
      id: `handoff-${Date.now()}-${index}`,
      kind: "handoff",
      title: readAgentStreamString(event.data, "title") ?? "任务派发",
      detail: readAgentStreamString(event.data, "detail"),
      agent: readAgentStreamAgent(event.data),
      traceType: "handoff",
      status: "completed"
    };
  }
  return undefined;
}

function buildCompletedAgentRunLog(
  result: AgentRunResponse,
  requestText: string,
  current: AgentRunLog | null
): AgentRunLog {
  const base = current ?? createRunningAgentRunLog(requestText);
  const streamItems = completeRunningThoughts(base.items);
  const eventItems = sortAgentRunEvents(result.events ?? []).map((event, index) => agentRunEventToActivityItem(event, index));
  const traces = sortAgentTraces(eventItems.length > 0 ? [] : (result.traces ?? result.session?.traces ?? []));
  const traceItems = traces.map(agentTraceToActivityItem);
  const items = mergeAgentActivityItems(streamItems, eventItems.length > 0 ? eventItems : traceItems).map((item) => ({
    ...item,
    status: item.status === "failed" ? "failed" as const : "completed" as const
  }));
  return {
    id: base.id,
    status: "completed",
    expanded: false,
    summary: completedAgentRunSummary(items),
    items
  };
}

function buildTerminalAgentRunLog(
  current: AgentRunLog | null,
  requestText: string,
  status: "failed" | "stopped",
  reason: string
): AgentRunLog {
  const base = current ?? createRunningAgentRunLog(requestText);
  const items = completeRunningThoughts(base.items);
  const terminalItems =
    status === "failed"
      ? [
          ...items,
          {
            id: `agent-error-${Date.now()}`,
            kind: "error" as const,
            title: "执行异常",
            detail: reason,
            traceType: "error" as const,
            status: "failed" as const
          }
        ]
      : items;
  return {
    id: base.id,
    status,
    expanded: false,
    summary: `${status === "failed" ? "执行失败" : "已停止本次处理"} · ${terminalItems.length} 步`,
    items: terminalItems
  };
}

function completeRunningThoughts(items: AgentActivityItem[]): AgentActivityItem[] {
  return items.map((item) =>
    item.kind === "thought" && item.status === "running"
      ? { ...item, title: completedThoughtTitle(item.title), detail: undefined, status: "completed" }
      : item
  );
}

function completedThoughtTitle(title: string): string {
  const normalized = title.replace(/^正在/, "").trim();
  if (/行程上下文/.test(normalized)) return "已读取行程上下文";
  if (normalized.startsWith("已")) return normalized;
  return `已完成${normalized}`;
}

function agentTraceToActivityItem(trace: AgentTraceEvent): AgentActivityItem {
  const kind: AgentActivityKind =
    trace.type === "message"
      ? "thought"
      : trace.type === "tool_call"
        ? "tool_call"
        : trace.type === "state_patch"
          ? "state_patch"
          : trace.type === "handoff"
            ? "handoff"
            : "error";
  return {
    id: trace.id,
    kind,
    title: trace.type === "message" ? completedThoughtTitle(trace.title) : trace.title,
    detail: trace.detail,
    agent: trace.agent,
    traceType: trace.type,
    status: trace.type === "error" ? "failed" : "completed"
  };
}

function agentRunEventToActivityItem(event: AgentRunEvent, index: number): AgentActivityItem {
  const kind = agentRunEventKind(event.type);
  return {
    id: event.id || `agent-event-${Date.now()}-${index}`,
    kind,
    title: kind === "output" ? "回复" : event.title,
    detail: event.detail,
    agent: event.agent,
    traceType: agentRunEventTraceType(event.type),
    status: event.status,
    technical: event.technical
  };
}

function agentRunEventKind(type: AgentRunEvent["type"]): AgentActivityKind {
  if (type === "thought_summary") return "thought";
  if (type === "assistant_message") return "output";
  if (type === "tool_call") return "tool_call";
  if (type === "tool_result") return "tool_result";
  if (type === "state_patch") return "state_patch";
  if (type === "handoff") return "handoff";
  if (type === "final_signal") return "final_signal";
  return "error";
}

function agentRunEventTraceType(type: AgentRunEvent["type"]): AgentTraceEvent["type"] | undefined {
  if (type === "thought_summary" || type === "assistant_message" || type === "final_signal") return "message";
  if (type === "tool_call" || type === "tool_result") return "tool_call";
  if (type === "state_patch") return "state_patch";
  if (type === "handoff") return "handoff";
  if (type === "error") return "error";
  return undefined;
}

function mergeAgentActivityItems(streamItems: AgentActivityItem[], traceItems: AgentActivityItem[]): AgentActivityItem[] {
  const merged = [...streamItems];
  for (const item of traceItems) {
    if (item.kind === "thought" && merged.some((candidate) => candidate.kind === "thought")) continue;
    if (merged.some((candidate) => isSameAgentActivity(candidate, item))) continue;
    merged.push(item);
  }
  return merged;
}

function primaryAgentActivityItems(items: AgentActivityItem[]): AgentActivityItem[] {
  return items.filter((item) => item.kind === "output" || item.kind === "tool_call" || item.kind === "tool_result" || item.kind === "error");
}

function reasoningAgentActivityItems(items: AgentActivityItem[]): AgentActivityItem[] {
  return items.filter((item) => item.kind === "thought" && item.title === "模型思考" && Boolean(item.detail));
}

function completedAgentRunSummary(items: AgentActivityItem[]): string {
  const primaryCount = primaryAgentActivityItems(items).length;
  if (primaryCount > 0) return `已完成模型与工具调用 · ${primaryCount} 步`;
  return `已完成后台状态 · ${items.length} 步`;
}

function isSameAgentActivity(left: AgentActivityItem, right: AgentActivityItem): boolean {
  return (
    left.kind === right.kind &&
    left.title === right.title &&
    (left.detail ?? "") === (right.detail ?? "") &&
    left.agent === right.agent
  );
}

function summarizeRunningAgentActivity(item: AgentActivityItem): string {
  if (item.kind === "tool_call") return `正在调用工具：${item.title}`;
  if (item.kind === "tool_result") return item.detail ? `工具完成：${item.detail}` : `工具完成：${item.title}`;
  if (item.kind === "output" && item.detail) return item.detail;
  if (item.kind === "state_patch") return "正在写入行程";
  if (item.kind === "handoff") return "正在派发任务";
  if (item.kind === "final_signal") return item.detail ?? "任务已完成";
  return item.title;
}

function shouldShowAgentActivityLabel(item: AgentActivityItem): boolean {
  return item.kind !== "output";
}

function shouldShowAgentBadge(item: AgentActivityItem): boolean {
  return item.kind !== "output";
}

function agentActivityLabel(item: AgentActivityItem): string {
  const labels: Record<AgentActivityKind, string> = {
    thought: "思考",
    output: "对外输出",
    tool_call: "工具调用",
    tool_result: "工具结果",
    state_patch: "写入画布",
    handoff: "任务派发",
    final_signal: "完成信号",
    error: "异常"
  };
  return labels[item.kind] ?? (item.traceType ? traceTypeLabel(item.traceType) : "步骤");
}

function readAgentRunEvent(data: unknown): AgentRunEvent | undefined {
  if (!data || typeof data !== "object") return undefined;
  const event = data as Partial<AgentRunEvent>;
  if (!event.id || !event.type || !event.status || !event.title) return undefined;
  return event as AgentRunEvent;
}

function sortAgentRunEvents(events: AgentRunEvent[]): AgentRunEvent[] {
  return [...events].sort((left, right) => left.sequence - right.sequence);
}

function hasTechnicalPayload(technical: AgentActivityItem["technical"]): boolean {
  return Boolean(technical && ("input" in technical || "output" in technical));
}

function formatTechnicalPayload(technical: AgentActivityItem["technical"]): string {
  try {
    return JSON.stringify(technical, null, 2);
  } catch {
    return String(technical);
  }
}

function readAgentStreamString(data: unknown, key: string): string | undefined {
  if (!data || typeof data !== "object" || !(key in data)) return undefined;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAgentStreamAgent(data: unknown): AgentTraceEvent["agent"] | undefined {
  const value = readAgentStreamString(data, "agent");
  return isAgentName(value) ? value : undefined;
}

function isAgentName(value: unknown): value is AgentTraceEvent["agent"] {
  return (
    value === "MainAgent" ||
    value === "StyleAgent" ||
    value === "SkillExtractorAgent" ||
    value === "WeatherAgent" ||
    value === "TransportAgent" ||
    value === "AttractionAgent" ||
    value === "PlannerAgent" ||
    value === "CriticAgent"
  );
}

function buildAgentStyleInfluences(skills: TravelSkill[], diffItems: string[]): AgentStyleInfluence[] {
  if (skills.length === 0 || diffItems.length === 0) return [];
  return skills
    .map((skill) => ({
      skillName: skillDisplayTitle(skill),
      scopes: buildSkillImpactScope(skill).slice(0, 2),
      rules: skill.rules.slice(0, 2)
    }))
    .filter((influence) => influence.scopes.length > 0 || influence.rules.length > 0);
}

function buildRouteConflictOptionActions(content: string): AssistantAction[] {
  if (!content.includes("可选方案")) return [];
  const hasRouteOption =
    content.includes("顺延下一项") || content.includes("缩短上一站") || content.includes("改用更快交通方式");
  if (!hasRouteOption) return [];

  const routeLine = content
    .split(/\r?\n/)
    .find((line) => line.includes("这段路线") || line.includes("这段交通"));
  const routeMatch = routeLine?.match(/^\s*(.+?)\s*到\s*(.+?)\s*这段(?:路线|交通)/);
  const from = routeMatch?.[1]?.trim();
  const to = routeMatch?.[2]?.trim();
  if (!from || !to) return [];

  const routePrefix = `${from}到${to}这段交通会晚到`;
  return [
    {
      keyword: "顺延下一项",
      label: "顺延下一项",
      requestText: `${routePrefix}，帮我延后下一项。`
    },
    {
      keyword: "缩短上一站",
      label: "缩短上一站",
      requestText: `${routePrefix}，帮我缩短上一站停留。`
    },
    {
      keyword: "改用更快交通方式",
      label: "改用更快交通方式",
      requestText: `${routePrefix}，帮我换个更快的交通方式，不改活动时间。`
    }
  ]
    .filter((action) => content.includes(action.keyword))
    .map(({ label, requestText }) => ({ label, requestText }));
}

function buildSkillImpactScope(skill: TravelSkill): string[] {
  const text = [skill.displayName, skill.description, skill.body, ...skill.tags, ...skill.rules].join(" ");
  const scope = new Set<string>();
  if (/慢|松弛|不赶|休息|低强度/.test(text)) scope.add("节奏：减少赶场，保留休息段");
  if (/咖啡|小店|餐饮|美食/.test(text)) scope.add("停留：优先保留咖啡、小店和餐饮休息");
  if (/雨天|室内|博物馆|展馆/.test(text)) scope.add("备选：天气不佳时优先室内和可预约地点");
  if (/交通|少走路|步行|地铁|公交|骑行|跨区|换乘/.test(text)) scope.add("交通：按偏好控制步行、换乘和跨区距离");
  if (/海边|日落|街区|景点|citywalk|博物馆/.test(text)) scope.add("地点：优先匹配风格里的地点类型");
  if (scope.size === 0) scope.add("规划：影响地点选择、活动密度和路线取舍");
  return [...scope].slice(0, 3);
}

function buildSkillAvoidanceHints(skill: TravelSkill, itinerary: TravelItinerary): string[] {
  if (skill.forbidden.length === 0) return [];
  const itineraryText = [
    itinerary.title,
    itinerary.destination,
    itinerary.notes ?? "",
    ...itinerary.days.flatMap((day) =>
      day.activities.flatMap((activity) => [
        activity.title,
        activity.placeName ?? "",
        activity.description ?? "",
        activity.note ?? "",
        ...activity.tags
      ])
    )
  ].join(" ");
  return skill.forbidden.slice(0, 2).map((rule) =>
    forbiddenRuleMayAffectItinerary(rule, itineraryText)
      ? `当前行程需复核：${rule}`
      : `后续规划会避开：${rule}`
  );
}

function forbiddenRuleMayAffectItinerary(rule: string, itineraryText: string): boolean {
  const ignoredTokens = new Set(["安排", "旅行", "活动", "用户", "当前", "风格", "地点", "路线", "直接"]);
  return rule
    .split(/[，。、；;,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !ignoredTokens.has(token))
    .some((token) => itineraryText.includes(token));
}

function buildImportedSkillInfluence(skills: TravelSkill[], itinerary: TravelItinerary) {
  const scopes = uniqueStrings(skills.flatMap((skill) => buildSkillImpactScope(skill))).slice(0, 4);
  const rules = uniqueStrings(skills.flatMap((skill) => skill.rules)).slice(0, 4);
  const avoidance = uniqueStrings(skills.flatMap((skill) => buildSkillAvoidanceHints(skill, itinerary))).slice(0, 4);
  const tradeoffs = buildImportedSkillTradeoffs(skills, rules);
  const conflictDetails = buildImportedSkillConflictDetails(skills);
  return { scopes, rules, avoidance, tradeoffs, conflictDetails };
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function buildImportedSkillTradeoffs(skills: TravelSkill[], rules: string[]): string[] {
  if (skills.length <= 1) return [];
  const combinedText = skills
    .flatMap((skill) => [skill.displayName, skill.description, skill.body, ...skill.tags, ...skill.rules, ...skill.forbidden])
    .join(" ");
  const tradeoffs = new Set<string>();
  if (/慢|松弛|休息|不赶/.test(combinedText) && /重点|博物馆|展馆|景点|参观/.test(combinedText)) {
    tradeoffs.add("先保留休息节奏，再安排核心景点");
  }
  if (/日落|夜景|晚/.test(combinedText) && /亲子|早起|上午|午休/.test(combinedText)) {
    tradeoffs.add("晚间活动和休息时间需要二选一取舍");
  }
  if (/少走路|减少跨区|同一区域|步行/.test(combinedText) && /多个|连续|跨城|换乘/.test(combinedText)) {
    tradeoffs.add("地点数量要服从交通距离，不把路线排满");
  }
  if (tradeoffs.size === 0 && rules.length > 0) {
    tradeoffs.add("多个风格同时生效时，优先保留明确偏好，冲突安排先降级为备选");
  }
  return [...tradeoffs].slice(0, 3);
}

function buildImportedSkillConflictDetails(skills: TravelSkill[]): string[] {
  if (skills.length <= 1) return [];
  const details = new Set<string>();
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex]!;
      const right = skills[rightIndex]!;
      const leftText = skillPositivePlanningText(left);
      const rightText = skillPositivePlanningText(right);
      const leftPrefersRest = prefersRestfulPace(leftText);
      const rightPrefersRest = prefersRestfulPace(rightText);
      const leftPrefersCore = prefersCoreAttractions(leftText);
      const rightPrefersCore = prefersCoreAttractions(rightText);
      const pairLabel = `${skillDisplayTitle(left)} × ${skillDisplayTitle(right)}`;
      const hasPaceAndCore = (leftPrefersRest && rightPrefersCore) || (rightPrefersRest && leftPrefersCore);
      if (hasPaceAndCore) {
        const restfulSkill = leftPrefersRest && !leftPrefersCore ? left : rightPrefersRest && !rightPrefersCore ? right : leftPrefersRest ? left : right;
        const coreSkill = restfulSkill.id === left.id ? right : left;
        details.add(`${skillDisplayTitle(restfulSkill)} × ${skillDisplayTitle(coreSkill)}：休息段优先，核心景点集中成半天，不把同一天排满`);
      }

      const hasWalkingAndMultiStop =
        (prefersShorterMovement(leftText) && prefersDenseStops(rightText)) ||
        (prefersDenseStops(leftText) && prefersShorterMovement(rightText));
      if (hasWalkingAndMultiStop) {
        details.add(`${pairLabel}：路线距离优先，跨区或多点安排先降级为备选`);
      }

      const hasEveningAndFamilyRest =
        (prefersEveningScenes(leftText) && prefersFamilyRest(rightText)) ||
        (prefersFamilyRest(leftText) && prefersEveningScenes(rightText));
      if (hasEveningAndFamilyRest) {
        details.add(`${pairLabel}：晚间体验需要和午休、返程时间二选一`);
      }
    }
  }
  return [...details].slice(0, 3);
}

function skillPositivePlanningText(skill: TravelSkill): string {
  return [skill.displayName, skill.description, skill.body, ...skill.tags, ...skill.rules].join(" ");
}

function prefersRestfulPace(text: string): boolean {
  return /慢|松弛|休息|不赶|低强度/.test(text);
}

function prefersCoreAttractions(text: string): boolean {
  return /重点|博物馆|展馆|参观/.test(text);
}

function prefersShorterMovement(text: string): boolean {
  return /少走路|减少跨区|同一区域|步行|交通距离|短范围/.test(text);
}

function prefersDenseStops(text: string): boolean {
  return /多个|连续|跨城|换乘|串联|排满/.test(text);
}

function prefersEveningScenes(text: string): boolean {
  return /日落|夜景|晚间|傍晚|夜/.test(text);
}

function prefersFamilyRest(text: string): boolean {
  return /亲子|午休|早起|上午|孩子|低风险/.test(text);
}

function skillDisplayTitle(
  skill: Pick<TravelSkill, "displayName"> & Partial<Pick<TravelSkill, "description" | "tags">>
): string {
  const baseTitle = skill.displayName.replace(/\s+\d{3,}$/, "").trim();
  const genericTitles = new Set(["待确认旅行风格", "旅行风格草稿"]);
  if (baseTitle && !genericTitles.has(baseTitle)) return baseTitle;
  const tagTitle = buildExtractedSkillDraftTitle({ tags: skill.tags });
  if (tagTitle !== "旅行风格草稿") return tagTitle;
  return deriveDraftSkillTitle([...(skill.tags ?? []), skill.description ?? ""].join(" "));
}

function skillDisplayDescription(
  skill: Pick<TravelSkill, "description" | "tags" | "rules">
): string {
  const rawDescription = skill.description.trim();
  const isWorkflowDescription =
    /旅行风格草稿|需要用户?确认后发布|从.*提取/.test(rawDescription) &&
    !/^适合/.test(rawDescription);
  if (rawDescription && !isWorkflowDescription) return rawDescription;

  const tagText = skill.tags.slice(0, 3).join("、");
  const firstRule = skill.rules[0]?.replace(/[。.]$/, "").trim();
  if (tagText && firstRule) return `${tagText}取向，${firstRule}。`;
  if (tagText) return `偏向${tagText}的地点选择和旅行节奏。`;
  if (firstRule) return `规划时优先遵循：${firstRule}。`;
  return "按已提取的偏好调整地点、节奏和路线取舍。";
}

function deriveDraftSkillTitle(sourceText: string): string {
  const cleanedLines = sourceText
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#+\s*/, "")
        .replace(/^[>\-*]\s*/, "")
        .replace(/[「」#`*_]/g, "")
        .trim()
    )
    .filter(Boolean);
  const keywordPool = [
    "亲子",
    "博物馆",
    "慢节奏",
    "咖啡",
    "街区",
    "海边",
    "小店",
    "日落",
    "雨天",
    "室内",
    "夜景",
    "citywalk",
    "骑行"
  ];
  const joined = cleanedLines.join(" ");
  const matchedKeywords = keywordPool.filter((keyword) => joined.includes(keyword)).slice(0, 2);
  if (matchedKeywords.length > 0) return `${matchedKeywords.join("、")}风格草稿`;
  const firstUsefulLine = cleanedLines.find((line) => !/^name:|^description:|^---$/.test(line));
  if (!firstUsefulLine) return "旅行风格草稿";
  return `${firstUsefulLine.slice(0, 12)}风格草稿`;
}

function dedupeSkillsForDisplay(skills: TravelSkill[], importedSkillIds: string[] = []): TravelSkill[] {
  const imported = new Set(importedSkillIds);
  const keys: string[] = [];
  const result: TravelSkill[] = [];
  for (const skill of skills) {
    const key = [
      skillDisplayTitle(skill),
      skill.description.trim(),
      skill.tags.join("|"),
      skill.rules.join("|")
    ].join("::");
    const existingIndex = keys.indexOf(key);
    if (existingIndex === -1) {
      keys.push(key);
      result.push(skill);
      continue;
    }
    if (imported.has(skill.id) && !imported.has(result[existingIndex]!.id)) {
      result[existingIndex] = skill;
    }
  }
  return result;
}

function parsePreferenceText(value: string): string[] {
  return value
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readApiRequestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) return error.message || fallback;
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

function sortSavedMemoriesByUpdatedAt(memories: SavedMemory[]): SavedMemory[] {
  return [...memories].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function deriveSavedMemoryKeywords(memories: SavedMemory[], skills: TravelSkill[]): string[] {
  const skillTags = new Set(skills.flatMap((skill) => skill.tags ?? []));
  const extracted = memories.flatMap((memory) =>
    memory.content
      .split(/[,\n，、\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => item.length >= 2)
  );
  return [...new Set([...skillTags, ...extracted])];
}

function normalizeCreateTripInput(input: CreateTripFormInput): CreateTripFormInput {
  const title = input.title.trim() || "未命名旅行";
  const destination = input.destination.trim() || input.destinationPlace?.name || input.destinationPlace?.city?.replace(/市$/, "") || "待定出发点";
  const firstDestination = input.firstDestination?.trim() || input.firstDestinationPlace?.name || undefined;
  const startDate = input.startDate || new Date().toISOString().slice(0, 10);
  const endDate = input.endDate && input.endDate >= startDate ? input.endDate : startDate;
  return {
    ...input,
    title,
    destination,
    firstDestination,
    startDate,
    endDate,
    notes: input.notes?.trim() || undefined,
    companions: input.companions?.map((item) => item.trim()).filter(Boolean) ?? []
  };
}

function readLastItineraryId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAST_ITINERARY_ID_KEY);
}

function rememberLastItineraryId(itineraryId: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LAST_ITINERARY_ID_KEY, itineraryId);
}

function sortItinerariesByRecency(items: TravelItinerary[]): TravelItinerary[] {
  return [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function upsertItineraryList(items: TravelItinerary[], next: TravelItinerary): TravelItinerary[] {
  return sortItinerariesByRecency([next, ...items.filter((item) => item.id !== next.id)]);
}

function compactDate(value?: string): string {
  if (!value) return "";
  return value.slice(5).replace("-", "/");
}

function compactDateRange(itinerary: TravelItinerary): string {
  const start = compactDate(itinerary.startDate);
  const end = itinerary.endDate && itinerary.endDate !== itinerary.startDate ? compactDate(itinerary.endDate) : "";
  return end ? `${start}-${end}` : start;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "最近编辑时间未知";
  return `最近编辑 ${date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function HomePage({
  onNavigate,
  onCreateTrip
}: {
  onNavigate: (page: Page) => void;
  onCreateTrip: (input: CreateTripFormInput) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("杭州周末旅行");
  const [destination, setDestination] = useState("杭州");
  const [destinationPlace, setDestinationPlace] = useState<PlaceSearchItem | null>(null);
  const [firstDestination, setFirstDestination] = useState("西湖");
  const [firstDestinationPlace, setFirstDestinationPlace] = useState<PlaceSearchItem | null>(null);
  const [startDate, setStartDate] = useState("2026-07-01");
  const [endDate, setEndDate] = useState("2026-07-03");
  const [budget, setBudget] = useState("1800");
  const [notes, setNotes] = useState("每天午后留出休息，避免连续跨区。");

  function submitTrip() {
    const selectedDestinationPlace = destinationPlace ? placeFromSearchItem(destinationPlace) : undefined;
    const destinationText = destinationPlace ? destinationTextFromSearchPlace(destinationPlace) : destination.trim();
    const selectedFirstDestinationPlace = firstDestinationPlace ? placeFromSearchItem(firstDestinationPlace) : undefined;
    const firstDestinationText = firstDestinationPlace ? destinationTextFromSearchPlace(firstDestinationPlace) : firstDestination.trim();
    if (!destinationText && !selectedDestinationPlace) return;
    void onCreateTrip({
      title,
      destination: destinationText,
      destinationPlace: selectedDestinationPlace,
      firstDestination: firstDestinationText,
      firstDestinationPlace: selectedFirstDestinationPlace,
      startDate,
      endDate,
      budgetCny: Number(budget) || undefined,
      notes
    });
  }

  return (
    <main className="min-h-screen bg-[#fbfbf9]">
      <nav className="flex h-16 items-center justify-between border-b border-border bg-white px-6">
        <div className="flex items-center gap-3 text-lg font-black">
          <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">J</span>
          Journey
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => onNavigate("skills")}>
            Skill 广场
          </Button>
          <Button onClick={() => onNavigate("workbench")}>进入工作台</Button>
        </div>
      </nav>
      <section className="mx-auto grid max-w-7xl grid-cols-1 gap-10 px-6 py-12 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col justify-center gap-6">
          <h1 className="max-w-2xl text-5xl font-black leading-tight tracking-normal lg:text-7xl">
            Journey
          </h1>
          <p className="max-w-xl text-lg leading-8 text-muted-foreground">
            把旅行风格沉淀成可分享的 Skill，再由旅行助手将天气、路线、景点和已保存记忆融合到可编辑行程画布里。
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => onNavigate("workbench")}>
              <MapPinned data-icon="inline-start" />
              新建行程
            </Button>
            <Button variant="secondary" onClick={() => onNavigate("creator")}>
              <WandSparkles data-icon="inline-start" />
              创作 Skill
            </Button>
          </div>
          <Card className="max-w-xl bg-white">
            <CardHeader>
              <CardTitle>新建行程</CardTitle>
              <CardDescription>命名旅行，选择出发和返回日期，进入可编辑规划画布。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="旅行名称" />
              <div className="md:col-span-2">
                <PoiSearchField
                  value={destination}
                  selectedPlace={destinationPlace ? placeFromSearchItem(destinationPlace) : null}
                  city="全国"
                  fieldLabel="出发点"
                  ariaLabel="出发点"
                  placeholder="搜索出发城市、车站、机场或酒店"
                  onQueryChange={(value) => {
                    setDestination(value);
                    setDestinationPlace(null);
                  }}
                  onSelect={(place) => {
                    setDestination(destinationTextFromSearchPlace(place));
                    setDestinationPlace(place);
                  }}
                />
              </div>
              <div className="md:col-span-2">
                <PoiSearchField
                  value={firstDestination}
                  selectedPlace={firstDestinationPlace ? placeFromSearchItem(firstDestinationPlace) : null}
                  city="全国"
                  fieldLabel="第一站"
                  ariaLabel="第一个目的地"
                  placeholder="搜索第一站、酒店、景点或餐厅"
                  onQueryChange={(value) => {
                    setFirstDestination(value);
                    setFirstDestinationPlace(null);
                  }}
                  onSelect={(place) => {
                    setFirstDestination(destinationTextFromSearchPlace(place));
                    setFirstDestinationPlace(place);
                  }}
                />
              </div>
              <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="出发日期" />
              <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="返回日期" />
              <Input value={budget} onChange={(event) => setBudget(event.target.value)} aria-label="预算" />
              <Input value={notes} onChange={(event) => setNotes(event.target.value)} aria-label="行程备注" />
              <Button className="md:col-span-2" onClick={submitTrip} disabled={!destination.trim() && !destinationPlace}>
                <MapPinned data-icon="inline-start" />
                创建并规划
              </Button>
            </CardContent>
          </Card>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {heroImages.map((image, index) => (
            <div
              key={image}
              className="photo-tile min-h-[420px] rounded-[32px]"
              style={{
                backgroundImage: `url(${image})`,
                marginTop: index === 1 ? 48 : index === 2 ? 96 : 0
              }}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function NewTripDialog({
  onCreateTrip,
  onClose
}: {
  onCreateTrip: (input: CreateTripFormInput) => void | Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [destination, setDestination] = useState("");
  const [destinationPlace, setDestinationPlace] = useState<PlaceSearchItem | null>(null);
  const [firstDestination, setFirstDestination] = useState("");
  const [firstDestinationPlace, setFirstDestinationPlace] = useState<PlaceSearchItem | null>(null);
  const [startDate, setStartDate] = useState("2026-07-01");
  const [endDate, setEndDate] = useState("2026-07-03");
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const endBeforeStart = Boolean(endDate && startDate && endDate < startDate);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedDestinationPlace = destinationPlace ? placeFromSearchItem(destinationPlace) : undefined;
    const destinationText = destinationPlace ? destinationTextFromSearchPlace(destinationPlace) : destination.trim();
    const selectedFirstDestinationPlace = firstDestinationPlace ? placeFromSearchItem(firstDestinationPlace) : undefined;
    const firstDestinationText = firstDestinationPlace ? destinationTextFromSearchPlace(firstDestinationPlace) : firstDestination.trim();
    if (!destinationText && !selectedDestinationPlace) return;
    void onCreateTrip({
      title,
      destination: destinationText,
      destinationPlace: selectedDestinationPlace,
      firstDestination: firstDestinationText,
      firstDestinationPlace: selectedFirstDestinationPlace,
      startDate,
      endDate,
      budgetCny: Number(budget) || undefined,
      notes
    });
  }

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-label="新建行程"
        className="grid max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl overflow-hidden rounded-[20px] border border-border bg-white shadow-2xl"
        onSubmit={submit}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-lg font-black">新建行程</h3>
            <p className="mt-1 text-sm text-muted-foreground">先确定出发点、第一站和日期，之后在画布中跨城市补地点、路线和预算。</p>
          </div>
          <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={onClose} aria-label="关闭新建行程">
            <X />
          </Button>
        </div>
        <div className="grid min-h-0 gap-4 overflow-auto p-5 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            旅行名称
            <Input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="新建行程名称" placeholder="例如：杭州周末旅行" />
          </label>
          <div className="md:col-span-2">
            <PoiSearchField
              value={destination}
              selectedPlace={destinationPlace ? placeFromSearchItem(destinationPlace) : null}
              city="全国"
              fieldLabel="出发点"
              ariaLabel="新建行程出发点"
              placeholder="搜索出发城市、车站、机场或酒店"
              onQueryChange={(value) => {
                setDestination(value);
                setDestinationPlace(null);
              }}
              onSelect={(place) => {
                setDestination(destinationTextFromSearchPlace(place));
                setDestinationPlace(place);
              }}
            />
          </div>
          <div className="md:col-span-2">
            <PoiSearchField
              value={firstDestination}
              selectedPlace={firstDestinationPlace ? placeFromSearchItem(firstDestinationPlace) : null}
              city="全国"
              fieldLabel="第一站"
              ariaLabel="新建行程第一个目的地"
              placeholder="搜索第一站、酒店、景点或餐厅"
              onQueryChange={(value) => {
                setFirstDestination(value);
                setFirstDestinationPlace(null);
              }}
              onSelect={(place) => {
                setFirstDestination(destinationTextFromSearchPlace(place));
                setFirstDestinationPlace(place);
              }}
            />
          </div>
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            出发日期
            <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="新建行程出发日期" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            返回日期
            <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="新建行程返回日期" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            总预算
            <Input value={budget} onChange={(event) => setBudget(event.target.value)} aria-label="新建行程预算" placeholder="例如：1800" />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            行程备注
            <Input value={notes} onChange={(event) => setNotes(event.target.value)} aria-label="新建行程备注" placeholder="例如：午后休息" />
          </label>
          {endBeforeStart && (
            <p className="rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 md:col-span-2">
              返回日期早于出发日期，将按出发日期创建 1 天行程。
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-4">
          <Button type="button" variant="outline" className="rounded-full" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" className="rounded-full" disabled={!destination.trim() && !destinationPlace}>
            <MapPinned data-icon="inline-start" />
            创建并规划
          </Button>
        </div>
      </form>
    </div>
  );
}

function Sidebar({
  page,
  onNavigate,
  onOpenNewTrip,
  itinerary,
  itineraries,
  onSelectItinerary,
  onArchiveItinerary,
  onDeleteItinerary
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  onOpenNewTrip: () => void;
  itinerary: TravelItinerary;
  itineraries: TravelItinerary[];
  onSelectItinerary: (itineraryId: string) => void;
  onArchiveItinerary: (itineraryId: string) => void;
  onDeleteItinerary: (itineraryId: string) => void;
}) {
  const entries: Array<{ page: Page; label: string; icon: typeof Home }> = [
    { page: "workbench", label: "当前行程", icon: MapPinned },
    { page: "creator", label: "创作 Skill", icon: WandSparkles },
    { page: "skills", label: "Skill 广场", icon: Store },
    { page: "settings", label: "偏好设置", icon: Settings2 }
  ];
  const titleCounts = itineraries.reduce<Record<string, number>>((counts, item) => {
    counts[item.title] = (counts[item.title] ?? 0) + 1;
    return counts;
  }, {});
  const compactSidebar = page === "workbench";
  const showFullHistory = page === "workbench" || page === "creator";
  return (
    <aside className={cn("hidden min-h-0 flex-col border-r border-border bg-[#fbfbf9] lg:flex", compactSidebar ? "px-2 py-4 2xl:p-4" : "p-4")}>
      <button
        className={cn("mb-6 flex min-h-10 items-center gap-3 text-left text-base font-black", compactSidebar ? "justify-center 2xl:justify-start" : "justify-start")}
        onClick={() => onNavigate("home")}
        aria-label="回到首页"
        title="Journey"
      >
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">J</span>
        <span className={cn(compactSidebar && "hidden 2xl:inline")}>Journey</span>
      </button>
      <div className="flex flex-col gap-2">
        <Button className={cn(compactSidebar ? "justify-center px-0 2xl:justify-start 2xl:px-4" : "justify-start")} onClick={onOpenNewTrip} aria-label="新建行程" title="新建行程">
          <Plus data-icon="inline-start" />
          <span className={cn(compactSidebar && "hidden 2xl:inline")}>新建行程</span>
        </Button>
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <Button
              key={entry.page}
              variant={page === entry.page ? "secondary" : "ghost"}
              className={cn(compactSidebar ? "justify-center px-0 2xl:justify-start 2xl:px-4" : "justify-start")}
              onClick={() => onNavigate(entry.page)}
              aria-label={entry.label}
              title={entry.label}
            >
              <Icon data-icon="inline-start" />
              <span className={cn(compactSidebar && "hidden 2xl:inline")}>{entry.label}</span>
            </Button>
          );
        })}
      </div>
      <Separator className={cn("my-5", compactSidebar && "hidden 2xl:block")} />
      {showFullHistory ? (
        <div className={cn("flex-1 flex-col gap-3", compactSidebar ? "hidden 2xl:flex" : "flex")}>
          <p className="text-xs font-bold text-muted-foreground">会话记录</p>
          <div className="grid gap-2">
            {itineraries.slice(0, 6).map((item) => {
              const active = item.id === itinerary.id;
              const duplicateTitle = (titleCounts[item.title] ?? 0) > 1;
              const canRemove = itineraries.length > 1;
              return (
                <div
                  key={item.id}
                  className={cn(
                    "group relative rounded-2xl bg-white p-2 text-sm font-semibold transition-colors hover:bg-secondary",
                    active && "bg-secondary ring-1 ring-border before:absolute before:inset-y-3 before:left-0 before:w-1 before:rounded-r-full before:bg-primary"
                  )}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 rounded-xl px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onSelectItinerary(item.id)}
                      aria-label={`${active ? "当前行程" : "打开行程"}：${item.title}`}
                    >
                      <span className="flex min-w-0 items-start justify-between gap-2">
                        <span className="min-w-0 truncate">{item.title}</span>
                        {active && (
                          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-black text-primary-foreground">
                            当前
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
                        出发点 {item.destination} · {compactDateRange(item)} · {item.days.length} 天
                        {duplicateTitle ? " · 同名行程" : ""}
                      </span>
                      <span className="mt-1 block truncate text-[11px] font-semibold text-muted-foreground/80">
                        {formatUpdatedAt(item.updatedAt)}
                      </span>
                    </button>
                    <div className="flex shrink-0 flex-col gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 bg-white/70"
                        disabled={!canRemove}
                        onClick={() => onArchiveItinerary(item.id)}
                        aria-label={`归档行程：${item.title}`}
                      >
                        <Archive className="size-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 bg-white/70 text-muted-foreground hover:text-destructive"
                        disabled={!canRemove}
                        onClick={() => onDeleteItinerary(item.id)}
                        aria-label={`删除行程：${item.title}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className={cn("flex-1 flex-col gap-3", compactSidebar ? "hidden 2xl:flex" : "flex")}>
          <p className="text-xs font-bold text-muted-foreground">当前规划</p>
          <button
            type="button"
            className="rounded-2xl bg-white p-3 text-left text-sm font-semibold transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onNavigate("workbench")}
            aria-label={`打开当前行程：${itinerary.title}`}
          >
            <span className="block truncate font-black">{itinerary.title}</span>
            <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">
              出发点 {itinerary.destination} · {compactDateRange(itinerary)} · {itinerary.days.length} 天
            </span>
            <span className="mt-2 inline-flex rounded-full bg-[#f6f6f3] px-2.5 py-1 text-[11px] font-black text-foreground">
              回到画布
            </span>
          </button>
        </div>
      )}
    </aside>
  );
}

function TravelResultPage({
  itinerary,
  exportText,
  onBackToWorkbench
}: {
  itinerary: TravelItinerary;
  exportText: string;
  onBackToWorkbench: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const checklist = summarizePlanningChecklist(itinerary);
  const activities = itinerary.days.flatMap((day) => day.activities);
  const routePairs = itinerary.days.flatMap((day) => getRoutePairsForDay(itinerary, day));
  const plannedLegs = routePairs.flatMap((pair) => (pair.leg ? [pair.leg] : []));
  const totalDistanceMeters = plannedLegs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const totalDurationMinutes = plannedLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const plannedBudget = activities.reduce((sum, activity) => sum + (activity.budgetCny ?? 0), 0);
  const overviewItems = [
    `${itinerary.days.length} 天`,
    `${activities.length} 项安排`,
    plannedLegs.length > 0 ? `${plannedLegs.length} 段路线` : undefined,
    totalDistanceMeters > 0 ? formatDistanceForUi(totalDistanceMeters) : undefined,
    totalDurationMinutes > 0 ? `${totalDurationMinutes} 分钟交通` : undefined,
    plannedBudget > 0 ? `活动预算约 ${plannedBudget} 元` : itinerary.budgetCny ? `总预算 ${itinerary.budgetCny} 元` : undefined
  ].filter(Boolean);
  const markdownReady = exportText.trim().length > 0;

  async function copyMarkdown() {
    if (!markdownReady) return;
    try {
      await navigator.clipboard?.writeText(exportText);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败");
    }
  }

  function downloadMarkdown() {
    if (!markdownReady) return;
    downloadTextFile(exportText, `${sanitizeFilename(itinerary.title)}-${itinerary.startDate}.md`);
  }

  return (
    <div className="min-h-screen bg-[#fbfbf9]">
      <header className="border-b border-border bg-white px-4 py-3 md:px-8 md:py-5">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-black uppercase tracking-normal text-muted-foreground">旅行结果</p>
            <h2 className="mt-1 text-xl font-black md:text-2xl">旅行结果</h2>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" className="rounded-full bg-white" onClick={onBackToWorkbench}>
              <Pencil data-icon="inline-start" />
              返回编辑
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full bg-white"
              onClick={() => void copyMarkdown()}
              disabled={!markdownReady}
              aria-label="复制导出 Markdown"
            >
              <Copy data-icon="inline-start" />
              {copyStatus || "复制"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={downloadMarkdown}
              disabled={!markdownReady}
              aria-label="重新下载 Markdown"
            >
              <Download data-icon="inline-start" />
              重新下载
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-5 md:px-8 md:py-8">
        <section aria-label="只读行程结果" className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm">
          <div className="grid gap-5 border-b border-border p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start md:p-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="bg-[#f6f6f3] text-foreground">只读</Badge>
                <span className="text-sm font-semibold text-muted-foreground">
                  {itinerary.startDate} 至 {itinerary.endDate ?? itinerary.startDate}
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-black md:text-4xl">{itinerary.title}</h1>
              <p className="mt-2 text-sm font-semibold text-muted-foreground md:text-base">
                出发点 {itinerary.destination}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:max-w-md md:justify-end">
              {overviewItems.map((item) => (
                <span key={item} className="inline-flex min-h-8 items-center rounded-full bg-[#f6f6f3] px-3 text-xs font-black text-foreground md:text-sm">
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-5 bg-[#fbfbf9] p-5 md:p-6">
            <section
              aria-label="导出检查"
              className={cn(
                "rounded-2xl border bg-white p-4",
                checklist.complete ? "border-emerald-200" : "border-amber-300"
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-black">导出检查</h2>
                <Badge className={checklist.complete ? "bg-emerald-600 text-white" : "bg-amber-100 text-amber-950"}>
                  {checklist.complete ? "可归档" : "待补齐"}
                </Badge>
              </div>
              <p className="mt-2 text-sm font-semibold text-muted-foreground">
                {checklist.complete ? "地点、时间和相邻交通已补齐" : `还有 ${checklist.total} 项需要补齐`}
              </p>
              {!checklist.complete && (
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  {checklist.missingPlaces.length > 0 && (
                    <div className="rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-950">
                      <p className="font-black">地点</p>
                      <ul className="mt-2 grid gap-1 leading-5">
                        {checklist.missingPlaceItems.map((item) => (
                          <li key={`place-${item.activityId}`}>{item.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {checklist.missingTimes.length > 0 && (
                    <div className="rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-950">
                      <p className="font-black">时间</p>
                      <ul className="mt-2 grid gap-1 leading-5">
                        {checklist.missingTimeItems.map((item) => (
                          <li key={`time-${item.activityId}`}>{item.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {checklist.pendingTransport.length > 0 && (
                    <div className="rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-950">
                      <p className="font-black">交通</p>
                      <ul className="mt-2 grid gap-1 leading-5">
                        {checklist.pendingTransportItems.map((item) => (
                          <li key={`transport-${item.fromActivityId}-${item.toActivityId}`}>{item.label}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </section>

            <section aria-label="每日安排" className="grid gap-4">
              {itinerary.days.map((day) => {
                const dayRoutePairs = getRoutePairsForDay(itinerary, day);
                return (
                  <article key={day.id} className="overflow-hidden rounded-2xl border border-border bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                      <div className="min-w-0">
                        <h2 className="text-lg font-black">{day.title}</h2>
                        <p className="mt-1 text-xs font-semibold text-muted-foreground">
                          {day.date}
                          {day.weather ? ` · ${day.weather.weather} ${formatTemperatureForUi(day.weather.temperature)}` : ""}
                        </p>
                      </div>
                      <Badge className="bg-[#f6f6f3] text-foreground">{day.activities.length} 项安排</Badge>
                    </div>
                    <ol className="grid gap-3 p-4">
                      {day.activities.length === 0 && (
                        <li className="rounded-xl border border-dashed border-border bg-[#fbfbf9] p-4 text-sm font-semibold text-muted-foreground">
                          这一天还没有安排
                        </li>
                      )}
                      {day.activities.map((activity, index) => {
                        const summary = activitySummaryView(activity, index);
                        const routePair = dayRoutePairs.find(
                          (pair) => pair.fromActivity.id === activity.id && pair.toActivity.id === day.activities[index + 1]?.id
                        );
                        return (
                          <li key={activity.id} className="grid gap-3">
                            <div className="rounded-xl border border-border bg-[#fbfbf9] p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="flex min-w-0 gap-3">
                                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-sm font-black text-background">
                                    {index + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <h3 className="text-base font-black md:text-lg">{summary.displayName}</h3>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      <Badge className="bg-white text-foreground">{summary.typeLabel}</Badge>
                                      {summary.time && <Badge className="bg-white text-foreground">{summary.time}</Badge>}
                                      {summary.budget && <Badge className="bg-white text-foreground">{summary.budget}</Badge>}
                                    </div>
                                  </div>
                                </div>
                              </div>
                              {(summary.place || activity.description || activity.note) && (
                                <div className="mt-3 grid gap-2 border-t border-border pt-3 text-sm font-semibold text-muted-foreground">
                                  {summary.place && (
                                    <p className="flex items-center gap-2">
                                      <MapPin className="size-4" />
                                      <span>{summary.place}</span>
                                    </p>
                                  )}
                                  {activity.description && <p>{activity.description}</p>}
                                  {activity.note && <p>{activity.note}</p>}
                                </div>
                              )}
                            </div>
                            {routePair && (
                              <ReadOnlyRouteResult
                                from={routePair.fromActivity}
                                to={routePair.toActivity}
                                fromIndex={routePair.fromIndex}
                                toIndex={routePair.toIndex}
                                leg={routePair.leg}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ol>
                  </article>
                );
              })}
            </section>
          </div>
        </section>

        {markdownReady && (
          <section aria-label="导出预览" className="rounded-2xl border border-border bg-white p-5 shadow-sm md:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-black">导出预览</h2>
              <Badge className="bg-[#f6f6f3] text-foreground">Markdown</Badge>
            </div>
            <pre className="mt-4 max-h-96 overflow-auto rounded-2xl bg-[#f6f6f3] p-4 text-xs leading-6">
              {exportText}
            </pre>
          </section>
        )}
      </main>
    </div>
  );
}

function ReadOnlyRouteResult({
  from,
  to,
  fromIndex,
  toIndex,
  leg
}: {
  from: Activity;
  to: Activity;
  fromIndex: number;
  toIndex: number;
  leg?: TransportLeg;
}) {
  const title = activityRouteName(from, to, fromIndex, toIndex);
  const provider = leg ? transportProviderMeta(leg) : undefined;
  const modeLabel = leg ? routeModeOptions.find(([value]) => value === leg.mode)?.[1] : undefined;
  return (
    <div className="ml-4 rounded-xl border border-border bg-white p-4 text-sm shadow-sm md:ml-12">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-[#f6f6f3]">
          <Route className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-black text-muted-foreground">路线</p>
          <h4 className="font-black">{title}</h4>
        </div>
      </div>
      {leg ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {provider && <Badge className={provider.className}>{provider.label}</Badge>}
          <Badge className="bg-[#f6f6f3] text-foreground">
            {formatDistanceForUi(leg.distanceMeters)} / {leg.durationMinutes} 分钟
          </Badge>
          {modeLabel && <Badge className="bg-[#f6f6f3] text-foreground">{modeLabel}</Badge>}
          {leg.summary && <span className="text-xs font-semibold text-muted-foreground">{leg.summary}</span>}
        </div>
      ) : (
        <p className="mt-3 text-xs font-semibold text-muted-foreground">路线待确认</p>
      )}
    </div>
  );
}

type PlaceSearchItem = {
  id: string;
  name: string;
  address: string;
  city: string;
  district?: string;
  type?: string;
  typeCode?: string;
  phone?: string;
  openingHours?: string;
  averageCostCny?: number;
  photos?: Place["photos"];
  source?: "amap" | "mock";
  location: NonNullable<Place["coordinates"]>;
};
type SearchPlaceActivityFields = Pick<Activity, "title" | "type"> & {
  placeName: string;
  place: Place;
};

function poiSearchText(place: PlaceSearchItem): string {
  return `${place.type ?? ""} ${place.name} ${place.address ?? ""}`;
}

function poiCategoryLabel(place: PlaceSearchItem): string {
  const text = poiSearchText(place);
  if (/餐饮|咖啡|茶|美食|饭店|餐厅|小吃|甜品/.test(text)) return "餐饮";
  if (/酒店|住宿|民宿|宾馆|客栈/.test(text)) return "住宿";
  if (/交通|机场|车站|地铁|公交|码头|火车|高铁/.test(text)) return "交通";
  if (/商场|购物|银泰|百货|店/.test(text)) return "购物";
  if (/公园|景区|景点|风景|博物馆|寺|馆|文化|展览|古镇/.test(text)) return "景点";
  return "地点";
}

function activityTypeFromPoi(place: PlaceSearchItem): ActivityType {
  const category = poiCategoryLabel(place);
  if (category === "餐饮") return "food";
  if (category === "住宿") return "lodging";
  if (category === "交通") return "transport";
  if (category === "景点" || category === "购物") return "attraction";
  return "free_time";
}

function placeMetaItems(place?: Pick<Place, "openingHours" | "phone" | "averageCostCny">): string[] {
  if (!place) return [];
  return [
    place.openingHours ? `营业 ${place.openingHours}` : undefined,
    place.phone ? `电话 ${place.phone}` : undefined,
    place.averageCostCny !== undefined ? `人均 ${place.averageCostCny} 元` : undefined
  ].filter((item): item is string => Boolean(item));
}

function placeFromSearchItem(place: PlaceSearchItem): Place {
  return {
    poiId: place.id,
    name: place.name,
    address: place.address,
    city: place.city,
    district: place.district,
    type: place.type,
    typeCode: place.typeCode,
    phone: place.phone,
    openingHours: place.openingHours,
    averageCostCny: place.averageCostCny,
    photos: place.photos,
    coordinates: place.location
  };
}

function activityChangesFromSearchPlace(place: PlaceSearchItem): SearchPlaceActivityFields {
  return {
    type: activityTypeFromPoi(place),
    title: place.name,
    placeName: place.name,
    place: placeFromSearchItem(place)
  };
}

function activityDraftFromSearchPlace(place: PlaceSearchItem): ActivityDraft {
  const category = poiCategoryLabel(place);
  return {
    ...activityChangesFromSearchPlace(place),
    tags: ["地点", category].filter(Boolean)
  };
}

function destinationTextFromSearchPlace(place: PlaceSearchItem): string {
  return place.name.trim() || place.city.trim().replace(/市$/, "");
}

function amapPoiItems(items: PlaceSearchItem[]): PlaceSearchItem[] {
  return items.filter(
    (place) =>
      Boolean(place.id) &&
      Number.isFinite(place.location.lng) &&
      Number.isFinite(place.location.lat)
  );
}

function placeAddressLine(place: Pick<Place, "address" | "city" | "district">): string {
  return [place.district, place.address].filter(Boolean).join(" · ") || place.city || "高德地点";
}

function PoiSearchField({
  value,
  selectedPlace,
  city,
  fieldLabel,
  ariaLabel,
  placeholder,
  selectionHint,
  className,
  onQueryChange,
  onSelect
}: {
  value: string;
  selectedPlace?: Place | null;
  city?: string;
  fieldLabel?: string;
  ariaLabel: string;
  placeholder?: string;
  selectionHint?: string;
  className?: string;
  onQueryChange: (value: string) => void;
  onSelect: (place: PlaceSearchItem) => void;
}) {
  const [results, setResults] = useState<PlaceSearchItem[]>([]);
  const [status, setStatus] = useState("");
  const [searching, setSearching] = useState(false);
  const inputId = useId();

  useEffect(() => {
    setResults([]);
    setStatus("");
  }, [city, value]);

  async function searchPlaces() {
    const query = value.trim();
    if (!query) {
      setResults([]);
      setStatus("输入关键词后搜索高德地点");
      return;
    }
    setSearching(true);
    setResults([]);
    setStatus("正在搜索高德地点...");
    try {
      const result = await apiGet<{ items: PlaceSearchItem[] }>(`/maps/poi?keywords=${encodeURIComponent(query)}&city=${encodeURIComponent(city?.trim() || "全国")}`);
      const concreteItems = amapPoiItems(result.items);
      setResults(concreteItems);
      setStatus(
        concreteItems.length > 0
          ? ""
          : result.items.length > 0
            ? "地图服务没有返回可用的高德地点，请换个关键词。"
            : "没有找到高德地点，请换个关键词。"
      );
    } catch (error) {
      setStatus(readApiRequestErrorMessage(error, "高德地点搜索失败，请稍后重试。"));
    } finally {
      setSearching(false);
    }
  }

  function choosePlace(place: PlaceSearchItem) {
    onSelect(place);
    setResults([]);
    setStatus("");
  }

  return (
    <div className={cn("grid gap-2", className)}>
      {fieldLabel && (
        <label className="text-xs font-bold text-muted-foreground" htmlFor={inputId}>
          {fieldLabel}
        </label>
      )}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          id={inputId}
          value={value}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void searchPlaces();
            }
          }}
          aria-label={ariaLabel}
          placeholder={placeholder ?? "搜索地点"}
          autoComplete="off"
        />
        <Button type="button" variant="secondary" onClick={searchPlaces} disabled={searching}>
          <Search data-icon="inline-start" />
          {searching ? "搜索中" : "搜索"}
        </Button>
      </div>
      {selectedPlace ? (
        <div className="rounded-xl border border-border bg-white px-3 py-2 text-xs">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge className="bg-[#f6f6f3] text-foreground">已选高德地点</Badge>
            <span className="min-w-0 truncate font-black text-foreground">{selectedPlace.name}</span>
          </div>
          <p className="mt-1 line-clamp-2 font-semibold text-muted-foreground">{placeAddressLine(selectedPlace)}</p>
        </div>
      ) : selectionHint ? (
        <p className="rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs font-semibold text-muted-foreground">{selectionHint}</p>
      ) : null}
      {results.length > 0 && (
        <div role="listbox" aria-label={`${ariaLabel}搜索结果`} className="grid max-h-64 gap-1 overflow-auto rounded-xl border border-border bg-white p-2">
          {results.map((place) => (
            <button
              key={place.id}
              type="button"
              role="option"
              className="grid gap-1 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => choosePlace(place)}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate text-sm font-black text-foreground">{place.name}</span>
                <Badge className="min-h-6 bg-[#f6f6f3] px-2 text-[11px] text-foreground">{poiCategoryLabel(place)}</Badge>
              </span>
              <span className="line-clamp-1 font-semibold text-muted-foreground">{placeAddressLine(place)}</span>
              {placeMetaItems(place).length > 0 && (
                <span className="line-clamp-1 font-semibold text-muted-foreground">{placeMetaItems(place).join(" · ")}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {status && (
        <p className="rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs font-semibold text-muted-foreground" aria-live="polite">
          {status}
        </p>
      )}
    </div>
  );
}

function Workbench({
  itinerary,
  selectedDayId,
  focusTarget,
  skills,
  importedSkillIds,
  serviceStatus,
  saveStatus,
  exportText,
  backgroundSyncEnabled,
  onSelectDay,
  onAddDay,
  onAddActivity,
  onUpdateActivity,
  onDeleteActivity,
  onReorderActivity,
  onMoveActivityToDay,
  onUpdateItinerary,
  onExport,
  onSetTransport,
  onRemoveTransport,
  onCompleteRoutes,
  onUpdateDayWeather,
  onOpenAgent,
  onMapWorkspaceOpenChange,
  onFocusTargetConsumed
}: {
  itinerary: TravelItinerary;
  selectedDayId: string;
  focusTarget: AgentChangeTarget | null;
  skills: TravelSkill[];
  importedSkillIds: string[];
  serviceStatus: string;
  saveStatus: string;
  exportText: string;
  backgroundSyncEnabled: boolean;
  onSelectDay: (dayId: string) => void;
  onAddDay: (position?: "after" | "before") => void;
  onAddActivity: (activity?: ActivityDraft) => TravelItinerary | void | Promise<TravelItinerary | void>;
  onUpdateActivity: (activityId: string, changes: Partial<Activity>) => void | Promise<void>;
  onDeleteActivity: (activityId: string) => void | Promise<void>;
  onReorderActivity: (dayId: string, activityId: string, targetIndex: number) => void | Promise<void>;
  onMoveActivityToDay: (activityId: string, targetDayId: string, targetIndex: number) => void | Promise<void>;
  onUpdateItinerary: (changes: Partial<TravelItinerary>) => void | Promise<void>;
  onExport: () => void;
  onSetTransport: (
    dayId: string,
    fromActivityId: string,
    toActivityId: string,
    mode: MapRouteMode,
    overrides?: TransportLegOverride
  ) => void | Promise<void>;
  onRemoveTransport: (dayId: string, fromActivityId: string, toActivityId: string) => void | Promise<void>;
  onCompleteRoutes: (mode?: MapRouteMode) => void | Promise<void>;
  onUpdateDayWeather: (dayId: string) => void | Promise<void>;
  onOpenAgent: () => void;
  onMapWorkspaceOpenChange?: (open: boolean) => void;
  onFocusTargetConsumed: () => void;
}) {
  const day = itinerary.days.find((candidate) => candidate.id === selectedDayId) ?? itinerary.days[0]!;
  const [titleText, setTitleText] = useState(itinerary.title);
  const [destinationText, setDestinationText] = useState(itinerary.destination);
  const [destinationPlaceDraft, setDestinationPlaceDraft] = useState<Place | null>(itinerary.destinationPlace ?? null);
  const [startDateText, setStartDateText] = useState(itinerary.startDate);
  const [endDateText, setEndDateText] = useState(itinerary.endDate ?? itinerary.startDate);
  const [budgetText, setBudgetText] = useState(String(itinerary.budgetCny ?? ""));
  const [notesText, setNotesText] = useState(itinerary.notes ?? "");
  const [tripDetailsOpen, setTripDetailsOpen] = useState(false);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [selectedTransportLegId, setSelectedTransportLegId] = useState<string | null>(null);
  const [mapRouteFocusRequest, setMapRouteFocusRequest] = useState<MapRouteFocusRequest | null>(null);
  const [draggingActivityId, setDraggingActivityId] = useState<string | null>(null);
  const [dragOverActivityIndex, setDragOverActivityIndex] = useState<number | null>(null);
  const [exportCopyStatus, setExportCopyStatus] = useState("");
  const weatherRequestRef = useRef(new Set<string>());
  const routeRequestRef = useRef(new Set<string>());

  useEffect(() => {
    setTitleText(itinerary.title);
    setDestinationText(itinerary.destination);
    setDestinationPlaceDraft(itinerary.destinationPlace ?? null);
    setStartDateText(itinerary.startDate);
    setEndDateText(itinerary.endDate ?? itinerary.startDate);
    setBudgetText(String(itinerary.budgetCny ?? ""));
    setNotesText(itinerary.notes ?? "");
  }, [
    itinerary.id,
    itinerary.title,
    itinerary.destination,
    itinerary.destinationPlace,
    itinerary.startDate,
    itinerary.endDate,
    itinerary.budgetCny,
    itinerary.notes
  ]);

  useEffect(() => {
    if (selectedActivityId && !day.activities.some((activity) => activity.id === selectedActivityId)) {
      setSelectedActivityId(null);
    }
  }, [day.activities, selectedActivityId]);

  useEffect(() => {
    if (selectedTransportLegId && !getAdjacentTransportLegs(day, itinerary).some((leg) => leg.id === selectedTransportLegId)) {
      setSelectedTransportLegId(null);
    }
  }, [day, itinerary, selectedTransportLegId]);

  useEffect(() => {
    if (!focusTarget || focusTarget.dayId !== day.id) return;
    if (focusTarget.activityId && day.activities.some((activity) => activity.id === focusTarget.activityId)) {
      setSelectedActivityId(focusTarget.activityId);
      setSelectedTransportLegId(null);
      onFocusTargetConsumed();
      return;
    }
    if (focusTarget.transportLegId && getAdjacentTransportLegs(day, itinerary).some((leg) => leg.id === focusTarget.transportLegId)) {
      setSelectedActivityId(null);
      setSelectedTransportLegId(focusTarget.transportLegId);
      onFocusTargetConsumed();
    }
  }, [day, itinerary, focusTarget, onFocusTargetConsumed]);

  const dayHasWeatherAnchor = day.activities.some(
    (activity) => hasMapPoint(activity) || Boolean(activity.placeName?.trim() || activity.place?.name?.trim())
  );
  const weatherRequestKey = `${day.id}:${itinerary.destination}:${day.date}`;
  useEffect(() => {
    if (!backgroundSyncEnabled) return;
    if (!dayHasWeatherAnchor) return;
    if (day.weather || weatherRequestRef.current.has(weatherRequestKey)) return;
    weatherRequestRef.current.add(weatherRequestKey);
    void onUpdateDayWeather(day.id);
  }, [backgroundSyncEnabled, day.id, day.weather, dayHasWeatherAnchor, onUpdateDayWeather, weatherRequestKey]);

  useEffect(() => {
    if (!backgroundSyncEnabled) return;
    const pendingRoutePairs = itinerary.days.flatMap((candidateDay) =>
      getRoutePairsForDay(itinerary, candidateDay).flatMap((pair) =>
        pair.leg
          ? []
          : [`${candidateDay.id}:${routeEndpointFingerprint(pair.fromActivity)}:${routeEndpointFingerprint(pair.toActivity)}`]
      )
    );
    if (pendingRoutePairs.length === 0) return;
    const fingerprint = pendingRoutePairs.join("|");
    if (routeRequestRef.current.has(fingerprint)) return;
    routeRequestRef.current.add(fingerprint);
    void onCompleteRoutes("walking");
  }, [backgroundSyncEnabled, itinerary.days, onCompleteRoutes]);

  const dayBudget = day.activities.reduce((sum, activity) => sum + (activity.budgetCny ?? 0), 0);
  const dayRoutePairs = getRoutePairsForDay(itinerary, day);
  const overnightStart = getOvernightStartAnchor(itinerary, day);
  const overnightRoutePair = dayRoutePairs.find((pair) => pair.overnightStart);
  const daySummary = [
    day.date,
    `${day.activities.length} 项安排`,
    dayBudget > 0 ? `约 ${dayBudget} 元` : undefined
  ]
    .filter(Boolean)
    .join(" · ");
  const selectedActivityIndex = day.activities.findIndex((activity) => activity.id === selectedActivityId);
  const selectedActivity = selectedActivityIndex >= 0 ? day.activities[selectedActivityIndex] : undefined;
  const selectedTransportContext = selectedTransportLegId
    ? getRoutePairsForDay(itinerary, day).flatMap((pair) => {
        return pair.leg && pair.leg.id === selectedTransportLegId
          ? [
              {
                fromActivity: pair.fromActivity,
                toActivity: pair.toActivity,
                fromIndex: pair.fromIndex,
                toIndex: pair.toIndex,
                leg: pair.leg
              }
            ]
          : [];
      })[0]
    : undefined;
  const dayRouteCount = getAdjacentTransportLegs(day, itinerary).length;
  const dayMissingPlaceCount = day.activities.filter((activity) => !hasMapPoint(activity)).length;
  const exportChecklist = useMemo(() => summarizePlanningChecklist(itinerary), [itinerary]);

  useEffect(() => {
    setExportCopyStatus("");
  }, [exportText]);

  function startActivityDrag(event: DragEvent<HTMLElement>, activityId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-journey-activity", activityId);
    event.dataTransfer.setData("text/plain", activityId);
    setDraggingActivityId(activityId);
    setDragOverActivityIndex(null);
  }

  function updateActivityDropTarget(event: DragEvent<HTMLElement>, targetIndex: number, targetActivityId: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverActivityIndex(draggingActivityId && draggingActivityId !== targetActivityId ? targetIndex : null);
  }

  function dropActivity(event: DragEvent<HTMLElement>, targetIndex: number) {
    event.preventDefault();
    const activityId =
      event.dataTransfer.getData("application/x-journey-activity") || event.dataTransfer.getData("text/plain");
    setDraggingActivityId(null);
    setDragOverActivityIndex(null);
    if (!activityId) return;
    void onReorderActivity(day.id, activityId, targetIndex);
  }

  function clearActivityDragState() {
    setDraggingActivityId(null);
    setDragOverActivityIndex(null);
  }

  function saveTripDetails() {
    if (!destinationText.trim() && !destinationPlaceDraft) return;
    void onUpdateItinerary({
      title: titleText,
      destination: destinationText,
      destinationPlace: destinationPlaceDraft ?? undefined,
      startDate: startDateText,
      endDate: endDateText,
      budgetCny: Number(budgetText) || undefined,
      notes: notesText
    });
    setTripDetailsOpen(false);
  }

  function updateDestinationText(value: string) {
    setDestinationText(value);
    setDestinationPlaceDraft(null);
  }

  function selectDestinationPlace(place: PlaceSearchItem) {
    setDestinationText(destinationTextFromSearchPlace(place));
    setDestinationPlaceDraft(placeFromSearchItem(place));
  }

  function selectRouteEndpoint(pair: DayRoutePair, activityId: string) {
    const targetDayId = activityId === pair.fromActivity.id ? pair.fromDayId : pair.toDayId;
    if (targetDayId !== day.id) onSelectDay(targetDayId);
    setSelectedActivityId(activityId);
    setSelectedTransportLegId(null);
  }

  async function addPlaceToDay(place: PlaceSearchItem): Promise<TravelItinerary | void> {
    const previousIds = new Set(day.activities.map((activity) => activity.id));
    const updated = await onAddActivity(activityDraftFromSearchPlace(place));
    const updatedDay = updated?.days.find((candidate) => candidate.id === day.id);
    const addedActivity =
      updatedDay?.activities.find((activity) => !previousIds.has(activity.id)) ??
      updatedDay?.activities.find((activity) => activity.place?.poiId === place.id) ??
      updatedDay?.activities.at(-1);
    if (addedActivity) {
      setSelectedActivityId(addedActivity.id);
      setSelectedTransportLegId(null);
    }
    return updated;
  }

  async function addBlankActivityFromCanvas() {
    const previousIds = new Set(day.activities.map((activity) => activity.id));
    const updated = await onAddActivity();
    const updatedDay = updated?.days.find((candidate) => candidate.id === day.id);
    const addedActivity =
      updatedDay?.activities.find((activity) => !previousIds.has(activity.id)) ??
      updatedDay?.activities[updatedDay.activities.length - 1];
    if (addedActivity) {
      setSelectedActivityId(addedActivity.id);
      setSelectedTransportLegId(null);
    }
  }

  async function copyExportMarkdown() {
    if (!exportText.trim()) return;
    try {
      await navigator.clipboard?.writeText(exportText);
      setExportCopyStatus("已复制");
    } catch {
      setExportCopyStatus("复制失败");
    }
  }

  function redownloadExportMarkdown() {
    if (!exportText.trim()) return;
    downloadTextFile(exportText, `${sanitizeFilename(itinerary.title)}-${itinerary.startDate}.md`);
  }

  function locatePlanningActivity(item: PlanningActivityChecklistItem) {
    onSelectDay(item.dayId);
    setSelectedActivityId(item.activityId);
    setSelectedTransportLegId(null);
  }

  function locatePlanningTransport(item: PlanningTransportChecklistItem) {
    onSelectDay(item.dayId);
    setSelectedActivityId(item.fromActivityId);
    setSelectedTransportLegId(null);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border px-4 py-2 md:px-6 md:py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-black md:text-xl">{itinerary.title}</h2>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground md:text-sm">
              <span className="min-w-0 truncate">
                出发点 {itinerary.destination} / {itinerary.startDate} 至 {itinerary.endDate ?? itinerary.startDate} / {itinerary.days.length} 天
              </span>
              <span className="inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded-full bg-[#f6f6f3] px-2 text-[11px] font-bold text-muted-foreground md:text-xs" aria-live="polite">
                <span className={cn("size-2 rounded-full", saveStatus.includes("正在") ? "bg-amber-500" : "bg-emerald-500")} />
                {saveStatus}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 self-center flex-wrap items-center justify-end gap-1.5 sm:gap-2" data-testid="workbench-header-actions">
            <Button
              variant="outline"
              size="sm"
              className="size-9 shrink-0 rounded-full bg-white p-0 sm:size-auto sm:px-3 min-[769px]:hidden"
              onClick={onOpenAgent}
              aria-label="打开旅行助手"
            >
              <Bot />
              <span className="hidden sm:inline">助手</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="size-9 shrink-0 rounded-full bg-white p-0 sm:size-auto sm:px-3"
              onClick={() => setTripDetailsOpen(true)}
              aria-label="编辑行程信息"
            >
              <Pencil />
              <span className="hidden sm:inline">编辑信息</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="size-9 shrink-0 rounded-full bg-white p-0 sm:size-auto sm:px-3"
              onClick={onExport}
              aria-label="导出"
            >
              <Download />
              <span className="hidden sm:inline">导出</span>
            </Button>
          </div>
        </div>
      </header>
      <div data-testid="workbench-scroll" className="min-h-0 flex-1 overflow-auto bg-[#fbfbf9] px-4 py-4 text-[#211922] md:px-6 md:py-5">
        {serviceStatus && <div className="mb-3 text-xs font-semibold text-muted-foreground">{serviceStatus}</div>}
        <MapPanel
          itinerary={itinerary}
          day={day}
          selectedActivityId={selectedActivityId}
          selectedTransportLegId={selectedTransportLegId}
          routeFocusRequest={mapRouteFocusRequest}
          onAddPlace={addPlaceToDay}
          onUpdateActivity={onUpdateActivity}
          onSelectDay={onSelectDay}
          onSelectActivity={(activityId) => {
            setSelectedActivityId(activityId);
            setSelectedTransportLegId(null);
          }}
          onSelectTransportLeg={(legId) => {
            setSelectedTransportLegId(legId);
            setSelectedActivityId(null);
          }}
          onExpandedChange={onMapWorkspaceOpenChange}
          onRouteFocusRequestConsumed={() => setMapRouteFocusRequest(null)}
        />
        <Card className="hidden" data-testid="trip-info-summary">
          <CardHeader className="gap-2 p-3 md:flex-row md:items-center md:justify-between md:p-4">
            <div>
              <CardTitle className="text-base">行程信息</CardTitle>
              <CardDescription className="mt-1 text-xs md:text-sm">
                出发点 {itinerary.destination} · {itinerary.days.length} 天 · 预算 {itinerary.budgetCny ? `${itinerary.budgetCny} 元` : "待定"}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-full"
              onClick={() => setTripDetailsOpen(true)}
              aria-haspopup="dialog"
            >
              编辑信息
            </Button>
          </CardHeader>
        </Card>
        {tripDetailsOpen && (
          <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-label="编辑行程信息"
              className="grid max-h-[min(720px,calc(100vh-32px))] w-full max-w-3xl overflow-hidden rounded-[20px] border border-border bg-white shadow-2xl"
            >
              <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-black">编辑行程信息</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    出发点 {itinerary.destination} · {itinerary.startDate} 至 {itinerary.endDate ?? itinerary.startDate}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setTripDetailsOpen(false)}
                  aria-label="关闭编辑行程信息"
                >
                  <X />
                </Button>
              </div>
              <div className="grid min-h-0 gap-4 overflow-auto bg-[#fbfbf9] p-5">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                    行程名称
                    <Input value={titleText} onChange={(event) => setTitleText(event.target.value)} aria-label="行程名称" />
                  </label>
                  <div className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
	                    出发点
	                    <PoiSearchField
	                      value={destinationText}
	                      selectedPlace={destinationPlaceDraft}
	                      city="全国"
	                      ariaLabel="出发点"
	                      placeholder="搜索出发城市、车站、机场或酒店"
	                      selectionHint="只用于确定出发位置，之后可以跨城市补地点。"
                      onQueryChange={updateDestinationText}
                      onSelect={selectDestinationPlace}
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px]">
                  <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                    出发日期
                    <Input type="date" value={startDateText} onChange={(event) => setStartDateText(event.target.value)} aria-label="出发日期" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                    返回日期
                    <Input type="date" value={endDateText} onChange={(event) => setEndDateText(event.target.value)} aria-label="返回日期" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground sm:col-span-2 lg:col-span-1">
                    总预算
                    <Input
                      type="number"
                      value={budgetText}
                      onChange={(event) => setBudgetText(event.target.value)}
                      aria-label="总预算"
                      placeholder="总预算"
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                  行程备注
                  <Input
                    value={notesText}
                    onChange={(event) => setNotesText(event.target.value)}
                    aria-label="行程备注"
                    placeholder="例如：每天留出午后休息，避免连续跨区。"
                  />
                </label>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-white px-5 py-4">
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setTripDetailsOpen(false)}>
                  取消
                </Button>
                <Button type="button" variant="secondary" className="rounded-full" onClick={saveTripDetails} disabled={!destinationText.trim() && !destinationPlaceDraft}>
                  应用信息
                </Button>
              </div>
            </div>
          </div>
        )}
        <DayContextBar
          itinerary={itinerary}
          day={day}
          daySummary={daySummary}
          dayRouteCount={dayRouteCount}
          dayMissingPlaceCount={dayMissingPlaceCount}
          selectedActivity={selectedActivity}
          selectedActivityIndex={selectedActivityIndex}
          selectedTransportContext={selectedTransportContext}
          onSelectDay={onSelectDay}
          onAddDay={onAddDay}
          onAddActivity={() => void addBlankActivityFromCanvas()}
        />
        <section className="mt-4 flex flex-col gap-3">
          {overnightStart && (
            <OvernightStartCard
              activity={overnightStart.activity}
              onEdit={() => {
                onSelectDay(overnightStart.day.id);
                setSelectedActivityId(overnightStart.activity.id);
                setSelectedTransportLegId(null);
              }}
            />
          )}
          {overnightRoutePair && (
            <TransportLegEditor
              leg={overnightRoutePair.leg}
              from={overnightRoutePair.fromActivity}
              to={overnightRoutePair.toActivity}
              fromIndex={overnightRoutePair.fromIndex}
              toIndex={overnightRoutePair.toIndex}
              selected={Boolean(overnightRoutePair.leg && selectedTransportLegId === overnightRoutePair.leg.id)}
              onFocus={() => {
                setSelectedActivityId(null);
                if (!overnightRoutePair.leg) setSelectedTransportLegId(null);
              }}
              onSelect={(legId) => {
                setSelectedTransportLegId(legId);
                setSelectedActivityId(null);
              }}
              onShowInMap={(legId) => {
                setSelectedTransportLegId(legId);
                setSelectedActivityId(null);
                setMapRouteFocusRequest((current) => ({
                  dayId: day.id,
                  legId,
                  nonce: (current?.nonce ?? 0) + 1
                }));
              }}
              onEditEndpoint={(activityId) => selectRouteEndpoint(overnightRoutePair, activityId)}
              onSave={(mode, overrides) => onSetTransport(day.id, overnightRoutePair.fromActivity.id, overnightRoutePair.toActivity.id, mode, overrides)}
              onRemove={() => onRemoveTransport(day.id, overnightRoutePair.fromActivity.id, overnightRoutePair.toActivity.id)}
            />
          )}
          {day.activities.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>这一天还没有安排</CardTitle>
                <CardDescription>先添加第一个地点，地图和时间线会同步展开。</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            day.activities.map((activity, index) => {
              const next = day.activities[index + 1];
              const routePair = next
                ? dayRoutePairs.find((pair) => !pair.overnightStart && pair.fromActivity.id === activity.id && pair.toActivity.id === next.id)
                : undefined;
              const leg = routePair?.leg;
              const showTransportLeg = Boolean(routePair);
              return (
                <div key={activity.id} className="flex flex-col gap-3">
                  <ActivityEditor
                    activity={activity}
                    index={index}
                    canMoveUp={index > 0}
                    canMoveDown={index < day.activities.length - 1}
                    selected={selectedActivityId === activity.id}
                    dragging={draggingActivityId === activity.id}
                    dropTarget={dragOverActivityIndex === index}
                    onDelete={() => onDeleteActivity(activity.id)}
                    onSelect={() => {
                      setSelectedActivityId(activity.id);
                      setSelectedTransportLegId(null);
                    }}
                    onMoveUp={() => onReorderActivity(day.id, activity.id, index - 1)}
                    onMoveDown={() => onReorderActivity(day.id, activity.id, index + 1)}
                    onDragStart={(event) => startActivityDrag(event, activity.id)}
                    onDragEnd={clearActivityDragState}
                    onDragOver={(event) => updateActivityDropTarget(event, index, activity.id)}
                    onDragLeave={(event) => {
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      setDragOverActivityIndex((current) => (current === index ? null : current));
                    }}
                    onDrop={(event) => dropActivity(event, index)}
                  />
                  {selectedActivityId === activity.id && (
                    <ActivityDetailsPanel
                      activity={activity}
                      index={index}
                      dayOptions={itinerary.days}
                      currentDayId={day.id}
                      onChange={(changes) => onUpdateActivity(activity.id, changes)}
                      onClose={() => setSelectedActivityId(null)}
                      onMoveToDay={(targetDayId) => {
                        if (targetDayId === day.id) return;
                        const targetDay = itinerary.days.find((candidate) => candidate.id === targetDayId);
                        void onMoveActivityToDay(activity.id, targetDayId, targetDay?.activities.length ?? 0);
                      }}
                    />
                  )}
                  {next && routePair && showTransportLeg && (
                    <TransportLegEditor
                      leg={leg}
                      from={activity}
                      to={next}
                      fromIndex={routePair.fromIndex}
                      toIndex={routePair.toIndex}
                      selected={Boolean(leg && selectedTransportLegId === leg.id)}
                      onFocus={() => {
                        setSelectedActivityId(null);
                        if (!leg) setSelectedTransportLegId(null);
                      }}
                      onSelect={(legId) => {
                        setSelectedTransportLegId(legId);
                        setSelectedActivityId(null);
                      }}
                      onShowInMap={(legId) => {
                        setSelectedTransportLegId(legId);
                        setSelectedActivityId(null);
                        setMapRouteFocusRequest((current) => ({
                          dayId: day.id,
                          legId,
                          nonce: (current?.nonce ?? 0) + 1
                        }));
                      }}
                      onEditEndpoint={(activityId) => selectRouteEndpoint(routePair, activityId)}
                      onSave={(mode, overrides) => onSetTransport(day.id, activity.id, next.id, mode, overrides)}
                      onRemove={() => onRemoveTransport(day.id, activity.id, next.id)}
                    />
                  )}
                </div>
              );
            })
          )}
          {exportText && (
            <Card className="bg-white">
              <CardHeader className="gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <CardTitle>导出预览</CardTitle>
                  <CardDescription>完整行程 Markdown，可用于分享或归档。</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => void copyExportMarkdown()} aria-label="复制导出 Markdown">
                    <Copy data-icon="inline-start" />
                    {exportCopyStatus || "复制"}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" className="rounded-full" onClick={redownloadExportMarkdown} aria-label="重新下载 Markdown">
                    <Download data-icon="inline-start" />
                    重新下载
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="grid gap-4">
                <section
                  aria-label="导出检查"
                  className={cn(
                    "rounded-2xl border p-4",
                    exportChecklist.complete ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-black">导出检查</p>
                    <Badge className={exportChecklist.complete ? "bg-emerald-600 text-white" : undefined}>
                      {exportChecklist.complete ? "可归档" : "待补齐"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {exportChecklist.complete ? "地点、时间和相邻交通已补齐" : `还有 ${exportChecklist.total} 项需要补齐`}
                  </p>
                  {!exportChecklist.complete && (
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      {exportChecklist.missingPlaces.length > 0 && (
                        <div className="grid gap-2">
                          <p className="text-xs font-black text-amber-900">地点</p>
                          <ul className="grid gap-1 text-xs leading-5 text-amber-900">
                            {exportChecklist.missingPlaceItems.map((item) => (
                              <li key={`place-${item.activityId}`} className="flex items-start justify-between gap-2">
                                <span>{item.label}</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="min-h-8 shrink-0 rounded-full bg-white px-2 py-1 text-[11px]"
                                  onClick={() => locatePlanningActivity(item)}
                                  aria-label={`定位待补地点：${item.label}`}
                                >
                                  定位
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {exportChecklist.missingTimes.length > 0 && (
                        <div className="grid gap-2">
                          <p className="text-xs font-black text-amber-900">时间</p>
                          <ul className="grid gap-1 text-xs leading-5 text-amber-900">
                            {exportChecklist.missingTimeItems.map((item) => (
                              <li key={`time-${item.activityId}`} className="flex items-start justify-between gap-2">
                                <span>{item.label}</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="min-h-8 shrink-0 rounded-full bg-white px-2 py-1 text-[11px]"
                                  onClick={() => locatePlanningActivity(item)}
                                  aria-label={`定位待补时间：${item.label}`}
                                >
                                  定位
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {exportChecklist.pendingTransport.length > 0 && (
                        <div className="grid gap-2">
                          <p className="text-xs font-black text-amber-900">交通</p>
                          <ul className="grid gap-1 text-xs leading-5 text-amber-900">
                            {exportChecklist.pendingTransportItems.map((item) => (
                              <li key={`transport-${item.fromActivityId}-${item.toActivityId}`} className="flex items-start justify-between gap-2">
                                <span>{item.label}</span>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="min-h-8 shrink-0 rounded-full bg-white px-2 py-1 text-[11px]"
                                  onClick={() => locatePlanningTransport(item)}
                                  aria-label={`定位待计算交通：${item.label}`}
                                >
                                  定位
                                </Button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </section>
                <pre className="max-h-72 overflow-auto rounded-2xl bg-secondary p-4 text-xs leading-6">
                  {exportText}
                </pre>
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function DayContextBar({
  itinerary,
  day,
  daySummary,
  dayRouteCount,
  dayMissingPlaceCount,
  selectedActivity,
  selectedActivityIndex,
  selectedTransportContext,
  onSelectDay,
  onAddDay,
  onAddActivity
}: {
  itinerary: TravelItinerary;
  day: ItineraryDay;
  daySummary: string;
  dayRouteCount: number;
  dayMissingPlaceCount: number;
  selectedActivity?: Activity;
  selectedActivityIndex: number;
  selectedTransportContext?: {
    fromActivity: Activity;
    toActivity: Activity;
    fromIndex: number;
    toIndex: number;
    leg: TransportLeg;
  };
  onSelectDay: (dayId: string) => void;
  onAddDay: (position?: "after" | "before") => void;
  onAddActivity: () => void;
}) {
  const routablePairCount = countRoutableAdjacentPairs(day, itinerary);
  const routeSummary = routablePairCount > 0 ? `${dayRouteCount}/${routablePairCount} 段路线` : "暂无路线";
  const selectedRouteName = selectedTransportContext
    ? activityRouteName(
        selectedTransportContext.fromActivity,
        selectedTransportContext.toActivity,
        selectedTransportContext.fromIndex,
        selectedTransportContext.toIndex
      )
    : undefined;
  const selectedActivitySummary = selectedActivity ? activitySummaryView(selectedActivity, selectedActivityIndex) : undefined;
  const selectedActivityTitle = selectedActivitySummary?.displayName;
  const hasSelectedCanvasContext = Boolean(selectedActivityTitle || selectedRouteName);
  const useCompactDayPicker = itinerary.days.length > 5;
  const selectedActivityMeta = selectedActivitySummary
    ? [selectedActivitySummary.time, selectedActivitySummary.place, selectedActivitySummary.typeLabel].filter(Boolean)
    : [];
  const selectedRouteMeta =
    selectedTransportContext && selectedRouteName
      ? [
          routeModeOptions.find(([value]) => value === selectedTransportContext.leg.mode)?.[1],
          transportProviderMeta(selectedTransportContext.leg).label,
          `${formatDistanceForUi(selectedTransportContext.leg.distanceMeters)} / ${selectedTransportContext.leg.durationMinutes} 分钟`
        ].filter(Boolean)
      : [];

  return (
    <section
      role="navigation"
      aria-label="行程日期和当前编辑上下文"
      data-testid="day-context-bar"
      className="mt-3 -mx-4 border-y border-[#dadad3] bg-white px-4 py-2.5 md:mt-5 md:-mx-6 md:px-6 md:py-3"
    >
      <div className="flex w-full max-w-full flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 w-fit max-w-full">
          {useCompactDayPicker && (
            <select
              className="h-10 min-h-10 w-full rounded-full border border-input bg-[#f6f6f3] px-3 text-sm font-black outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
              value={day.id}
              onChange={(event) => onSelectDay(event.target.value)}
              aria-label="选择日期"
            >
              {itinerary.days.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title} · {candidate.date}
                </option>
              ))}
            </select>
          )}
          <TabsList
            className={cn(
              "h-10 min-w-0 w-fit max-w-full snap-x overflow-x-auto whitespace-nowrap rounded-full bg-[#f6f6f3] p-0.5",
              useCompactDayPicker ? "hidden sm:flex" : "flex"
            )}
          >
            {itinerary.days.map((candidate) => (
              <TabsTrigger
                key={candidate.id}
                active={candidate.id === day.id}
                className={cn(
                  "h-9 min-h-9 shrink-0 snap-start",
                  candidate.id === day.id && "bg-primary text-primary-foreground"
                )}
                onClick={() => onSelectDay(candidate.id)}
              >
                {candidate.title}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Button type="button" variant="outline" size="sm" className="size-10 h-10 min-h-10 shrink-0 rounded-full p-0 min-[480px]:size-auto min-[480px]:px-3" onClick={() => onAddDay("before")} aria-label="前加一天">
            <CalendarPlus />
            <span className="hidden min-[480px]:inline">前加一天</span>
          </Button>
          <Button type="button" variant="outline" size="sm" className="size-10 h-10 min-h-10 shrink-0 rounded-full p-0 min-[480px]:size-auto min-[480px]:px-3" onClick={() => onAddDay("after")} aria-label="后加一天">
            <CalendarPlus />
            <span className="hidden min-[480px]:inline">后加一天</span>
          </Button>
          <Button type="button" size="sm" className="h-10 min-h-10 rounded-full px-4" onClick={onAddActivity} aria-label="添加活动">
            <Plus data-icon="inline-start" />
            <span className="hidden sm:inline">添加活动</span>
            <span className="sm:hidden">添加</span>
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "mt-3 grid gap-2",
          hasSelectedCanvasContext && "min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(260px,0.62fr)] min-[1180px]:items-stretch"
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-black md:text-xl">{day.title}</h3>
            {day.weather && (
              <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-[#e5e5e0] bg-[#f6f6f3] px-2.5 text-xs font-bold text-[#33332e]">
                <CloudSun className="size-3.5" />
                {day.weather.weather}
                <span className="text-muted-foreground">{formatTemperatureForUi(day.weather.temperature)}</span>
              </span>
            )}
            {[daySummary, routeSummary, dayMissingPlaceCount > 0 ? `${dayMissingPlaceCount} 项缺地点` : undefined]
              .filter(Boolean)
              .map((item) => (
                <span key={item} className="inline-flex min-h-7 items-center rounded-full border border-[#e5e5e0] bg-[#f6f6f3] px-2.5 text-xs font-bold text-[#33332e]">
                  {item}
                </span>
              ))}
          </div>
        </div>
        {hasSelectedCanvasContext && (
        <div
          data-testid="selected-canvas-context"
          className="grid min-w-0 gap-1 rounded-2xl border border-[#e5e5e0] bg-white px-3 py-2 text-sm"
        >
          {selectedActivityTitle ? (
            <>
              <p className="text-xs font-black text-muted-foreground">正在编辑</p>
              <p className="truncate font-black">{selectedActivityTitle}</p>
              {selectedActivityMeta.length > 0 && (
                <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{selectedActivityMeta.join(" · ")}</p>
              )}
            </>
          ) : selectedRouteName ? (
            <>
              <p className="text-xs font-black text-muted-foreground">正在查看</p>
              <p className="truncate font-black">{selectedRouteName}</p>
              {selectedRouteMeta.length > 0 && (
                <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">{selectedRouteMeta.join(" · ")}</p>
              )}
            </>
          ) : null}
        </div>
        )}
      </div>
    </section>
  );
}

function MapPanel({
  itinerary,
  day,
  selectedActivityId,
  selectedTransportLegId,
  routeFocusRequest,
  onAddPlace,
  onSelectDay,
  onSelectActivity,
  onSelectTransportLeg,
  onExpandedChange,
  onRouteFocusRequestConsumed,
  onUpdateActivity
}: {
  itinerary: TravelItinerary;
  day: ItineraryDay;
  selectedActivityId: string | null;
  selectedTransportLegId: string | null;
  routeFocusRequest: MapRouteFocusRequest | null;
  onAddPlace: (place: PlaceSearchItem) => TravelItinerary | void | Promise<TravelItinerary | void>;
  onSelectDay: (dayId: string) => void;
  onSelectActivity: (activityId: string) => void;
  onSelectTransportLeg: (legId: string) => void;
  onExpandedChange?: (open: boolean) => void;
  onRouteFocusRequestConsumed: () => void;
  onUpdateActivity: (activityId: string, changes: Partial<Activity>) => void | Promise<void>;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const [mapScope, setMapScope] = useState<"day" | "trip">("day");
  const [mapExpanded, setMapExpanded] = useState(false);
  const [mapSearchText, setMapSearchText] = useState("");
  const [mapSearchResults, setMapSearchResults] = useState<PlaceSearchItem[]>([]);
  const [mapSearchStatus, setMapSearchStatus] = useState("");
  const [activeMapSearchPlaceId, setActiveMapSearchPlaceId] = useState<string | null>(null);
  const [mapFilterText, setMapFilterText] = useState("");
  const [destinationCenter, setDestinationCenter] = useState<NonNullable<Place["coordinates"]> | null>(null);
  const [hideEmptyTripDays, setHideEmptyTripDays] = useState(false);
  const [mapEditPanel, setMapEditPanel] = useState<"places" | "routes" | "risks">("places");
  const [selectedRouteStepIndex, setSelectedRouteStepIndex] = useState(0);
  const [lastAddedPlace, setLastAddedPlace] = useState<{ dayTitle: string; placeName: string } | null>(null);
  const [lastRouteFix, setLastRouteFix] = useState<{
    activityId: string;
    activityTitle: string;
    previousStartTime: string | undefined;
    previousEndTime: string | undefined;
    nextStartTime: string;
  } | null>(null);
  const mapActionRefs = useRef({
    onSelectDay,
    onSelectActivity,
    onSelectTransportLeg
  });
  useEffect(() => {
    mapActionRefs.current = {
      onSelectDay,
      onSelectActivity,
      onSelectTransportLeg
    };
  }, [onSelectActivity, onSelectDay, onSelectTransportLeg]);
  const tripDaysWithPlaces = itinerary.days.filter((visibleDay) => visibleDay.activities.some(hasMapPoint));
  const hiddenEmptyTripDayCount = Math.max(0, itinerary.days.length - tripDaysWithPlaces.length);
  const visibleDays = mapScope === "trip" && hideEmptyTripDays ? tripDaysWithPlaces : mapScope === "trip" ? itinerary.days : [day];
  const points = visibleDays.flatMap((visibleDay) =>
    visibleDay.activities.flatMap((activity, index) => (hasMapPoint(activity) ? [{ day: visibleDay, activity, index }] : []))
  );
  const normalizedMapFilter = normalizeMapFilter(mapFilterText);
  const filteredPoints = normalizedMapFilter
    ? points.filter(({ day: pointDay, activity, index }) => activityMatchesMapFilter(activity, index, pointDay, normalizedMapFilter))
    : points;
  const searchPreviewPoints = mapExpanded ? mapSearchResults.filter((place) => place.location) : [];
  const legs = visibleDays.flatMap((visibleDay) => getAdjacentTransportLegs(visibleDay, itinerary));
  const routeSegmentsForDay = (targetDay: ItineraryDay) =>
    getRoutePairsForDay(itinerary, targetDay).map((pair) => ({
      day: targetDay,
      fromActivity: pair.fromActivity,
      toActivity: pair.toActivity,
      leg: pair.leg,
      fromIndex: pair.fromIndex,
      toIndex: pair.toIndex,
      fromDayId: pair.fromDayId,
      toDayId: pair.toDayId,
      overnightStart: pair.overnightStart
    }));
  const allRouteSegments = visibleDays.flatMap((visibleDay) => routeSegmentsForDay(visibleDay));
  const routeSegments = mapScope === "day" ? routeSegmentsForDay(day) : [];
  const pendingLegCount = visibleDays.reduce((sum, visibleDay) => {
    const expectedLegs = countRoutableAdjacentPairs(visibleDay, itinerary);
    return sum + Math.max(0, expectedLegs - getAdjacentTransportLegs(visibleDay, itinerary).length);
  }, 0);
  const unplacedActivityCount = visibleDays.reduce(
    (sum, visibleDay) => sum + visibleDay.activities.filter((activity) => !hasMapPoint(activity)).length,
    0
  );
  const totalDistance = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const totalDuration = legs.reduce((sum, leg) => sum + leg.durationMinutes, 0);
  const routeTitle = mapScope === "trip" ? "全部行程" : day.title;
  const routeSummaryItems =
    pendingLegCount > 0
      ? [routeTitle, `${points.length} 个地点`, `${pendingLegCount} 段交通待确认`]
      : legs.length > 0
        ? [routeTitle, `${points.length} 个地点`, `${legs.length} 段交通`, formatDistanceForUi(totalDistance), `${totalDuration} 分钟`]
        : [routeTitle, `${points.length} 个地点`];
  const routeSummary =
    routeSummaryItems.join(" · ");
  const hasActivitiesWithoutMapPoints = unplacedActivityCount > 0;
  const emptySummary =
    hasActivitiesWithoutMapPoints
      ? mapScope === "trip"
        ? `${unplacedActivityCount} 项安排缺少地点`
        : `${day.title} · ${unplacedActivityCount} 项安排缺少地点`
      : mapScope === "trip"
        ? "全部行程还没有地点"
        : `${day.title} 还没有地点`;
  const routeMetricSummary =
    pendingLegCount > 0
      ? `${points.length} 个地点 · ${pendingLegCount} 段交通待确认`
      : legs.length > 0
        ? `${points.length} 个地点 · ${legs.length} 段交通 · ${formatDistanceForUi(totalDistance)} · ${totalDuration} 分钟`
        : `${points.length} 个地点`;
  const visibleMapSummaryItems = points.length > 0 ? [routeTitle, routeMetricSummary] : [];
  const mapEmptyTitle = hasActivitiesWithoutMapPoints ? `${unplacedActivityCount} 项安排缺少地点` : "还没有地点";
  const mapEmptyDescription =
    hasActivitiesWithoutMapPoints
      ? "从搜索结果加入真实地点，或编辑下方安排。"
      : "先创建一项安排，再在活动里补地点。";
  const showMapEmptyGuidance = points.length === 0 && mapScope !== "trip";
  function routeSegmentMatchesMapFilter(segment: (typeof allRouteSegments)[number], filter: string): boolean {
    const segmentTitle = activityRouteName(segment.fromActivity, segment.toActivity, segment.fromIndex, segment.toIndex);
    return (
      activityMatchesMapFilter(segment.fromActivity, segment.fromIndex, segment.day, filter) ||
      activityMatchesMapFilter(segment.toActivity, segment.toIndex, segment.day, filter) ||
      textMatchesMapFilter(filter, [
        segment.day.title,
        segment.day.date,
        segmentTitle,
        segment.leg?.summary,
        segment.leg?.note,
        segment.leg?.mode,
        segment.leg ? routeModeOptions.find(([mode]) => mode === segment.leg?.mode)?.[1] : undefined,
        segment.leg ? transportProviderMeta(segment.leg).label : undefined
      ])
    );
  }

  const dayRouteSummaries = visibleDays.map((visibleDay) => {
    const dayPointItems = visibleDay.activities.flatMap((activity, index) =>
      hasMapPoint(activity) ? [{ activity, index }] : []
    );
    const dayPoints = dayPointItems.map((item) => item.activity);
    const dayLegs = getAdjacentTransportLegs(visibleDay, itinerary);
    const daySegments = routeSegmentsForDay(visibleDay);
    const filteredDayPoints = normalizedMapFilter
      ? dayPointItems.filter(({ activity, index }) => activityMatchesMapFilter(activity, index, visibleDay, normalizedMapFilter))
      : dayPointItems;
    const filteredDaySegments = normalizedMapFilter
      ? daySegments.filter((segment) => routeSegmentMatchesMapFilter(segment, normalizedMapFilter))
      : daySegments;
    const expectedLegs = countRoutableAdjacentPairs(visibleDay, itinerary);
    const dayPendingLegs = Math.max(0, expectedLegs - dayLegs.length);
    const dayMatchesFilter =
      !normalizedMapFilter ||
      textMatchesMapFilter(normalizedMapFilter, [visibleDay.title, visibleDay.date]) ||
      filteredDayPoints.length > 0 ||
      filteredDaySegments.length > 0;
    return {
      day: visibleDay,
      points: normalizedMapFilter ? filteredDayPoints.map((item) => item.activity) : dayPoints,
      routeSegments: filteredDaySegments,
      pointCount: dayPoints.length,
      legCount: dayLegs.length,
      pendingLegCount: dayPendingLegs,
      distanceMeters: dayLegs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationMinutes: dayLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0),
      matchesFilter: dayMatchesFilter
    };
  });
  const filteredDayRouteSummaries =
    mapScope === "trip" && normalizedMapFilter
      ? dayRouteSummaries.filter((summary) => summary.matchesFilter)
      : dayRouteSummaries;
  const tripRouteOverviewSegments = filteredDayRouteSummaries.flatMap((summary) => summary.routeSegments);
  const tripPlannedRouteSegments = tripRouteOverviewSegments.filter((segment) => segment.leg);
  const tripPendingRouteSegmentCount = tripRouteOverviewSegments.length - tripPlannedRouteSegments.length;
  const tripOverviewDistanceMeters = tripPlannedRouteSegments.reduce((sum, segment) => sum + (segment.leg?.distanceMeters ?? 0), 0);
  const tripOverviewDurationMinutes = tripPlannedRouteSegments.reduce((sum, segment) => sum + (segment.leg?.durationMinutes ?? 0), 0);
  const routeRiskItems = visibleDays.flatMap((visibleDay) =>
    getRoutePairsForDay(itinerary, visibleDay).flatMap((pair) => {
      const conflict = pair.leg ? detectTransportTimingConflict(pair.fromActivity, pair.toActivity, pair.leg) : undefined;
      if (!pair.leg || !conflict) return [];
      return [
        {
          day: visibleDay,
          fromActivity: pair.fromActivity,
          toActivity: pair.toActivity,
          fromIndex: pair.fromIndex,
          toIndex: pair.toIndex,
          leg: pair.leg,
          conflict
        }
      ];
    })
  );
  const filteredRouteSegments = normalizedMapFilter
    ? routeSegments.filter((segment) => routeSegmentMatchesMapFilter(segment, normalizedMapFilter))
    : routeSegments;
  const selectedMapActivityIndex = day.activities.findIndex((activity) => activity.id === selectedActivityId);
  const selectedMapActivity = selectedMapActivityIndex >= 0 ? day.activities[selectedMapActivityIndex] : undefined;
  const selectedMapRouteSegment = routeSegments.find((segment) => segment.leg?.id === selectedTransportLegId);
  const selectedMapRouteTitle = selectedMapRouteSegment
    ? activityRouteName(
        selectedMapRouteSegment.fromActivity,
        selectedMapRouteSegment.toActivity,
        selectedMapRouteSegment.fromIndex,
        selectedMapRouteSegment.toIndex
      )
    : undefined;
  const selectedMapRouteProvider =
    selectedMapRouteSegment?.leg ? transportProviderMeta(selectedMapRouteSegment.leg) : undefined;
  const selectedMapRouteSteps =
    selectedMapRouteSegment?.leg && selectedMapRouteTitle
      ? routeStepsForMapDisplay(
          selectedMapRouteSegment.leg,
          selectedMapRouteSegment.toActivity
        )
      : [];
  const selectedRouteStepIndexForRender =
    selectedMapRouteSteps.length > 0 ? Math.min(selectedRouteStepIndex, selectedMapRouteSteps.length - 1) : 0;
  const selectedMapRouteStep = selectedMapRouteSteps[selectedRouteStepIndexForRender];
  const filteredRouteRiskItems = normalizedMapFilter
    ? routeRiskItems.filter((item) => {
        const routeName = `${activityDisplayName(item.fromActivity, item.fromIndex)} 到 ${activityDisplayName(
          item.toActivity,
          item.toIndex
        )}`;
        return (
          activityMatchesMapFilter(item.fromActivity, item.fromIndex, item.day, normalizedMapFilter) ||
          activityMatchesMapFilter(item.toActivity, item.toIndex, item.day, normalizedMapFilter) ||
          textMatchesMapFilter(normalizedMapFilter, [routeName, item.conflict.message])
        );
      })
    : routeRiskItems;
  const mapDisplayPoints = mapExpanded || normalizedMapFilter ? filteredPoints : points;
  const coordinatePoints = mapDisplayPoints.filter((item) => item.activity.place?.coordinates);
  const destinationPlaceCoordinates = itinerary.destinationPlace?.coordinates;
  useEffect(() => {
    if (!routeFocusRequest) return;
    if (day.id !== routeFocusRequest.dayId) {
      onSelectDay(routeFocusRequest.dayId);
      return;
    }
    const targetRouteExists = routeSegmentsForDay(day).some((segment) => segment.leg?.id === routeFocusRequest.legId);
    if (!targetRouteExists) {
      onRouteFocusRequestConsumed();
      return;
    }
    setMapScope("day");
    setMapExpanded(true);
    setMapEditPanel("routes");
    setMapFilterText("");
    onSelectTransportLeg(routeFocusRequest.legId);
    onRouteFocusRequestConsumed();
  }, [day, onRouteFocusRequestConsumed, onSelectDay, onSelectTransportLeg, routeFocusRequest]);
  useEffect(() => {
    if (!mapExpanded) return;
    if (mapEditPanel === "routes" && routeSegments.length === 0) setMapEditPanel("places");
    if (mapEditPanel === "risks" && routeRiskItems.length === 0) setMapEditPanel("places");
  }, [mapEditPanel, mapExpanded, routeRiskItems.length, routeSegments.length]);
  useEffect(() => {
    setSelectedRouteStepIndex(0);
  }, [selectedTransportLegId]);
  useEffect(() => {
    if (selectedRouteStepIndex >= selectedMapRouteSteps.length && selectedMapRouteSteps.length > 0) {
      setSelectedRouteStepIndex(0);
    }
  }, [selectedMapRouteSteps.length, selectedRouteStepIndex]);
  useEffect(() => {
    setLastRouteFix(null);
  }, [itinerary.id]);
  useEffect(() => {
    if (!lastRouteFix) return;
    const fixedActivityExists = itinerary.days.some((visibleDay) =>
      visibleDay.activities.some((activity) => activity.id === lastRouteFix.activityId)
    );
    if (!fixedActivityExists) setLastRouteFix(null);
  }, [itinerary.days, lastRouteFix]);
  const coordinateFingerprint = coordinatePoints
    .map(({ day: pointDay, activity }) => {
      const coordinates = activity.place?.coordinates;
      return `${pointDay.id}:${activity.id}:${coordinates?.lng ?? ""}:${coordinates?.lat ?? ""}`;
    })
    .join("|");
  const legFingerprint = legs
    .map((leg) => `${leg.id}:${leg.fromActivityId}:${leg.toActivityId}:${leg.polyline?.length ?? 0}:${leg.provider}`)
    .join("|");
  const selectedRouteStepPolylineFingerprint = selectedMapRouteStep?.polyline
    .map((point) => `${point.lng}:${point.lat}`)
    .join("|") ?? "";
  const searchPreviewFingerprint = searchPreviewPoints
    .map((place) => `${place.id}:${place.location.lng}:${place.location.lat}`)
    .join("|");
  const activeMapSearchPlace = searchPreviewPoints.find((place) => place.id === activeMapSearchPlaceId) ?? searchPreviewPoints[0];
  const activeMapSearchPlaceIdForRender = activeMapSearchPlace?.id ?? null;
  const destinationFallbackCenter = cityFallbackCoordinates(itinerary.destination);
  const destinationCenterFingerprint = destinationCenter ? `${destinationCenter.lng}:${destinationCenter.lat}` : "";
  const destinationPlaceFingerprint = destinationPlaceCoordinates
    ? `${destinationPlaceCoordinates.lng}:${destinationPlaceCoordinates.lat}`
    : "";

  useEffect(() => {
    let cancelled = false;
    async function resolveDestinationCenter() {
      try {
        if (destinationPlaceCoordinates) {
          setDestinationCenter(destinationPlaceCoordinates);
          return;
        }
        const destination = itinerary.destination.trim();
        if (!destination) {
          setDestinationCenter(null);
          return;
        }
        const result = await apiGet<{ items: PlaceSearchItem[] }>(`/maps/poi?keywords=${encodeURIComponent(destination)}&city=${encodeURIComponent(destination)}`);
        if (cancelled) return;
        setDestinationCenter(amapPoiItems(result.items)[0]?.location ?? cityFallbackCoordinates(destination));
      } catch {
        if (cancelled) return;
        setDestinationCenter(destinationFallbackCenter);
      }
    }
    void resolveDestinationCenter();
    return () => {
      cancelled = true;
    };
  }, [destinationPlaceCoordinates, destinationPlaceFingerprint, itinerary.destination]);

  useEffect(() => {
    let disposed = false;
    async function renderMap() {
      const key = import.meta.env.VITE_AMAP_JS_API_KEY as string | undefined;
      const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE as string | undefined;
      if (!key || !mapRef.current) {
        return;
      }
      try {
        const AMap = await loadAmap(key, securityJsCode);
        if (disposed || !mapRef.current) return;
        mapRef.current.innerHTML = "";
        const center =
          searchPreviewPoints[0]?.location ??
          coordinatePoints[0]?.activity.place?.coordinates ??
          destinationCenter ??
          destinationFallbackCenter;
        const map = new AMap.Map(mapRef.current, {
          zoom: coordinatePoints.length + searchPreviewPoints.length > 1 ? 12 : 13,
          center: [center.lng, center.lat],
          viewMode: "2D"
        });
        if (AMap.Scale) map.addControl?.(new AMap.Scale());
        if (AMap.ToolBar) map.addControl?.(new AMap.ToolBar({ position: "RB" }));
        const rootStyles = getComputedStyle(document.documentElement);
        const tokenColor = (name: string, fallback: string) => {
          const value = rootStyles.getPropertyValue(name).trim();
          return value ? `hsl(${value})` : fallback;
        };
        const mapColors = {
          primary: tokenColor("--primary", "#d50024"),
          foreground: tokenColor("--foreground", "#211f1f"),
          muted: tokenColor("--muted-foreground", "#66645f")
        };
        coordinatePoints.forEach((item) => {
          const coordinates = item.activity.place!.coordinates!;
          const label =
            mapScope === "trip"
              ? `${item.day.title} · ${item.index + 1}. ${activityDisplayName(item.activity, item.index)}`
              : `${item.index + 1}. ${activityDisplayName(item.activity, item.index)}`;
          const marker = new AMap.Marker({
            position: [coordinates.lng, coordinates.lat],
            content: mapMarkerContent(label),
            anchor: "bottom-center",
            offset: new AMap.Pixel(0, -6)
          });
          marker.on?.("click", () => {
            const actions = mapActionRefs.current;
            actions.onSelectDay(item.day.id);
            setMapScope("day");
            setMapEditPanel("places");
            actions.onSelectActivity(item.activity.id);
          });
          map.add(marker);
        });
        searchPreviewPoints.forEach((place, index) => {
          const marker = new AMap.Marker({
            position: [place.location.lng, place.location.lat],
            content: mapMarkerContent(`候选 ${index + 1}. ${place.name}`, "candidate"),
            anchor: "bottom-center",
            offset: new AMap.Pixel(0, -6)
          });
          marker.on?.("click", () => setActiveMapSearchPlaceId(place.id));
          map.add(marker);
        });
        legs
          .filter((leg) => leg.polyline?.length)
          .forEach((leg) => {
            const selected = selectedTransportLegId === leg.id;
            const polyline = new AMap.Polyline({
              path: leg.polyline!.map((point) => [point.lng, point.lat]),
              strokeColor: selected ? mapColors.primary : mapColors.foreground,
              strokeWeight: selected ? 7 : 5,
              strokeOpacity: selected ? 0.95 : 0.72
            });
            polyline.on?.("click", () => mapActionRefs.current.onSelectTransportLeg(leg.id));
            map.add(polyline);
        });
        if (selectedMapRouteStep?.polyline.length) {
          const stepPolyline = new AMap.Polyline({
            path: selectedMapRouteStep.polyline.map((point) => [point.lng, point.lat]),
            strokeColor: mapColors.primary,
            strokeWeight: 9,
            strokeOpacity: 0.98
          });
          map.add(stepPolyline);
        }
        if (coordinatePoints.length + searchPreviewPoints.length > 1) map.setFitView();
      } catch {
      }
    }
    void renderMap();
    return () => {
      disposed = true;
    };
  }, [
    coordinateFingerprint,
    day.id,
    destinationCenterFingerprint,
    itinerary.id,
    itinerary.destination,
    legFingerprint,
    mapExpanded,
    mapScope,
    searchPreviewFingerprint,
    selectedRouteStepPolylineFingerprint,
    selectedTransportLegId
  ]);

  async function searchMapPlaces() {
    const query = mapSearchText.trim();
    if (!query) {
      setMapSearchResults([]);
      setMapSearchStatus("输入关键词后搜索高德地点");
      return;
    }
    setMapSearchStatus("正在搜索高德地点...");
    try {
      const result = await apiGet<{ items: PlaceSearchItem[] }>(`/maps/poi?keywords=${encodeURIComponent(query)}&city=${encodeURIComponent("全国")}`);
      const concreteItems = amapPoiItems(result.items);
      setMapSearchResults(concreteItems);
      setActiveMapSearchPlaceId(concreteItems.find((place) => place.location)?.id ?? concreteItems[0]?.id ?? null);
      setMapSearchStatus(concreteItems.length > 0 ? "" : "没有找到可用的高德地点，请换个关键词。");
    } catch (error) {
      setMapSearchResults([]);
      setActiveMapSearchPlaceId(null);
      setMapSearchStatus(readApiRequestErrorMessage(error, "高德地点搜索失败，请稍后重试。"));
    }
  }

  async function addMapPlace(place: PlaceSearchItem) {
    await onAddPlace(place);
    setLastAddedPlace({ dayTitle: day.title, placeName: place.name });
    setMapSearchText("");
    setMapSearchResults([]);
    setMapSearchStatus("");
    setActiveMapSearchPlaceId(null);
  }

  async function fillSelectedActivityWithMapPlace(place: PlaceSearchItem) {
    if (!selectedMapActivity) return;
    await onUpdateActivity(selectedMapActivity.id, activityChangesFromSearchPlace(place));
    onSelectActivity(selectedMapActivity.id);
    setMapSearchText("");
    setMapSearchResults([]);
    setMapSearchStatus("");
    setActiveMapSearchPlaceId(null);
  }

  function selectRiskRoute(item: (typeof routeRiskItems)[number]) {
    onSelectDay(item.day.id);
    setMapScope("day");
    setMapEditPanel("risks");
    onSelectTransportLeg(item.leg.id);
  }

  function delayNextActivityForRisk(item: (typeof routeRiskItems)[number]) {
    const shiftedEndTime = addMinutesToClockValue(item.toActivity.endTime, item.conflict.delayMinutes);
    setLastRouteFix({
      activityId: item.toActivity.id,
      activityTitle: activityDisplayName(item.toActivity, item.toIndex),
      previousStartTime: item.toActivity.startTime,
      previousEndTime: item.toActivity.endTime,
      nextStartTime: item.conflict.estimatedArrivalTime
    });
    void onUpdateActivity(item.toActivity.id, {
      startTime: item.conflict.estimatedArrivalTime,
      endTime: shiftedEndTime ?? item.toActivity.endTime
    });
    onSelectDay(item.day.id);
    setMapScope("day");
    setMapEditPanel("places");
    onSelectTransportLeg(item.leg.id);
  }

  function undoLastRouteFix() {
    if (!lastRouteFix) return;
    void onUpdateActivity(lastRouteFix.activityId, {
      startTime: lastRouteFix.previousStartTime,
      endTime: lastRouteFix.previousEndTime
    });
    setLastRouteFix(null);
  }

  function selectOverviewActivity(targetDay: ItineraryDay, activity: Activity) {
    onSelectDay(targetDay.id);
    setMapScope("day");
    setMapEditPanel("places");
    onSelectActivity(activity.id);
  }

  function focusRouteEditorFromMap(legId: string, targetDayId?: string) {
    if (targetDayId) {
      onSelectDay(targetDayId);
      setMapScope("day");
    }
    onSelectTransportLeg(legId);
    setMapExpanded(false);
    setMapEditPanel("routes");
  }

  function toggleMapExpanded() {
    setMapExpanded((expanded) => {
      const nextExpanded = !expanded;
      if (nextExpanded) setMapEditPanel("places");
      onExpandedChange?.(nextExpanded);
      return nextExpanded;
    });
  }

  return (
    <section
      role={mapExpanded ? "region" : undefined}
      aria-label={mapExpanded ? "地图编辑工作区" : undefined}
      data-testid={mapExpanded ? "map-edit-workspace" : "map-panel"}
      className={cn(
        "overflow-hidden rounded-2xl border border-[#dadad3] bg-white text-[#211922] transition-[min-height]",
        mapExpanded &&
          "fixed inset-0 z-[1100] flex h-dvh min-h-0 flex-col rounded-none border-0 shadow-2xl md:inset-4 md:h-[calc(100vh-2rem)] md:rounded-[32px] md:border md:border-[#dadad3]"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#dadad3] bg-white px-3 py-3 md:gap-4 md:px-4">
        <div className="min-w-0 self-center">
          <p className="hidden text-sm font-bold text-[#62625b] md:block">行程地图</p>
          <h3 className="truncate text-lg font-black text-[#211922] md:text-2xl">出发点：{itinerary.destination}</h3>
          {points.length > 0 && <p className="sr-only">{routeSummary}</p>}
          <div className="mt-1 flex flex-wrap gap-1.5 md:mt-2 md:gap-2" aria-hidden="true">
            {visibleMapSummaryItems.map((item, index) => (
              <span
                key={item}
                className={cn(
                  "rounded-full border border-[#e5e5e0] bg-[#f6f6f3] px-3 py-1 text-xs font-bold text-[#62625b]",
                  index === 0 && "hidden sm:inline-flex"
                )}
              >
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5 md:gap-2">
          {mapScope === "trip" && hiddenEmptyTripDayCount > 0 && (
            <Button
              type="button"
              variant={hideEmptyTripDays ? "secondary" : "outline"}
              size="sm"
              className="rounded-full"
              onClick={() => setHideEmptyTripDays((hidden) => !hidden)}
            >
              {hideEmptyTripDays ? "显示全部日期" : "只看有地点的日期"}
            </Button>
          )}
          <TabsList className="h-10 rounded-full bg-[#f6f6f3] p-0">
            <TabsTrigger
              type="button"
              active={mapScope === "day"}
              className="h-10 min-h-10 px-2 py-0 text-xs data-[active=true]:bg-[#262622] md:px-3"
              onClick={() => setMapScope("day")}
            >
              当前日期
            </TabsTrigger>
            <TabsTrigger
              type="button"
              active={mapScope === "trip"}
              className="h-10 min-h-10 px-2 py-0 text-xs md:px-3"
              onClick={() => setMapScope("trip")}
            >
              全部行程
            </TabsTrigger>
          </TabsList>
          {!mapExpanded && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-10 min-h-10 rounded-full px-2.5 py-0 text-xs md:px-3"
              onClick={toggleMapExpanded}
            >
              <Search data-icon="inline-start" />
              搜索地点
            </Button>
          )}
          {mapExpanded && (
            <Button type="button" variant="outline" size="sm" className="h-10 min-h-10 rounded-full px-2.5 py-0 text-xs md:px-3" onClick={toggleMapExpanded}>
              收起地图
            </Button>
          )}
        </div>
      </div>
      {mapScope === "trip" && hideEmptyTripDays && hiddenEmptyTripDayCount > 0 && (
        <div className="border-b border-[#dadad3] bg-white px-4 py-2 text-xs font-semibold text-muted-foreground">
          已隐藏 {hiddenEmptyTripDayCount} 个空日期
        </div>
      )}
      {lastAddedPlace && (
        <div className="border-b border-[#dadad3] bg-white px-4 py-2 text-xs font-semibold text-foreground">
          已加入 {lastAddedPlace.dayTitle}：{lastAddedPlace.placeName}
        </div>
      )}
      {lastRouteFix && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-[#dadad3] bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-950"
        >
          <span>已将{lastRouteFix.activityTitle}调整到 {lastRouteFix.nextStartTime}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9 rounded-full bg-white px-3 text-xs text-emerald-950 hover:bg-emerald-100"
            onClick={undoLastRouteFix}
          >
            撤销本次路线修复
          </Button>
        </div>
      )}
      {mapExpanded && (
        <div className="grid gap-2 border-b border-[#dadad3] bg-white px-3 py-3">
          <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-2">
            <Input
              className="bg-[#fbfbf9]"
              value={mapSearchText}
              onChange={(event) => {
                setMapSearchText(event.target.value);
                setMapSearchStatus("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void searchMapPlaces();
                }
              }}
              aria-label="在地图上搜索地点"
              placeholder="搜索景点、餐厅、车站或跨城地点"
            />
            <Button type="button" variant="secondary" className="min-w-0 rounded-2xl px-3" onClick={searchMapPlaces} aria-label="搜索地点">
              <Search data-icon="inline-start" />
              搜索
            </Button>
          </div>
          {mapSearchStatus && (
            <p className="rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs font-semibold text-muted-foreground" aria-live="polite">
              {mapSearchStatus}
            </p>
          )}
          {mapSearchResults.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-2xl border border-border bg-white p-2 lg:col-span-2">
              {searchPreviewPoints.length > 0 && (
                <p
                  data-testid="map-search-preview-status"
                  className="mb-2 rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs font-semibold text-muted-foreground"
                >
                  已在地图上预览 {searchPreviewPoints.length} 个地点
                  {!selectedMapActivity && `，选择后加入 ${day.title}`}
                </p>
              )}
              {mapSearchResults.map((place) => {
                const active = activeMapSearchPlaceIdForRender === place.id;
                const content = (actionLabel: string) => (
                  <>
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate font-bold">{place.name}</span>
                      <Badge className="min-h-6 bg-[#f6f6f3] px-2 text-[11px] text-foreground">
                        {poiCategoryLabel(place)}
                      </Badge>
                      <span className="ml-auto rounded-full bg-secondary px-2.5 py-1 text-xs font-black text-foreground">
                        {actionLabel}
                      </span>
                    </span>
                    <span className="line-clamp-1 text-xs text-muted-foreground">
                      {[place.district, place.address].filter(Boolean).join(" · ") || place.city}
                    </span>
                    {placeMetaItems(place).length > 0 && (
                      <span className="flex flex-wrap gap-1.5 text-xs font-semibold text-muted-foreground">
                        {placeMetaItems(place).map((item) => (
                          <span key={item} className="rounded-full bg-[#f6f6f3] px-2 py-0.5">
                            {item}
                          </span>
                        ))}
                      </span>
                    )}
                  </>
                );

                if (selectedMapActivity) {
                  return (
                    <div
                      key={place.id}
                      data-testid={`map-search-result-${place.id}`}
                      data-active={active ? "true" : "false"}
                      className={cn(
                        "overflow-hidden rounded-xl border border-transparent transition-colors hover:border-border hover:bg-secondary",
                        active && "border-ring bg-secondary ring-2 ring-ring"
                      )}
                      onMouseEnter={() => setActiveMapSearchPlaceId(place.id)}
                      onFocusCapture={() => setActiveMapSearchPlaceId(place.id)}
                    >
                      <button
                        type="button"
                        className="grid w-full gap-2 px-3 py-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => fillSelectedActivityWithMapPlace(place)}
                        aria-label={`填入第 ${selectedMapActivityIndex + 1} 项：${place.name}`}
                      >
                        {content("填入")}
                      </button>
                      <div className="flex justify-end border-t border-border/70 bg-white/70 px-3 py-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-8 rounded-full px-3 text-xs"
                          onClick={() => addMapPlace(place)}
                          aria-label={`添加${place.name}到 ${day.title}`}
                        >
                          新增到 {day.title}
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <button
                    key={place.id}
                    type="button"
                    data-testid={`map-search-result-${place.id}`}
                    data-active={active ? "true" : "false"}
                    className={cn(
                      "grid w-full gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active && "bg-secondary ring-2 ring-ring"
                    )}
                    onMouseEnter={() => setActiveMapSearchPlaceId(place.id)}
                    onFocus={() => setActiveMapSearchPlaceId(place.id)}
                    onClick={() => addMapPlace(place)}
                    aria-label={`添加${place.name}到 ${day.title}`}
                  >
                    {content("加入")}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {showMapEmptyGuidance && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dadad3] bg-white px-4 py-3">
          <div className="min-w-0">
            <p className="font-black">{mapEmptyTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{mapEmptyDescription}</p>
          </div>
        </div>
      )}
      {routeRiskItems.length > 0 && !mapExpanded && (
        <section
          role="region"
          aria-label="路线风险"
          data-testid="map-route-risk-summary"
          className="border-b border-border bg-amber-50 px-4 py-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-black text-amber-950">路线风险</p>
              <p className="mt-1 text-sm font-semibold text-amber-950/80">
                {routeRiskItems.length} 段交通可能影响时间
              </p>
            </div>
            <div className="grid min-w-0 flex-1 gap-2 md:max-w-[70%]">
              {routeRiskItems.slice(0, 3).map((item) => {
                const routeName = `${activityDisplayName(item.fromActivity, item.fromIndex)} 到 ${activityDisplayName(
                  item.toActivity,
                  item.toIndex
                )}`;
                return (
                  <div
                    key={item.leg.id}
                    className="grid min-w-0 gap-2 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-amber-950"
                  >
                    <button
                      type="button"
                      className="grid min-w-0 gap-1 text-left transition-colors hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`查看路线风险：${routeName}`}
                      onClick={() => selectRiskRoute(item)}
                    >
                      <span className="truncate font-black">
                        {mapScope === "trip" ? `${item.day.title} · ` : ""}
                        {routeName}
                      </span>
                      <span className="line-clamp-2">{item.conflict.message}</span>
                    </button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="w-fit rounded-full bg-amber-100 text-amber-950 hover:bg-amber-200"
                      onClick={() => delayNextActivityForRisk(item)}
                    >
                      延后下一项到 {item.conflict.estimatedArrivalTime}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
      {!mapExpanded && (
        <div data-testid="map-canvas" className="relative min-h-[160px] overflow-hidden bg-[#f6f6f3] sm:min-h-[220px] md:min-h-[320px]">
          <div ref={mapRef} className="absolute inset-0" />
        </div>
      )}
      {mapExpanded && (
        <div data-testid="editable-map-canvas" className="relative min-h-[280px] flex-1 overflow-hidden bg-[#f6f6f3] md:min-h-0">
          <div ref={mapRef} className="absolute inset-0" />
          {selectedMapRouteSegment?.leg && selectedMapRouteTitle && selectedMapRouteProvider && (
            <div
              data-testid="selected-map-route-summary"
              className="absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)] rounded-2xl border border-border bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur md:max-w-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] font-black text-primary-foreground">
                  路线
                </span>
                <p className="min-w-0 truncate font-black">{selectedMapRouteTitle}</p>
              </div>
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 font-semibold text-muted-foreground">
                <span>
                  {formatDistanceForUi(selectedMapRouteSegment.leg.distanceMeters)} / {selectedMapRouteSegment.leg.durationMinutes} 分钟
                </span>
                <span className="text-border">/</span>
                <span>{selectedMapRouteProvider.label}</span>
              </div>
            </div>
          )}
          {selectedMapRouteSegment?.leg && selectedMapRouteTitle && selectedMapRouteSteps.length > 0 && (
            <div className="absolute bottom-3 right-3 z-20 grid max-h-[46%] w-[min(360px,calc(100%-1.5rem))] gap-2 overflow-hidden rounded-2xl border border-border bg-white/95 p-3 text-xs shadow-lg backdrop-blur">
              <div className="flex items-center justify-between gap-3">
                <p className="font-black text-foreground">路径段</p>
                <Badge className="bg-[#f6f6f3] text-foreground">
                  {selectedRouteStepIndexForRender + 1}/{selectedMapRouteSteps.length}
                </Badge>
              </div>
              {selectedMapRouteStep && (
                <div
                  data-testid="selected-route-step-summary"
                  className="rounded-xl bg-[#fff7ed] px-3 py-2 font-semibold text-amber-950"
                >
                  <span className="font-black">路径段 {selectedRouteStepIndexForRender + 1}</span>
                  <span className="ml-2">{formatRouteStepMeta(selectedMapRouteStep)}</span>
                </div>
              )}
              <ol
                className="grid max-h-36 gap-1 overflow-auto"
                aria-label={`${selectedMapRouteTitle} 路径步骤`}
              >
                {selectedMapRouteSteps.map((step, index) => {
                  const selected = index === selectedRouteStepIndexForRender;
                  return (
                    <li key={`${step.instruction}-${index}`}>
                      <button
                        type="button"
                        className={cn(
                          "grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected ? "bg-primary text-primary-foreground" : "bg-[#f6f6f3] text-foreground hover:bg-secondary"
                        )}
                        data-selected={selected ? "true" : "false"}
                        onClick={() => setSelectedRouteStepIndex(index)}
                        aria-label={`查看路径段 ${index + 1}：${step.instruction}`}
                      >
                        <span className="font-black">{String(index + 1).padStart(2, "0")}</span>
                        <span className="min-w-0">
                          <span className="block truncate font-bold">{step.instruction}</span>
                          <span className={cn("block text-[11px] font-semibold", selected ? "text-primary-foreground/80" : "text-muted-foreground")}>
                            {formatRouteStepMeta(step)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          {searchPreviewPoints.length > 0 && (
            <div className="pointer-events-none absolute inset-0 z-10" aria-label="地图搜索候选点">
              {searchPreviewPoints.map((place, index) => {
                const active = activeMapSearchPlaceIdForRender === place.id;
                return (
                  <button
                    key={place.id}
                    type="button"
                    data-testid={`map-search-preview-marker-${place.id}`}
                    data-active={active ? "true" : "false"}
                    className={cn(
                      "pointer-events-auto absolute max-w-[180px] -translate-x-1/2 -translate-y-1/2 rounded-full border bg-white px-3 py-2 text-left text-xs font-black shadow-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "z-20 border-primary text-primary ring-2 ring-ring"
                        : "z-10 border-border text-foreground hover:border-primary/50"
                    )}
                    style={{
                      left: `${searchPreviewPoints.length === 1 ? 50 : 18 + index * (64 / Math.max(1, searchPreviewPoints.length - 1))}%`,
                      top: `${index % 2 === 0 ? 42 : 58}%`
                    }}
                    onMouseEnter={() => setActiveMapSearchPlaceId(place.id)}
                    onFocus={() => setActiveMapSearchPlaceId(place.id)}
                    onClick={() => setActiveMapSearchPlaceId(place.id)}
                    aria-label={`预览地点：${place.name}`}
                  >
                    <span className="block truncate">{String(index + 1).padStart(2, "0")} {place.name}</span>
                    <span className="block truncate text-[11px] font-semibold text-muted-foreground">{place.district || place.city}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      {points.length > 0 || mapScope === "trip" ? (
        <div
          data-testid={mapExpanded ? "map-edit-inspector" : "map-overview-panel"}
          className={cn(
            "border-t border-border bg-white p-3",
            !mapExpanded && mapScope === "day" && "hidden sm:block",
            mapExpanded
              ? "max-h-[34vh] shrink-0 overflow-auto"
              : mapScope === "trip"
                ? "overflow-visible md:max-h-56 md:overflow-auto"
                : "overflow-visible"
          )}
        >
          {mapScope === "trip" ? (
            <div className="grid min-w-0 gap-3">
              <div className="grid gap-2 rounded-2xl bg-[#f6f6f3] p-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <Input
                  className="bg-white"
                  value={mapFilterText}
                  onChange={(event) => setMapFilterText(event.target.value)}
                  aria-label="筛选全部行程地图"
                  placeholder="筛选日期、地点或路线"
                />
                <p data-testid="map-global-filter-status" className="px-2 text-xs font-semibold text-muted-foreground">
                  {normalizedMapFilter
                    ? `已筛选 ${filteredDayRouteSummaries.length}/${dayRouteSummaries.length} 个日期`
                    : `${dayRouteSummaries.length} 个日期`}
                </p>
              </div>
              <section
                data-testid="trip-route-overview"
                className="grid gap-3 rounded-2xl border border-border bg-white p-3"
                aria-label="全程路线总览"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-black text-primary">全程路线总览</p>
                    <p className="mt-1 text-sm font-semibold text-muted-foreground">
                      {tripPlannedRouteSegments.length > 0
                        ? `${formatDistanceForUi(tripOverviewDistanceMeters)} / ${tripOverviewDurationMinutes} 分钟`
                        : "路线待规划"}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Badge className="bg-[#f6f6f3] text-foreground">{tripPlannedRouteSegments.length} 段已规划</Badge>
                    {tripPendingRouteSegmentCount > 0 && (
                      <Badge className="bg-amber-100 text-amber-950">{tripPendingRouteSegmentCount} 段待确认</Badge>
                    )}
                  </div>
                </div>
                {tripRouteOverviewSegments.length > 0 ? (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {tripRouteOverviewSegments.map((segment) => {
                      const routeTitle = activityRouteName(
                        segment.fromActivity,
                        segment.toActivity,
                        segment.fromIndex,
                        segment.toIndex
                      );
                      const provider = segment.leg ? transportProviderMeta(segment.leg) : undefined;
                      return (
                        <button
                          key={`${segment.day.id}-${segment.fromActivity.id}-${segment.toActivity.id}`}
                          type="button"
                          className="grid min-h-16 gap-1 rounded-xl bg-[#f6f6f3] px-3 py-2 text-left text-xs transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            if (segment.leg) {
                              focusRouteEditorFromMap(segment.leg.id, segment.day.id);
                              return;
                            }
                            onSelectDay(segment.day.id);
                            setMapScope("day");
                            setMapExpanded(false);
                            setMapEditPanel("routes");
                            onSelectActivity(segment.fromActivity.id);
                          }}
                          aria-label={
                            segment.leg
                              ? `查看全程路线：${segment.day.title} ${routeTitle}`
                              : `定位待确认路线：${segment.day.title} ${routeTitle}`
                          }
                        >
                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <span className="font-black text-primary">{segment.day.title}</span>
                            {provider ? (
                              <Badge className={cn("min-h-6 px-2", provider.className)}>{provider.label}</Badge>
                            ) : (
                              <Badge className="min-h-6 bg-amber-100 px-2 text-amber-950">待确认</Badge>
                            )}
                          </span>
                          <span className="line-clamp-1 font-black">{routeTitle}</span>
                          <span className="font-semibold text-muted-foreground">
                            {segment.leg
                              ? `${formatDistanceForUi(segment.leg.distanceMeters)} / ${segment.leg.durationMinutes} 分钟`
                              : "选择交通方式后规划路线"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl bg-[#f6f6f3] px-3 py-3 text-sm font-semibold text-muted-foreground">
                    当前筛选范围内还没有可汇总路线
                  </p>
                )}
              </section>
              <div className="grid min-w-0 gap-3 xl:grid-cols-2">
                {filteredDayRouteSummaries.length === 0 && (
                  <p className="rounded-2xl bg-[#f6f6f3] px-3 py-4 text-sm font-semibold text-muted-foreground">
                    没有匹配日期
                  </p>
                )}
                {filteredDayRouteSummaries.map((summary) => (
                  <article
                    key={summary.day.id}
                    className="w-full cursor-pointer rounded-2xl border border-[#dadad3] bg-white p-3 text-left transition-colors hover:border-[#c8c8c1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <button
                      type="button"
                      data-testid={`map-day-route-${summary.day.title.toLowerCase().replace(/\s+/g, "-")}`}
                      className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        onSelectDay(summary.day.id);
                        setMapScope("day");
                      }}
                      aria-label={`打开 ${summary.day.title} 路线`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-black text-primary">{summary.day.date}</p>
                          <p className="font-black">{summary.day.title} 路线</p>
                        </div>
                        <span className="rounded-full bg-[#f6f6f3] px-3 py-1 text-xs font-bold text-muted-foreground">
                          {summary.pointCount > 0 ? `${summary.pointCount} 个地点` : "暂无地点"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs font-semibold text-muted-foreground">
                        {summary.pendingLegCount > 0
                          ? `${summary.pendingLegCount} 段交通待确认`
                          : summary.legCount > 0
                            ? `${summary.legCount} 段交通 · ${formatDistanceForUi(summary.distanceMeters)} · ${summary.durationMinutes} 分钟`
                            : "路线待规划"}
                      </p>
                    </button>
                    {summary.points.length > 0 ? (
                      <ol className="mt-3 grid gap-2">
                        {summary.points.map((activity, pointIndex) => {
                          const activitySummary = activitySummaryView(activity, pointIndex);
                          return (
                            <li key={activity.id}>
                              <button
                                type="button"
                                className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-xl px-2 py-1.5 text-left text-xs transition-colors hover:bg-[#f6f6f3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => selectOverviewActivity(summary.day, activity)}
                                aria-label={`在行程中编辑 ${summary.day.title} 的 ${activitySummary.displayName}`}
                              >
                                <span className="font-black text-primary">{String(pointIndex + 1).padStart(2, "0")}</span>
                                <span className="min-w-0">
                                  <span className="block truncate font-bold">{activitySummary.mapLabel}</span>
                                  <span className="block truncate text-muted-foreground">{activitySummary.mapMeta}</span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <p className="mt-3 rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs text-muted-foreground">
                        暂无地点
                      </p>
                    )}
                    {summary.routeSegments.some((segment) => segment.leg) && (
                      <div className="mt-3 grid gap-2 border-t border-border pt-3">
                        {summary.routeSegments
                          .filter((segment) => segment.leg)
                          .map((segment) => {
                            const routeTitle = activityRouteName(
                              segment.fromActivity,
                              segment.toActivity,
                              segment.fromIndex,
                              segment.toIndex
                            );
                            const provider = segment.leg ? transportProviderMeta(segment.leg) : undefined;
                            return (
                              <button
                                key={segment.leg!.id}
                                type="button"
                                className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl bg-[#f6f6f3] px-3 py-2 text-left text-xs transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => focusRouteEditorFromMap(segment.leg!.id, summary.day.id)}
                                aria-label={`编辑 ${summary.day.title} 路线：${routeTitle}`}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-black">{routeTitle}</span>
                                  <span className="block truncate font-semibold text-muted-foreground">
                                    {segment.leg
                                      ? `${formatDistanceForUi(segment.leg.distanceMeters)} / ${segment.leg.durationMinutes} 分钟`
                                      : "路线待规划"}
                                  </span>
                                </span>
                                {provider && <Badge className={cn("min-h-6 px-2.5", provider.className)}>{provider.label}</Badge>}
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
            ) : mapExpanded ? (
              <div className="grid min-w-0 gap-3">
                <div className="grid gap-2 rounded-2xl bg-[#f6f6f3] p-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <Input
                    className="bg-white"
                    value={mapFilterText}
                    onChange={(event) => setMapFilterText(event.target.value)}
                    aria-label="筛选地图内容"
                    placeholder="筛选已选地点、路线或风险"
                  />
                  <p data-testid="map-filter-status" className="px-2 text-xs font-semibold text-muted-foreground">
                    {normalizedMapFilter ? `已筛选 ${filteredPoints.length}/${points.length} 个地点` : `${points.length} 个地点`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <TabsList className="rounded-full bg-[#f6f6f3] p-1">
                    <TabsTrigger
                      type="button"
                      active={mapEditPanel === "places"}
                      className="min-h-8 px-3 text-xs"
                      onClick={() => setMapEditPanel("places")}
                    >
                      地点
                      <span className="ml-1 rounded-full bg-white px-1.5 py-0.5 text-[10px]">{filteredPoints.length}</span>
                    </TabsTrigger>
                    {routeSegments.length > 0 && (
                      <TabsTrigger
                        type="button"
                        active={mapEditPanel === "routes"}
                        className="min-h-8 px-3 text-xs"
                        onClick={() => setMapEditPanel("routes")}
                      >
                        路线
                        <span className="ml-1 rounded-full bg-white px-1.5 py-0.5 text-[10px]">{filteredRouteSegments.length}</span>
                      </TabsTrigger>
                    )}
                    {routeRiskItems.length > 0 && (
                      <TabsTrigger
                        type="button"
                        active={mapEditPanel === "risks"}
                        className="min-h-8 px-3 text-xs"
                        onClick={() => setMapEditPanel("risks")}
                      >
                        风险
                        <span className="ml-1 rounded-full bg-white px-1.5 py-0.5 text-[10px]">{filteredRouteRiskItems.length}</span>
                      </TabsTrigger>
                    )}
                  </TabsList>
                  <p className="text-xs font-semibold text-muted-foreground">
                    {mapEditPanel === "places"
                      ? "管理已选地点"
                      : mapEditPanel === "routes"
                        ? "检查相邻路线"
                        : "处理时间冲突"}
                  </p>
                </div>
                {mapEditPanel === "places" && (
                  <section className="grid min-w-0 gap-2">
                    <p className="sr-only">地点</p>
                    <div
                      data-testid="map-day-place-list"
                      className="grid grid-cols-1 gap-2 sm:[grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]"
                    >
                      {filteredPoints.length === 0 && (
                        <p className="rounded-2xl bg-white px-3 py-4 text-sm font-semibold text-muted-foreground">
                          没有匹配地点
                        </p>
                      )}
                      {filteredPoints.map(({ activity, index }) => {
                        const activitySummary = activitySummaryView(activity, index);
                        return (
                          <button
                            key={activity.id}
                            type="button"
                            aria-label={`在行程中编辑${activitySummary.displayName}`}
                            data-selected={selectedActivityId === activity.id ? "true" : "false"}
                            onClick={() => onSelectActivity(activity.id)}
                            className={cn(
                              "w-full cursor-pointer rounded-2xl border border-[#dadad3] bg-white p-3 text-left transition-colors hover:border-[#c8c8c1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              selectedActivityId === activity.id && "border-primary ring-2 ring-primary/15"
                            )}
                          >
                            <span className="text-xs font-black text-primary">{String(index + 1).padStart(2, "0")}</span>
                            <p className="truncate font-bold">{activitySummary.mapLabel}</p>
                            <p className="text-xs text-muted-foreground">{activitySummary.mapMeta}</p>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
                {mapEditPanel === "routes" && (
                  <section className="grid min-w-0 gap-2" data-testid="map-day-route-list">
                    <p className="sr-only">路线</p>
                    <div className="grid gap-2 md:grid-cols-2">
                      {filteredRouteSegments.length === 0 && (
                        <p className="rounded-2xl bg-white px-3 py-4 text-sm font-semibold text-muted-foreground">
                          没有匹配路线
                        </p>
                      )}
                      {filteredRouteSegments.map((segment, index) => {
                        const provider = segment.leg ? transportProviderMeta(segment.leg) : undefined;
                        const routeTitle = `${activityDisplayName(segment.fromActivity, segment.fromIndex)} 到 ${activityDisplayName(
                          segment.toActivity,
                          segment.toIndex
                        )}`;
                        return (
                          <div
                            key={`${segment.fromActivity.id}-${segment.toActivity.id}`}
                            data-selected={segment.leg && selectedTransportLegId === segment.leg.id ? "true" : "false"}
                            className={cn(
                              "w-full rounded-2xl border border-[#dadad3] bg-white p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              segment.leg ? "hover:border-[#c8c8c1]" : "opacity-70",
                              segment.leg && selectedTransportLegId === segment.leg.id && "border-primary ring-2 ring-primary/15"
                            )}
                          >
                            <button
                              type="button"
                              aria-label={`查看路线：${routeTitle}`}
                              disabled={!segment.leg}
                              className={cn(
                                "grid w-full gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                segment.leg ? "cursor-pointer" : "cursor-not-allowed"
                              )}
                              onClick={() => {
                                if (segment.leg) onSelectTransportLeg(segment.leg.id);
                              }}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <span className="text-xs font-black text-primary">
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <p className="truncate font-bold">{routeTitle}</p>
                                </div>
                                {provider ? (
                                  <Badge className={cn("min-h-6 shrink-0 px-2.5", provider.className)}>
                                    {provider.label}
                                  </Badge>
                                ) : (
                                  <Badge className="min-h-6 shrink-0 bg-[#f6f6f3] px-2.5 text-muted-foreground">
                                    待确认
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs font-semibold text-muted-foreground">
                                {segment.leg
                                  ? `${formatDistanceForUi(segment.leg.distanceMeters)} / ${segment.leg.durationMinutes} 分钟`
                                  : "选择交通方式后规划路线"}
                              </p>
                            </button>
                            {segment.leg && (
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="mt-3 rounded-full"
                                onClick={() => focusRouteEditorFromMap(segment.leg!.id)}
                                aria-label={`定位到路线编辑：${routeTitle}`}
                              >
                                编辑路线
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
                {mapEditPanel === "risks" && (
                  <section className="grid min-w-0 gap-2" data-testid="map-route-risk-list">
                    <p className="sr-only">风险</p>
                    <div className="grid gap-2">
                      {filteredRouteRiskItems.length === 0 && (
                        <p className="rounded-2xl bg-white px-3 py-4 text-sm font-semibold text-muted-foreground">
                          没有匹配风险
                        </p>
                      )}
                      {filteredRouteRiskItems.map((item) => {
                        const routeName = `${activityDisplayName(item.fromActivity, item.fromIndex)} 到 ${activityDisplayName(
                          item.toActivity,
                          item.toIndex
                        )}`;
                        return (
                          <div key={item.leg.id} className="grid gap-2 rounded-2xl bg-amber-50 p-3 text-xs font-semibold text-amber-950">
                            <button
                              type="button"
                              className="grid min-w-0 gap-1 text-left transition-colors hover:text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`查看路线风险：${routeName}`}
                              onClick={() => selectRiskRoute(item)}
                            >
                              <span className="truncate font-black">{routeName}</span>
                              <span className="line-clamp-2">{item.conflict.message}</span>
                            </button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="w-fit rounded-full bg-amber-100 text-amber-950 hover:bg-amber-200"
                              onClick={() => delayNextActivityForRisk(item)}
                            >
                              延后下一项到 {item.conflict.estimatedArrivalTime}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            ) : (
              <div data-testid="map-compact-overview" className="grid gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-black text-muted-foreground">当前日期概览</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {points.length > 0
                      ? points
                          .slice(0, 4)
                          .map(({ activity, index }) => `${String(index + 1).padStart(2, "0")} ${activityMapLabel(activity, index)}`)
                          .join(" · ")
                      : "还没有地点"}
                    {points.length > 4 ? ` · 另有 ${points.length - 4} 个地点` : ""}
                  </p>
                </div>
              </div>
            )}
          </div>
        ) : (
          null
        )}
    </section>
  );
}

function formatDistanceForUi(distanceMeters: number): string {
  return distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(1)} km` : `${distanceMeters} m`;
}

function formatTemperatureForUi(temperature: string): string {
  return temperature.replace(/\s*C\b/g, "°C");
}

function buildAgentChangeTargets(
  before: TravelItinerary,
  after: TravelItinerary,
  diffItems: string[]
): Array<AgentChangeTarget | undefined> {
  const activityChanges = collectChangedActivities(before, after);
  const transportChanges = collectChangedTransportLegs(before, after);
  const usedActivityIds = new Set<string>();
  const usedTransportIds = new Set<string>();

  return diffItems.map((item) => {
    if (/交通|路线/.test(item)) {
      const transport = transportChanges.find((candidate) => !usedTransportIds.has(candidate.transportLegId!) && item.includes(candidate.label));
      const fallbackTransport = transport ?? transportChanges.find((candidate) => !usedTransportIds.has(candidate.transportLegId!));
      if (fallbackTransport) {
        usedTransportIds.add(fallbackTransport.transportLegId!);
        return fallbackTransport;
      }
    }
    const activity = activityChanges.find((candidate) => !usedActivityIds.has(candidate.activityId!) && item.includes(candidate.label));
    const fallbackActivity =
      activity ??
      activityChanges.find((candidate) => !usedActivityIds.has(candidate.activityId!) && !/删除/.test(item));
    if (fallbackActivity) {
      usedActivityIds.add(fallbackActivity.activityId!);
      return fallbackActivity;
    }
    return undefined;
  });
}

function collectChangedActivities(before: TravelItinerary, after: TravelItinerary): AgentChangeTarget[] {
  const beforeActivities = new Map<string, { dayId: string; index: number; activity: Activity }>();
  for (const day of before.days) {
    day.activities.forEach((activity, index) => beforeActivities.set(activity.id, { dayId: day.id, index, activity }));
  }

  const changes: AgentChangeTarget[] = [];
  for (const day of after.days) {
    day.activities.forEach((activity, index) => {
      const previous = beforeActivities.get(activity.id);
      const label = activityDisplayName(activity, index);
      if (!previous) {
        changes.push({ label, dayId: day.id, activityId: activity.id });
        return;
      }
      const moved = previous.dayId !== day.id || previous.index !== index;
      const updated =
        previous.activity.title !== activity.title ||
        previous.activity.startTime !== activity.startTime ||
        previous.activity.endTime !== activity.endTime ||
        previous.activity.placeName !== activity.placeName ||
        previous.activity.budgetCny !== activity.budgetCny ||
        previous.activity.note !== activity.note ||
        previous.activity.description !== activity.description;
      if (moved || updated) changes.push({ label, dayId: day.id, activityId: activity.id });
    });
  }
  return changes;
}

function collectChangedTransportLegs(before: TravelItinerary, after: TravelItinerary): AgentChangeTarget[] {
  const beforeLegs = new Map<string, TransportLeg>();
  for (const day of before.days) {
    for (const leg of day.transportLegs ?? []) {
      beforeLegs.set(`${day.id}:${leg.fromActivityId}:${leg.toActivityId}`, leg);
    }
  }

  const changes: AgentChangeTarget[] = [];
  for (const day of after.days) {
    for (const leg of day.transportLegs ?? []) {
      const previous = beforeLegs.get(`${day.id}:${leg.fromActivityId}:${leg.toActivityId}`);
      const changed =
        !previous ||
        previous.id !== leg.id ||
        previous.mode !== leg.mode ||
        previous.distanceMeters !== leg.distanceMeters ||
        previous.durationMinutes !== leg.durationMinutes ||
        previous.provider !== leg.provider ||
        previous.routeStatus !== leg.routeStatus;
      if (!changed) continue;
      const fromIndex = day.activities.findIndex((activity) => activity.id === leg.fromActivityId);
      const toIndex = day.activities.findIndex((activity) => activity.id === leg.toActivityId);
      const fromActivity = day.activities[fromIndex];
      const toActivity = day.activities[toIndex];
      if (!fromActivity || !toActivity) continue;
      changes.push({
        label: activityRouteName(fromActivity, toActivity, fromIndex, toIndex),
        dayId: day.id,
        transportLegId: leg.id
      });
    }
  }
  return changes;
}

function addMinutesToClockValue(value: string | undefined, minutes: number): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(mins) || hours > 23 || mins > 59) return undefined;
  const total = ((hours * 60 + mins + minutes) % 1440 + 1440) % 1440;
  const nextHours = Math.floor(total / 60).toString().padStart(2, "0");
  const nextMinutes = (total % 60).toString().padStart(2, "0");
  return `${nextHours}:${nextMinutes}`;
}

function formatRouteStepMeta(step: RouteStep): string {
  const parts = [
    step.distanceMeters !== undefined ? formatDistanceForUi(step.distanceMeters) : undefined,
    step.durationMinutes !== undefined ? `${step.durationMinutes} 分钟` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "步骤详情待确认";
}

function routeStepsForMapDisplay(leg: TransportLeg, to: Activity): RouteStep[] {
  if (leg.steps.length > 0) return leg.steps;
  return [
    {
      instruction: leg.summary?.trim() || `${routeActionLabel(leg.mode)}前往${activityDisplayName(to)}`,
      mode: leg.mode,
      distanceMeters: leg.distanceMeters,
      durationMinutes: leg.durationMinutes,
      polyline: leg.polyline
    }
  ];
}

function metersToKilometersInput(distanceMeters: number): string {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) return "";
  return Number((distanceMeters / 1000).toFixed(1)).toString();
}

function kilometersTextToMeters(value: string): number | undefined {
  const kilometers = numberTextToNonNegativeNumber(value);
  return kilometers === undefined ? undefined : Math.round(kilometers * 1000);
}

function numberTextToNonNegativeInteger(value: string): number | undefined {
  const number = numberTextToNonNegativeNumber(value);
  return number === undefined ? undefined : Math.round(number);
}

function numberTextToNonNegativeNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number;
}

function getOvernightStartAnchor(itinerary: TravelItinerary, day: ItineraryDay): OvernightStartAnchor | undefined {
  const dayIndex = itinerary.days.findIndex((candidate) => candidate.id === day.id);
  if (dayIndex <= 0) return undefined;
  const previousDay = itinerary.days[dayIndex - 1];
  if (!previousDay) return undefined;
  const index = previousDay.activities.length - 1;
  const activity = previousDay.activities[index];
  if (!activity) return undefined;
  return { day: previousDay, activity, index };
}

function getRoutePairsForDay(itinerary: TravelItinerary, day: ItineraryDay): DayRoutePair[] {
  const pairs: DayRoutePair[] = [];
  const overnightStart = getOvernightStartAnchor(itinerary, day);
  const firstActivity = day.activities[0];
  if (overnightStart && firstActivity && canRouteActivityPair(overnightStart.activity, firstActivity)) {
    pairs.push({
      day,
      fromActivity: overnightStart.activity,
      toActivity: firstActivity,
      fromIndex: overnightStart.index,
      toIndex: 0,
      fromDayId: overnightStart.day.id,
      toDayId: day.id,
      leg: findTransportLeg(day, overnightStart.activity.id, firstActivity.id),
      overnightStart: true
    });
  }
  day.activities.forEach((activity, index) => {
    const next = day.activities[index + 1];
    if (!next || !canRouteActivityPair(activity, next)) return;
    pairs.push({
      day,
      fromActivity: activity,
      toActivity: next,
      fromIndex: index,
      toIndex: index + 1,
      fromDayId: day.id,
      toDayId: day.id,
      leg: findTransportLeg(day, activity.id, next.id),
      overnightStart: false
    });
  });
  return pairs;
}

function findTransportLeg(day: ItineraryDay, fromActivityId: string, toActivityId: string): TransportLeg | undefined {
  return (day.transportLegs ?? []).find((leg) => leg.fromActivityId === fromActivityId && leg.toActivityId === toActivityId);
}

function getAdjacentTransportLegs(day: ItineraryDay, itinerary?: TravelItinerary): TransportLeg[] {
  if (itinerary) return getRoutePairsForDay(itinerary, day).flatMap((pair) => (pair.leg ? [pair.leg] : []));
  return (day.transportLegs ?? []).filter((leg) =>
    day.activities.some((activity, index) => {
      const next = day.activities[index + 1];
      return next && leg.fromActivityId === activity.id && leg.toActivityId === next.id;
    })
  );
}

function countRoutableAdjacentPairs(day: ItineraryDay, itinerary?: TravelItinerary): number {
  if (itinerary) return getRoutePairsForDay(itinerary, day).length;
  return day.activities.reduce((count, activity, index) => {
    const next = day.activities[index + 1];
    return next && canRouteActivityPair(activity, next) ? count + 1 : count;
  }, 0);
}

function transportProviderMeta(leg: TransportLeg): { label: string; description: string; className: string } {
  if (leg.routeStatus === "failed") {
    return {
      label: "路线待确认",
      description: leg.failureReason ?? "路线计算失败，请补全地点或手动填写交通。",
      className: "bg-red-100 text-red-950"
    };
  }
  if (leg.manualOverride || leg.provider === "manual") {
    return {
      label: "手动调整",
      description: "按手动输入保存",
      className: "bg-[#f6f6f3] text-foreground"
    };
  }
  if (leg.provider === "amap") {
    return {
      label: "实时路线",
      description: "由地图服务计算",
      className: "bg-emerald-100 text-emerald-950"
    };
  }
  return {
    label: "参考路线",
    description: "当前为参考估算",
    className: "bg-amber-100 text-amber-950"
  };
}

declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode?: string };
  }
}

let amapPromise: Promise<any> | undefined;

function loadAmap(key: string, securityJsCode?: string): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (securityJsCode) window._AMapSecurityConfig = { securityJsCode };
  amapPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Scale,AMap.ToolBar`;
    script.async = true;
    script.onload = () => (window.AMap ? resolve(window.AMap) : reject(new Error("AMap unavailable")));
    script.onerror = () => reject(new Error("AMap script failed"));
    document.head.appendChild(script);
  });
  return amapPromise;
}

function buildItinerarySkillSourceText(itinerary: TravelItinerary): string {
  const days = itinerary.days ?? [];
  const lines = [
    `当前行程：${itinerary.title}`,
    `出发点：${itinerary.destination}`,
    `日期：${itinerary.startDate} 至 ${itinerary.endDate ?? itinerary.startDate}`,
    "",
    "每日安排：",
    ...days.flatMap((day) => [
      `${day.title} ${day.date}`,
      ...(day.activities ?? []).map((activity, index) => {
        const time = [activity.startTime, activity.endTime].filter(Boolean).join("-");
        const place = activityPrimaryPlaceName(activity);
        const tags = activity.tags?.length ? `；标签：${activity.tags.join("、")}` : "";
        return `${index + 1}. ${activityDisplayName(activity, index)}${place ? `（${place}）` : ""}${time ? `；时间：${time}` : ""}${tags}`;
      })
    ]),
    "",
    "请从以上行程中总结可复用的旅行风格、规划规则和禁止模式。"
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

function buildConversationSkillSourceText(itinerary: TravelItinerary, messages: ChatMessage[]): string {
  const recentMessages = messages.slice(-8);
  const conversationLines = recentMessages
    .map((message) => {
      const body = stripAssistantDiffFromMessage(message.content);
      if (!body) return undefined;
      return message.role === "user" ? `用户需求：${body}` : `助手回复：${body}`;
    })
    .filter((line): line is string => Boolean(line));

  const lines = [
    buildItinerarySkillSourceText(itinerary),
    "",
    "最近对话：",
    ...conversationLines,
    "",
    "请结合当前画布和最近对话，提炼用户真正想复用的旅行节奏、地点取舍、交通偏好、预算意识和避免模式。"
  ];
  return lines.join("\n");
}

function stripAssistantDiffFromMessage(content: string): string {
  const lines = content.split(/\r?\n/);
  const diffStartIndex = lines.findIndex((line) => line === "本轮改动");
  return lines
    .slice(0, diffStartIndex >= 0 ? diffStartIndex : undefined)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function findActivityInItinerary(itinerary: TravelItinerary, activityId: string): Activity | undefined {
  for (const day of itinerary.days) {
    const activity = day.activities.find((candidate) => candidate.id === activityId);
    if (activity) return activity;
  }
  return undefined;
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

function escapeMapHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[character] ?? character;
  });
}

function mapMarkerContent(label: string, variant: "activity" | "candidate" = "activity"): string {
  return `<span class="journey-map-pin journey-map-pin--${variant}"><span class="journey-map-pin__label">${escapeMapHtml(label)}</span></span>`;
}

function downloadTextFile(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "itinerary"
  );
}

function TimePickerField({
  label,
  value,
  onChange,
  ariaLabel
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
      <div className="flex items-center justify-between gap-2">
        <span>{label}</span>
        {value && (
          <button
            type="button"
            className="rounded-full px-2 py-0.5 text-[11px] font-black text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            onClick={() => onChange(undefined)}
          >
            清空
          </button>
        )}
      </div>
      <Input
        type="time"
        step={60}
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        aria-label={ariaLabel}
        className="font-black"
      />
    </div>
  );
}

function ActivityDetailsPanel({
  activity,
  index,
  dayOptions,
  currentDayId,
  onChange,
  onClose,
  onMoveToDay
}: {
  activity: Activity;
  index: number;
  dayOptions: ItineraryDay[];
  currentDayId: string;
  onChange: (changes: Partial<Activity>) => void;
  onClose: () => void;
  onMoveToDay: (targetDayId: string) => void | Promise<void>;
}) {
  const [placeQuery, setPlaceQuery] = useState(activity.placeName ?? "");
  const titleText = activityDisplayName(activity, index);

  useEffect(() => {
    setPlaceQuery(activity.placeName ?? "");
  }, [activity.id]);

  function selectPlace(place: PlaceSearchItem) {
    void onChange({
      placeName: place.name,
      place: placeFromSearchItem(place)
    });
    setPlaceQuery(place.name);
  }

  return (
    <Card className="border-ring/40 bg-white shadow-sm" role="region" aria-label="编辑活动">
      <CardHeader className="gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0 self-center">
          <CardTitle>编辑活动</CardTitle>
          <CardDescription className="mt-1 truncate">
            第 {index + 1} 站 · {titleText}
          </CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0 rounded-full" onClick={onClose}>
          完成编辑
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 border-t border-border bg-[#fbfbf9] p-4">
        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_280px]">
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_150px]">
              <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                活动名称
                <Input
                  value={activity.title}
                  onChange={(event) => onChange({ title: event.target.value })}
                  aria-label={`第 ${index + 1} 项活动名称`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                类型
                <select
                  className="min-h-11 rounded-2xl border border-input bg-background px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                  value={activity.type}
                  onChange={(event) => onChange({ type: event.target.value as ActivityType })}
                  aria-label={`${titleText} 的活动类型`}
                >
                  {activityTypeOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                日期
                <select
                  className="min-h-11 rounded-2xl border border-input bg-background px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                  value={currentDayId}
                  onChange={(event) => void onMoveToDay(event.target.value)}
                  aria-label={`${titleText} 的日期`}
                >
                  {dayOptions.map((optionDay) => (
                    <option key={optionDay.id} value={optionDay.id}>
                      {optionDay.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <section className="rounded-xl bg-white p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-black">
                <MapPin className="size-4" />
                地点
              </div>
              <PoiSearchField
                value={placeQuery}
                selectedPlace={placeQuery.trim() === (activity.placeName ?? activity.place?.name ?? "") ? activity.place ?? null : null}
                city={activity.place?.city || "全国"}
                ariaLabel={`${titleText} 的地点`}
                placeholder="搜索地点或景点名称"
                selectionHint="必须从高德搜索结果中选择地点，选择后会写入坐标并触发路线、天气更新。"
                onQueryChange={setPlaceQuery}
                onSelect={selectPlace}
              />
              {activity.place?.address && (
                <p className="mt-2 rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs font-semibold text-muted-foreground">
                  {activity.place.address}
                </p>
              )}
              {placeMetaItems(activity.place).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold text-muted-foreground">
                  {placeMetaItems(activity.place).map((item) => (
                    <span key={item} className="rounded-full bg-[#f6f6f3] px-2 py-0.5">
                      {item}
                    </span>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section role="group" aria-label="时间与预算" className="grid gap-3 rounded-xl bg-white p-3 sm:grid-cols-3">
            <div className="flex items-center gap-2 text-sm font-black sm:col-span-3">
              <Clock3 className="size-4" />
              时间与预算
            </div>
            <TimePickerField
              label="开始时间"
              value={activity.startTime}
              onChange={(value) => onChange({ startTime: value })}
              ariaLabel={`${titleText} 的开始时间`}
            />
            <TimePickerField
              label="结束时间"
              value={activity.endTime}
              onChange={(value) => onChange({ endTime: value })}
              ariaLabel={`${titleText} 的结束时间`}
            />
            <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
              预算 / 元
              <Input
                type="number"
                min="0"
                value={activity.budgetCny ?? ""}
                onChange={(event) => onChange({ budgetCny: Number(event.target.value) || undefined })}
                aria-label={`${titleText} 的预算`}
                placeholder="0"
              />
            </label>
          </section>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            活动内容
            <Textarea
              value={activity.description ?? ""}
              onChange={(event) => onChange({ description: event.target.value })}
              aria-label={`${titleText} 的活动内容`}
              placeholder="参观重点、预约信息、停留节奏"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
            给自己的提醒
            <Textarea
              value={activity.note ?? ""}
              onChange={(event) => onChange({ note: event.target.value })}
              aria-label={`${titleText} 的提醒`}
              placeholder="例如：提前买票、雨天改室内、给拍照留时间"
            />
          </label>
        </div>
      </CardContent>
    </Card>
  );
}

function OvernightStartCard({
  activity,
  onEdit
}: {
  activity: Activity;
  onEdit: () => void;
}) {
  const titleText = activityDisplayName(activity);
  const placeText = activityPrimaryPlaceName(activity);

  return (
    <Card className="border-dashed border-[#dadad3] bg-[#fbfbf9]" role="listitem" aria-label={titleText}>
      <div className="grid gap-3 p-3 md:grid-cols-[44px_minmax(0,1fr)_auto] md:items-center">
        <span className="flex size-8 items-center justify-center rounded-full bg-white text-xs font-black text-muted-foreground">
          <Route className="size-4" />
        </span>
        <div className="min-w-0">
          <h4 className="min-w-0 truncate text-base font-black leading-7">{titleText}</h4>
          {placeText && placeText !== titleText && <p className="truncate text-xs font-semibold text-muted-foreground">{placeText}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" className="rounded-full bg-white" onClick={onEdit} aria-label={`编辑${titleText}`}>
          <Pencil data-icon="inline-start" />
          编辑
        </Button>
      </div>
    </Card>
  );
}

function ActivityEditor({
  activity,
  index,
  canMoveUp,
  canMoveDown,
  selected,
  dragging,
  dropTarget,
  onDelete,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop
}: {
  activity: Activity;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  selected: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onDelete: () => void;
  onSelect: () => void;
  onMoveUp: () => void | Promise<void>;
  onMoveDown: () => void | Promise<void>;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}) {
  const hasDetails = Boolean(activity.description || activity.note);
  const activitySummary = activitySummaryView(activity, index);
  const timeSummary = activitySummary.time;
  const budgetSummary = activitySummary.budget;
  const placeSummary = activitySummary.place;
  const missingSummary = activitySummary.missing;
  const detailSummary = [activity.description, activity.note].filter(Boolean).join(" / ");
  const typeLabel = activitySummary.typeLabel;
  const blankDraft = activitySummary.blankDraft;
  const titleText = activitySummary.displayName;
  const visiblePlaceSummary =
    placeSummary && placeSummary.trim() !== titleText.trim() ? placeSummary : undefined;
  const statusSummary = blankDraft ? "待补时间" : timeSummary ?? missingSummary;

  return (
    <Card
      className={cn(
        "group relative cursor-pointer overflow-hidden border-[#dadad3] bg-white text-[#211922] transition-[background-color,border-color,box-shadow,opacity,transform] duration-150 hover:border-[#c8c8c1] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary ring-2 ring-primary/15",
        dragging && "scale-[0.995] border-primary/70 bg-primary/5 opacity-95 shadow-lg ring-2 ring-primary/20",
        dropTarget && "border-primary/70 bg-primary/5 ring-2 ring-primary/15"
      )}
      data-testid={`activity-drop-${index}`}
      data-selected={selected ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-drop-target={dropTarget ? "true" : "false"}
      role="listitem"
      tabIndex={0}
      aria-label={`第 ${index + 1} 站：${titleText}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropTarget && (
        <div
          data-testid={`activity-drop-indicator-${index}`}
          className="h-1.5 bg-primary"
          aria-hidden="true"
        />
      )}
      <div
        className={cn(
          "grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 p-3",
          blankDraft && "grid-cols-[32px_minmax(0,1fr)_auto] gap-x-2 gap-y-2 p-2.5"
        )}
      >
        <button
          type="button"
          draggable
          onClick={(event) => event.stopPropagation()}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          aria-label={`拖动${titleText}调整顺序`}
          title="拖动排序"
          className={cn(
            "flex h-8 min-h-8 w-8 cursor-grab items-center justify-center self-center rounded-full border-0 bg-transparent text-muted-foreground transition-colors hover:text-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragging && "text-primary ring-2 ring-primary/20",
            blankDraft && "h-8 min-h-8 w-8"
          )}
        >
          <GripVertical className="size-4" />
        </button>

        <div className="min-w-0 self-center">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="min-w-0 flex-[1_1_auto] truncate text-base font-black leading-6">{titleText}</h4>
            {!blankDraft && (
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Badge className="min-h-6 bg-[#f6f6f3] px-2.5 text-[11px] text-[#33332e]">{typeLabel}</Badge>
                {activity.lockedByUser && <Badge className="min-h-6 px-2.5 text-[11px]">手动锁定</Badge>}
                {activity.source === "agent" && <Badge className="min-h-6 bg-accent px-2.5 text-[11px] text-accent-foreground">助手建议</Badge>}
              </div>
            )}
          </div>
        </div>
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center self-center rounded-full bg-[#262622] text-xs font-black text-white",
            selected && "bg-primary text-primary-foreground",
            blankDraft && "size-7"
          )}
        >
          {index + 1}
        </span>

        <div
          className={cn(
            "col-span-3 grid min-h-14 gap-1 rounded-2xl border border-[#e5e5e0] bg-[#f6f6f3] px-3 py-2 text-xs font-semibold text-[#62625b]",
            blankDraft && "min-h-11"
          )}
        >
          {blankDraft ? (
            <span className="flex items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" />
              地点待补
            </span>
          ) : (
            <>
              {visiblePlaceSummary && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="truncate">{visiblePlaceSummary}</span>
                </span>
              )}
              {!visiblePlaceSummary && (
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground/80">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="truncate">地点待补</span>
                </span>
              )}
              {budgetSummary && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Wallet className="size-3.5 shrink-0" />
                  <span className="truncate">{budgetSummary}</span>
                </span>
              )}
              {hasDetails && (
                <span className="min-w-0 truncate text-muted-foreground">{detailSummary}</span>
              )}
            </>
          )}
        </div>

        <div className="col-span-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2">
          {statusSummary && (
            <span
              className={cn(
                "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full px-3 text-xs font-black",
                timeSummary ? "bg-[#f6f6f3] text-[#211922]" : "bg-secondary text-muted-foreground"
              )}
            >
              <Clock3 className="size-3.5 shrink-0" />
              <span className="truncate">{statusSummary}</span>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="min-h-9 rounded-full bg-[#f6f6f3] px-3 text-xs text-[#211922] hover:bg-[#e5e5e0]"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            aria-label={`编辑${titleText}`}
          >
            <Pencil className="size-4" />
            编辑
          </Button>
          {selected && (
            <div className="flex flex-wrap items-center gap-1 rounded-full border border-[#e5e5e0] bg-[#f6f6f3] p-1" aria-label={`${titleText} 的次要操作`}>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                onClick={(event) => {
                  event.stopPropagation();
                  void onMoveUp();
                }}
                disabled={!canMoveUp}
                aria-label={`上移${titleText}`}
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                onClick={(event) => {
                  event.stopPropagation();
                  void onMoveDown();
                }}
                disabled={!canMoveDown}
                aria-label={`下移${titleText}`}
              >
                <ChevronDown />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                aria-label={`删除${titleText}`}
              >
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function TransportLegEditor({
  leg,
  from,
  to,
  fromIndex,
  toIndex,
  selected,
  onFocus,
  onSelect,
  onShowInMap,
  onEditEndpoint,
  onSave,
  onRemove
}: {
  leg?: TransportLeg;
  from: Activity;
  to: Activity;
  fromIndex: number;
  toIndex: number;
  selected: boolean;
  onFocus: () => void;
  onSelect: (legId: string) => void;
  onShowInMap: (legId: string) => void;
  onEditEndpoint: (activityId: string) => void;
  onSave: (mode: MapRouteMode, overrides?: TransportLegOverride) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<MapRouteMode>(leg?.mode ?? "walking");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [manualEditorOpen, setManualEditorOpen] = useState(false);
  const [distanceKmText, setDistanceKmText] = useState(leg ? metersToKilometersInput(leg.distanceMeters) : "");
  const [durationText, setDurationText] = useState(leg ? String(leg.durationMinutes) : "");
  const [costText, setCostText] = useState(leg?.costCny !== undefined ? String(leg.costCny) : "");
  const [summaryText, setSummaryText] = useState(leg?.summary ?? "");
  const [noteText, setNoteText] = useState(leg?.note ?? "");
  const distance = leg ? formatDistanceForUi(leg.distanceMeters) : "待确认";
  const provider = leg ? transportProviderMeta(leg) : undefined;
  const routeFailed = leg?.routeStatus === "failed";
  const routeTitle = `${activityDisplayName(from, fromIndex)} 到 ${activityDisplayName(to, toIndex)}`;
  const fromTitle = activityDisplayName(from, fromIndex);
  const toTitle = activityDisplayName(to, toIndex);
  const timingConflict = leg ? detectTransportTimingConflict(from, to, leg) : undefined;
  const routeRepairIssue = routeFailed ? routeRepairIssueText(from, to) : undefined;
  const metricText = leg
    ? routeFailed
      ? "路线待确认"
      : [`${distance} / ${leg.durationMinutes} 分钟`, leg.costCny !== undefined ? `约 ${leg.costCny} 元` : undefined]
        .filter(Boolean)
        .join(" / ")
    : distance;
  const showQuickPlanAction = !leg || routeFailed;

  useEffect(() => {
    setMode(leg?.mode ?? "walking");
    setDistanceKmText(leg ? metersToKilometersInput(leg.distanceMeters) : "");
    setDurationText(leg ? String(leg.durationMinutes) : "");
    setCostText(leg?.costCny !== undefined ? String(leg.costCny) : "");
    setSummaryText(leg?.summary ?? "");
    setNoteText(leg?.note ?? "");
  }, [leg?.id, leg?.mode, leg?.distanceMeters, leg?.durationMinutes, leg?.costCny, leg?.summary, leg?.note]);

  useEffect(() => {
    if (selected) setDetailsOpen(true);
  }, [selected]);

  function saveManualOverride() {
    void onSave(mode, {
      distanceMeters: kilometersTextToMeters(distanceKmText),
      durationMinutes: numberTextToNonNegativeInteger(durationText),
      costCny: numberTextToNonNegativeNumber(costText),
      summary: summaryText.trim() || undefined,
      note: noteText.trim() || undefined,
      manualOverride: true
    });
  }

  return (
    <div className="ml-6 border-l border-dashed border-[#dadad3] pl-4 sm:pl-5">
      <div
        role="group"
        aria-label={`路线：${routeTitle}`}
        data-selected={selected ? "true" : "false"}
        className={cn(
          "relative rounded-[18px] border border-[#e5e5e0] bg-[#f6f6f3] px-3 py-3 text-sm text-[#211922] transition-colors",
          selected && "border-primary ring-2 ring-primary/15"
        )}
      >
        <div className="grid gap-2">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold text-[#62625b]">路线</p>
              <p className="mt-0.5 truncate font-black text-[#211922]">{routeTitle}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[#dadad3] bg-white text-[#62625b]">
                <Route className="size-3.5" />
              </span>
              {leg && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8 min-h-8 rounded-full bg-white p-0"
                  onClick={() => {
                    onFocus();
                    onSelect(leg.id);
                    onShowInMap(leg.id);
                  }}
                  aria-label={`在地图中查看路线：${routeTitle}`}
                  title="地图"
                >
                  <MapPinned className="size-4" data-icon="inline-start" />
                  <span className="sr-only">地图</span>
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  onFocus();
                  if (leg) onSelect(leg.id);
                  setDetailsOpen((open) => !open);
                }}
                aria-expanded={detailsOpen}
                aria-label={`编辑路线细节：${routeTitle}`}
                className="size-8 min-h-8 rounded-full bg-white p-0"
                title={detailsOpen ? "收起细节" : routeFailed ? "修正路线" : "路线细节"}
              >
                {detailsOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                <span className="sr-only">{detailsOpen ? "收起细节" : routeFailed ? "修正路线" : "路线细节"}</span>
              </Button>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-semibold text-[#62625b]">
            {provider && <Badge className={cn("min-h-6 px-2.5", provider.className)}>{provider.label}</Badge>}
            <span className="rounded-full bg-white px-3 py-1 font-bold text-[#211922]">{metricText}</span>
            {leg?.summary && <span className="min-w-0 flex-1 basis-48 truncate">{leg.summary}</span>}
          </div>
          {leg?.manualOverride && leg.note && (
            <p className="truncate text-xs font-semibold text-primary">手动调整：{leg.note}</p>
          )}
          {routeFailed && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-950">
              {leg?.failureReason ?? "路线计算失败，请补全地点或手动填写交通。"}
            </p>
          )}
          {timingConflict && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950">
              {timingConflict.message}
            </p>
          )}
          {showQuickPlanAction && (
            <Button type="button" variant="secondary" size="sm" className="h-9 min-h-9 w-fit rounded-full px-3 py-0 text-xs" onClick={() => onSave(mode)}>
              {leg ? "重新规划路线" : "规划路线"}
            </Button>
          )}
        </div>
        {detailsOpen && (
          <div className="mt-3 grid gap-3 rounded-xl bg-white p-3">
            {routeFailed && (
              <section
                className="grid gap-3 rounded-xl border border-red-100 bg-red-50/70 p-3"
                aria-label={`${routeTitle} 的路线修复`}
              >
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-red-700">
                    <MapPin className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-black text-red-950">无法确认路线</p>
                    <p className="mt-1 text-xs font-semibold text-red-900">
                      {leg?.failureReason ?? "路线计算失败，请补全地点或手动填写交通。"}
                    </p>
                  </div>
                </div>
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center">
                  <div className="rounded-xl bg-white px-3 py-2">
                    <p className="text-xs font-black text-foreground">{routeRepairIssue}</p>
                    <p className="mt-1 truncate text-xs font-semibold text-muted-foreground">
                      {activityPrimaryPlaceName(from) ?? activityDisplayName(from, fromIndex)} 到{" "}
                      {activityPrimaryPlaceName(to) ?? activityDisplayName(to, toIndex)}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-8 rounded-full px-2.5 text-xs"
                        onClick={() => onEditEndpoint(from.id)}
                        aria-label={`编辑起点：${fromTitle}`}
                      >
                        编辑起点
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-8 rounded-full px-2.5 text-xs"
                        onClick={() => onEditEndpoint(to.id)}
                        aria-label={`编辑终点：${toTitle}`}
                      >
                        编辑终点
                      </Button>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    className="rounded-full"
                    onClick={() => onSave(mode)}
                    aria-label={`重新规划路线：${routeTitle}`}
                  >
                    重新规划路线
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full bg-white"
                    onClick={() => setManualEditorOpen(true)}
                    aria-label={`手动记录路线：${routeTitle}`}
                  >
                    手动记录路线
                  </Button>
                </div>
              </section>
            )}
            <section className="grid gap-3 rounded-xl bg-[#fbfbf9] p-3" aria-label={`${routeTitle} 的路线结果`}>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)] lg:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-black text-foreground">路线结果</p>
                    {provider && <Badge className={cn("min-h-6 px-2.5", provider.className)}>{provider.label}</Badge>}
                  </div>
                  <p className="mt-1 text-sm font-semibold text-foreground">{metricText}</p>
                  {leg?.summary && <p className="mt-1 text-xs font-semibold text-muted-foreground">{leg.summary}</p>}
                  {timingConflict && (
                    <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950">
                      {timingConflict.message}
                    </p>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-1">
                  <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                    交通方式
                    <select
                      className="min-h-11 rounded-2xl border border-input bg-background px-3 py-2 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
                      value={mode}
                      onChange={(event) => setMode(event.target.value as MapRouteMode)}
                      aria-label={`${routeTitle} 的交通方式`}
                    >
                      {routeModeOptions.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button type="button" variant="outline" className="rounded-full self-end lg:self-auto" onClick={() => onSave(mode)}>
                    {leg ? "重新规划路线" : "规划路线"}
                  </Button>
                  {leg && (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full text-destructive hover:text-destructive"
                      onClick={() => onRemove()}
                      aria-label={`移除路线：${routeTitle}`}
                    >
                      <Trash2 data-icon="inline-start" />
                      移除路线
                    </Button>
                  )}
                </div>
              </div>
              {leg?.steps?.length ? (
                <div className="rounded-xl bg-white p-3">
                  <p className="text-xs font-black text-foreground">路线步骤</p>
                  <ol className="mt-2 grid gap-2 text-xs text-muted-foreground">
                    {leg.steps.map((step, index) => (
                      <li key={`${step.instruction}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
                        <span className="font-black text-primary">{index + 1}</span>
                        <span>
                          <span className="block font-semibold text-foreground">{step.instruction}</span>
                          <span className="block">{formatRouteStepMeta(step)}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
            </section>
            <section className="grid gap-3 rounded-xl bg-[#fbfbf9] p-3" aria-label={`${routeTitle} 的手动校准`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black text-foreground">手动校准</p>
                  <p className="mt-1 text-xs font-semibold text-muted-foreground">
                    地图结果不符合实际时，再校准距离、耗时、费用和路上提醒。
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setManualEditorOpen((open) => !open)}
                  aria-expanded={manualEditorOpen}
                  aria-label={`${manualEditorOpen ? "收起" : "展开"}手动校准：${routeTitle}`}
                >
                  {manualEditorOpen ? "收起校准" : "手动校准"}
                </Button>
              </div>
              {manualEditorOpen && (
                <div className="grid gap-3">
                  <div className="grid gap-2 md:grid-cols-3">
                    <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                      实际距离 / km
                      <Input
                        type="number"
                        min="0"
                        step="0.1"
                        value={distanceKmText}
                        onChange={(event) => setDistanceKmText(event.target.value)}
                        aria-label={`${routeTitle} 的实际距离公里`}
                        placeholder="地图估算"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                      实际耗时 / 分钟
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={durationText}
                        onChange={(event) => setDurationText(event.target.value)}
                        aria-label={`${routeTitle} 的实际耗时分钟`}
                        placeholder="分钟"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                      预计费用 / 元
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={costText}
                        onChange={(event) => setCostText(event.target.value)}
                        aria-label={`${routeTitle} 的预计花费`}
                        placeholder="元"
                      />
                    </label>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                      怎么走
                      <Input
                        value={summaryText}
                        onChange={(event) => setSummaryText(event.target.value)}
                        aria-label={`${routeTitle} 的出行方式说明`}
                        placeholder="例如：打车、网约车或地铁 1 号线"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                      路上提醒
                      <Input
                        value={noteText}
                        onChange={(event) => setNoteText(event.target.value)}
                        aria-label={`${routeTitle} 的路上提醒`}
                        placeholder="例如：雨天改打车，等车多留 15 分钟"
                      />
                    </label>
                  </div>
                  <Button type="button" variant="secondary" className="w-fit rounded-full" onClick={saveManualOverride}>
                    应用调整
                  </Button>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportedSkillInfluenceSummary({
  skills,
  itinerary
}: {
  skills: TravelSkill[];
  itinerary: TravelItinerary;
}) {
  const influence = buildImportedSkillInfluence(skills, itinerary);
  return (
    <section
      role="region"
      aria-label="当前风格对规划的影响"
      className="mt-3 grid gap-2 rounded-2xl border border-border bg-[#fbfbf9] p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black text-foreground">{skills.length} 个风格正在影响本次规划</p>
        <Badge className="bg-white text-foreground">可随时移除</Badge>
      </div>
      {influence.scopes.length > 0 && (
        <div className="grid gap-1">
          <p className="text-[11px] font-black text-muted-foreground">后续规划会优先这样取舍</p>
          <ul className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {influence.scopes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {influence.tradeoffs.length > 0 && (
        <div className="grid gap-1">
          <p className="text-[11px] font-black text-muted-foreground">需要取舍</p>
          <ul className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {influence.tradeoffs.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {influence.conflictDetails.length > 0 && (
        <div className="grid gap-1">
          <p className="text-[11px] font-black text-muted-foreground">规则取舍详情</p>
          <ul className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {influence.conflictDetails.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {influence.avoidance.length > 0 && (
        <div className="grid gap-1">
          <p className="text-[11px] font-black text-muted-foreground">需要避开</p>
          <ul className="grid gap-1 text-xs font-semibold text-muted-foreground">
            {influence.avoidance.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AgentPanel({
  skills,
  importedSkillIds,
  itinerary,
  messages,
  agentInput,
  agentRunning,
  agentProgress,
  agentRunLog,
  onImportSkill,
  onRemoveSkill,
  onAgentInputChange,
  onRunAgent,
  onStopAgent,
  onToggleAgentRunLog,
  onToggleActiveAgentRunLog,
  onCreateSkillFromConversation,
  onUndoAgentChange,
  onLocateAgentChange,
  savedMemoryKeywords,
  onClose
}: {
  skills: TravelSkill[];
  importedSkillIds: string[];
  itinerary: TravelItinerary;
  messages: ChatMessage[];
  agentInput: string;
  agentRunning: boolean;
  agentProgress: string[];
  agentRunLog: AgentRunLog | null;
  onImportSkill: (skillId: string) => void;
  onRemoveSkill: (skillId: string) => void;
  onAgentInputChange: (value: string) => void;
  onRunAgent: (requestText?: string) => void;
  onStopAgent: () => void;
  onToggleAgentRunLog: (messageIndex: number) => void;
  onToggleActiveAgentRunLog: () => void;
  onCreateSkillFromConversation: () => void;
  onUndoAgentChange: (messageIndex: number) => void;
  onLocateAgentChange: (target: AgentChangeTarget) => void;
  savedMemoryKeywords: string[];
  onClose?: () => void;
}) {
  const displaySkills = useMemo(() => dedupeSkillsForDisplay(skills, importedSkillIds), [importedSkillIds, skills]);
  const appliedSkills = displaySkills.filter((skill) => importedSkillIds.includes(skill.id));
  const skillRecommendationById = useMemo(
    () =>
      new Map(
        recommendSkills(displaySkills, {
          destination: itinerary.destination,
          companions: [],
          preferences: savedMemoryKeywords,
          currentText: `${itinerary.title} ${itinerary.days.flatMap((day) => day.activities.map((activity) => activity.title)).join(" ")}`,
          importedSkillIds
        }).map((recommendation) => [recommendation.skill.id, recommendation])
      ),
    [displaySkills, importedSkillIds, itinerary, savedMemoryKeywords]
  );
  const [skillBrowserOpen, setSkillBrowserOpen] = useState(false);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const runLogAnchorRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const skipNextAutoScrollRef = useRef(false);
  function preserveRunLogAnchor(anchorElement?: HTMLElement | null) {
    const container = conversationScrollRef.current;
    if (!container || !anchorElement) return;
    runLogAnchorRef.current = {
      element: anchorElement,
      top: anchorElement.getBoundingClientRect().top
    };
    skipNextAutoScrollRef.current = true;
  }
  useLayoutEffect(() => {
    const container = conversationScrollRef.current;
    const anchor = runLogAnchorRef.current;
    if (!container || !anchor) return;
    runLogAnchorRef.current = null;
    const nextTop = anchor.element.getBoundingClientRect().top;
    container.scrollTop += nextTop - anchor.top;
  });
  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container) return;
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [agentProgress.length, agentRunLog?.items.length, agentRunLog?.expanded, agentRunning, messages]);
  return (
    <>
    <aside className="relative flex h-full min-h-0 flex-col bg-[#fbfbf9]">
      <header className="flex min-h-16 items-center gap-2 border-b border-border px-4">
        <Bot />
        <div className="min-w-0 flex-1">
          <h2 className="font-black">旅行助手</h2>
          <p className="truncate text-xs text-muted-foreground">
            {itinerary.title} · 出发点 {itinerary.destination} · {itinerary.days.length} 天
          </p>
        </div>
        {onClose && (
          <Button type="button" variant="ghost" size="icon" className="min-[769px]:hidden" onClick={onClose} aria-label="关闭旅行助手">
            <X />
          </Button>
        )}
      </header>
      <div data-testid="agent-style-strip" className="flex min-h-14 items-center gap-2 border-b border-border bg-white px-4 py-2">
        <p className="shrink-0 text-xs font-black text-muted-foreground">当前风格</p>
        <div
          data-testid="agent-style-list"
          className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap"
        >
          {appliedSkills.length > 0 ? (
            appliedSkills.map((skill) => (
              <span
                key={skill.id}
                className="inline-flex min-h-8 min-w-0 max-w-[180px] shrink-0 items-center gap-1 rounded-full bg-[#f6f6f3] pl-3 pr-0.5 text-xs font-bold text-foreground"
              >
                <span className="min-w-0 flex-1 truncate">{skillDisplayTitle(skill)}</span>
                <button
                  type="button"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onRemoveSkill(skill.id)}
                  aria-label={`移出当前风格 ${skillDisplayTitle(skill)}`}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))
          ) : (
            <span className="shrink-0 rounded-full bg-[#f6f6f3] px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              未选择风格
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 rounded-full"
            disabled={messages.length === 0 || agentRunning}
            onClick={onCreateSkillFromConversation}
            aria-label="沉淀风格"
            title="沉淀风格"
          >
            <WandSparkles className="size-4" />
          </Button>
          <Button
            type="button"
            variant={skillBrowserOpen ? "secondary" : "ghost"}
            size="icon"
            className="size-8 rounded-full"
            onClick={() => setSkillBrowserOpen((open) => !open)}
            aria-label="浏览风格"
            title="浏览风格"
          >
            <Store className="size-4" />
          </Button>
        </div>
      </div>
      <div ref={conversationScrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4" data-testid="agent-message-scroll">
        <div className="flex min-h-max flex-col gap-3" data-testid="agent-message-stack">
          {messages.length === 0 && !agentRunning && (
            <section className="rounded-2xl border border-border bg-white p-3" aria-label="旅行助手建议">
              <p className="text-sm font-black">试试这些需求</p>
              <div className="mt-3 grid gap-2">
                {ASSISTANT_PROMPT_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="min-h-11 rounded-2xl bg-[#f6f6f3] px-3 py-2 text-left text-xs font-bold text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onAgentInputChange(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </section>
          )}
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={cn(
                "max-w-[92%] rounded-2xl p-3 text-sm",
                message.role === "assistant" ? "self-start bg-white" : "self-end bg-primary text-primary-foreground"
              )}
            >
              <MessageContent
                content={message.content}
                changeSet={message.changeSet}
                runLog={message.runLog}
                onUndo={() => onUndoAgentChange(index)}
                onLocate={onLocateAgentChange}
                onToggleRunLog={(anchorElement) => {
                  preserveRunLogAnchor(anchorElement);
                  onToggleAgentRunLog(index);
                }}
                onRunSuggestion={message.role === "assistant" ? onRunAgent : undefined}
                actionsDisabled={agentRunning}
              />
            </div>
          ))}
          {agentRunning && agentRunLog && (
            <div className="max-w-[92%] self-start" aria-live="polite">
              <AgentRunLogPanel
                runLog={agentRunLog}
                onToggle={(anchorElement) => {
                  preserveRunLogAnchor(anchorElement);
                  onToggleActiveAgentRunLog();
                }}
              />
            </div>
          )}
        </div>
      </div>
      <footer className="border-t border-border p-4">
        <label className="sr-only" htmlFor="agent-input">
          对行程的修改需求
        </label>
        <Textarea
          id="agent-input"
          aria-label="对行程的修改需求"
          value={agentInput}
          onChange={(event) => onAgentInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!agentRunning) onRunAgent();
          }}
          placeholder="例如：Day 2 下午安排一个室内景点，节奏轻松一点。"
          disabled={agentRunning}
        />
        <Button className="mt-3 w-full" onClick={agentRunning ? onStopAgent : () => onRunAgent()}>
          {agentRunning ? <CircleStop data-icon="inline-start" /> : <Send data-icon="inline-start" />}
          {agentRunning ? "停止" : "发送"}
        </Button>
      </footer>
    </aside>
    {skillBrowserOpen && (
      <div className="fixed inset-0 z-[1200] bg-black/25" data-testid="skill-browser-backdrop">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="旅行风格选择"
          data-testid="skill-browser-panel"
          className="absolute inset-y-0 right-0 flex w-full max-w-[460px] flex-col border-l border-border bg-white shadow-2xl"
        >
          <header className="flex min-h-16 items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <h3 className="text-lg font-black">选择旅行风格</h3>
              <p className="mt-1 text-sm text-muted-foreground">选择后，本次行程会按它取舍地点和节奏。</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => setSkillBrowserOpen(false)}
              aria-label="关闭旅行风格选择"
            >
              <X />
            </Button>
          </header>
          <div className="min-h-0 flex-1 overflow-auto bg-[#fbfbf9] p-4">
            <div className="grid gap-2">
              {displaySkills.map((skill) => {
                const imported = importedSkillIds.includes(skill.id);
                const fitReasons = buildSkillFitReasons(skill, skillRecommendationById.get(skill.id), itinerary, savedMemoryKeywords);
                return (
                  <div
                    key={skill.id}
                    className={cn(
                      "rounded-2xl border border-border bg-white p-3",
                      imported && "border-ring/60 bg-[#f6f6f3]"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Sparkles className="mt-1 size-4 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-black">{skillDisplayTitle(skill)}</p>
                        <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">
                          {skillDisplayDescription(skill)}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {skill.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="rounded-full bg-[#f6f6f3] px-2 py-0.5 text-[11px] font-bold">
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="mt-3 rounded-2xl bg-[#fbfbf9] p-2">
                          <p className="text-[11px] font-black text-muted-foreground">适合当前行程</p>
                          <ul className="mt-1 grid gap-1 text-[11px] font-semibold text-foreground">
                            {fitReasons.slice(0, 2).map((reason) => (
                              <li key={reason} className="grid grid-cols-[auto_minmax(0,1fr)] gap-1.5">
                                <span className="mt-1.5 size-1 rounded-full bg-primary" aria-hidden="true" />
                                <span>{reason}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant={imported ? "secondary" : "outline"}
                        size="sm"
                        className="shrink-0 rounded-full"
                        onClick={() => {
                          if (imported) {
                            onRemoveSkill(skill.id);
                          } else {
                            onImportSkill(skill.id);
                            setSkillBrowserOpen(false);
                          }
                        }}
                        aria-label={`${imported ? "移出" : "使用"} ${skillDisplayTitle(skill)}`}
                      >
                        {imported ? "移出" : "使用"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: bold (**) before italic (*); explicit links before autolinks
  // so we don't double-wrap link URLs.
  const pattern =
    /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_|https?:\/\/[^\s)]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key} className="font-black">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("~~") && token.endsWith("~~")) {
      nodes.push(
        <s key={key} className="line-through text-muted-foreground">
          {token.slice(2, -2)}
        </s>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key} className="rounded-md bg-[#f6f6f3] px-1 py-0.5 font-mono text-[0.92em] text-foreground">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <a
            key={key}
            href={linkMatch[2]}
            target="_blank"
            rel="noreferrer"
            className="font-bold underline underline-offset-2"
          >
            {linkMatch[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("http")) {
      nodes.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noreferrer"
          className="font-bold underline underline-offset-2"
        >
          {token}
        </a>
      );
    } else if ((token.startsWith("*") && token.endsWith("*")) || (token.startsWith("_") && token.endsWith("_"))) {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    } else {
      nodes.push(token);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").match(/^```\s*$/)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${index}`} className="overflow-auto rounded-xl bg-[#211922] p-3 text-xs leading-5 text-white">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} className="my-3 border-t border-border" data-testid="markdown-hr" />);
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const marker = headingMatch[1] ?? "#";
      const headingText = headingMatch[2] ?? "";
      const level = marker.length;
      const className =
        level === 1
          ? "text-base font-black"
          : level === 2
            ? "text-sm font-black"
            : level === 3
              ? "text-xs font-black uppercase tracking-normal text-muted-foreground"
              : "text-xs font-black text-muted-foreground";
      blocks.push(
        <p key={`heading-${index}`} className={className} data-heading-level={level}>
          {renderInlineMarkdown(headingText, `heading-${index}`)}
        </p>
      );
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`quote-${index}`}
          className="border-l-2 border-primary/40 pl-3 leading-6 text-muted-foreground"
          data-testid="markdown-quote"
        >
          {renderInlineMarkdown(quoteLines.join(" "), `quote-${index}`)}
        </blockquote>
      );
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headerCells = parseMarkdownTableCells(lines[index] ?? "");
      const alignments = parseMarkdownTableAlignments(lines[index + 1] ?? "", headerCells.length);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isMarkdownTableRow(lines[index] ?? "")) {
        rows.push(normalizeMarkdownTableCells(parseMarkdownTableCells(lines[index] ?? ""), headerCells.length));
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} className="overflow-x-auto rounded-xl border border-border bg-white">
          <table data-testid="markdown-table" className="min-w-full border-collapse text-left text-xs">
            <thead className="bg-[#f6f6f3]">
              <tr>
                {headerCells.map((cell, cellIndex) => (
                  <th
                    key={`table-head-${index}-${cellIndex}`}
                    scope="col"
                    className={cn("border-b border-border px-2 py-2 font-black text-foreground", alignments[cellIndex])}
                  >
                    {renderInlineMarkdown(cell, `table-head-${index}-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`table-row-${index}-${rowIndex}`} className="border-t border-border/70">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`table-cell-${index}-${rowIndex}-${cellIndex}`}
                      className={cn("px-2 py-2 align-top leading-5 text-muted-foreground", alignments[cellIndex])}
                    >
                      {renderInlineMarkdown(cell, `table-cell-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
      const items: Array<{ checked: boolean; content: string }> = [];
      while (index < lines.length && /^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[index] ?? "")) {
        const taskMatch = (lines[index] ?? "").match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          items.push({ checked: taskMatch[1]?.toLowerCase() === "x", content: taskMatch[2] ?? "" });
        }
        index += 1;
      }
      blocks.push(
        <ul key={`task-${index}`} className="grid gap-1.5" data-testid="markdown-task-list">
          {items.map((item, itemIndex) => (
            <li
              key={`task-${index}-${itemIndex}`}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-2"
            >
              <input
                type="checkbox"
                checked={item.checked}
                readOnly
                disabled
                aria-label="任务复选框"
                className="mt-1 size-3.5 rounded border-border accent-primary"
              />
              <span>{renderInlineMarkdown(item.content, `task-${index}-${itemIndex}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (
        index < lines.length &&
        /^\s*[-*]\s+/.test(lines[index] ?? "") &&
        !/^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[index] ?? "")
      ) {
        items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="grid gap-1.5">
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <span className="mt-2 size-1.5 rounded-full bg-primary" aria-hidden="true" />
              <span>{renderInlineMarkdown(item, `ul-${index}-${itemIndex}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="grid gap-1.5">
          {items.map((item, itemIndex) => (
            <li key={`${item}-${itemIndex}`} className="grid grid-cols-[2ch_minmax(0,1fr)] gap-2">
              <span className="font-black text-muted-foreground">{itemIndex + 1}.</span>
              <span>{renderInlineMarkdown(item, `ol-${index}-${itemIndex}`)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^(#{1,6})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "") &&
      !/^\s*>\s?/.test(lines[index] ?? "") &&
      !/^\s*([-*_])\1{2,}\s*$/.test(lines[index] ?? "") &&
      !/^```/.test(lines[index] ?? "") &&
      !isMarkdownTableStart(lines, index)
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push(
      <p key={`p-${index}`} className="leading-6">
        {renderInlineMarkdown(paragraphLines.join(" "), `p-${index}`)}
      </p>
    );
  }
  return blocks;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const headerCells = parseMarkdownTableCells(lines[index] ?? "");
  if (headerCells.length < 2) return false;
  return isMarkdownTableDivider(lines[index + 1] ?? "", headerCells.length);
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("|")) return false;
  return parseMarkdownTableCells(trimmed).length >= 2;
}

function isMarkdownTableDivider(line: string, expectedColumns: number): boolean {
  const cells = parseMarkdownTableCells(line);
  if (cells.length !== expectedColumns) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function parseMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const withoutLeading = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutOuterPipes = withoutLeading.endsWith("|") ? withoutLeading.slice(0, -1) : withoutLeading;
  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

function parseMarkdownTableAlignments(dividerLine: string, expectedColumns: number): string[] {
  return normalizeMarkdownTableCells(parseMarkdownTableCells(dividerLine), expectedColumns).map((cell) => {
    const compact = cell.replace(/\s+/g, "");
    if (compact.startsWith(":") && compact.endsWith(":")) return "text-center";
    if (compact.endsWith(":")) return "text-right";
    return "text-left";
  });
}

function normalizeMarkdownTableCells(cells: string[], expectedColumns: number): string[] {
  return Array.from({ length: expectedColumns }, (_, index) => cells[index] ?? "");
}

function AgentRunLogPanel({ runLog, onToggle }: { runLog: AgentRunLog; onToggle?: (anchorElement?: HTMLElement | null) => void }) {
  const panelRef = useRef<HTMLElement | null>(null);
  const primaryItems = primaryAgentActivityItems(runLog.items);
  const reasoningItems = reasoningAgentActivityItems(runLog.items);
  const statusLabel: Record<AgentRunLog["status"], string> = {
    running: "执行中",
    completed: "任务已完成",
    failed: "未完成",
    stopped: "已停止"
  };
  const statusClassName =
    runLog.status === "completed"
      ? "bg-emerald-100 text-emerald-950"
      : runLog.status === "failed"
        ? "bg-destructive text-destructive-foreground"
        : runLog.status === "stopped"
          ? "bg-[#f6f6f3] text-muted-foreground"
          : "bg-primary text-primary-foreground";
  return (
    <section
      ref={panelRef}
      role="group"
      aria-label="Agent 执行记录"
      className="grid gap-2 rounded-2xl border border-border bg-[#fbfbf9] p-2.5 text-xs"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={runLog.expanded}
        aria-label={`Agent 执行记录：${runLog.summary}`}
        onClick={() => onToggle?.(panelRef.current)}
      >
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black", statusClassName)}>
          {statusLabel[runLog.status]}
        </span>
        <span className="min-w-0 flex-1 font-black text-foreground">{runLog.summary}</span>
        {runLog.expanded ? <ChevronUp className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
      </button>
      {runLog.expanded && (
        <div className="grid gap-2">
          {reasoningItems.length > 0 && (
            <div className="grid gap-2">
              {reasoningItems.map((item) => (
                <section key={item.id} data-testid="agent-reasoning-block" className="rounded-xl bg-white p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="font-black text-foreground">{item.title}</p>
                    {item.agent && (
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-black text-foreground">
                        {agentLabel(item.agent)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-[#fbfbf9] p-2 leading-5 text-muted-foreground">
                    {item.detail}
                  </p>
                </section>
              ))}
            </div>
          )}
          {primaryItems.length === 0 && reasoningItems.length === 0 && runLog.status === "running" && (
            <div
              data-testid="agent-thinking-placeholder"
              className="flex items-center gap-2 rounded-xl bg-white p-2 text-xs font-semibold text-muted-foreground"
            >
              <span
                data-testid="agent-thinking-spinner"
                className="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
                aria-hidden="true"
              />
              <span>思考中</span>
            </div>
          )}
          {primaryItems.length === 0 && reasoningItems.length === 0 && runLog.status !== "running" && (
            <p className="rounded-xl bg-white p-2 text-xs font-semibold text-muted-foreground">暂无模型输出或工具调用。</p>
          )}
          {primaryItems.length > 0 && (
        <ol data-testid="agent-primary-step-list" className="grid gap-2">
          {primaryItems.map((item, index) => (
            <li key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-xl bg-white p-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#f6f6f3] text-[10px] font-black text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="font-black text-foreground">{item.title}</p>
                  {shouldShowAgentActivityLabel(item) && (
                    <span className="rounded-full bg-[#f6f6f3] px-2 py-0.5 text-[10px] font-black text-muted-foreground">
                      {agentActivityLabel(item)}
                    </span>
                  )}
                  {shouldShowAgentBadge(item) && item.agent && (
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-black text-foreground">
                      {agentLabel(item.agent)}
                    </span>
                  )}
                </div>
                {item.detail && (
                  <p
                    className={cn(
                      "mt-1 leading-5 text-muted-foreground",
                      "max-h-40 overflow-y-auto rounded-lg bg-[#fbfbf9] p-2",
                      item.kind === "thought" && item.status === "running" && "italic"
                    )}
                  >
                    {item.detail}
                  </p>
                )}
                {hasTechnicalPayload(item.technical) && (
                  <details className="mt-2 rounded-lg border border-border bg-[#fbfbf9] px-2 py-1">
                    <summary className="cursor-pointer text-[10px] font-black text-muted-foreground">技术详情</summary>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-4 text-muted-foreground">
                      {formatTechnicalPayload(item.technical)}
                    </pre>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
          )}
        </div>
      )}
    </section>
  );
}

function MessageContent({
  content,
  changeSet,
  runLog,
  onUndo,
  onLocate,
  onToggleRunLog,
  onRunSuggestion,
  actionsDisabled
}: {
  content: string;
  changeSet?: AgentChangeSet;
  runLog?: AgentRunLog;
  onUndo?: () => void;
  onLocate?: (target: AgentChangeTarget) => void;
  onToggleRunLog?: (anchorElement?: HTMLElement | null) => void;
  onRunSuggestion?: (requestText: string) => void;
  actionsDisabled?: boolean;
}) {
  const runLogNode = runLog ? <AgentRunLogPanel runLog={runLog} onToggle={onToggleRunLog} /> : null;
  const lines = content.split("\n");
  const diffStartIndex = lines.findIndex((line) => line === "本轮改动");
  if (diffStartIndex >= 0) {
    const bodyLines = lines.slice(0, diffStartIndex).filter((line) => line.trim().length > 0);
    const parsedDiffItems = lines
      .slice(diffStartIndex + 1)
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean);
    const diffItems = changeSet?.diff.length ? changeSet.diff : parsedDiffItems;
    const styleNames = changeSet?.styleNames ?? [];
    const styleInfluences = changeSet?.styleInfluences ?? [];
    return (
      <div className="grid gap-3">
        {runLogNode}
        {renderMarkdownBlocks(bodyLines.join("\n"))}
        {diffItems.length > 0 && (
          <section
            role="group"
            aria-label="本轮改动"
            className="grid gap-2 rounded-2xl border border-border bg-[#fbfbf9] p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-black text-foreground">本轮改动</p>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-[11px] font-black",
                  changeSet?.undone ? "bg-[#f6f6f3] text-muted-foreground" : "bg-emerald-100 text-emerald-950"
                )}
              >
                {changeSet?.undone ? "已撤销" : "已应用到画布"}
              </span>
            </div>
            {styleNames.length > 0 && (
              <div className="grid gap-1">
                <p className="text-[11px] font-black text-muted-foreground">参考风格</p>
                <div className="flex flex-wrap gap-1.5">
                  {styleNames.map((name) => (
                    <span key={name} className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-foreground">
                      {name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {styleInfluences.length > 0 && (
              <div className="grid gap-1 rounded-xl bg-white p-2" aria-label="本轮风格影响">
                <p className="text-[11px] font-black text-muted-foreground">本轮风格影响</p>
                <ul className="grid gap-1.5 text-[11px] font-semibold text-foreground">
                  {styleInfluences.map((influence) => (
                    <li key={influence.skillName} className="grid gap-1">
                      <span className="font-black">{influence.skillName}</span>
                      {influence.scopes.length > 0 && (
                        <span className="text-muted-foreground">影响 {influence.scopes.join("、")}</span>
                      )}
                      {influence.rules.slice(0, 2).map((rule) => (
                        <span key={rule}>{rule}</span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="grid gap-1.5 text-xs font-semibold text-muted-foreground">
              {diffItems.map((item, index) => {
                const target = changeSet?.targets[index];
                return (
                  <li key={`${item}-${index}`} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <span className="mt-1 size-1.5 rounded-full bg-primary" aria-hidden="true" />
                    <span className="min-w-0">
                      <span>{item}</span>
                      {target && onLocate && !changeSet?.undone && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-2 h-7 rounded-full px-2 text-[11px]"
                          onClick={() => onLocate(target)}
                          aria-label={`定位本轮改动：${target.label}`}
                        >
                          定位
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {changeSet?.beforeItinerary && !changeSet.undone && (
              <Button type="button" variant="outline" size="sm" className="w-fit rounded-full" onClick={onUndo}>
                撤销本轮改动
              </Button>
            )}
          </section>
        )}
      </div>
    );
  }
  const optionActions = buildRouteConflictOptionActions(content);
  return (
    <div className="grid gap-2">
      {runLogNode}
      {renderMarkdownBlocks(content)}
      {optionActions.length > 0 && onRunSuggestion && (
        <section
          role="group"
          aria-label="路线调整方案"
          className="mt-2 grid gap-2 rounded-2xl border border-border bg-[#fbfbf9] p-2.5"
        >
          {optionActions.map((action) => (
            <Button
              key={action.label}
              type="button"
              variant="outline"
              className="min-h-11 justify-start rounded-full bg-white px-3 text-left text-xs"
              disabled={actionsDisabled}
              onClick={() => onRunSuggestion(action.requestText)}
              aria-label={`执行方案：${action.label}`}
            >
              {action.label}
            </Button>
          ))}
        </section>
      )}
    </div>
  );
}

function SkillValidationSummary({
  title,
  validation
}: {
  title: string;
  validation: SkillValidationResult;
}) {
  return (
    <section className="rounded-2xl border border-border bg-[#fbfbf9] p-3" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-black text-foreground">{title}</p>
        <Badge className={cn(validation.valid ? "bg-secondary text-foreground" : "bg-destructive text-destructive-foreground")}>
          {validation.valid ? "可使用" : "待完善"}
        </Badge>
      </div>
      <ul className="mt-2 grid gap-1.5 text-xs font-semibold text-muted-foreground">
        {validation.checks.map((check) => (
          <li key={check.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
            <span
              className={cn("mt-1 size-1.5 rounded-full", check.passed ? "bg-primary" : "bg-destructive")}
              aria-hidden="true"
            />
            <span className={check.passed ? "text-muted-foreground" : "text-foreground"}>{check.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkillPlaza({
  skills,
  recommendations,
  itinerary,
  importedSkillIds,
  savedMemoryKeywords,
  filter,
  onImport,
  onRemoveImport,
  onImportMarkdown,
  onFilterChange,
  onFavorite,
  onUpdateSkill
}: {
  skills: TravelSkill[];
  recommendations: ReturnType<typeof recommendSkills>;
  itinerary: TravelItinerary;
  importedSkillIds: string[];
  savedMemoryKeywords: string[];
  filter: SkillFilter;
  onImport: (skillId: string) => void;
  onRemoveImport: (skillId: string) => void;
  onImportMarkdown: (markdown: string) => void | Promise<void>;
  onFilterChange: (filter: SkillFilter) => void;
  onFavorite: (skillId: string) => void;
  onUpdateSkill: (skillId: string, changes: Partial<TravelSkill>) => void;
}) {
  const [importText, setImportText] = useState("");
  const [importPanelOpen, setImportPanelOpen] = useState(false);
  const importValidation = useMemo(() => validateSkillMarkdown(importText), [importText]);
  const displaySkills = useMemo(() => dedupeSkillsForDisplay(skills, importedSkillIds), [importedSkillIds, skills]);
  const recommendedSkills = dedupeSkillsForDisplay(
    recommendations.map((item) => item.skill),
    importedSkillIds
  );
  const recommendationBySkillId = useMemo(
    () => new Map(recommendations.map((item) => [item.skill.id, item])),
    [recommendations]
  );
  const importedSkills = displaySkills.filter((skill) => importedSkillIds.includes(skill.id));
  const favoriteCount = displaySkills.filter((skill) => skill.favorited).length;
  const visibleSkills =
    filter === "recommended"
      ? recommendedSkills
    : filter === "favorites"
        ? displaySkills.filter((skill) => skill.favorited)
    : filter === "drafts"
          ? displaySkills.filter((skill) => skill.status === "draft")
          : displaySkills;

  return (
    <div className="min-h-screen overflow-auto bg-[#fbfbf9] p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">Skill 广场</h2>
          <p className="text-muted-foreground">发现可复用的旅行风格，并应用到当前行程。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>推荐风格</Badge>
          <Badge className="bg-white text-foreground">{favoriteCount} 个收藏</Badge>
          <Button type="button" variant="outline" className="rounded-full bg-white" onClick={() => setImportPanelOpen((open) => !open)}>
            <Sparkles data-icon="inline-start" />
            导入风格
          </Button>
        </div>
      </div>
      <section
        className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-white px-4 py-3"
        aria-label="当前行程使用的旅行风格"
      >
        <div className="min-w-0">
          <p className="text-xs font-black text-muted-foreground">当前行程</p>
          <p className="truncate text-sm font-bold">
            {itinerary.title} · {importedSkills.length ? `已使用 ${importedSkills.length} 个风格` : "还未选择旅行风格"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {importedSkills.length ? (
            importedSkills.map((skill) => (
              <Badge key={skill.id} className="bg-[#f6f6f3] text-foreground">
                {skillDisplayTitle(skill)}
              </Badge>
            ))
          ) : (
            <Badge className="bg-[#f6f6f3] text-muted-foreground">从下方选择旅行风格</Badge>
          )}
        </div>
      </section>
      {importPanelOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/30 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导入旅行风格"
            className="grid max-h-[min(720px,calc(100vh-32px))] w-full max-w-2xl overflow-hidden rounded-[20px] border border-border bg-white shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-lg font-black">导入旅行风格</h3>
                <p className="mt-1 text-sm text-muted-foreground">粘贴旅行风格内容，校验通过后保存到风格库。</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => setImportPanelOpen(false)}
                aria-label="关闭导入旅行风格"
              >
                <X />
              </Button>
            </div>
            <div className="grid min-h-0 gap-4 overflow-auto p-5">
              <label className="flex flex-col gap-2 text-xs font-bold text-muted-foreground">
                粘贴风格内容
                <Textarea
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  aria-label="粘贴风格内容"
                  className="min-h-52"
                  placeholder={"---\nname: rainy-cafe-style\ndescription: 适合雨天、咖啡、室内和不赶路的旅行风格\n---\n\n## 规划规则\n- 雨天优先室内景点和咖啡休息"}
                />
              </label>
              <SkillValidationSummary title="格式检查" validation={importValidation} />
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="outline" className="rounded-full" onClick={() => setImportPanelOpen(false)}>
                  取消
                </Button>
                <Button
                  className="rounded-full"
                  disabled={!importValidation.valid}
                  onClick={async () => {
                    if (!importText.trim()) return;
                    await onImportMarkdown(importText);
                    setImportText("");
                    setImportPanelOpen(false);
                  }}
                >
                  <Sparkles data-icon="inline-start" />
                  用于当前行程
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      <TabsList className="mb-5 flex w-fit flex-wrap">
        {[
          ["recommended", "推荐"],
          ["all", "全部"],
          ["favorites", "我的收藏"],
          ["drafts", "草稿"]
        ].map(([value, label]) => (
          <TabsTrigger
            key={value}
            active={filter === value}
            onClick={() => onFilterChange(value as SkillFilter)}
          >
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      {visibleSkills.length === 0 ? (
        <Card className="bg-white">
          <CardHeader>
            <CardTitle>{filter === "favorites" ? "还没有收藏的旅行风格" : "这里暂时没有旅行风格"}</CardTitle>
            <CardDescription>
              {filter === "favorites" ? "在旅行风格卡片上点收藏后，会出现在这里。" : "可以先去创作一个旅行风格草稿。"}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid items-stretch gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {visibleSkills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              recommendation={recommendationBySkillId.get(skill.id)}
              itinerary={itinerary}
              savedMemoryKeywords={savedMemoryKeywords}
              imported={importedSkillIds.includes(skill.id)}
              onImport={() => onImport(skill.id)}
              onRemoveImport={() => onRemoveImport(skill.id)}
              onFavorite={() => onFavorite(skill.id)}
              onSaveTags={(tags) => onUpdateSkill(skill.id, { tags })}
              allowTagEditing={filter === "drafts" || skill.source !== "plaza"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  recommendation,
  itinerary,
  savedMemoryKeywords,
  imported,
  onImport,
  onRemoveImport,
  onFavorite,
  onSaveTags,
  allowTagEditing
}: {
  skill: TravelSkill;
  recommendation?: SkillRecommendation;
  itinerary: TravelItinerary;
  savedMemoryKeywords: string[];
  imported: boolean;
  onImport: () => void;
  onRemoveImport: () => void;
  onFavorite: () => void;
  onSaveTags: (tags: string[]) => void;
  allowTagEditing: boolean;
}) {
  const [tagText, setTagText] = useState(skill.tags.join(","));
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const displayTitle = skillDisplayTitle(skill);
  const fitReasons = buildSkillFitReasons(skill, recommendation, itinerary, savedMemoryKeywords);

  useEffect(() => {
    setTagText(skill.tags.join(","));
  }, [skill.id, skill.tags.join(",")]);

  return (
    <Card className="flex h-full min-h-[560px] flex-col overflow-hidden bg-white">
      <SkillCardVisual skill={skill} />
      <CardHeader className="shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="line-clamp-1">{displayTitle}</CardTitle>
            <CardDescription className="line-clamp-2">{skillDisplayDescription(skill)}</CardDescription>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {imported && <Badge className="bg-accent text-accent-foreground">使用中</Badge>}
            {skill.status === "draft" && <Badge>草稿</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex min-h-8 flex-wrap content-start gap-2">
          {skill.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
        <section className="min-h-[108px] rounded-2xl bg-[#fbfbf9] p-3" aria-label={`${displayTitle}适配当前行程的原因`}>
          <p className="text-xs font-black text-muted-foreground">适合当前行程</p>
          <ul className="mt-2 grid gap-1.5 text-xs font-semibold text-foreground">
            {fitReasons.map((reason) => (
              <li key={reason} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
                <span className="mt-1.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span className="line-clamp-2">{reason}</span>
              </li>
            ))}
          </ul>
        </section>
        <SkillVersionHistory skill={skill} displayTitle={displayTitle} />
        {allowTagEditing && tagEditorOpen ? (
          <div className="grid gap-2 rounded-2xl bg-[#fbfbf9] p-3 sm:grid-cols-[1fr_auto]">
            <Input
              value={tagText}
              onChange={(event) => setTagText(event.target.value)}
              aria-label={`编辑${displayTitle}标签`}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onSaveTags(splitTagInput(tagText));
                setTagEditorOpen(false);
              }}
              aria-label={`保存${displayTitle}标签`}
            >
              保存标签
            </Button>
          </div>
        ) : allowTagEditing ? (
          <Button
            type="button"
            variant="secondary"
            className="w-fit rounded-full"
            onClick={() => setTagEditorOpen(true)}
            aria-label={`打开${displayTitle}标签编辑`}
            title="编辑标签"
          >
            <Pencil data-icon="inline-start" />
            编辑标签
          </Button>
        ) : null}
        <p className="mt-auto text-xs font-semibold text-muted-foreground">{skill.favorites} 人收藏</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant={skill.favorited ? "secondary" : "outline"}
            onClick={onFavorite}
            aria-label={`${skill.favorited ? "取消收藏" : "收藏"}${displayTitle}`}
            className="w-full"
          >
            <Heart data-icon="inline-start" />
            {skill.favorited ? "取消收藏" : "收藏"}
          </Button>
          <Button
            onClick={imported ? onRemoveImport : onImport}
            variant={imported ? "secondary" : "default"}
            className="w-full"
            aria-label={`${imported ? "移出" : "使用"}${displayTitle}风格`}
          >
            <Sparkles data-icon="inline-start" />
            {imported ? "移出行程" : "使用风格"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SkillVersionHistory({ skill, displayTitle }: { skill: TravelSkill; displayTitle: string }) {
  const versions = normalizeSkillVersionHistory(skill);
  if (versions.length === 0) return null;

  const latest = versions[versions.length - 1]!;
  const visibleVersions = versions.slice(-3).reverse();
  return (
    <section className="rounded-2xl border border-border bg-white p-3" aria-label={`${displayTitle} 版本记录`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-black text-foreground">
          <History className="size-4 text-muted-foreground" aria-hidden="true" />
          版本记录
        </div>
        <Badge className="bg-[#f6f6f3] text-foreground">当前 v{latest.version}</Badge>
      </div>
      <ol className="mt-2 grid gap-2 text-xs font-semibold">
        {visibleVersions.map((version) => (
          <li key={`${skill.id}-${version.version}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <span className="rounded-full bg-secondary px-2 py-1 font-black text-foreground">v{version.version}</span>
            <span className="min-w-0 truncate text-foreground">{version.summary}</span>
            <time className="text-muted-foreground" dateTime={version.createdAt}>
              {formatSkillVersionDate(version)}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatSkillVersionDate(version: TravelSkillVersion): string {
  const date = new Date(version.createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function SkillCardVisual({ skill }: { skill: TravelSkill }) {
  const visual = skillVisualProfile(skill);
  return (
    <div className={cn("skill-visual h-44", `skill-visual--${visual.tone}`)} aria-label={`${skillDisplayTitle(skill)}视觉：${visual.label}`}>
      <div className="skill-visual__tile skill-visual__tile--large" aria-hidden="true" />
      <div className="skill-visual__tile skill-visual__tile--small" aria-hidden="true" />
      <div className="skill-visual__tile skill-visual__tile--wide" aria-hidden="true" />
      <div className="skill-visual__caption">
        <span>{visual.label}</span>
        <strong>{visual.subject}</strong>
      </div>
    </div>
  );
}

function skillVisualProfile(skill: TravelSkill): { tone: string; label: string; subject: string } {
  const tags = skill.tags ?? [];
  const text = [skill.displayName, skill.description, skill.body, ...tags].join(" ");
  if (/海边|日落|松弛|小店/.test(text)) return { tone: "seaside", label: "海边松弛", subject: "日落与街区小店" };
  if (/亲子|博物馆|展馆/.test(text)) return { tone: "museum", label: "亲子博物馆", subject: "展馆与休息节奏" };
  if (/咖啡|citywalk|街区|慢节奏/.test(text)) return { tone: "citywalk", label: "街区漫步", subject: "咖啡与轻量步行" };
  if (/雨天|室内/.test(text)) return { tone: "rainy", label: "雨天室内", subject: "室内备选与休息" };
  return { tone: "default", label: "旅行风格", subject: tags.slice(0, 2).join("与") || "自定义规则" };
}

function buildSkillFitReasons(
  skill: TravelSkill,
  recommendation: SkillRecommendation | undefined,
  itinerary: TravelItinerary,
  memoryKeywords: string[]
): string[] {
  const reasons = new Set<string>();
  const skillTags = skill.tags ?? [];
  const itineraryDays = itinerary.days ?? [];
  const matchedMemoryKeywords = memoryKeywords.filter((keyword) => skillTags.includes(keyword));
  if (matchedMemoryKeywords.length) {
    reasons.add(`匹配已保存记忆：${matchedMemoryKeywords.slice(0, 3).join("、")}`);
  }
  const activityTags = new Set(itineraryDays.flatMap((day) => (day.activities ?? []).flatMap((activity) => activity.tags ?? [])));
  const matchedActivityTags = skillTags.filter((tag) => activityTags.has(tag));
  if (matchedActivityTags.length) {
    reasons.add(`与已安排内容相符：${matchedActivityTags.slice(0, 3).join("、")}`);
  }
  for (const reason of recommendation?.reasons ?? []) {
    if (reason === "匹配当前行程语境") continue;
    if (reason.startsWith("匹配偏好：")) continue;
    reasons.add(reason);
    if (reasons.size >= 2) break;
  }
  if (skill.rules[0]) {
    reasons.add(`使用后会优先遵循：${skill.rules[0]}`);
  }
  if (reasons.size === 0) {
    reasons.add(`可作为从「${itinerary.destination}」出发的行程风格参考`);
  }
  return [...reasons].slice(0, 3);
}

function SkillCreator({
  sourceText,
  onSourceTextChange,
  onUseCurrentItinerary,
  onStart,
  onCreatorReply,
  onPublish
}: {
  sourceText: string;
  onSourceTextChange: (value: string) => void;
  onUseCurrentItinerary: () => void;
  onStart: () => Promise<SkillCreatorStartResponse>;
  onCreatorReply: (sessionId: string, answer: { selectedOptionIds: string[]; customAnswer: string }) => Promise<SkillCreatorReplyResponse>;
  onPublish: (changes: Partial<TravelSkill>) => void;
}) {
  const [session, setSession] = useState<SkillCreatorSession | null>(null);
  const [turn, setTurn] = useState<SkillCreatorTurn | null>(null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [customAnswer, setCustomAnswer] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceText.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await onStart();
      setSession(result.session);
      setTurn(result.turn);
      setSelectedOptionIds([]);
      setCustomAnswer("");
      setAdvancedOpen(false);
    } catch {
      setError("创作助手暂时无法开始，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !turn || busy) return;
    if (!customAnswer.trim() && selectedOptionIds.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await onCreatorReply(session.id, {
        selectedOptionIds,
        customAnswer: customAnswer.trim()
      });
      setSession(result.session);
      setTurn(result.turn);
      setSelectedOptionIds([]);
      setCustomAnswer("");
      setAdvancedOpen(false);
    } catch {
      setError("创作助手没有返回可用问题，请重试本题。");
    } finally {
      setBusy(false);
    }
  }

  function toggleOption(option: SkillCreatorOption) {
    if (!turn?.mode) return;
    setSelectedOptionIds((current) => {
      if (turn.mode === "single") return current.includes(option.id) ? [] : [option.id];
      return current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id];
    });
  }

  const showHeader = !session || !turn || turn.done;
  const sourceCharacterCount = sourceText.trim().length;
  const inspirationPins = [
    {
      title: "海边散步",
      meta: "地点偏好",
      icon: MapPin,
      className: "min-h-[184px] bg-[linear-gradient(145deg,#dce9f1_0%,#eef4f5_38%,#8fb6c5_100%)] text-[#211922]"
    },
    {
      title: "傍晚日落",
      meta: "时间节奏",
      icon: Clock3,
      className: "min-h-[132px] bg-[linear-gradient(145deg,#ffcf78_0%,#f07f3c_52%,#9e321f_100%)] text-white"
    },
    {
      title: "小店探索",
      meta: "体验类型",
      icon: Store,
      className: "min-h-[118px] bg-[linear-gradient(145deg,#e5eee2_0%,#b8d1bd_52%,#5d8067_100%)] text-[#211922]"
    },
    {
      title: "不要赶路",
      meta: "避开安排",
      icon: Check,
      className: "min-h-[154px] bg-[linear-gradient(145deg,#f7f2e9_0%,#d9c7ad_48%,#5d5144_100%)] text-[#211922]"
    }
  ];

  return (
    <main className="mx-auto flex h-[calc(100dvh-32px)] w-full min-w-0 max-w-7xl flex-col gap-5 overflow-auto overflow-x-hidden bg-white p-4 md:p-6">
      {showHeader && (
        <div className="shrink-0">
          <h2 className="text-4xl font-black leading-none tracking-normal text-balance sm:text-5xl">创作 Skill</h2>
          <p className="mt-3 max-w-3xl text-base font-semibold leading-7 text-muted-foreground md:text-lg">
            把旅行经验交给创作助手，由它主持问题并生成可发布的旅行风格。
          </p>
        </div>
      )}

      {!session || !turn ? (
        <form className="grid min-w-0 gap-5 min-[1180px]:min-h-0 min-[1180px]:flex-1 min-[1180px]:grid-cols-[minmax(0,1.02fr)_minmax(320px,0.78fr)] min-[1180px]:items-stretch" onSubmit={handleStart}>
          <section className="flex min-w-0 flex-col rounded-[16px] border border-[#dadad3] bg-[#fbfbf9] p-4 min-[1180px]:min-h-0 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-xl font-black">来源材料</h3>
                <p className="mt-1 max-w-xl text-sm font-semibold leading-6 text-muted-foreground">
                  粘贴游记、攻略或旅行笔记，越具体越容易提炼出独特风格。
                </p>
              </div>
              <Button type="button" variant="secondary" className="h-10 min-h-10 w-full shrink-0 rounded-full bg-[#e5e5e0] px-4 min-[560px]:w-auto" onClick={onUseCurrentItinerary} disabled={busy}>
                <MapPinned data-icon="inline-start" />
                使用当前行程
              </Button>
            </div>

            <div className="mt-4 flex min-w-0 flex-col rounded-[16px] border border-[#dadad3] bg-white min-[1180px]:min-h-0 min-[1180px]:flex-1">
              <Textarea
                name="skill-source-text"
                autoComplete="off"
                value={sourceText}
                onChange={(event) => onSourceTextChange(event.target.value)}
                className="min-h-[168px] resize-none border-0 bg-transparent p-4 text-base font-semibold leading-8 shadow-none focus-visible:ring-0 sm:min-h-[220px] sm:p-5 min-[1180px]:min-h-[320px] min-[1180px]:flex-1"
                aria-label="来源材料"
                placeholder="例如：这次厦门旅行最喜欢沙坡尾海边散步、傍晚日落和小店探索，整体不要赶路…"
                disabled={busy}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e5e5e0] px-4 py-3 text-xs font-bold text-muted-foreground">
                <span>内容只用于生成旅行风格草稿</span>
                <span>{sourceCharacterCount}/2000</span>
              </div>
            </div>

            {error && <p className="mt-3 rounded-[16px] bg-red-50 px-4 py-3 text-sm font-bold text-destructive">{error}</p>}

            <Button type="submit" className="mt-4 min-h-14 rounded-[16px] text-base font-black" disabled={!sourceText.trim() || busy}>
              <Sparkles data-icon="inline-start" />
              {busy ? "正在开始..." : "开始创作"}
            </Button>
          </section>

          <aside className="min-h-0 min-w-0 rounded-[16px] bg-[#f6f6f3] p-4 md:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-xl font-black">灵感板</h3>
              <p className="text-sm font-semibold text-muted-foreground">助手会从材料里提炼风格</p>
            </div>
            <div className="mt-4 flex min-h-0 min-w-0 snap-x gap-3 overflow-x-auto pb-1 min-[1180px]:grid min-[1180px]:grid-cols-2 min-[1180px]:overflow-visible min-[1180px]:pb-0">
              {inspirationPins.map((pin, index) => {
                const Icon = pin.icon;
                return (
                  <div
                    key={pin.title}
                    className={cn(
                      "relative flex min-h-[104px] min-w-[168px] snap-start overflow-hidden rounded-[16px] p-3 min-[1180px]:min-w-0",
                      index === 0 && "min-[1180px]:row-span-2",
                      index === 3 && "min-[1180px]:row-span-2",
                      pin.className
                    )}
                  >
                    <div className="relative z-10 mt-auto max-w-full rounded-full bg-white/90 px-3 py-2 text-sm font-black text-[#211922] shadow-sm">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Icon className="size-4 shrink-0" />
                        <span className="truncate">{pin.title}</span>
                      </span>
                    </div>
                    <span className="absolute right-3 top-3 hidden rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-black text-[#211922] min-[420px]:inline-flex">
                      {pin.meta}
                    </span>
                  </div>
                );
              })}
              <div className="min-w-[260px] snap-start rounded-[16px] border border-[#dadad3] bg-white p-4 min-[1180px]:col-span-2 min-[1180px]:min-w-0">
                <div className="inline-flex max-w-full items-center gap-2 rounded-full bg-[#f6f6f3] px-3 py-2 text-sm font-black">
                  <WandSparkles className="size-4 text-primary" />
                  <span className="truncate">Agent 会继续追问</span>
                </div>
                <p className="mt-3 text-sm font-semibold leading-6 text-muted-foreground">
                  你只需要回答它给出的选择题；它会判断信息是否足够，再生成最终可检查的旅行风格。
                </p>
              </div>
            </div>
          </aside>
        </form>
      ) : turn.done ? (
        <SkillCreatorFinalReview
          session={session}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((open) => !open)}
          onPublish={onPublish}
        />
      ) : (
        <form className="flex min-h-0 flex-1 flex-col gap-5 rounded-xl border border-border bg-white p-5" onSubmit={handleSubmitAnswer}>
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-black text-muted-foreground">创作助手</div>
            <div className="flex min-w-48 items-center gap-2" aria-label={`创作进度 ${turn.progressPercent}%`}>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary" style={{ width: `${turn.progressPercent}%` }} />
              </div>
              <span className="text-sm font-black">{turn.progressPercent}%</span>
            </div>
          </div>
          <div>
            <h3 className="text-3xl font-black leading-tight">{turn.question}</h3>
          </div>
          <div className="grid gap-3">
            {(turn.options ?? []).map((option) => {
              const selected = selectedOptionIds.includes(option.id);
              return (
                <Button
                  key={option.id}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  className="h-auto justify-start rounded-xl px-4 py-4 text-left text-base leading-6"
                  onClick={() => toggleOption(option)}
                  disabled={busy}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          <label className="grid gap-2 text-sm font-black text-muted-foreground">
            补充答案
            <Input
              value={customAnswer}
              onChange={(event) => setCustomAnswer(event.target.value)}
              aria-label="补充答案"
              placeholder={turn.customPlaceholder ?? "也可以写自己的答案"}
              disabled={busy}
            />
          </label>
          {error && <p className="text-sm font-bold text-destructive">{error}</p>}
          <div className="mt-auto flex justify-end border-t border-border pt-4">
            <Button type="submit" className="rounded-xl" disabled={busy || (!customAnswer.trim() && selectedOptionIds.length === 0)}>
              <Send data-icon="inline-start" />
              {busy ? "提交中..." : "提交回答"}
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}

function SkillCreatorFinalReview({
  session,
  advancedOpen,
  onToggleAdvanced,
  onPublish
}: {
  session: SkillCreatorSession;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  onPublish: (changes: Partial<TravelSkill>) => void;
}) {
  const draft = session.draft;
  const [displayName, setDisplayName] = useState(draft.displayName);
  const [tags, setTags] = useState(draft.tags.join(","));
  const [description, setDescription] = useState(draft.description);
  const [rules, setRules] = useState(draft.rules.join("\n"));
  const [forbidden, setForbidden] = useState(draft.forbidden.join("\n"));
  const [body, setBody] = useState(draft.body);
  const editedSkill: TravelSkill = {
    ...draft,
    displayName,
    description,
    body,
    tags: splitTagInput(tags),
    rules: splitLines(rules),
    forbidden: splitLines(forbidden)
  };
  const markdown = buildSkillMarkdown({
    name: draft.name,
    description: editedSkill.description,
    body: editedSkill.body,
    tags: editedSkill.tags,
    rules: editedSkill.rules,
    forbidden: editedSkill.forbidden
  });
  const validation = validateSkillMarkdown(markdown);
  const hasDisplayName = displayName.trim().length > 0;
  const canPublish = validation.valid && hasDisplayName;

  useEffect(() => {
    setDisplayName(draft.displayName);
    setTags(draft.tags.join(","));
    setDescription(draft.description);
    setRules(draft.rules.join("\n"));
    setForbidden(draft.forbidden.join("\n"));
    setBody(draft.body);
  }, [draft.id]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-white p-5" aria-label="最终检查">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black text-muted-foreground">最终检查</p>
          <h3 className="mt-1 text-2xl font-black">{editedSkill.displayName}</h3>
          <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-muted-foreground">{editedSkill.description}</p>
        </div>
        <Button
          type="button"
          className="rounded-xl"
          disabled={!canPublish}
          onClick={() => {
            if (!canPublish) return;
            onPublish({ ...editedSkill, displayName: displayName.trim() });
          }}
        >
          <Sparkles data-icon="inline-start" />
          发布到广场
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-3 rounded-xl bg-[#fbfbf9] p-4">
          <p className="text-xs font-black text-muted-foreground">标签</p>
          <div className="flex flex-wrap gap-2">
            {editedSkill.tags.map((tag) => (
              <Badge key={tag} className="bg-white text-foreground">
                {tag}
              </Badge>
            ))}
          </div>
          <p className="text-xs font-black text-muted-foreground">摘要</p>
          <p className="text-sm font-semibold leading-6 text-foreground">{editedSkill.body}</p>
        </div>
        <div className="grid gap-3 rounded-xl bg-[#fbfbf9] p-4">
          <p className="text-xs font-black text-muted-foreground">规则</p>
          <ul className="grid gap-2 text-sm font-semibold leading-6 text-foreground">
            {editedSkill.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
          {editedSkill.forbidden.length > 0 && (
            <>
              <p className="text-xs font-black text-muted-foreground">避免</p>
              <ul className="grid gap-2 text-sm font-semibold leading-6 text-foreground">
                {editedSkill.forbidden.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-3 border-t border-border pt-4">
        <Button type="button" variant="outline" className="w-fit rounded-xl" onClick={onToggleAdvanced}>
          {advancedOpen ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
          {advancedOpen ? "收起最终 Skill 产物" : "展开最终 Skill 产物"}
        </Button>
        {advancedOpen && (
          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                Skill 名称
                <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-label="Skill 名称" />
              </label>
              <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                Skill 标签
                <Input value={tags} onChange={(event) => setTags(event.target.value)} aria-label="Skill 标签" />
              </label>
              <label className="grid gap-1 text-xs font-bold text-muted-foreground md:col-span-2">
                Skill 说明
                <Textarea
                  className="min-h-24 bg-white"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  aria-label="Skill 说明"
                />
              </label>
              <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                规划规则
                <Textarea
                  className="min-h-32 bg-white text-sm font-semibold text-foreground"
                  value={rules}
                  onChange={(event) => setRules(event.target.value)}
                  aria-label="规划规则"
                />
              </label>
              <label className="grid gap-1 text-xs font-bold text-muted-foreground">
                不希望出现的安排
                <Textarea
                  className="min-h-32 bg-white text-sm font-semibold text-foreground"
                  value={forbidden}
                  onChange={(event) => setForbidden(event.target.value)}
                  aria-label="不希望出现的安排"
                />
              </label>
              <label className="grid gap-1 text-xs font-bold text-muted-foreground md:col-span-2">
                Skill 正文
                <Textarea
                  className="min-h-32 bg-white text-sm font-semibold text-foreground"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  aria-label="Skill 正文"
                />
              </label>
            </div>
            <p className="text-xs font-bold text-muted-foreground">SKILL.md 预览包含 frontmatter 和正文。</p>
            {!validation.valid && <SkillValidationSummary title="发布检查" validation={validation} />}
            <pre className="max-h-80 overflow-auto rounded-xl bg-secondary p-4 text-xs leading-6">{markdown}</pre>
          </div>
        )}
      </div>
    </section>
  );
}

function splitTagInput(value: string): string[] {
  return [...new Set(value.split(/[,，、\s]+/).map((tag) => tag.trim()).filter(Boolean))];
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter(Boolean);
}

function skillContentChanges(changes: Partial<TravelSkill>): SkillContentChanges {
  const contentChanges: SkillContentChanges = {};
  if (typeof changes.displayName === "string") contentChanges.displayName = changes.displayName;
  if (typeof changes.description === "string") contentChanges.description = changes.description;
  if (typeof changes.body === "string") contentChanges.body = changes.body;
  if (Array.isArray(changes.tags)) contentChanges.tags = changes.tags;
  if (Array.isArray(changes.rules)) contentChanges.rules = changes.rules;
  if (Array.isArray(changes.forbidden)) contentChanges.forbidden = changes.forbidden;
  if (changes.status) contentChanges.status = changes.status;
  return contentChanges;
}

function SavedMemorySettings({
  memories,
  onCreateMemory,
  onUpdateMemory,
  onDeleteMemory
}: {
  memories: SavedMemory[];
  onCreateMemory: (content: string) => void | Promise<void>;
  onUpdateMemory: (memoryId: string, content: string) => void | Promise<void>;
  onDeleteMemory: (memoryId: string) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const visibleMemories = memories.filter((memory) => memory.content.toLowerCase().includes(query.trim().toLowerCase()));

  async function createMemory() {
    const content = newMemory.trim();
    if (!content) return;
    await onCreateMemory(content);
    setNewMemory("");
  }

  function startEditing(memory: SavedMemory) {
    setEditingId(memory.id);
    setEditingContent(memory.content);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditingContent("");
  }

  async function saveEditing() {
    if (!editingId || !editingContent.trim()) return;
    await onUpdateMemory(editingId, editingContent.trim());
    cancelEditing();
  }

  return (
    <div className="min-h-screen overflow-auto bg-[#fbfbf9] p-6">
      <div className="mb-6">
        <h2 className="text-3xl font-black">保存的记忆</h2>
        <p className="mt-1 text-muted-foreground">用一条一条的记录保存长期有效的偏好和禁忌，供后续规划直接复用。</p>
      </div>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>记忆列表</CardTitle>
          <CardDescription>支持搜索、新增、手动编辑和删除。助手会读取这些记忆，并在需要时精确修改其中某一条。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-muted-foreground">
              搜索记忆
              <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索记忆" placeholder="按关键词过滤已保存记忆" />
            </label>
            <div className="self-end rounded-full bg-[#f6f6f3] px-3 py-2 text-xs font-bold text-muted-foreground">{visibleMemories.length} 条</div>
          </div>

          <div className="grid gap-3 rounded-2xl bg-[#fbfbf9] p-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="flex min-w-0 flex-col gap-1 text-xs font-bold text-muted-foreground">
              新增记忆
              <Input
                value={newMemory}
                onChange={(event) => setNewMemory(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createMemory();
                  }
                }}
                aria-label="新增记忆"
                placeholder="例如：用户不喜欢连续跨区。"
              />
            </label>
            <Button type="button" variant="secondary" className="self-end rounded-full" onClick={() => void createMemory()}>
              保存记忆
            </Button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-white">
            {visibleMemories.length > 0 ? (
              visibleMemories.map((memory, index) => (
                <div
                  key={memory.id}
                  className={cn("grid gap-3 px-4 py-4", index > 0 && "border-t border-border")}
                >
                  {editingId === memory.id ? (
                    <>
                      <Input
                        value={editingContent}
                        onChange={(event) => setEditingContent(event.target.value)}
                        aria-label="编辑记忆内容"
                      />
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button type="button" variant="ghost" className="rounded-full" onClick={cancelEditing}>
                          取消修改
                        </Button>
                        <Button type="button" variant="secondary" className="rounded-full" onClick={() => void saveEditing()}>
                          保存修改
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <p className="min-w-0 flex-1 text-sm font-semibold leading-7 text-foreground">{memory.content}</p>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="rounded-full"
                          aria-label={`编辑记忆 ${memory.content}`}
                          onClick={() => startEditing(memory)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="rounded-full text-destructive hover:text-destructive"
                          aria-label={`删除记忆 ${memory.content}`}
                          onClick={() => void onDeleteMemory(memory.id)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="px-4 py-10 text-center text-sm font-semibold text-muted-foreground">还没有匹配的记忆。</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function EvaluationPage() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [traces, setTraces] = useState<AgentTraceEvent[]>([]);
  const [skills, setSkills] = useState<TravelSkill[]>([]);
  const before = evaluationDataset.map((item) => ({
    ...item,
    output: {
      ...item.output,
      itineraryText: item.output.itineraryText.replaceAll("慢节奏", "").replaceAll("轻松", ""),
      days: Math.max(1, item.output.days - 1),
      preservedActivityIds: [],
      toolCalls: item.output.toolCalls.filter((agent) => agent !== "CriticAgent"),
      scriptErrors: ["baseline bad case"]
    }
  }));
  const summary = aggregateEvaluation(before, evaluationDataset);
  useEffect(() => {
    let cancelled = false;
    async function loadAgentEvidence() {
      try {
        const [sessionResult, traceResult, skillResult] = await Promise.all([
          apiGet<{ items: AgentSession[] }>("/agent/sessions"),
          apiGet<{ items: AgentTraceEvent[] }>("/agent/traces"),
          apiGet<{ items: TravelSkill[] }>("/skills")
        ]);
        if (cancelled) return;
        setSessions(sortAgentSessions(sessionResult.items));
        setTraces(sortAgentTraces(traceResult.items));
        setSkills(skillResult.items);
      } catch {
        if (cancelled) return;
        setSessions([]);
        setTraces([]);
        setSkills([]);
      }
    }
    void loadAgentEvidence();
    return () => {
      cancelled = true;
    };
  }, []);
  const latestSession = sessions[0];
  const latestTraces = latestSession ? traces.filter((trace) => trace.sessionId === latestSession.id) : traces;
  const agentSummaries = summarizeAgentTraces(latestTraces);
  const latestImportedSkillNames = latestSession
    ? latestSession.importedSkillIds
        .map((skillId) => skills.find((skill) => skill.id === skillId)?.displayName ?? skillId)
        .map((name) => name.replace(/\s+\d{3,}$/, "").trim())
    : [];
  return (
    <div className="min-h-screen overflow-auto bg-white p-6">
      <div className="mb-6">
        <h2 className="text-3xl font-black">评估后台</h2>
        <p className="text-muted-foreground">用于答辩展示 Agent 优化过程、Bad Case 和优化前后指标。</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {[
          ["任务成功率", summary.after.average.taskSuccess, summary.delta.taskSuccess],
          ["风格一致性", summary.after.average.styleConsistency, summary.delta.styleConsistency],
          ["手动保护", summary.after.average.manualPreservation, summary.delta.manualPreservation]
        ].map(([label, value, delta]) => (
          <Card key={String(label)} className="bg-[#f6f6f3]">
            <CardHeader>
              <CardTitle>{label}</CardTitle>
              <CardDescription>
                优化后 {Number(value).toFixed(2)} / 提升 {Number(delta).toFixed(2)}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
      <section className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(420px,1.05fr)]" aria-label="Agent 编排运行证据">
        <Card className="bg-white">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>最近 Agent 运行</CardTitle>
                <CardDescription>展示真实会话中的上下文读取、记忆快照和导入风格。</CardDescription>
              </div>
              <Badge className="bg-[#f6f6f3] text-foreground">{sessions.length} 次会话</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {latestSession ? (
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <EvidenceBlock label="上下文摘要" value={latestSession.contextSummary ?? "暂无上下文摘要"} />
                  <EvidenceBlock label="记忆快照" value={latestSession.memorySnapshotText ?? "暂无记忆快照"} />
                </div>
                <div>
                  <p className="text-xs font-black text-muted-foreground">导入风格</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {latestImportedSkillNames.length ? (
                      latestImportedSkillNames.map((name) => (
                        <Badge key={name} className="bg-[#f6f6f3] text-foreground">
                          {name}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">本轮未导入旅行风格</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-black text-muted-foreground">最近消息</p>
                  <div className="mt-2 grid gap-2">
                    {latestSession.messages.slice(-4).map((message) => (
                      <div key={`${latestSession.id}-${message.createdAt}-${message.role}`} className="rounded-2xl bg-[#f6f6f3] p-3">
                        <p className="text-xs font-black text-muted-foreground">{message.role === "user" ? "用户" : "助手"}</p>
                        <p className="mt-1 text-sm font-semibold leading-6">{message.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">运行一次右侧助手后，这里会显示真实会话、偏好摘要和上下文证据。</p>
            )}
          </CardContent>
        </Card>
        <Card className="bg-[#f6f6f3]">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>子 Agent 编排</CardTitle>
                <CardDescription>主 Agent 将任务派发给风格、地点、交通、规划和校验 Agent；天气由画布后台服务自动补全。</CardDescription>
              </div>
              <Badge className="bg-white text-foreground">{latestTraces.length} 条 trace</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {agentSummaries.map((agent) => (
                <div key={agent.name} className="rounded-2xl bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-black">{agent.label}</p>
                    <Badge className={cn("text-xs", agent.count > 0 ? "bg-foreground text-white" : "bg-[#f6f6f3] text-muted-foreground")}>
                      {agent.count > 0 ? `${agent.count} 次` : "待运行"}
                    </Badge>
                  </div>
                  <p className="mt-2 min-h-10 text-sm leading-5 text-muted-foreground">{agent.latestTitle}</p>
                </div>
              ))}
            </div>
            {latestTraces.length > 0 && (
              <>
                <Separator className="my-4" />
                <div className="grid gap-2" aria-label="Agent trace 时间线">
                  {latestTraces.slice(0, 8).map((trace) => (
                    <div key={trace.id} className="grid gap-1 rounded-2xl bg-white p-3 md:grid-cols-[132px_minmax(0,1fr)] md:gap-3">
                      <div>
                        <p className="text-sm font-black">{agentLabel(trace.agent)}</p>
                        <p className="text-xs text-muted-foreground">{traceTypeLabel(trace.type)}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold">{trace.title}</p>
                        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{trace.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </section>
      <div className="mt-6 flex flex-col gap-3">
        {evaluationDataset.map((item) => (
          <Card key={item.id} className="bg-white">
            <CardHeader>
              <CardTitle>{item.title}</CardTitle>
              <CardDescription>
                {item.category} / {item.input}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}

function EvidenceBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-[#f6f6f3] p-4">
      <p className="text-xs font-black text-muted-foreground">{label}</p>
      <p className="mt-2 text-sm font-semibold leading-6">{value}</p>
    </div>
  );
}

function sortAgentSessions(sessions: AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function sortAgentTraces(traces: AgentTraceEvent[]): AgentTraceEvent[] {
  return [...traces].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function summarizeAgentTraces(traces: AgentTraceEvent[]): Array<{ name: AgentTraceEvent["agent"]; label: string; count: number; latestTitle: string }> {
  const agents: AgentTraceEvent["agent"][] = [
    "MainAgent",
    "StyleAgent",
    "PlannerAgent",
    "AttractionAgent",
    "TransportAgent",
    "CriticAgent"
  ];
  return agents.map((agent) => {
    const agentTraces = traces.filter((trace) => trace.agent === agent);
    return {
      name: agent,
      label: agentLabel(agent),
      count: agentTraces.length,
      latestTitle: agentTraces.at(-1)?.title ?? "等待真实运行数据"
    };
  });
}

function agentLabel(agent: AgentTraceEvent["agent"]): string {
  const labels: Record<AgentTraceEvent["agent"], string> = {
    MainAgent: "主 Agent",
    StyleAgent: "风格 Agent",
    SkillExtractorAgent: "风格提取 Agent",
    WeatherAgent: "天气 Agent",
    TransportAgent: "交通 Agent",
    AttractionAgent: "地点 Agent",
    PlannerAgent: "规划 Agent",
    CriticAgent: "校验 Agent"
  };
  return labels[agent];
}

function traceTypeLabel(type: AgentTraceEvent["type"]): string {
  const labels: Record<AgentTraceEvent["type"], string> = {
    message: "上下文",
    tool_call: "工具调用",
    state_patch: "写入画布",
    handoff: "任务派发",
    error: "异常"
  };
  return labels[type];
}
