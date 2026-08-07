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

### Publication tiers

`MIN_PUBLISH_SCORE` is 50, but it is used for *presentation*, not admission. With no whale flow to
add, `computePeadsStrength` only reaches 50 when `P(beat) <= 0.05`, so a price-only signal would
essentially never clear it and the page would sit empty. Instead:

- Any market passing the primary filter (score `>= 1`) gets a history row.
- Cards scoring `>= 50` render in the **conviction** tier.
- Cards below it render in a de-emphasised **watchlist** tier.

Once a market has been recorded, it is re-recorded on every later run even if its score collapses,
so a decaying or reversing signal stays visible on the chart instead of the line simply stopping.

---

## Thresholds, and why they are what they are

All of these live in [`src/lib/config.ts`](src/lib/config.ts).

| Constant | Value | Source spec | Why it differs |
| --- | --- | --- | --- |
| `MIN_PUBLISH_SCORE` | 50 | 50 | Same value, but it now selects a card tier rather than gating the insert. |
| `VOLUME_ABSOLUTE_FLOOR` | 5000 | 5000 (flat) | Kept, but now one half of an OR. |
| `VOLUME_TOP_PERCENTILE` | 0.10 | — | A market qualifies on the absolute floor **or** by being in the top 10% of the current board. Measured live, *zero* of 26 open earnings markets cleared a flat 5000 — the largest was $4,333 — because volume only concentrates in the last days before resolution. |
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

---

## Architecture

```
Cron (every 12h)
  -> Gamma  /public-search?q=earnings   discover open markets
  -> volume gate + ticker extraction + rank by volume, cap at 12
  -> CLOB   /midpoint                   P(beat)
  -> Data   /trades                     normalise to YES axis -> imbalance
  -> Alpaca /snapshot, /bars            stock price (optional)
  -> D1     signal_history              one append-only row per observation

HTTP
  GET /            server-rendered cards, chart data embedded in the document
  GET /feed.json   the same rolling window as JSON
  GET /style.css   served from public/ by Workers Static Assets
```

```
.
├── wrangler.toml
├── schema.sql
├── public/style.css
└── src/
    ├── index.ts              Hono routes + scheduled handler
    └── lib/
        ├── config.ts         every tunable
        ├── polymarket.ts     Gamma + CLOB + Data clients, ticker extraction
        ├── alpaca.ts         snapshot + bars, degrades to null, never throws
        ├── signals.ts        pure scoring math
        ├── pipeline.ts       the scheduled pass
        ├── db.ts             D1 helpers
        └── render.ts         server-rendered HTML
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
npm test        # 57 unit tests over the scoring math, rendering, and the Alpaca client
npm run typecheck
```

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

`imbalance` is in `[-1, 1]` and negative means net selling pressure against the beat.

---

## Licence and disclaimer

Provided as-is as a code sample. Nothing here is investment advice, and the signal has not been
validated out of sample. Polymarket and Alpaca are used through their public and free-tier
endpoints respectively; respect their terms of service.
