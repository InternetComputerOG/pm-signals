import { describe, expect, it } from "vitest";

import { imbalanceFor } from "./pipeline";
import { extractTicker, normalizeTrade } from "./polymarket";
import {
  computeImbalance,
  computeImbalanceAbove,
  computeImbalanceStrength,
  computePeadsStrength,
  computeTotalScore,
  topPercentileThreshold,
} from "./signals";

describe("computePeadsStrength", () => {
  it("scores zero above the 0.30 primary filter", () => {
    expect(computePeadsStrength(0.31)).toBe(0);
    expect(computePeadsStrength(0.79)).toBe(0);
    expect(computePeadsStrength(1)).toBe(0);
  });

  it("scores zero exactly at the boundary, where the crowd is indifferent", () => {
    expect(computePeadsStrength(0.3)).toBe(0);
  });

  it("rises linearly as the beat probability falls", () => {
    expect(computePeadsStrength(0.295)).toBe(1);
    expect(computePeadsStrength(0.25)).toBe(10);
    expect(computePeadsStrength(0.19)).toBe(22);
    expect(computePeadsStrength(0.05)).toBe(50);
  });

  it("caps at 60", () => {
    expect(computePeadsStrength(0)).toBe(60);
    expect(computePeadsStrength(-1)).toBe(60);
  });
});

describe("computeImbalance", () => {
  it("ignores trades below the spec's $1,000 large-trade floor", () => {
    const trades = [
      { side: "SELL", size: 100, price: 0.5 }, // $50
      { side: "BUY", size: 50, price: 0.4 }, //  $20
    ];
    expect(computeImbalance(trades)).toBe(0);
  });

  it("reports net selling pressure as negative", () => {
    const trades = [
      { side: "SELL", size: 10000, price: 0.5 }, // $5,000
      { side: "BUY", size: 2000, price: 0.5 }, //  $1,000
    ];
    expect(computeImbalance(trades)).toBeCloseTo((1000 - 5000) / 6000, 10);
  });

  it("returns 0 when nothing qualifies", () => {
    expect(computeImbalance([])).toBe(0);
  });

  it("saturates at -1 for one-sided selling and +1 for one-sided buying", () => {
    expect(computeImbalance([{ side: "SELL", size: 10000, price: 0.5 }])).toBe(-1);
    expect(computeImbalance([{ side: "BUY", size: 10000, price: 0.5 }])).toBe(1);
  });

  /**
   * Regression guard for the spec's inverted sign. If the formula ever flips
   * back to (sell - buy), heavy selling stops earning conviction and heavy
   * buying starts earning it, which is the opposite of the intended signal.
   */
  it("makes heavy selling, not heavy buying, earn the conviction bonus", () => {
    const allSelling = computeImbalance([{ side: "SELL", size: 10000, price: 0.5 }]);
    const allBuying = computeImbalance([{ side: "BUY", size: 10000, price: 0.5 }]);
    expect(computeImbalanceStrength(allSelling)).toBe(40);
    expect(computeImbalanceStrength(allBuying)).toBe(0);
  });
});

describe("computeImbalanceAbove", () => {
  it("matches computeImbalance when given the spec's floor", () => {
    const trades = [
      { side: "SELL", size: 4000, price: 0.5 },
      { side: "BUY", size: 100, price: 0.5 },
    ];
    expect(computeImbalanceAbove(trades, 1000)).toBe(computeImbalance(trades));
  });

  it("admits smaller prints as the threshold drops", () => {
    const trades = [
      { side: "SELL", size: 100, price: 0.5 }, // $50
      { side: "BUY", size: 50, price: 0.5 }, //  $25
    ];
    expect(computeImbalanceAbove(trades, 1000)).toBe(0);
    expect(computeImbalanceAbove(trades, 20)).toBeCloseTo((25 - 50) / 75, 10);
  });
});

describe("computeImbalanceStrength", () => {
  it("gives no credit for weak or buy-side flow", () => {
    expect(computeImbalanceStrength(0)).toBe(0);
    expect(computeImbalanceStrength(-0.3)).toBe(0);
    expect(computeImbalanceStrength(0.9)).toBe(0);
  });

  it("gives partial credit in the middle band", () => {
    expect(computeImbalanceStrength(-0.31)).toBe(25);
    expect(computeImbalanceStrength(-0.5)).toBe(25);
    expect(computeImbalanceStrength(-0.69)).toBe(25);
  });

  it("gives full credit for heavy selling pressure", () => {
    expect(computeImbalanceStrength(-0.7)).toBe(40);
    expect(computeImbalanceStrength(-1)).toBe(40);
  });
});

describe("computeTotalScore", () => {
  it("gates on the primary filter regardless of flow", () => {
    expect(computeTotalScore(0.5, -1)).toBe(0);
    expect(computeTotalScore(0.3, -1)).toBe(0);
  });

  it("adds the conviction multiplier on top of the PEAD score", () => {
    // pBeat 0.19 -> 22, heavy selling -> +40
    expect(computeTotalScore(0.19, -0.8)).toBe(62);
    // Same probability, no whale flow -> price-only, below the publish bar.
    expect(computeTotalScore(0.19, 0)).toBe(22);
  });

  it("caps at 100", () => {
    expect(computeTotalScore(0, -1)).toBe(100);
  });
});

describe("topPercentileThreshold", () => {
  it("admits nothing for an empty input", () => {
    expect(topPercentileThreshold([], 0.1)).toBe(Infinity);
  });

  it("returns the cut-off of the top slice", () => {
    const volumes = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    // Top 10% of ten values is one value: the largest.
    expect(topPercentileThreshold(volumes, 0.1)).toBe(1000);
    // Top 30% is three values, so the cut-off is the third largest.
    expect(topPercentileThreshold(volumes, 0.3)).toBe(800);
  });

  it("degenerates to the largest value on small samples", () => {
    expect(topPercentileThreshold([10, 20, 30, 40, 50], 0.05)).toBe(50);
    expect(topPercentileThreshold([42], 0.05)).toBe(42);
  });
});

describe("normalizeTrade", () => {
  const YES = "yes-token";
  const NO = "no-token";

  it("passes YES trades through untouched", () => {
    expect(normalizeTrade({ side: "BUY", size: 10, price: 0.25, asset: YES }, YES)).toEqual({
      side: "BUY",
      size: 10,
      price: 0.25,
    });
  });

  it("folds a NO buy into YES selling pressure", () => {
    // Buying NO at $0.22 is selling YES at $0.78.
    expect(normalizeTrade({ side: "BUY", size: 22, price: 0.22, asset: NO }, YES)).toEqual({
      side: "SELL",
      size: 22,
      price: 0.78,
    });
  });

  it("folds a NO sell into YES buying pressure", () => {
    const t = normalizeTrade({ side: "SELL", size: 5, price: 0.7, asset: NO }, YES)!;
    expect(t.side).toBe("BUY");
    expect(t.size).toBe(5);
    expect(t.price).toBeCloseTo(0.3, 10);
  });

  it("falls back to the outcome label when no asset id is present", () => {
    const no = normalizeTrade({ side: "BUY", size: 1, price: 0.4, outcome: "No" }, YES)!;
    expect(no.side).toBe("SELL");
    expect(no.price).toBeCloseTo(0.6, 10);

    expect(normalizeTrade({ side: "BUY", size: 1, price: 0.4, outcome: "Yes" }, YES)).toEqual({
      side: "BUY",
      size: 1,
      price: 0.4,
    });
  });

  it("rejects malformed trades", () => {
    expect(normalizeTrade({ side: "BUY", size: NaN, price: 0.4, asset: YES }, YES)).toBeNull();
    expect(normalizeTrade({ side: "MERGE", size: 1, price: 0.4, asset: YES }, YES)).toBeNull();
  });

  it("would invert the signal if outcome were ignored", () => {
    // Four large NO buys are bearish on the beat. Read naively they look bullish.
    const raw = Array.from({ length: 4 }, () => ({
      side: "BUY",
      size: 10000,
      price: 0.2,
      asset: NO,
    }));
    const normalized = raw.map((t) => normalizeTrade(t, YES)!);
    expect(imbalanceFor(normalized)).toBe(-1); // net selling on YES, as it should be
    const naive = raw.map((t) => ({ side: t.side, size: t.size, price: t.price }));
    expect(imbalanceFor(naive)).toBe(1); // read as buying pressure: wrong sign
  });
});

describe("imbalanceFor", () => {
  it("returns 0 with no trades", () => {
    expect(imbalanceFor([])).toBe(0);
  });

  it("reports no whale flow when the biggest print misses the absolute floor", () => {
    // This is the common case on real markets away from resolution dates:
    // the largest fill is in the low hundreds, so there is simply nothing to
    // read and the ticker becomes a price-only signal.
    const trades = [
      { side: "SELL", size: 600, price: 0.5 }, // $300
      { side: "SELL", size: 400, price: 0.5 }, // $200
      { side: "BUY", size: 200, price: 0.5 }, //  $100
      { side: "BUY", size: 2, price: 0.5 }, //     $1
    ];
    expect(imbalanceFor(trades)).toBe(0);
  });

  it("does not promote dust just because it is the biggest thing present", () => {
    const trades = [
      { side: "SELL", size: 20, price: 0.5 }, // $10
      { side: "BUY", size: 2, price: 0.5 }, //    $1
      { side: "BUY", size: 2, price: 0.5 }, //    $1
    ];
    expect(imbalanceFor(trades)).toBe(0);
  });

  it("keeps only the top slice once a market is genuinely liquid", () => {
    // Twenty fills, so the top 5% is one fill. It clears $1,000, so it is the
    // only whale print and the imbalance reflects it alone.
    const trades = [
      { side: "SELL", size: 10000, price: 0.5 }, // $5,000
      ...Array.from({ length: 19 }, () => ({ side: "BUY", size: 2400, price: 0.5 })), // $1,200
    ];
    expect(imbalanceFor(trades)).toBe(-1);
  });

  it("splits the imbalance across whales when several clear both bars", () => {
    // Forty equal-notional fills: top 5% is two of them, one per side.
    const trades = [
      { side: "SELL", size: 8000, price: 0.5 }, // $4,000
      { side: "BUY", size: 8000, price: 0.5 }, //  $4,000
      ...Array.from({ length: 38 }, () => ({ side: "BUY", size: 10, price: 0.5 })), // $5
    ];
    expect(imbalanceFor(trades)).toBe(0); // 4,000 buy vs 4,000 sell
  });
});

describe("extractTicker", () => {
  it("prefers the parenthesised symbol", () => {
    expect(
      extractTicker(
        "Will Home Depot (HD) beat quarterly earnings?",
        "hd-quarterly-earnings-nongaap-eps-08-18-2026-4pt73",
      ),
    ).toBe("HD");
    expect(
      extractTicker("Will Hims & Hers Health (HIMS) beat quarterly earnings?", "hims-q-earnings"),
    ).toBe("HIMS");
  });

  it("falls back to the slug prefix", () => {
    expect(extractTicker("Will this company beat earnings?", "rklb-quarterly-earnings-gaap-eps")).toBe(
      "RKLB",
    );
  });

  it("never returns template noise like EPS or GAAP", () => {
    const ticker = extractTicker(
      "Quarterly GAAP EPS earnings beat?",
      "quarterly-earnings-gaap-eps-08-19-2026",
    );
    expect(ticker).not.toBe("EPS");
    expect(ticker).not.toBe("GAAP");
  });

  it("returns null when there is nothing plausible", () => {
    expect(extractTicker("Will the EPS beat?", "quarterly-gaap-eps")).toBeNull();
  });

  it("strips punctuation from class-share symbols", () => {
    expect(extractTicker("Will Berkshire (BRK.B) beat quarterly earnings?", "brkb-earnings")).toBe(
      "BRKB",
    );
  });
});
