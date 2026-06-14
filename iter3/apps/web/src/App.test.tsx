import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Travel Skill Agent frontend", () => {
  it("lets a user enter the workbench and manually add an activity", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(screen.getByText("杭州三日松弛游")).toBeInTheDocument();
    expect(screen.getByText("行程地图")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加活动" }));
    expect(screen.getByRole("listitem", { name: /第 3 站：待补全安排/ })).toBeInTheDocument();
    expect(await screen.findByLabelText("第 3 项活动名称")).toHaveValue("");
    expect(screen.getByText("补充地点后会出现在地图和路线里")).toBeInTheDocument();
    expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通待计算")).toBeInTheDocument();
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

    const timelineItem = screen.getByRole("listitem", { name: /第 3 站：待补全安排/ });
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

    expect(screen.getByRole("listitem", { name: /第 1 站：待补全安排/ })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /第 2 站：待补全安排/ })).toBeInTheDocument();
    expect(screen.getByText("Day 2 · 2 项待补地点")).toBeInTheDocument();
    expect(screen.queryByText("Day 2 · 2 个地点")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /补全 .*路线/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "计算路线" })).not.toBeInTheDocument();
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
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    expect(await screen.findByText("灵隐寺")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "添加灵隐寺到 Day 1" }));

    expect(screen.getByRole("listitem", { name: /第 3 站：灵隐寺/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "编辑灵隐寺" }));
    expect(screen.getByLabelText("第 3 项活动名称")).toHaveValue("灵隐寺");
    expect(screen.getAllByText("杭州市核心区域").length).toBeGreaterThan(0);
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
    await user.clear(screen.getByLabelText("在地图上搜索地点"));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "南山路咖啡馆");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));

    const result = await screen.findByRole("button", { name: "添加南山路咖啡馆到 Day 1" });
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
    expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通待计算")).toBeInTheDocument();
    expect(screen.getAllByText("西湖").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Day 2" }));
    expect(screen.getByText("Day 2 还没有地点")).toBeInTheDocument();
    expect(screen.queryByText("西湖")).not.toBeInTheDocument();
  });

  it("lets a user select a map point and edit the matching activity", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(screen.queryByLabelText("第 1 项活动名称")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "在行程中编辑西湖晨间散步" }));

    expect(screen.getByTestId("activity-drop-0")).toHaveAttribute("data-selected", "true");
    expect(screen.getByLabelText("第 1 项活动名称")).toHaveValue("西湖晨间散步");
    expect(screen.getByLabelText("西湖晨间散步 的活动内容")).toBeInTheDocument();
  });

  it("lets the map switch from the selected day to the full trip overview", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "Day 2" }));
    await user.type(screen.getByLabelText("在地图上搜索地点"), "灵隐寺");
    await user.click(screen.getByRole("button", { name: "搜索地点" }));
    await user.click(await screen.findByRole("button", { name: "添加灵隐寺到 Day 2" }));
    expect(screen.getByText("Day 2 · 1 个地点")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "全部行程" }));

    expect(screen.getByText("全部行程 · 3 个地点 · 1 段交通待计算")).toBeInTheDocument();
    expect(screen.getByTestId("map-day-route-day-1")).toHaveTextContent("Day 1 路线");
    expect(screen.getByTestId("map-day-route-day-1")).toHaveTextContent("2 个地点");
    expect(screen.getByTestId("map-day-route-day-2")).toHaveTextContent("Day 2 路线");
    expect(screen.getByTestId("map-day-route-day-2")).toHaveTextContent("1 个地点");
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

  it("keeps newly added map search results selected on the canvas", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
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
    expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通待计算")).toBeInTheDocument();
  });

  it("lets a user calculate all missing routes from the map", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通待计算")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "补全 1 段路线" }));

    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 1.3 km · 18 分钟")).toBeInTheDocument();
    });
    expect(screen.getAllByText("1.3 km / 18 分钟").length).toBeGreaterThan(0);
    expect(screen.getAllByText("估算路线").length).toBeGreaterThan(0);
    expect(screen.getByText("实时路线不可用时的参考值")).toBeInTheDocument();
  });

  it("lets a user choose the route mode before calculating every missing route from the map", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.selectOptions(screen.getByLabelText("批量路线交通方式"), "driving");
    await user.click(screen.getByRole("button", { name: "补全 1 段路线" }));

    await waitFor(() => {
      expect(screen.getByText("Day 1 · 2 个地点 · 1 段交通 · 3.6 km · 12 分钟")).toBeInTheDocument();
    });
    expect(screen.getAllByText("3.6 km / 12 分钟").length).toBeGreaterThan(0);
  });

  it("lets a user select a route segment from the map and edit that leg", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "补全 1 段路线" }));

    const mapRouteSegment = await screen.findByRole("button", { name: "查看路线：西湖晨间散步 到 湖滨咖啡" });
    expect(mapRouteSegment).toHaveTextContent("估算路线");
    expect(screen.queryByLabelText("西湖晨间散步 到 湖滨咖啡 的距离公里")).not.toBeInTheDocument();

    await user.click(mapRouteSegment);

    expect(screen.getByRole("group", { name: "路线：西湖晨间散步 到 湖滨咖啡" })).toHaveAttribute(
      "data-selected",
      "true"
    );
    expect(screen.getByText("路线数据")).toBeInTheDocument();
    expect(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的距离公里")).toBeInTheDocument();
    expect(screen.getByText("路线步骤")).toBeInTheDocument();
    expect(screen.getByText("步行前往湖滨咖啡")).toBeInTheDocument();
  });

  it("lets a user expand the map and add a place from map search", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "展开地图" }));
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

    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的距离公里"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的距离公里"), "2.4");
    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的耗时分钟"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的耗时分钟"), "35");
    await user.clear(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的费用"));
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的费用"), "18");
    await user.type(screen.getByLabelText("西湖晨间散步 到 湖滨咖啡 的路线备注"), "雨天含等车时间");

    await user.click(screen.getByRole("button", { name: "应用调整" }));

    await waitFor(() => {
    expect(screen.getByText("2.4 km / 35 分钟 / 约 18 元")).toBeInTheDocument();
    });
    expect(screen.getByText("用户调整：雨天含等车时间")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "计算路线" }));

    await waitFor(() => {
      expect(screen.getAllByText("路线待确认").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("高德未返回可用路线，请补全地点或手动填写交通。").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" })).toHaveTextContent("修正路线");
  });

  it("shows a saved state after manual itinerary edits", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "添加活动" }));

    expect(screen.getByText(/已保存/)).toBeInTheDocument();
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
    expect(screen.getByText("24-30 C")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更新天气" })).not.toBeInTheDocument();
  });

  it("downloads a markdown file when exporting the itinerary", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:journey-export");
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

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
  });

  it("imports a skill and runs the agent to update the itinerary canvas", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "使用风格" }));
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，别太赶。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(screen.getAllByText(/已更新行程/).length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/慢节奏街区探索|街区咖啡与自由探索/).length).toBeGreaterThan(0);
    expect(screen.getByText("本轮改动")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "本轮改动" })).not.toBeInTheDocument();
    expect(screen.queryByText("偏好记忆")).not.toBeInTheDocument();
  });

  it("opens the skill plaza and shows recommendations", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Skill 广场" }));
    expect(screen.getByText("推荐风格")).toBeInTheDocument();
    expect(screen.getByText("慢节奏街区漫步")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开慢节奏街区漫步标签编辑" })).not.toBeInTheDocument();
  });

  it("keeps the traveler-facing workbench copy free of internal implementation labels", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(screen.getByRole("heading", { name: "旅行助手" })).toBeInTheDocument();
    expect(screen.queryByText(/导入后会参与右侧对话和中间画布更新/)).not.toBeInTheDocument();
    expect(screen.queryByText(/高德地图已加载/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent 输入/)).not.toBeInTheDocument();
    expect(screen.queryByText(/让 Agent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/预算与交通可手动调整/)).not.toBeInTheDocument();
    expect(screen.queryByText(/交通备注/)).not.toBeInTheDocument();
    expect(screen.queryByText("偏好记忆")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用风格" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /导入慢节奏街区漫步/ })).not.toBeInTheDocument();

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
    await user.click(screen.getByRole("button", { name: "使用风格" }));
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));

    expect(screen.getByText("当前风格 1 个")).toBeInTheDocument();
    expect(screen.queryByText("已用 1 个风格")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "补全 1 段路线" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "补全路线" })).not.toBeInTheDocument();
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

  it("keeps the assistant as a drawer until the canvas has wide desktop space", async () => {
    const user = userEvent.setup();
    const { getByTestId } = render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));

    expect(getByTestId("app-shell")).toHaveClass("2xl:grid-cols-[280px_minmax(0,1fr)_380px]");
    expect(getByTestId("app-shell").className).not.toContain("xl:grid-cols-[248px_minmax(0,1fr)_340px]");
    expect(screen.getByRole("button", { name: "打开旅行助手" })).toHaveClass("2xl:hidden");
  });

  it("opens Skill browse as a temporary chooser and closes it after applying a style", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "使用风格" }));

    expect(screen.getByRole("dialog", { name: "旅行风格选择" })).toBeInTheDocument();
    expect(screen.queryByText("选择后，下一轮建议会参考它。")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "使用 慢节奏街区漫步" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "旅行风格选择" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "移出当前风格 慢节奏街区漫步" })).toBeInTheDocument();
  });

  it("keeps activity editing and route editing mutually focused", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "进入工作台" }));
    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    expect(screen.getByLabelText("第 1 项活动名称")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑路线细节：西湖晨间散步 到 湖滨咖啡" }));

    expect(screen.getByText("路线数据")).toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 项活动名称")).not.toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "编辑西湖晨间散步" }));
    expect(screen.getByLabelText("第 1 项活动名称")).toHaveValue("西湖晨间散步");
    expect(screen.getByLabelText("西湖晨间散步 的地点")).toBeInTheDocument();
    expect(screen.getByLabelText("西湖晨间散步 的活动内容")).toBeInTheDocument();

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
    fireEvent.drop(screen.getByTestId("activity-drop-0"), { dataTransfer });

    await waitFor(() => {
      expect(screen.getByRole("listitem", { name: /第 1 站：湖滨咖啡/ })).toBeInTheDocument();
    });
    expect(screen.getByRole("listitem", { name: /第 2 站：西湖晨间散步/ })).toBeInTheDocument();
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
    await user.type(
      screen.getByLabelText("粘贴风格内容"),
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
    await user.click(screen.getByRole("button", { name: "用于当前行程" }));

    expect(await screen.findByText("Rainy Cafe Style")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移出Rainy Cafe Style风格" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "最近：杭州三日松弛游 杭州 / 3 天" }));
    expect(screen.getByRole("button", { name: "移出当前风格 Rainy Cafe Style" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "使用风格" }));
    expect(screen.getAllByText("Rainy Cafe Style").length).toBeGreaterThan(1);
    expect(screen.queryByText(/避免：暴雨时安排长距离户外步行/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "移出 Rainy Cafe Style" }));

    expect(screen.queryByRole("button", { name: "移出当前风格 Rainy Cafe Style" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 Rainy Cafe Style" })).toBeInTheDocument();
  });

  it("extracts a skill into an editable draft before publishing it", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "创作 Skill" }));
    await user.click(screen.getByRole("button", { name: "提取为 Skill 草稿" }));

    expect(screen.getByText("确认草稿")).toBeInTheDocument();
    const nameInput = screen.getByLabelText("Skill 名称");
    await user.clear(nameInput);
    await user.type(nameInput, "厦门海边松弛风格");
    await user.click(screen.getByRole("button", { name: "发布到广场" }));

    expect(screen.getByRole("heading", { name: "Skill 广场" })).toBeInTheDocument();
    expect(screen.getByText("厦门海边松弛风格")).toBeInTheDocument();
  });

  it("shows user-facing assistant progress and lets the user stop a running request", async () => {
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
    await user.type(screen.getByLabelText("对行程的修改需求"), "帮我补全 Day 2 下午，节奏轻松一点。");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByText("正在处理行程")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => {
      expect(screen.getAllByText("已停止本次处理，行程没有改动。").length).toBeGreaterThan(0);
    });
  });
});
