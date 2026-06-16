import type {
  EvaluationCase,
  EvaluationScore,
  EvaluationSummary,
  OptimizationComparison
} from "./types.js";

export function scoreEvaluationCase(evaluationCase: EvaluationCase): EvaluationScore {
  const text = evaluationCase.output.itineraryText;
  const requirementCoverage = ratio(
    evaluationCase.expected.requiredKeywords.filter((keyword) => text.includes(keyword)).length,
    evaluationCase.expected.requiredKeywords.length
  );
  const styleConsistency = ratio(
    evaluationCase.expected.styleKeywords.filter((keyword) => text.includes(keyword)).length,
    evaluationCase.expected.styleKeywords.length
  );
  const structureCompleteness = evaluationCase.output.days >= evaluationCase.expected.minDays ? 1 : ratio(evaluationCase.output.days, evaluationCase.expected.minDays);
  const manualPreservation = ratio(
    evaluationCase.expected.preserveActivityIds.filter((id) => evaluationCase.output.preservedActivityIds.includes(id)).length,
    evaluationCase.expected.preserveActivityIds.length
  );
  const toolCoverage = ratio(
    evaluationCase.expected.requiredToolNames.filter((name) => evaluationCase.output.toolCalls.includes(name)).length,
    evaluationCase.expected.requiredToolNames.length
  );
  const scriptHealth = evaluationCase.output.scriptErrors.length === 0 ? 1 : 0;
  const toolSuccess = (toolCoverage + scriptHealth) / 2;
  const taskSuccess = average([
    requirementCoverage,
    styleConsistency,
    structureCompleteness,
    manualPreservation,
    toolSuccess
  ]);

  return {
    taskSuccess,
    requirementCoverage,
    styleConsistency,
    structureCompleteness,
    manualPreservation,
    toolSuccess
  };
}

export function aggregateEvaluation(before: EvaluationCase[], after: EvaluationCase[]): OptimizationComparison {
  const beforeSummary = summarize(before);
  const afterSummary = summarize(after);
  return {
    before: beforeSummary,
    after: afterSummary,
    delta: subtractScores(afterSummary.average, beforeSummary.average)
  };
}

export function summarize(cases: EvaluationCase[]): EvaluationSummary {
  const scores = cases.map(scoreEvaluationCase);
  return {
    count: cases.length,
    average: averageScores(scores)
  };
}

function ratio(count: number, total: number): number {
  if (total === 0) return 1;
  return clamp01(count / total);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return clamp01(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function averageScores(scores: EvaluationScore[]): EvaluationScore {
  if (scores.length === 0) {
    return {
      taskSuccess: 0,
      requirementCoverage: 0,
      styleConsistency: 0,
      structureCompleteness: 0,
      manualPreservation: 0,
      toolSuccess: 0
    };
  }

  return {
    taskSuccess: average(scores.map((score) => score.taskSuccess)),
    requirementCoverage: average(scores.map((score) => score.requirementCoverage)),
    styleConsistency: average(scores.map((score) => score.styleConsistency)),
    structureCompleteness: average(scores.map((score) => score.structureCompleteness)),
    manualPreservation: average(scores.map((score) => score.manualPreservation)),
    toolSuccess: average(scores.map((score) => score.toolSuccess))
  };
}

function subtractScores(after: EvaluationScore, before: EvaluationScore): EvaluationScore {
  return {
    taskSuccess: round(after.taskSuccess - before.taskSuccess),
    requirementCoverage: round(after.requirementCoverage - before.requirementCoverage),
    styleConsistency: round(after.styleConsistency - before.styleConsistency),
    structureCompleteness: round(after.structureCompleteness - before.structureCompleteness),
    manualPreservation: round(after.manualPreservation - before.manualPreservation),
    toolSuccess: round(after.toolSuccess - before.toolSuccess)
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, round(value)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
