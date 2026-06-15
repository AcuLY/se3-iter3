import { z } from "zod";

export const ActivityTypeSchema = z.enum([
  "lodging",
  "food",
  "transport",
  "attraction",
  "free_time"
]);

export type ActivityType = z.infer<typeof ActivityTypeSchema>;

export const CoordinatesSchema = z.object({
  lng: z.number(),
  lat: z.number()
});

export type Coordinates = z.infer<typeof CoordinatesSchema>;

export const PlacePhotoSchema = z.object({
  title: z.string().optional(),
  url: z.string()
});

export type PlacePhoto = z.infer<typeof PlacePhotoSchema>;

export const PlaceSchema = z.object({
  poiId: z.string().optional(),
  name: z.string(),
  address: z.string().optional(),
  city: z.string().optional(),
  district: z.string().optional(),
  type: z.string().optional(),
  typeCode: z.string().optional(),
  phone: z.string().optional(),
  openingHours: z.string().optional(),
  averageCostCny: z.number().nonnegative().optional(),
  photos: z.array(PlacePhotoSchema).optional(),
  coordinates: CoordinatesSchema.optional()
});

export type Place = z.infer<typeof PlaceSchema>;

export const ActivitySchema = z.object({
  id: z.string(),
  type: ActivityTypeSchema,
  title: z.string(),
  placeName: z.string().optional(),
  place: PlaceSchema.optional(),
  description: z.string().optional(),
  note: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  tags: z.array(z.string()).default([]),
  budgetCny: z.number().optional(),
  transportNote: z.string().optional(),
  agentReason: z.string().optional(),
  lockedByUser: z.boolean().default(false),
  source: z.enum(["manual", "agent", "imported"]).default("manual")
});

export type Activity = z.infer<typeof ActivitySchema>;

export const RouteStepSchema = z.object({
  instruction: z.string(),
  mode: z.enum(["walking", "transit", "driving", "cycling"]),
  distanceMeters: z.number().nonnegative().optional(),
  durationMinutes: z.number().nonnegative().optional(),
  polyline: z.array(CoordinatesSchema).default([])
});

export type RouteStep = z.infer<typeof RouteStepSchema>;

export const RouteStatusSchema = z.enum(["planned", "estimated", "manual", "failed"]);

export type RouteStatus = z.infer<typeof RouteStatusSchema>;

export const TransportLegSchema = z.object({
  id: z.string(),
  fromActivityId: z.string(),
  toActivityId: z.string(),
  mode: z.enum(["walking", "transit", "driving", "cycling"]),
  distanceMeters: z.number().nonnegative().default(0),
  durationMinutes: z.number().nonnegative().default(0),
  costCny: z.number().nonnegative().optional(),
  provider: z.enum(["amap", "manual", "mock"]).default("manual"),
  routeStatus: RouteStatusSchema.default("manual"),
  summary: z.string().optional(),
  note: z.string().optional(),
  failureReason: z.string().optional(),
  manualOverride: z.boolean().default(false),
  polyline: z.array(CoordinatesSchema).default([]),
  steps: z.array(RouteStepSchema).default([])
});

export type TransportLeg = z.infer<typeof TransportLegSchema>;

export const WeatherSummarySchema = z.object({
  city: z.string(),
  date: z.string(),
  weather: z.string(),
  temperature: z.string(),
  source: z.enum(["amap", "mock"])
});

export type WeatherSummary = z.infer<typeof WeatherSummarySchema>;

export const ItineraryDaySchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  summary: z.string().optional(),
  weather: WeatherSummarySchema.optional(),
  activities: z.array(ActivitySchema),
  transportLegs: z.array(TransportLegSchema).default([])
});

export type ItineraryDay = z.infer<typeof ItineraryDaySchema>;

export const TravelItinerarySchema = z.object({
  id: z.string(),
  title: z.string(),
  destination: z.string(),
  startDate: z.string(),
  endDate: z.string().optional(),
  companions: z.array(z.string()).default([]),
  preferences: z.array(z.string()).default([]),
  budgetCny: z.number().nonnegative().optional(),
  notes: z.string().optional(),
  days: z.array(ItineraryDaySchema),
  importedSkillIds: z.array(z.string()).default([]),
  manualRevision: z.number().int().nonnegative().default(0),
  agentRevision: z.number().int().nonnegative().default(0),
  archivedAt: z.string().optional(),
  updatedAt: z.string()
});

export type TravelItinerary = z.infer<typeof TravelItinerarySchema>;

export type ActivityDraft = Omit<Activity, "id" | "tags" | "source" | "lockedByUser"> &
  Partial<Pick<Activity, "id" | "tags" | "source" | "lockedByUser">>;

export type CreateItineraryInput = {
  title: string;
  destination: string;
  startDate: string;
  endDate?: string;
  dayCount?: number;
  companions?: string[];
  preferences?: string[];
  budgetCny?: number;
  notes?: string;
};

export type ItineraryPatchOperation =
  | {
      type: "addActivity";
      dayId: string;
      activity: ActivityDraft;
    }
  | {
      type: "updateActivity";
      activityId: string;
      changes: Partial<Activity>;
    }
  | {
      type: "removeActivity";
      activityId: string;
    }
  | {
      type: "moveActivity";
      activityId: string;
      targetDayId: string;
      targetIndex: number;
    };

export type ItineraryPatch = {
  source: "manual" | "agent";
  reason: string;
  operations: ItineraryPatchOperation[];
};

export type PatchConflict = {
  activityId: string;
  field: keyof Activity;
  kept: unknown;
  proposed: unknown;
};

export type PatchResult = {
  itinerary: TravelItinerary;
  conflicts: PatchConflict[];
  diff: string[];
};

export const TravelSkillVersionSchema = z.object({
  version: z.number().int().positive(),
  summary: z.string(),
  changedFields: z.array(z.string()),
  createdAt: z.string()
});

export type TravelSkillVersion = z.infer<typeof TravelSkillVersionSchema>;

export const TravelSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  body: z.string(),
  tags: z.array(z.string()).default([]),
  rules: z.array(z.string()).default([]),
  forbidden: z.array(z.string()).default([]),
  status: z.enum(["draft", "published", "imported", "archived"]),
  source: z.enum(["plaza", "uploaded", "extracted", "system"]),
  imports: z.number().int().nonnegative().default(0),
  favorites: z.number().int().nonnegative().default(0),
  favorited: z.boolean().default(false),
  scriptEntry: z.string().optional(),
  versionHistory: z.array(TravelSkillVersionSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type TravelSkill = z.infer<typeof TravelSkillSchema>;

export type SkillDraftInput = {
  name: string;
  description: string;
  body: string;
  tags?: string[];
  rules?: string[];
  forbidden?: string[];
};

export type SkillRecommendationContext = {
  destination?: string;
  companions?: string[];
  preferences?: string[];
  currentText?: string;
  importedSkillIds?: string[];
};

export type SkillRecommendation = {
  skill: TravelSkill;
  score: number;
  reasons: string[];
};

export type AgentName =
  | "MainAgent"
  | "StyleAgent"
  | "SkillExtractorAgent"
  | "WeatherAgent"
  | "TransportAgent"
  | "AttractionAgent"
  | "PlannerAgent"
  | "CriticAgent";

export type AgentTraceEvent = {
  id: string;
  sessionId: string;
  agent: AgentName;
  type: "message" | "tool_call" | "state_patch" | "handoff" | "error";
  title: string;
  detail: string;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type AgentSession = {
  id: string;
  itineraryId: string;
  messages: ChatMessage[];
  importedSkillIds: string[];
  traces: AgentTraceEvent[];
  contextSummary?: string;
  userPreferenceSummary?: string;
  createdAt: string;
  updatedAt: string;
};

export type MapRouteMode = "walking" | "transit" | "driving" | "cycling";

export type RouteSummary = {
  mode: MapRouteMode;
  from: string;
  to: string;
  distanceMeters: number;
  durationMinutes: number;
  summary?: string;
  polyline?: Coordinates[];
  steps?: RouteStep[];
  source: "amap" | "mock";
  status: Extract<RouteStatus, "planned" | "estimated" | "failed">;
  fallbackReason?: string;
};

export type EvaluationCategory =
  | "normal_planning"
  | "skill_fusion"
  | "skill_extraction_internal"
  | "skill_extraction_external"
  | "manual_replan"
  | "intent_routing"
  | "skill_script_success"
  | "skill_script_failure";

export type EvaluationExpected = {
  requiredKeywords: string[];
  styleKeywords: string[];
  minDays: number;
  preserveActivityIds: string[];
  requiredToolNames: AgentName[];
};

export type EvaluationOutput = {
  itineraryText: string;
  days: number;
  preservedActivityIds: string[];
  toolCalls: AgentName[];
  scriptErrors: string[];
};

export type EvaluationCase = {
  id: string;
  title: string;
  category: EvaluationCategory;
  input: string;
  expected: EvaluationExpected;
  output: EvaluationOutput;
};

export type EvaluationScore = {
  taskSuccess: number;
  requirementCoverage: number;
  styleConsistency: number;
  structureCompleteness: number;
  manualPreservation: number;
  toolSuccess: number;
};

export type EvaluationSummary = {
  count: number;
  average: EvaluationScore;
};

export type OptimizationComparison = {
  before: EvaluationSummary;
  after: EvaluationSummary;
  delta: EvaluationScore;
};
