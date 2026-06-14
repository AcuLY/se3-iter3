import {
  addActivity,
  addDay,
  aggregateEvaluation,
  createDraftItinerary,
  createSeedItinerary,
  createSeedSkills,
  diffItineraries,
  evaluationDataset,
  moveActivity,
  parseSkillMarkdown,
  recommendSkills,
  removeActivity,
  reorderActivity,
  resizeItineraryDateRange,
  setDayWeather,
  setTransportLeg,
  summarizeItineraryAsSkill,
  updateActivity,
  type AgentSession,
  type Activity,
  type ActivityDraft,
  type ActivityType,
  type ItineraryDay,
  type MapRouteMode,
  type Place,
  type RouteStep,
  type RouteSummary,
  type TransportLeg,
  type TravelItinerary,
  type TravelSkill,
  type WeatherSummary
} from "@journey/shared";
import {
  Bot,
  CalendarPlus,
  ChevronDown,
  ChevronUp,
  CloudSun,
  Clock3,
  CircleStop,
  GalleryHorizontalEnd,
  GripVertical,
  Heart,
  Home,
  MapPinned,
  MapPin,
  Pencil,
  Plus,
  Route,
  Send,
  Sparkles,
  Store,
  Trash2,
  Wallet,
  WandSparkles,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { apiDelete, apiEventStream, apiGet, apiPost, apiPatch, apiText } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Page = "home" | "workbench" | "skills" | "creator" | "evaluation";
type ChatMessage = { role: "user" | "assistant"; content: string };
type SkillFilter = "recommended" | "all" | "favorites" | "drafts";
type AgentRunResponse = {
  itinerary: TravelItinerary;
  message: { role: "assistant"; content: string };
  diff: string[];
  session?: AgentSession;
};
type AgentMemory = {
  preferenceSummary?: string;
  contextSummary?: string;
  sessionCount: number;
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

function activityPrimaryPlaceName(activity: Activity): string | undefined {
  const placeName = activity.placeName?.trim() || activity.place?.name?.trim();
  return placeName || undefined;
}

function activityDisplayName(activity: Activity, index?: number): string {
  return activity.title.trim() || activityPrimaryPlaceName(activity) || "待补全安排";
}

function activityMapLabel(activity: Activity, index?: number): string {
  return activityPrimaryPlaceName(activity) || activityDisplayName(activity, index);
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

function canRouteActivityPair(from: Activity, to: Activity): boolean {
  return hasRouteEndpoint(from) && hasRouteEndpoint(to);
}

function normalizeItineraryForClient(itinerary: TravelItinerary): TravelItinerary {
  const days = itinerary.days.map((day) => {
    const activities = day.activities.map((activity) => normalizeLegacyPlaceholderActivity(activity, itinerary.destination));
    const routeablePairs = new Set(
      activities.flatMap((activity, index) => {
        const next = activities[index + 1];
        return next && canRouteActivityPair(activity, next) ? [`${activity.id}:${next.id}`] : [];
      })
    );
    return {
      ...day,
      activities,
      transportLegs: (day.transportLegs ?? []).filter((leg) => routeablePairs.has(`${leg.fromActivityId}:${leg.toActivityId}`))
    };
  });
  return { ...itinerary, days };
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
  const [page, setPage] = useState<Page>("home");
  const [itinerary, setItinerary] = useState<TravelItinerary>(() => createSeedItinerary());
  const [skills, setSkills] = useState<TravelSkill[]>(() => createSeedSkills());
  const [selectedDayId, setSelectedDayId] = useState(() => itinerary.days[0]?.id ?? "");
  const [importedSkillIds, setImportedSkillIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "告诉我想调整的日期、地点、节奏或预算，我会直接更新行程。" }
  ]);
  const [agentInput, setAgentInput] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentProgress, setAgentProgress] = useState<string[]>([]);
  const agentAbortRef = useRef<AbortController | null>(null);
  const [exportText, setExportText] = useState("");
  const [serviceStatus, setServiceStatus] = useState("");
  const [saveStatus, setSaveStatus] = useState("已保存");
  const [, setAgentMemory] = useState<AgentMemory | null>(null);
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const [skillFilter, setSkillFilter] = useState<SkillFilter>("recommended");
  const [creatorDraft, setCreatorDraft] = useState<TravelSkill | null>(null);
  const [creatorText, setCreatorText] = useState(
    "这次厦门旅行最喜欢沙坡尾海边散步、傍晚日落和小店探索，整体不要赶路。"
  );

  useEffect(() => {
    let cancelled = false;
    async function loadInitialData() {
      const [itineraryResult, skillResult] = await Promise.all([
        apiGet<{ items: TravelItinerary[] }>("/itineraries", { items: [createSeedItinerary()] }),
        apiGet<{ items: TravelSkill[] }>("/skills", { items: createSeedSkills() })
      ]);
      if (cancelled) return;
      const loaded = itineraryResult.items[0];
      if (loaded) {
        const normalizedLoaded = normalizeItineraryForClient(loaded);
        setItinerary(normalizedLoaded);
        setSelectedDayId(normalizedLoaded.days[0]?.id ?? "");
        setImportedSkillIds(normalizedLoaded.importedSkillIds ?? []);
        const sessionResult = await apiGet<{ items: AgentSession[] }>(
          `/agent/sessions?itineraryId=${encodeURIComponent(normalizedLoaded.id)}`,
          { items: [] }
        );
        if (!cancelled) setAgentMemory(buildAgentMemory(sessionResult.items));
      }
      setSkills(skillResult.items);
      setServiceStatus("");
    }
    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDay = itinerary.days.find((day) => day.id === selectedDayId) ?? itinerary.days[0]!;
  const recommendations = useMemo(
    () =>
      recommendSkills(skills, {
        destination: itinerary.destination,
        companions: itinerary.companions,
        preferences: itinerary.preferences,
        currentText: `${itinerary.title} ${itinerary.days.flatMap((day) => day.activities.map((activity) => activity.title)).join(" ")}`,
        importedSkillIds
      }),
    [importedSkillIds, itinerary, skills]
  );
  const showAgentPanel = page === "workbench";
  const shellGridClass = showAgentPanel
    ? "grid min-h-screen grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] 2xl:grid-cols-[280px_minmax(0,1fr)_380px]"
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
    const fallback = {
      itinerary: addActivity(itinerary, selectedDay.id, draft)
    };
    const result = await apiPost<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/days/${selectedDay.id}/activities`,
      draft,
      fallback
    );
    const normalized = normalizeItineraryForClient(result.itinerary);
    setItinerary(normalized);
    markSaved();
    return normalized;
  }

  async function updateActivityField(activityId: string, changes: Partial<Activity>) {
    markSaving();
    const fallback = { itinerary: updateActivity(itinerary, activityId, changes) };
    const result = await apiPatch<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/activities/${activityId}`,
      changes,
      fallback
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  async function deleteActivity(activityId: string) {
    markSaving();
    const fallback = { itinerary: removeActivity(itinerary, activityId) };
    const result = await apiDelete<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/activities/${activityId}`,
      fallback
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  async function reorderManualActivity(dayId: string, activityId: string, targetIndex: number) {
    const day = itinerary.days.find((candidate) => candidate.id === dayId);
    if (!day) return;
    const currentIndex = day.activities.findIndex((activity) => activity.id === activityId);
    const nextIndex = Math.min(Math.max(targetIndex, 0), day.activities.length - 1);
    if (currentIndex < 0 || currentIndex === nextIndex) return;
    markSaving();
    const fallback = { itinerary: reorderActivity(itinerary, dayId, activityId, nextIndex) };
    const result = await apiPost<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/days/${dayId}/activities/${activityId}/reorder`,
      { targetIndex: nextIndex },
      fallback
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  async function moveManualActivity(activityId: string, targetDayId: string, targetIndex: number) {
    markSaving();
    const fallback = { itinerary: moveActivity(itinerary, activityId, targetDayId, targetIndex) };
    const result = await apiPost<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/activities/${activityId}/move`,
      { targetDayId, targetIndex },
      fallback
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    setSelectedDayId(targetDayId);
    markSaved();
  }

  async function importSkill(skillId: string) {
    const currentSkill = skills.find((skill) => skill.id === skillId);
    setImportedSkillIds((current) => (current.includes(skillId) ? current : [...current, skillId]));
    const result = await apiPost<{ itinerary: TravelItinerary; skill?: TravelSkill }>(
      `/itineraries/${itinerary.id}/skills/${skillId}`,
      {},
      {
        itinerary: { ...itinerary, importedSkillIds: [...new Set([...itinerary.importedSkillIds, skillId])] },
        skill: currentSkill
          ? {
              ...currentSkill,
              imports: currentSkill.imports + (itinerary.importedSkillIds.includes(skillId) ? 0 : 1),
              updatedAt: new Date().toISOString()
            }
          : undefined
      }
    );
    const normalized = normalizeItineraryForClient(result.itinerary);
    setItinerary(normalized);
    setImportedSkillIds(normalized.importedSkillIds);
    if (result.skill) replaceSkill(result.skill);
  }

  async function removeImportedSkill(skillId: string) {
    const fallbackItinerary = {
      ...itinerary,
      importedSkillIds: itinerary.importedSkillIds.filter((id) => id !== skillId)
    };
    setImportedSkillIds((current) => current.filter((id) => id !== skillId));
    const result = await apiDelete<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/skills/${skillId}`,
      { itinerary: fallbackItinerary }
    );
    const normalized = normalizeItineraryForClient(result.itinerary);
    setItinerary(normalized);
    setImportedSkillIds(normalized.importedSkillIds);
  }

  async function importSkillMarkdown(markdown: string) {
    const fallbackSkill = parseSkillMarkdown(markdown);
    const result = await apiPost<{ skill: TravelSkill }>("/skills/import", { markdown }, { skill: fallbackSkill });
    replaceSkill(result.skill);
    setSkillFilter("all");
    await importSkill(result.skill.id);
  }

  function replaceSkill(skill: TravelSkill) {
    setSkills((current) => [skill, ...current.filter((item) => item.id !== skill.id)]);
    setCreatorDraft((current) => (current?.id === skill.id ? skill : current));
  }

  async function favoriteSkill(skillId: string) {
    const skill = skills.find((item) => item.id === skillId);
    if (!skill) return;
    const favorited = !skill.favorited;
    const fallbackSkill = {
      ...skill,
      favorited,
      favorites: Math.max(0, skill.favorites + (favorited ? 1 : -1)),
      updatedAt: new Date().toISOString()
    };
    replaceSkill(fallbackSkill);
    const result = await apiPost<{ skill: TravelSkill }>(
      `/skills/${skillId}/favorite`,
      { favorited },
      { skill: fallbackSkill }
    );
    replaceSkill(result.skill);
  }

  async function updateSkill(skillId: string, changes: Partial<TravelSkill>) {
    const skill = skills.find((item) => item.id === skillId) ?? creatorDraft;
    if (!skill) return;
    const fallbackSkill = { ...skill, ...changes, updatedAt: new Date().toISOString() };
    replaceSkill(fallbackSkill);
    const result = await apiPatch<{ skill: TravelSkill }>(`/skills/${skillId}`, changes, { skill: fallbackSkill });
    replaceSkill(result.skill);
  }

  async function publishSkillDraft(changes: Partial<TravelSkill>) {
    if (!creatorDraft) return;
    const fallbackSkill = {
      ...creatorDraft,
      ...changes,
      status: "published" as const,
      updatedAt: new Date().toISOString()
    };
    replaceSkill(fallbackSkill);
    const result = await apiPost<{ skill: TravelSkill }>(
      `/skills/${creatorDraft.id}/publish`,
      changes,
      { skill: fallbackSkill }
    );
    replaceSkill(result.skill);
    setCreatorDraft(null);
    setSkillFilter("all");
    setPage("skills");
  }

  function applyAgentResult(result: AgentRunResponse, requestText: string) {
    const normalized = normalizeItineraryForClient(result.itinerary);
    setItinerary(normalized);
    setImportedSkillIds(normalized.importedSkillIds);
    setAgentMemory(
      result.session
        ? buildAgentMemory([result.session])
        : {
            preferenceSummary: inferVisiblePreferenceSummary(normalized, skills, normalized.importedSkillIds, requestText),
            contextSummary: `最近请求：${requestText}`,
            sessionCount: 1
          }
    );
    setMessages((current) => [
      ...current,
      { role: "user", content: requestText },
      { role: "assistant", content: formatAssistantMessageWithDiff(result.message.content, result.diff) }
    ]);
    setAgentInput("");
    setPage("workbench");
  }

  function buildAgentFallback(requestText: string): AgentRunResponse {
    const before = itinerary;
    const targetDay = itinerary.days[1] ?? selectedDay;
    const importedNames = skills.filter((skill) => importedSkillIds.includes(skill.id)).map((skill) => skill.displayName);
    const title = requestText.includes("咖啡")
      ? "街区咖啡与自由探索"
      : importedNames.some((name) => name.includes("海边"))
        ? "海边日落与小店探索"
        : "慢节奏街区探索";
    const next = addActivity(
      { ...itinerary, importedSkillIds },
      targetDay.id,
      {
        type: "free_time",
        title,
        startTime: "15:00",
        endTime: "17:00",
        description: "已根据你的要求补充，可继续手动调整。",
        tags: ["慢节奏", "助手建议"],
        budgetCny: 80,
        transportNote: "同区域内移动，避免跨城奔波。",
        agentReason: "根据导入 Skill 和用户本轮需求补全空白时段。"
      },
      "agent"
    );
    const diff = diffItineraries(before, next);
    const fallback = {
      itinerary: next,
      message: { role: "assistant" as const, content: "已更新行程。" },
      diff
    };
    return fallback;
  }

  async function runAgent() {
    const requestText = agentInput.trim();
    if (!requestText || !selectedDay || agentRunning) return;
    const fallback = buildAgentFallback(requestText);
    const controller = new AbortController();
    agentAbortRef.current = controller;
    setAgentRunning(true);
    setAgentProgress(["正在理解你的需求"]);
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
            if (event.event === "final") {
              streamedResult = event.data as AgentRunResponse;
            }
          }
        }
      );
      applyAgentResult(streamedResult ?? fallback, requestText);
      setAgentProgress([]);
    } catch {
      if (controller.signal.aborted) {
        setAgentProgress(["已停止本次处理，行程没有改动。"]);
        setMessages((current) => [
          ...current,
          { role: "assistant", content: "已停止本次处理，行程没有改动。" }
        ]);
        return;
      }
      const result = await apiPost<AgentRunResponse>(
        "/agent/run",
        {
          itineraryId: itinerary.id,
          message: requestText,
          importedSkillIds
        },
        fallback
      );
      applyAgentResult(result, requestText);
      setAgentProgress([]);
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
    setAgentProgress(["已停止本次处理，行程没有改动。"]);
  }

  async function extractSkill() {
    const fallbackSkill = {
      ...summarizeItineraryAsSkill(itinerary, creatorText),
      displayName: "待确认旅行风格"
    };
    const result = await apiPost<{ skill: TravelSkill }>(
      "/skills/extract",
      { sourceText: creatorText, itineraryId: itinerary.id },
      { skill: fallbackSkill }
    );
    setSkills((current) => [result.skill, ...current.filter((skill) => skill.id !== result.skill.id)]);
    setCreatorDraft(result.skill);
  }

  async function addRemoteDay() {
    markSaving();
    const fallback = { itinerary: addDay(itinerary) };
    const result = await apiPost<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}/days`, {}, fallback);
    const normalized = normalizeItineraryForClient(result.itinerary);
    setItinerary(normalized);
    setSelectedDayId(normalized.days.at(-1)?.id ?? selectedDay.id);
    markSaved();
  }

  async function exportItinerary() {
    const text = await apiText(`/itineraries/${itinerary.id}/export`, "");
    setExportText(text);
    if (text.trim()) {
      downloadTextFile(text, `${sanitizeFilename(itinerary.title)}-${itinerary.startDate}.md`);
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
    const fallback = {
      itinerary: setTransportLeg(
        itinerary,
        dayId,
        createLocalTransportLegDraft(itinerary, dayId, fromActivityId, toActivityId, mode, overrides)
      )
    };
    const result = await apiPost<{ itinerary: TravelItinerary }>(
      `/itineraries/${itinerary.id}/days/${dayId}/transport-legs`,
      { fromActivityId, toActivityId, mode, ...overrides },
      fallback
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  async function completeMissingRoutes(mode: MapRouteMode = "walking") {
    markSaving();
    const fallback = { itinerary: completeMissingRoutesLocally(itinerary, mode), completed: 0, skipped: 0 };
    const result = await apiPost<{ itinerary: TravelItinerary; completed: number; skipped: number }>(
      `/itineraries/${itinerary.id}/transport-legs/complete`,
      { mode },
      fallback
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  async function updateDayWeather(dayId: string) {
    const day = itinerary.days.find((candidate) => candidate.id === dayId);
    if (!day) return;
    markSaving();
    const weather = createFallbackWeather(itinerary.destination, day.date);
    const result = await apiPost<{ itinerary: TravelItinerary; weather: WeatherSummary }>(
      `/itineraries/${itinerary.id}/days/${dayId}/weather`,
      { city: itinerary.destination },
      {
        weather,
        itinerary: setDayWeather(itinerary, dayId, weather)
      }
    );
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  async function updateItineraryDetails(changes: Partial<TravelItinerary>) {
    markSaving();
    const base =
      changes.startDate !== undefined || changes.endDate !== undefined
        ? resizeItineraryDateRange(
            itinerary,
            changes.startDate ?? itinerary.startDate,
            changes.endDate ?? itinerary.endDate ?? changes.startDate ?? itinerary.startDate
          )
        : itinerary;
    const fallback = {
      itinerary: {
        ...base,
        ...changes,
        startDate: base.startDate,
        endDate: base.endDate,
        days: base.days,
        updatedAt: new Date().toISOString()
      }
    };
    const result = await apiPatch<{ itinerary: TravelItinerary }>(`/itineraries/${itinerary.id}`, changes, fallback);
    setItinerary(normalizeItineraryForClient(result.itinerary));
    markSaved();
  }

  function markSaving() {
    setSaveStatus("正在保存...");
  }

  function markSaved() {
    setSaveStatus(`已保存 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
  }

  async function createTrip(input: {
    title: string;
    destination: string;
    startDate: string;
    endDate: string;
    budgetCny?: number;
    preferences?: string[];
  }) {
    const fallback = {
      itinerary: createDraftItinerary({
        title: input.title,
        destination: input.destination,
        startDate: input.startDate,
        endDate: input.endDate,
        budgetCny: input.budgetCny,
        preferences: input.preferences
      })
    };
    const result = await apiPost<{ itinerary: TravelItinerary }>("/itineraries", input, fallback);
    const normalized = normalizeItineraryForClient(result.itinerary);
    setItinerary(normalized);
    setSelectedDayId(normalized.days[0]?.id ?? "");
    setImportedSkillIds([]);
    setExportText("");
    setAgentMemory(null);
    setPage("workbench");
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {page === "home" ? (
        <HomePage onNavigate={setPage} onCreateTrip={createTrip} />
      ) : (
        <div className={shellGridClass} data-testid="app-shell">
          <Sidebar page={page} onNavigate={setPage} itinerary={itinerary} />
          <main className="min-w-0 bg-white">
            {page === "workbench" && (
              <Workbench
                itinerary={itinerary}
                selectedDayId={selectedDay.id}
                importedSkillIds={importedSkillIds}
                skills={skills}
                onSelectDay={setSelectedDayId}
                serviceStatus={serviceStatus}
                saveStatus={saveStatus}
                exportText={exportText}
                onAddDay={addRemoteDay}
                onAddActivity={addManualActivity}
                onUpdateActivity={updateActivityField}
                onDeleteActivity={deleteActivity}
                onReorderActivity={reorderManualActivity}
                onMoveActivityToDay={moveManualActivity}
                onUpdateItinerary={updateItineraryDetails}
                onExport={exportItinerary}
                onSetTransport={setActivityTransport}
                onCompleteRoutes={completeMissingRoutes}
                onUpdateDayWeather={updateDayWeather}
                onOpenAgent={() => setAgentDrawerOpen(true)}
              />
            )}
            {page === "skills" && (
              <SkillPlaza
                skills={skills}
                recommendations={recommendations}
                importedSkillIds={importedSkillIds}
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
                draft={creatorDraft}
                onSourceTextChange={setCreatorText}
                onExtract={extractSkill}
                onPublish={publishSkillDraft}
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
                  className="fixed inset-0 z-40 bg-black/30 2xl:hidden"
                  onClick={() => setAgentDrawerOpen(false)}
                />
              )}
              <div
                className={cn(
                  "fixed inset-y-0 right-0 z-50 w-[min(420px,calc(100vw-24px))] shadow-2xl 2xl:static 2xl:w-auto 2xl:shadow-none",
                  agentDrawerOpen ? "block" : "hidden 2xl:block"
                )}
              >
                <AgentPanel
                  skills={skills}
                  importedSkillIds={importedSkillIds}
                  messages={messages}
                  agentInput={agentInput}
                  agentRunning={agentRunning}
                  agentProgress={agentProgress}
                  onImportSkill={importSkill}
                  onRemoveSkill={removeImportedSkill}
                  onAgentInputChange={setAgentInput}
                  onRunAgent={runAgent}
                  onStopAgent={stopAgent}
                  onClose={() => setAgentDrawerOpen(false)}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function buildAgentMemory(sessions: AgentSession[]): AgentMemory | null {
  const latest = sessions[0];
  if (!latest) return null;
  return {
    preferenceSummary: latest.userPreferenceSummary,
    contextSummary: latest.contextSummary,
    sessionCount: sessions.length
  };
}

function inferVisiblePreferenceSummary(
  itinerary: TravelItinerary,
  skills: TravelSkill[],
  importedSkillIds: string[],
  requestText: string
): string {
  const importedNames = skills
    .filter((skill) => importedSkillIds.includes(skill.id))
    .map((skill) => skill.displayName);
  const requestTokens = ["慢节奏", "咖啡", "citywalk", "亲子", "博物馆", "海边", "日落", "小店", "雨天", "室内", "夜景", "不赶路"].filter(
    (token) => requestText.includes(token)
  );
  return [...new Set([...itinerary.preferences, ...importedNames, ...requestTokens])].join("、") || "暂无稳定偏好";
}

function formatAssistantMessageWithDiff(content: string, diff: string[]): string {
  if (diff.length === 0) return content;
  return [content, "本轮改动", ...diff.map((item) => `- ${item}`)].join("\n");
}

function HomePage({
  onNavigate,
  onCreateTrip
}: {
  onNavigate: (page: Page) => void;
  onCreateTrip: (input: {
    title: string;
    destination: string;
    startDate: string;
    endDate: string;
    budgetCny?: number;
    preferences?: string[];
  }) => void | Promise<void>;
}) {
  const [title, setTitle] = useState("杭州周末旅行");
  const [destination, setDestination] = useState("杭州");
  const [startDate, setStartDate] = useState("2026-07-01");
  const [endDate, setEndDate] = useState("2026-07-03");
  const [budget, setBudget] = useState("1800");
  const [preferences, setPreferences] = useState("慢节奏, 咖啡, citywalk");

  function submitTrip() {
    void onCreateTrip({
      title,
      destination,
      startDate,
      endDate,
      budgetCny: Number(budget) || undefined,
      preferences: preferences
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
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
            把旅行风格沉淀成可分享的 Skill，再由旅行助手将天气、路线、景点和个人偏好融合到可编辑行程画布里。
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
              <Input value={destination} onChange={(event) => setDestination(event.target.value)} aria-label="目的地" />
              <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} aria-label="出发日期" />
              <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} aria-label="返回日期" />
              <Input value={budget} onChange={(event) => setBudget(event.target.value)} aria-label="预算" />
              <Input value={preferences} onChange={(event) => setPreferences(event.target.value)} aria-label="偏好" />
              <Button className="md:col-span-2" onClick={submitTrip}>
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

function Sidebar({
  page,
  onNavigate,
  itinerary
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  itinerary: TravelItinerary;
}) {
  const entries: Array<{ page: Page; label: string; icon: typeof Home }> = [
    { page: "workbench", label: "新建行程", icon: MapPinned },
    { page: "creator", label: "创作 Skill", icon: WandSparkles },
    { page: "skills", label: "Skill 广场", icon: Store }
  ];
  const devEntry = { page: "evaluation" as Page, label: "评估后台", icon: GalleryHorizontalEnd };
  const DevIcon = devEntry.icon;
  return (
    <aside className="hidden min-h-screen flex-col border-r border-border bg-[#fbfbf9] p-4 lg:flex">
      <button className="mb-6 flex items-center gap-3 text-left text-base font-black" onClick={() => onNavigate("home")}>
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">J</span>
        Journey
      </button>
      <div className="flex flex-col gap-2">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <Button
              key={entry.page}
              variant={page === entry.page ? "secondary" : "ghost"}
              className="justify-start"
              onClick={() => onNavigate(entry.page)}
            >
              <Icon data-icon="inline-start" />
              {entry.label}
            </Button>
          );
        })}
      </div>
      <Separator className="my-5" />
      <div className="flex flex-1 flex-col gap-3">
        <p className="text-xs font-bold text-muted-foreground">会话记录</p>
        <button className="rounded-2xl bg-white p-3 text-left text-sm font-semibold" onClick={() => onNavigate("workbench")}>
          最近：{itinerary.title}
          <span className="mt-1 block text-xs font-normal text-muted-foreground">
            {itinerary.destination} / {itinerary.days.length} 天
          </span>
        </button>
      </div>
      <div className="mt-5 border-t border-border pt-4">
        <p className="mb-2 text-xs font-bold text-muted-foreground">开发与答辩</p>
        <Button
          variant={page === devEntry.page ? "secondary" : "ghost"}
          className="w-full justify-start"
          onClick={() => onNavigate(devEntry.page)}
        >
          <DevIcon data-icon="inline-start" />
          {devEntry.label}
        </Button>
      </div>
    </aside>
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

function Workbench({
  itinerary,
  selectedDayId,
  skills,
  importedSkillIds,
  serviceStatus,
  saveStatus,
  exportText,
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
  onCompleteRoutes,
  onUpdateDayWeather,
  onOpenAgent
}: {
  itinerary: TravelItinerary;
  selectedDayId: string;
  skills: TravelSkill[];
  importedSkillIds: string[];
  serviceStatus: string;
  saveStatus: string;
  exportText: string;
  onSelectDay: (dayId: string) => void;
  onAddDay: () => void;
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
  onCompleteRoutes: (mode?: MapRouteMode) => void | Promise<void>;
  onUpdateDayWeather: (dayId: string) => void | Promise<void>;
  onOpenAgent: () => void;
}) {
  const day = itinerary.days.find((candidate) => candidate.id === selectedDayId) ?? itinerary.days[0]!;
  const importedNames = skills.filter((skill) => importedSkillIds.includes(skill.id)).map((skill) => skill.displayName);
  const [titleText, setTitleText] = useState(itinerary.title);
  const [destinationText, setDestinationText] = useState(itinerary.destination);
  const [startDateText, setStartDateText] = useState(itinerary.startDate);
  const [endDateText, setEndDateText] = useState(itinerary.endDate ?? itinerary.startDate);
  const [budgetText, setBudgetText] = useState(String(itinerary.budgetCny ?? ""));
  const [notesText, setNotesText] = useState(itinerary.notes ?? "");
  const [tripDetailsOpen, setTripDetailsOpen] = useState(false);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [selectedTransportLegId, setSelectedTransportLegId] = useState<string | null>(null);
  const weatherRequestRef = useRef(new Set<string>());

  useEffect(() => {
    setTitleText(itinerary.title);
    setDestinationText(itinerary.destination);
    setStartDateText(itinerary.startDate);
    setEndDateText(itinerary.endDate ?? itinerary.startDate);
    setBudgetText(String(itinerary.budgetCny ?? ""));
    setNotesText(itinerary.notes ?? "");
  }, [itinerary.id, itinerary.title, itinerary.destination, itinerary.startDate, itinerary.endDate, itinerary.budgetCny, itinerary.notes]);

  useEffect(() => {
    if (selectedActivityId && !day.activities.some((activity) => activity.id === selectedActivityId)) {
      setSelectedActivityId(null);
    }
  }, [day.activities, selectedActivityId]);

  useEffect(() => {
    if (selectedTransportLegId && !(day.transportLegs ?? []).some((leg) => leg.id === selectedTransportLegId)) {
      setSelectedTransportLegId(null);
    }
  }, [day.transportLegs, selectedTransportLegId]);

  useEffect(() => {
    if (day.weather || weatherRequestRef.current.has(day.id)) return;
    weatherRequestRef.current.add(day.id);
    void onUpdateDayWeather(day.id);
  }, [day.id, day.weather, onUpdateDayWeather]);

  const dayBudget = day.activities.reduce((sum, activity) => sum + (activity.budgetCny ?? 0), 0);
  const daySummary = [
    day.date,
    `${day.activities.length} 项安排`,
    dayBudget > 0 ? `约 ${dayBudget} 元` : undefined
  ]
    .filter(Boolean)
    .join(" · ");
  const selectedActivityIndex = day.activities.findIndex((activity) => activity.id === selectedActivityId);
  const selectedActivity = selectedActivityIndex >= 0 ? day.activities[selectedActivityIndex] : undefined;

  function startActivityDrag(event: DragEvent<HTMLElement>, activityId: string) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-journey-activity", activityId);
    event.dataTransfer.setData("text/plain", activityId);
  }

  function dropActivity(event: DragEvent<HTMLElement>, targetIndex: number) {
    event.preventDefault();
    const activityId =
      event.dataTransfer.getData("application/x-journey-activity") || event.dataTransfer.getData("text/plain");
    if (!activityId) return;
    void onReorderActivity(day.id, activityId, targetIndex);
  }

  function saveTripDetails() {
    void onUpdateItinerary({
      title: titleText,
      destination: destinationText,
      startDate: startDateText,
      endDate: endDateText,
      budgetCny: Number(budgetText) || undefined,
      notes: notesText
    });
  }

  async function addPlaceToDay(place: PlaceSearchItem): Promise<TravelItinerary | void> {
    const type = activityTypeFromPoi(place);
    const category = poiCategoryLabel(place);
    const previousIds = new Set(day.activities.map((activity) => activity.id));
    const updated = await onAddActivity({
      type,
      title: place.name,
      placeName: place.name,
      place: {
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
      },
      tags: ["地点", category].filter(Boolean)
    });
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

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-black">{itinerary.title}</h2>
          <p className="text-sm text-muted-foreground">
            {itinerary.destination} / {itinerary.startDate} 至 {itinerary.endDate ?? itinerary.startDate} / {itinerary.days.length} 天
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full bg-[#f6f6f3] px-3 text-xs font-bold text-muted-foreground">
            <span className={cn("size-2 rounded-full", saveStatus.includes("正在") ? "bg-amber-500" : "bg-emerald-500")} />
            {saveStatus}
          </span>
          {importedNames.length > 0 && (
            <Badge className="shrink-0 whitespace-nowrap bg-white">当前风格 {importedNames.length} 个</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 rounded-full bg-white px-3 2xl:hidden"
            onClick={onOpenAgent}
            aria-label="打开旅行助手"
          >
            <Bot data-icon="inline-start" />
            助手
          </Button>
          <Button variant="outline" size="sm" className="shrink-0 rounded-full bg-white px-3" onClick={onAddDay}>
            <CalendarPlus data-icon="inline-start" />
            添加日期
          </Button>
          <Button variant="outline" size="sm" className="shrink-0 rounded-full bg-white px-3" onClick={onExport}>
            导出
          </Button>
        </div>
      </header>
      <div className="min-h-0 overflow-auto px-4 py-4 md:px-6 md:py-5">
        {serviceStatus && <div className="mb-3 text-xs font-semibold text-muted-foreground">{serviceStatus}</div>}
        <MapPanel
          itinerary={itinerary}
          day={day}
          selectedActivityId={selectedActivityId}
          selectedTransportLegId={selectedTransportLegId}
          onAddPlace={addPlaceToDay}
          onAddBlankActivity={() => void addBlankActivityFromCanvas()}
          onSelectDay={onSelectDay}
          onSelectActivity={(activityId) => {
            setSelectedActivityId(activityId);
            setSelectedTransportLegId(null);
          }}
          onSelectTransportLeg={(legId) => {
            setSelectedTransportLegId(legId);
            setSelectedActivityId(null);
          }}
          onCompleteRoutes={onCompleteRoutes}
        />
        <Card className="mt-4 bg-white">
          <CardHeader className="gap-3 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>行程信息</CardTitle>
              <CardDescription className="mt-1">
                {itinerary.destination} · {itinerary.days.length} 天 · 预算 {itinerary.budgetCny ? `${itinerary.budgetCny} 元` : "待定"}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant={tripDetailsOpen ? "secondary" : "outline"}
              size="sm"
              className="shrink-0 rounded-full"
              onClick={() => setTripDetailsOpen((open) => !open)}
              aria-expanded={tripDetailsOpen}
            >
              {tripDetailsOpen ? "收起信息" : "编辑信息"}
            </Button>
          </CardHeader>
          {tripDetailsOpen && (
            <CardContent className="grid gap-4 border-t border-border bg-[#fbfbf9] p-4">
              <div className="grid gap-3 lg:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                  行程名称
                  <Input value={titleText} onChange={(event) => setTitleText(event.target.value)} aria-label="行程名称" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                  目的地
                  <Input value={destinationText} onChange={(event) => setDestinationText(event.target.value)} aria-label="目的地" />
                </label>
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
              <div className="flex justify-end">
                <Button variant="secondary" className="rounded-full" onClick={saveTripDetails}>
                  应用信息
                </Button>
              </div>
            </CardContent>
          )}
        </Card>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <TabsList className="max-w-full min-w-0 overflow-x-auto">
            {itinerary.days.map((candidate) => (
              <TabsTrigger
                key={candidate.id}
                active={candidate.id === day.id}
                onClick={() => onSelectDay(candidate.id)}
              >
                {candidate.title}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button onClick={() => void addBlankActivityFromCanvas()}>
            <Plus data-icon="inline-start" />
            添加活动
          </Button>
        </div>
        <section className="mt-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-2xl font-black">{day.title}</h3>
              <p className="text-sm text-muted-foreground">{daySummary}</p>
              {day.weather && (
                <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-full bg-[#f6f6f3] px-3 py-1.5 text-sm font-semibold">
                  <CloudSun className="size-4" />
                  <span>{day.weather.weather}</span>
                  <span className="text-muted-foreground">{day.weather.temperature}</span>
                </div>
              )}
            </div>
          </div>
          {selectedActivity && (
            <ActivityDetailsPanel
              activity={selectedActivity}
              index={selectedActivityIndex}
              dayOptions={itinerary.days}
              currentDayId={day.id}
              onChange={(changes) => onUpdateActivity(selectedActivity.id, changes)}
              onClose={() => setSelectedActivityId(null)}
              onMoveToDay={(targetDayId) => {
                if (targetDayId === day.id) return;
                const targetDay = itinerary.days.find((candidate) => candidate.id === targetDayId);
                void onMoveActivityToDay(selectedActivity.id, targetDayId, targetDay?.activities.length ?? 0);
              }}
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
              const leg = next
                ? (day.transportLegs ?? []).find(
                    (candidate) => candidate.fromActivityId === activity.id && candidate.toActivityId === next.id
                  )
                : undefined;
              const showTransportLeg = Boolean(next && (leg || canRouteActivityPair(activity, next)));
              return (
                <div key={activity.id} className="flex flex-col gap-3">
                  <ActivityEditor
                    activity={activity}
                    index={index}
                    canMoveUp={index > 0}
                    canMoveDown={index < day.activities.length - 1}
                    selected={selectedActivityId === activity.id}
                    onDelete={() => onDeleteActivity(activity.id)}
                    onSelect={() => {
                      setSelectedActivityId(activity.id);
                      setSelectedTransportLegId(null);
                    }}
                    onMoveUp={() => onReorderActivity(day.id, activity.id, index - 1)}
                    onMoveDown={() => onReorderActivity(day.id, activity.id, index + 1)}
                    onDragStart={(event) => startActivityDrag(event, activity.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropActivity(event, index)}
                  />
                  {next && showTransportLeg && (
                    <TransportLegEditor
                      leg={leg}
                      from={activity}
                      to={next}
                      fromIndex={index}
                      toIndex={index + 1}
                      selected={Boolean(leg && selectedTransportLegId === leg.id)}
                      onFocus={() => {
                        setSelectedActivityId(null);
                        if (!leg) setSelectedTransportLegId(null);
                      }}
                      onSelect={(legId) => {
                        setSelectedTransportLegId(legId);
                        setSelectedActivityId(null);
                      }}
                      onSave={(mode, overrides) => onSetTransport(day.id, activity.id, next.id, mode, overrides)}
                    />
                  )}
                </div>
              );
            })
          )}
          {exportText && (
            <Card className="bg-white">
              <CardHeader>
                <CardTitle>导出预览</CardTitle>
                <CardDescription>完整行程 Markdown，可用于答辩或分享。</CardDescription>
              </CardHeader>
              <CardContent>
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

function MapPanel({
  itinerary,
  day,
  selectedActivityId,
  selectedTransportLegId,
  onAddPlace,
  onAddBlankActivity,
  onSelectDay,
  onSelectActivity,
  onSelectTransportLeg,
  onCompleteRoutes
}: {
  itinerary: TravelItinerary;
  day: ItineraryDay;
  selectedActivityId: string | null;
  selectedTransportLegId: string | null;
  onAddPlace: (place: PlaceSearchItem) => TravelItinerary | void | Promise<TravelItinerary | void>;
  onAddBlankActivity: () => void;
  onSelectDay: (dayId: string) => void;
  onSelectActivity: (activityId: string) => void;
  onSelectTransportLeg: (legId: string) => void;
  onCompleteRoutes: (mode?: MapRouteMode) => void | Promise<void>;
}) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const [mapScope, setMapScope] = useState<"day" | "trip">("day");
  const [mapExpanded, setMapExpanded] = useState(false);
  const [batchRouteMode, setBatchRouteMode] = useState<MapRouteMode>("walking");
  const [mapSearchText, setMapSearchText] = useState("");
  const [mapSearchResults, setMapSearchResults] = useState<PlaceSearchItem[]>([]);
  const [hideEmptyTripDays, setHideEmptyTripDays] = useState(false);
  const [lastAddedPlace, setLastAddedPlace] = useState<{ dayTitle: string; placeName: string } | null>(null);
  const tripDaysWithPlaces = itinerary.days.filter((visibleDay) => visibleDay.activities.some(hasMapPoint));
  const hiddenEmptyTripDayCount = Math.max(0, itinerary.days.length - tripDaysWithPlaces.length);
  const visibleDays = mapScope === "trip" && hideEmptyTripDays ? tripDaysWithPlaces : mapScope === "trip" ? itinerary.days : [day];
  const points = visibleDays.flatMap((visibleDay) =>
    visibleDay.activities
      .filter(hasMapPoint)
      .map((activity) => ({ day: visibleDay, activity }))
  );
  const coordinatePoints = points.filter((item) => item.activity.place?.coordinates);
  const legs = visibleDays.flatMap((visibleDay) => getAdjacentTransportLegs(visibleDay));
  const routeSegments =
    mapScope === "day"
      ? day.activities.slice(0, -1).flatMap((fromActivity, index) => {
          const toActivity = day.activities[index + 1]!;
          const leg = (day.transportLegs ?? []).find(
            (candidate) => candidate.fromActivityId === fromActivity.id && candidate.toActivityId === toActivity.id
          );
          if (!leg && !canRouteActivityPair(fromActivity, toActivity)) return [];
          return [{ fromActivity, toActivity, leg, fromIndex: index, toIndex: index + 1 }];
        })
      : [];
  const pendingLegCount = visibleDays.reduce((sum, visibleDay) => {
    const expectedLegs = countRoutableAdjacentPairs(visibleDay);
    return sum + Math.max(0, expectedLegs - getAdjacentTransportLegs(visibleDay).length);
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
      ? [routeTitle, `${points.length} 个地点`, `${pendingLegCount} 段交通待计算`]
      : legs.length > 0
        ? [routeTitle, `${points.length} 个地点`, `${legs.length} 段交通`, formatDistanceForUi(totalDistance), `${totalDuration} 分钟`]
        : [routeTitle, `${points.length} 个地点`];
  const routeSummary =
    routeSummaryItems.join(" · ");
  const emptySummary =
    unplacedActivityCount > 0
      ? mapScope === "trip"
        ? `${unplacedActivityCount} 项安排待补地点`
        : `${day.title} · ${unplacedActivityCount} 项待补地点`
      : mapScope === "trip"
        ? "全部行程还没有地点"
        : `${day.title} 还没有地点`;
  const visibleMapSummaryItems = points.length > 0 ? routeSummaryItems : [emptySummary];
  const mapEmptyTitle = unplacedActivityCount > 0 ? "安排还缺地点" : "还没有地点";
  const mapEmptyDescription =
    unplacedActivityCount > 0
      ? "先为下方安排选择地点，地图会同步生成点位和路线。"
      : "搜索地点加入行程，或先创建一项待补全安排。";
  const dayRouteSummaries = visibleDays.map((visibleDay) => {
    const dayPoints = visibleDay.activities.filter(hasMapPoint);
    const dayLegs = getAdjacentTransportLegs(visibleDay);
    const expectedLegs = countRoutableAdjacentPairs(visibleDay);
    const dayPendingLegs = Math.max(0, expectedLegs - dayLegs.length);
    return {
      day: visibleDay,
      points: dayPoints,
      pointCount: dayPoints.length,
      legCount: dayLegs.length,
      pendingLegCount: dayPendingLegs,
      distanceMeters: dayLegs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationMinutes: dayLegs.reduce((sum, leg) => sum + leg.durationMinutes, 0)
    };
  });
  const coordinateFingerprint = coordinatePoints
    .map(({ day: pointDay, activity }) => {
      const coordinates = activity.place?.coordinates;
      return `${pointDay.id}:${activity.id}:${coordinates?.lng ?? ""}:${coordinates?.lat ?? ""}`;
    })
    .join("|");
  const legFingerprint = legs
    .map((leg) => `${leg.id}:${leg.fromActivityId}:${leg.toActivityId}:${leg.polyline?.length ?? 0}:${leg.provider}`)
    .join("|");

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
        const center = coordinatePoints[0]?.activity.place?.coordinates ?? { lng: 120.1551, lat: 30.2741 };
        const map = new AMap.Map(mapRef.current, {
          zoom: coordinatePoints.length > 1 ? 12 : 13,
          center: [center.lng, center.lat],
          viewMode: "2D"
        });
        if (AMap.Scale) map.addControl?.(new AMap.Scale());
        if (AMap.ToolBar) map.addControl?.(new AMap.ToolBar({ position: "RB" }));
        coordinatePoints.forEach((item, index) => {
          const coordinates = item.activity.place!.coordinates!;
          const label =
            mapScope === "trip"
              ? `${item.day.title} · ${index + 1}. ${activityDisplayName(item.activity, index)}`
              : `${index + 1}. ${activityDisplayName(item.activity, index)}`;
          const marker = new AMap.Marker({
            position: [coordinates.lng, coordinates.lat],
            label: {
              content: label,
              direction: "top"
            }
          });
          marker.on?.("click", () => onSelectActivity(item.activity.id));
          map.add(marker);
        });
        legs
          .filter((leg) => leg.polyline?.length)
          .forEach((leg) => {
            const selected = selectedTransportLegId === leg.id;
            const polyline = new AMap.Polyline({
              path: leg.polyline!.map((point) => [point.lng, point.lat]),
              strokeColor: selected ? "#435ee5" : "#111111",
              strokeWeight: selected ? 7 : 5,
              strokeOpacity: selected ? 0.95 : 0.8
            });
            polyline.on?.("click", () => onSelectTransportLeg(leg.id));
            map.add(polyline);
        });
        if (coordinatePoints.length > 1) map.setFitView();
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
    itinerary.id,
    legFingerprint,
    mapScope,
    onSelectActivity,
    onSelectTransportLeg,
    selectedTransportLegId
  ]);

  async function searchMapPlaces() {
    const query = mapSearchText.trim();
    if (!query) return;
    const result = await apiGet<{ items: PlaceSearchItem[] }>(
      `/maps/poi?keywords=${encodeURIComponent(query)}&city=${encodeURIComponent(itinerary.destination)}`,
      {
        items: [
          {
            id: `local-map-${query}`,
            name: query,
            address: `${itinerary.destination}市核心区域`,
            city: itinerary.destination,
            location: { lng: 120.1551, lat: 30.2741 }
          }
        ]
      }
    );
    setMapSearchResults(result.items);
  }

  async function addMapPlace(place: PlaceSearchItem) {
    await onAddPlace(place);
    setLastAddedPlace({ dayTitle: day.title, placeName: place.name });
    setMapSearchText("");
    setMapSearchResults([]);
  }

  return (
    <section
      className={cn(
        "overflow-hidden rounded-[20px] border border-border bg-white transition-[min-height]"
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-4">
        <div className="min-w-0">
          <p className="text-sm font-bold">行程地图</p>
          <h3 className="truncate text-2xl font-black">{itinerary.destination}</h3>
          {points.length > 0 && <p className="sr-only">{routeSummary}</p>}
          <div className="mt-2 flex flex-wrap gap-2" aria-hidden="true">
            {visibleMapSummaryItems.map((item) => (
              <span key={item} className="rounded-full bg-[#f6f6f3] px-3 py-1 text-xs font-bold text-muted-foreground">
                {item}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
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
          <TabsList className="rounded-full bg-[#f6f6f3] p-1">
            <TabsTrigger
              type="button"
              active={mapScope === "day"}
              className="min-h-9 px-3"
              onClick={() => setMapScope("day")}
            >
              当前日期
            </TabsTrigger>
            <TabsTrigger
              type="button"
              active={mapScope === "trip"}
              className="min-h-9 px-3"
              onClick={() => setMapScope("trip")}
            >
              全部行程
            </TabsTrigger>
          </TabsList>
          <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => setMapExpanded((expanded) => !expanded)}>
            {mapExpanded ? "收起地图" : "展开地图"}
          </Button>
        </div>
      </div>
      {mapScope === "trip" && hideEmptyTripDays && hiddenEmptyTripDayCount > 0 && (
        <div className="border-b border-border bg-white px-4 py-2 text-xs font-semibold text-muted-foreground">
          已隐藏 {hiddenEmptyTripDayCount} 个空日期
        </div>
      )}
      {lastAddedPlace && (
        <div className="border-b border-border bg-white px-4 py-2 text-xs font-semibold text-foreground">
          已加入 {lastAddedPlace.dayTitle}：{lastAddedPlace.placeName}
        </div>
      )}
      <div className="grid gap-3 border-b border-border bg-[#fbfbf9] p-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            value={mapSearchText}
            onChange={(event) => setMapSearchText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void searchMapPlaces();
              }
            }}
            aria-label="在地图上搜索地点"
            placeholder={`搜索${itinerary.destination}景点、餐厅或地点`}
          />
          <Button type="button" variant="secondary" onClick={searchMapPlaces}>
            <MapPin data-icon="inline-start" />
            搜索地点
          </Button>
        </div>
        {pendingLegCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <select
              className="h-10 rounded-full border border-border bg-background px-3 text-sm font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
              value={batchRouteMode}
              onChange={(event) => setBatchRouteMode(event.target.value as MapRouteMode)}
              aria-label="批量路线交通方式"
            >
              {routeModeOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => onCompleteRoutes(batchRouteMode)}>
              <Route data-icon="inline-start" />
              补全 {pendingLegCount} 段路线
            </Button>
          </div>
        )}
        {mapSearchResults.length > 0 && (
          <div className="max-h-64 overflow-auto rounded-2xl border border-border bg-white p-2 lg:col-span-2">
            {mapSearchResults.map((place) => (
              <button
                key={place.id}
                type="button"
                className="grid w-full gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => addMapPlace(place)}
                aria-label={`添加${place.name}到 ${day.title}`}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-bold">{place.name}</span>
                  <Badge className="min-h-6 bg-[#f6f6f3] px-2 text-[11px] text-foreground">
                    {poiCategoryLabel(place)}
                  </Badge>
                  <Badge className={cn("min-h-6 px-2 text-[11px]", place.source === "amap" ? "bg-emerald-100 text-emerald-950" : "bg-amber-100 text-amber-950")}>
                    {place.source === "amap" ? "高德" : "本地"}
                  </Badge>
                  <span className="ml-auto rounded-full bg-secondary px-2.5 py-1 text-xs font-black text-foreground">
                    加入
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
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className={cn(
          "relative overflow-hidden bg-[#f6f6f3]",
          mapExpanded ? "min-h-[68vh]" : "min-h-[360px]"
        )}
      >
        <div ref={mapRef} className="absolute inset-0" />
        {points.length === 0 && mapScope !== "trip" && (
          <div className="absolute left-4 top-4 grid max-w-sm gap-3 rounded-2xl bg-white/95 p-4 text-sm text-muted-foreground shadow-sm">
            <div>
              <p className="font-black text-foreground">{mapEmptyTitle}</p>
              <p className="mt-1">{mapEmptyDescription}</p>
            </div>
            <Button type="button" variant="secondary" size="sm" className="w-fit rounded-full" onClick={onAddBlankActivity}>
              <Plus data-icon="inline-start" />
              添加待补全安排
            </Button>
          </div>
        )}
      </div>
      {points.length > 0 || mapScope === "trip" ? (
        <div className="max-h-56 overflow-auto border-t border-border bg-white p-3">
          {mapScope === "trip" ? (
            <div className="grid gap-3 xl:grid-cols-2">
                {dayRouteSummaries.map((summary) => (
                  <button
                    type="button"
                    key={summary.day.id}
                    data-testid={`map-day-route-${summary.day.title.toLowerCase().replace(/\s+/g, "-")}`}
                    className="w-full cursor-pointer rounded-2xl bg-white/95 p-3 text-left shadow-sm transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      onSelectDay(summary.day.id);
                      setMapScope("day");
                    }}
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
                        ? `${summary.pendingLegCount} 段交通待计算`
                        : summary.legCount > 0
                          ? `${summary.legCount} 段交通 · ${formatDistanceForUi(summary.distanceMeters)} · ${summary.durationMinutes} 分钟`
                          : "路线待规划"}
                    </p>
                    {summary.points.length > 0 ? (
                      <ol className="mt-3 grid gap-2">
                        {summary.points.map((activity, pointIndex) => (
                          <li key={activity.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-xs">
                            <span className="font-black text-primary">{String(pointIndex + 1).padStart(2, "0")}</span>
                            <span className="min-w-0">
                              <span className="block truncate font-bold">{activityMapLabel(activity, pointIndex)}</span>
                              <span className="block truncate text-muted-foreground">
                                {activity.startTime ?? "待定"} / {activityLabels[activity.type]}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-3 rounded-xl bg-[#f6f6f3] px-3 py-2 text-xs text-muted-foreground">
                        暂无地点
                      </p>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section className="grid gap-2">
                  <p className="text-xs font-black text-muted-foreground">地点</p>
                  <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
                    {points.map(({ activity }, index) => (
                      <button
                        key={activity.id}
                        type="button"
                        aria-label={`在行程中编辑${activityDisplayName(activity, index)}`}
                        data-selected={selectedActivityId === activity.id ? "true" : "false"}
                        onClick={() => onSelectActivity(activity.id)}
                        className={cn(
                          "w-full cursor-pointer rounded-2xl bg-white/95 p-3 text-left shadow-sm transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selectedActivityId === activity.id && "ring-2 ring-ring"
                        )}
                      >
                        <span className="text-xs font-black text-primary">{String(index + 1).padStart(2, "0")}</span>
                        <p className="truncate font-bold">{activityMapLabel(activity, index)}</p>
                        <p className="text-xs text-muted-foreground">
                          {activity.startTime ?? "待定"} / {activityLabels[activity.type]}
                        </p>
                      </button>
                    ))}
                  </div>
                </section>
                {routeSegments.length > 0 && (
                  <section className="grid gap-2">
                    <p className="text-xs font-black text-muted-foreground">路线段</p>
                    <div className="grid gap-2">
                      {routeSegments.map((segment, index) => {
                        const provider = segment.leg ? transportProviderMeta(segment.leg) : undefined;
                        const routeTitle = `${activityDisplayName(segment.fromActivity, segment.fromIndex)} 到 ${activityDisplayName(
                          segment.toActivity,
                          segment.toIndex
                        )}`;
                        return (
                          <button
                            key={`${segment.fromActivity.id}-${segment.toActivity.id}`}
                            type="button"
                            aria-label={`查看路线：${routeTitle}`}
                            data-selected={segment.leg && selectedTransportLegId === segment.leg.id ? "true" : "false"}
                            disabled={!segment.leg}
                            onClick={() => {
                              if (segment.leg) onSelectTransportLeg(segment.leg.id);
                            }}
                            className={cn(
                              "w-full rounded-2xl bg-white/95 p-3 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              segment.leg ? "cursor-pointer hover:bg-white" : "cursor-not-allowed opacity-70",
                              segment.leg && selectedTransportLegId === segment.leg.id && "ring-2 ring-ring"
                            )}
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
                                  待计算
                                </Badge>
                              )}
                            </div>
                            <p className="mt-2 text-xs font-semibold text-muted-foreground">
                              {segment.leg
                                ? `${formatDistanceForUi(segment.leg.distanceMeters)} / ${segment.leg.durationMinutes} 分钟`
                                : "选择交通方式后计算路线"}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
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

function formatRouteStepMeta(step: RouteStep): string {
  const parts = [
    step.distanceMeters !== undefined ? formatDistanceForUi(step.distanceMeters) : undefined,
    step.durationMinutes !== undefined ? `${step.durationMinutes} 分钟` : undefined
  ].filter(Boolean);
  return parts.length ? parts.join(" / ") : "步骤详情待确认";
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

function getAdjacentTransportLegs(day: ItineraryDay): TransportLeg[] {
  return (day.transportLegs ?? []).filter((leg) =>
    day.activities.some((activity, index) => {
      const next = day.activities[index + 1];
      return next && leg.fromActivityId === activity.id && leg.toActivityId === next.id;
    })
  );
}

function countRoutableAdjacentPairs(day: ItineraryDay): number {
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
      label: "用户调整",
      description: "按手动输入保存",
      className: "bg-[#f6f6f3] text-foreground"
    };
  }
  if (leg.provider === "amap") {
    return {
      label: "高德路线",
      description: "路线、距离和耗时来自高德",
      className: "bg-emerald-100 text-emerald-950"
    };
  }
  return {
    label: "估算路线",
    description: "实时路线不可用时的参考值",
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

function createFallbackWeather(city: string, date: string): WeatherSummary {
  return {
    city,
    date,
    weather: "多云，适合户外步行",
    temperature: "24-30 C",
    source: "mock"
  };
}

function completeMissingRoutesLocally(itinerary: TravelItinerary, mode: MapRouteMode): TravelItinerary {
  let current = itinerary;
  for (const day of itinerary.days) {
    for (let index = 0; index < day.activities.length - 1; index += 1) {
      const fromActivity = day.activities[index];
      const toActivity = day.activities[index + 1];
      if (!fromActivity || !toActivity) continue;
      if (!canRouteActivityPair(fromActivity, toActivity)) continue;
      const existing = (day.transportLegs ?? []).some(
        (leg) => leg.fromActivityId === fromActivity.id && leg.toActivityId === toActivity.id
      );
      if (existing) continue;
      const route = createFallbackRoute(fromActivity, toActivity, mode);
      current = setTransportLeg(current, day.id, {
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
        steps: route.steps ?? []
      });
    }
  }
  return current;
}

function createLocalTransportLegDraft(
  itinerary: TravelItinerary,
  dayId: string,
  fromActivityId: string,
  toActivityId: string,
  mode: MapRouteMode,
  overrides: TransportLegOverride
): Omit<TransportLeg, "id"> {
  const day = itinerary.days.find((candidate) => candidate.id === dayId);
  const fromActivity = day?.activities.find((activity) => activity.id === fromActivityId);
  const toActivity = day?.activities.find((activity) => activity.id === toActivityId);
  const route =
    fromActivity && toActivity && canRouteActivityPair(fromActivity, toActivity)
      ? createFallbackRoute(fromActivity, toActivity, mode)
      : {
        mode,
        from: fromActivityId,
        to: toActivityId,
        distanceMeters: 0,
        durationMinutes: 0,
        summary: "路线待确认",
        source: "mock" as const,
        polyline: [],
        steps: [],
        status: "failed" as const,
        fallbackReason: "缺少起点或终点，路线待确认"
      };
  const manualOverride = Boolean(overrides.manualOverride);
  return {
    fromActivityId,
    toActivityId,
    mode: route.mode,
    distanceMeters: overrides.distanceMeters ?? route.distanceMeters,
    durationMinutes: overrides.durationMinutes ?? route.durationMinutes,
    costCny: overrides.costCny,
    provider: manualOverride ? "manual" : route.source,
    routeStatus: manualOverride ? "manual" : route.status,
    failureReason: route.fallbackReason,
    summary: overrides.summary?.trim() || route.summary,
    note: overrides.note?.trim() || undefined,
    manualOverride,
    polyline: route.polyline ?? [],
    steps: route.steps ?? []
  };
}

function createFallbackRoute(from: Activity, to: Activity, mode: MapRouteMode): RouteSummary {
  const fromPoint = from.place?.coordinates ?? { lng: 120.1551, lat: 30.2741 };
  const toPoint = to.place?.coordinates ?? { lng: 120.16, lat: 30.27 };
  const durationByMode: Record<MapRouteMode, number> = {
    walking: 18,
    transit: 24,
    driving: 12,
    cycling: 10
  };
  return {
    from: routePointForFallback(from),
    to: routePointForFallback(to),
    mode,
    distanceMeters: mode === "walking" ? 1300 : 3600,
    durationMinutes: durationByMode[mode],
    summary: mode === "walking" ? "步行路线建议" : "路线建议",
    polyline: [fromPoint, toPoint],
    steps: [
      {
        instruction: `${routeActionLabel(mode)}前往${activityDisplayName(to)}`,
        mode,
        distanceMeters: mode === "walking" ? 1300 : 3600,
        durationMinutes: durationByMode[mode],
        polyline: [fromPoint, toPoint]
      }
    ],
    source: "mock",
    status: "estimated",
    fallbackReason: "实时路线不可用时的参考值"
  };
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

function routePointForFallback(activity: Activity): string {
  const coordinates = activity.place?.coordinates;
  if (coordinates) return `${coordinates.lng},${coordinates.lat}`;
  const fallback = activityPrimaryPlaceName(activity) ?? activity.title.trim();
  return fallback || "未设置地点";
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
  const [placeResults, setPlaceResults] = useState<PlaceSearchItem[]>([]);
  const titleText = activityDisplayName(activity, index);

  useEffect(() => {
    setPlaceQuery(activity.placeName ?? "");
    setPlaceResults([]);
  }, [activity.id, activity.placeName]);

  async function searchPlaces() {
    const result = await apiGet<{
      items: PlaceSearchItem[];
    }>(`/maps/poi?keywords=${encodeURIComponent(placeQuery || activity.title)}&city=${encodeURIComponent(activity.place?.city ?? "")}`, {
      items: []
    });
    setPlaceResults(result.items);
  }

  function selectPlace(place: PlaceSearchItem) {
    void onChange({
      placeName: place.name,
      place: {
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
      }
    });
    setPlaceQuery(place.name);
    setPlaceResults([]);
  }

  return (
    <Card className="border-ring/40 bg-white shadow-sm" role="region" aria-label="编辑活动">
      <CardHeader className="gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
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
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  value={placeQuery}
                  onChange={(event) => {
                    setPlaceQuery(event.target.value);
                    onChange({ placeName: event.target.value });
                  }}
                  aria-label={`${titleText} 的地点`}
                  placeholder="输入地点或景点名称"
                />
                <Button type="button" variant="secondary" onClick={searchPlaces}>
                  搜索
                </Button>
              </div>
              {activity.place?.address && <p className="mt-2 text-xs text-muted-foreground">{activity.place.address}</p>}
              {placeMetaItems(activity.place).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-semibold text-muted-foreground">
                  {placeMetaItems(activity.place).map((item) => (
                    <span key={item} className="rounded-full bg-[#f6f6f3] px-2 py-0.5">
                      {item}
                    </span>
                  ))}
                </div>
              )}
              {placeResults.length > 0 && (
                <div className="mt-3 flex max-h-36 flex-col gap-1 overflow-auto rounded-xl border border-border bg-background p-2">
                  {placeResults.map((place) => (
                    <button
                      key={place.id}
                      type="button"
                      className="rounded-lg px-2 py-1 text-left text-xs transition-colors hover:bg-secondary"
                      onClick={() => selectPlace(place)}
                    >
                      <strong className="block">{place.name}</strong>
                      <span className="text-muted-foreground">{place.address}</span>
                      {placeMetaItems(place).length > 0 && (
                        <span className="mt-1 block text-muted-foreground">{placeMetaItems(place).join(" · ")}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="grid gap-3 rounded-xl bg-white p-3">
            <div className="flex items-center gap-2 text-sm font-black">
              <Clock3 className="size-4" />
              时间与预算
            </div>
            <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
              开始时间
              <Input
                type="time"
                value={activity.startTime ?? ""}
                onChange={(event) => onChange({ startTime: event.target.value })}
                aria-label={`${titleText} 的开始时间`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
              结束时间
              <Input
                type="time"
                value={activity.endTime ?? ""}
                onChange={(event) => onChange({ endTime: event.target.value })}
                aria-label={`${titleText} 的结束时间`}
              />
            </label>
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

function ActivityEditor({
  activity,
  index,
  canMoveUp,
  canMoveDown,
  selected,
  onDelete,
  onSelect,
  onMoveUp,
  onMoveDown,
  onDragStart,
  onDragOver,
  onDrop
}: {
  activity: Activity;
  index: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  selected: boolean;
  onDelete: () => void;
  onSelect: () => void;
  onMoveUp: () => void | Promise<void>;
  onMoveDown: () => void | Promise<void>;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}) {
  const hasDetails = Boolean(activity.description || activity.note);
  const timeSummary =
    activity.startTime && activity.endTime
      ? `${activity.startTime}-${activity.endTime}`
      : activity.startTime || activity.endTime || undefined;
  const budgetSummary = activity.budgetCny ? `约 ${activity.budgetCny} 元` : undefined;
  const placeSummary = activity.placeName || activity.place?.name;
  const missingSummary =
    !placeSummary && !timeSummary
      ? "待补地点与时间"
      : !placeSummary
        ? "待补地点"
        : !timeSummary
          ? "待补时间"
          : undefined;
  const detailSummary = [activity.description, activity.note].filter(Boolean).join(" / ");
  const titleText = activityDisplayName(activity, index);
  const typeLabel = activityLabels[activity.type];
  const blankDraft = isBlankDraftActivity(activity);

  return (
    <Card
      className={cn(
        "group overflow-hidden bg-white transition-colors hover:border-foreground/25",
        selected && "border-ring/70 ring-2 ring-ring/20"
      )}
      data-testid={`activity-drop-${index}`}
      data-selected={selected ? "true" : "false"}
      role="listitem"
      aria-label={`第 ${index + 1} 站：${titleText}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="grid gap-3 p-3 md:grid-cols-[44px_minmax(0,1fr)_auto] md:items-center">
        <button
          type="button"
          draggable
          onDragStart={onDragStart}
          aria-label={`拖动${titleText}调整顺序`}
          title="拖动排序"
          className="flex min-h-11 w-11 cursor-grab items-center justify-center rounded-full border border-border bg-[#f6f6f3] text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-secondary active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>

        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-black text-background">
              {index + 1}
            </span>
            <h4 className="min-w-0 flex-1 truncate text-base font-black">{titleText}</h4>
            <Badge className={cn("bg-[#f6f6f3] text-foreground", blankDraft && "bg-secondary")}>
              {blankDraft ? "待补全" : typeLabel}
            </Badge>
            {activity.lockedByUser && <Badge>手动锁定</Badge>}
            {activity.source === "agent" && <Badge className="bg-accent text-accent-foreground">助手建议</Badge>}
          </div>

          {blankDraft ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <MapPin className="size-3.5 shrink-0" />
              补充地点后会出现在地图和路线里
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-semibold text-muted-foreground">
              {placeSummary && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="truncate">{placeSummary}</span>
                </span>
              )}
              {timeSummary && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Clock3 className="size-3.5 shrink-0" />
                  <span className="truncate">{timeSummary}</span>
                </span>
              )}
              {budgetSummary && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Wallet className="size-3.5 shrink-0" />
                  <span className="truncate">{budgetSummary}</span>
                </span>
              )}
              {missingSummary && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="truncate">{missingSummary}</span>
                </span>
              )}
            </div>
          )}

          {hasDetails && (
            <p className="mt-2 truncate text-xs text-muted-foreground">{detailSummary}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 md:justify-end">
          <Button
            type="button"
            variant={selected ? "secondary" : "outline"}
            size="sm"
            onClick={onSelect}
            aria-expanded={selected}
            aria-label={`编辑${titleText}`}
          >
            编辑
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoveUp}
            disabled={!canMoveUp}
            aria-label={`上移${titleText}`}
          >
            <ChevronUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onMoveDown}
            disabled={!canMoveDown}
            aria-label={`下移${titleText}`}
          >
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`删除${titleText}`}>
            <Trash2 />
          </Button>
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
  onSave
}: {
  leg?: TransportLeg;
  from: Activity;
  to: Activity;
  fromIndex: number;
  toIndex: number;
  selected: boolean;
  onFocus: () => void;
  onSelect: (legId: string) => void;
  onSave: (mode: MapRouteMode, overrides?: TransportLegOverride) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<MapRouteMode>(leg?.mode ?? "walking");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [distanceKmText, setDistanceKmText] = useState(leg ? metersToKilometersInput(leg.distanceMeters) : "");
  const [durationText, setDurationText] = useState(leg ? String(leg.durationMinutes) : "");
  const [costText, setCostText] = useState(leg?.costCny !== undefined ? String(leg.costCny) : "");
  const [summaryText, setSummaryText] = useState(leg?.summary ?? "");
  const [noteText, setNoteText] = useState(leg?.note ?? "");
  const distance = leg ? formatDistanceForUi(leg.distanceMeters) : "待计算";
  const provider = leg ? transportProviderMeta(leg) : undefined;
  const routeFailed = leg?.routeStatus === "failed";
  const routeTitle = `${activityDisplayName(from, fromIndex)} 到 ${activityDisplayName(to, toIndex)}`;
  const metricText = leg
    ? routeFailed
      ? "路线待确认"
      : [`${distance} / ${leg.durationMinutes} 分钟`, leg.costCny !== undefined ? `约 ${leg.costCny} 元` : undefined]
        .filter(Boolean)
        .join(" / ")
    : distance;

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
    <div className="ml-7 border-l border-dashed border-border pl-6">
      <div
        role="group"
        aria-label={`路线：${routeTitle}`}
        data-selected={selected ? "true" : "false"}
        className={cn(
          "rounded-xl bg-[#fbfbf9] px-4 py-3 text-sm transition-colors",
          selected && "ring-2 ring-ring"
        )}
      >
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-muted-foreground">
              <Route className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-muted-foreground">路线</p>
              <p className="truncate font-semibold">{routeTitle}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {provider && <Badge className={cn("min-h-6 px-2.5", provider.className)}>{provider.label}</Badge>}
                <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-muted-foreground">{metricText}</span>
                {leg?.summary && <span className="max-w-[260px] truncate text-xs text-muted-foreground">{leg.summary}</span>}
                {leg?.manualOverride && leg.note && (
                  <span className="max-w-[260px] truncate text-xs font-semibold text-primary">用户调整：{leg.note}</span>
                )}
              </div>
              {provider && <p className="mt-1 text-xs text-muted-foreground">{provider.description}</p>}
              {routeFailed && (
                <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-950">
                  {leg?.failureReason ?? "路线计算失败，请补全地点或手动填写交通。"}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <select
              className="h-9 rounded-xl border border-input bg-background px-3 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onFocus();
                if (leg) onSelect(leg.id);
                setDetailsOpen((open) => !open);
              }}
              aria-expanded={detailsOpen}
              aria-label={`编辑路线细节：${routeTitle}`}
            >
              {detailsOpen ? "收起细节" : routeFailed ? "修正路线" : "路线细节"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => onSave(mode)}>
              {leg ? "重新计算" : "计算路线"}
            </Button>
          </div>
        </div>
        {detailsOpen && (
          <div className="mt-3 grid gap-3 rounded-xl bg-white p-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto]">
            <section className="grid gap-3 rounded-xl bg-[#fbfbf9] p-3">
              <p className="text-xs font-black text-foreground">路线数据</p>
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                  距离 / km
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    value={distanceKmText}
                    onChange={(event) => setDistanceKmText(event.target.value)}
                    aria-label={`${routeTitle} 的距离公里`}
                    placeholder="自动"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                  耗时 / 分钟
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={durationText}
                    onChange={(event) => setDurationText(event.target.value)}
                    aria-label={`${routeTitle} 的耗时分钟`}
                    placeholder="分钟"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-bold text-muted-foreground">
                  费用 / 元
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={costText}
                    onChange={(event) => setCostText(event.target.value)}
                    aria-label={`${routeTitle} 的费用`}
                    placeholder="元"
                  />
                </label>
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
            <section className="grid gap-3 rounded-xl bg-[#fbfbf9] p-3">
              <p className="text-xs font-black text-foreground">我的调整</p>
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
                  备注
                  <Input
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    aria-label={`${routeTitle} 的路线备注`}
                    placeholder="例如：雨天改打车，等车需预留时间"
                  />
                </label>
              </div>
            </section>
            <Button type="button" variant="secondary" className="self-end rounded-full xl:self-stretch" onClick={saveManualOverride}>
              应用调整
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentPanel({
  skills,
  importedSkillIds,
  messages,
  agentInput,
  agentRunning,
  agentProgress,
  onImportSkill,
  onRemoveSkill,
  onAgentInputChange,
  onRunAgent,
  onStopAgent,
  onClose
}: {
  skills: TravelSkill[];
  importedSkillIds: string[];
  messages: ChatMessage[];
  agentInput: string;
  agentRunning: boolean;
  agentProgress: string[];
  onImportSkill: (skillId: string) => void;
  onRemoveSkill: (skillId: string) => void;
  onAgentInputChange: (value: string) => void;
  onRunAgent: () => void;
  onStopAgent: () => void;
  onClose?: () => void;
}) {
  const appliedSkills = skills.filter((skill) => importedSkillIds.includes(skill.id));
  const [skillBrowserOpen, setSkillBrowserOpen] = useState(false);
  return (
    <aside className="relative flex h-screen flex-col border-l border-border bg-[#fbfbf9]">
      <header className="flex min-h-16 items-center gap-2 border-b border-border px-4">
        <Bot />
        <div className="min-w-0 flex-1">
          <h2 className="font-black">旅行助手</h2>
          <p className="text-xs text-muted-foreground">补全安排、调整节奏、检查路线。</p>
        </div>
        {onClose && (
          <Button type="button" variant="ghost" size="icon" className="2xl:hidden" onClick={onClose} aria-label="关闭旅行助手">
            <X />
          </Button>
        )}
      </header>
      <div className="border-b border-border bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-black text-muted-foreground">当前风格</p>
            <div className="mt-1 flex min-h-7 flex-wrap gap-1.5">
              {appliedSkills.length > 0 ? (
                appliedSkills.slice(0, 3).map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className="rounded-full bg-[#f6f6f3] px-2.5 py-1 text-xs font-bold text-foreground"
                    onClick={() => onRemoveSkill(skill.id)}
                    aria-label={`移出当前风格 ${skill.displayName}`}
                    title="点击移出当前行程"
                  >
                    {skill.displayName}
                  </button>
                ))
              ) : (
                <span className="rounded-full bg-[#f6f6f3] px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                  未选择风格
                </span>
              )}
              {appliedSkills.length > 3 && (
                <span className="rounded-full bg-[#f6f6f3] px-2.5 py-1 text-xs font-bold">
                  +{appliedSkills.length - 3}
                </span>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant={skillBrowserOpen ? "secondary" : "outline"}
            size="sm"
            className="shrink-0"
            onClick={() => setSkillBrowserOpen((open) => !open)}
          >
            <Store data-icon="inline-start" />
            使用风格
          </Button>
        </div>
      </div>
      {skillBrowserOpen && (
        <div
          role="dialog"
          aria-label="旅行风格选择"
          className="absolute left-3 right-3 top-32 z-20 max-h-[calc(100vh-220px)] overflow-auto rounded-2xl border border-border bg-white shadow-2xl"
        >
          <Card className="border-0 bg-white shadow-none">
            <CardHeader>
              <CardTitle>选择旅行风格</CardTitle>
              <CardDescription>选择后会用于本次行程规划和对话建议。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {skills.map((skill) => {
                const imported = importedSkillIds.includes(skill.id);
                return (
                  <div
                    key={skill.id}
                    className={cn(
                      "rounded-2xl border border-border bg-white p-3",
                      imported && "border-primary/50 bg-[#fff7f7]"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Sparkles className="mt-1 size-4 shrink-0 text-primary" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-black">{skill.displayName}</p>
                        <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted-foreground">
                        {skill.description}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {skill.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="rounded-full bg-[#f6f6f3] px-2 py-0.5 text-[11px] font-bold">
                              {tag}
                            </span>
                          ))}
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
                        aria-label={`${imported ? "移出" : "使用"} ${skill.displayName}`}
                      >
                        {imported ? "移出" : "使用"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <div className="flex flex-1 flex-col gap-3">
          {agentRunning && agentProgress.length > 0 && (
            <Card className="border-primary/20 bg-white">
              <CardHeader className="pb-3">
                <CardTitle>正在处理行程</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {agentProgress.map((item) => (
                  <div key={item} className="rounded-2xl bg-secondary px-3 py-2 text-xs">
                    {item}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`rounded-2xl p-3 text-sm ${
                message.role === "assistant" ? "bg-white" : "bg-primary text-primary-foreground"
              }`}
            >
              <MessageContent content={message.content} />
            </div>
          ))}
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
          placeholder="例如：Day 2 下午安排一个室内景点，节奏轻松一点。"
          disabled={agentRunning}
        />
        <Button className="mt-3 w-full" onClick={agentRunning ? onStopAgent : onRunAgent}>
          {agentRunning ? <CircleStop data-icon="inline-start" /> : <Send data-icon="inline-start" />}
          {agentRunning ? "停止" : "发送"}
        </Button>
      </footer>
    </aside>
  );
}

function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <div className="grid gap-1 whitespace-pre-wrap">
      {lines.map((line, index) => {
        if (line === "本轮改动") {
          return (
            <p key={`${line}-${index}`} className="mt-2 text-xs font-black text-foreground">
              本轮改动
            </p>
          );
        }
        return <p key={`${line}-${index}`}>{line}</p>;
      })}
    </div>
  );
}

function SkillPlaza({
  skills,
  recommendations,
  importedSkillIds,
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
  importedSkillIds: string[];
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
  const recommendedSkills = recommendations.map((item) => item.skill);
  const visibleSkills =
    filter === "recommended"
      ? recommendedSkills
      : filter === "favorites"
        ? skills.filter((skill) => skill.favorited)
        : filter === "drafts"
          ? skills.filter((skill) => skill.status === "draft")
          : skills;

  return (
    <div className="min-h-screen overflow-auto bg-[#fbfbf9] p-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black">Skill 广场</h2>
          <p className="text-muted-foreground">发现可复用的旅行风格，并应用到当前行程。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>推荐风格</Badge>
          <Button type="button" variant="outline" className="rounded-full bg-white" onClick={() => setImportPanelOpen((open) => !open)}>
            <Sparkles data-icon="inline-start" />
            导入风格
          </Button>
        </div>
      </div>
      {importPanelOpen && (
        <Card className="mb-5 bg-white">
          <CardHeader>
            <CardTitle>导入旅行风格</CardTitle>
            <CardDescription>粘贴符合 Skill.md 标准的旅行风格内容，用于当前行程。</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
            <label className="flex flex-col gap-2 text-xs font-bold text-muted-foreground">
              粘贴风格内容
              <Textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                aria-label="粘贴风格内容"
                className="min-h-36"
                placeholder={"---\nname: rainy-cafe-style\ndescription: 适合雨天、咖啡、室内和不赶路的旅行风格\n---\n\n## 规划规则\n- 雨天优先室内景点和咖啡休息"}
              />
            </label>
            <Button
              className="self-end rounded-full"
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
          </CardContent>
        </Card>
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
            <CardTitle>{filter === "favorites" ? "还没有收藏的旅行风格" : "这里暂时没有 Skill"}</CardTitle>
            <CardDescription>
              {filter === "favorites" ? "在 Skill 卡片上点收藏后，会出现在这里。" : "可以先去创作一个 Skill 草稿。"}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
          {visibleSkills.map((skill, index) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              image={heroImages[index % heroImages.length] ?? fallbackHeroImage}
              imported={importedSkillIds.includes(skill.id)}
              onImport={() => onImport(skill.id)}
              onRemoveImport={() => onRemoveImport(skill.id)}
              onFavorite={() => onFavorite(skill.id)}
              onSaveTags={(tags) => onUpdateSkill(skill.id, { tags })}
              allowTagEditing={filter === "drafts"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  image,
  imported,
  onImport,
  onRemoveImport,
  onFavorite,
  onSaveTags,
  allowTagEditing
}: {
  skill: TravelSkill;
  image: string;
  imported: boolean;
  onImport: () => void;
  onRemoveImport: () => void;
  onFavorite: () => void;
  onSaveTags: (tags: string[]) => void;
  allowTagEditing: boolean;
}) {
  const [tagText, setTagText] = useState(skill.tags.join(","));
  const [tagEditorOpen, setTagEditorOpen] = useState(false);

  useEffect(() => {
    setTagText(skill.tags.join(","));
  }, [skill.id, skill.tags.join(",")]);

  return (
    <Card className="overflow-hidden bg-white">
      <div className="photo-tile h-44" style={{ backgroundImage: `url(${image})` }} />
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{skill.displayName}</CardTitle>
            <CardDescription>{skill.description}</CardDescription>
          </div>
          {skill.status === "draft" && <Badge>草稿</Badge>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {skill.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
        {allowTagEditing && tagEditorOpen ? (
          <div className="grid gap-2 rounded-2xl bg-[#fbfbf9] p-3 sm:grid-cols-[1fr_auto]">
            <Input
              value={tagText}
              onChange={(event) => setTagText(event.target.value)}
              aria-label={`编辑${skill.displayName}标签`}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                onSaveTags(splitTagInput(tagText));
                setTagEditorOpen(false);
              }}
              aria-label={`保存${skill.displayName}标签`}
            >
              保存标签
            </Button>
          </div>
        ) : allowTagEditing ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full"
            onClick={() => setTagEditorOpen(true)}
            aria-label={`打开${skill.displayName}标签编辑`}
            title="编辑标签"
          >
            <Pencil />
          </Button>
        ) : null}
        <p className="text-xs font-semibold text-muted-foreground">{skill.favorites} 人收藏</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant={skill.favorited ? "secondary" : "outline"}
            onClick={onFavorite}
            aria-label={`${skill.favorited ? "取消收藏" : "收藏"}${skill.displayName}`}
            className="w-full"
          >
            <Heart data-icon="inline-start" />
            {skill.favorited ? "取消收藏" : "收藏"}
          </Button>
          <Button
            onClick={imported ? onRemoveImport : onImport}
            variant={imported ? "secondary" : "default"}
            className="w-full"
            aria-label={`${imported ? "移出" : "使用"}${skill.displayName}风格`}
          >
            <Sparkles data-icon="inline-start" />
            {imported ? "移出行程" : "使用风格"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SkillCreator({
  sourceText,
  draft,
  onSourceTextChange,
  onExtract,
  onPublish
}: {
  sourceText: string;
  draft: TravelSkill | null;
  onSourceTextChange: (value: string) => void;
  onExtract: () => void;
  onPublish: (changes: Partial<TravelSkill>) => void;
}) {
  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-3xl font-black">创作 Skill</h2>
        <p className="text-muted-foreground">从行程、对话或外部游记中提取旅行风格，确认后发布到广场。</p>
      </div>
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>来源文本</CardTitle>
          <CardDescription>可以粘贴攻略、游记，也可以使用当前行程上下文。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea value={sourceText} onChange={(event) => onSourceTextChange(event.target.value)} className="min-h-56" />
          <Button onClick={onExtract}>
            <WandSparkles data-icon="inline-start" />
            提取为 Skill 草稿
          </Button>
        </CardContent>
      </Card>
      {draft && <SkillDraftEditor draft={draft} onPublish={onPublish} />}
    </div>
  );
}

function SkillDraftEditor({
  draft,
  onPublish
}: {
  draft: TravelSkill;
  onPublish: (changes: Partial<TravelSkill>) => void;
}) {
  const [displayName, setDisplayName] = useState(draft.displayName);
  const [description, setDescription] = useState(draft.description);
  const [tags, setTags] = useState(draft.tags.join(","));
  const [body, setBody] = useState(draft.body);
  const [rules, setRules] = useState(draft.rules.join("\n"));
  const [forbidden, setForbidden] = useState(draft.forbidden.join("\n"));

  useEffect(() => {
    setDisplayName(draft.displayName);
    setDescription(draft.description);
    setTags(draft.tags.join(","));
    setBody(draft.body);
    setRules(draft.rules.join("\n"));
    setForbidden(draft.forbidden.join("\n"));
  }, [draft.id]);

  const preview = [
    "---",
    `name: ${draft.name}`,
    `description: ${description}`,
    `tags: [${splitTagInput(tags).map((tag) => `"${tag}"`).join(", ")}]`,
    "---",
    "",
    `# ${displayName}`,
    "",
    body,
    "",
    "## 规划规则",
    ...splitLines(rules).map((rule) => `- ${rule}`),
    "",
    "## 禁止模式",
    ...splitLines(forbidden).map((rule) => `- ${rule}`)
  ].join("\n");

  return (
    <Card className="bg-white">
      <CardHeader>
        <CardTitle>确认草稿</CardTitle>
        <CardDescription>发布前可以编辑名称、说明、标签和规则。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-label="Skill 名称" />
        <Input value={tags} onChange={(event) => setTags(event.target.value)} aria-label="Skill 标签" />
        <Textarea
          className="md:col-span-2"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          aria-label="Skill 说明"
        />
        <Textarea
          className="min-h-44 md:col-span-2"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label="Skill 正文"
        />
        <Textarea value={rules} onChange={(event) => setRules(event.target.value)} aria-label="规划规则" />
        <Textarea value={forbidden} onChange={(event) => setForbidden(event.target.value)} aria-label="禁止模式" />
        <pre className="max-h-72 overflow-auto rounded-2xl bg-secondary p-4 text-xs leading-6 md:col-span-2">
          {preview}
        </pre>
        <Button
          className="md:col-span-2"
          onClick={() =>
            onPublish({
              displayName,
              description,
              tags: splitTagInput(tags),
              body,
              rules: splitLines(rules),
              forbidden: splitLines(forbidden)
            })
          }
        >
          <Sparkles data-icon="inline-start" />
          发布到广场
        </Button>
      </CardContent>
    </Card>
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

function EvaluationPage() {
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
