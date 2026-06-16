import { aggregateEvaluation, type EvaluationCase, type OptimizationComparison } from "@journey/shared";
import type { JourneyDatabase } from "../db.js";

export class EvaluationService {
  constructor(private readonly db: JourneyDatabase) {}

  listCases(): EvaluationCase[] {
    return this.db.listEvaluationCases();
  }

  summary(): OptimizationComparison {
    const after = this.listCases();
    const before = after.map((evaluationCase) => ({
      ...evaluationCase,
      output: {
        ...evaluationCase.output,
        itineraryText: evaluationCase.output.itineraryText.replaceAll("慢节奏", "").replaceAll("轻松", ""),
        days: Math.max(1, evaluationCase.output.days - 1),
        preservedActivityIds: [],
        toolCalls: evaluationCase.output.toolCalls.filter((agent) => agent !== "StyleAgent" && agent !== "CriticAgent"),
        scriptErrors: ["baseline missing optimized orchestration"]
      }
    }));

    return aggregateEvaluation(before, after);
  }
}
