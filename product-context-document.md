# Product Context Document: PM Stock Signal Dashboard

**Conditional PEAD Short + Whale Order-Flow Imbalance Signals**

| | |
| --- | --- |
| Version | 2.1 |
| Status | Implemented and verified end-to-end against live APIs, Alpaca included |
| Supersedes | v2.0 (Alpaca unconfigured), v1.0 (pre-implementation draft) |
| Last verified against live data | 2026-08-07 |

> **Read this first.** v1.0 of this document was written before any code existed. Implementing it
> surfaced two sign inversions and three threshold values that, against real Polymarket data,
> filtered out every market on the board. Those are corrected here, and every correction is
> recorded in [Section 18](#18-corrections-to-v10) with the evidence that motivated it. Where this
> document and v1.0 disagree, **this document is authoritative**, and it matches the code.
>
> **v2.1** records the first run with Alpaca credentials actually configured. The client was written
> in v2.0 but had never been exercised against a live account, so every observation on record had a
> null price. It now returns prices; see [Section 3.2](#32-alpaca-verified-behaviour) for the
> free-tier behaviours that verification surfaced and [Section 19](#19-observed-baseline-2026-08-07)
> for the refreshed baseline.

---

## 1. Goal

Build a minimal, fully free, Cloudflare-native application that discovers Polymarket earnings
markets, computes the PEAD-short + large-trade imbalance signals, stores a rolling 10-day history
of scores, and publishes active signals to a single public chronological landing page (one card per
ticker, sorted strongest to weakest). The landing page includes an overlay graph of
prediction-market price, signal strength, and stock-price trendlines for the past 10 days.

The system runs entirely on the Cloudflare Free tier, contains zero LLM inference, and uses only
public Polymarket endpoints plus the Alpaca Market Data free tier.

**This is a polished public code sample / showcase only. It is not a trading system.** It produces
no advice, executes nothing, and has never been validated out of sample.

---

## 2. Core Premise (Research Basis)

Source: Chloe Feng (2026), "Minority Report: Contrarian Traders, Prediction Markets, and the Return
of Post-Earnings Drift" (SSRN `abstract_id=6477080` / `6578598`).

- **Primary filter:** Polymarket YES (beat) mid-price `pBeat <= 0.30`.
- **Conviction:** strong directional large-trade order-flow imbalance, especially net selling
  pressure.
- When both conditions are present the short-side signal is strongest. Low crowd-assigned beat
  probability alone already produces significant 10-day post-announcement returns; strong
  directional flow further raises realized beat certainty.
- The low-probability PEAD condition is the **primary filter**; the large-trade imbalance is the
  **conviction multiplier**.

The filter gates the multiplier rather than summing with it. If `pBeat > 0.30` the score is zero no
matter how lopsided the order flow is.

---

## 3. Data Sources (Exact)

### Polymarket (public, no key)

| API | Base URL |
| --- | --- |
| Gamma | `https://gamma-api.polymarket.com` |
| CLOB | `https://clob.polymarket.com` |
| Data | `https://data-api.polymarket.com` |

### Alpaca Market Data free tier (IEX only)

- Base: `https://data.alpaca.markets`
- Auth headers on every request: `APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`
- **Optional.** Stock price is the third trendline on the chart, never an input to the score. With
  no keys the app runs normally and records `current_stock_price` as `NULL`.

An Alpaca paper-trading account issues a single key pair valid against **two different hosts**:
`https://paper-api.alpaca.markets` (the trading API) and `https://data.alpaca.markets` (market
data). Only the second is used. The `/v2/stocks/...` paths this system calls do not exist on the
trading host, so pointing `ALPACA_BASE` at `paper-api` would 404 every request — and placing orders
is out of scope regardless (Section 15). `ALPACA_BASE` carries a comment to that effect so the
distinction is not rediscovered.

No other data providers are necessary.

### 3.1 Verified response shapes

These were confirmed by calling the live endpoints. Several differ from what v1.0 assumed, and
getting them wrong is silent rather than loud.

**`GET /public-search?q=earnings&limit_per_type=50`** returns `{ events, pagination }` — **not** a
flat market list. Markets are nested at `event.markets[]`, and **closed events are included**, so
open-filtering must happen client-side.

**`clobTokenIds`, `outcomes`, and `outcomePrices` are JSON-encoded strings, not arrays.** They must
be `JSON.parse`d:

```jsonc
{
  "conditionId": "0x27dc7db9...",
  "question": "Will Home Depot (HD) beat quarterly earnings?",
  "slug": "hd-quarterly-earnings-nongaap-eps-08-18-2026-4pt73",
  "clobTokenIds": "[\"35231036...\", \"27774296...\"]",  // string!
  "outcomes": "[\"Yes\", \"No\"]",                        // string!
  "outcomePrices": "[\"0.79\", \"0.21\"]",                // string!
  "volumeNum": 2012.48,
  "closed": false,
  "acceptingOrders": true
}
```

**`GET /midpoint?token_id=...`** returns `{"mid":"0.79"}` — `mid` is a **string**, needs
`parseFloat`.

**`GET /trades?market={conditionId}&limit=200`** returns a bare array. Critically, it contains fills
on **both** tokens of the binary market:

```jsonc
{
  "side": "BUY",
  "size": 22,
  "price": 0.22,
  "asset": "27774296...",   // the NO token id
  "outcome": "No",
  "outcomeIndex": 1,
  "conditionId": "0x27dc7db9...",
  "timestamp": 1786107774
}
```

**Alpaca without credentials** returns a **401 with an nginx HTML body**, not JSON. Clients must
check status before parsing and must not blindly `JSON.parse` error responses.

### 3.2 Alpaca verified behaviour

Confirmed against a live free-tier paper account on 2026-08-07. The v2.0 client was written from the
documentation and never run with real keys, so these are the first observations of what it actually
faces.

| Call | Result |
| --- | --- |
| `GET {DATA}/v2/stocks/RKLB/snapshot?feed=iex` | `200`, with `latestTrade.p`, `dailyBar.c`, and `prevDailyBar.c` all present — exactly the fields the client reads, in that precedence |
| `GET {DATA}/v2/stocks/RKLB/bars?...&feed=iex` | `200`, `bars` **oldest first**, which is why the client takes `.at(-1)` |
| `GET {DATA}/v2/stocks/RKLB/snapshot?feed=sip` | `403 {"message":"subscription does not permit querying recent SIP data"}` |
| `GET {DATA}/v2/stocks/ZZZZ/snapshot?feed=iex` | `404 {"message":"no snapshot found for ZZZZ"}` — JSON, unlike the 401 |
| Same call with no auth headers | `401`, nginx HTML |

Two consequences are load-bearing:

- **`feed=iex` is not a preference, it is the only option.** SIP is a hard 403 on this plan, so the
  constant must not be "upgraded" without a paid subscription behind it.
- **A 404 is routine, not a failure.** Polymarket lists earnings markets for names that are not
  US-listed equities, and those tickers will never resolve. The client logs 404 at `warn` and
  everything else at `error`, so a genuine misconfiguration (401/403) or a rate limit (429) is not
  buried in noise from symbols that were never going to price.

---

## 4. Market Discovery (Exact)

Every cron run is fully stateless and re-discovers markets from scratch. The only thing read back
out of D1 is the set of already-tracked market ids.

1. Call `GET https://gamma-api.polymarket.com/public-search?q=earnings&limit_per_type=50`.
   Fallback queries, tried in order until one yields candidates: `beat earnings`, then
   `quarterly earnings`. Final fallback:
   `GET /events?active=true&closed=false&limit=100`, filtered client-side for "earnings".
2. **Flatten** `events[].markets[]` into a candidate list, de-duplicated by `conditionId`.
3. **Filter to genuinely open markets.** Drop the event if `closed`, `archived`, or
   `active === false`. Drop the market if `closed` or `acceptingOrders === false`.
4. Parse the JSON-string fields. Extract:
   - `market_id` = `conditionId` (falling back to `id`)
   - YES `token_id` = the entry of `clobTokenIds` at the index where `outcomes` is `"Yes"`,
     falling back to index 0
   - `question`, `slug`
   - `pm_url` = `https://polymarket.com/event/${event.slug}`
   - `volume` = `volumeNum ?? volume`
   - `fallbackPBeat` = the YES entry of `outcomePrices`, used only if the CLOB midpoint call fails
5. **Ticker extraction** — see Section 4.2.
6. **Volume gate** — see Section 4.1.
7. Rank surviving candidates by volume descending and cap at `MAX_MARKETS_PER_RUN` (12), to stay
   inside the free plan's subrequest budget.

### 4.1 Volume gate (disjunctive)

A market qualifies if **either** condition holds:

```
volume >= VOLUME_ABSOLUTE_FLOOR (5000)
  OR
volume >= the top VOLUME_TOP_PERCENTILE (10%) cut-off of this run's open candidates
```

**Why the relative half exists.** Measured live on 2026-08-07: of 26 open earnings markets,
**zero** cleared a flat `volume >= 5000`. The largest was $4,333. Volume on these markets only
concentrates in the last days before resolution, so the flat floor from v1.0 would have produced a
permanently empty dashboard outside earnings peaks. The absolute floor still admits everything
genuinely liquid.

### 4.2 Ticker extraction (layered, most precise first)

v1.0 specified a bare `\b([A-Z]{1,5})\b` against the question and slug. That matches `EPS` and
`GAAP`, both of which appear in nearly every Polymarket earnings slug. Replaced with three layers,
each filtered through a blocklist:

1. **Parenthesised symbol in the question** — `Will Home Depot (HD) beat quarterly earnings?`
   Polymarket earnings markets are templated, so this resolves essentially every real market.
   Punctuation is stripped, so `(BRK.B)` yields `BRKB`.
2. **Slug prefix** — `hd-quarterly-earnings-nongaap-eps-08-18-2026-4pt73` yields `HD`.
3. **The v1.0 regex**, preferring tokens positioned near `earnings`, `beat`, or `eps`, as a last
   resort.

Returns `null` rather than guessing when nothing survives; candidates without a ticker are dropped.

**Blocklist** (`TICKER_BLOCKLIST`): `EPS`, `GAAP`, `NONGAAP`, `CEO`, `CFO`, `COO`, `IPO`, `ETF`,
`SEC`, `NYSE`, `IRS`, `FED`, `GDP`, `CPI`, `USA`, `US`, `UK`, `EU`, `AI`, `FY`, `YOY`, `QOQ`,
`Q1`-`Q4`, `YES`, `NO`, `TBD`, `AM`, `PM`, `ET`, `UTC`, `WILL`, `THE`, `AND`, `FOR`, `NEW`, `INC`,
`CORP`, `LTD`, `PLC`, `CO`, `HOLD`, `BEAT`, `MISS`, `REV`, `NET`, `ATH`, `OR`, `A`, `I`.

> Single letters such as `A` (Agilent) can be genuine tickers, but they are blocklisted because the
> false-positive rate from ordinary prose dominates. Supporting them would need an allowlist
> exception.

---

## 5. Signal Computation (Pure Functions – Exact)

All of this lives in `src/lib/signals.ts` with no I/O, no clock, and no randomness.

```ts
/** Primary PEAD filter. 0-60, rising linearly as pBeat falls below 0.30. */
function computePeadsStrength(pBeat: number): number {
  if (pBeat > 0.3) return 0;
  return Math.min(60, Math.round((0.3 - pBeat) * 200));
}

/**
 * Net large-trade order-flow imbalance on the YES axis, in [-1, 1].
 * Negative = net selling pressure against the beat.
 *
 * Trades MUST already be normalised onto the YES axis (Section 5.1).
 */
function computeImbalanceAbove(trades: NormalizedTrade[], minNotional: number): number {
  let buy = 0, sell = 0;
  for (const t of trades) {
    const notional = t.size * t.price;
    if (notional < minNotional) continue;
    if (t.side === "BUY") buy += notional;
    else sell += notional;
  }
  const total = buy + sell;
  if (total === 0) return 0;
  return (buy - sell) / total; // negative = selling pressure
}

/** v1.0's fixed-floor form, retained so the spec'd bar stays under test. */
function computeImbalance(trades: NormalizedTrade[]): number {
  return computeImbalanceAbove(trades, 1000);
}

/**
 * Conviction multiplier. Deliberately a coarse step function: the paper
 * supports "strong directional flow", not a precise elasticity.
 */
function computeImbalanceStrength(imbalance: number): number {
  if (imbalance >= -0.3) return 0;
  if (imbalance <= -0.7) return 40;
  return 25;
}

/** Combined 0-100 score. The filter gates the multiplier. */
function computeTotalScore(pBeat: number, imbalance: number): number {
  const pead = computePeadsStrength(pBeat);
  if (pead === 0) return 0; // primary filter
  return Math.min(100, pead + computeImbalanceStrength(imbalance));
}

/**
 * Cut-off of the top `fraction` of values. Used by both adaptive gates.
 * The slice always holds at least one item, so on small samples this
 * degenerates to "the largest value" — intended, since a market with four
 * fills has no meaningful 5% tail. Infinity for empty input.
 */
function topPercentileThreshold(values: number[], fraction: number): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => b - a);
  const take = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * fraction)));
  return sorted[take - 1];
}
```

> **`(buy - sell)`, not `(sell - buy)`.** This is a correction to v1.0. See
> [Section 18.1](#181-the-imbalance-sign-was-inverted).

### 5.1 Trade side normalization (mandatory pre-step)

`/trades` returns fills on both tokens. **Buying NO at $0.22 is the same economic act as selling YES
at $0.78.** Every raw fill is folded onto the YES axis before it reaches the scoring functions:

```ts
// Most reliable discriminator first: the asset id is the token that traded.
const isYes = raw.asset ? raw.asset === yesTokenId
            : raw.outcome ? raw.outcome.trim().toLowerCase() === "yes"
            : raw.outcomeIndex === 0;

if (isYes) return { side, size, price };
return { side: side === "BUY" ? "SELL" : "BUY", size, price: 1 - price };
```

Complementing the price (`1 - price`) keeps `size * price` a consistent **YES-equivalent notional**
across both tokens, which is what makes the ratio in `computeImbalanceAbove` meaningful.

Skipping this step inverts the conviction signal precisely in the markets that matter most — the
ones where `pBeat` is already low and NO is therefore the busy side.

### 5.2 Whale threshold (conjunctive)

A fill counts as a whale print only if **both** conditions hold:

```
notional >= LARGE_TRADE_ABSOLUTE_FLOOR (1000)
  AND
notional >= the top LARGE_TRADE_TOP_PERCENTILE (5%) cut-off of this market's fills
```

Implemented as `threshold = Math.max(absoluteFloor, topPercentileThreshold(notionals, 0.05))`.

Note this is a **conjunction**, unlike the volume gate — it is strictly *narrower* than v1.0's flat
`notional >= 1000`, not looser. Requiring both is what stops a quiet market's largest $12 print from
being promoted to "whale" status merely because it is the biggest thing present.

**The consequence is deliberate.** Away from resolution dates almost no earnings market has $1,000
prints — on the busiest open market the largest fill was $303.67 and the median was $4.40 — so most
markets report an imbalance of exactly `0` and degrade to a **price-only signal**. That is the
honest outcome; manufacturing conviction out of $5 trades would be worse than reporting none. It is
also why sub-threshold scores still render, in the watchlist tier (Section 6).

### 5.3 Data fetching per candidate

| Value | Call |
| --- | --- |
| `pBeat` | `GET {CLOB}/midpoint?token_id={yesTokenId}` → `parseFloat(mid)`; falls back to Gamma's `outcomePrices` |
| Trades | `GET {DATA}/trades?market={conditionId}&limit=200` → normalize (5.1) → threshold (5.2) |
| Stock price | `GET {ALPACA}/v2/stocks/{ticker}/snapshot?feed=iex` → `latestTrade.p`, then `dailyBar.c`, then `prevDailyBar.c` |
| Stock price fallback | `GET {ALPACA}/v2/stocks/{ticker}/bars?timeframe=1Day&start={ISO-10d}&end={now}&feed=iex&limit=15` → last bar close |

Alpaca is only called for markets that are actually going to be recorded, which conserves both the
subrequest budget and the Alpaca rate limit.

**The bars fallback is skipped when the snapshot returns 404.** A symbol the feed cannot resolve has
no bars either, so the second call is guaranteed waste. This matters against the subrequest budget:
without the short-circuit, a board of twelve unlistable tickers would spend 24 subrequests to learn
nothing. The fallback still runs for any other snapshot outcome, since an empty-but-200 snapshot is
the normal state outside market hours and bars do answer then.

---

## 6. Publication & History Rules

`MIN_PUBLISH_SCORE` is **50**, but it selects a *card tier*, not admission to the database.

**Why the change from v1.0.** With no whale flow to add, `computePeadsStrength` only reaches 50 when
`pBeat <= 0.05`. Combined with Section 5.2 — where most markets legitimately have no whale flow — a
strict `>= 50` insert gate would discard nearly every real observation and leave the page empty. A
price-only signal at `pBeat = 0.19` scores 22 and is genuinely informative; it should be visible,
just visibly weaker.

| Rule | Behaviour |
| --- | --- |
| `MIN_RECORD_SCORE = 1` | Any market passing the primary `pBeat <= 0.30` filter gets a history row. Score 0 means it failed the filter. |
| `MIN_PUBLISH_SCORE = 50` | Cards at or above render in the **conviction** tier; below, in a de-emphasised **watchlist** tier. |
| Re-record rule | Any `market_id` with at least one record inside the past 10 days is recorded on every subsequent run **even when its score drops to 0**, so decays and reversals stay visible instead of the series simply stopping. |
| Row identity | Every observation is a fresh insert with `crypto.randomUUID()`. The table is append-only; nothing is ever updated in place. |
| Active signals for the UI | Any ticker with at least one record in the past 10 days. |

---

## 7. Architecture

A single Cloudflare Worker containing one scheduled handler, two Hono HTTP routes, pure signal
functions, and thin API clients. All state lives in one D1 database.

```
Cron (every 12h)
  -> Gamma  /public-search?q=earnings   discover, flatten events, filter open
  -> volume gate + ticker extraction + rank by volume, cap at 12
  -> CLOB   /midpoint                   pBeat
  -> Data   /trades                     normalize to YES axis -> whale threshold -> imbalance
  -> score  computeTotalScore
  -> record if score >= 1 OR already tracked in the last 10 days
  -> Alpaca /snapshot, /bars            stock price (optional, recorded markets only)
  -> D1     signal_history              one append-only row per observation

HTTP
  GET /            server-rendered cards, chart data embedded in the document
  GET /feed.json   the same rolling window as JSON
  GET /style.css   served from public/ by Workers Static Assets
```

Markets are scored with a bounded concurrency of `SCORING_CONCURRENCY = 4`.

---

## 8. Tech Stack

| Concern | Choice |
| --- | --- |
| Runtime | Cloudflare Workers (`compatibility_date = "2026-08-01"`) |
| Framework | Hono `^4.13.1` (TypeScript) |
| Database | Cloudflare D1 |
| Static assets | Workers Static Assets (`[assets] directory = "./public"`) |
| Package manager | npm |
| Deploy | Wrangler `^4.120.0` |
| Tests | Vitest `^3.2.7` |
| Frontend | Server-rendered HTML + Chart.js 4 (CDN) + one external stylesheet |

No React, Next.js, KV, R2, Durable Objects, queues, or external cron services. No build step for
the frontend.

> **Vitest is pinned to 3.x deliberately.** Vitest 4.x triggers a resolver crash in npm 11.1.0
> (`TypeError: Cannot read properties of null (reading 'edgesOut')` in arborist's peer-set
> resolution). Vitest 3.2.7 resolves cleanly. Revisit when npm is upgraded.

---

## 9. Project Structure

```
/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── schema.sql
├── README.md
├── product-context-document.md    # this file
├── .dev.vars.example
├── public/
│   └── style.css
└── src/
    ├── index.ts                   # Hono routes + scheduled handler
    └── lib/
        ├── config.ts              # every tunable, with v1.0 values documented
        ├── polymarket.ts          # Gamma + CLOB + Data clients, ticker extraction
        ├── alpaca.ts              # snapshot + bars, degrades to null
        ├── signals.ts             # pure PEAD + imbalance + score
        ├── pipeline.ts            # the scheduled pass
        ├── db.ts                  # D1 helpers
        ├── render.ts              # server-rendered HTML
        ├── signals.test.ts
        ├── render.test.ts
        └── alpaca.test.ts
```

Three files are additions to v1.0's structure: `config.ts` (so no threshold is buried in a
function body), `pipeline.ts` (so `index.ts` stays a thin entry point), and `render.ts`.
`alpaca.test.ts` was added in v2.1, when the client stopped being hypothetical.

---

## 10. D1 Schema (Exact)

Unchanged from v1.0 apart from `IF NOT EXISTS` for idempotent re-application.

```sql
CREATE TABLE IF NOT EXISTS signal_history (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  p_beat REAL NOT NULL,
  imbalance REAL NOT NULL,
  strength INTEGER NOT NULL,
  current_stock_price REAL,
  pm_url TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_ticker_time ON signal_history(ticker, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_market_time ON signal_history(market_id, recorded_at DESC);
```

### 10.1 Timestamp handling (load-bearing)

`recorded_at` is **left to the column default** and never written from the Worker. This keeps every
row in SQLite's `YYYY-MM-DD HH:MM:SS` UTC format, which is what makes the window comparisons
correct:

```sql
WHERE recorded_at >= datetime('now', '-10 days')
```

Writing ISO-8601 with a `T` and a `Z` would break these comparisons lexicographically — silently,
and only for some rows. Conversion to ISO-8601 happens on the way *out*, in `toIso()`, for
`/feed.json` and chart labels.

---

## 11. Cron

```toml
[triggers]
crons = ["0 */12 * * *"]
```

The handler performs full rediscovery, scoring, and history insertion in one pass, and is `await`ed
rather than handed to `waitUntil` so a failure surfaces as a failed scheduled invocation.

In local development the timer does not fire. Trigger a pass by hand against
`wrangler dev --test-scheduled`:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*/12+*+*+*"
```

---

## 12. Public Endpoints

### `GET /`

Server-rendered HTML.

- One card per active ticker, sorted strongest → weakest by **latest** strength (not peak strength).
- Each card shows ticker, latest `p_beat` as a percentage, latest imbalance rendered as
  "−84% sell" / "+12% buy" / "no whale flow", latest stock price (an em dash when null), the
  observation count, the latest timestamp, and a Polymarket link.
- Cards carry a `conviction` or `watchlist` class per Section 6.
- Each card contains an overlay line chart (Chart.js 4 via CDN) covering the past 10 days.
- **Chart data is embedded** as JSON in the document, so the page paints complete in one round
  trip. `/feed.json` exists for programmatic consumers, not for the page.
- Empty state renders when no ticker is active, explaining that liquidity concentrates near
  resolution dates.
- Tiny external stylesheet at `/style.css`. No auto-refresh meta tag.

**Chart axes.** Three series over one shared time axis built from `recorded_at`, using two y-axes:

| Series | Axis | Style |
| --- | --- | --- |
| `p_beat`, rendered ×100 as a percentage | left, `0-100` | solid blue |
| `strength` | left, `0-100` | solid red |
| `current_stock_price` | right, USD, autoscaled | dashed amber |

The price series **and its axis** are omitted per chart when that ticker has no recorded price, so a
keyless deployment shows two clean series rather than an empty axis.

The stock series is read from the stored `current_stock_price` column rather than re-fetching Alpaca
bars at render time. This puts all three series on identical timestamps, avoids per-pageview API
calls against the free tier, and matches the schema as written.

**Escaping.** All interpolated text is HTML-escaped, and the embedded JSON has `<` escaped to
`\u003c` so a value containing `</script>` cannot terminate the block early. Both are covered by
tests.

### `GET /feed.json`

The same rolling 10-day window, oldest first, with `recorded_at` converted to ISO-8601.

```json
[
  {
    "id": "81239f4c-ab14-4387-8f84-763ce62c6904",
    "market_id": "0x0977f25e40d4bbc770246f6fa75c7353ce11a950a7c20ca83bb48ffb122c34df",
    "ticker": "RKLB",
    "p_beat": 0.29,
    "imbalance": 0,
    "strength": 2,
    "current_stock_price": null,
    "pm_url": "https://polymarket.com/event/rklb-quarterly-earnings-gaap-eps-08-10-2026-neg0pt08",
    "recorded_at": "2026-08-07T14:53:25Z"
  }
]
```

`imbalance` is in `[-1, 1]`; **negative means net selling pressure against the beat**.

---

## 13. Configuration & Secrets

```toml
name = "pead-whale-feed"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[[d1_databases]]
binding = "DB"
database_name = "pead-whale"
database_id = "..."          # from `wrangler d1 create pead-whale`

[assets]
directory = "./public"

[triggers]
crons = ["0 */12 * * *"]

[observability]
enabled = true
```

### Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `ALPACA_API_KEY` | No | Alpaca Market Data, free tier (IEX feed) |
| `ALPACA_SECRET_KEY` | No | Same |

Set with `wrangler secret put`, or locally via `.dev.vars` (see `.dev.vars.example`).

Still "No" in the required column, and that stays true — the app is fully functional without them.
A configured pair is now the *expected* deployment, though, because a chart with two of its three
series is the degraded mode, not the intended one. `.dev.vars` is gitignored; since this is a public
code sample, real keys must never reach a commit.

### Constants — all in `src/lib/config.ts`

| Constant | Value | v1.0 | Notes |
| --- | --- | --- | --- |
| `MIN_PUBLISH_SCORE` | `50` | `50` | Now selects a card tier, not database admission |
| `MIN_RECORD_SCORE` | `1` | — | Insert bar; equivalent to "passed the primary filter" |
| `VOLUME_ABSOLUTE_FLOOR` | `5000` | `5000` | One half of a disjunction |
| `VOLUME_TOP_PERCENTILE` | `0.10` | — | The other half. See 4.1 |
| `LARGE_TRADE_ABSOLUTE_FLOOR` | `1000` | `1000` | One half of a **conjunction** |
| `LARGE_TRADE_TOP_PERCENTILE` | `0.05` | — | The other half. See 5.2 |
| `TRADES_LIMIT` | `200` | `200` | Unchanged |
| `HISTORY_WINDOW_DAYS` | `10` | `10` | Unchanged |
| `GAMMA_SEARCH_LIMIT_PER_TYPE` | `50` | `50` | Unchanged |
| `MAX_MARKETS_PER_RUN` | `12` | — | Free-tier subrequest guard. See 13.1 |
| `SCORING_CONCURRENCY` | `4` | — | Bounded parallelism |
| `ALPACA_BARS_LIMIT` | `15` | `15` | Unchanged |
| `ALPACA_FEED` | `"iex"` | `"iex"` | Free tier is IEX-only; `"sip"` is a hard 403. See 3.2 |
| `SEARCH_QUERIES` | 3 phrasings | 3 phrasings | Unchanged |
| `TICKER_BLOCKLIST` | 52 tokens | — | See 4.2 |

### 13.1 Free-tier budget

**Workers Free allows 50 subrequests per invocation.** This is the binding constraint on the
scheduled pass, and v1.0 did not account for it.

```
1 discovery call
+ 12 markets x 2 (midpoint + trades)  = 24
+ up to 12 Alpaca calls (recorded only) = 12
-------------------------------------------
  37 worst case, against a limit of 50
```

The Alpaca line is "up to 12" rather than "up to 24" because `fetchCurrentPrice` costs a second
subrequest only when the snapshot comes back empty but valid. A 404 short-circuits (Section 5.3),
and in practice the snapshot answers on the first call.

`MAX_MARKETS_PER_RUN = 12` is derived from that arithmetic. Raising it risks mid-run failures.
D1 queries do not count against the subrequest limit.

Two cron invocations per day sit far inside the 100k requests/day allowance.

---

## 14. Error Handling

On any upstream failure (Gamma, CLOB, Data API, or Alpaca), log with `console.error` and **skip that
market**; continue processing the rest. No retries, circuit breakers, or external alerting.

Specifics learned during implementation:

- Each market is scored inside its own `try/catch`, so one bad market cannot abort the run.
- Alpaca helpers **never throw**. They return `null` (or `[]`) on missing credentials, non-2xx
  status, or unparseable bodies. Stock price is decorative, so it must not be able to fail a run.
  The one gradation: a 404 logs at `console.warn`, because an unlistable ticker is expected, while
  everything else logs at `console.error`. Both still return `null`.
- Discovery falls through its three search phrasings and then the `/events` listing before giving
  up, and returns `[]` rather than throwing.
- Every run logs a one-line summary:
  `run complete: discovered=26 gated=3 scored=3 recorded=1 skipped=0`

---

## 15. Explicitly Out of Scope

- Any LLM or AI summarization
- Financial Modeling Prep or any data source other than Polymarket + Alpaca
- User accounts, authentication, or notifications
- Real-time WebSockets
- Backtesting UI or performance tracking beyond the 10-day graphs
- Complex order-book analysis beyond the large-trade imbalance defined above
- Production monitoring beyond console logs

---

## 16. Success Criteria

- [x] Landing page displays active tickers as cards sorted by latest strength, each with the
      required overlay graph of `p_beat`, strength, and stock price over the past 10 days.
- [x] `/feed.json` returns the history data needed by the graphs.
- [x] Discovery + scoring runs every 12 hours, stays inside free-tier limits, and correctly records
      both new signals and subsequent score updates for previously seen markets.
- [x] Codebase is small, well-commented, and structured as a polished public sample.
- [x] `README.md` explains the Feng (2026) basis, the `P <= 0.30` + directional-flow logic, deploy
      steps, required secrets, and that the project is a showcase only.
- [x] The stock-price trendline is populated from live Alpaca data, not just structurally supported.
      Through v2.0 the first criterion was met in code but every recorded price was `NULL`.

---

## 17. Implementation Notes

- Prefer pure functions for all signal math. `signals.ts` has no imports.
- Keep API clients thin wrappers around `fetch`.
- Use `crypto.randomUUID()` for every history row id.
- Timestamps: SQLite format in the database, ISO-8601 on output. See 10.1.
- Chart.js is loaded from a public CDN (`chart.js@4/dist/chart.umd.min.js`); no build step.
- The application deploys with a single `wrangler deploy` once the D1 id and secrets are configured.
- Comments explain the research mapping and free-tier constraints, and every deviation from v1.0
  carries its justification inline.

### 17.1 Testing

57 tests across three files, all hermetic — no network, no database, no fixtures on disk.

- `signals.test.ts` — the scoring functions including boundary cases (`pBeat` exactly `0.30`,
  imbalance exactly `-0.30` / `-0.70`, the 60 and 100 caps), `topPercentileThreshold`,
  `normalizeTrade` for all four side/outcome combinations, `imbalanceFor` threshold behaviour, and
  ticker extraction.
- `render.test.ts` — ordering by *latest* strength, tier assignment, the empty state, HTML escaping,
  and `</script>` neutralisation in the embedded JSON.
- `alpaca.test.ts` — added in v2.1, with `fetch` stubbed and the response bodies copied from the
  live free-tier calls in Section 3.2. Covers the auth headers and IEX feed parameter, the
  three-level price precedence, rejection of zero and non-finite prices, the bars window and
  ordering, and every degradation path: no credentials (no request is made at all), the HTML 401,
  a transport exception, a 500, and the 404 short-circuit.

The degradation tests are the point of the file. Stock price is decorative, so an Alpaca fault must
never fail a run — but that property is invisible in normal operation and would rot silently.

Two tests are **regression guards for the v1.0 defects** and should not be deleted:

- `"makes heavy selling, not heavy buying, earn the conviction bonus"` pins the imbalance sign.
- `"would invert the signal if outcome were ignored"` asserts that normalized and naive readings of
  the same NO-side fills produce *opposite* signs.

### 17.2 Local development

```bash
npm install
npm run db:local                                        # apply schema.sql to local D1
npm run dev                                             # wrangler dev --test-scheduled, :8787
curl "http://localhost:8787/__scheduled?cron=0+*/12+*+*+*"   # fire a pass by hand
npm test
npm run typecheck
```

Inspect rows directly:

```bash
npx wrangler d1 execute pead-whale --local \
  --command "SELECT ticker, p_beat, imbalance, strength, recorded_at FROM signal_history ORDER BY strength DESC"
```

Note that `wrangler` writes logs outside the project directory, so a strict sandbox needs write
access beyond the workspace.

### 17.3 Deploying

```bash
npx wrangler d1 create pead-whale          # copy the printed id into wrangler.toml
npm run db:remote
npx wrangler secret put ALPACA_API_KEY     # optional
npx wrangler secret put ALPACA_SECRET_KEY  # optional
npx wrangler deploy
```

---

## 18. Corrections to v1.0

Everything in this section was discovered by running the real APIs and the v1.0 functions as
literally specified. Each is reflected in the code and, where behavioural, pinned by a test.

### 18.1 The imbalance sign was inverted

v1.0 specified:

```ts
return (sell - buy) / total; // negative = selling pressure
```

The expression is **positive** when selling dominates, which contradicts its own trailing comment
*and* its only consumer. `computeImbalanceStrength` awards its maximum to values `<= -0.70`.
Executing the v1.0 functions verbatim:

| Market | v1.0 `imbalance` | v1.0 conviction bonus |
| --- | --- | --- |
| All selling | `+1` | **0** |
| All buying | `-1` | **40** |

So the conviction multiplier fired on whale **accumulation** of "beat" inside a short-side
dashboard — precisely backwards. Corrected to `(buy - sell) / total`, the one-character change that
makes the function agree with its documented convention and with the research premise.

### 18.2 NO-token trades were counted backwards

`/trades` returns fills on both tokens; on one live market the mix was 21 BUY-Yes, 8 BUY-No,
7 SELL-Yes, 4 SELL-No. v1.0's `computeImbalance` inspects only `t.side` and ignores `outcome`, so
every BUY-No — a bearish act — was counted as buying pressure on the beat.

This compounds with 18.1, and it bites hardest exactly where the strategy operates: when `pBeat` is
low, NO is the cheap and busy side. Corrected by normalizing every fill onto the YES axis before
scoring (Section 5.1).

### 18.3 `volume >= 5000` matched nothing

Live on 2026-08-07, of 26 open earnings markets:

| | |
| --- | --- |
| Markets with `volume >= 5000` | **0** |
| Largest volume | $4,333 (SPCE) |
| Next | $2,012 (HD), $905 (RKLB) |

Corrected with the disjunctive gate in Section 4.1.

### 18.4 `notional >= 1000` matched nothing

On the busiest open market (HD, 40 trades in its entire history):

| | |
| --- | --- |
| Trades with notional `>= $1,000` | **0** |
| Largest trade | $303.67 |
| Median trade | $4.40 |

So the conviction multiplier was dead code. Addressed with the conjunctive adaptive threshold in
Section 5.2 — which still yields zero whale flow on today's board, but does so as a deliberate,
documented "no flow yet" rather than by accident.

### 18.5 `MIN_PUBLISH_SCORE = 50` as an insert gate emptied the database

Following from 18.4: with imbalance pinned at 0, `computeTotalScore` reduces to
`computePeadsStrength`, which reaches 50 only when `pBeat <= 0.05`. Combined with 18.3, the v1.0
rules produce a permanently empty page. Addressed by the two-tier model in Section 6.

### 18.6 `public-search` returns events, not markets

v1.0 read as though the endpoint returned a flat market list. It returns
`{ events, pagination }` with markets nested at `event.markets[]`, and it **includes closed
events**. Both handled in Section 4.

### 18.7 Gamma array fields are JSON-encoded strings

`clobTokenIds`, `outcomes`, and `outcomePrices` are strings. Indexing them without parsing yields
characters, not tokens — a failure that looks like a malformed token id rather than a type error.

### 18.8 The ticker regex matched template noise

`\b([A-Z]{1,5})\b` matches `EPS` and `GAAP`, which appear in nearly every earnings slug. Replaced
with the layered extractor in Section 4.2.

### 18.9 Alpaca returns HTML on 401

Not JSON. Clients must check status before parsing.

---

## 19. Observed baseline (2026-08-07)

Recorded so that future behaviour changes can be distinguished from market-condition changes.

**Discovery:** 50 events returned, 26 open earnings markets after filtering, 3 through the volume
gate (SPCE $4,333, HD $2,012, RKLB $905).

**Scoring:** 3 scored, 1 recorded.

| Ticker | `pBeat` | Imbalance | Strength | Stock price | Outcome |
| --- | --- | --- | --- | --- | --- |
| SPCE | 0.845 | — | 0 | not fetched | Skipped, failed primary filter |
| HD | 0.790 | — | 0 | not fetched | Skipped, failed primary filter |
| RKLB | 0.280 | 0.000 | 4 | $83.11 | Recorded, watchlist tier, price-only |

The RKLB row is the first observation in the table's history with a non-null price; the same run
earlier in the day scored it 0.290 / strength 2 with `current_stock_price = NULL`, because no
credentials were configured. The `pBeat` drift between the two runs is the market moving, not a
behaviour change.

Because earlier rows have null prices and the newest has one, RKLB's chart also exercises the mixed
case: Chart.js draws the price series with `spanGaps`, so the partial history renders as a line from
the first real reading rather than a broken series or a suppressed axis.

Six open markets had `pYes <= 0.30` (RKLB 0.295, RUM 0.19, GETY 0.30, PLBY 0.22, HIMS 0.295,
TBPH 0.285), but only RKLB also cleared the volume gate. Resolution dates clustered around
2026-08-10 through 2026-08-19, so the board should thicken through mid-August.

**Expect a sparse dashboard between earnings peaks.** That is the system working correctly, not a
bug. The empty state and watchlist tier exist for exactly this condition.

---

## 20. Known limitations and future work

Not defects — deliberate boundaries, recorded so they are not rediscovered.

- **Signal has never been validated.** No backtest, no out-of-sample check. The scores are a faithful
  encoding of a paper's stated conditions, nothing more.
- **`imbalance = 0` is ambiguous.** It means both "no whale flow" and "perfectly balanced whale
  flow". Distinguishing them would need a qualifying-trade count column.
- **`topPercentileThreshold` degenerates on small samples** to "the largest value". Harmless while
  the conjunction with `$1,000` holds, but it would matter if that floor were lowered.
- **Trades are capped at the 200 most recent** with no pagination, so imbalance on a very busy
  market reflects a recent window rather than full history.
- **Single-letter tickers are unreachable** (`A` and `I` are blocklisted). Needs an allowlist
  exception.
- **`MAX_MARKETS_PER_RUN = 12`** means a board with more than 12 qualifying markets silently drops
  the least liquid. Raising it requires the Workers paid plan.
- **Chart x-axis is a category scale, not a time scale,** so points are evenly spaced regardless of
  actual gaps. Avoids a Chart.js date-adapter dependency; revisit if cadence becomes irregular.
- **No pruning.** `signal_history` grows without bound; only reads are windowed. A cleanup pass
  should be added before this runs for long.
