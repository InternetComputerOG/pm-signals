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
  MIN_RECORD_SCORE,
  SCORING_CONCURRENCY,
  VOLUME_ABSOLUTE_FLOOR,
  VOLUME_TOP_PERCENTILE,
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
  gated: number;
  scored: number;
  recorded: number;
  skipped: number;
}

/**
 * Volume gate: absolute floor OR the top slice of today's board.
 *
 * Splitting these is what keeps the dashboard populated between earnings
 * seasons, when no open market anywhere is near the absolute floor.
 */
export function applyVolumeGate(candidates: Candidate[]): Candidate[] {
  const relativeFloor = topPercentileThreshold(
    candidates.map((c) => c.volume),
    VOLUME_TOP_PERCENTILE,
  );
  return candidates.filter(
    (c) => c.volume >= VOLUME_ABSOLUTE_FLOOR || c.volume >= relativeFloor,
  );
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
  const summary: RunSummary = { discovered: 0, gated: 0, scored: 0, recorded: 0, skipped: 0 };

  if (!hasAlpacaCredentials(env)) {
    console.warn("alpaca: no credentials configured, stock prices will be recorded as null");
  }

  const discovered = await discoverEarningsMarkets();
  summary.discovered = discovered.length;
  if (discovered.length === 0) {
    console.warn("run: no candidates discovered, nothing to do");
    return summary;
  }

  // Rank by volume before capping, so the subrequest budget is spent on the
  // markets most likely to carry a real signal.
  const gated = applyVolumeGate(discovered)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, MAX_MARKETS_PER_RUN);
  summary.gated = gated.length;

  const alreadyTracked = await getRecentlySeenMarketIds(env.DB, HISTORY_WINDOW_DAYS);

  await mapWithConcurrency(gated, SCORING_CONCURRENCY, async (candidate) => {
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

      // Record if the market is newly interesting, or if we are already
      // tracking it - the latter keeps decays and reversals on the chart.
      const isTracked = alreadyTracked.has(candidate.marketId);
      if (strength < MIN_RECORD_SCORE && !isTracked) {
        console.log(
          `skip ${candidate.ticker}: strength ${strength} below record bar and not tracked`,
        );
        return;
      }

      const price = await fetchCurrentPrice(candidate.ticker, env, HISTORY_WINDOW_DAYS);

      await insertObservation(env.DB, {
        market_id: candidate.marketId,
        ticker: candidate.ticker,
        p_beat: pBeat,
        imbalance,
        strength,
        current_stock_price: price,
        pm_url: candidate.pmUrl,
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
    `run complete: discovered=${summary.discovered} gated=${summary.gated} ` +
      `scored=${summary.scored} recorded=${summary.recorded} skipped=${summary.skipped}`,
  );
  return summary;
}
