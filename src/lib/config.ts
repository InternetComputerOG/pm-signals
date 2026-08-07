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
 * record everything that passes the primary pBeat filter (see
 * MIN_RECORD_SCORE) and use MIN_PUBLISH_SCORE purely to decide whether a card
 * renders in the conviction tier or the de-emphasised watchlist tier.
 */
export const MIN_PUBLISH_SCORE = 50;

/**
 * Anything scoring above zero has, by definition, passed the primary
 * PEAD filter of pBeat <= 0.30, so it is worth a history row.
 */
export const MIN_RECORD_SCORE = 1;

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
 * A market clears the volume gate if it is big in absolute terms OR big
 * relative to the rest of today's earnings board.
 *
 * Spec said a flat `volume >= 5000`. Measured against the live API, zero of
 * the 26 currently-open earnings markets clear that (the largest was $4,333),
 * because volume only concentrates in the last days before resolution. The
 * relative gate keeps the dashboard alive in the quiet part of the cycle
 * while the absolute floor still admits everything genuinely liquid.
 */
export const VOLUME_ABSOLUTE_FLOOR = 5000;
export const VOLUME_TOP_PERCENTILE = 0.1;

/**
 * Free-plan Workers allow 50 subrequests per invocation. Each market costs two
 * (midpoint + trades) plus at most one Alpaca call, on top of one discovery
 * call, so this cap keeps a worst-case run at roughly 37 subrequests.
 * Candidates are ranked by volume before the cap is applied.
 */
export const MAX_MARKETS_PER_RUN = 12;

/** How many markets are scored concurrently. Keeps wall time down. */
export const SCORING_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Large-trade ("whale") detection
// ---------------------------------------------------------------------------

export const TRADES_LIMIT = 200;

/**
 * A trade is a "whale" trade only if it is large in absolute terms AND sits in
 * the top slice of that market's own fills. Note this is a conjunction, unlike
 * the volume gate above - it is strictly narrower than the spec's flat
 * `notional >= 1000`, not looser.
 *
 * The consequence is deliberate and worth stating plainly: away from
 * resolution dates almost no earnings market has $1,000 prints (on the busiest
 * open market the largest fill was $304 and the median was $4.40), so most
 * markets report an imbalance of exactly zero and degrade to a price-only
 * signal. That is the correct behaviour - it is an honest "no whale flow here
 * yet" rather than conviction manufactured from $5 trades - and it is why
 * sub-threshold scores still render, in the watchlist tier.
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
