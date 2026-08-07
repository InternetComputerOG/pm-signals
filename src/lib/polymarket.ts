/**
 * Thin fetch wrappers over the three public Polymarket APIs. No keys required.
 *
 * Everything the rest of the app sees is already cleaned up here: events are
 * flattened into markets, Polymarket's JSON-encoded string fields are parsed,
 * and raw trades are normalised onto the YES ("beat") axis.
 */

import {
  CLOB_BASE,
  DATA_BASE,
  GAMMA_BASE,
  GAMMA_SEARCH_LIMIT_PER_TYPE,
  SEARCH_QUERIES,
  TICKER_BLOCKLIST,
  TICKER_CONTEXT_WORDS,
  TRADES_LIMIT,
} from "./config";
import type { NormalizedTrade } from "./signals";

/** One open earnings market, ready to be scored. */
export interface Candidate {
  marketId: string;
  yesTokenId: string;
  question: string;
  slug: string;
  pmUrl: string;
  volume: number;
  ticker: string;
  /**
   * Gamma's own last outcome price. Used as the fallback if the CLOB midpoint
   * call fails, and as the free ranking key during selection - it arrives with
   * discovery, so ranking on it costs no subrequest.
   */
  fallbackPBeat: number | null;
  /** ISO-8601 resolution date, when Gamma supplies one. Display context only. */
  endDate: string | null;
}

interface GammaMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  volume?: number | string;
  volumeNum?: number | string;
  endDate?: string;
  /** JSON-encoded string, e.g. '["123...","456..."]'. */
  clobTokenIds?: string;
  /** JSON-encoded string, e.g. '["Yes", "No"]'. */
  outcomes?: string;
  /** JSON-encoded string, e.g. '["0.79", "0.21"]'. */
  outcomePrices?: string;
}

interface GammaEvent {
  slug?: string;
  title?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  endDate?: string;
  markets?: GammaMarket[];
}

/** Raw shape returned by data-api /trades. */
interface RawTrade {
  side?: string;
  size?: number;
  price?: number;
  asset?: string;
  outcome?: string;
  outcomeIndex?: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Gamma returns arrays as JSON-encoded *strings*, not arrays, on
 * clobTokenIds / outcomes / outcomePrices. Parsing them is not optional.
 */
function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toNumber(value: unknown): number {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Ticker extraction
// ---------------------------------------------------------------------------

function isPlausibleTicker(candidate: string): boolean {
  return /^[A-Z]{1,5}$/.test(candidate) && !TICKER_BLOCKLIST.has(candidate);
}

/**
 * Layered, most-precise-first. Polymarket earnings markets are templated, so
 * the first two layers resolve essentially every real market:
 *
 *   1. Parenthesised symbol in the question - "Will Home Depot (HD) beat ...".
 *   2. Slug prefix - "hd-quarterly-earnings-nongaap-eps-08-18-2026-4pt73".
 *   3. The spec's bare /\b([A-Z]{1,5})\b/, preferring tokens sitting near
 *      "earnings" / "beat" / "EPS", as a last resort.
 *
 * Returns null rather than guessing when nothing survives the blocklist.
 */
export function extractTicker(question: string, slug: string): string | null {
  const parenthesised = question.match(/\(([A-Za-z.]{1,6})\)/g) ?? [];
  for (const match of parenthesised) {
    const symbol = match.slice(1, -1).toUpperCase().replace(/\./g, "");
    if (isPlausibleTicker(symbol)) return symbol;
  }

  const slugPrefix = slug.split("-")[0]?.toUpperCase() ?? "";
  if (isPlausibleTicker(slugPrefix)) return slugPrefix;

  const lowerQuestion = question.toLowerCase();
  const scored: Array<{ symbol: string; distance: number }> = [];
  for (const match of question.matchAll(/\b([A-Z]{1,5})\b/g)) {
    const symbol = match[1];
    if (!isPlausibleTicker(symbol)) continue;
    const at = match.index ?? 0;
    let distance = Number.MAX_SAFE_INTEGER;
    for (const word of TICKER_CONTEXT_WORDS) {
      const wordAt = lowerQuestion.indexOf(word);
      if (wordAt >= 0) distance = Math.min(distance, Math.abs(wordAt - at));
    }
    scored.push({ symbol, distance });
  }
  scored.sort((a, b) => a.distance - b.distance);
  return scored[0]?.symbol ?? null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Turn a Gamma event into scoreable candidates.
 *
 * public-search returns *events*, each holding a `markets` array, and it does
 * not filter by open/closed - both have to be handled here.
 */
function candidatesFromEvent(event: GammaEvent): Candidate[] {
  if (event.closed || event.archived || event.active === false) return [];

  const out: Candidate[] = [];
  for (const market of event.markets ?? []) {
    if (market.closed || market.acceptingOrders === false) continue;

    const marketId = market.conditionId || market.id;
    if (!marketId) continue;

    const outcomes = parseJsonArray(market.outcomes);
    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (tokenIds.length === 0) continue;

    // Prefer the token that actually corresponds to "Yes"; fall back to the
    // first entry, which is the convention on these templated markets.
    const yesIndex = outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
    const yesTokenId = tokenIds[yesIndex >= 0 ? yesIndex : 0];
    if (!yesTokenId) continue;

    const prices = parseJsonArray(market.outcomePrices);
    const rawFallback = prices[yesIndex >= 0 ? yesIndex : 0];
    const parsedFallback = rawFallback === undefined ? NaN : Number.parseFloat(rawFallback);

    const question = market.question ?? event.title ?? "";
    const slug = market.slug || event.slug || "";
    const ticker = extractTicker(question, slug);
    if (!ticker) continue;

    out.push({
      marketId,
      yesTokenId,
      question,
      slug,
      pmUrl: `https://polymarket.com/event/${event.slug || slug}`,
      volume: toNumber(market.volumeNum ?? market.volume),
      ticker,
      fallbackPBeat: Number.isFinite(parsedFallback) ? parsedFallback : null,
      endDate: market.endDate ?? event.endDate ?? null,
    });
  }
  return out;
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!byId.has(c.marketId)) byId.set(c.marketId, c);
  }
  return [...byId.values()];
}

/**
 * Discovery is fully stateless: every run re-reads the board from scratch.
 * Falls back through the alternate search phrasings, then to a plain event
 * listing, before giving up.
 */
export async function discoverEarningsMarkets(): Promise<Candidate[]> {
  for (const query of SEARCH_QUERIES) {
    const url =
      `${GAMMA_BASE}/public-search?q=${encodeURIComponent(query)}` +
      `&limit_per_type=${GAMMA_SEARCH_LIMIT_PER_TYPE}`;
    try {
      const body = await getJson<{ events?: GammaEvent[] }>(url);
      const found = dedupe((body.events ?? []).flatMap(candidatesFromEvent));
      if (found.length > 0) {
        console.log(`discovery: "${query}" -> ${found.length} open candidates`);
        return found;
      }
      console.warn(`discovery: "${query}" returned no open candidates`);
    } catch (err) {
      console.error(`discovery: "${query}" failed`, err);
    }
  }

  try {
    const url = `${GAMMA_BASE}/events?active=true&closed=false&limit=100`;
    const body = await getJson<GammaEvent[] | { events?: GammaEvent[] }>(url);
    const events = Array.isArray(body) ? body : (body.events ?? []);
    const earnings = events.filter((e) =>
      `${e.title ?? ""} ${e.slug ?? ""}`.toLowerCase().includes("earnings"),
    );
    const found = dedupe(earnings.flatMap(candidatesFromEvent));
    console.log(`discovery: /events fallback -> ${found.length} open candidates`);
    return found;
  } catch (err) {
    console.error("discovery: /events fallback failed", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Pricing and flow
// ---------------------------------------------------------------------------

/** Crowd-assigned probability of a beat. The API returns `mid` as a string. */
export async function fetchPBeat(yesTokenId: string): Promise<number | null> {
  const body = await getJson<{ mid?: string | number }>(
    `${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(yesTokenId)}`,
  );
  const mid = typeof body.mid === "string" ? Number.parseFloat(body.mid) : Number(body.mid);
  return Number.isFinite(mid) ? mid : null;
}

/**
 * Fold a raw Polymarket trade onto the YES axis.
 *
 * /trades returns fills on *both* tokens of a binary market. Buying NO at
 * $0.22 is the same economic act as selling YES at $0.78, so a NO fill has its
 * side flipped and its price complemented. Skipping this step would count
 * bearish NO buying as bullish pressure on the beat and invert the conviction
 * signal exactly when it matters most - in markets where pBeat is already low.
 */
export function normalizeTrade(raw: RawTrade, yesTokenId: string): NormalizedTrade | null {
  const size = Number(raw.size);
  const price = Number(raw.price);
  const side = String(raw.side ?? "").toUpperCase();
  if (!Number.isFinite(size) || !Number.isFinite(price)) return null;
  if (side !== "BUY" && side !== "SELL") return null;

  // Most reliable first: the asset id is the token that actually traded.
  const isYes = raw.asset
    ? raw.asset === yesTokenId
    : raw.outcome
      ? raw.outcome.trim().toLowerCase() === "yes"
      : raw.outcomeIndex === 0;

  if (isYes) return { side, size, price };
  return { side: side === "BUY" ? "SELL" : "BUY", size, price: 1 - price };
}

/** Recent fills for a market, already normalised onto the YES axis. */
export async function fetchNormalizedTrades(
  conditionId: string,
  yesTokenId: string,
): Promise<NormalizedTrade[]> {
  const url =
    `${DATA_BASE}/trades?market=${encodeURIComponent(conditionId)}&limit=${TRADES_LIMIT}`;
  const body = await getJson<RawTrade[]>(url);
  if (!Array.isArray(body)) return [];
  return body
    .map((t) => normalizeTrade(t, yesTokenId))
    .filter((t): t is NormalizedTrade => t !== null);
}
