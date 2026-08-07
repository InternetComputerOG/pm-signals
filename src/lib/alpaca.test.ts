/**
 * Alpaca client behaviour, with `fetch` stubbed.
 *
 * The response bodies below are trimmed copies of what the live free-tier API
 * actually returned on 2026-08-07, including the two shapes that are easy to
 * get wrong: the nginx HTML 401 and the JSON 404 for an unlisted symbol.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchCurrentPrice,
  fetchDailyBars,
  fetchSnapshotPrice,
  hasAlpacaCredentials,
} from "./alpaca";

const env = { ALPACA_API_KEY: "key", ALPACA_SECRET_KEY: "secret" };

/** Queues one canned response per call, in order. */
function stubFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NGINX_401 = new Response(
  "<html>\n<head><title>401 Authorization Required</title></head>\n</html>",
  { status: 401, headers: { "content-type": "text/html" } },
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hasAlpacaCredentials", () => {
  it("requires both halves of the pair", () => {
    expect(hasAlpacaCredentials(env)).toBe(true);
    expect(hasAlpacaCredentials({ ALPACA_API_KEY: "key" })).toBe(false);
    expect(hasAlpacaCredentials({ ALPACA_SECRET_KEY: "secret" })).toBe(false);
    expect(hasAlpacaCredentials({})).toBe(false);
  });
});

describe("fetchSnapshotPrice", () => {
  it("sends both auth headers and asks for the IEX feed", async () => {
    const fetchMock = stubFetch(json({ latestTrade: { p: 83.01 } }));
    await fetchSnapshotPrice("RKLB", env);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://data.alpaca.markets/v2/stocks/RKLB/snapshot?feed=iex");
    expect(init.headers["APCA-API-KEY-ID"]).toBe("key");
    expect(init.headers["APCA-API-SECRET-KEY"]).toBe("secret");
  });

  it("prefers the latest trade, then the day's close, then the prior close", async () => {
    stubFetch(
      json({
        latestTrade: { p: 83.01 },
        dailyBar: { c: 82.915 },
        prevDailyBar: { c: 75.7 },
      }),
    );
    expect(await fetchSnapshotPrice("RKLB", env)).toBe(83.01);

    stubFetch(json({ dailyBar: { c: 82.915 }, prevDailyBar: { c: 75.7 } }));
    expect(await fetchSnapshotPrice("RKLB", env)).toBe(82.915);

    stubFetch(json({ prevDailyBar: { c: 75.7 } }));
    expect(await fetchSnapshotPrice("RKLB", env)).toBe(75.7);
  });

  it("rejects zero and non-finite prices rather than charting them", async () => {
    stubFetch(json({ latestTrade: { p: 0 }, dailyBar: { c: 82.915 } }));
    expect(await fetchSnapshotPrice("RKLB", env)).toBe(82.915);
  });

  it("makes no request at all when credentials are absent", async () => {
    const fetchMock = stubFetch();
    expect(await fetchSnapshotPrice("RKLB", {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not try to parse the HTML body Alpaca returns on 401", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(NGINX_401);
    expect(await fetchSnapshotPrice("RKLB", env)).toBeNull();
  });

  it("survives a transport failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSnapshotPrice("RKLB", env)).toBeNull();
  });
});

describe("fetchDailyBars", () => {
  it("returns bars oldest first and bounds the window", async () => {
    const fetchMock = stubFetch(
      json({
        bars: [
          { t: "2026-07-29T04:00:00Z", c: 58.59 },
          { t: "2026-08-06T04:00:00Z", c: 75.7 },
        ],
      }),
    );
    const bars = await fetchDailyBars("RKLB", env, 10);
    expect(bars.at(-1)?.c).toBe(75.7);

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("timeframe")).toBe("1Day");
    expect(url.searchParams.get("feed")).toBe("iex");
    expect(url.searchParams.get("limit")).toBe("15");

    const spanMs =
      Date.parse(url.searchParams.get("end") as string) -
      Date.parse(url.searchParams.get("start") as string);
    expect(spanMs).toBe(10 * 24 * 60 * 60 * 1000);
  });

  it("treats a null bars array as no data", async () => {
    stubFetch(json({ bars: null }));
    expect(await fetchDailyBars("RKLB", env, 10)).toEqual([]);
  });
});

describe("fetchCurrentPrice", () => {
  it("costs one request when the snapshot has a price", async () => {
    const fetchMock = stubFetch(json({ latestTrade: { p: 83.01 } }));
    expect(await fetchCurrentPrice("RKLB", env, 10)).toBe(83.01);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last daily close when the snapshot is empty", async () => {
    const fetchMock = stubFetch(json({}), json({ bars: [{ t: "2026-08-06T04:00:00Z", c: 75.7 }] }));
    expect(await fetchCurrentPrice("RKLB", env, 10)).toBe(75.7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * Polymarket lists earnings markets for names Alpaca cannot price. Spending
   * a second subrequest on each of them is what the 404 short-circuit avoids.
   */
  it("does not spend a second subrequest on a symbol the feed does not know", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = stubFetch(json({ message: "no snapshot found for ZZZZ" }, 404));
    expect(await fetchCurrentPrice("ZZZZ", env, 10)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("degrades to null, never throws, when the whole service is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(json({ message: "internal" }, 500), json({ message: "internal" }, 500));
    expect(await fetchCurrentPrice("RKLB", env, 10)).toBeNull();
  });
});
