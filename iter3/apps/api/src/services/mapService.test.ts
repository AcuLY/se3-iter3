import { afterEach, describe, expect, it, vi } from "vitest";
import { MapService } from "./mapService.js";

describe("MapService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses Amap POI search when a web service key is configured", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/place/text");
      expect(url.searchParams.get("key")).toBe("amap-test-key");
      expect(url.searchParams.get("keywords")).toBe("西湖");
      expect(url.searchParams.get("city")).toBe("杭州");
      return jsonResponse({
        status: "1",
        pois: [
          {
            id: "B023B0A8Y8",
            name: "西湖风景名胜区",
            address: "浙江省杭州市西湖区龙井路1号",
            cityname: "杭州市",
            adname: "西湖区",
            type: "风景名胜;风景名胜;国家级景点",
            typecode: "110202",
            location: "120.141,30.259",
            tel: "0571-12345678",
            biz_ext: {
              cost: "68.00",
              opentime: "08:30-17:00"
            },
            photos: [
              {
                title: "西湖入口",
                url: "https://example.test/xihu.jpg"
              }
            ]
          }
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new MapService();
    const items = await service.searchPoi("西湖", "杭州");

    expect(items[0]).toMatchObject({
      id: "B023B0A8Y8",
      name: "西湖风景名胜区",
      city: "杭州市",
      district: "西湖区",
      type: "风景名胜;风景名胜;国家级景点",
      typeCode: "110202",
      phone: "0571-12345678",
      openingHours: "08:30-17:00",
      averageCostCny: 68,
      photos: [{ title: "西湖入口", url: "https://example.test/xihu.jpg" }],
      source: "amap",
      location: { lng: 120.141, lat: 30.259 }
    });
  });

  it("skips Amap POIs without coordinates and falls back when no usable result remains", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          status: "1",
          pois: [
            {
              id: "bad-poi",
              name: "无坐标地点",
              address: "未知地址",
              cityname: "杭州市"
            }
          ]
        })
      )
    );

    const service = new MapService();
    const items = await service.searchPoi("无坐标地点", "杭州");

    expect(items[0]).toMatchObject({
      id: "mock-无坐标地点",
      source: "mock",
      type: "风景名胜",
      location: { lng: 120.1551, lat: 30.2741 }
    });
  });

  it("uses Amap route planning and normalizes seconds to minutes", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/direction/walking");
      expect(url.searchParams.get("origin")).toBe("120.141,30.259");
      expect(url.searchParams.get("destination")).toBe("120.165,30.255");
      return jsonResponse({
        status: "1",
        route: {
          paths: [
            {
              distance: "3200",
              duration: "1680",
              steps: [
                {
                  instruction: "沿北山街步行",
                  distance: "3200",
                  duration: "1680",
                  polyline: "120.141,30.259;120.15,30.257;120.165,30.255"
                }
              ]
            }
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new MapService();
    const route = await service.route("120.141,30.259", "120.165,30.255", "walking");

    expect(route).toMatchObject({
      mode: "walking",
      distanceMeters: 3200,
      durationMinutes: 28,
      source: "amap",
      summary: "沿北山街步行"
    });
    expect(route.status).toBe("planned");
    expect(route.steps).toEqual([
      expect.objectContaining({
        instruction: "沿北山街步行",
        mode: "walking",
        distanceMeters: 3200,
        durationMinutes: 28,
        polyline: [
          { lng: 120.141, lat: 30.259 },
          { lng: 120.15, lat: 30.257 },
          { lng: 120.165, lat: 30.255 }
        ]
      })
    ]);
    expect(route.polyline).toEqual([
      { lng: 120.141, lat: 30.259 },
      { lng: 120.15, lat: 30.257 },
      { lng: 120.165, lat: 30.255 }
    ]);
  });

  it("keeps transit walking and busline polylines so the map can draw the complete route", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/direction/transit/integrated");
      expect(url.searchParams.get("origin")).toBe("120.141,30.259");
      expect(url.searchParams.get("destination")).toBe("120.165,30.255");
      expect(url.searchParams.get("city")).toBe("全国");
      return jsonResponse({
        status: "1",
        route: {
          transits: [
            {
              distance: "6200",
              duration: "2100",
              segments: [
                {
                  walking: {
                    steps: [
                      {
                        instruction: "步行至龙翔桥站",
                        distance: "500",
                        duration: "420",
                        polyline: "120.141,30.259;120.145,30.258"
                      }
                    ]
                  },
                  bus: {
                    buslines: [
                      {
                        name: "地铁1号线(湘湖方向)",
                        distance: "5200",
                        duration: "1200",
                        polyline: "120.145,30.258;120.155,30.256;120.162,30.255"
                      }
                    ]
                  }
                },
                {
                  walking: {
                    steps: [
                      {
                        instruction: "步行至湖滨银泰",
                        distance: "500",
                        duration: "480",
                        polyline: "120.162,30.255;120.165,30.255"
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new MapService();
    const route = await service.route("120.141,30.259", "120.165,30.255", "transit");

    expect(route).toMatchObject({
      mode: "transit",
      distanceMeters: 6200,
      durationMinutes: 35,
      source: "amap",
      summary: "地铁1号线(湘湖方向)"
    });
    expect(route.polyline).toEqual([
      { lng: 120.141, lat: 30.259 },
      { lng: 120.145, lat: 30.258 },
      { lng: 120.145, lat: 30.258 },
      { lng: 120.155, lat: 30.256 },
      { lng: 120.162, lat: 30.255 },
      { lng: 120.162, lat: 30.255 },
      { lng: 120.165, lat: 30.255 }
    ]);
    expect(route.steps).toEqual([
      expect.objectContaining({
        instruction: "步行至龙翔桥站",
        mode: "walking",
        distanceMeters: 500,
        durationMinutes: 7,
        polyline: [
          { lng: 120.141, lat: 30.259 },
          { lng: 120.145, lat: 30.258 }
        ]
      }),
      expect.objectContaining({
        instruction: "乘坐地铁1号线(湘湖方向)",
        mode: "transit",
        distanceMeters: 5200,
        durationMinutes: 20,
        polyline: [
          { lng: 120.145, lat: 30.258 },
          { lng: 120.155, lat: 30.256 },
          { lng: 120.162, lat: 30.255 }
        ]
      }),
      expect.objectContaining({
        instruction: "步行至湖滨银泰",
        mode: "walking",
        distanceMeters: 500,
        durationMinutes: 8,
        polyline: [
          { lng: 120.162, lat: 30.255 },
          { lng: 120.165, lat: 30.255 }
        ]
      })
    ]);
  });

  it("uses traveler-facing Chinese copy for fallback route summaries", async () => {
    const service = new MapService();
    const route = await service.route("西湖", "湖滨银泰", "walking");

    expect(route).toMatchObject({
      mode: "walking",
      source: "mock",
      summary: "步行路线建议",
      status: "estimated",
      fallbackReason: "实时路线不可用时的参考值"
    });
    expect(route.steps?.[0]).toMatchObject({
      instruction: "步行前往湖滨银泰",
      mode: "walking",
      distanceMeters: 1300,
      durationMinutes: 18
    });
  });

  it("uses Amap weather forecasts for the requested travel date", async () => {
    vi.stubEnv("AMAP_WEB_SERVICE_KEY", "amap-test-key");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://restapi.amap.com/v3/weather/weatherInfo");
      expect(url.searchParams.get("key")).toBe("amap-test-key");
      expect(url.searchParams.get("city")).toBe("杭州");
      expect(url.searchParams.get("extensions")).toBe("all");
      return jsonResponse({
        status: "1",
        forecasts: [
          {
            city: "杭州市",
            casts: [
              {
                date: "2026-07-01",
                dayweather: "晴",
                nightweather: "多云",
                daytemp: "31",
                nighttemp: "23"
              },
              {
                date: "2026-07-02",
                dayweather: "小雨",
                nightweather: "阴",
                daytemp: "28",
                nighttemp: "22"
              }
            ]
          }
        ]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new MapService();
    const weather = await service.weather("杭州", "2026-07-02");

    expect(weather).toEqual({
      city: "杭州市",
      date: "2026-07-02",
      weather: "小雨 / 阴",
      temperature: "22-28 C",
      source: "amap"
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
