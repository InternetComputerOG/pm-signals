/**
 * The scheduled pass: discover -> gate -> score -> record.
 *
 * Every run is stateless with respect to discovery; the only thing read back
 * out of D1 is the set of markets already being tracked, so that their series
 * keep extending even after they weaken.
 *
 * Failure policy (spec section 14): any upstream error is logged and that one
 * market is skipped. No retries, no circuit breakers, no alerting.
 */

import { fetchCurrentPrice, hasAlpacaCredentials, type AlpacaEnv } from "./alpaca";
import {
  HISTORY_WINDOW_DAYS,
  LARGE_TRADE_ABSOLUTE_FLOOR,
  LARGE_TRADE_TOP_PERCENTILE,
  MAX_MARKETS_PER_RUN,
  MIN_TRACKED_MARKETS,
  RADAR_PBEAT_CEILING,
  SCORING_CONCURRENCY,
  TRACKED_PRIORITY_BONUS,
} from "./config";
import { getRecentlySeenMarketIds, insertObservation } from "./db";
import {
  discoverEarningsMarkets,
  fetchNormalizedTrades,
  fetchPBeat,
  type Candidate,
} from "./polymarket";
import {
  computeImbalanceAbove,
  computeTotalScore,
  topPercentileThreshold,
  type NormalizedTrade,
} from "./signals";

export interface Env extends AlpacaEnv {
  DB: D1Database;
}

export interface RunSummary {
  discovered: number;
  selected: number;
  scored: number;
  recorded: number;
  skipped: number;
}

/**
 * Choose which markets are worth spending the subrequest budget on.
 *
 * Ranks on Gamma's own YES outcome price, which discovery has already parsed
 * into fallbackPBeat and which therefore costs nothing extra. It is a slightly
 * stale proxy for the CLOB midpoint fetched later, but with a ceiling at 0.50
 * against a filter at 0.30 there is ample margin for the drift between them.
 *
 * This replaces a volume gate that ran before any signal consideration and cut
 * the board to its top 10% by liquidity. That ordering was backwards: volume
 * on earnings markets concentrates in the names the crowd expects to beat,
 * which is the opposite of what a short-side thesis wants. On the live board
 * of 2026-08-07 it admitted three markets priced 0.30, 0.79 and 0.85, and
 * discarded all five that passed the primary filter, so nothing was recorded.
 *
 * Volume survives only as a tiebreak, and as a "thin book" label on the card.
 *
 * Three rules, in order:
 *   1. Rank by price ascending, tracked markets discounted so a series in
 *      progress keeps extending.
 *   2. Admit everything at or below RADAR_PBEAT_CEILING, plus anything already
 *      tracked, so decays and reversals stay visible.
 *   3. If that yields fewer than MIN_TRACKED_MARKETS, backfill with the
 *      cheapest remaining markets regardless of the ceiling. This is what
 *      guarantees a populated dashboard when the whole board is priced high.
 */
export function selectCandidates(
  candidates: Candidate[],
  tracked: ReadonlySet<string>,
): Candidate[] {
  // A missing price sorts last rather than first: unknown is not cheap.
  const rank = (c: Candidate) =>
    (c.fallbackPBeat ?? 1) - (tracked.has(c.marketId) ? TRACKED_PRIORITY_BONUS : 0);

  const ordered = [...candidates].sort((a, b) => rank(a) - rank(b) || b.volume - a.volume);

  const eligible = ordered.filter(
    (c) => (c.fallbackPBeat ?? 1) <= RADAR_PBEAT_CEILING || tracked.has(c.marketId),
  );

  const filled =
    eligible.length >= MIN_TRACKED_MARKETS ? eligible : ordered.slice(0, MIN_TRACKED_MARKETS);

  return filled.slice(0, MAX_MARKETS_PER_RUN);
}

/**
 * Net YES-side imbalance over this market's whale flow.
 *
 * A fill counts only if it clears the absolute floor AND sits in the top slice
 * of this market's own fills, so the bar is the higher of the two. Requiring
 * both is what stops a quiet market's largest $12 print from being promoted to
 * "whale" status simply because it is the biggest thing there.
 *
 * Returns 0 when nothing qualifies. That is not a failure - it means there is
 * no large-trade flow to read yet, and the ticker degrades to a price-only
 * signal. Liquidity concentrates sharply in the days before resolution, so
 * thin markets fill in on later runs.
 */
export function imbalanceFor(trades: NormalizedTrade[]): number {
  if (trades.length === 0) return 0;

  const notionals = trades.map((t) => t.size * t.price);
  const relativeFloor = topPercentileThreshold(notionals, LARGE_TRADE_TOP_PERCENTILE);
  const threshold = Math.max(LARGE_TRADE_ABSOLUTE_FLOOR, relativeFloor);

  return computeImbalanceAbove(trades, threshold);
}

/** Runs `worker` over `items` with bounded concurrency. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export async function runDiscoveryPass(env: Env): Promise<RunSummary> {
  const summary: RunSummary = { discovered: 0, selected: 0, scored: 0, recorded: 0, skipped: 0 };

  if (!hasAlpacaCredentials(env)) {
    console.warn("alpaca: no credentials configured, stock prices will be recorded as null");
  }

  const discovered = await discoverEarningsMarkets();
  summary.discovered = discovered.length;
  if (discovered.length === 0) {
    console.warn("run: no candidates discovered, nothing to do");
    return summary;
  }

  // Read the tracked set first: selection needs it to keep series in progress
  // from being crowded out by fresh candidates.
  const alreadyTracked = await getRecentlySeenMarketIds(env.DB, HISTORY_WINDOW_DAYS);

  const selected = selectCandidates(discovered, alreadyTracked);
  summary.selected = selected.length;

  await mapWithConcurrency(selected, SCORING_CONCURRENCY, async (candidate) => {
    try {
      let pBeat = await fetchPBeat(candidate.yesTokenId);
      if (pBeat === null) pBeat = candidate.fallbackPBeat;
      if (pBeat === null) {
        console.error(`skip ${candidate.ticker}: no midpoint or fallback price available`);
        summary.skipped++;
        return;
      }

      const trades = await fetchNormalizedTrades(candidate.marketId, candidate.yesTokenId);
      const imbalance = imbalanceFor(trades);
      const strength = computeTotalScore(pBeat, imbalance);
      summary.scored++;

      // Everything selected gets a row. Selection is now signal-aware, so if a
      // market was worth two subrequests it is worth one row - and a score of
      // 0 is itself the data, whether it means "not across the filter yet" or
      // "was across it and decayed". There is no separate record bar; a score
      // gate here would drop the p_beat == 0.30 boundary and every radar row.
      const price = await fetchCurrentPrice(candidate.ticker, env, HISTORY_WINDOW_DAYS);

      await insertObservation(env.DB, {
        market_id: candidate.marketId,
        ticker: candidate.ticker,
        p_beat: pBeat,
        imbalance,
        strength,
        current_stock_price: price,
        pm_url: candidate.pmUrl,
        resolution_date: candidate.endDate,
        volume: candidate.volume,
      });
      summary.recorded++;

      console.log(
        `record ${candidate.ticker}: pBeat=${pBeat.toFixed(3)} ` +
          `imbalance=${imbalance.toFixed(3)} strength=${strength} ` +
          `price=${price ?? "n/a"} trades=${trades.length}`,
      );
    } catch (err) {
      summary.skipped++;
      console.error(`skip ${candidate.ticker} (${candidate.marketId})`, err);
    }
  });

  console.log(
    `run complete: discovered=${summary.discovered} selected=${summary.selected} ` +
      `scored=${summary.scored} recorded=${summary.recorded} skipped=${summary.skipped}`,
  );
  return summary;
}
