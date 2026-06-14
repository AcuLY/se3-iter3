import { describe, expect, it } from "vitest";
import { aggregateEvaluation, scoreEvaluationCase } from "./evaluation";
import type { EvaluationCase } from "./types";

describe("evaluation scoring", () => {
  it("scores requirement coverage, style consistency, structure, manual preservation, and tool success", () => {
    const evaluationCase: EvaluationCase = {
      id: "case-manual-protection",
      title: "手动改动后重规划",
      category: "manual_replan",
      input: "保留我锁定的博物馆上午安排，下午补一个轻松咖啡。",
      expected: {
        requiredKeywords: ["博物馆", "咖啡"],
        styleKeywords: ["轻松"],
        minDays: 1,
        preserveActivityIds: ["locked-1"],
        requiredToolNames: ["PlannerAgent", "CriticAgent"]
      },
      output: {
        itineraryText: "上午保留博物馆，下午安排轻松咖啡。",
        days: 1,
        preservedActivityIds: ["locked-1"],
        toolCalls: ["StyleAgent", "PlannerAgent", "CriticAgent"],
        scriptErrors: []
      }
    };

    expect(scoreEvaluationCase(evaluationCase)).toMatchObject({
      taskSuccess: 1,
      requirementCoverage: 1,
      styleConsistency: 1,
      structureCompleteness: 1,
      manualPreservation: 1,
      toolSuccess: 1
    });
  });

  it("aggregates before and after scores for the optimization document", () => {
    const before: EvaluationCase[] = [
      {
        id: "bad",
        title: "缺少风格",
        category: "skill_fusion",
        input: "慢节奏杭州",
        expected: {
          requiredKeywords: ["杭州"],
          styleKeywords: ["慢节奏"],
          minDays: 2,
          preserveActivityIds: [],
          requiredToolNames: ["StyleAgent"]
        },
        output: {
          itineraryText: "杭州两日游。",
          days: 1,
          preservedActivityIds: [],
          toolCalls: [],
          scriptErrors: ["style script failed"]
        }
      }
    ];
    const after: EvaluationCase[] = [
      {
        ...before[0]!,
        output: {
          itineraryText: "杭州两日慢节奏 citywalk。",
          days: 2,
          preservedActivityIds: [],
          toolCalls: ["StyleAgent"],
          scriptErrors: []
        }
      }
    ];

    const summary = aggregateEvaluation(before, after);

    expect(summary.after.average.taskSuccess).toBeGreaterThan(summary.before.average.taskSuccess);
    expect(summary.delta.taskSuccess).toBeGreaterThan(0);
  });
});
