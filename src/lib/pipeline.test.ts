import { describe, expect, it } from "vitest";

import { MAX_MARKETS_PER_RUN, MIN_TRACKED_MARKETS, RADAR_PBEAT_CEILING } from "./config";
import { selectCandidates } from "./pipeline";
import type { Candidate } from "./polymarket";

function candidate(ticker: string, fallbackPBeat: number | null, volume = 100): Candidate {
  return {
    marketId: `0x${ticker}`,
    yesTokenId: `token-${ticker}`,
    question: `Will ${ticker} beat quarterly earnings?`,
    slug: `${ticker.toLowerCase()}-quarterly-earnings`,
    pmUrl: `https://polymarket.com/event/${ticker.toLowerCase()}`,
    volume,
    ticker,
    fallbackPBeat,
    endDate: "2026-08-12T13:00:00Z",
  };
}

const tickers = (candidates: Candidate[]) => candidates.map((c) => c.ticker);

/**
 * The live board on 2026-08-07, ticker / YES price / volume, exactly as Gamma
 * returned it. Kept whole rather than trimmed because its shape is the point:
 * the three most liquid markets were priced 0.30, 0.79 and 0.85, while every
 * market that passed the primary filter sat in the bottom half by volume.
 */
const LIVE_BOARD_2026_08_07: Candidate[] = [
  candidate("SPCE", 0.85, 4334.06),
  candidate("HD", 0.79, 2016.23),
  candidate("RKLB", 0.3, 904.96),
  candidate("AMAT", 0.94, 901.57),
  candidate("CSCO", 0.945, 700.18),
  candidate("RUM", 0.185, 582.62),
  candidate("MRX", 0.92, 552.31),
  candidate("AS", 0.94, 551.98),
  candidate("VIK", 0.76, 413.27),
  candidate("NMAX", 0.715, 376.6),
  candidate("WB", 0.36, 368.41),
  candidate("ETOR", 0.625, 299.93),
  candidate("ACM", 0.945, 234.14),
  candidate("EL", 0.825, 201.51),
  candidate("BLSH", 0.31, 199.34),
  candidate("DY", 0.745, 121.2),
  candidate("ADI", 0.87, 113.39),
  candidate("GETY", 0.225, 106),
  candidate("QUBT", 0.355, 92.39),
  candidate("WMT", 0.79, 56.22),
  candidate("PLBY", 0.22, 53.25),
  candidate("HIMS", 0.295, 53.16),
  candidate("STUB", 0.35, 50),
  candidate("PXLW", 0.415, 29),
  candidate("LOW", 0.675, 19.43),
  candidate("TBPH", 0.295, 10),
];

describe("selectCandidates", () => {
  /**
   * REGRESSION GUARD - do not delete.
   *
   * The volume gate this replaced took the top 10% of the board by liquidity,
   * which on this data is exactly SPCE, HD and RKLB. Two of those are priced
   * near 0.80 and the third sits exactly on the filter, where the PEAD
   * strength is still 0, so the run recorded nothing at all while five real
   * signals were on the board. Selecting on liquidity selects against a
   * short-side thesis: volume concentrates in the names the crowd expects to
   * beat.
   */
  it("keeps the markets that pass the primary filter, which the volume gate discarded", () => {
    const selected = tickers(selectCandidates(LIVE_BOARD_2026_08_07, new Set()));

    // The five that scored above zero and were thrown away.
    expect(selected).toEqual(expect.arrayContaining(["RUM", "PLBY", "GETY", "HIMS", "TBPH"]));

    // The three the old gate admitted, two of which were never scoreable.
    expect(selected).not.toContain("SPCE");
    expect(selected).not.toContain("HD");
  });

  it("orders the live board by price, cheapest first", () => {
    expect(tickers(selectCandidates(LIVE_BOARD_2026_08_07, new Set()))).toEqual([
      "RUM",
      "PLBY",
      "GETY",
      "HIMS",
      "TBPH",
      "RKLB",
      "BLSH",
      "STUB",
      "QUBT",
      "WB",
      "PXLW",
    ]);
  });

  it("prefers a cheap thin market over an expensive liquid one", () => {
    const selected = selectCandidates(
      [candidate("RICH", 0.79, 2016), candidate("CHEAP", 0.22, 10)],
      new Set(),
    );
    expect(tickers(selected)[0]).toBe("CHEAP");
  });

  it("breaks a price tie on volume, so the better book wins", () => {
    const selected = selectCandidates(
      [candidate("THIN", 0.295, 10), candidate("DEEP", 0.295, 900)],
      new Set(),
    );
    expect(tickers(selected)).toEqual(["DEEP", "THIN"]);
  });

  it("excludes markets above the radar ceiling once the floor is satisfied", () => {
    const board = [
      ...Array.from({ length: MIN_TRACKED_MARKETS }, (_, i) => candidate(`LOW${i}`, 0.2)),
      candidate("HIGH", RADAR_PBEAT_CEILING + 0.01),
    ];
    expect(tickers(selectCandidates(board, new Set()))).not.toContain("HIGH");
  });

  it("admits a market sitting exactly on the radar ceiling", () => {
    const board = [
      ...Array.from({ length: MIN_TRACKED_MARKETS }, (_, i) => candidate(`LOW${i}`, 0.2)),
      candidate("EDGE", RADAR_PBEAT_CEILING),
    ];
    expect(tickers(selectCandidates(board, new Set()))).toContain("EDGE");
  });

  it("floor-fills with the cheapest markets when nothing clears the ceiling", () => {
    // A board where the crowd expects every name to beat. Under a ceiling-only
    // rule this renders an empty dashboard; the floor is what prevents that.
    const board = [
      candidate("A", 0.95),
      candidate("B", 0.6),
      candidate("C", 0.9),
      candidate("D", 0.55),
      candidate("E", 0.99),
      candidate("F", 0.7),
      candidate("G", 0.85),
      candidate("H", 0.8),
    ];
    const selected = selectCandidates(board, new Set());
    expect(selected).toHaveLength(MIN_TRACKED_MARKETS);
    expect(tickers(selected)).toEqual(["D", "B", "F", "H", "G", "C"]);
  });

  it("floor-fills to the whole board when it is smaller than the floor", () => {
    const board = [candidate("A", 0.9), candidate("B", 0.8), candidate("C", 0.95)];
    expect(tickers(selectCandidates(board, new Set()))).toEqual(["B", "A", "C"]);
  });

  it("returns nothing for an empty board", () => {
    expect(selectCandidates([], new Set())).toEqual([]);
  });

  it("keeps a tracked market that has drifted above the ceiling", () => {
    // Its series must keep extending, otherwise the chart just stops instead
    // of showing the reversal.
    const board = [
      ...Array.from({ length: MIN_TRACKED_MARKETS }, (_, i) => candidate(`LOW${i}`, 0.2)),
      candidate("FADED", 0.72),
    ];
    const selected = tickers(selectCandidates(board, new Set(["0xFADED"])));
    expect(selected).toContain("FADED");
  });

  it("still lets a much cheaper new market outrank a tracked one", () => {
    // The tracked discount is a tiebreak, not a veto.
    const selected = selectCandidates(
      [candidate("TRACKED", 0.4), candidate("FRESH", 0.2)],
      new Set(["0xTRACKED"]),
    );
    expect(tickers(selected)).toEqual(["FRESH", "TRACKED"]);
  });

  it("puts a tracked market ahead of an equally priced new one", () => {
    const selected = selectCandidates(
      [candidate("FRESH", 0.3), candidate("TRACKED", 0.3)],
      new Set(["0xTRACKED"]),
    );
    expect(tickers(selected)).toEqual(["TRACKED", "FRESH"]);
  });

  it("sorts a market with no price last, since unknown is not cheap", () => {
    const selected = selectCandidates(
      [candidate("UNKNOWN", null), candidate("PRICED", 0.45)],
      new Set(),
    );
    expect(tickers(selected)[0]).toBe("PRICED");
  });

  it("caps at the subrequest budget", () => {
    const board = Array.from({ length: MAX_MARKETS_PER_RUN + 8 }, (_, i) =>
      candidate(`T${i}`, 0.1),
    );
    expect(selectCandidates(board, new Set())).toHaveLength(MAX_MARKETS_PER_RUN);
  });

  it("does not mutate the caller's array", () => {
    const board = [candidate("B", 0.4), candidate("A", 0.2)];
    selectCandidates(board, new Set());
    expect(tickers(board)).toEqual(["B", "A"]);
  });
});
