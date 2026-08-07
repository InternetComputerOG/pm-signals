import { describe, expect, it } from "vitest";

import type { SignalRow } from "./db";
import { groupByTicker, renderPage } from "./render";

function row(partial: Partial<SignalRow> & Pick<SignalRow, "ticker" | "strength">): SignalRow {
  return {
    id: crypto.randomUUID(),
    market_id: `0x${partial.ticker}`,
    p_beat: 0.2,
    imbalance: -0.5,
    current_stock_price: null,
    pm_url: "https://polymarket.com/event/example",
    recorded_at: "2026-08-01 12:00:00",
    ...partial,
  };
}

describe("groupByTicker", () => {
  it("returns one series per ticker, strongest first", () => {
    const series = groupByTicker([
      row({ ticker: "AAA", strength: 10 }),
      row({ ticker: "BBB", strength: 80 }),
      row({ ticker: "CCC", strength: 45 }),
    ]);
    expect(series.map((s) => s.ticker)).toEqual(["BBB", "CCC", "AAA"]);
  });

  it("ranks on the latest observation, not the strongest one", () => {
    // Rows arrive oldest-first, so a decayed signal must sort by its last value.
    const series = groupByTicker([
      row({ ticker: "FADED", strength: 95, recorded_at: "2026-08-01 12:00:00" }),
      row({ ticker: "FADED", strength: 5, recorded_at: "2026-08-02 12:00:00" }),
      row({ ticker: "RISING", strength: 60, recorded_at: "2026-08-02 12:00:00" }),
    ]);
    expect(series.map((s) => s.ticker)).toEqual(["RISING", "FADED"]);
    expect(series[1].latest.strength).toBe(5);
  });
});

describe("renderPage", () => {
  it("shows the empty state when nothing is active", () => {
    const html = renderPage([]);
    expect(html).toContain("No active signals");
    expect(html).not.toContain("<article class=\"card");
  });

  it("splits cards into conviction and watchlist tiers at the publish score", () => {
    const html = renderPage([
      row({ ticker: "STRONG", strength: 62 }),
      row({ ticker: "WEAK", strength: 22 }),
    ]);
    expect(html).toContain('class="card conviction"');
    expect(html).toContain('class="card watchlist"');
    // Strongest first.
    expect(html.indexOf("STRONG")).toBeLessThan(html.indexOf("WEAK"));
  });

  it("escapes untrusted market text rather than interpolating it raw", () => {
    const html = renderPage([
      row({ ticker: "XSS", strength: 60, pm_url: 'https://x.test/"><script>alert(1)</script>' }),
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps a stray tag out of the canvas id derived from the ticker", () => {
    const html = renderPage([row({ ticker: "</script><b>", strength: 60 })]);
    expect(html).toContain('id="chart-scriptb"');
  });

  it("neutralises a closing script tag inside the embedded chart JSON", () => {
    // Chart labels are the only free text that reaches the script block: an
    // unparseable timestamp is passed through verbatim.
    const html = renderPage([row({ ticker: "AAA", strength: 60, recorded_at: "</script><b>" })]);
    const embedded = html.slice(html.indexOf("var series ="));
    expect(embedded).not.toContain("</script><b>");
    expect(embedded).toContain("\\u003c/script>\\u003cb>");
  });

  it("omits the price series when no stock price was recorded", () => {
    const html = renderPage([row({ ticker: "NOPRICE", strength: 60 })]);
    expect(html).toContain('"price":[null]');
  });
});
