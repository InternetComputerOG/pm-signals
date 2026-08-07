/**
 * Alpaca Market Data free tier (IEX feed only).
 *
 * Stock price is decorative here - it is the third trendline on the chart, not
 * an input to the score - so every function in this module degrades to null
 * rather than throwing. The app is fully functional with no Alpaca keys at
 * all; cards simply show no price and the charts omit the price series.
 */

import { ALPACA_BARS_LIMIT, ALPACA_BASE, ALPACA_FEED } from "./config";

export interface AlpacaEnv {
  ALPACA_API_KEY?: string;
  ALPACA_SECRET_KEY?: string;
}

export interface DailyBar {
  /** RFC-3339 timestamp of the bar. */
  t: string;
  /** Close. */
  c: number;
}

export function hasAlpacaCredentials(env: AlpacaEnv): boolean {
  return Boolean(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY);
}

/**
 * A fetch that cannot throw. `status` is carried through on failure because
 * callers need to tell "this symbol isn't on the feed" (404) apart from "the
 * call went wrong" - the first is routine, the second is worth shouting about.
 */
type AlpacaResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null };

/**
 * Alpaca answers unauthenticated requests with an nginx HTML error page, not
 * JSON, so the body is only parsed after the status check and even then
 * defensively.
 */
async function getJson<T>(url: string, env: AlpacaEnv): Promise<AlpacaResult<T>> {
  if (!hasAlpacaCredentials(env)) return { ok: false, status: null };
  try {
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": env.ALPACA_API_KEY as string,
        "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY as string,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      // A 404 just means the ticker has no data on this feed, which is normal:
      // Polymarket lists earnings markets for names that are not US-listed
      // equities. A 401/403 means the keys are missing, wrong, or lack the
      // data subscription, and a 429 means we are over the rate limit - all
      // three are configuration problems the operator needs to see.
      if (res.status === 404) console.warn(`alpaca: no data for ${url}`);
      else console.error(`alpaca: GET ${url} -> HTTP ${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    console.error(`alpaca: GET ${url} failed`, err);
    return { ok: false, status: null };
  }
}

interface Snapshot {
  latestTrade?: { p?: number };
  dailyBar?: { c?: number };
  prevDailyBar?: { c?: number };
}

/** The first of the candidate fields that holds a usable price. */
function firstUsablePrice(candidates: Array<number | undefined>): number | null {
  for (const price of candidates) {
    if (typeof price === "number" && Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

/**
 * Snapshot lookup, reporting whether the symbol itself is unknown to the feed
 * so the caller can decide against a pointless second request.
 */
async function lookupSnapshot(
  ticker: string,
  env: AlpacaEnv,
): Promise<{ price: number | null; symbolUnknown: boolean }> {
  const url = `${ALPACA_BASE}/v2/stocks/${encodeURIComponent(ticker)}/snapshot?feed=${ALPACA_FEED}`;
  const result = await getJson<Snapshot>(url, env);
  if (!result.ok) return { price: null, symbolUnknown: result.status === 404 };

  const { latestTrade, dailyBar, prevDailyBar } = result.data;
  return {
    price: firstUsablePrice([latestTrade?.p, dailyBar?.c, prevDailyBar?.c]),
    symbolUnknown: false,
  };
}

/** Latest trade price, falling back to the day's close then the prior close. */
export async function fetchSnapshotPrice(ticker: string, env: AlpacaEnv): Promise<number | null> {
  return (await lookupSnapshot(ticker, env)).price;
}

/** Daily bars covering the history window, oldest first. */
export async function fetchDailyBars(
  ticker: string,
  env: AlpacaEnv,
  days: number,
): Promise<DailyBar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const url =
    `${ALPACA_BASE}/v2/stocks/${encodeURIComponent(ticker)}/bars` +
    `?timeframe=1Day&start=${start.toISOString()}&end=${end.toISOString()}` +
    `&feed=${ALPACA_FEED}&limit=${ALPACA_BARS_LIMIT}`;
  const result = await getJson<{ bars?: DailyBar[] | null }>(url, env);
  return result.ok ? (result.data.bars ?? []) : [];
}

/**
 * Current price for a ticker: the snapshot, or the most recent daily close if
 * the snapshot is unavailable (common outside market hours on the IEX feed).
 *
 * Costs one subrequest in the happy path and two in the fallback path, which
 * matters against the free plan's 50-subrequest budget per invocation.
 */
export async function fetchCurrentPrice(
  ticker: string,
  env: AlpacaEnv,
  days: number,
): Promise<number | null> {
  const { price, symbolUnknown } = await lookupSnapshot(ticker, env);
  if (price !== null) return price;

  // If the feed does not know the symbol, bars will not either. Skipping the
  // fallback keeps the worst-case run inside the 50-subrequest budget even on
  // a board full of tickers Alpaca cannot price.
  if (symbolUnknown) return null;

  const bars = await fetchDailyBars(ticker, env, days);
  return firstUsablePrice([bars.at(-1)?.c]);
}
