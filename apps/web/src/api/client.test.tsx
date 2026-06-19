import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, apiGet, apiPost, apiPostStrict } from "./client";

describe("strict API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws instead of returning fallback data on non-2xx GET responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad Gateway", { status: 502 })));

    await expect(apiGet<{ items: string[] }>("/itineraries")).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 502
    });
  });

  it("throws instead of returning fallback data when POST transport fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    await expect(apiPost<{ ok: boolean }>("/itineraries", {})).rejects.toBeInstanceOf(ApiRequestError);
  });

  it("allows strict POST callers to choose a longer timeout", async () => {
    const signal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }))
    );

    await expect(apiPostStrict<{ ok: boolean }>("/skills/creator/start", {}, { timeoutMs: 90_000 })).resolves.toEqual({
      ok: true
    });

    expect(timeoutSpy).toHaveBeenCalledWith(90_000);
  });
});
