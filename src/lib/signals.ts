/**
 * Pure signal math. No I/O, no clock, no randomness - everything here is
 * directly unit-testable and is the whole of the "model".
 *
 * Research basis: Chloe Feng (2026), "Minority Report: Contrarian Traders,
 * Prediction Markets, and the Return of Post-Earnings Drift"
 * (SSRN abstract_id=6477080 / 6578598).
 *
 * The mapping from paper to code is deliberately literal:
 *
 *   primary filter      pBeat <= 0.30            -> computePeadsStrength
 *   conviction overlay  directional whale flow   -> computeImbalanceStrength
 *   combined            filter gates the overlay -> computeTotalScore
 *
 * A low crowd-assigned beat probability is on its own enough to predict
 * 10-day post-announcement drift; strong net selling pressure from large
 * traders raises realised beat certainty further. So the probability is a
 * gate, not an addend: if pBeat is above 0.30 the score is zero no matter how
 * lopsided the order flow is.
 */

/** A trade already normalised onto the YES ("beat") axis. See polymarket.ts. */
export interface NormalizedTrade {
  side: string;
  size: number;
  price: number;
}

/**
 * Primary PEAD filter. Scores 0-60, rising linearly as the crowd's beat
 * probability falls below 0.30. Spec section 5, unchanged.
 */
export function computePeadsStrength(pBeat: number): number {
  if (pBeat > 0.3) return 0;
  return Math.min(60, Math.round((0.3 - pBeat) * 200));
}

/**
 * Net large-trade order-flow imbalance on the YES side, in [-1, 1].
 * Negative means net selling pressure against the beat.
 *
 * Keeps the spec's $1,000 large-trade floor. In production we call
 * computeImbalanceAbove with an adaptive threshold instead, because no real
 * earnings market has $1,000 prints this far from resolution. This wrapper is
 * kept so the spec'd bar stays exercised by the test suite.
 */
export function computeImbalance(trades: NormalizedTrade[]): number {
  return computeImbalanceAbove(trades, 1000);
}

/**
 * computeImbalance generalised over the "what counts as a large trade" bar.
 *
 * Trades must already be normalised onto the YES axis: a BUY of the NO token
 * is economically selling pressure on the beat, and passing raw Polymarket
 * trades in here would invert the conviction signal for those prints.
 *
 * SIGN CONVENTION - deviates from the spec, deliberately.
 *
 * The spec's body returned `(sell - buy) / total`, which is positive when
 * selling dominates. That contradicts both its own trailing comment
 * ("negative = selling pressure") and its only consumer,
 * computeImbalanceStrength, which awards its maximum to values <= -0.70.
 * Taken literally, an all-selling market scored a 0 conviction bonus and an
 * all-buying market scored the full 40, so the multiplier fired on whale
 * *accumulation* of "beat" in a short-side dashboard - precisely inverted.
 *
 * `(buy - sell) / total` is the one-character fix that makes the function
 * agree with its documented convention and with the research premise that
 * net selling pressure is what raises conviction.
 */
export function computeImbalanceAbove(trades: NormalizedTrade[], minNotional: number): number {
  let buy = 0;
  let sell = 0;
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

/**
 * Conviction multiplier. Deliberately a coarse step function rather than a
 * continuous curve - the paper supports "strong directional flow", not a
 * precise elasticity, and a smooth curve would imply precision we do not have.
 * Spec section 5, unchanged.
 */
export function computeImbalanceStrength(imbalance: number): number {
  if (imbalance >= -0.3) return 0;
  if (imbalance <= -0.7) return 40;
  return 25;
}

/** Combined 0-100 score. Spec section 5, unchanged. */
export function computeTotalScore(pBeat: number, imbalance: number): number {
  const pead = computePeadsStrength(pBeat);
  if (pead === 0) return 0; // primary filter
  return Math.min(100, pead + computeImbalanceStrength(imbalance));
}

/**
 * Value at the cut-off of the top `fraction` of `values`, used by both
 * adaptive gates (top 10% of market volumes, top 5% of a market's trades).
 * Items greater than or equal to the return value are "in the top slice".
 *
 * The slice always contains at least one item, so on small samples this
 * degenerates to "the single largest value". That is intended: a market with
 * four fills does not have a meaningful 5% tail.
 *
 * Returns Infinity for an empty input so that callers naturally admit nothing.
 */
export function topPercentileThreshold(values: number[], fraction: number): number {
  if (values.length === 0) return Infinity;
  const sorted = [...values].sort((a, b) => b - a);
  const take = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * fraction)));
  return sorted[take - 1];
}
