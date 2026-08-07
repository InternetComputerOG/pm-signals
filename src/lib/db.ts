/**
 * D1 helpers. One append-only table, three queries.
 *
 * A note on time: `recorded_at` is deliberately left to the column's
 * `DEFAULT (datetime('now'))` rather than written from the Worker. That keeps
 * every row in SQLite's own "YYYY-MM-DD HH:MM:SS" UTC format, which is what
 * makes the `>= datetime('now', '-10 days')` window comparisons correct -
 * writing ISO-8601 with a "T" and a "Z" would break them lexicographically.
 * Conversion to ISO-8601 happens on the way out, in toIso().
 */

import { HISTORY_WINDOW_DAYS } from "./config";

export interface SignalRow {
  id: string;
  market_id: string;
  ticker: string;
  p_beat: number;
  imbalance: number;
  strength: number;
  current_stock_price: number | null;
  pm_url: string | null;
  /**
   * Both added with the radar tier and both nullable, so rows written before
   * migrations/0001_radar_tier.sql read back as null. Context for the card,
   * never inputs to the score.
   */
  resolution_date: string | null;
  volume: number | null;
  recorded_at: string;
}

export type NewObservation = Omit<SignalRow, "id" | "recorded_at">;

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) to ISO-8601. */
export function toIso(sqliteTimestamp: string): string {
  if (!sqliteTimestamp) return sqliteTimestamp;
  if (sqliteTimestamp.includes("T")) return sqliteTimestamp;
  return `${sqliteTimestamp.replace(" ", "T")}Z`;
}

/**
 * Seconds before another manual refresh is allowed; 0 when one may run now.
 * Doubles as the `Retry-After` value, which is why it returns seconds rather
 * than a boolean.
 *
 * Lives here rather than in the route because it is entirely a question about
 * `recorded_at`, whose format is this module's concern - the same reason
 * toIso() is here.
 *
 * **Fails open.** No rows yet, or a timestamp that will not parse, both permit
 * the run. A fresh deployment has an empty table and is precisely the case the
 * endpoint exists for, so a null must not be mistaken for "just ran"; and a
 * malformed value should not be able to wedge the endpoint shut permanently.
 */
export function cooldownRemainingSeconds(
  latestRecorded: string | null,
  now: number,
  cooldownMinutes: number,
): number {
  if (!latestRecorded) return 0;

  const at = Date.parse(toIso(latestRecorded));
  if (Number.isNaN(at)) return 0;

  const windowMs = cooldownMinutes * 60_000;
  const elapsed = now - at;
  if (elapsed >= windowMs) return 0;

  // A timestamp in the future (clock skew) yields the full window rather than
  // a nonsensical value, since elapsed is negative and capped by the window.
  return Math.min(Math.ceil((windowMs - elapsed) / 1000), Math.ceil(windowMs / 1000));
}

export async function insertObservation(db: D1Database, row: NewObservation): Promise<void> {
  await db
    .prepare(
      `INSERT INTO signal_history
         (id, market_id, ticker, p_beat, imbalance, strength, current_stock_price,
          pm_url, resolution_date, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      row.market_id,
      row.ticker,
      row.p_beat,
      row.imbalance,
      row.strength,
      row.current_stock_price,
      row.pm_url,
      row.resolution_date,
      row.volume,
    )
    .run();
}

/**
 * Markets already seen inside the window.
 *
 * Read before selection, not after: these get a small ranking discount so a
 * series in progress is not crowded out by fresh candidates. That is the whole
 * point - a signal decaying or reversing stays visible on the chart instead of
 * the series simply stopping.
 */
export async function getRecentlySeenMarketIds(
  db: D1Database,
  days = HISTORY_WINDOW_DAYS,
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT market_id
         FROM signal_history
        WHERE recorded_at >= datetime('now', ?)`,
    )
    .bind(`-${days} days`)
    .all<{ market_id: string }>();
  return new Set((results ?? []).map((r) => r.market_id));
}

/**
 * Timestamp of the most recent observation, or null on an empty table.
 *
 * Unwindowed on purpose: this answers "when did a pass last write anything",
 * which the refresh cooldown needs, not "what is currently active".
 */
export async function latestRecordedAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare("SELECT MAX(recorded_at) AS latest FROM signal_history")
    .first<{ latest: string | null }>();
  return row?.latest ?? null;
}

/** Full rolling window, oldest first, which is the order the charts want. */
export async function getHistory(
  db: D1Database,
  days = HISTORY_WINDOW_DAYS,
): Promise<SignalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, market_id, ticker, p_beat, imbalance, strength,
              current_stock_price, pm_url, resolution_date, volume, recorded_at
         FROM signal_history
        WHERE recorded_at >= datetime('now', ?)
        ORDER BY recorded_at ASC`,
    )
    .bind(`-${days} days`)
    .all<SignalRow>();
  return results ?? [];
}
