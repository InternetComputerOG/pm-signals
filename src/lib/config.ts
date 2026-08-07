/**
 * Every tunable in the system lives here.
 *
 * The product spec fixed several constants at values that, against live
 * Polymarket data, filter out literally every market. Where a value has been
 * adapted, the spec's original is stated next to it so the trade-off is
 * auditable. Nothing here is a trading parameter - this is a showcase.
 */

// ---------------------------------------------------------------------------
// Publication tiers
// ---------------------------------------------------------------------------

/**
 * The "conviction" bar. Spec value, unchanged.
 *
 * Note what this threshold means once the imbalance multiplier is unavailable:
 * computePeadsStrength only reaches 50 when pBeat <= 0.05, so a price-only
 * signal essentially never clears it. Rather than silently discard those, we
 * record every market we spend subrequests on and use MIN_PUBLISH_SCORE purely
 * to decide whether a card renders in the conviction tier or one of the two
 * de-emphasised tiers below it.
 */
export const MIN_PUBLISH_SCORE = 50;

/**
 * The paper's primary filter. A market at or below this is inside the thesis
 * and scores above zero; above it, computePeadsStrength returns 0.
 *
 * Duplicated as a constant (signals.ts hard-codes 0.30 to stay import-free)
 * so that render.ts can tell a "passed the filter but scored low" watchlist
 * row apart from a "has not crossed yet" radar row. Both have strength 0 at
 * the boundary, so strength alone cannot distinguish them.
 */
export const PEAD_FILTER_CEILING = 0.3;

/**
 * The radar tier: markets close enough to the primary filter to be worth
 * tracking before they cross it.
 *
 * Everything between PEAD_FILTER_CEILING and this value scores 0 by design -
 * it is outside the thesis. It is still recorded, because the useful early
 * signal is the *drift*: a market falling 0.45 -> 0.34 -> 0.29 arrives at the
 * filter with ten days of history behind it instead of appearing from nowhere.
 */
export const RADAR_PBEAT_CEILING = 0.5;

// ---------------------------------------------------------------------------
// Market discovery
// ---------------------------------------------------------------------------

export const GAMMA_BASE = "https://gamma-api.polymarket.com";
export const CLOB_BASE = "https://clob.polymarket.com";
export const DATA_BASE = "https://data-api.polymarket.com";

/** Tried in order; the first query that yields candidates wins. */
export const SEARCH_QUERIES = ["earnings", "beat earnings", "quarterly earnings"];

export const GAMMA_SEARCH_LIMIT_PER_TYPE = 50;

/**
 * Volume is a *display* threshold, not a gate. Below this a market's book is
 * labelled "thin" on its card, so a $10 book does not read as equivalent to a
 * $900 one.
 *
 * It used to gate discovery, disjunctively with a top-10% relative floor, and
 * that was the bug that emptied the dashboard: selecting on liquidity selects
 * against the low-probability names the thesis is about. Measured live on
 * 2026-08-07, the gate admitted SPCE (pYes 0.85), HD (0.79) and RKLB (0.30
 * exactly) and discarded all five markets that actually passed the primary
 * filter. Selection now ranks on price - see selectCandidates in pipeline.ts.
 */
export const VOLUME_ABSOLUTE_FLOOR = 5000;

/**
 * Free-plan Workers allow 50 subrequests per invocation. Each market costs two
 * (midpoint + trades) plus at most one Alpaca call, on top of one discovery
 * call, so this cap keeps a worst-case run at roughly 37 subrequests.
 */
export const MAX_MARKETS_PER_RUN = 12;

/**
 * Floor on how many markets a run tracks, so the board is never empty while
 * any earnings market is open at all.
 *
 * When fewer than this clear RADAR_PBEAT_CEILING, the run backfills with the
 * lowest-priced markets remaining regardless of how far above the ceiling they
 * sit. Those render honestly - a card reading "P(beat) 76%" is itself the
 * information that the board has nothing near the thesis right now.
 */
export const MIN_TRACKED_MARKETS = 6;

/**
 * Effective price discount applied to markets already in the history window,
 * so a series in progress outranks a fresh candidate at the same price and
 * keeps extending. Small on purpose: a tracked market that has drifted to 0.9
 * should still lose its slot to a new candidate at 0.2.
 */
export const TRACKED_PRIORITY_BONUS = 0.05;

/** How many markets are scored concurrently. Keeps wall time down. */
export const SCORING_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Large-trade ("whale") detection
// ---------------------------------------------------------------------------

export const TRADES_LIMIT = 200;

/**
 * A trade is a "whale" trade only if it is large in absolute terms AND sits in
 * the top slice of that market's own fills. The conjunction makes this
 * strictly narrower than the spec's flat `notional >= 1000`, not looser.
 *
 * The consequence is deliberate and worth stating plainly: away from
 * resolution dates almost no earnings market has $1,000 prints (on the busiest
 * open market the largest fill was $304 and the median was $4.40), so most
 * markets report an imbalance of exactly zero and degrade to a price-only
 * signal. That is the correct behaviour - it is an honest "no whale flow here
 * yet" rather than conviction manufactured from $5 trades - and it is why
 * sub-threshold scores still render, in the watchlist and radar tiers.
 */
export const LARGE_TRADE_ABSOLUTE_FLOOR = 1000;
export const LARGE_TRADE_TOP_PERCENTILE = 0.05;

// ---------------------------------------------------------------------------
// History window
// ---------------------------------------------------------------------------

export const HISTORY_WINDOW_DAYS = 10;

// ---------------------------------------------------------------------------
// Alpaca (free tier, IEX feed only)
// ---------------------------------------------------------------------------

/**
 * Market data only. Alpaca keys also open https://paper-api.alpaca.markets,
 * the trading API, and that base is deliberately absent here: this project
 * reads prices and places no orders. Pointing the client at paper-api would
 * 404 on every request, since /v2/stocks/... lives on the data host.
 */
export const ALPACA_BASE = "https://data.alpaca.markets";

/**
 * The free plan is IEX-only. Asking for "sip" returns HTTP 403
 * ("subscription does not permit querying recent SIP data"), verified live.
 */
export const ALPACA_FEED = "iex";

export const ALPACA_BARS_LIMIT = 15;

// ---------------------------------------------------------------------------
// Ticker extraction
// ---------------------------------------------------------------------------

/**
 * Uppercase tokens that look like tickers but are not. The spec's bare
 * /\b([A-Z]{1,5})\b/ happily matches EPS and GAAP, both of which appear in
 * nearly every Polymarket earnings slug.
 */
export const TICKER_BLOCKLIST: ReadonlySet<string> = new Set([
  "EPS", "GAAP", "NONGAAP", "CEO", "CFO", "COO", "IPO", "ETF", "SEC", "NYSE",
  "IRS", "FED", "GDP", "CPI", "USA", "US", "UK", "EU", "AI", "FY", "YOY",
  "QOQ", "Q1", "Q2", "Q3", "Q4", "YES", "NO", "TBD", "AM", "PM", "ET", "UTC",
  "WILL", "THE", "AND", "FOR", "NEW", "INC", "CORP", "LTD", "PLC", "CO",
  "HOLD", "BEAT", "MISS", "REV", "NET", "ATH", "OR", "A", "I",
]);

/** Words whose neighbourhood makes a nearby uppercase token likelier to be a ticker. */
export const TICKER_CONTEXT_WORDS = ["earnings", "beat", "eps"];
