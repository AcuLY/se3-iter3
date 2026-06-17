import type { MapRouteMode, RouteStep, RouteSummary, WeatherSummary } from "@journey/shared";

export type RouteRequestOptions = {
  originCity?: string;
  destinationCity?: string;
};

export type PoiResult = {
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
  photos?: Array<{ title?: string; url: string }>;
  location: { lng: number; lat: number };
  source: "amap";
};

export class MapService {
  async searchPoi(keywords: string, city = "杭州"): Promise<PoiResult[]> {
    const key = requireAmapKey();
    const url = new URL("https://restapi.amap.com/v3/place/text");
    url.searchParams.set("key", key);
    url.searchParams.set("keywords", keywords);
    url.searchParams.set("city", city);
    url.searchParams.set("offset", "20");
    url.searchParams.set("extensions", "all");
    const data = await fetchAmap<AmapPoiResponse>(url);
    if (data.status !== "1" || !Array.isArray(data.pois)) {
      throw new Error("Amap POI search returned an unsuccessful response");
    }
    return data.pois.flatMap((poi) => {
      const location = parseLngLat(poi.location);
      if (!location) return [];
      return [{
        id: poi.id,
        name: poi.name,
        address: typeof poi.address === "string" ? poi.address : "",
        city: poi.cityname || city,
        district: poi.adname,
        type: poi.type,
        typeCode: poi.typecode,
        phone: normalizeText(poi.tel),
        openingHours: normalizeText(poi.biz_ext?.opentime),
        averageCostCny: parseCost(poi.biz_ext?.cost),
        photos: normalizePhotos(poi.photos),
        location,
        source: "amap" as const
      }];
    });
  }

  async route(
    from: string,
    to: string,
    mode: MapRouteMode = "walking",
    options: RouteRequestOptions = {}
  ): Promise<RouteSummary> {
    const key = requireAmapKey();
    const url = routeUrl(mode);
    url.searchParams.set("key", key);
    url.searchParams.set("origin", from);
    url.searchParams.set("destination", to);
    if (mode === "transit") {
      const originCity = options.originCity?.trim();
      const destinationCity = options.destinationCity?.trim();
      if (originCity && destinationCity && originCity !== destinationCity) {
        // Intercity transit (e.g. 苏州→上海) requires both city codes so Amap
        // returns high-speed rail / coach options instead of urban-only buses.
        url.searchParams.set("city", originCity);
        url.searchParams.set("cityd", destinationCity);
      } else {
        url.searchParams.set("city", originCity || destinationCity || "全国");
      }
    }
    const data = await fetchAmap<AmapRouteResponse>(url);
    const route = normalizeAmapRoute(data, mode, from, to);
    if (!route) {
      throw new Error(`Amap route planning returned no usable result for mode=${mode}`);
    }
    return route;
  }

  async weather(city: string, date: string): Promise<WeatherSummary> {
    const key = requireAmapKey();
    const url = new URL("https://restapi.amap.com/v3/weather/weatherInfo");
    url.searchParams.set("key", key);
    url.searchParams.set("city", city);
    url.searchParams.set("extensions", "all");
    const data = await fetchAmap<AmapWeatherResponse>(url);
    const forecast = normalizeAmapForecast(data, city, date);
    if (forecast) return forecast;
    const live = data.lives?.[0];
    if (data.status === "1" && live) {
      return {
        city: live.city || city,
        date,
        weather: live.weather,
        temperature: `${live.temperature} C`,
        source: "amap"
      };
    }
    throw new Error("Amap weather API returned no usable forecast");
  }
}

function requireAmapKey(): string {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!key) {
    throw new Error("AMAP_WEB_SERVICE_KEY is required");
  }
  return key;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseCost(value: unknown): number | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.round(number);
}

function normalizePhotos(value: unknown): Array<{ title?: string; url: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const photos = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const photo = item as { title?: unknown; url?: unknown };
    const url = normalizeText(photo.url);
    if (!url) return [];
    const title = normalizeText(photo.title);
    return [{ title, url }];
  });
  return photos.length > 0 ? photos : undefined;
}

async function fetchAmap<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Amap request failed: ${response.status}`);
  return (await response.json()) as T;
}

function routeUrl(mode: MapRouteMode): URL {
  if (mode === "driving") return new URL("https://restapi.amap.com/v3/direction/driving");
  if (mode === "cycling") return new URL("https://restapi.amap.com/v4/direction/bicycling");
  if (mode === "transit") return new URL("https://restapi.amap.com/v3/direction/transit/integrated");
  return new URL("https://restapi.amap.com/v3/direction/walking");
}

function normalizeAmapRoute(data: AmapRouteResponse, mode: MapRouteMode, from: string, to: string): RouteSummary | undefined {
  if (!isAmapRouteSuccess(data)) return undefined;
  const path = data.route?.paths?.[0] ?? data.data?.paths?.[0];
  if (path) {
    const steps = path.steps ?? [];
    const routeSteps = steps.flatMap((step): RouteStep[] => {
      const instruction = normalizeText(step.instruction);
      if (!instruction) return [];
      const polyline = parsePolyline(step.polyline);
      return [
        {
          instruction,
          mode,
          distanceMeters: parseAmapDistance(step.distance),
          durationMinutes: parseAmapDurationMinutes(step.duration),
          polyline
        }
      ];
    });
    return {
      from,
      to,
      mode,
      distanceMeters: Number(path.distance ?? 0),
      durationMinutes: Math.ceil(Number(path.duration ?? 0) / 60),
      summary: steps.map((step) => step.instruction).filter(Boolean).slice(0, 3).join("；") || undefined,
      polyline: steps.flatMap((step) => parsePolyline(step.polyline)),
      steps: routeSteps,
      source: "amap",
      status: "planned"
    };
  }

  const transit = data.route?.transits?.[0];
  if (transit) {
    const routeSteps = transit.segments?.flatMap((segment): RouteStep[] => {
      const busline = segment.bus?.buslines?.[0];
      const walkingSteps =
        segment.walking?.steps?.flatMap((step): RouteStep[] => {
          const instruction = normalizeText(step.instruction);
          if (!instruction) return [];
          return [
            {
              instruction,
              mode: "walking",
              distanceMeters: parseAmapDistance(step.distance),
              durationMinutes: parseAmapDurationMinutes(step.duration),
              polyline: parsePolyline(step.polyline)
            }
          ];
        }) ?? [];
      const busName = normalizeText(busline?.name);
      const busSteps = busName
        ? [
            {
              instruction: `乘坐${busName}`,
              mode: "transit" as const,
              distanceMeters: parseAmapDistance(busline?.distance),
              durationMinutes: parseAmapDurationMinutes(busline?.duration),
              polyline: parsePolyline(busline?.polyline)
            }
          ]
        : [];
      return [...walkingSteps, ...busSteps];
    }) ?? [];
    return {
      from,
      to,
      mode,
      distanceMeters: Number(transit.distance ?? 0),
      durationMinutes: Math.ceil(Number(transit.duration ?? 0) / 60),
      summary: transit.segments?.map((segment) => segment.bus?.buslines?.[0]?.name).filter(Boolean).slice(0, 3).join("；"),
      polyline: transit.segments?.flatMap(transitSegmentPolyline) ?? [],
      steps: routeSteps,
      source: "amap",
      status: "planned"
    };
  }
  return undefined;
}

function isAmapRouteSuccess(data: AmapRouteResponse): boolean {
  return data.status === "1" || data.errcode === 0;
}

function parseAmapDistance(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function parseAmapDurationMinutes(value: unknown): number | undefined {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds / 60) : undefined;
}

function transitSegmentPolyline(segment: AmapTransitSegment): Array<{ lng: number; lat: number }> {
  const walkingPolyline = parsePolyline(segment.walking?.steps?.map((step) => step.polyline).join(";") ?? "");
  const busPolyline = parsePolyline(segment.bus?.buslines?.map((line) => line.polyline).filter(Boolean).join(";") ?? "");
  return [...walkingPolyline, ...busPolyline];
}

function normalizeAmapForecast(data: AmapWeatherResponse, city: string, date: string): WeatherSummary | undefined {
  if (data.status !== "1") return undefined;
  const forecast = data.forecasts?.[0];
  const cast = forecast?.casts?.find((candidate) => candidate.date === date) ?? forecast?.casts?.[0];
  if (!forecast || !cast) return undefined;
  const dayWeather = cast.dayweather?.trim();
  const nightWeather = cast.nightweather?.trim();
  const weather =
    dayWeather && nightWeather && dayWeather !== nightWeather
      ? `${dayWeather} / ${nightWeather}`
      : dayWeather || nightWeather || "天气待确认";
  const minTemp = Math.min(Number(cast.daytemp), Number(cast.nighttemp));
  const maxTemp = Math.max(Number(cast.daytemp), Number(cast.nighttemp));
  const temperature =
    Number.isFinite(minTemp) && Number.isFinite(maxTemp)
      ? `${minTemp}-${maxTemp} C`
      : [cast.nighttemp, cast.daytemp].filter(Boolean).join("-") || "温度待确认";
  return {
    city: forecast.city || city,
    date: cast.date || date,
    weather,
    temperature,
    source: "amap"
  };
}

function parsePolyline(value?: string): Array<{ lng: number; lat: number }> {
  if (!value) return [];
  return value
    .split(";")
    .map(parseLngLat)
    .filter((point): point is { lng: number; lat: number } => Boolean(point));
}

function parseLngLat(value?: string): { lng: number; lat: number } | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map(Number);
  const lng = parts[0];
  const lat = parts[1];
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    return undefined;
  }
  return { lng, lat };
}

type AmapPoiResponse = {
  status: string;
  pois?: Array<{
    id: string;
    name: string;
    address?: string | unknown[];
    cityname?: string;
    adname?: string;
    type?: string;
    typecode?: string;
    tel?: string;
    biz_ext?: {
      cost?: string;
      opentime?: string;
    };
    photos?: Array<{
      title?: string;
      url?: string;
    }>;
    location?: string;
  }>;
};

type AmapRouteResponse = {
  status?: string;
  errcode?: number;
  route?: {
    paths?: AmapPath[];
    transits?: Array<{
      distance?: string;
      duration?: string;
      segments?: AmapTransitSegment[];
    }>;
  };
  data?: {
    paths?: AmapPath[];
  };
};

type AmapPath = {
  distance?: string;
  duration?: string;
  steps?: Array<{
    instruction?: string;
    distance?: string;
    duration?: string;
    polyline?: string;
  }>;
};

type AmapTransitSegment = {
  walking?: { steps?: Array<{ instruction?: string; distance?: string; duration?: string; polyline?: string }> };
  bus?: { buslines?: Array<{ name?: string; distance?: string; duration?: string; polyline?: string }> };
};

type AmapWeatherResponse = {
  status: string;
  forecasts?: Array<{
    city?: string;
    casts?: Array<{
      date?: string;
      dayweather?: string;
      nightweather?: string;
      daytemp?: string;
      nighttemp?: string;
    }>;
  }>;
  lives?: Array<{
    city?: string;
    weather: string;
    temperature: string;
  }>;
};
