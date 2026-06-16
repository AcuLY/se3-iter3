import { describe, expect, it } from "vitest";
import { aggregateEvaluation, scoreEvaluationCase } from "./evaluation";
import { evaluationDataset } from "./fixtures";
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

  it("includes the deterministic activity move optimization case in shipped fixtures", () => {
    const activityMoveCase = evaluationDataset.find((item) => item.id === "intent-activity-move");

    expect(activityMoveCase).toMatchObject({
      title: "移动已有活动到另一日",
      category: "intent_routing",
      input: "把湖滨咖啡移到 Day 2 上午第一项。"
    });
    expect(activityMoveCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["移动活动", "Day 2", "第 1 项", "未新增活动"])
    );
  });

  it("includes the deterministic natural date detail optimization case in shipped fixtures", () => {
    const naturalDateCase = evaluationDataset.find((item) => item.id === "intent-natural-date-details");

    expect(naturalDateCase).toMatchObject({
      title: "中文月日行程信息更新",
      category: "intent_routing",
      input: "把返回日期改到 7 月 5 日，预算 2600，备注每天午后留出休息。"
    });
    expect(naturalDateCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["日期范围", "2026-07-05", "预算", "备注", "未新增活动"])
    );
  });

  it("includes the deterministic travel profile detail optimization case in shipped fixtures", () => {
    const profileCase = evaluationDataset.find((item) => item.id === "intent-profile-details");

    expect(profileCase).toMatchObject({
      title: "目的地同行人偏好信息更新",
      category: "intent_routing",
      input: "把目的地改成苏州，同行人改成家人和孩子，偏好改成园林、慢节奏、亲子。"
    });
    expect(profileCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["目的地", "苏州", "同行人", "家人", "孩子", "偏好", "亲子", "未新增活动"])
    );
  });

  it("includes the deterministic activity remove optimization case in shipped fixtures", () => {
    const activityRemoveCase = evaluationDataset.find((item) => item.id === "intent-activity-remove");

    expect(activityRemoveCase).toMatchObject({
      title: "删除已有活动不新增活动",
      category: "intent_routing",
      input: "删掉湖滨咖啡，其他活动保持不变。"
    });
    expect(activityRemoveCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["删除活动", "湖滨咖啡", "未新增活动"])
    );
  });

  it("includes the deterministic place replacement optimization case in shipped fixtures", () => {
    const placeReplaceCase = evaluationDataset.find((item) => item.id === "intent-place-replace");

    expect(placeReplaceCase).toMatchObject({
      title: "替换已有活动地点并解析 POI",
      category: "intent_routing",
      input: "把湖滨咖啡换成灵隐寺，改成景点，时间 14:00-16:00。"
    });
    expect(placeReplaceCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["更新活动", "灵隐寺", "已更新地点", "未新增活动"])
    );
  });

  it("includes the deterministic explicit POI add optimization case in shipped fixtures", () => {
    const placeAddCase = evaluationDataset.find((item) => item.id === "intent-place-add");

    expect(placeAddCase).toMatchObject({
      title: "新增点名地点并解析 POI",
      category: "intent_routing",
      input: "在 Day 1 下午 15:00-17:00 添加灵隐寺景点，并补全步行路线。"
    });
    expect(placeAddCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已添加地点", "灵隐寺", "已补全交通路线", "未新增泛化活动"])
    );
  });

  it("includes the deterministic transport cancellation optimization case in shipped fixtures", () => {
    const transportRemoveCase = evaluationDataset.find((item) => item.id === "intent-transport-remove");

    expect(transportRemoveCase).toMatchObject({
      title: "取消指定交通段但保留活动",
      category: "intent_routing",
      input: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。"
    });
    expect(transportRemoveCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已取消交通", "西湖晨间散步", "湖滨咖啡", "未新增活动"])
    );
  });

  it("includes the deterministic transport comparison optimization case in shipped fixtures", () => {
    const transportCompareCase = evaluationDataset.find((item) => item.id === "intent-transport-compare-fastest");

    expect(transportCompareCase).toMatchObject({
      title: "比较交通方式并选择最快路线",
      category: "intent_routing",
      input: "比较西湖晨间散步到湖滨咖啡的步行、公交和骑行，选最快的路线。"
    });
    expect(transportCompareCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已比较交通方式", "步行", "公交/地铁", "骑行", "已选择骑行"])
    );
  });

  it("includes the route conflict faster-mode optimization case in shipped fixtures", () => {
    const fasterModeCase = evaluationDataset.find((item) => item.id === "intent-route-conflict-faster-mode");

    expect(fasterModeCase).toMatchObject({
      title: "路线晚到后改用更快交通方式",
      category: "intent_routing",
      input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我换个更快的交通方式，不改活动时间。"
    });
    expect(fasterModeCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已比较交通方式", "步行", "公交/地铁", "驾车", "骑行", "已选择骑行", "未新增活动"])
    );
  });

  it("includes the deterministic route timing adjustment optimization case in shipped fixtures", () => {
    const routeConflictCase = evaluationDataset.find((item) => item.id === "intent-route-conflict-delay-next");

    expect(routeConflictCase).toMatchObject({
      title: "路线晚到后顺延下一项活动",
      category: "intent_routing",
      input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。"
    });
    expect(routeConflictCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已顺延活动", "湖滨咖啡", "11:45", "未新增活动"])
    );
  });

  it("includes the deterministic route conflict shorten-previous optimization case in shipped fixtures", () => {
    const routeConflictCase = evaluationDataset.find((item) => item.id === "intent-route-conflict-shorten-previous");

    expect(routeConflictCase).toMatchObject({
      title: "路线晚到后缩短上一站停留",
      category: "intent_routing",
      input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我缩短上一站停留。"
    });
    expect(routeConflictCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已缩短停留", "西湖晨间散步", "10:45", "未新增活动"])
    );
  });

  it("includes the deterministic route conflict downstream-shift optimization case in shipped fixtures", () => {
    const routeConflictCase = evaluationDataset.find((item) => item.id === "intent-route-conflict-shift-downstream");

    expect(routeConflictCase).toMatchObject({
      title: "路线晚到后整体顺延后续安排",
      category: "intent_routing",
      input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我整体顺延后续安排。"
    });
    expect(routeConflictCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已顺延后续安排", "湖滨咖啡", "11:45", "未新增活动"])
    );
  });

  it("includes the deterministic route conflict options case in shipped fixtures", () => {
    const routeConflictCase = evaluationDataset.find((item) => item.id === "intent-route-conflict-options");

    expect(routeConflictCase).toMatchObject({
      title: "路线晚到后先给多方案取舍",
      category: "intent_routing",
      input: "西湖晨间散步到湖滨咖啡这段交通会晚到，先给我几个调整方案，暂时不要改画布。"
    });
    expect(routeConflictCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["路线会在", "顺延下一项", "缩短上一站", "改用更快交通方式", "未修改画布"])
    );
  });

  it("includes the online transport comparison tool optimization case in shipped fixtures", () => {
    const onlineCompareCase = evaluationDataset.find((item) => item.id === "deepseek-transport-compare-tool");

    expect(onlineCompareCase).toMatchObject({
      title: "在线模型通过工具比较交通方式",
      category: "intent_routing",
      input: "比较西湖晨间散步到湖滨咖啡的交通方式，选最快路线。"
    });
    expect(onlineCompareCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已比较交通方式", "步行", "公交/地铁", "驾车", "骑行", "已选择骑行"])
    );
  });

  it("includes the online place replacement tool optimization case in shipped fixtures", () => {
    const onlinePlaceCase = evaluationDataset.find((item) => item.id === "deepseek-place-replace-tool");

    expect(onlinePlaceCase).toMatchObject({
      title: "在线模型通过工具替换已有活动地点",
      category: "intent_routing",
      input: "把湖滨咖啡换成灵隐寺，选正式景区，活动本身保留。"
    });
    expect(onlinePlaceCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已更新地点", "灵隐寺飞来峰景区", "未新增活动"])
    );
  });

  it("includes the online transport removal tool optimization case in shipped fixtures", () => {
    const onlineRemoveCase = evaluationDataset.find((item) => item.id === "deepseek-transport-remove-tool");

    expect(onlineRemoveCase).toMatchObject({
      title: "在线模型通过工具取消指定交通段",
      category: "intent_routing",
      input: "取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留。"
    });
    expect(onlineRemoveCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已取消交通", "西湖晨间散步", "湖滨咖啡", "未新增活动"])
    );
  });

  it("includes the online route timing adjustment tool optimization case in shipped fixtures", () => {
    const onlineTimingCase = evaluationDataset.find((item) => item.id === "deepseek-route-conflict-delay-next-tool");

    expect(onlineTimingCase).toMatchObject({
      title: "在线模型通过工具修复路线晚到",
      category: "intent_routing",
      input: "西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。"
    });
    expect(onlineTimingCase?.expected.requiredKeywords).toEqual(
      expect.arrayContaining(["已顺延活动", "湖滨咖啡", "11:45", "未新增活动"])
    );
  });
});
