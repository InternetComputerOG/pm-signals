# Product Context Document: PM Stock Signal Dashboard

**Conditional PEAD Short + Whale Order-Flow Imbalance Signals**

| | |
| --- | --- |
| Version | 2.3 |
| Status | Deployed on Cloudflare Free (workers.dev), D1 + cron configured |
| Supersedes | v2.2 (cron-only refresh), v2.1 (volume-gated discovery), v2.0 (Alpaca unconfigured), v1.0 (pre-implementation draft) |
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
> free-tier behaviours that verification surfaced.
>
> **v2.2 removes the volume gate**, which turned out to be the reason the dashboard sat empty. It
> selected the top 10% of the board by liquidity *before* anything looked at price, and on earnings
> markets liquidity concentrates in the names the crowd expects to beat — the opposite of what a
> short-side thesis wants. Measured live, it admitted three markets priced 0.30, 0.79 and 0.85 and
> discarded all five that passed the primary filter, so the run recorded nothing. Selection now
> ranks on price ([Section 4.1](#41-candidate-selection)), and a third **radar** tier tracks markets
> approaching the filter so their drift is visible before they cross it
> ([Section 6](#6-publication--history-rules)). See [Section 18.10](#1810-the-volume-gate-selected-against-the-thesis)
> for the evidence and [Section 19](#19-observed-baseline-2026-08-07) for the refreshed baseline.
>
> **v2.3 adds `POST /refresh` and a Refresh button on the page**, because deploying v2.2 exposed a
> gap the design had: the table is written only by a cron that fires twice a day, so a deployment
> landing at 20:02 UTC showed an empty page until midnight with nothing wrong. See
> [Section 12](#post-refresh) for the endpoint and [Section 18.11](#1811-a-fresh-deployment-had-no-way-to-populate-itself)
> for what the incident also revealed about the empty state's wording.

---

## 1. Goal

Build a minimal, fully free, Cloudflare-native application that discovers Polymarket earnings
markets, computes the PEAD-short + large-trade imbalance signals, stores a rolling 10-day history
of scores, and publishes active signals to a single public landing page (one card per ticker,
sorted strongest to weakest, grouped into three tiers). The landing page includes an overlay graph
of prediction-market price, signal strength, and stock-price trendlines for the past 10 days.

The page is expected to carry cards at all times. Genuine signals are seasonal — they cluster in
the days before resolution dates — so between peaks the board is filled by the weaker tiers, which
track markets approaching the filter rather than showing nothing. A card that reads "36%, 6 points
above the filter, drifting down" is a real if weak observation; an empty page is not.

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
   - `endDate` = `market.endDate ?? event.endDate`, the resolution date
   - `fallbackPBeat` = the YES entry of `outcomePrices`
5. **Ticker extraction** — see Section 4.2.
6. **Selection** — see Section 4.1.

### 4.1 Candidate selection

`selectCandidates` in `pipeline.ts` decides which markets are worth spending subrequests on. It
ranks on `fallbackPBeat`, Gamma's own YES outcome price, which discovery has already parsed and
which therefore **costs nothing extra**. It is a slightly stale proxy for the CLOB midpoint fetched
later, but with a ceiling at 0.50 against a filter at 0.30 there is ample margin for the drift.

Three rules, in order:

1. **Rank by price ascending.** Markets already inside the history window get a
   `TRACKED_PRIORITY_BONUS` (0.05) discount so a series in progress keeps extending. Volume is the
   tiebreak, so at equal price the better book wins.
2. **Admit everything at or below `RADAR_PBEAT_CEILING` (0.50)**, plus anything already tracked
   regardless of price, so decays and reversals stay visible.
3. **Floor-fill.** If that yields fewer than `MIN_TRACKED_MARKETS` (6), backfill with the cheapest
   remaining markets *regardless of the ceiling*. This is what guarantees a populated dashboard
   when the entire board is priced high. Those cards render honestly in the radar tier — "P(beat)
   76%" is itself the information that nothing is near the thesis right now.

Then cap at `MAX_MARKETS_PER_RUN` (12) for the subrequest budget.

**The tracked discount is a tiebreak, not a veto.** A tracked market that has drifted to 0.90 still
loses its slot to a fresh candidate at 0.20, so the board cannot silt up with stale series over the
ten-day window.

> **This replaced a volume gate**, and that gate was the reason the dashboard sat empty. It cut the
> board to its top 10% by liquidity before anything looked at price. See
> [Section 18.10](#1810-the-volume-gate-selected-against-the-thesis).

Volume survives in two places only: as the ranking tiebreak above, and as a "thin book" marker on
the card, since with no gate in front of it a $10 market would otherwise look as credible as a
$900 one.

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

### 6.1 Recording

**Everything selected gets a row.** There is no score bar on insert. Selection (Section 4.1) is
already signal-aware, so if a market was worth two subrequests it is worth one row, and a score of
0 is itself the data — whether it means "not across the filter yet" or "was across it and decayed".

`MIN_RECORD_SCORE = 1` was retired in v2.2. It dropped every radar row, and it also dropped a
market sitting *exactly* on the filter, since `computePeadsStrength(0.30)` returns 0.

| Rule | Behaviour |
| --- | --- |
| Insert bar | None. Every selected market is recorded on every run. |
| Re-record rule | Tracked markets are re-selected via the ranking discount in Section 4.1, so decays and reversals stay visible instead of the series simply stopping. |
| Row identity | Every observation is a fresh insert with `crypto.randomUUID()`. The table is append-only; nothing is ever updated in place. |
| Active signals for the UI | Any ticker with at least one record in the past 10 days. |

### 6.2 The three card tiers

Tier is derived at render time from stored columns by `tierOf` in `render.ts`. There is no tier
column.

| Tier | Condition | Meaning |
| --- | --- | --- |
| **Conviction** | `strength >= MIN_PUBLISH_SCORE` (50) | Inside the filter with whale flow behind it. |
| **Watchlist** | `p_beat <= 0.30`, below 50 | Inside the filter, almost always price-only. |
| **Radar** | `p_beat > 0.30` | Not across the filter. Scores 0 by definition; tracked for drift. |

**`strength` alone cannot assign these.** A radar row scores 0, and so does a watchlist row sitting
exactly on the filter. `p_beat` is what separates "has not crossed yet" from "across it, just
weak", which is why the tier is derived from both.

`groupByTicker` reproduces that order with a single composite sort, no tier awareness needed:

```ts
.sort((a, b) => b.latest.strength - a.latest.strength || a.latest.p_beat - b.latest.p_beat)
```

Conviction rows outrank everything on strength. Radar rows always score 0 *and* always sit above
0.30, so on the strength tie they lose the `p_beat` comparison to any watchlist row, including a
decayed one at the boundary that scores 0 itself.

**Why `MIN_PUBLISH_SCORE` is a tier and not a gate.** With no whale flow to add,
`computePeadsStrength` only reaches 50 when `pBeat <= 0.05`. Combined with Section 5.2 — where most
markets legitimately have no whale flow — a strict `>= 50` insert gate would discard nearly every
real observation and leave the page empty. A price-only signal at `pBeat = 0.19` scores 22 and is
genuinely informative; it should be visible, just visibly weaker.

### 6.3 Why the radar tier exists

Radar rows score 0 and are outside the paper's thesis. They are stored anyway because the useful
early signal is the **drift**: a market falling 0.45 → 0.34 → 0.29 arrives at the filter with ten
days of history behind it instead of appearing from nowhere as a single point. Since every radar
row scores 0, drift is also the only thing that differentiates them on the page.

The cards therefore carry three pieces of context the score cannot express:

| Stat | Source | Why |
| --- | --- | --- |
| Drift | `latest.p_beat - oldest.p_beat`, in percentage points | Direction of travel relative to the filter. Falling is the interesting direction on a short-side dashboard, so it takes the highlight colour. |
| Resolves | `resolution_date` | A book at 40% the day before it settles is not the same as one at 40% three weeks out. |
| Book | `volume` | Volume no longer gates discovery, so the card has to carry it. |

---

## 7. Architecture

A single Cloudflare Worker containing one scheduled handler, two Hono HTTP routes, pure signal
functions, and thin API clients. All state lives in one D1 database.

```
Cron (every 12h)
  -> Gamma  /public-search?q=earnings   discover, flatten events, filter open
  -> D1     tracked market ids          read first; selection needs it
  -> select ticker extraction + rank by price, radar ceiling, floor-fill, cap at 12
  -> CLOB   /midpoint                   pBeat
  -> Data   /trades                     normalize to YES axis -> whale threshold -> imbalance
  -> score  computeTotalScore
  -> Alpaca /snapshot, /bars            stock price (optional)
  -> D1     signal_history              one append-only row per selected market

HTTP
  GET  /            server-rendered cards in three tiers, chart data embedded in the document
  GET  /feed.json   the same rolling window as JSON
  POST /refresh     runs the pass above on demand, subject to a cooldown
  GET  /style.css   served from public/ by Workers Static Assets
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
├── migrations/
│   └── 0001_radar_tier.sql        # resolution_date + volume, for deployed databases
├── public/
│   └── style.css
└── src/
    ├── index.ts                   # Hono routes + scheduled handler
    └── lib/
        ├── config.ts              # every tunable, with v1.0 values documented
        ├── polymarket.ts          # Gamma + CLOB + Data clients, ticker extraction
        ├── alpaca.ts              # snapshot + bars, degrades to null
        ├── signals.ts             # pure PEAD + imbalance + score
        ├── pipeline.ts            # selection + the scheduled pass
        ├── db.ts                  # D1 helpers
        ├── render.ts              # server-rendered HTML, tier derivation
        ├── signals.test.ts
        ├── pipeline.test.ts
        ├── render.test.ts
        ├── db.test.ts
        └── alpaca.test.ts
```

Three files are additions to v1.0's structure: `config.ts` (so no threshold is buried in a
function body), `pipeline.ts` (so `index.ts` stays a thin entry point), and `render.ts`.
`alpaca.test.ts` was added in v2.1, when the client stopped being hypothetical. `migrations/` and
`pipeline.test.ts` were added in v2.2 with the radar tier, and `db.test.ts` in v2.3 with the
refresh cooldown.

---

## 10. D1 Schema (Exact)

v1.0's table plus `IF NOT EXISTS` for idempotent re-application, and the two v2.2 columns.

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
  resolution_date TEXT,
  volume REAL,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_ticker_time ON signal_history(ticker, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_market_time ON signal_history(market_id, recorded_at DESC);
```

`resolution_date` and `volume` are **context, not inputs** — neither feeds the score. Both arrive
free with discovery, since Gamma's market payload already carries `endDate` and `volumeNum`.

Both are nullable, so rows written before the radar tier read back as `null` and the renderer shows
an em dash. It already had to handle that for `current_stock_price`.

**An existing database needs the migration**, because SQLite has no `ADD COLUMN IF NOT EXISTS` and
`schema.sql` must stay idempotent for fresh deploys:

```bash
npx wrangler d1 execute pead-whale --remote --file migrations/0001_radar_tier.sql
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

**Twice a day is the only automatic write path**, which means a deployment can land up to 12 hours
before the page has anything to show. `POST /refresh` (Section 12) exists to close that window; see
18.11 for the rollout that made the gap obvious.

In local development the timer does not fire. Trigger a pass by hand against
`wrangler dev --test-scheduled`:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*/12+*+*+*"
```

---

## 12. Public Endpoints

### `GET /`

Server-rendered HTML.

- One card per active ticker, sorted strongest → weakest by **latest** strength (not peak
  strength), with `p_beat` ascending as the tiebreak.
- Cards are grouped into three `<section>` blocks — conviction, watchlist, radar — each with a
  heading, a count, and a sentence explaining what the tier means. A section with no members is
  omitted entirely rather than rendered empty.
- Cards carry a `conviction`, `watchlist`, or `radar` class per Section 6.2.
- Each card shows ticker, strength, a per-card status line, six stats, an overlay chart, the
  observation count, the latest timestamp, and a Polymarket link.
- The status line is per-card rather than a repeat of the tier heading: "Cleared score 50",
  "Inside the filter · below score 50", or, for radar, "6.0 pts above the 30% filter".
- The six stats are `P(beat)` as a percentage, drift, whale flow ("−84% sell" / "+12% buy" /
  "no whale flow"), stock price, book size, and days to resolution. Anything null renders as an
  em dash.
- Each card contains an overlay line chart (Chart.js 4 via CDN) covering the past 10 days.
- **Chart data is embedded** as JSON in the document, so the page paints complete in one round
  trip. `/feed.json` exists for programmatic consumers, not for the page.
- Empty state renders only when *no earnings market is open anywhere*. Selection floor-fills, so a
  merely quiet board produces radar cards instead.
- Tiny external stylesheet at `/style.css`. No auto-refresh meta tag.

**The Refresh button** sits in the header, beside the disclaimer, and calls `POST /refresh`. It is
in the header rather than the card grid on purpose: the state where it matters most is the empty
one, and a control inside the grid would vanish exactly when it is needed. A test pins that it
renders on the empty state.

It is a real `<form method="post" action="/refresh">`, progressively enhanced. The script
intercepts the submit, posts with `accept: application/json`, and reports the outcome in an
`aria-live` region — "Recorded 7 of 26 open markets" on success, the wait on a 429, the status code
on anything else — then reloads. With scripting off, or if `window.fetch` is absent, the listener
is never attached and the plain form POST goes through; the route sees an HTML `Accept` header and
answers `303` back to `/`, so the button degrades to a full page round trip instead of breaking.

The script block is emitted **before** the Chart.js CDN tag and shares nothing with it, so an
unreachable CDN cannot take the control down with it. That ordering is pinned by a test.

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
    "id": "09ebbab7-ee7c-4a27-9ff1-62d8faa011b7",
    "market_id": "0xb59315e5ce78261432af1a9292dba1f50fc7b12a4178e4b90596b92695b4c197",
    "ticker": "BLSH",
    "p_beat": 0.31,
    "imbalance": 0,
    "strength": 0,
    "current_stock_price": 23.35,
    "pm_url": "https://polymarket.com/event/blsh-quarterly-earnings-gaap-eps-08-13-2026-1pt07",
    "resolution_date": "2026-08-13T13:00:00Z",
    "volume": 199.344113,
    "recorded_at": "2026-08-07T18:52:43Z"
  }
]
```

That row is a radar observation: `strength` is 0 because `p_beat` is above the 0.30 filter, not
because anything failed. Consumers distinguishing tiers should read `p_beat`, per Section 6.2.

### `POST /refresh`

Runs the scheduled pass on demand and returns its `RunSummary`, so a fresh deployment does not sit
empty until the next cron. Called by the page's Refresh button (Section 12, `GET /`) and usable
directly.

```bash
curl -X POST https://pm-signals.small-unit-9fb3.workers.dev/refresh
```

```json
{ "status": "ok", "discovered": 26, "selected": 7, "scored": 7, "recorded": 7, "skipped": 0 }
```

Within `REFRESH_COOLDOWN_MINUTES` of the most recent recorded observation it declines instead,
with a `Retry-After` header carrying the same figure:

```json
{ "status": "cooldown", "retry_after_seconds": 600, "last_recorded_at": "2026-08-07T20:25:44Z" }
```

Three decisions worth keeping:

- **POST, not GET.** The route has side effects, and a GET would eventually be fired by a
  prefetcher, uptime monitor or crawler — each firing a full pass. A GET to `/refresh` is a plain
  404.
- **No authentication.** This is a public showcase with no secret worth managing, and the real risk
  is cost rather than disclosure.
- **The cooldown is the safeguard.** A pass spends roughly 37 subrequests against a finite daily
  allowance, so an unbounded refresh is the one thing a visitor could use to break the free tier.
  The cron's own writes reset the timer too, which is correct: if data landed five minutes ago
  there is nothing to refresh.

Putting a button on the public page in v2.3 raised the expected call rate substantially, and
changed the exposure not at all: the cooldown caps the work at 6 passes an hour no matter how many
people click. That property is why the endpoint could be shipped without a key in the first place.

An HTML `Accept` header gets `303` to `/` instead of a JSON body, on both the success and cooldown
paths. That is the no-JS form fallback described in Section 12; a 303 rather than 302 so the reload
is a GET and the post cannot be resubmitted by a refresh.

`cooldownRemainingSeconds` **fails open** — an empty table or an unparseable timestamp both permit
the run. A fresh deployment has an empty table and is exactly the case the endpoint exists for, so
a null must never read as "just ran", and a malformed value must not be able to wedge the endpoint
shut permanently.

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
| `MIN_PUBLISH_SCORE` | `50` | `50` | Selects a card tier, not database admission |
| `PEAD_FILTER_CEILING` | `0.30` | — | The paper's primary filter, restated so `render.ts` can derive tiers. See 6.2 |
| `RADAR_PBEAT_CEILING` | `0.50` | — | Selection ceiling and the radar tier's outer edge. See 4.1 |
| `MIN_TRACKED_MARKETS` | `6` | — | Floor-fill target; what makes the board never empty. See 4.1 |
| `TRACKED_PRIORITY_BONUS` | `0.05` | — | Ranking discount for a series already in progress |
| `VOLUME_ABSOLUTE_FLOOR` | `5000` | `5000` | No longer a gate — now the "thin book" display threshold |
| `LARGE_TRADE_ABSOLUTE_FLOOR` | `1000` | `1000` | One half of a **conjunction** |
| `LARGE_TRADE_TOP_PERCENTILE` | `0.05` | — | The other half. See 5.2 |
| `TRADES_LIMIT` | `200` | `200` | Unchanged |
| `HISTORY_WINDOW_DAYS` | `10` | `10` | Unchanged |
| `REFRESH_COOLDOWN_MINUTES` | `10` | — | Rate limit on `POST /refresh`. See 12 |
| `GAMMA_SEARCH_LIMIT_PER_TYPE` | `50` | `50` | Unchanged |
| `MAX_MARKETS_PER_RUN` | `12` | — | Free-tier subrequest guard. See 13.1 |
| `SCORING_CONCURRENCY` | `4` | — | Bounded parallelism |
| `ALPACA_BARS_LIMIT` | `15` | `15` | Unchanged |
| `ALPACA_FEED` | `"iex"` | `"iex"` | Free tier is IEX-only; `"sip"` is a hard 403. See 3.2 |
| `SEARCH_QUERIES` | 3 phrasings | 3 phrasings | Unchanged |
| `TICKER_BLOCKLIST` | 52 tokens | — | See 4.2 |

**Removed in v2.2:** `VOLUME_TOP_PERCENTILE` (the relative half of the volume gate) and
`MIN_RECORD_SCORE` (the insert bar). See Sections 4.1 and 6.1.

### 13.1 Free-tier budget

**Workers Free allows 50 subrequests per invocation.** This is the binding constraint on the
scheduled pass, and v1.0 did not account for it.

```
1 discovery call
+ 12 markets x 2 (midpoint + trades)  = 24
+ up to 12 Alpaca calls                = 12
-------------------------------------------
  37 worst case, against a limit of 50
```

Widening selection in v2.2 did not change this arithmetic. The cap, not the gate, was always what
bounded the run — the volume gate happened to admit only three markets, but nothing guaranteed
that. The Alpaca line was "recorded only" in v2.1; every selected market is now recorded, so it is
simply every selected market.

The Alpaca line is "up to 12" rather than "up to 24" because `fetchCurrentPrice` costs a second
subrequest only when the snapshot comes back empty but valid. A 404 short-circuits (Section 5.3),
and in practice the snapshot answers on the first call.

`MAX_MARKETS_PER_RUN = 12` is derived from that arithmetic. Raising it risks mid-run failures.
D1 queries do not count against the subrequest limit.

Two cron invocations per day sit far inside the 100k requests/day allowance.

`POST /refresh` runs the same pass and so costs the same ~37 subrequests, but it is publicly
callable, which makes it the only path by which a visitor could consume the daily budget. That is
what `REFRESH_COOLDOWN_MINUTES` bounds: at worst 6 passes an hour, or 144 a day, against an
allowance measured in tens of thousands of requests.

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
  `run complete: discovered=26 selected=8 scored=8 recorded=8 skipped=0`

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
- [x] The page carries cards whenever any earnings market is open, not only during earnings peaks.
      Added in v2.2: through v2.1 the live board produced zero cards despite five markets passing
      the primary filter.

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

110 tests across five files, all hermetic — no network, no database, no fixtures on disk.

- `signals.test.ts` — the scoring functions including boundary cases (`pBeat` exactly `0.30`,
  imbalance exactly `-0.30` / `-0.70`, the 60 and 100 caps), `topPercentileThreshold`,
  `normalizeTrade` for all four side/outcome combinations, `imbalanceFor` threshold behaviour, and
  ticker extraction.
- `pipeline.test.ts` — added in v2.2. `selectCandidates` against the live 2026-08-07 board, plus
  the radar ceiling, floor-fill on an all-high-probability board, floor-fill on a board smaller
  than the floor, tracked-market continuity, the price tiebreak, null prices sorting last, and the
  cap.
- `render.test.ts` — tier derivation, ordering by *latest* strength with the `p_beat` tiebreak,
  section grouping, drift, resolution formatting, null-column degradation, the empty state, HTML
  escaping, `</script>` neutralisation in the embedded JSON, and the refresh control: that it
  renders on the empty state, that it is a real form, and that its script precedes the Chart.js
  tag.
- `db.test.ts` — added in v2.3. `toIso`, and every branch of `cooldownRemainingSeconds`: the empty
  table, mid-window and elapsed-window, a future timestamp from clock skew, an unparseable value,
  a zero-minute cooldown, and the shipped `REFRESH_COOLDOWN_MINUTES`. One test pins that SQLite's
  space-separated format is read as UTC — parsing it as local time would shift the cooldown by the
  host's offset and, west of UTC, make every fresh row look hours old.
- `alpaca.test.ts` — added in v2.1, with `fetch` stubbed and the response bodies copied from the
  live free-tier calls in Section 3.2. Covers the auth headers and IEX feed parameter, the
  three-level price precedence, rejection of zero and non-finite prices, the bars window and
  ordering, and every degradation path: no credentials (no request is made at all), the HTML 401,
  a transport exception, a 500, and the 404 short-circuit.

The degradation tests are the point of the Alpaca file. Stock price is decorative, so an Alpaca
fault must never fail a run — but that property is invisible in normal operation and would rot
silently.

`renderPage` takes `now` as a defaulted second parameter purely so the resolution-countdown tests
are not a function of when the suite runs.

Three tests are **regression guards for defects that shipped** and should not be deleted:

- `"makes heavy selling, not heavy buying, earn the conviction bonus"` pins the imbalance sign.
- `"would invert the signal if outcome were ignored"` asserts that normalized and naive readings of
  the same NO-side fills produce *opposite* signs.
- `"keeps the markets that pass the primary filter, which the volume gate discarded"` holds the
  full 26-market board of 2026-08-07 and asserts that RUM, PLBY, GETY, HIMS and TBPH survive
  selection while SPCE and HD do not. That board is kept whole rather than trimmed because its
  shape is the point: the three most liquid markets were priced 0.30, 0.79 and 0.85.

### 17.2 Local development

```bash
npm install
npm run db:local                                        # apply schema.sql to local D1
npm run dev                                             # wrangler dev --test-scheduled, :8787
curl "http://localhost:8787/__scheduled?cron=0+*/12+*+*+*"   # fire a pass by hand
npm test
npm run typecheck
```

A local database created before v2.2 lacks `resolution_date` and `volume`, and inserts will fail
against it. Either apply `migrations/0001_radar_tier.sql`, or delete `.wrangler/state/v3/d1` and
re-run `npm run db:local` — the table is a cache of a stateless discovery pass, so there is nothing
worth preserving locally.

Inspect rows directly:

```bash
npx wrangler d1 execute pead-whale --local \
  --command "SELECT ticker, p_beat, imbalance, strength, recorded_at FROM signal_history ORDER BY strength DESC"
```

Note that `wrangler` writes logs outside the project directory, so a strict sandbox needs write
access beyond the workspace.

### 17.3 Deploying

The needed environment variables are already configured in Cloudflare, as well as the database.

**v2.2 requires the migration to be applied before deploying**, or every insert will fail on the
two missing columns:

```bash
npx wrangler d1 execute pead-whale --remote --file migrations/0001_radar_tier.sql
npx wrangler deploy
curl -X POST https://pm-signals.small-unit-9fb3.workers.dev/refresh
```

The `curl` is what stops a deploy from showing an empty page until the next cron. It returns the
run summary, so it also doubles as a post-deploy smoke test — a non-zero `recorded` proves the
Worker reached Gamma, CLOB and D1 in production.

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

### 18.10 The volume gate selected against the thesis

This one is a correction to **v2.1**, not v1.0 — it was introduced by 18.3's fix rather than
inherited. It is the reason the dashboard was empty.

The gate ran before anything looked at price, so ranking by volume decided which markets got
scored at all. On the live board of 2026-08-07, 26 open markets, the top-10% relative floor
admitted exactly three:

| Ticker | Volume | `pYes` | Score |
| --- | --- | --- | --- |
| SPCE | $4,334 | 0.845 | 0 — nowhere near the filter |
| HD | $2,016 | 0.790 | 0 — nowhere near the filter |
| RKLB | $905 | 0.300 | 0 — exactly on the filter, where `computePeadsStrength` still returns 0 |

Meanwhile **five markets passed the primary filter and were discarded** for being illiquid:

| Ticker | Volume | `pYes` | Score it would have had |
| --- | --- | --- | --- |
| RUM | $583 | 0.185 | 23 |
| PLBY | $53 | 0.220 | 16 |
| GETY | $106 | 0.225 | 15 |
| HIMS | $53 | 0.295 | 1 |
| TBPH | $10 | 0.295 | 1 |

Zero rows recorded, from a board carrying five signals.

The error is one of ordering, and it is directional rather than merely conservative. Volume on
earnings markets concentrates in the names the crowd expects to beat, so **selecting on liquidity
selects against a short-side thesis**. Widening the gate would not have fixed it; the gate had to
stop being the first filter.

Section 4.1 of v2.1 asserted the relative floor "keeps the dashboard alive in the quiet part of the
cycle." It did the opposite. The claim was plausible and untested — the fix for 18.3 was verified
to admit *some* markets, never to admit the *right* ones.

Corrected by ranking on `fallbackPBeat`, which discovery already parses, so the fix costs no
additional subrequest. Pinned by the regression test in Section 17.1.

### 18.11 A fresh deployment had no way to populate itself

Found by deploying v2.2. The rollout landed at 20:02 UTC; the cron fires at 00:00 and 12:00 UTC, so
the last opportunity had passed eight hours earlier and the next was four hours away. The page
showed its empty state, and everything was working correctly.

Two separate defects, and the second is the more instructive one.

**The table is written only by the cron.** With a twice-daily trigger, any deploy can be followed
by up to 12 hours of an empty page. That is fine for a system nobody is watching and wrong for a
showcase, whose entire purpose is to be looked at. Fixed with `POST /refresh` (Section 12).

**The empty state asserted a cause it could not possibly know.** The v2.2 copy read:

> No earnings markets open — Polymarket is not currently listing any open earnings markets, so
> there is nothing to track at any tier.

`renderPage` receives `rows` and nothing else. It knows `rows.length === 0`. It cannot distinguish
"the cron has never run", "the cron ran and Polymarket returned nothing", or "the cron ran, found
markets, and every insert failed" — yet it named the second as fact. Polymarket was in fact serving
26 open earnings markets at that moment, 7 of them under the radar ceiling.

The cost was not the blank page, which was momentary and correct. It was that the page sent its
reader to debug a healthy API. **A message that guesses at a cause is worse than one that admits
it does not know**, because a plausible wrong explanation is acted on and a missing one is
investigated.

The v2.2 empty-state wording is still in place — with the refresh endpoint the state is now rare —
but it is a known defect, recorded in Section 20 rather than in the corrections, because it has not
been corrected.

The deeper gap is structural: **the app records observations but no record of runs**. A `run_log`
table holding one row per pass (timestamp, discovered, selected, recorded) would let the page state
facts instead of inferring them — "last scanned 3h ago, 26 markets seen, 8 tracked" — and would
have made this diagnosis immediate. It was considered during the v2.2 design and dropped as
over-engineering. This incident is the argument against that call.

---

## 19. Observed baseline (2026-08-07)

Recorded so that future behaviour changes can be distinguished from market-condition changes.

`run complete: discovered=26 selected=8 scored=8 recorded=8 skipped=0`

**Discovery:** 50 events returned, 26 open earnings markets after filtering, 8 selected — every
market at or below `RADAR_PBEAT_CEILING`. The floor-fill did not engage, since 8 exceeds
`MIN_TRACKED_MARKETS`.

| Ticker | `pBeat` | Imbalance | Strength | Stock price | Book | Tier |
| --- | --- | --- | --- | --- | --- | --- |
| RUM | 0.185 | 0.000 | 23 | $6.26 | $583 | Watchlist |
| PLBY | 0.225 | 0.000 | 15 | $1.20 | $53 | Watchlist |
| RKLB | 0.285 | 0.000 | 3 | $80.86 | $905 | Watchlist |
| HIMS | 0.295 | 0.000 | 1 | $31.34 | $53 | Watchlist |
| BLSH | 0.310 | 0.000 | 0 | $23.35 | $199 | Radar |
| STUB | 0.350 | 0.000 | 0 | $9.09 | $50 | Radar |
| QUBT | 0.355 | 0.000 | 0 | $8.99 | $92 | Radar |
| WB | 0.360 | 0.000 | 0 | $7.92 | $380 | Radar |

**The same board produced zero cards under v2.1.** Compare the v2.1 baseline above it: three
markets gated in, one recorded, and on the run measured for 18.10, none. Every ticker here also
carries a non-null Alpaca price, so all eight charts draw all three series.

Every imbalance is exactly 0.000, as Section 5.2 predicts — these books have no $1,000 prints — so
the whole board is a price-only signal. That is the expected state away from resolution dates.

**Board volatility is high enough to matter when reproducing this.** A fetch 80 minutes earlier had
GETY (0.225), TBPH (0.295) and PXLW (0.415) on the board and no LZB, TGT or DE; RKLB had moved
0.300 → 0.285 over the same span. Expect the ticker list to differ on any re-run; the funnel counts
are the stable part.

Resolution dates cluster from 2026-08-10 to 2026-08-20, so several of these watchlist names resolve
within three days and the board will turn over quickly.

**A sparse *conviction* tier between earnings peaks is correct.** What was not correct was a sparse
*page*: the radar tier and the floor-fill exist so that the quiet part of the cycle produces weak,
honestly-labelled observations instead of nothing at all.

---

## 20. Known limitations and future work

Not defects — deliberate boundaries, recorded so they are not rediscovered.

- **Signal has never been validated.** No backtest, no out-of-sample check. The scores are a faithful
  encoding of a paper's stated conditions, nothing more.
- **The empty state still names a cause it cannot know**, claiming Polymarket lists no open
  earnings markets whenever the table is empty for any reason. See 18.11. Left as-is because
  `POST /refresh` makes the state rare, but it is a defect, not a decision.
- **No record of runs, only of observations.** Nothing distinguishes "the pass has never run" from
  "it ran and found nothing", for either the page or an operator. A `run_log` table would fix both
  this and the item above, and is the natural next change.
- **`RADAR_PBEAT_CEILING = 0.50` and `MIN_TRACKED_MARKETS = 6` are editorial, not empirical.** The
  paper says nothing about markets above 0.30, so the radar tier's width is a judgement about what
  is worth watching, chosen to keep the board populated on the boards observed so far. It is not a
  claim that 0.49 is meaningfully different from 0.51.
- **Selection ranks on a slightly stale price.** `fallbackPBeat` is Gamma's last outcome price, not
  the CLOB midpoint the score later uses. The 0.20 margin between the ceiling and the filter covers
  the observed gap, but a market that moves hard between discovery and scoring could be missed for
  one run. Closing this would cost a subrequest per candidate, which the budget cannot afford.
- **`imbalance = 0` is ambiguous.** It means both "no whale flow" and "perfectly balanced whale
  flow". Distinguishing them would need a qualifying-trade count column.
- **`strength = 0` is ambiguous in isolation**, meaning either "never crossed the filter" or
  "crossed and decayed". `p_beat` resolves it for the renderer, but a `/feed.json` consumer has to
  know to check.
- **Drift is measured against the oldest row in the window**, so it silently rescales as rows age
  out of the ten days. A market flat for a fortnight and one that fell and recovered can read the
  same.
- **`topPercentileThreshold` degenerates on small samples** to "the largest value". Harmless while
  the conjunction with `$1,000` holds, but it would matter if that floor were lowered.
- **Trades are capped at the 200 most recent** with no pagination, so imbalance on a very busy
  market reflects a recent window rather than full history.
- **Single-letter tickers are unreachable** (`A` and `I` are blocklisted). Needs an allowlist
  exception.
- **`MAX_MARKETS_PER_RUN = 12`** means a board with more than 12 qualifying markets silently drops
  the most expensive. This binds far more often since v2.2 — 8 of 26 markets qualified on the
  baseline board, and a busy earnings week will exceed 12. Raising it requires the Workers paid
  plan.
- **Chart x-axis is a category scale, not a time scale,** so points are evenly spaced regardless of
  actual gaps. Avoids a Chart.js date-adapter dependency; revisit if cadence becomes irregular.
- **No pruning.** `signal_history` grows without bound; only reads are windowed. v2.2 made this
  materially worse: v2.1 recorded roughly one row per run, v2.2 records up to twelve. A cleanup
  pass is now the most pressing item on this list.
