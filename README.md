# PEAD Whale Signals

A single Cloudflare Worker that discovers open Polymarket earnings markets, scores them for a
conditional post-earnings-announcement-drift (PEAD) short setup, and publishes the results to a
public page with a 10-day overlay chart per ticker.

**This is a showcase, not a trading system.** It produces no advice, executes nothing, and has
never been backtested. It exists to demonstrate a small, well-documented, free-tier-native
Cloudflare application. Do not put money behind it.

> The full specification lives in
> [`product-context-document.md`](product-context-document.md) and is the authoritative reference
> for continued development: verified API response shapes, every threshold and its justification,
> the corrections made to the original draft, and known limitations. This README is the short
> version.

---

## The signal

Based on Chloe Feng (2026), *"Minority Report: Contrarian Traders, Prediction Markets, and the
Return of Post-Earnings Drift"* (SSRN `abstract_id=6477080` / `6578598`).

The paper's finding, reduced to two conditions:

1. **Primary filter.** When a prediction market assigns a low probability to a company beating
   earnings, that low crowd probability on its own predicts significant 10-day post-announcement
   returns. Here that is `P(beat) <= 0.30`, read from the Polymarket YES mid-price.
2. **Conviction multiplier.** Strong directional order flow from *large* traders, especially net
   selling pressure, further raises realised beat certainty.

The relationship between them is a gate, not a sum. If `P(beat) > 0.30` the score is zero no
matter how lopsided the order flow is:

```ts
function computeTotalScore(pBeat: number, imbalance: number): number {
  const pead = computePeadsStrength(pBeat);
  if (pead === 0) return 0; // primary filter
  return Math.min(100, pead + computeImbalanceStrength(imbalance));
}
```

`computePeadsStrength` contributes 0-60, rising linearly as `P(beat)` falls below 0.30.
`computeImbalanceStrength` adds 0, 25, or 40 depending on how one-sided the whale flow is. All of
it lives in [`src/lib/signals.ts`](src/lib/signals.ts) as pure functions with no I/O.

### Two things the source spec got wrong

Both were found by running the real APIs, and both are corrected here.

**1. The imbalance sign was inverted.** The specified body returned `(sell - buy) / total`, which
is *positive* when selling dominates. That contradicts its own trailing comment
(`// negative = selling pressure`) and its only consumer, `computeImbalanceStrength`, which awards
its maximum to values `<= -0.70`. Implemented literally, an all-selling market earned a conviction
bonus of 0 and an all-buying market earned the full 40 — the multiplier fired on whale
*accumulation* of "beat" inside a short-side dashboard. The code uses `(buy - sell) / total`, which
is the one-character fix that makes the function agree with its documented convention. There is a
regression test pinning this.

**2. Trades on the NO token were being counted backwards.** Polymarket's `/trades` endpoint returns
fills on *both* tokens of a binary market; on a live market the mix was 21 BUY-Yes, 8 BUY-No,
7 SELL-Yes, 4 SELL-No. Buying NO at $0.22 is the same economic act as selling YES at $0.78, so
every fill is folded onto the YES axis in `normalizeTrade` before it reaches the scoring functions.
Skipping this inverts the conviction signal precisely in the markets that matter most — the ones
where `P(beat)` is already low and NO is therefore the busy side.

### Three publication tiers

`MIN_PUBLISH_SCORE` is 50, but it is used for *presentation*, not admission. With no whale flow to
add, `computePeadsStrength` only reaches 50 when `P(beat) <= 0.05`, so a price-only signal would
essentially never clear it and the page would sit empty. Every market the run scores gets a history
row, and the tier is derived at render time:

| Tier | Condition | Meaning |
| --- | --- | --- |
| **Conviction** | score `>= 50` | Inside the filter with whale flow behind it. |
| **Watchlist** | `P(beat) <= 0.30`, score below 50 | Inside the filter, almost always price-only. |
| **Radar** | `P(beat) > 0.30` | Not across the filter. Scores 0 by definition; tracked for drift. |

The radar tier exists because genuine signals are seasonal — they cluster in the days before
resolution dates — and a page that shows nothing for weeks at a time is less useful than one
showing weak, honestly-labelled observations. A market drifting 0.45 → 0.34 → 0.29 arrives at the
filter with ten days of history behind it instead of appearing from nowhere as a single point.
Since every radar card scores 0, that drift is also the only thing distinguishing them, so each
card carries it alongside the book size and days to resolution.

Selection guarantees a minimum number of tracked markets, so the page is populated whenever any
earnings market is open at all. Tracked markets also get a small ranking preference, so a decaying
or reversing signal stays visible on the chart instead of the line simply stopping.

Note that `strength = 0` therefore means either "never crossed the filter" or "crossed and
decayed". Read `p_beat` to tell them apart.

---

## Thresholds, and why they are what they are

All of these live in [`src/lib/config.ts`](src/lib/config.ts).

| Constant | Value | Source spec | Why it differs |
| --- | --- | --- | --- |
| `MIN_PUBLISH_SCORE` | 50 | 50 | Same value, but it now selects a card tier rather than gating the insert. |
| `PEAD_FILTER_CEILING` | 0.30 | 0.30 | The paper's primary filter, restated as a constant so the renderer can derive tiers. |
| `RADAR_PBEAT_CEILING` | 0.50 | — | Markets up to here are tracked for drift. Editorial, not empirical — the paper says nothing above 0.30. |
| `MIN_TRACKED_MARKETS` | 6 | — | If fewer than six markets clear the ceiling, the cheapest remaining are tracked anyway. This is what keeps the page populated. |
| `VOLUME_ABSOLUTE_FLOOR` | 5000 | 5000 (flat) | No longer gates anything. Now the threshold below which a card's book is marked thin. |
| `LARGE_TRADE_ABSOLUTE_FLOOR` | 1000 | 1000 (flat) | Kept. |
| `LARGE_TRADE_TOP_PERCENTILE` | 0.05 | — | A fill counts as a whale print only if it clears $1,000 **and** sits in the top 5% of that market's fills. Note this is a conjunction, so it is *stricter* than the spec, not looser. |
| `TRADES_LIMIT` | 200 | 200 | Unchanged. |
| `HISTORY_WINDOW_DAYS` | 10 | 10 | Unchanged. |
| `MAX_MARKETS_PER_RUN` | 12 | — | Free-plan Workers allow 50 subrequests per invocation; 12 markets keeps a worst-case run near 37. |

The conjunction on large trades has a deliberate and visible consequence: away from resolution
dates almost no earnings market has $1,000 prints — on the busiest open market the largest fill was
$304 and the median was $4.40 — so most tickers report an imbalance of exactly zero and degrade to
a price-only signal in the watchlist tier. That is the honest outcome. Manufacturing conviction out
of $5 trades would be worse than reporting none. Liquidity rises sharply as resolution approaches,
and the conviction tier fills in with it.

### The volume gate, and why it is gone

Earlier versions gated discovery on volume: a market qualified on a flat $5,000 floor **or** by
being in the top 10% of the current board. It sounded reasonable and it emptied the dashboard.

Because the gate ran before anything looked at price, ranking by volume decided which markets got
scored at all. On the live board of 2026-08-07 — 26 open markets — it admitted exactly three: SPCE
at `P(beat)` 0.85, HD at 0.79, and RKLB at 0.30 exactly, where `computePeadsStrength` still returns
0. Five markets passed the primary filter and were all discarded for being illiquid: RUM at 0.185
(would have scored 23), PLBY at 0.22 (16), GETY at 0.225 (15), HIMS and TBPH at 0.295 (1 each).
The run recorded nothing, from a board carrying five signals.

The error is directional, not merely conservative. Volume on earnings markets concentrates in the
names the crowd expects to beat, so **selecting on liquidity selects against a short-side thesis**.
Widening the gate would not have fixed it; the gate had to stop being the first filter.

Selection now ranks on Gamma's own YES outcome price, which discovery already parses, so the fix
costs no extra subrequest. Volume survives as the tiebreak and as a display marker. A regression
test holds that entire 26-market board and asserts the five survive while SPCE and HD do not.

---

## Architecture

```
Cron (every 12h)
  -> Gamma  /public-search?q=earnings   discover open markets
  -> D1     tracked market ids          read first; selection needs it
  -> select ticker extraction + rank by price, radar ceiling, floor, cap at 12
  -> CLOB   /midpoint                   P(beat)
  -> Data   /trades                     normalise to YES axis -> imbalance
  -> Alpaca /snapshot, /bars            stock price (optional)
  -> D1     signal_history              one append-only row per selected market

HTTP
  GET /            server-rendered cards in three tiers, chart data embedded
  GET /feed.json   the same rolling window as JSON
  GET /style.css   served from public/ by Workers Static Assets
```

```
.
├── wrangler.toml
├── schema.sql
├── migrations/0001_radar_tier.sql
├── public/style.css
└── src/
    ├── index.ts              Hono routes + scheduled handler
    └── lib/
        ├── config.ts         every tunable
        ├── polymarket.ts     Gamma + CLOB + Data clients, ticker extraction
        ├── alpaca.ts         snapshot + bars, degrades to null, never throws
        ├── signals.ts        pure scoring math
        ├── pipeline.ts       selection + the scheduled pass
        ├── db.ts             D1 helpers
        └── render.ts         server-rendered HTML, tier derivation
```

Discovery is completely stateless — every run rebuilds the candidate list from scratch. The only
thing read back out of D1 is the set of markets already being tracked.

Per spec, any upstream failure is logged with `console.error` and that one market is skipped; the
rest of the run continues. There are no retries, circuit breakers, or alerting.

### Notes on two details that are easy to get wrong

**Polymarket's JSON-encoded strings.** `clobTokenIds`, `outcomes`, and `outcomePrices` come back
from Gamma as JSON-encoded *strings*, not arrays, and `/public-search` returns events with markets
nested inside them rather than a flat list. Both are handled in `polymarket.ts`.

**Timestamps.** `recorded_at` is left to the column's `DEFAULT (datetime('now'))` rather than
written from the Worker, which keeps every row in SQLite's `YYYY-MM-DD HH:MM:SS` UTC format. That
is what makes the `>= datetime('now', '-10 days')` window comparisons correct — writing ISO-8601
with a `T` and a `Z` would break them lexicographically. Conversion to ISO-8601 happens on the way
out, in `toIso`.

---

## Running it locally

```bash
npm install
npm run db:local      # apply schema.sql to the local D1
npm run dev           # wrangler dev --test-scheduled, on :8787
```

The cron handler does not fire on a timer in dev. Trigger a pass by hand:

```bash
curl "http://localhost:8787/__scheduled?cron=0+*/12+*+*+*"
```

Then open <http://localhost:8787>, or inspect the rows directly:

```bash
npx wrangler d1 execute pead-whale --local \
  --command "SELECT ticker, p_beat, imbalance, strength, recorded_at FROM signal_history ORDER BY strength DESC"
```

```bash
npm test        # 92 unit tests over scoring, selection, rendering, and the Alpaca client
npm run typecheck
```

A local database created before the radar tier lacks the `resolution_date` and `volume` columns,
and inserts will fail against it. Delete `.wrangler/state/v3/d1` and re-run `npm run db:local`;
the local table is only ever a cache of a stateless discovery pass.

---

## Deploying

```bash
npx wrangler d1 create pead-whale          # copy the printed id into wrangler.toml
npm run db:remote                          # apply the schema to the real database
npx wrangler secret put ALPACA_API_KEY     # optional, see below
npx wrangler secret put ALPACA_SECRET_KEY  # optional
npx wrangler deploy
```

Everything after the database id is in place is a single `wrangler deploy`.

**A database created before the radar tier needs the migration first**, or every insert will fail
on the two missing columns. SQLite has no `ADD COLUMN IF NOT EXISTS`, so this is kept out of
`schema.sql`, which stays idempotent for fresh deploys:

```bash
npx wrangler d1 execute pead-whale --remote --file migrations/0001_radar_tier.sql
```

### Secrets

| Secret | Required | Purpose |
| --- | --- | --- |
| `ALPACA_API_KEY` | No | Alpaca Market Data, free tier (IEX feed) |
| `ALPACA_SECRET_KEY` | No | Same |

Both are optional. Stock price is the third trendline on the chart, never an input to the score, so
without keys the app runs normally: `current_stock_price` is recorded as `NULL`, cards show a dash,
and the price series and its axis are omitted from that ticker's chart. Copy `.dev.vars.example` to
`.dev.vars` to supply them locally. Free keys come with an Alpaca paper-trading account.

A paper-trading account issues one key pair that works against both
`https://paper-api.alpaca.markets` (trading) and `https://data.alpaca.markets` (market data). This
project only calls the latter, and only to read prices — it places no orders and has no code path
that could. Three things about the free tier are worth knowing, all verified against the live API:

- The plan is **IEX-only**. Requesting `feed=sip` returns `403 subscription does not permit
  querying recent SIP data`.
- An unknown or non-US-listed symbol returns a **JSON 404**, which the client treats as "no price"
  and logs as a warning rather than an error. It also skips the daily-bars fallback in that case,
  since a symbol the feed cannot resolve has no bars either.
- Missing or bad credentials return a **401 with an nginx HTML body**, not JSON, so the client
  always checks the status before parsing.

None of these can fail a run. Every function in `alpaca.ts` returns `null` or `[]` instead of
throwing.

### Free-tier posture

Workers, D1, and Static Assets only — no KV, R2, Durable Objects, queues, or external cron. Two
cron invocations a day against a 100k/day request allowance, and a worst case around 37 subrequests
per run against a 50 limit. There is no LLM inference anywhere in the system.

---

## `GET /feed.json`

The same rolling 10-day window the page uses, oldest first.

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

`imbalance` is in `[-1, 1]` and negative means net selling pressure against the beat.

That row is a radar observation: `strength` is 0 because `p_beat` is above the 0.30 filter, not
because anything failed. `resolution_date` and `volume` are null on rows written before those
columns existed.

---

## Licence and disclaimer

Provided as-is as a code sample. Nothing here is investment advice, and the signal has not been
validated out of sample. Polymarket and Alpaca are used through their public and free-tier
endpoints respectively; respect their terms of service.
