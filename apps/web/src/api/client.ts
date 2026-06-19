export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function apiGet<T>(path: string, ..._unused: unknown[]): Promise<T> {
  const response = await strictFetch(path, { signal: AbortSignal.timeout(5000) });
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown, ..._unused: unknown[]): Promise<T> {
  return apiJson("POST", path, body);
}

export async function apiPostStrict<T>(path: string, body: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
  const response = await strictFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000)
  });
  return (await response.json()) as T;
}

export async function apiPatch<T>(path: string, body: unknown, ..._unused: unknown[]): Promise<T> {
  return apiJson("PATCH", path, body);
}

export async function apiDelete<T>(path: string, ..._unused: unknown[]): Promise<T> {
  const response = await strictFetch(path, {
    method: "DELETE",
    signal: AbortSignal.timeout(5000)
  });
  return (await response.json()) as T;
}

export async function apiText(path: string, ..._unused: unknown[]): Promise<string> {
  const response = await strictFetch(path, { signal: AbortSignal.timeout(5000) });
  return await response.text();
}

export type ApiStreamEvent = {
  event: string;
  data: unknown;
};

export class ApiStreamEventError extends Error {
  constructor(
    message: string,
    readonly data: unknown
  ) {
    super(message);
    this.name = "ApiStreamEventError";
  }
}

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
      if (parsed) handleStreamEvent(parsed, options.onEvent);
    }
  }
  if (buffer.trim()) {
    const parsed = parseEventChunk(buffer);
    if (parsed) handleStreamEvent(parsed, options.onEvent);
  }
}

async function apiJson<T>(method: "POST" | "PATCH", path: string, body: unknown): Promise<T> {
  const response = await strictFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  return (await response.json()) as T;
}

async function strictFetch(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), init);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network request failed";
    throw new ApiRequestError(message);
  }
  if (!response.ok) {
    const body = await readErrorBody(response);
    throw new ApiRequestError(readErrorMessage(body, response.status), response.status, body);
  }
  return response;
}

async function readErrorBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  try {
    if (contentType.includes("application/json")) return await response.json();
    return await response.text();
  } catch {
    return undefined;
  }
}

function readErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (data && typeof data === "object" && "error" in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  return `Request failed: ${status}`;
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

function handleStreamEvent(event: ApiStreamEvent, onEvent: (event: ApiStreamEvent) => void): void {
  if (event.event === "error") {
    throw new ApiStreamEventError(readStreamErrorMessage(event.data), event.data);
  }
  onEvent(event);
}

function readStreamErrorMessage(data: unknown): string {
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "助手暂时无法完成这次规划";
}
