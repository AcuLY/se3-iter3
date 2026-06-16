import { z } from "zod";
import { nowIso } from "./itinerary.js";
import { buildSkillMarkdown, validateSkillMarkdown } from "./skill.js";
import { TravelSkillSchema, type TravelSkill } from "./types.js";

export const SkillCreatorOptionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1)
});

export type SkillCreatorOption = z.infer<typeof SkillCreatorOptionSchema>;

export const SkillCreatorDraftPatchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    displayName: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    body: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    rules: z.array(z.string().trim().min(1)).optional(),
    forbidden: z.array(z.string().trim().min(1)).optional()
  })
  .strict();

export type SkillCreatorDraftPatch = z.infer<typeof SkillCreatorDraftPatchSchema>;

export const SkillCreatorTurnSchema = z
  .object({
    assistantMessage: z.string().trim().optional().default(""),
    question: z.string().trim().min(1).optional(),
    mode: z.enum(["single", "multiple"]).optional(),
    options: z.array(SkillCreatorOptionSchema).min(3).max(5).optional(),
    customPlaceholder: z.string().trim().optional().default("也可以写自己的答案"),
    progressPercent: z.number().int().min(0).max(100),
    draftPatch: SkillCreatorDraftPatchSchema.default({}),
    done: z.boolean()
  })
  .superRefine((turn, context) => {
    if (turn.done) return;
    if (!turn.question) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["question"],
        message: "question is required until done is true"
      });
    }
    if (!turn.mode) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "mode is required until done is true"
      });
    }
    if (!turn.options || turn.options.length < 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "at least three options are required until done is true"
      });
    }
  });

export type SkillCreatorTurn = z.infer<typeof SkillCreatorTurnSchema>;

export const SkillCreatorAnswerSchema = z.object({
  selectedOptionIds: z.array(z.string().trim().min(1)).default([]),
  customAnswer: z.string().trim().default("")
});

export type SkillCreatorAnswer = z.infer<typeof SkillCreatorAnswerSchema>;

export const SkillCreatorHistoryItemSchema = z.object({
  question: z.string(),
  mode: z.enum(["single", "multiple"]),
  options: z.array(SkillCreatorOptionSchema),
  selectedOptionIds: z.array(z.string()),
  customAnswer: z.string(),
  progressPercent: z.number().int().min(0).max(100),
  createdAt: z.string()
});

export type SkillCreatorHistoryItem = z.infer<typeof SkillCreatorHistoryItemSchema>;

export const SkillCreatorSessionSchema = z.object({
  id: z.string(),
  sourceText: z.string(),
  itineraryId: z.string().optional(),
  draft: TravelSkillSchema,
  currentTurn: SkillCreatorTurnSchema.optional(),
  history: z.array(SkillCreatorHistoryItemSchema),
  status: z.enum(["active", "ready"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

export type SkillCreatorSession = z.infer<typeof SkillCreatorSessionSchema>;

export function createSkillCreatorSession(input: {
  id: string;
  sourceText: string;
  itineraryId?: string;
  draft: TravelSkill;
  currentTurn?: SkillCreatorTurn;
}): SkillCreatorSession {
  const timestamp = nowIso();
  return {
    id: input.id,
    sourceText: input.sourceText,
    itineraryId: input.itineraryId,
    draft: input.draft,
    currentTurn: input.currentTurn,
    history: [],
    status: input.currentTurn?.done ? "ready" : "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function applySkillCreatorDraftPatch(skill: TravelSkill, patch: SkillCreatorDraftPatch): TravelSkill {
  const timestamp = nowIso();
  return {
    ...skill,
    name: patch.name ?? skill.name,
    displayName: patch.displayName ?? skill.displayName,
    description: patch.description ?? skill.description,
    body: patch.body ?? skill.body,
    tags: patch.tags ? unique([...skill.tags, ...patch.tags]) : skill.tags,
    rules: patch.rules ? unique([...skill.rules, ...patch.rules]) : skill.rules,
    forbidden: patch.forbidden ? unique([...skill.forbidden, ...patch.forbidden]) : skill.forbidden,
    updatedAt: timestamp
  };
}

export function isSkillCreatorDraftReady(skill: TravelSkill): boolean {
  const markdown = buildSkillMarkdown({
    name: skill.name,
    description: skill.description,
    body: skill.body,
    tags: skill.tags,
    rules: skill.rules,
    forbidden: skill.forbidden
  });
  return validateSkillMarkdown(markdown).valid;
}

export function recordSkillCreatorAnswer(
  session: SkillCreatorSession,
  answer: SkillCreatorAnswer
): SkillCreatorSession {
  if (!session.currentTurn || session.currentTurn.done) return session;
  const timestamp = nowIso();
  return {
    ...session,
    history: [
      ...session.history,
      {
        question: session.currentTurn.question ?? "",
        mode: session.currentTurn.mode ?? "single",
        options: session.currentTurn.options ?? [],
        selectedOptionIds: answer.selectedOptionIds,
        customAnswer: answer.customAnswer,
        progressPercent: session.currentTurn.progressPercent,
        createdAt: timestamp
      }
    ],
    updatedAt: timestamp
  };
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
