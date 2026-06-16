import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addActivity,
  createDraftItinerary,
  createSeedItinerary,
  createSeedSkills,
  exportItineraryMarkdown,
  setTransportLeg,
  type SkillCreatorSession,
  type SkillCreatorTurn,
  type TravelSkill
} from "@journey/shared";
import App from "./App";

type TestAgentRunEvent = {
  id: string;
  sessionId: string;
  turnIndex: number;
  sequence: number;
  type:
    | "thought_summary"
    | "assistant_message"
    | "tool_call"
    | "tool_result"
    | "state_patch"
    | "handoff"
    | "error"
    | "final_signal";
  status: "running" | "completed" | "failed";
  title: string;
  detail: string;
  agent?: string;
  technical?: unknown;
  createdAt: string;
};

function testAgentRunEvent(overrides: Partial<TestAgentRunEvent> & Pick<TestAgentRunEvent, "sequence" | "type" | "title" | "detail">) {
  return {
    id: `event-${overrides.sequence}`,
    sessionId: "session-agent-run",
    turnIndex: 1,
    status: "completed" as const,
    createdAt: "2026-06-16T08:00:00.000Z",
    ...overrides
  };
}

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}`;
}

const creatorTimestamp = "2026-06-16T08:00:00.000Z";

function creatorDraft(overrides: Partial<TravelSkill> = {}): TravelSkill {
  return {
    id: "skill-seaside-shop-style",
    name: "seaside-shop-style",
    displayName: "海边小店松弛风格",
    description: "适合看海、逛小店、保留傍晚松弛时间的旅行风格。",
    body: "把看海、散步和小店停留作为核心体验。",
    tags: ["海边", "小店", "松弛"],
    rules: ["每天最多两个核心安排", "傍晚留给小店和日落"],
    forbidden: ["避免连续跨区", "不要午后暴晒长距离步行"],
    status: "draft",
    source: "extracted",
    imports: 0,
    favorites: 0,
    favorited: false,
    createdAt: creatorTimestamp,
    updatedAt: creatorTimestamp,
    ...overrides
  };
}

function creatorTurn(overrides: Partial<SkillCreatorTurn> = {}): SkillCreatorTurn {
  return {
    assistantMessage: "",
    question: "这套旅行风格最适合在哪类请求里触发？",
    mode: "single",
    options: [
      { id: "first-visit", label: "第一次到海边城市" },
      { id: "slow-shop", label: "想慢慢逛小店" },
      { id: "sunset", label: "傍晚看日落" }
    ],
    customPlaceholder: "也可以写自己的触发场景",
    progressPercent: 25,
    draftPatch: {},
    done: false,
    ...overrides
  };
}

function creatorSession(overrides: Partial<SkillCreatorSession> = {}): SkillCreatorSession {
  const draft = overrides.draft ?? creatorDraft();
  const currentTurn = overrides.currentTurn ?? creatorTurn();
  return {
    id: "creator-session-1",
    sourceText: "海边散步、傍晚小店、不要赶路。",
    draft,
    currentTurn,
    history: [],
    status: currentTurn.done ? "ready" : "active",
    createdAt: creatorTimestamp,
    updatedAt: creatorTimestamp,
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("Travel Skill Agent frontend", () => {
  it("keeps a stable workbench URL so refresh restores the current trip canvas", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);

    expect(window.location.hash).toBe("");
    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(window.location.hash).toBe("#/workbench");
    expect(screen.getByText("行程地图")).toBeInTheDocument();

    unmount();
    render(<App />);

    expect(window.location.hash).toBe("#/workbench");
    expect(screen.getByText("行程地图")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入工作台" })).not.toBeInTheDocument();
  });

  it("restores direct links for the travel style plaza routes", () => {
    window.history.replaceState(null, "", "#/skills");
    const firstRender = render(<App />);

    expect(screen.getByRole("heading", { name: "Skill 广场" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入工作台" })).not.toBeInTheDocument();

    firstRender.unmount();
    window.history.replaceState(null, "", "#/plaza");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Skill 广场" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "进入工作台" })).not.toBeInTheDocument();
  });

  it("waits for the restored itinerary before automatic weather and route sync", async () => {
    let loaded = createDraftItinerary({
      title: "苏州正式行程",
      destination: "苏州",
      startDate: "2026-08-01"
    });
    loaded = addActivity(loaded, loaded.days[0]!.id, {
      type: "attraction",
      title: "苏州博物馆",
      placeName: "苏州博物馆"
    });
    loaded = addActivity(loaded, loaded.days[0]!.id, {
      type: "food",
      title: "平江路午餐",
      placeName: "平江路"
    });
    const backgroundUrls: string[] = [];
    window.history.replaceState(null, "", "#/workbench");
    window.localStorage.setItem("journey:last-itinerary-id", loaded.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [loaded] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/weather")) {
          backgroundUrls.push(url);
          return new Response(JSON.stringify({ itinerary: loaded }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/transport-legs/complete")) {
          backgroundUrls.push(url);
          return new Response(JSON.stringify({ itinerary: loaded, completed: 0, skipped: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "苏州正式行程" })).toBeInTheDocument();
    await waitFor(() => expect(backgroundUrls.length).toBeGreaterThan(0));
    expect(backgroundUrls.every((url) => url.includes(loaded.id))).toBe(true);
  });

  it("collapses itinerary history maintenance actions outside the workbench", async () => {
    const seed = createSeedItinerary();
    const secondTrip = createDraftItinerary({
      title: "上海亲子周末",
      destination: "上海",
      startDate: "2026-08-01",
      endDate: "2026-08-03"
    });
    window.history.replaceState(null, "", "#/skills");
    window.localStorage.setItem("journey:last-itinerary-id", seed.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [seed, secondTrip] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Skill 广场" })).toBeInTheDocument();
    expect(screen.queryByText("会话记录")).not.toBeInTheDocument();
    expect(screen.getByText("当前规划")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开当前行程：杭州三日松弛游" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开行程：上海亲子周末" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "归档行程：杭州三日松弛游" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除行程：杭州三日松弛游" })).not.toBeInTheDocument();
  });

  it("restores the last active itinerary and lets a user switch from conversation history", async () => {
    const seed = createSeedItinerary();
    const custom = createDraftItinerary({
      title: "厦门亲子四日",
      destination: "厦门",
      startDate: "2026-08-10",
      endDate: "2026-08-13",
      budgetCny: 4200,
      preferences: ["亲子", "海边"]
    });
    window.history.replaceState(null, "", "#/workbench");
    window.localStorage.setItem("journey:last-itinerary-id", custom.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [seed, custom] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole("heading", { name: "厦门亲子四日" })).toBeInTheDocument();
    expect(screen.getByText("出发点 厦门 / 2026-08-10 至 2026-08-13 / 4 天")).toBeInTheDocument();
    const currentTripEntry = screen.getByRole("button", { name: "当前行程：厦门亲子四日" });
    expect(currentTripEntry).toBeInTheDocument();
    expect(within(currentTripEntry).queryByText(/^当前：/)).not.toBeInTheDocument();
    expect(within(currentTripEntry).getByText("当前")).toBeInTheDocument();
    expect(within(currentTripEntry).getByText(/08\/10-08\/13/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开行程：杭州三日松弛游" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开行程：杭州三日松弛游" }));

    expect(await screen.findByRole("heading", { name: "杭州三日松弛游" })).toBeInTheDocument();
    expect(window.localStorage.getItem("journey:last-itinerary-id")).toBe(seed.id);
  });

  it("keeps development validation titles out of traveler-facing navigation", async () => {
    const validationTrip = createDraftItinerary({
      title: "高德骑行验证行程",
      destination: "杭州",
      startDate: "2026-07-01",
      endDate: "2026-07-03",
      budgetCny: 1800
    });
    window.history.replaceState(null, "", "#/workbench");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [validationTrip] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "杭州西湖骑行路线" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前行程：杭州西湖骑行路线" })).toBeInTheDocument();
    expect(screen.queryByText(/高德骑行验证/)).not.toBeInTheDocument();
    expect(screen.queryByText(/验证行程/)).not.toBeInTheDocument();
  });

  it("lets a user archive and delete stale itinerary history entries", async () => {
    const seed = { ...createSeedItinerary(), updatedAt: "2026-06-14T10:00:00.000Z" };
    const stale = {
      ...createDraftItinerary({
      title: "杭州周末旅行",
      destination: "杭州",
      startDate: "2026-07-01",
      endDate: "2026-07-03"
      }),
      updatedAt: "2026-06-15T10:00:00.000Z"
    };
    const older = {
      ...createDraftItinerary({
      title: "杭州周末旅行副本",
      destination: "杭州",
      startDate: "2026-07-01",
      endDate: "2026-07-03"
      }),
      updatedAt: "2026-06-13T10:00:00.000Z"
    };
    window.history.replaceState(null, "", "#/workbench");
    window.localStorage.setItem("journey:last-itinerary-id", stale.id);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [stale, seed, older] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith(`/api/itineraries/${stale.id}/archive`)) {
          return new Response(JSON.stringify({ itinerary: { ...stale, archivedAt: "2026-06-15T00:00:00.000Z" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith(`/api/itineraries/${older.id}`) && init?.method === "DELETE") {
          return new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "杭州周末旅行" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "归档行程：杭州周末旅行" }));

    expect(await screen.findByRole("heading", { name: "杭州三日松弛游" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开行程：杭州周末旅行" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("journey:last-itinerary-id")).toBe(seed.id);

    await userEvent.click(screen.getByRole("button", { name: "删除行程：杭州周末旅行副本" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "打开行程：杭州周末旅行副本" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "当前行程：杭州三日松弛游" })).toBeInTheDocument();
  });

  it("creates a new named itinerary from the sidebar before planning places", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(screen.getByRole("button", { name: "当前行程" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建行程" }));
    const dialog = screen.getByRole("dialog", { name: "新建行程" });
    await user.type(within(dialog).getByLabelText("新建行程名称"), "上海亲子周末");
    await user.type(within(dialog).getByLabelText("新建行程出发点"), "上海");
    fireEvent.change(within(dialog).getByLabelText("新建行程出发日期"), { target: { value: "2026-08-01" } });
    fireEvent.change(within(dialog).getByLabelText("新建行程返回日期"), { target: { value: "2026-08-04" } });
    await user.type(within(dialog).getByLabelText("新建行程预算"), "3200");
    await user.type(within(dialog).getByLabelText("新建行程同行人"), "家人, 孩子");
    await user.type(within(dialog).getByLabelText("新建行程偏好"), "亲子, 博物馆, 少走路");
    await user.type(within(dialog).getByLabelText("新建行程备注"), "每天午后休息，避免连续跨区。");
    await user.click(within(dialog).getByRole("button", { name: "创建并规划" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新建行程" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "上海亲子周末" })).toBeInTheDocument();
    expect(screen.getByText("出发点 上海 / 2026-08-01 至 2026-08-04 / 4 天")).toBeInTheDocument();
    expect(screen.getByText("同行 家人、孩子")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Day 4" })).toBeInTheDocument();
    expect(screen.getByText("出发点 上海 · 4 天 · 预算 3200 元")).toBeInTheDocument();
    expect(screen.getByText("这一天还没有安排")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "杭州三日松弛游" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开行程：杭州三日松弛游" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑行程信息" }));
    const detailsDialog = screen.getByRole("dialog", { name: "编辑行程信息" });
    expect(within(detailsDialog).getByLabelText("行程备注")).toHaveValue("每天午后休息，避免连续跨区。");
  });

  it("lets a user enter the workbench and manually add an activity", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(screen.getByRole("heading", { name: "杭州三日松弛游" })).toBeInTheDocument();
    expect(screen.getByText("行程地图")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加活动" }));
    const newTimelineItem = screen.getByRole("listitem", { name: /第 3 站：第 3 项安排/ });
    expect(newTimelineItem).toBeInTheDocument();
    expect(await screen.findByLabelText("第 3 项活动名称")).toHaveValue("");
    expect(within(newTimelineItem).queryByText("待补地点与时间")).not.toBeInTheDocument();
    expect(screen.queryByText("补充地点后会出现在地图和路线里")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
    expect(screen.queryByText("新的活动")).not.toBeInTheDocument();
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("keeps activity fields in one focused editor panel instead of inside timeline cards", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));

    const editor = await screen.findByRole("region", { name: "编辑活动" });
    expect(within(editor).getByLabelText("第 3 项活动名称")).toHaveValue("");
    const timeBudget = within(editor).getByRole("group", { name: "时间与预算" });
    expect(timeBudget).toHaveClass("sm:grid-cols-3");
    expect(within(timeBudget).getByLabelText("待补全安排 的开始时间")).toBeInTheDocument();
    expect(within(timeBudget).getByLabelText("待补全安排 的结束时间")).toBeInTheDocument();
    expect(within(timeBudget).getByLabelText("待补全安排 的预算")).toBeInTheDocument();

    const timelineItem = screen.getByRole("listitem", { name: /第 3 站：第 3 项安排/ });
    expect(within(timelineItem).queryByLabelText("第 3 项活动名称")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "完成编辑" }));
    expect(screen.queryByRole("region", { name: "编辑活动" })).not.toBeInTheDocument();
  });

  it("keeps blank manual activities out of map points and route completion", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "Day 2" }));

    await user.click(screen.getByRole("button", { name: "添加活动" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));

    expect(within(screen.getByRole("listitem", { name: /第 1 站：第 1 项安排/ })).queryByText("待补地点与时间")).not.toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: /第 2 站：第 2 项安排/ })).queryByText("待补地点与时间")).not.toBeInTheDocument();
    expect(screen.getByText("2 项安排缺少地点")).toBeInTheDocument();
    expect(screen.queryByText("Day 2 · 2 项安排缺少地点")).not.toBeInTheDocument();
    expect(screen.queryByText("Day 2 · 2 个地点")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /补全 .*路线/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "规划路线" })).not.toBeInTheDocument();
    expect(screen.queryByText("补充地点后会出现在地图和路线里")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加待补全安排" })).not.toBeInTheDocument();
  });

  it("uses place names for route labels when activity titles are blank", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    await user.clear(screen.getByLabelText("第 1 项活动名称"));

    expect(screen.getByRole("group", { name: "路线：西湖 到 湖滨咖啡" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑路线细节：西湖 到 湖滨咖啡" })).toBeInTheDocument();
  });

  it("lets a user search a place and add it directly to the selected day", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    expect(await screen.findByText("灵隐寺")).toBeInTheDocument();
    expect(screen.getByTestId("map-search-preview-status")).toHaveTextContent("已在地图上预览 1 个地点");
    expect(screen.getByTestId("map-search-preview-status")).toHaveTextContent("选择后加入 Day 1");

    await user.click(screen.getByRole("button", { name: "添加灵隐寺到 Day 1" }));

    expect(screen.getByRole("listitem", { name: /第 3 站：灵隐寺/ })).toBeInTheDocument();
    expect(screen.queryByTestId("map-search-preview-status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑灵隐寺" }));
    expect(screen.getByLabelText("第 3 项活动名称")).toHaveValue("灵隐寺");
    expect(screen.getAllByText("全国范围").length).toBeGreaterThan(0);
  });

  it("lets a user fill the selected activity from map search without adding another activity", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    expect(await screen.findByTestId("map-search-preview-status")).toHaveTextContent("已在地图上预览 1 个地点");
    expect(screen.getByTestId("map-search-preview-status")).not.toHaveTextContent("选择后加入 Day 1");
    await user.click(await screen.findByRole("button", { name: "填入第 1 项：灵隐寺" }));

    expect(screen.getByRole("listitem", { name: /第 1 站：灵隐寺/ })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /第 2 站：湖滨咖啡/ })).toBeInTheDocument();
    expect(screen.queryByRole("listitem", { name: /第 3 站：灵隐寺/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "编辑活动" })).toHaveTextContent("第 1 站 · 灵隐寺");
    expect(screen.getByLabelText("第 1 项活动名称")).toHaveValue("灵隐寺");
    expect(screen.queryByTestId("map-search-preview-status")).not.toBeInTheDocument();
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("replans adjacent routes after filling a selected activity with a new place", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.click(await screen.findByRole("button", { name: "填入第 1 项：灵隐寺" }));

    await waitFor(() => {
      expect(screen.getByRole("listitem", { name: /第 1 站：灵隐寺/ })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
    expect(screen.queryByText("Day 1 · 2 个地点 · 1 段交通待确认")).not.toBeInTheDocument();
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("links map search candidates with preview markers before adding a place", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/maps/poi")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "poi-lingyin",
                  name: "Lingyin Temple",
                  address: "Lingyin Road",
                  city: "Hangzhou",
                  district: "Xihu",
                  type: "Scenic Area",
                  source: "amap",
                  location: { lng: 120.101, lat: 30.24 }
                },
                {
                  id: "poi-temple-cafe",
                  name: "Temple Cafe",
                  address: "Lingyin Road 18",
                  city: "Hangzhou",
                  district: "Xihu",
                  type: "Cafe",
                  source: "amap",
                  location: { lng: 120.104, lat: 30.242 }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "temple");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    const lingyinResult = await screen.findByTestId("map-search-result-poi-lingyin");
    const cafeResult = screen.getByTestId("map-search-result-poi-temple-cafe");
    const lingyinMarker = screen.getByTestId("map-search-preview-marker-poi-lingyin");
    const cafeMarker = screen.getByTestId("map-search-preview-marker-poi-temple-cafe");

    expect(lingyinResult).toHaveAttribute("data-active", "true");
    expect(lingyinMarker).toHaveAttribute("data-active", "true");
    expect(cafeMarker).toHaveAttribute("data-active", "false");

    fireEvent.mouseEnter(cafeResult);
    expect(cafeResult).toHaveAttribute("data-active", "true");
    expect(cafeMarker).toHaveAttribute("data-active", "true");
    expect(lingyinMarker).toHaveAttribute("data-active", "false");

    await user.click(lingyinMarker);
    expect(lingyinResult).toHaveAttribute("data-active", "true");
    expect(lingyinMarker).toHaveAttribute("data-active", "true");
  });

  it("uses a departure point without limiting later map searches to that city", async () => {
    const poiUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/maps/poi")) {
          poiUrls.push(url);
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "poi-bund",
                  name: "外滩",
                  address: "中山东一路",
                  city: "上海",
                  district: "黄浦区",
                  type: "风景名胜",
                  source: "amap",
                  location: { lng: 121.49, lat: 31.24 }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByLabelText("出发点")).toBeInTheDocument();
    expect(screen.queryByLabelText("目的地")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "外滩");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    await screen.findByRole("button", { name: "添加外滩到 Day 1" });
    const bundUrl = poiUrls.find((url) => url.includes("keywords=%E5%A4%96%E6%BB%A9"));
    expect(bundUrl).toBeTruthy();
    expect(new URL(bundUrl!, "http://localhost").searchParams.get("city")).toBe("全国");
  });

  it("shows the previous day's final activity as the next day's read-only continuation start", async () => {
    let itinerary = createDraftItinerary({
      title: "江南跨城两日",
      destination: "上海虹桥站",
      startDate: "2026-07-01",
      endDate: "2026-07-02"
    });
    const [day1, day2] = itinerary.days;
    itinerary = addActivity(itinerary, day1!.id, {
      type: "attraction",
      title: "西湖",
      placeName: "西湖",
      place: {
        name: "西湖",
        city: "杭州",
        coordinates: { lng: 120.141, lat: 30.259 }
      },
      startTime: "14:00",
      endTime: "17:00"
    });
    itinerary = addActivity(itinerary, day1!.id, {
      type: "food",
      title: "湖滨咖啡",
      placeName: "湖滨银泰",
      place: {
        name: "湖滨咖啡",
        city: "杭州",
        coordinates: { lng: 120.166, lat: 30.255 }
      },
      startTime: "11:30",
      endTime: "12:30"
    });
    itinerary = addActivity(itinerary, day2!.id, {
      type: "attraction",
      title: "苏州博物馆",
      placeName: "苏州博物馆",
      place: {
        name: "苏州博物馆",
        city: "苏州",
        coordinates: { lng: 120.629, lat: 31.318 }
      },
      startTime: "10:00",
      endTime: "12:00"
    });
    const cafe = itinerary.days[0]!.activities.at(-1)!;
    const museum = itinerary.days[1]!.activities[0]!;
    itinerary = setTransportLeg(itinerary, day2!.id, {
      fromActivityId: cafe.id,
      toActivityId: museum.id,
      mode: "driving",
      distanceMeters: 164000,
      durationMinutes: 118,
      provider: "mock",
      routeStatus: "estimated",
      summary: "跨城到首站"
    });
    window.history.replaceState(null, "", "#/workbench");
    window.localStorage.setItem("journey:last-itinerary-id", itinerary.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [itinerary] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills") || url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "江南跨城两日" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Day 2" }));

    expect(screen.getByRole("listitem", { name: "湖滨咖啡" })).toBeInTheDocument();
    expect(screen.getByText("湖滨银泰")).toBeInTheDocument();
    expect(screen.queryByText("接续起点")).not.toBeInTheDocument();
    expect(screen.queryByText(/跟随 Day 1 收尾/)).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "路线：湖滨咖啡 到 苏州博物馆" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑湖滨咖啡" }));
    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 项活动名称")).toHaveValue("湖滨咖啡");
  });

  it("shows the continuation start even before the next day has activities", async () => {
    let itinerary = createDraftItinerary({
      title: "杭州三日松弛游",
      destination: "杭州",
      startDate: "2026-07-01",
      endDate: "2026-07-03"
    });
    const [day1, day2] = itinerary.days;
    itinerary = addActivity(itinerary, day1!.id, {
      type: "attraction",
      title: "西湖晨间散步",
      placeName: "西湖",
      place: {
        name: "西湖",
        city: "杭州",
        coordinates: { lng: 120.141, lat: 30.259 }
      },
      startTime: "09:00",
      endTime: "11:00"
    });
    itinerary = addActivity(itinerary, day1!.id, {
      type: "food",
      title: "湖滨咖啡",
      placeName: "湖滨银泰",
      place: {
        name: "湖滨咖啡",
        city: "杭州",
        coordinates: { lng: 120.166, lat: 30.255 }
      },
      startTime: "11:30",
      endTime: "12:30"
    });
    window.history.replaceState(null, "", "#/workbench");
    window.localStorage.setItem("journey:last-itinerary-id", itinerary.id);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [itinerary] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills") || url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "杭州三日松弛游" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Day 2" }));

    expect(screen.getByRole("listitem", { name: "湖滨咖啡" })).toBeInTheDocument();
    expect(screen.getByText("湖滨银泰")).toBeInTheDocument();
    expect(screen.queryByText("接续起点")).not.toBeInTheDocument();
    expect(screen.queryByText(/跟随 Day 1 收尾/)).not.toBeInTheDocument();
    expect(screen.getByText("这一天还没有安排")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑湖滨咖啡" }));
    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("第 2 项活动名称")).toHaveValue("湖滨咖啡");
  });

  it("carries rich POI details from search into the editable activity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/maps/poi")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "poi-hubin-cafe",
                  name: "南山路咖啡馆",
                  address: "湖滨路 88 号",
                  city: "杭州",
                  district: "上城区",
                  type: "餐饮服务;咖啡厅",
                  typeCode: "050500",
                  phone: "0571-88886666",
                  openingHours: "10:00-22:00",
                  averageCostCny: 68,
                  source: "amap",
                  location: { lng: 120.165, lat: 30.255 }
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "南山路咖啡馆");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    const result = await screen.findByRole("button", { name: "添加南山路咖啡馆到 Day 1" });
    expect(screen.getByTestId("map-search-preview-status")).toHaveTextContent("已在地图上预览 1 个地点");
    expect(result).toHaveTextContent("餐饮");
    expect(result).toHaveTextContent("人均 68 元");

    await user.click(result);
    await user.click(screen.getByRole("button", { name: "编辑南山路咖啡馆" }));

    expect(screen.getByText("营业 10:00-22:00")).toBeInTheDocument();
    expect(screen.getByText("电话 0571-88886666")).toBeInTheDocument();
    expect(screen.getAllByText("人均 68 元").length).toBeGreaterThan(0);
  });

  it("scopes the map and route summary to the selected day", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
    expect(screen.getAllByText("西湖").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Day 2" }));
    expect(screen.getByText("还没有地点")).toBeInTheDocument();
    expect(screen.queryByText("Day 2 还没有地点")).not.toBeInTheDocument();
    expect(screen.queryByText("西湖")).not.toBeInTheDocument();
  });

  it("lets a user select a map point and edit the matching activity", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(screen.queryByLabelText("第 1 项活动名称")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.click(screen.getByRole("button", { name: "在行程中编辑西湖晨间散步" }));

    expect(screen.getByTestId("activity-drop-0")).toHaveAttribute("data-selected", "true");
    expect(screen.getByLabelText("第 1 项活动名称")).toHaveValue("西湖晨间散步");
    expect(screen.getByLabelText("西湖晨间散步 的活动内容")).toBeInTheDocument();
  });

  it("keeps the collapsed map overview mobile-first without an internal scroll trap", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const overviewPanel = screen.getByTestId("map-overview-panel");
    expect(Array.from(overviewPanel.classList)).toContain("overflow-visible");
    expect(Array.from(overviewPanel.classList)).not.toContain("overflow-auto");
    expect(Array.from(overviewPanel.classList)).not.toContain("md:overflow-auto");
    expect(screen.queryByLabelText("在地图上搜索地点")).not.toBeInTheDocument();
    expect(screen.queryByTestId("map-day-place-list")).not.toBeInTheDocument();
    expect(screen.queryByText("进入地图编辑后可搜索地点、选择地点卡和查看路线段。")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    const placeList = screen.getByTestId("map-day-place-list");
    expect(Array.from(placeList.classList)).toContain("grid-cols-1");
    expect(Array.from(placeList.classList)).toContain("sm:[grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]");
    expect(Array.from(placeList.classList)).not.toContain("[grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]");
    expect(screen.queryByTestId("map-day-route-list")).not.toBeInTheDocument();
  });

  it("keeps the editable map viewport before the active supporting panel", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    const placeList = within(editWorkspace).getByTestId("map-day-place-list");
    const mapViewport = within(editWorkspace).getByTestId("editable-map-canvas");

    expect(mapViewport.compareDocumentPosition(placeList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(editWorkspace).queryByTestId("map-day-route-list")).not.toBeInTheDocument();
    const firstPlace = within(placeList).getByRole("button", { name: "在行程中编辑西湖晨间散步" });
    expect(firstPlace).toHaveTextContent("09:00-11:00 / 景点");
    expect(firstPlace).not.toHaveTextContent("09:00 / 景点");

    await user.click(within(editWorkspace).getByRole("button", { name: "路线 1" }));
    const routeList = within(editWorkspace).getByTestId("map-day-route-list");
    expect(mapViewport.compareDocumentPosition(routeList) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(routeList).getByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" })).toBeInTheDocument();
  });

  it("opens map editing as an independent workspace with its own inspector scroll", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    expect(editWorkspace).toHaveClass("fixed");
    expect(editWorkspace).toHaveClass("z-[1100]");
    expect(screen.getByTestId("map-edit-workspace")).toHaveClass("min-h-0");

    const inspector = within(editWorkspace).getByTestId("map-edit-inspector");
    expect(inspector).toHaveClass("overflow-auto");
    expect(inspector).toHaveClass("max-h-[34vh]");
    expect(inspector).not.toHaveClass("overflow-visible");
    expect(within(inspector).getByTestId("map-day-place-list")).toBeInTheDocument();

    const timelineItem = screen.getByTestId("activity-drop-0");
    expect(editWorkspace.contains(timelineItem)).toBe(false);
  });

  it("filters existing map places and routes inside the map inspector", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    const inspector = within(editWorkspace).getByTestId("map-edit-inspector");
    await user.type(within(inspector).getByLabelText("筛选地图内容"), "咖啡");

    const placeList = within(inspector).getByTestId("map-day-place-list");
    expect(within(placeList).getByRole("button", { name: "在行程中编辑湖滨咖啡" })).toBeInTheDocument();
    expect(within(placeList).queryByRole("button", { name: "在行程中编辑西湖晨间散步" })).not.toBeInTheDocument();
    expect(within(inspector).getByTestId("map-filter-status")).toHaveTextContent("已筛选 1/2 个地点");

    await user.click(within(editWorkspace).getByRole("button", { name: "路线 1" }));
    const routeList = within(inspector).getByTestId("map-day-route-list");
    expect(within(routeList).getByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" })).toBeInTheDocument();
  });

  it("can jump from a map route segment to the route editor on the timeline", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    await user.click(within(editWorkspace).getByRole("button", { name: "路线 1" }));

    await user.click(within(editWorkspace).getByRole("button", { name: "定位到路线编辑：西湖晨间散步 到 湖滨咖啡" }));

    expect(screen.queryByRole("region", { name: "地图编辑工作区" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" })).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("路线结果")).toBeInTheDocument();
  });

  it("shows the selected route summary directly on the editable map canvas", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    await user.click(within(editWorkspace).getByRole("button", { name: "路线 1" }));

    const routeList = within(editWorkspace).getByTestId("map-day-route-list");
    await user.click(within(routeList).getByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" }));

    const mapCanvas = within(editWorkspace).getByTestId("editable-map-canvas");
    const selectedRouteSummary = within(mapCanvas).getByTestId("selected-map-route-summary");
    expect(selectedRouteSummary).toHaveTextContent("西湖晨间散步 到 湖滨咖啡");
    expect(selectedRouteSummary).toHaveTextContent("1.3 km / 18 分钟");
    expect(selectedRouteSummary).toHaveTextContent("参考路线");
  });

  it("highlights route steps inside the editable map canvas", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    await user.click(within(editWorkspace).getByRole("button", { name: "路线 1" }));

    const routeList = within(editWorkspace).getByTestId("map-day-route-list");
    await user.click(within(routeList).getByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" }));

    const mapCanvas = within(editWorkspace).getByTestId("editable-map-canvas");
    const routeSteps = within(mapCanvas).getByRole("list", { name: "西湖晨间散步 到 湖滨咖啡 路径步骤" });
    expect(routeSteps).toHaveTextContent("步行前往湖滨咖啡");
    expect(within(routeSteps).getByRole("button", { name: "查看路径段 1：步行前往湖滨咖啡" })).toHaveAttribute("data-selected", "true");

    await user.click(within(routeSteps).getByRole("button", { name: "查看路径段 1：步行前往湖滨咖啡" }));
    expect(within(routeSteps).getByRole("button", { name: "查看路径段 1：步行前往湖滨咖啡" })).toHaveAttribute("data-selected", "true");
    expect(within(mapCanvas).getByTestId("selected-route-step-summary")).toHaveTextContent("路径段 1");
    expect(within(mapCanvas).getByTestId("selected-route-step-summary")).toHaveTextContent("1.3 km / 18 分钟");
  });

  it("edits trip information in a dialog without inserting the form between map and timeline", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const tripSummary = screen.getByTestId("trip-info-summary");
    const dayContext = screen.getByTestId("day-context-bar");
    expect(tripSummary).toHaveClass("hidden");
    expect(tripSummary.compareDocumentPosition(dayContext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tripSummary).queryByLabelText("返回日期")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑行程信息" }));

    const dialog = screen.getByRole("dialog", { name: "编辑行程信息" });
    expect(dialog.parentElement).toHaveClass("z-[1200]");
    expect(within(dialog).getByLabelText("返回日期")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("行程备注")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("同行人")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "应用信息" }));
    expect(screen.getByText("同行 朋友")).toBeInTheDocument();
    expect(within(tripSummary).queryByLabelText("返回日期")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收起信息" })).not.toBeInTheDocument();
  });

  it("lets the map switch from the selected day to the full trip overview", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "Day 2" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.click(await screen.findByRole("button", { name: "添加灵隐寺到 Day 2" }));
    expect(screen.getByText("Day 2 · 1 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "全部行程" }));

    await waitFor(() => {
      expect(screen.getByText("全部行程 · 3 个地点 · 2 段交通 · 2.6 km · 36 分钟")).toBeInTheDocument();
    });
    expect(screen.getByTestId("map-day-route-day-1")).toHaveTextContent("Day 1 路线");
    expect(screen.getByTestId("map-day-route-day-1")).toHaveTextContent("2 个地点");
    expect(screen.getByTestId("map-day-route-day-2")).toHaveTextContent("Day 2 路线");
    expect(screen.getByTestId("map-day-route-day-2")).toHaveTextContent("1 个地点");
    expect(screen.getByTestId("map-day-route-day-2")).toHaveTextContent("1 段交通 · 1.3 km · 18 分钟");
  });

  it("groups the full-trip map overview by day for longer itineraries", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑信息" }));
    const returnDate = screen.getByLabelText("返回日期");
    await user.clear(returnDate);
    await user.type(returnDate, "2026-07-05");
    await user.click(screen.getByRole("button", { name: "应用信息" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));

    expect(screen.getByTestId("map-day-route-day-1")).toHaveTextContent("Day 1 路线");
    expect(screen.getByTestId("map-day-route-day-1")).toHaveTextContent("2 个地点");
    expect(screen.getByTestId("map-day-route-day-5")).toHaveTextContent("Day 5 路线");
    expect(screen.getByTestId("map-day-route-day-5")).toHaveTextContent("暂无地点");
  });

  it("shows a full-trip route overview before long day cards and jumps to a route", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑信息" }));
    const returnDate = screen.getByLabelText("返回日期");
    await user.clear(returnDate);
    await user.type(returnDate, "2026-07-05");
    await user.click(screen.getByRole("button", { name: "应用信息" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));

    const overviewPanel = screen.getByTestId("map-overview-panel");
    const routeOverview = within(overviewPanel).getByTestId("trip-route-overview");
    const firstDayCard = within(overviewPanel).getByTestId("map-day-route-day-1");
    expect(routeOverview.compareDocumentPosition(firstDayCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(routeOverview).toHaveTextContent("全程路线总览");
    expect(routeOverview).toHaveTextContent("1 段已规划");
    expect(routeOverview).toHaveTextContent("1.3 km / 18 分钟");

    await user.click(within(routeOverview).getByRole("button", { name: "查看全程路线：Day 1 西湖晨间散步 到 湖滨咖啡" }));

    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" })).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("路线结果")).toBeInTheDocument();
  });

  it("lets a user filter a long full-trip map overview to days that already have places", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑信息" }));
    const returnDate = screen.getByLabelText("返回日期");
    await user.clear(returnDate);
    await user.type(returnDate, "2026-07-05");
    await user.click(screen.getByRole("button", { name: "应用信息" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));

    expect(screen.getByTestId("map-day-route-day-5")).toHaveTextContent("暂无地点");

    await user.click(screen.getByRole("button", { name: "只看有地点的日期" }));

    expect(screen.getByTestId("map-day-route-day-1")).toBeInTheDocument();
    expect(screen.queryByTestId("map-day-route-day-5")).not.toBeInTheDocument();
    expect(screen.getByText("已隐藏 4 个空日期")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示全部日期" }));
    expect(screen.getByTestId("map-day-route-day-5")).toBeInTheDocument();
  });

  it("filters the full-trip map overview by place or route text", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑信息" }));
    const returnDate = screen.getByLabelText("返回日期");
    await user.clear(returnDate);
    await user.type(returnDate, "2026-07-05");
    await user.click(screen.getByRole("button", { name: "应用信息" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));

    const overviewPanel = screen.getByTestId("map-overview-panel");
    await user.type(within(overviewPanel).getByLabelText("筛选全部行程地图"), "湖滨");

    expect(within(overviewPanel).getByTestId("map-global-filter-status")).toHaveTextContent("已筛选 1/5 个日期");
    expect(screen.getByTestId("map-day-route-day-1")).toBeInTheDocument();
    expect(screen.queryByTestId("map-day-route-day-5")).not.toBeInTheDocument();
    expect(within(overviewPanel).getAllByText("西湖晨间散步 到 湖滨咖啡").length).toBeGreaterThan(0);
  });

  it("lets a user jump from a full-trip route card to the timeline route editor", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));

    await user.click(screen.getByRole("button", { name: "编辑 Day 1 路线：西湖晨间散步 到 湖滨咖啡" }));

    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" })).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("路线结果")).toBeInTheDocument();
  });

  it("lets a user return from the timeline route editor to the selected map route", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    await user.click(screen.getByRole("button", { name: "在地图中查看路线：西湖晨间散步 到 湖滨咖啡" }));

    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    const routeList = within(editWorkspace).getByTestId("map-day-route-list");
    const selectedRoute = within(routeList).getByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" });
    expect(selectedRoute.closest("[data-selected]")).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: "收起地图" })).toBeInTheDocument();
  });

  it("opens the selected day route panel when returning from the timeline after viewing the full-trip map", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));
    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    await user.click(screen.getByRole("button", { name: "在地图中查看路线：西湖晨间散步 到 湖滨咖啡" }));

    const editWorkspace = screen.getByRole("region", { name: "地图编辑工作区" });
    const routeList = within(editWorkspace).getByTestId("map-day-route-list");
    const selectedRoute = within(routeList).getByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" });
    expect(selectedRoute.closest("[data-selected]")).toHaveAttribute("data-selected", "true");
  });

  it("keeps newly added map search results selected on the canvas", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.click(await screen.findByRole("button", { name: "添加灵隐寺到 Day 1" }));

    expect(screen.getByTestId("activity-drop-2")).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("region", { name: "编辑活动" })).toHaveTextContent("第 3 站 · 灵隐寺");
    expect(screen.getByText("已加入 Day 1：灵隐寺")).toBeInTheDocument();
  });

  it("lets a user open a day from the full-trip map overview", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "Day 2" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));
    expect(screen.getByRole("heading", { name: "Day 2" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "全部行程" }));
    await user.click(screen.getByTestId("map-day-route-day-1"));

    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
  });

  it("lets a user locate an activity from the full-trip map overview", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "全部行程" }));
    await user.click(screen.getByRole("button", { name: "在行程中编辑 Day 1 的 西湖晨间散步" }));

    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    expect(screen.getByTestId("activity-drop-0")).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("region", { name: "编辑活动" })).toHaveTextContent("第 1 站 · 西湖晨间散步");
    expect(screen.getByLabelText("第 1 项活动名称")).toHaveValue("西湖晨间散步");
  });

  it("automatically completes missing routes when adjacent places exist", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(screen.queryByRole("button", { name: /补全 .*路线/ })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
    expect(screen.getAllByText("1.3 km / 18 分钟").length).toBeGreaterThan(0);
    expect(screen.getAllByText("参考路线").length).toBeGreaterThan(0);
    expect(screen.queryByText("当前为参考估算")).not.toBeInTheDocument();
  });

  it("lets a user update the route mode from the route card", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" })).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("西湖晨间散步 到 湖滨咖啡 的交通方式")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新规划" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));
    await user.selectOptions(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的交通方式"), "driving");
    await user.click(screen.getByRole("button", { name: "重新规划路线" }));

    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 3.6 km · 12 分钟")).toBeInTheDocument();
    });
    expect(screen.getAllByText("3.6 km / 12 分钟").length).toBeGreaterThan(0);
  });

  it("lets a user select a route segment from the map and edit that leg", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.click(screen.getByRole("button", { name: "路线 1" }));

    const mapRouteSegment = await screen.findByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" });
    expect(mapRouteSegment).toHaveTextContent("参考路线");
    expect(screen.queryByLabelText("西湖晨间散步 到 湖滨咖啡 的距离公里")).not.toBeInTheDocument();

    await user.click(mapRouteSegment);

    const routeEditor = screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" });
    expect(routeEditor).toHaveAttribute("data-selected", "true");
    expect(screen.getByText("路线结果")).toBeInTheDocument();
    expect(screen.queryByLabelText("西湖晨间散步 到 湖滨咖啡 的实际距离公里")).not.toBeInTheDocument();
    expect(within(routeEditor).getByText("路线步骤")).toBeInTheDocument();
    expect(within(routeEditor).getByText("步行前往湖滨咖啡")).toBeInTheDocument();
  });

  it("lets a user expand the map and add a place from map search", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    expect(screen.getByRole("button", { name: "收起地图" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    expect(await screen.findByRole("button", { name: "添加灵隐寺到 Day 1" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加灵隐寺到 Day 1" }));

    expect(screen.getByRole("listitem", { name: /第 3 站：灵隐寺/ })).toBeInTheDocument();
  });

  it("lets a user manually override transport distance, duration, cost, and note", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    expect(screen.queryByLabelText("西湖晨间散步 到 湖滨咖啡 的实际距离公里")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "展开手动校准：西湖晨间散步 到 湖滨咖啡" }));

    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际距离公里"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际距离公里"), "2.4");
    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际耗时分钟"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际耗时分钟"), "35");
    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的预计花费"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的预计花费"), "18");
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的路上提醒"), "雨天含等车时间");

    await user.click(screen.getByRole("button", { name: "应用调整" }));

    await waitFor(() => {
      expect(screen.getAllByText("2.4 km / 35 分钟 / 约 18 元").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("手动调整：雨天含等车时间")).toBeInTheDocument();
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("lets a user remove a planned route without removing adjacent activities", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));
    await user.click(screen.getByRole("button", { name: "移除路线：西湖晨间散步 到 湖滨咖啡" }));

    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通待确认")).toBeInTheDocument();
    });
    expect(screen.getByRole("listitem", { name: /第 1 站：西湖晨间散步/ })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /第 2 站：湖滨咖啡/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "规划路线" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("warns when route duration makes the next activity unreachable on time", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    await user.click(screen.getByRole("button", { name: "展开手动校准：西湖晨间散步 到 湖滨咖啡" }));
    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际耗时分钟"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际耗时分钟"), "45");
    await user.click(screen.getByRole("button", { name: "应用调整" }));

    await waitFor(() => {
      expect(screen.getAllByText("预计 11:45 到达，晚于 11:30，需调整上一站停留或下一项开始时间。").length).toBeGreaterThan(1);
    });
    const mapRiskSummary = screen.getByRole("region", { name: "路线风险" });
    expect(mapRiskSummary).toHaveTextContent("1 段交通可能影响时间");
    expect(within(mapRiskSummary).getByRole("button", { name: "查看路线风险：西湖晨间散步 到 湖滨咖啡" })).toHaveTextContent(
      "预计 11:45 到达"
    );
    expect(within(mapRiskSummary).getByRole("button", { name: "延后下一项到 11:45" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    expect(screen.queryByRole("region", { name: "路线风险" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("map-route-risk-list")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "风险 1" }));
    const mapRiskList = screen.getByTestId("map-route-risk-list");
    expect(mapRiskList).toHaveTextContent("预计 11:45 到达");

    await user.click(within(mapRiskList).getByRole("button", { name: "查看路线风险：西湖晨间散步 到 湖滨咖啡" }));
    expect(screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" })).toHaveAttribute("data-selected", "true");

    await user.click(within(mapRiskList).getByRole("button", { name: "延后下一项到 11:45" }));

    await waitFor(() => {
      expect(screen.getByText("已将湖滨咖啡调整到 11:45")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "撤销本次路线修复" })).toBeInTheDocument();
    expect(screen.queryByTestId("map-route-risk-list")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑湖滨咖啡" }));

    expect(screen.getByLabelText("湖滨咖啡 的开始时间")).toHaveValue("11:45");
    expect(screen.getByLabelText("湖滨咖啡 的结束时间")).toHaveValue("12:45");
    await user.click(screen.getByRole("button", { name: "撤销本次路线修复" }));
    expect(screen.getByLabelText("湖滨咖啡 的开始时间")).toHaveValue("11:30");
    expect(screen.getByLabelText("湖滨咖啡 的结束时间")).toHaveValue("12:30");
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("surfaces route failures with a user-facing recovery path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/itineraries/") && url.includes("/transport-legs")) {
          return new Response(
            JSON.stringify({
              itinerary: {
                id: "trip-failed-route",
                title: "杭州三日松弛游",
                destination: "杭州",
                startDate: "2026-07-01",
                endDate: "2026-07-03",
                companions: [],
                preferences: [],
                days: [
                  {
                    id: "day-1",
                    title: "Day 1",
                    date: "2026-07-01",
                    activities: [
                      {
                        id: "act-a",
                        type: "attraction",
                        title: "西湖晨间散步",
                        placeName: "西湖",
                        tags: [],
                        lockedByUser: false,
                        source: "manual"
                      },
                      {
                        id: "act-b",
                        type: "food",
                        title: "湖滨咖啡",
                        placeName: "湖滨银泰",
                        tags: [],
                        lockedByUser: false,
                        source: "manual"
                      }
                    ],
                    transportLegs: [
                      {
                        id: "leg-failed",
                        fromActivityId: "act-a",
                        toActivityId: "act-b",
                        mode: "walking",
                        distanceMeters: 0,
                        durationMinutes: 0,
                        provider: "mock",
                        routeStatus: "failed",
                        failureReason: "高德未返回可用路线，请补全地点或手动填写交通。",
                        manualOverride: false,
                        polyline: [],
                        steps: []
                      }
                    ]
                  },
                  { id: "day-2", title: "Day 2", date: "2026-07-02", activities: [], transportLegs: [] },
                  { id: "day-3", title: "Day 3", date: "2026-07-03", activities: [], transportLegs: [] }
                ],
                importedSkillIds: [],
                manualRevision: 1,
                agentRevision: 0,
                updatedAt: "2026-06-14T00:00:00.000Z"
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    await waitFor(() => {
      expect(screen.getAllByText("路线待确认").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("高德未返回可用路线，请补全地点或手动填写交通。").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" })).toHaveTextContent("修正路线");

    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));
    const repairPanel = screen.getByRole("region", { name: "西湖晨间散步 到 湖滨咖啡 的路线修复" });
    const routeResult = screen.getByRole("region", { name: "西湖晨间散步 到 湖滨咖啡 的路线结果" });
    expect(within(repairPanel).getByText("无法确认路线")).toBeInTheDocument();
    expect(within(repairPanel).getByText("起点和终点都缺少精确位置")).toBeInTheDocument();
    expect(within(repairPanel).getByRole("button", { name: "编辑起点：西湖晨间散步" })).toBeInTheDocument();
    expect(within(repairPanel).getByRole("button", { name: "编辑终点：湖滨咖啡" })).toBeInTheDocument();
    expect(within(repairPanel).getByRole("button", { name: "重新规划路线：西湖晨间散步 到 湖滨咖啡" })).toBeInTheDocument();
    expect(within(routeResult).queryByText("高德未返回可用路线，请补全地点或手动填写交通。")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("西湖晨间散步 到 湖滨咖啡 的实际距离公里")).not.toBeInTheDocument();

    await user.click(within(repairPanel).getByRole("button", { name: "编辑起点：西湖晨间散步" }));
    expect(screen.getByRole("region", { name: "编辑活动" })).toBeInTheDocument();
    expect(screen.getByLabelText("西湖晨间散步 的地点")).toHaveValue("西湖");

    await user.click(within(repairPanel).getByRole("button", { name: "手动记录路线：西湖晨间散步 到 湖滨咖啡" }));
    expect(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的实际距离公里")).toBeInTheDocument();
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("shows a saved state after manual itinerary edits", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));

    await waitFor(() => {
      expect(screen.getByText(/已保存 .*\d{2}:\d{2}/)).toBeInTheDocument();
    });
    expect(screen.getAllByText(/最近编辑 \d{2}\/\d{2} .*\d{2}:\d{2}/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^最近 \d{2}\/\d{2}/)).not.toBeInTheDocument();
  });

  it("lets a user adjust the trip date range and keeps day tabs in sync", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑信息" }));

    const returnDate = screen.getByLabelText("返回日期");
    await user.clear(returnDate);
    await user.type(returnDate, "2026-07-05");
    await user.click(screen.getByRole("button", { name: "应用信息" }));

    expect(screen.getByRole("button", { name: "Day 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Day 5" })).toBeInTheDocument();
  });

  it("updates daily weather automatically on the itinerary canvas", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(await screen.findByText("多云，适合户外步行")).toBeInTheDocument();
    expect(screen.getByText("24-30°C")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新天气" })).not.toBeInTheDocument();
  });

  it("downloads a markdown file when exporting the itinerary", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:journey-export");
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });

    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL,
        revokeObjectURL
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/export")) {
          return new Response("# 杭州西湖周末\n\n## 行程总览\n\n总安排：2 项\n");
        }
        return new Response("", { status: 404 });
      })
    );

    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "导出" }));

    expect(await screen.findByText("导出预览")).toBeInTheDocument();
    expect(screen.getByText(/行程总览/)).toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:journey-export");

    await user.click(screen.getByRole("button", { name: "复制导出 Markdown" }));
    expect(writeText).toHaveBeenCalledWith("# 杭州西湖周末\n\n## 行程总览\n\n总安排：2 项\n");
    expect(await screen.findByText("已复制")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新下载 Markdown" }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(anchorClick).toHaveBeenCalledTimes(2);
  });

  it("opens a dedicated read-only travel result page when exporting the itinerary", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/export")) {
          return new Response("# 杭州三日松弛游\n\n## 行程总览\n\n总安排：2 项\n");
        }
        return new Response("", { status: 404 });
      })
    );
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:journey-export"),
        revokeObjectURL: vi.fn()
      })
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "导出" }));

    expect(await screen.findByRole("heading", { name: "旅行结果" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/result");
    const resultPage = screen.getByRole("region", { name: "只读行程结果" });
    expect(within(resultPage).getByRole("heading", { name: "杭州三日松弛游" })).toBeInTheDocument();
    expect(within(resultPage).getByText("Day 1")).toBeInTheDocument();
    expect(within(resultPage).getByText("西湖晨间散步")).toBeInTheDocument();
    expect(within(resultPage).getByText("湖滨咖啡")).toBeInTheDocument();
    expect(within(resultPage).getByText("西湖晨间散步 到 湖滨咖啡")).toBeInTheDocument();
    expect(within(resultPage).getByText("1.3 km / 18 分钟")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "导出预览" })).toHaveTextContent("行程总览");
    expect(screen.queryByRole("button", { name: "添加活动" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑西湖晨间散步" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "旅行助手" })).not.toBeInTheDocument();
  });

  it("shows unresolved planning gaps in the export preview", async () => {
    const user = userEvent.setup();
    let itinerary = createDraftItinerary({
      title: "苏州周末规划",
      destination: "苏州",
      startDate: "2026-07-04",
      dayCount: 2
    });
    itinerary = addActivity(itinerary, itinerary.days[0]!.id, {
      type: "free_time",
      title: "",
      description: ""
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "attraction",
      title: "苏州博物馆",
      placeName: "苏州博物馆",
      startTime: "10:00",
      endTime: "12:00"
    });
    itinerary = addActivity(itinerary, itinerary.days[1]!.id, {
      type: "food",
      title: "平江路午餐",
      placeName: "平江路",
      startTime: "12:30",
      endTime: "13:30"
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:journey-export"),
        revokeObjectURL: vi.fn()
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [itinerary] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/transport-legs/complete")) {
          return new Response(JSON.stringify({ itinerary, completed: 0, skipped: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith("/export")) {
          return new Response(exportItineraryMarkdown(itinerary));
        }
        return new Response("Not found", { status: 404 });
      })
    );

    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(await screen.findByRole("button", { name: "导出" }));

    const exportCheck = await screen.findByRole("region", { name: "导出检查" });
    expect(within(exportCheck).getByText("还有 3 项需要补齐")).toBeInTheDocument();
    expect(within(exportCheck).getByText("地点")).toBeInTheDocument();
    expect(within(exportCheck).getByText("时间")).toBeInTheDocument();
    expect(within(exportCheck).getByText("交通")).toBeInTheDocument();
    expect(within(exportCheck).getAllByText("Day 1 第 1 项 待补全安排")).toHaveLength(2);
    expect(within(exportCheck).getByText("Day 2 苏州博物馆 到 平江路午餐")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "旅行结果" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/result");
    expect(within(exportCheck).queryByRole("button", { name: /定位待补地点/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回编辑" }));
    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
  });

  it("imports a skill and runs the agent to update the itinerary canvas", async () => {
    const user = userEvent.setup();
    let restoreBody: { itinerary?: { id: string; title: string } } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/itineraries/") && url.endsWith("/restore")) {
          restoreBody = JSON.parse(String(init?.body ?? "{}"));
          return new Response(JSON.stringify({ itinerary: restoreBody?.itinerary }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        throw new Error("offline fallback");
      })
    );
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "浏览风格" }));
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，别太赶。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getAllByText(/已更新行程/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/慢节奏街区探索|街区咖啡与自由探索/).length).toBeGreaterThan(0);
    const diffBlock = screen.getByRole("group", { name: "本轮改动" });
    expect(diffBlock).toBeInTheDocument();
    expect(within(diffBlock).getByText("已应用到画布")).toBeInTheDocument();
    expect(within(diffBlock).getByText("参考风格")).toBeInTheDocument();
    expect(within(diffBlock).getAllByText("慢节奏街区漫步").length).toBeGreaterThan(0);
    expect(within(diffBlock).getByText("本轮风格影响")).toBeInTheDocument();
    expect(within(diffBlock).getByText("每天保留至少一个长休息段")).toBeInTheDocument();
    expect(within(diffBlock).getAllByRole("listitem").length).toBeGreaterThan(0);

    const locateButton = within(diffBlock).getByRole("button", { name: /定位本轮改动/ });
    await user.click(locateButton);

    expect(screen.getByRole("region", { name: "编辑活动" })).toHaveTextContent(/慢节奏街区探索|街区咖啡与自由探索/);
    expect(screen.getByTestId("selected-canvas-context")).toHaveTextContent("正在编辑");
    expect(screen.getByTestId("selected-canvas-context")).toHaveTextContent(/慢节奏街区探索|街区咖啡与自由探索/);

    expect(screen.getByRole("listitem", { name: /第 \d 站：慢节奏街区探索|第 \d 站：街区咖啡与自由探索/ })).toBeInTheDocument();

    await user.click(within(diffBlock).getByRole("button", { name: "撤销本轮改动" }));
    expect(within(diffBlock).getByText("已撤销")).toBeInTheDocument();
    expect(restoreBody?.itinerary?.title).toBe("杭州三日松弛游");
    await waitFor(() => {
      expect(screen.queryByRole("listitem", { name: /第 \d 站：慢节奏街区探索|第 \d 站：街区咖啡与自由探索/ })).not.toBeInTheDocument();
    });
    expect(screen.queryByText("偏好记忆")).not.toBeInTheDocument();
  });

  it("lets a user choose a route-conflict option from the assistant reply and then shows the agent diff", async () => {
    const seed = createSeedItinerary();
    const day = seed.days[0]!;
    const [fromActivity, toActivity] = day.activities;
    const withConflict = {
      ...seed,
      days: seed.days.map((candidateDay) =>
        candidateDay.id === day.id
          ? {
              ...candidateDay,
              transportLegs: [
                {
                  id: "leg-conflict-options",
                  fromActivityId: fromActivity!.id,
                  toActivityId: toActivity!.id,
                  mode: "walking",
                  distanceMeters: 1300,
                  durationMinutes: 45,
                  provider: "manual",
                  routeStatus: "manual",
                  summary: "步行含等待",
                  manualOverride: true,
                  polyline: [],
                  steps: []
                }
              ]
            }
          : candidateDay
      )
    };
    const delayed = {
      ...withConflict,
      days: withConflict.days.map((candidateDay) =>
        candidateDay.id === day.id
          ? {
              ...candidateDay,
              activities: candidateDay.activities.map((activity) =>
                activity.id === toActivity!.id ? { ...activity, startTime: "11:45", endTime: "12:45" } : activity
              )
            }
          : candidateDay
      )
    };
    const agentRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [withConflict] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills") || url.includes("/api/agent/sessions")) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/run-stream")) {
          return new Response("", { status: 503 });
        }
        if (url.includes("/api/agent/run")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string };
          const requestText = body.message ?? "";
          agentRequests.push(requestText);
          const optionResponse = {
            itinerary: withConflict,
            message: {
              role: "assistant",
              content: [
                "西湖晨间散步 到 湖滨咖啡 这段路线会在 11:45 左右到达，晚于湖滨咖啡 的 11:30。",
                "",
                "可选方案：",
                "1. 顺延下一项：把 湖滨咖啡 调整到 11:45 开始，后续时间不自动改变。",
                "2. 缩短上一站：把 西湖晨间散步 提前结束，保留 湖滨咖啡 原开始时间。",
                "3. 改用更快交通方式：比较步行、公交/地铁、驾车和骑行，选择耗时最短的一种，不改活动时间。",
                "",
                "你选其中一种后，我再更新画布。"
              ].join("\n")
            },
            diff: []
          };
          const delayedResponse = {
            itinerary: delayed,
            message: { role: "assistant", content: "已更新行程。" },
            diff: ["已顺延活动：湖滨咖啡 到 11:45"]
          };
          return new Response(JSON.stringify(requestText.includes("延后下一项") ? delayedResponse : optionResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "西湖晨间散步到湖滨咖啡这段交通会晚到，先给我几个调整方案，暂时不要改画布。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/路线会在 11:45 左右到达/)).toBeInTheDocument();
    const optionGroup = screen.getByRole("group", { name: "路线调整方案" });
    expect(within(optionGroup).getByRole("button", { name: "执行方案：顺延下一项" })).toBeInTheDocument();
    expect(within(optionGroup).getByRole("button", { name: "执行方案：缩短上一站" })).toBeInTheDocument();
    expect(within(optionGroup).getByRole("button", { name: "执行方案：改用更快交通方式" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "本轮改动" })).not.toBeInTheDocument();

    await user.click(within(optionGroup).getByRole("button", { name: "执行方案：顺延下一项" }));

    await waitFor(() => {
      expect(agentRequests.at(-1)).toBe("西湖晨间散步到湖滨咖啡这段交通会晚到，帮我延后下一项。");
    });
    const diffBlock = await screen.findByRole("group", { name: "本轮改动" });
    expect(within(diffBlock).getByText("已顺延活动：湖滨咖啡 到 11:45")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑湖滨咖啡" }));
    expect(screen.getByLabelText("湖滨咖啡 的开始时间")).toHaveValue("11:45");
  });

  it("shows agent orchestration evidence in the evaluation backend", async () => {
    const seed = createSeedItinerary();
    const skills = createSeedSkills();
    window.history.replaceState(null, "", "#/evaluation");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/itineraries")) {
          return new Response(JSON.stringify({ items: [seed] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills")) {
          return new Response(JSON.stringify({ items: skills }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/agent/sessions")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "session-agent-evidence",
                  itineraryId: seed.id,
                  importedSkillIds: ["skill-slow-citywalk"],
                  contextSummary: "用户请求：补 Day 2 室内活动；当前行程：杭州三日松弛游",
                  userPreferenceSummary: "慢节奏、咖啡、少走路",
                  messages: [
                    { id: "msg-u", role: "user", content: "补 Day 2 室内活动", createdAt: "2026-06-15T10:00:00.000Z" },
                    { id: "msg-a", role: "assistant", content: "已更新行程。", createdAt: "2026-06-15T10:00:02.000Z" }
                  ],
                  traces: [],
                  createdAt: "2026-06-15T10:00:00.000Z",
                  updatedAt: "2026-06-15T10:00:02.000Z"
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/agent/traces")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "trace-main",
                  sessionId: "session-agent-evidence",
                  agent: "MainAgent",
                  type: "message",
                  title: "读取行程上下文",
                  detail: "杭州三日松弛游 / 3 天",
                  createdAt: "2026-06-15T10:00:00.000Z"
                },
                {
                  id: "trace-style",
                  sessionId: "session-agent-evidence",
                  agent: "StyleAgent",
                  type: "tool_call",
                  title: "读取已导入 Skill",
                  detail: "慢节奏街区漫步",
                  createdAt: "2026-06-15T10:00:01.000Z"
                },
                {
                  id: "trace-weather",
                  sessionId: "session-agent-evidence",
                  agent: "WeatherAgent",
                  type: "tool_call",
                  title: "检查天气约束",
                  detail: "高德天气返回多云",
                  createdAt: "2026-06-15T10:00:02.000Z"
                },
                {
                  id: "trace-transport",
                  sessionId: "session-agent-evidence",
                  agent: "TransportAgent",
                  type: "tool_call",
                  title: "检查路线可行性",
                  detail: "计算相邻活动路线",
                  createdAt: "2026-06-15T10:00:03.000Z"
                },
                {
                  id: "trace-planner",
                  sessionId: "session-agent-evidence",
                  agent: "PlannerAgent",
                  type: "state_patch",
                  title: "生成结构化行程补丁",
                  detail: "补全空白时段",
                  createdAt: "2026-06-15T10:00:04.000Z"
                },
                {
                  id: "trace-critic",
                  sessionId: "session-agent-evidence",
                  agent: "CriticAgent",
                  type: "handoff",
                  title: "检查需求覆盖",
                  detail: "确认慢节奏和手动编辑保护",
                  createdAt: "2026-06-15T10:00:05.000Z"
                }
              ]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "评估后台" })).toBeInTheDocument();
    expect(await screen.findByText("最近 Agent 运行")).toBeInTheDocument();
    expect(screen.getByText("用户请求：补 Day 2 室内活动；当前行程：杭州三日松弛游")).toBeInTheDocument();
    expect(screen.getByText("慢节奏、咖啡、少走路")).toBeInTheDocument();
    expect(screen.getAllByText("慢节奏街区漫步").length).toBeGreaterThan(0);
    expect(screen.getAllByText("主 Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("风格 Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("天气 Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("交通 Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("规划 Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("校验 Agent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("检查路线可行性").length).toBeGreaterThan(0);
  });

  it("opens the skill plaza and shows recommendations", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill 广场" }));
    expect(screen.getByText("推荐风格")).toBeInTheDocument();
    expect(screen.getByText("慢节奏街区漫步")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "当前行程使用的旅行风格" })).toHaveTextContent("还未选择旅行风格");
    expect(screen.getByLabelText("慢节奏街区漫步视觉：街区漫步")).toBeInTheDocument();
    expect(screen.getByLabelText("慢节奏街区漫步适配当前行程的原因")).toHaveTextContent("匹配当前偏好：慢节奏、咖啡、citywalk");
    expect(screen.queryByRole("button", { name: "打开慢节奏街区漫步标签编辑" })).not.toBeInTheDocument();
  });

  it("keeps the traveler-facing workbench copy free of internal implementation labels", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/itineraries/") && url.includes("/export")) {
          return new Response("# 杭州三日松弛游\n\n可分享行程", {
            status: 200,
            headers: { "Content-Type": "text/markdown" }
          });
        }
        return new Response("Not found", { status: 404 });
      })
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:journey-export"),
      revokeObjectURL: vi.fn()
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(screen.getByRole("heading", { name: "旅行助手" })).toBeInTheDocument();
    expect(screen.queryByText(/导入后会参与右侧对话和中间画布更新/)).not.toBeInTheDocument();
    expect(screen.queryByText(/导入后会作为本次规划的偏好依据/)).not.toBeInTheDocument();
    expect(screen.queryByText(/选择后会参与当前行程规划/)).not.toBeInTheDocument();
    expect(screen.queryByText(/高德地图已加载/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent 输入/)).not.toBeInTheDocument();
    expect(screen.queryByText(/让 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预算与交通可手动调整/)).not.toBeInTheDocument();
    expect(screen.queryByText(/交通备注/)).not.toBeInTheDocument();
    expect(screen.queryByText(/先为下方安排选择地点/)).not.toBeInTheDocument();
    expect(screen.queryByText(/打开下方安排继续补全/)).not.toBeInTheDocument();
    expect(screen.queryByText("偏好记忆")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览风格" })).toBeInTheDocument();
    expect(screen.queryByText("发送后会更新画布；本轮改动会在下一条消息里列出，可定位和撤销。")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "旅行助手建议" })).toBeInTheDocument();
    expect(screen.getByText("试试这些需求")).toBeInTheDocument();
    const suggestion = screen.getByRole("button", { name: "Day 2 下午补一个室内景点，节奏轻松一点" });
    expect(suggestion).toHaveClass("min-h-11");
    await user.click(suggestion);
    expect(screen.getByLabelText("对行程的修改需求")).toHaveValue("Day 2 下午补一个室内景点，节奏轻松一点");
    expect(screen.queryByText(/当前风格 \d+ 个/)).not.toBeInTheDocument();
    expect(screen.queryByText("开发与答辩")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "评估后台" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "答辩评估" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入慢节奏街区漫步/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "导出" }));
    expect(await screen.findByRole("heading", { name: "旅行结果" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "导出预览" })).toHaveTextContent("可分享行程");
    expect(screen.queryByText("完整行程 Markdown，可用于分享或归档。")).not.toBeInTheDocument();
    expect(screen.queryByText(/答辩或分享/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回编辑" }));
    expect(screen.getByRole("heading", { name: "旅行助手" })).toBeInTheDocument();

    await user.clear(screen.getByLabelText("对行程的修改需求"));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，别太赶。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getAllByText(/已更新行程/).length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Day 2" }));
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.getByText("助手建议")).toBeInTheDocument();
  });

  it("keeps workbench status chips and route commands task-oriented", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "浏览风格" }));
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));

    expect(screen.queryByText("当前风格 1 个")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移出当前风格 慢节奏街区漫步" })).toHaveClass("size-9");
    expect(screen.queryByText("已用 1 个风格")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /补全 .*路线/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "补全路线" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新路线" })).not.toBeInTheDocument();
    expect(screen.queryByText("高德路线")).not.toBeInTheDocument();
    expect(screen.queryByText("路线、距离和耗时来自高德")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));
    expect(screen.queryByRole("button", { name: "重新规划" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新规划路线" })).toBeInTheDocument();
  });

  it("keeps global header actions separate from day planning actions", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const headerActions = screen.getByTestId("workbench-header-actions");
    expect(within(headerActions).queryByRole("button", { name: "前加一天" })).not.toBeInTheDocument();
    expect(within(headerActions).queryByRole("button", { name: "后加一天" })).not.toBeInTheDocument();
    expect(within(headerActions).getByRole("button", { name: "导出" })).toBeInTheDocument();
    expect(within(headerActions).getByRole("button", { name: "编辑行程信息" })).toBeInTheDocument();

    const contextBar = screen.getByRole("navigation", { name: "行程日期和当前编辑上下文" });
    expect(within(contextBar).getByRole("button", { name: "前加一天" })).toBeInTheDocument();
    expect(within(contextBar).getByRole("button", { name: "后加一天" })).toBeInTheDocument();
    expect(within(contextBar).getByRole("button", { name: "添加活动" })).toBeInTheDocument();
    expect(screen.getByTestId("trip-info-summary")).toHaveClass("hidden");
    expect(screen.getByTestId("map-canvas")).toHaveClass("min-h-[160px]");
    expect(screen.getByTestId("map-overview-panel")).toHaveClass("hidden");
    expect(screen.getByTestId("map-overview-panel")).toHaveClass("sm:block");
  });

  it("can add a new date before the selected date", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "前加一天" }));

    expect(screen.getByRole("button", { name: "Day 4" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Day 1" })).toBeInTheDocument();
    expect(screen.getByText("2026-06-30 · 0 项安排 · 暂无路线")).toBeInTheDocument();
    expect(screen.getByText("这一天还没有安排")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Day 2" }));
    expect(screen.getByRole("listitem", { name: /第 1 站：西湖晨间散步/ })).toBeInTheDocument();
  });

  it("summarizes incomplete nonblank activities without repeating missing field labels", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));
    await user.type(await screen.findByLabelText("第 3 项活动名称"), "雨天咖啡休息");
    await user.click(screen.getByRole("button", { name: "完成编辑" }));

    const timelineItem = screen.getByRole("listitem", { name: /第 3 站：雨天咖啡休息/ });
    expect(within(timelineItem).getByText("待补地点与时间")).toBeInTheDocument();
    expect(within(timelineItem).queryByText("未设置地点")).not.toBeInTheDocument();
    expect(within(timelineItem).queryByText("未设置时间")).not.toBeInTheDocument();
    expect(within(timelineItem).queryByText("未设置预算")).not.toBeInTheDocument();
    expect(within(timelineItem).getByRole("button", { name: "编辑雨天咖啡休息" })).toHaveTextContent("编辑");
    expect(within(timelineItem).queryByRole("button", { name: /正在编辑/ })).not.toBeInTheDocument();
  });

  it("keeps repeated blank activity cards visually quiet and keeps the map empty state actionable", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "Day 2" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));

    expect(screen.getByText("2 项安排缺少地点")).toBeInTheDocument();
    expect(screen.getByText("从搜索结果加入真实地点，或编辑下方安排。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加待补全安排" })).not.toBeInTheDocument();
    expect(screen.queryByText("搜索地点，或打开下方安排继续补全。")).not.toBeInTheDocument();

    const blankItems = screen.getAllByRole("listitem", { name: /第 \d 项安排/ });
    expect(blankItems.length).toBe(2);
    blankItems.forEach((item) => {
      expect(within(item).queryByText("待补地点与时间")).not.toBeInTheDocument();
      expect(within(item).queryByText("待补全")).not.toBeInTheDocument();
    });
  });

  it("keeps compact workbench controls sized to their content", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const contextBar = screen.getByRole("navigation", { name: "行程日期和当前编辑上下文" });
    const dayActionRow = contextBar.firstElementChild;
    expect(dayActionRow).toHaveClass("w-full");
    expect(dayActionRow).toHaveClass("max-w-full");
    expect(dayActionRow).toHaveClass("flex-wrap");
    expect(dayActionRow).toHaveClass("justify-between");
    expect(dayActionRow).not.toHaveClass("grid");

    const dayPicker = within(contextBar).getByRole("button", { name: "Day 1" }).parentElement;
    const dayPickerWrapper = dayPicker?.parentElement;
    expect(dayPickerWrapper).toHaveClass("w-fit");
    expect(dayPickerWrapper).toHaveClass("max-w-full");
    expect(dayPicker).toHaveClass("w-fit");
    expect(dayPicker).toHaveClass("max-w-full");
    expect(dayPicker).toHaveClass("h-10");

    const addButton = within(contextBar).getByRole("button", { name: "添加活动" });
    const dayActions = addButton.parentElement;
    expect(dayActions).toHaveClass("ml-auto");
    expect(dayActions).toHaveClass("justify-end");
    expect(within(contextBar).getByRole("button", { name: "前加一天" })).toHaveClass("h-10");
    expect(within(contextBar).getByRole("button", { name: "后加一天" })).toHaveClass("h-10");
    expect(addButton).toHaveClass("h-10");

    const daySummaryRow = dayActionRow?.nextElementSibling;
    expect(daySummaryRow).toHaveClass("min-h-11");
    expect(daySummaryRow).toHaveClass("items-center");

    const dragHandle = screen.getByRole("button", { name: "拖动西湖晨间散步调整顺序" });
    expect(dragHandle).toHaveClass("border-0");
    expect(dragHandle).toHaveClass("bg-transparent");
    expect(dragHandle.className).not.toContain("bg-[#f6f6f3]");

    const activityHeading = screen.getByRole("heading", { name: "西湖晨间散步" });
    expect(activityHeading.parentElement?.parentElement).toHaveClass("self-center");
    expect(activityHeading.parentElement).toHaveClass("items-center");
    expect(activityHeading.parentElement).toHaveClass("grid");
    expect(activityHeading.parentElement?.parentElement?.parentElement).toHaveClass("grid-cols-[44px_minmax(0,1fr)_auto]");
    expect(activityHeading.parentElement?.parentElement?.parentElement).toHaveClass("min-[1180px]:grid-cols-[44px_minmax(190px,0.86fr)_minmax(180px,1fr)_minmax(132px,auto)_auto]");
    const activityMetaRow = activityHeading.nextElementSibling;
    expect(activityMetaRow).toHaveClass("flex-wrap");
    expect(activityMetaRow).toHaveTextContent("景点");

    expect(screen.getByRole("button", { name: "当前日期" }).parentElement).toHaveClass("h-10");
    expect(screen.getByRole("button", { name: "当前日期" })).toHaveClass("h-10");
    expect(screen.getByRole("button", { name: "全部行程" })).toHaveClass("h-10");
    expect(screen.getByRole("button", { name: "搜索地点" })).toHaveClass("h-10");
  });

  it("keeps route cards visually separated from the timeline background", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const routeCard = screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" });
    expect(routeCard).toHaveClass("border");
    expect(routeCard).toHaveClass("border-[#e5e5e0]");
    expect(routeCard).toHaveClass("bg-[#f6f6f3]");
    expect(routeCard.className).not.toContain("shadow");
    expect(within(routeCard).getByRole("button", { name: "在地图中查看路线：西湖晨间散步 到 湖滨咖啡" })).toHaveClass("size-8");
    expect(within(routeCard).getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" })).toHaveClass("size-8");
  });

  it("uses Pinterest warm surfaces and restrained red accents in the workbench", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const workbenchScroll = screen.getByTestId("workbench-scroll");
    expect(workbenchScroll).toHaveClass("bg-[#fbfbf9]");

    const mapPanel = screen.getByTestId("map-panel");
    expect(mapPanel).toHaveClass("border-[#dadad3]");
    expect(mapPanel).toHaveClass("bg-white");
    expect(mapPanel.className).not.toContain("shadow");

    const contextBar = screen.getByRole("navigation", { name: "行程日期和当前编辑上下文" });
    expect(contextBar).toHaveClass("border-[#dadad3]");
    expect(contextBar).toHaveClass("bg-white");
    expect(within(contextBar).getByRole("button", { name: "Day 1" })).toHaveClass("bg-primary");
    expect(within(contextBar).getByRole("button", { name: "添加活动" })).toHaveClass("bg-primary");

    const activityCard = screen.getByTestId("activity-drop-0");
    expect(activityCard).toHaveClass("border-[#dadad3]");
    expect(activityCard).toHaveClass("bg-white");

    const routeCard = screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" });
    expect(routeCard).toHaveClass("border-[#e5e5e0]");
    expect(routeCard).toHaveClass("bg-[#f6f6f3]");
    expect(routeCard.className).not.toContain("shadow");
  });

  it("keeps the assistant as a rail whenever the viewport is wider than 768px", async () => {
    const user = userEvent.setup();
    const { getByTestId } = render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(getByTestId("app-shell")).toHaveClass(
      "min-[769px]:grid-cols-[minmax(0,1fr)_clamp(440px,46vw,500px)]"
    );
    expect(getByTestId("app-shell")).toHaveClass(
      "lg:grid-cols-[72px_minmax(0,1fr)_clamp(440px,38vw,540px)]"
    );
    expect(getByTestId("app-shell")).toHaveClass(
      "2xl:grid-cols-[280px_minmax(0,1fr)_clamp(520px,30vw,620px)]"
    );
    expect(getByTestId("app-shell")).toHaveClass("h-dvh");
    expect(getByTestId("app-shell")).toHaveClass("overflow-hidden");
    expect(getByTestId("workbench-main")).toHaveClass("overflow-hidden");
    expect(getByTestId("workbench-scroll")).toHaveClass("overflow-auto");
    expect(getByTestId("app-shell").className).not.toContain("min-[1360px]:grid-cols");
    expect(getByTestId("app-shell").className).not.toContain("xl:grid-cols-[248px_minmax(0,1fr)_340px]");
    expect(getByTestId("app-shell").className).not.toContain("_320px");
    expect(getByTestId("app-shell").className).not.toContain("_380px");
    expect(screen.getByRole("button", { name: "打开旅行助手" })).toHaveClass("min-[769px]:hidden");

    const panelShell = getByTestId("agent-panel-shell");
    expect(panelShell).toHaveClass("hidden");
    expect(panelShell).toHaveClass("z-[1000]");
    expect(panelShell).toHaveClass("w-full");
    expect(panelShell).toHaveClass("sm:w-[min(440px,calc(100vw-24px))]");
    expect(panelShell).toHaveClass("min-[769px]:block");
    expect(panelShell).toHaveClass("min-[769px]:static");
    expect(panelShell).toHaveClass("min-[769px]:w-auto");
    expect(screen.getByRole("button", { name: "关闭旅行助手" })).toHaveClass("min-[769px]:hidden");

    await user.click(screen.getByRole("button", { name: "打开旅行助手" }));
    expect(getByTestId("agent-backdrop")).toHaveClass("min-[769px]:hidden");
    expect(getByTestId("agent-backdrop")).toHaveClass("z-[900]");
  });

  it("opens Skill browse as a temporary chooser and closes it after applying a style", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "浏览风格" }));

    const styleChooser = screen.getByRole("dialog", { name: "旅行风格选择" });
    expect(styleChooser).toBeInTheDocument();
    expect(screen.getByTestId("skill-browser-backdrop")).toHaveClass("fixed");
    expect(screen.getByTestId("skill-browser-backdrop")).toHaveClass("z-[1200]");
    expect(screen.getByTestId("skill-browser-panel")).toHaveClass("absolute");
    expect(screen.getByTestId("skill-browser-panel")).toHaveClass("max-w-[460px]");
    expect(styleChooser.className).not.toContain("max-h-[36vh]");
    expect(screen.queryByText("选择后，下一轮建议会参考它。")).not.toBeInTheDocument();
    expect(within(styleChooser).getAllByText("适合当前行程").length).toBeGreaterThan(0);
    expect(within(styleChooser).getByText("匹配当前偏好：慢节奏、咖啡、citywalk")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "旅行风格选择" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "移出当前风格 慢节奏街区漫步" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前风格对规划的影响" })).not.toBeInTheDocument();
    expect(screen.queryByText("已使用「慢节奏街区漫步」。")).not.toBeInTheDocument();
    expect(screen.queryByText("适配当前行程")).not.toBeInTheDocument();
    expect(screen.queryByText("优先遵循")).not.toBeInTheDocument();
    expect(screen.queryByText(/后续规划会避开：连续三个重体力景点/)).not.toBeInTheDocument();
    expect(screen.queryByText("本轮改动")).not.toBeInTheDocument();
  });

  it("keeps imported skills as removable chips without exposing planning internals", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "浏览风格" }));
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "旅行风格选择" })).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "浏览风格" }));
    await user.click(screen.getByRole("button", { name: "使用 亲子博物馆路线" }));

    expect(screen.getByRole("button", { name: "移出当前风格 慢节奏街区漫步" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移出当前风格 亲子博物馆路线" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前风格对规划的影响" })).not.toBeInTheDocument();
    expect(screen.queryByText("规则取舍详情")).not.toBeInTheDocument();
    expect(screen.queryByText(/慢节奏街区漫步 × 亲子博物馆路线/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent|trace|tool|上下文|主 Agent/i)).not.toBeInTheDocument();
  });

  it("keeps activity editing and route editing mutually focused", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    expect(screen.getByLabelText("第 1 项活动名称")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    expect(screen.getByText("路线结果")).toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 项活动名称")).not.toBeInTheDocument();
  });

  it("keeps the current day and selected canvas object anchored while planning", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const contextBar = screen.getByRole("navigation", { name: "行程日期和当前编辑上下文" });
    expect(contextBar).not.toHaveClass("sticky");
    expect(contextBar).not.toHaveClass("-top-4");
    expect(contextBar).not.toHaveClass("md:-top-5");
    expect(contextBar).not.toHaveClass("z-30");
    expect(contextBar).not.toHaveClass("backdrop-blur");
    expect(contextBar).toHaveTextContent("Day 1");
    expect(contextBar).toHaveTextContent("2026-07-01");
    expect(contextBar).toHaveTextContent("2 项安排");
    await waitFor(() => {
      expect(contextBar).toHaveTextContent("1/1 段路线");
    });
    expect(within(contextBar).queryByTestId("selected-canvas-context")).not.toBeInTheDocument();
    expect(contextBar).not.toHaveTextContent("当前日期");
    expect(contextBar).not.toHaveTextContent("选择活动或路线查看详情");
    expect(contextBar).not.toHaveTextContent("先添加当天安排");

    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));

    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("正在编辑");
    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("西湖晨间散步");
    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("09:00-11:00");
    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("西湖");

    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("正在查看");
    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("西湖晨间散步 到 湖滨咖啡");
    expect(within(contextBar).getByTestId("selected-canvas-context")).toHaveTextContent("步行");
  });

  it("lets a user reorder activities in the day timeline without the assistant", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(screen.getByRole("listitem", { name: /第 1 站：西湖晨间散步/ })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /第 2 站：湖滨咖啡/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拖动湖滨咖啡调整顺序" })).toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 项活动名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("西湖晨间散步 的地点")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("西湖晨间散步 的活动内容")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上移湖滨咖啡" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除湖滨咖啡" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    expect(screen.getByLabelText("第 1 项活动名称")).toHaveValue("西湖晨间散步");
    expect(screen.getByLabelText("西湖晨间散步 的地点")).toBeInTheDocument();
    expect(screen.getByLabelText("西湖晨间散步 的活动内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下移西湖晨间散步" })).toHaveClass("size-9");
    expect(screen.getByRole("button", { name: "删除西湖晨间散步" })).toHaveClass("size-9");

    await user.click(screen.getByRole("button", { name: "编辑湖滨咖啡" }));
    await user.click(screen.getByRole("button", { name: "上移湖滨咖啡" }));

    await waitFor(() => {
      expect(screen.getByRole("listitem", { name: /第 1 站：湖滨咖啡/ })).toBeInTheDocument();
    });
    expect(screen.getByRole("listitem", { name: /第 2 站：西湖晨间散步/ })).toBeInTheDocument();
  });

  it("supports dragging an activity onto another position in the day timeline", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const dragStore = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn((type: string, value: string) => dragStore.set(type, value)),
      getData: vi.fn((type: string) => dragStore.get(type) ?? "")
    };

    fireEvent.dragStart(screen.getByRole("button", { name: "拖动湖滨咖啡调整顺序" }), { dataTransfer });
    expect(screen.getByTestId("activity-drop-1")).toHaveAttribute("data-dragging", "true");
    expect(screen.getByTestId("activity-drop-0")).toHaveAttribute("data-drop-target", "false");

    fireEvent.dragOver(screen.getByTestId("activity-drop-1"), { dataTransfer });
    expect(screen.getByTestId("activity-drop-1")).toHaveAttribute("data-drop-target", "false");

    fireEvent.dragOver(screen.getByTestId("activity-drop-0"), { dataTransfer });
    expect(screen.getByTestId("activity-drop-0")).toHaveAttribute("data-drop-target", "true");
    expect(screen.getByTestId("activity-drop-indicator-0")).toBeInTheDocument();

    fireEvent.drop(screen.getByTestId("activity-drop-0"), { dataTransfer });

    await waitFor(() => {
      expect(screen.getByRole("listitem", { name: /第 1 站：湖滨咖啡/ })).toBeInTheDocument();
    });
    expect(screen.getByRole("listitem", { name: /第 2 站：西湖晨间散步/ })).toBeInTheDocument();
    expect(screen.queryByTestId("activity-drop-indicator-0")).not.toBeInTheDocument();
  });

  it("lets a user move an activity to another day without the assistant", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    const daySelect = screen.getByLabelText("西湖晨间散步 的日期");
    await user.selectOptions(daySelect, within(daySelect).getByRole("option", { name: "Day 2" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Day 2" })).toBeInTheDocument();
    });
    expect(screen.getByRole("listitem", { name: /西湖晨间散步/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Day 1" }));
    expect(screen.queryByRole("listitem", { name: /西湖晨间散步/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Day 2" }));
    expect(screen.getByRole("listitem", { name: /西湖晨间散步/ })).toBeInTheDocument();
  });

  it("lets a user keep a personal favorites list in the skill plaza", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill 广场" }));
    expect(screen.getByText("18 人收藏")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收藏慢节奏街区漫步" })).toHaveTextContent("收藏");
    expect(screen.getByRole("button", { name: "收藏慢节奏街区漫步" })).not.toHaveTextContent("18");
    await user.click(screen.getByRole("button", { name: "收藏慢节奏街区漫步" }));
    await user.click(screen.getByRole("button", { name: "我的收藏" }));

    expect(screen.getByText("慢节奏街区漫步")).toBeInTheDocument();
    expect(screen.getByText("19 人收藏")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消收藏慢节奏街区漫步" })).toBeInTheDocument();
  });

  it("keeps tag editing out of regular skill browsing cards", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill 广场" }));
    expect(screen.queryByRole("button", { name: "打开慢节奏街区漫步标签编辑" })).not.toBeInTheDocument();
  });

  it("imports a custom Skill.md into the current itinerary and shows its applied rules to the assistant", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill 广场" }));
    await user.click(screen.getByRole("button", { name: "导入风格" }));
    const importDialog = screen.getByRole("dialog", { name: "导入旅行风格" });
    expect(within(importDialog).queryByText(/SKILL\.md/i)).not.toBeInTheDocument();
    expect(within(importDialog).getByText("粘贴旅行风格内容，校验通过后保存到风格库。")).toBeInTheDocument();
    await user.type(
      within(importDialog).getByLabelText("粘贴风格内容"),
      [
        "---",
        "name: rainy-cafe-style",
        "description: 适合雨天、咖啡、室内和不赶路的旅行风格",
        "---",
        "",
        "# Rainy Cafe Style",
        "",
        "## 规划规则",
        "- 雨天优先室内景点和咖啡休息",
        "- 每两段活动之间预留休息",
        "",
        "## 禁止模式",
        "- 暴雨时安排长距离户外步行"
      ].join("\n")
    );
    expect(within(importDialog).queryByText(/Skill\.md 标准/)).not.toBeInTheDocument();
    await user.click(within(importDialog).getByRole("button", { name: "用于当前行程" }));

    await waitFor(() => {
      expect(screen.getAllByText("Rainy Cafe Style").length).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "导入旅行风格" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "打开Rainy Cafe Style标签编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移出Rainy Cafe Style风格" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "打开当前行程：杭州三日松弛游" }));
    expect(screen.getByRole("button", { name: "移出当前风格 Rainy Cafe Style" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前风格对规划的影响" })).not.toBeInTheDocument();
    expect(screen.queryByText(/后续规划会避开：暴雨时安排长距离户外步行/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "浏览风格" }));
    expect(screen.getAllByText("Rainy Cafe Style").length).toBeGreaterThan(1);
    expect(screen.queryByText(/避免：暴雨时安排长距离户外步行/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移出 Rainy Cafe Style" }));

    expect(screen.queryByRole("button", { name: "移出当前风格 Rainy Cafe Style" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 Rainy Cafe Style" })).toBeInTheDocument();
  });

  it("blocks incomplete travel style imports before they reach the itinerary", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill 广场" }));
    await user.click(screen.getByRole("button", { name: "导入风格" }));
    const importDialog = screen.getByRole("dialog", { name: "导入旅行风格" });
    const submit = within(importDialog).getByRole("button", { name: "用于当前行程" });

    await user.type(
      within(importDialog).getByLabelText("粘贴风格内容"),
      ["---", "name: loose-travel-notes", "---", "", "只是一些游记片段，还没有整理成规划规则。"].join("\n")
    );

    expect(within(importDialog).getByText("格式检查")).toBeInTheDocument();
    expect(within(importDialog).getByText("需要填写 description")).toBeInTheDocument();
    expect(within(importDialog).getByText("至少添加一条规划规则")).toBeInTheDocument();
    expect(submit).toBeDisabled();
  });

  it("starts the Skill creator agent and shows only the current question during interview", async () => {
    let startBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          startBody = JSON.parse(String(init?.body ?? "{}"));
          const turn = creatorTurn();
          return new Response(JSON.stringify({ session: creatorSession({ currentTurn: turn }), turn }), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.click(screen.getByRole("button", { name: "使用当前行程" }));
    expect((screen.getByLabelText("来源材料") as HTMLTextAreaElement).value).toContain("西湖晨间散步");

    await user.click(screen.getByRole("button", { name: "开始创作" }));

    await waitFor(() => {
      expect(startBody).toMatchObject({
        itineraryId: expect.any(String),
        sourceText: expect.stringContaining("西湖晨间散步")
      });
    });
    expect(screen.getByText("创作助手")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "这套旅行风格最适合在哪类请求里触发？" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第一次到海边城市" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "想慢慢逛小店" })).toBeInTheDocument();
    expect(screen.getByLabelText("补充答案")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "创作 Skill" })).not.toBeInTheDocument();
    expect(screen.queryByText("把旅行经验交给创作助手，由它主持问题并生成可发布的旅行风格。")).not.toBeInTheDocument();
    expect(screen.queryByText("单选，也可以补充自己的说法")).not.toBeInTheDocument();
    expect(screen.queryByText("多选，也可以补充自己的说法")).not.toBeInTheDocument();
    expect(screen.queryByText("问题 1")).not.toBeInTheDocument();
    expect(screen.queryByText("第 1 题")).not.toBeInTheDocument();
    expect(screen.queryByText("1/3")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "创作对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "最终 Skill 产物" })).not.toBeInTheDocument();
    expect(screen.queryByText(/frontmatter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SKILL\.md/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Skill 名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Skill 正文")).not.toBeInTheDocument();
  });

  it("submits multi-option Skill creator answers with custom input to the session reply endpoint", async () => {
    const replyBodies: unknown[] = [];
    const multiTurn = creatorTurn({
      question: "哪些做法要稳定保留？",
      mode: "multiple",
      progressPercent: 50,
      options: [
        { id: "small-shops", label: "保留傍晚小店" },
        { id: "sea-walks", label: "安排海边散步" },
        { id: "low-density", label: "每天少排一点" }
      ]
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          return new Response(JSON.stringify({ session: creatorSession({ currentTurn: multiTurn }), turn: multiTurn }), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills/creator/creator-session-1/reply")) {
          replyBodies.push(JSON.parse(String(init?.body ?? "{}")));
          const nextTurn = creatorTurn({ question: "哪些安排应该避免？", progressPercent: 75 });
          return new Response(JSON.stringify({ session: creatorSession({ currentTurn: nextTurn }), turn: nextTurn }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.type(screen.getByLabelText("来源材料"), "海边散步、傍晚小店、不要赶路。");
    await user.click(screen.getByRole("button", { name: "开始创作" }));
    await user.click(await screen.findByRole("button", { name: "保留傍晚小店" }));
    await user.click(screen.getByRole("button", { name: "安排海边散步" }));
    await user.type(screen.getByLabelText("补充答案"), "每天最多两个核心安排");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => {
      expect(replyBodies).toHaveLength(1);
    });
    expect(replyBodies[0]).toEqual({
      selectedOptionIds: ["small-shops", "sea-walks"],
      customAnswer: "每天最多两个核心安排"
    });
    expect(screen.getByRole("heading", { name: "哪些安排应该避免？" })).toBeInTheDocument();
  });

  it("keeps final Skill markdown hidden until the final review is expanded", async () => {
    let publishBody: Partial<TravelSkill> = {};
    const doneTurn = creatorTurn({
      question: undefined,
      mode: undefined,
      options: undefined,
      progressPercent: 100,
      done: true
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          const turn = creatorTurn();
          return new Response(JSON.stringify({ session: creatorSession({ currentTurn: turn }), turn }), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills/creator/creator-session-1/reply")) {
          return new Response(
            JSON.stringify({ session: creatorSession({ currentTurn: doneTurn, status: "ready" }), turn: doneTurn }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/skills/skill-seaside-shop-style/publish")) {
          publishBody = JSON.parse(String(init?.body ?? "{}")) as Partial<TravelSkill>;
          return new Response(JSON.stringify({ skill: { ...creatorDraft(), ...publishBody, status: "published" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.type(screen.getByLabelText("来源材料"), "海边散步、傍晚小店、不要赶路。");
    await user.click(screen.getByRole("button", { name: "开始创作" }));
    await user.click(await screen.findByRole("button", { name: "第一次到海边城市" }));
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(await screen.findByText("海边小店松弛风格")).toBeInTheDocument();
    expect(screen.getByText("适合看海、逛小店、保留傍晚松弛时间的旅行风格。")).toBeInTheDocument();
    expect(screen.getByText("每天最多两个核心安排")).toBeInTheDocument();
    expect(screen.getByText("避免连续跨区")).toBeInTheDocument();
    expect(screen.queryByText(/name: seaside-shop-style/)).not.toBeInTheDocument();
    expect(screen.queryByText(/frontmatter/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SKILL\.md/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Skill 名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Skill 说明")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开最终 Skill 产物" }));

    expect(screen.getByLabelText("Skill 名称")).toHaveValue("海边小店松弛风格");
    expect(screen.getByLabelText("Skill 说明")).toHaveValue("适合看海、逛小店、保留傍晚松弛时间的旅行风格。");
    expect(screen.getByLabelText("Skill 标签")).toHaveValue("海边,小店,松弛");
    expect(screen.getByLabelText("规划规则")).toHaveValue("每天最多两个核心安排\n傍晚留给小店和日落");
    expect(screen.getByLabelText("不希望出现的安排")).toHaveValue("避免连续跨区\n不要午后暴晒长距离步行");
    await user.clear(screen.getByLabelText("Skill 名称"));
    expect(screen.getByRole("button", { name: "发布到广场" })).toBeDisabled();
    await user.type(screen.getByLabelText("Skill 名称"), "海边小店夜游风格");
    await user.clear(screen.getByLabelText("Skill 标签"));
    await user.type(screen.getByLabelText("Skill 标签"), "海边,夜游");
    await user.clear(screen.getByLabelText("Skill 说明"));
    await user.type(screen.getByLabelText("Skill 说明"), "适合看海和夜游小店。");
    await user.clear(screen.getByLabelText("规划规则"));
    await user.type(screen.getByLabelText("规划规则"), "每天保留夜游小店");
    await user.clear(screen.getByLabelText("不希望出现的安排"));
    await user.type(screen.getByLabelText("不希望出现的安排"), "避免午后暴晒长距离步行");
    await user.clear(screen.getByLabelText("Skill 正文"));
    await user.type(screen.getByLabelText("Skill 正文"), "把夜游小店和看海作为核心体验。");
    expect(screen.getByText(/name: seaside-shop-style/)).toBeInTheDocument();
    expect(screen.getByText(/SKILL\.md/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发布到广场" })).not.toBeDisabled();

    await user.click(screen.getByRole("button", { name: "发布到广场" }));

    await waitFor(() => {
      expect(publishBody).toMatchObject({
        displayName: "海边小店夜游风格",
        description: "适合看海和夜游小店。",
        body: "把夜游小店和看海作为核心体验。",
        tags: ["海边", "夜游"],
        rules: ["每天保留夜游小店"],
        forbidden: ["避免午后暴晒长距离步行"]
      });
    });
  });

  it("shows retryable Skill creator reply failures and preserves the pending answer", async () => {
    const replyBodies: unknown[] = [];
    let replyAttempts = 0;
    const multiTurn = creatorTurn({
      question: "哪些做法要稳定保留？",
      mode: "multiple",
      progressPercent: 50,
      options: [
        { id: "small-shops", label: "保留傍晚小店" },
        { id: "sea-walks", label: "安排海边散步" },
        { id: "low-density", label: "每天少排一点" }
      ]
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/skills/creator/start")) {
          return new Response(JSON.stringify({ session: creatorSession({ currentTurn: multiTurn }), turn: multiTurn }), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.includes("/api/skills/creator/creator-session-1/reply")) {
          replyAttempts += 1;
          replyBodies.push(JSON.parse(String(init?.body ?? "{}")));
          if (replyAttempts === 1) {
            return new Response(JSON.stringify({ error: "model unavailable" }), {
              status: 502,
              headers: { "Content-Type": "application/json" }
            });
          }
          const nextTurn = creatorTurn({ question: "哪些安排应该避免？", progressPercent: 75 });
          return new Response(JSON.stringify({ session: creatorSession({ currentTurn: nextTurn }), turn: nextTurn }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response("", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.type(screen.getByLabelText("来源材料"), "海边散步、傍晚小店、不要赶路。");
    await user.click(screen.getByRole("button", { name: "开始创作" }));
    await user.click(await screen.findByRole("button", { name: "保留傍晚小店" }));
    await user.type(screen.getByLabelText("补充答案"), "需要保留日落后的自由时间");
    await user.click(screen.getByRole("button", { name: "提交回答" }));

    expect(await screen.findByText("创作助手没有返回可用问题，请重试本题。")).toBeInTheDocument();
    expect(screen.getByLabelText("补充答案")).toHaveValue("需要保留日落后的自由时间");

    await user.click(screen.getByRole("button", { name: "提交回答" }));

    await waitFor(() => {
      expect(replyBodies).toHaveLength(2);
    });
    expect(replyBodies[1]).toEqual({
      selectedOptionIds: ["small-shops"],
      customAnswer: "需要保留日落后的自由时间"
    });
    expect(screen.getByRole("heading", { name: "哪些安排应该避免？" })).toBeInTheDocument();
  });

  it("lets a user manage preferences and clear assistant memory outside the chat panel", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "我喜欢慢节奏和咖啡，之后继续按这个偏好规划。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getAllByText(/已更新行程/).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("偏好记忆")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "偏好设置" }));
    expect(screen.getByRole("heading", { name: "偏好设置" })).toBeInTheDocument();
    expect(screen.getByLabelText("行程偏好")).toHaveValue("慢节奏, 咖啡, citywalk");
    expect(screen.getByText("节奏与强度")).toBeInTheDocument();
    expect(screen.getByText("餐饮与停留")).toBeInTheDocument();
    expect(screen.getByText("地点兴趣")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除偏好 咖啡" })).toBeInTheDocument();
    expect(screen.getByText("当前行程范围")).toBeInTheDocument();
    expect(screen.getByText("来源")).toBeInTheDocument();
    expect(screen.getByText("影响范围")).toBeInTheDocument();
    expect(screen.getByText("风格融合")).toBeInTheDocument();
    expect(screen.getByText(/最近请求/)).toBeInTheDocument();
    const preferenceEvidence = screen.getByRole("region", { name: "偏好来源明细" });
    expect(within(preferenceEvidence).getByTestId("preference-evidence-咖啡")).toHaveTextContent("当前行程");
    expect(within(preferenceEvidence).getByTestId("preference-evidence-咖啡")).toHaveTextContent("最近用于地点取舍");
    expect(within(preferenceEvidence).getByTestId("preference-evidence-慢节奏")).toHaveTextContent("最近对话");

    await user.click(screen.getByRole("button", { name: "清除餐饮与停留偏好" }));
    expect(screen.getByLabelText("行程偏好")).toHaveValue("慢节奏, citywalk");
    expect(screen.queryByRole("button", { name: "移除偏好 咖啡" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("preference-evidence-咖啡")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("添加行程偏好"), "少走路");
    await user.click(screen.getByRole("button", { name: "添加偏好" }));
    expect(screen.getByLabelText("行程偏好")).toHaveValue("慢节奏, citywalk, 少走路");

    const preferences = screen.getByLabelText("行程偏好");
    await user.clear(preferences);
    await user.type(preferences, "博物馆, 夜景, 少走路");
    await user.click(screen.getByRole("button", { name: "保存偏好" }));

    await waitFor(() => {
      expect(screen.getByText("博物馆、夜景、少走路")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "移除偏好 博物馆" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除偏好 少走路" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清除会话记忆" }));
    expect(screen.getByText("暂无会话记忆")).toBeInTheDocument();
    expect(screen.queryByText(/最近请求/)).not.toBeInTheDocument();
  });

  it("shows user-facing assistant progress and lets the user stop a running request", async () => {
    const requestText = "帮我补全 Day 2 下午，节奏轻松一点。";
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), requestText);
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(within(screen.getByTestId("agent-message-scroll")).getByText(requestText)).toBeInTheDocument();
    expect(screen.getByLabelText("对行程的修改需求")).toHaveValue("");
    const activityLog = screen.getByRole("group", { name: "Agent 执行记录" });
    expect(activityLog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Agent 执行记录/ })).toHaveAttribute("aria-expanded", "true");
    const thinkingPlaceholder = within(activityLog).getByTestId("agent-thinking-placeholder");
    expect(within(thinkingPlaceholder).getByText("思考中")).toBeInTheDocument();
    expect(within(thinkingPlaceholder).getByTestId("agent-thinking-spinner")).toBeInTheDocument();
    expect(screen.queryByText("公开思考摘要")).not.toBeInTheDocument();
    expect(screen.queryByText(`用户想要「${requestText}」，我需要先读取当前行程、风格和约束，再决定要调用哪些工具。`)).not.toBeInTheDocument();
    expect(screen.queryByText("正在理解你的需求")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => {
      expect(screen.getAllByText("已停止本次处理，行程没有改动。").length).toBeGreaterThan(0);
    });
    expect(within(screen.getByTestId("agent-message-scroll")).getByText(requestText)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "本轮改动" })).not.toBeInTheDocument();
    expect(screen.queryByText("慢节奏街区探索")).not.toBeInTheDocument();
  });

  it("shows a thinking spinner until real model output or tool calls arrive", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              }
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，节奏轻松一点。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const activityLog = await screen.findByRole("group", { name: "Agent 执行记录" });
    const thinkingPlaceholder = within(activityLog).getByTestId("agent-thinking-placeholder");
    expect(within(thinkingPlaceholder).getByText("思考中")).toBeInTheDocument();
    expect(within(thinkingPlaceholder).getByTestId("agent-thinking-spinner")).toBeInTheDocument();
    expect(within(activityLog).queryByText("等待模型输出或工具调用。")).not.toBeInTheDocument();
    expect(within(activityLog).queryByTestId("agent-support-status")).not.toBeInTheDocument();

    streamController?.close();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    });
  });

  it("renders real streamed model reasoning separately from numbered action steps", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(
                  encoder.encode(
                    `${sseChunk(
                      "activity",
                      testAgentRunEvent({
                        sequence: 1,
                        type: "thought_summary",
                        title: "模型思考",
                        detail: "我需要先判断 Day 2 下午是否有可调整空档。"
                      })
                    )}\n\n`
                  )
                );
              }
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，节奏轻松一点。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const activityLog = await screen.findByRole("group", { name: "Agent 执行记录" });
    const reasoning = within(activityLog).getByTestId("agent-reasoning-block");
    expect(within(reasoning).getByText("模型思考")).toBeInTheDocument();
    expect(within(reasoning).getByText("我需要先判断 Day 2 下午是否有可调整空档。")).toBeInTheDocument();
    expect(within(activityLog).queryByTestId("agent-primary-step-list")).not.toBeInTheDocument();
    expect(within(activityLog).queryByTestId("agent-support-status")).not.toBeInTheDocument();

    streamController?.close();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    });
  });

  it("renders streamed agent output and tool calls as a running timeline", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const longAgentOutput = [
      "让我检查当前行程空档。",
      "这段模型输出可能会比较长，需要限制在步骤内部滚动，而不是把整个助手输入区挤下去。",
      "我会继续保留工具调用记录。"
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(
                  encoder.encode(
                    `${sseChunk(
                      "activity",
                      testAgentRunEvent({
                        sequence: 1,
                        type: "assistant_message",
                        title: "行动输出",
                        detail: longAgentOutput
                      })
                    )}\n\n`
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    `${sseChunk(
                      "activity",
                      testAgentRunEvent({
                        sequence: 2,
                        type: "tool_call",
                        status: "running",
                        agent: "AttractionAgent",
                        title: "搜索地点",
                        detail: "室内景点",
                        technical: { input: { query: "室内景点" } }
                      })
                    )}\n\n`
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    `${sseChunk(
                      "activity",
                      testAgentRunEvent({
                        sequence: 3,
                        type: "tool_result",
                        agent: "AttractionAgent",
                        title: "搜索地点完成",
                        detail: "找到 3 个候选地点",
                        technical: { output: { count: 3 } }
                      })
                    )}\n\n`
                  )
                );
              }
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，节奏轻松一点。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("回复")).toBeInTheDocument();
    const activityLog = screen.getByRole("group", { name: "Agent 执行记录" });
    const primarySteps = within(activityLog).getByTestId("agent-primary-step-list");
    expect(within(primarySteps).queryByText("已分析用户请求")).not.toBeInTheDocument();
    expect(within(activityLog).queryByTestId("agent-support-status")).not.toBeInTheDocument();
    expect(within(primarySteps).getByText("回复")).toBeInTheDocument();
    expect(within(primarySteps).queryByText("对外输出")).not.toBeInTheDocument();
    expect(within(primarySteps).queryByText("主 Agent")).not.toBeInTheDocument();
    expect(within(primarySteps).getAllByText("搜索地点").length).toBeGreaterThan(0);
    expect(within(primarySteps).getAllByText("地点 Agent").length).toBeGreaterThan(0);
    expect(within(primarySteps).getByText("室内景点")).toBeInTheDocument();
    expect(within(primarySteps).getByText("工具结果")).toBeInTheDocument();
    const outputDetail = within(primarySteps).getByText((content) => content.includes("这段模型输出可能会比较长"));
    expect(outputDetail).toHaveClass("max-h-40");
    expect(outputDetail).toHaveClass("overflow-y-auto");
    expect(within(activityLog).getAllByText("技术详情").length).toBeGreaterThan(0);
    expect(within(activityLog).queryByText("AGENT_MAX_TURNS")).not.toBeInTheDocument();
    expect(screen.queryByText("正在连接助手，等待实时进度")).not.toBeInTheDocument();

    streamController?.close();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
    });
  });

  it("collapses completed agent activity while keeping the final reply and diff visible", async () => {
    const seed = createSeedItinerary();
    const updated = addActivity(seed, seed.days[1]!.id, {
      type: "attraction",
      title: "浙江省博物馆",
      placeName: "浙江省博物馆",
      startTime: "14:00",
      endTime: "16:00"
    });
    const runEvents = [
      testAgentRunEvent({
        sequence: 1,
        type: "assistant_message",
        title: "行动输出",
        detail: "让我搜索适合 Day 2 下午的室内景点。"
      }),
      testAgentRunEvent({
        sequence: 2,
        type: "tool_call",
        status: "running",
        agent: "AttractionAgent",
        title: "搜索地点",
        detail: "浙江省博物馆",
        technical: { input: { query: "浙江省博物馆" } }
      }),
      testAgentRunEvent({
        sequence: 3,
        type: "tool_result",
        agent: "AttractionAgent",
        title: "搜索地点完成",
        detail: "已找到浙江省博物馆",
        technical: { output: { name: "浙江省博物馆" } }
      }),
      testAgentRunEvent({
        sequence: 4,
        type: "state_patch",
        agent: "PlannerAgent",
        title: "写入行程",
        detail: "Day 2 下午新增浙江省博物馆"
      }),
      testAgentRunEvent({
        sequence: 5,
        type: "final_signal",
        agent: "CriticAgent",
        title: "完成本轮任务",
        detail: "已添加地点：浙江省博物馆"
      })
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            [
              ...runEvents.map((event) => sseChunk("activity", event)),
              `event: final\ndata: ${JSON.stringify({
                itinerary: updated,
                message: { role: "assistant", content: "我已经帮你把 Day 2 下午补成浙江省博物馆。" },
                diff: ["已添加地点：浙江省博物馆"],
                events: runEvents
              })}`,
              ""
            ].join("\n\n"),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "Day 2 下午补一个室内景点。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("我已经帮你把 Day 2 下午补成浙江省博物馆。")).toBeInTheDocument();
    const activityToggle = screen.getByRole("button", { name: /Agent 执行记录/ });
    expect(activityToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("已完成模型与工具调用 · 3 步")).toBeInTheDocument();
    expect(screen.queryByText("Day 2 下午新增浙江省博物馆")).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "本轮改动" })).getByText("已添加地点：浙江省博物馆")).toBeInTheDocument();

    await user.click(activityToggle);

    const activityLog = screen.getByRole("group", { name: "Agent 执行记录" });
    const primarySteps = within(activityLog).getByTestId("agent-primary-step-list");
    expect(within(primarySteps).queryByText("Day 2 下午新增浙江省博物馆")).not.toBeInTheDocument();
    expect(within(primarySteps).queryByText("写入画布")).not.toBeInTheDocument();
    expect(within(primarySteps).queryByText("完成信号")).not.toBeInTheDocument();
    expect(within(primarySteps).queryByText("已分析用户请求")).not.toBeInTheDocument();
    expect(within(activityLog).queryByTestId("agent-support-status")).not.toBeInTheDocument();
    expect(within(primarySteps).getByText("回复")).toBeInTheDocument();
    expect(within(primarySteps).queryByText("行动输出")).not.toBeInTheDocument();
    expect(within(primarySteps).queryByText("对外输出")).not.toBeInTheDocument();
    expect(within(primarySteps).queryByText("主 Agent")).not.toBeInTheDocument();
    expect(within(primarySteps).getByText("搜索地点")).toBeInTheDocument();
    expect(within(primarySteps).getByText("搜索地点完成")).toBeInTheDocument();
    expect(screen.queryByText("准备规划工具循环")).not.toBeInTheDocument();
  });

  it("keeps the completed agent log anchored when expanding it inside the message scroll area", async () => {
    const seed = createSeedItinerary();
    const runEvents = [
      testAgentRunEvent({
        sequence: 1,
        type: "assistant_message",
        title: "行动输出",
        detail: "我整理了一版较长的行程说明。"
      }),
      testAgentRunEvent({
        sequence: 2,
        type: "tool_call",
        status: "running",
        agent: "AttractionAgent",
        title: "检查地点",
        detail: "西湖"
      }),
      testAgentRunEvent({
        sequence: 3,
        type: "tool_result",
        agent: "AttractionAgent",
        title: "检查地点完成",
        detail: "地点已确认"
      })
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            [
              ...runEvents.map((event) => sseChunk("activity", event)),
              `event: final\ndata: ${JSON.stringify({
                itinerary: seed,
                message: {
                  role: "assistant",
                  content: [
                    "这是展开记录下方的长回复。",
                    "",
                    ...Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行说明，模拟较长内容。`)
                  ].join("\n")
                },
                diff: [],
                events: runEvents
              })}`,
              ""
            ].join("\n\n"),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "给我一段长说明。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const activityToggle = await screen.findByRole("button", { name: /Agent 执行记录/ });
    const messageScroll = screen.getByTestId("agent-message-scroll");
    Object.defineProperty(messageScroll, "scrollHeight", { configurable: true, value: 2000 });
    messageScroll.scrollTop = 500;
    const activityLog = screen.getByRole("group", { name: "Agent 执行记录" });
    const rectMock = vi
      .fn()
      .mockReturnValueOnce({ top: 240, bottom: 290, left: 0, right: 300, width: 300, height: 50, x: 0, y: 240, toJSON: () => ({}) })
      .mockReturnValueOnce({ top: 120, bottom: 390, left: 0, right: 300, width: 300, height: 270, x: 0, y: 120, toJSON: () => ({}) });
    activityLog.getBoundingClientRect = rectMock;

    await user.click(activityToggle);

    await waitFor(() => {
      expect(activityToggle).toHaveAttribute("aria-expanded", "true");
    });
    expect(messageScroll.scrollTop).toBe(380);
    expect(rectMock).toHaveBeenCalledTimes(2);
  });

  it("keeps assistant history in a dedicated scrollable message area", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const messageScroll = screen.getByTestId("agent-message-scroll");
    expect(messageScroll).toHaveClass("overflow-y-auto");
    expect(messageScroll).toHaveClass("overscroll-contain");
    expect(messageScroll).toHaveClass("min-h-0");
    expect(screen.getByTestId("agent-message-stack")).toHaveClass("min-h-max");
    expect(screen.getByTestId("agent-message-stack").className).not.toContain("justify-end");
  });

  it("keeps the current style selector on one compact row", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    const styleStrip = screen.getByTestId("agent-style-strip");
    expect(styleStrip).toHaveClass("flex");
    expect(styleStrip).toHaveClass("items-center");
    expect(styleStrip).toHaveClass("gap-2");
    expect(styleStrip).toHaveClass("py-2");
    expect(styleStrip.className).not.toContain("py-2.5");

    const styleList = screen.getByTestId("agent-style-list");
    expect(styleList).toHaveClass("flex-1");
    expect(styleList).toHaveClass("overflow-x-auto");
    expect(styleList).toHaveTextContent("未选择风格");
  });

  it("renders markdown tables in assistant replies as scrollable tables", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            [
              `event: final\ndata: ${JSON.stringify({
                itinerary: createSeedItinerary(),
                message: {
                  role: "assistant",
                  content: [
                    "我整理了一版时间表：",
                    "",
                    "| 时间 | 安排 | 备注 |",
                    "| --- | --- | --- |",
                    "| 09:00 | **西湖晨间散步** | 慢节奏 |",
                    "| 11:30 | 湖滨咖啡 | 休息 |"
                  ].join("\n")
                },
                diff: [],
                events: []
              })}`,
              ""
            ].join("\n\n"),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "给我一个表格版安排。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const table = await screen.findByTestId("markdown-table");
    expect(within(table).getByRole("columnheader", { name: "时间" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "安排" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "西湖晨间散步" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "湖滨咖啡" })).toBeInTheDocument();
    expect(screen.queryByText("| --- | --- | --- |")).not.toBeInTheDocument();
  });

  it("shows streamed assistant errors without applying local fallback changes", async () => {
    let agentRunCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/agent/run-stream")) {
          return new Response(
            [
              sseChunk(
                "activity",
                testAgentRunEvent({
                  sequence: 1,
                  type: "thought_summary",
                  title: "分析用户请求",
                  detail: "正在检查地点和路线"
                })
              ),
              'event: error\ndata: {"message":"路线服务暂时不可用，请稍后重试。"}',
              ""
            ].join("\n\n"),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        if (url.includes("/api/agent/run")) {
          agentRunCalls += 1;
          return new Response("Should not call fallback run", { status: 500 });
        }
        return new Response("Not found", { status: 404 });
      })
    );
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，节奏轻松一点。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("路线服务暂时不可用，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "本轮改动" })).not.toBeInTheDocument();
    expect(screen.queryByText("慢节奏街区探索")).not.toBeInTheDocument();
    expect(agentRunCalls).toBe(0);
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });
});
