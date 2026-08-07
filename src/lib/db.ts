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
  recorded_at: string;
}

export type NewObservation = Omit<SignalRow, "id" | "recorded_at">;

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) to ISO-8601. */
export function toIso(sqliteTimestamp: string): string {
  if (!sqliteTimestamp) return sqliteTimestamp;
  if (sqliteTimestamp.includes("T")) return sqliteTimestamp;
  return `${sqliteTimestamp.replace(" ", "T")}Z`;
}

export async function insertObservation(db: D1Database, row: NewObservation): Promise<void> {
  await db
    .prepare(
      `INSERT INTO signal_history
         (id, market_id, ticker, p_beat, imbalance, strength, current_stock_price, pm_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    .run();
}

/**
 * Markets already seen inside the window.
 *
 * These are re-recorded on every subsequent run even when their score falls
 * back below the publication bar, which is the whole point: a signal decaying
 * or reversing is visible on the chart instead of the series just stopping.
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

/** Full rolling window, oldest first, which is the order the charts want. */
export async function getHistory(
  db: D1Database,
  days = HISTORY_WINDOW_DAYS,
): Promise<SignalRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, market_id, ticker, p_beat, imbalance, strength,
              current_stock_price, pm_url, recorded_at
         FROM signal_history
        WHERE recorded_at >= datetime('now', ?)
        ORDER BY recorded_at ASC`,
    )
    .bind(`-${days} days`)
    .all<SignalRow>();
  return results ?? [];
}
