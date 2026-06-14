export async function apiGet<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export async function apiPost<T>(path: string, body: unknown, fallback: T): Promise<T> {
  return apiJson("POST", path, body, fallback);
}

export async function apiPatch<T>(path: string, body: unknown, fallback: T): Promise<T> {
  return apiJson("PATCH", path, body, fallback);
}

export async function apiDelete<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), {
      method: "DELETE",
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export async function apiText(path: string, fallback: string): Promise<string> {
  try {
    const response = await fetch(apiUrl(path), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return fallback;
    return await response.text();
  } catch {
    return fallback;
  }
}

export type ApiStreamEvent = {
  event: string;
  data: unknown;
};

export async function apiEventStream(
  path: string,
  body: unknown,
  options: {
    signal?: AbortSignal;
    onEvent: (event: ApiStreamEvent) => void;
  }
): Promise<void> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`Stream request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const parsed = parseEventChunk(chunk);
      if (parsed) options.onEvent(parsed);
    }
  }
  if (buffer.trim()) {
    const parsed = parseEventChunk(buffer);
    if (parsed) options.onEvent(parsed);
  }
}

async function apiJson<T>(method: "POST" | "PATCH", path: string, body: unknown, fallback: T): Promise<T> {
  try {
    const response = await fetch(apiUrl(path), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

function apiUrl(path: string): string {
  const base = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (!base) return `/api${path}`;
  return `${base.replace(/\/$/, "")}/api${path}`;
}

function parseEventChunk(chunk: string): ApiStreamEvent | undefined {
  const eventLine = chunk.split(/\r?\n/).find((line) => line.startsWith("event:"));
  const dataLines = chunk
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (!eventLine || dataLines.length === 0) return undefined;
  const event = eventLine.slice("event:".length).trim();
  const raw = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}
