import { describe, expect, it } from "vitest";

import type { SignalRow } from "./db";
import { describeDrift, describeResolution, groupByTicker, renderPage, tierOf } from "./render";

/** Fixed clock, so "resolves in Nd" is not a function of when the suite runs. */
const NOW = Date.parse("2026-08-07T12:00:00Z");

function row(partial: Partial<SignalRow> & Pick<SignalRow, "ticker" | "strength">): SignalRow {
  return {
    id: crypto.randomUUID(),
    market_id: `0x${partial.ticker}`,
    p_beat: 0.2,
    imbalance: -0.5,
    current_stock_price: null,
    pm_url: "https://polymarket.com/event/example",
    resolution_date: "2026-08-12T13:00:00Z",
    volume: 900,
    recorded_at: "2026-08-01 12:00:00",
    ...partial,
  };
}

describe("tierOf", () => {
  it("promotes anything at or above the publish score", () => {
    expect(tierOf(row({ ticker: "A", strength: 50, p_beat: 0.05 }))).toBe("conviction");
  });

  it("calls a low-scoring row inside the filter a watchlist row", () => {
    expect(tierOf(row({ ticker: "A", strength: 22, p_beat: 0.19 }))).toBe("watchlist");
  });

  it("keeps a row exactly on the filter in the watchlist despite scoring zero", () => {
    // computePeadsStrength(0.30) is 0, so strength cannot distinguish this
    // from a radar row. p_beat is what does.
    expect(tierOf(row({ ticker: "A", strength: 0, p_beat: 0.3 }))).toBe("watchlist");
  });

  it("puts anything above the filter on the radar", () => {
    expect(tierOf(row({ ticker: "A", strength: 0, p_beat: 0.31 }))).toBe("radar");
  });
});

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

  it("orders zero-scoring rows by price, so the boundary beats the radar", () => {
    // Every one of these scores 0, so the p_beat tiebreak is the only thing
    // keeping tier order intact.
    const series = groupByTicker([
      row({ ticker: "FAR", strength: 0, p_beat: 0.44 }),
      row({ ticker: "BOUNDARY", strength: 0, p_beat: 0.3 }),
      row({ ticker: "NEAR", strength: 0, p_beat: 0.33 }),
    ]);
    expect(series.map((s) => s.ticker)).toEqual(["BOUNDARY", "NEAR", "FAR"]);
    expect(series.map((s) => s.tier)).toEqual(["watchlist", "radar", "radar"]);
  });

  it("sorts every tier into its section order in one pass", () => {
    const series = groupByTicker([
      row({ ticker: "RADAR", strength: 0, p_beat: 0.42 }),
      row({ ticker: "WATCH", strength: 15, p_beat: 0.22 }),
      row({ ticker: "STRONG", strength: 66, p_beat: 0.04 }),
    ]);
    expect(series.map((s) => s.tier)).toEqual(["conviction", "watchlist", "radar"]);
  });
});

describe("describeDrift", () => {
  it("reports a single observation as such rather than as no movement", () => {
    expect(describeDrift([row({ ticker: "A", strength: 0 })]).text).toBe("first reading");
  });

  it("marks a fall toward the filter as the interesting direction", () => {
    const drift = describeDrift([
      row({ ticker: "A", strength: 0, p_beat: 0.44 }),
      row({ ticker: "A", strength: 0, p_beat: 0.33 }),
    ]);
    expect(drift.text).toBe("-11.0 pts");
    expect(drift.cls).toBe("falling");
  });

  it("marks a rise away from the filter", () => {
    const drift = describeDrift([
      row({ ticker: "A", strength: 0, p_beat: 0.33 }),
      row({ ticker: "A", strength: 0, p_beat: 0.4 }),
    ]);
    expect(drift.text).toBe("+7.0 pts");
    expect(drift.cls).toBe("rising");
  });

  it("measures from the oldest row, not the previous one", () => {
    const drift = describeDrift([
      row({ ticker: "A", strength: 0, p_beat: 0.5 }),
      row({ ticker: "A", strength: 0, p_beat: 0.2 }),
      row({ ticker: "A", strength: 0, p_beat: 0.35 }),
    ]);
    expect(drift.text).toBe("-15.0 pts");
  });

  it("calls an unmoved series flat, with no direction colour", () => {
    const drift = describeDrift([
      row({ ticker: "A", strength: 0, p_beat: 0.35 }),
      row({ ticker: "A", strength: 0, p_beat: 0.35 }),
    ]);
    expect(drift.text).toBe("flat, 2 obs");
    expect(drift.cls).toBe("");
  });
});

describe("describeResolution", () => {
  it("counts whole days to the resolution date", () => {
    expect(describeResolution("2026-08-10T13:00:00Z", NOW)).toBe("3d");
  });

  it("reports a date inside the next 24 hours as today", () => {
    expect(describeResolution("2026-08-07T20:00:00Z", NOW)).toBe("today");
  });

  it("reports a date already gone as passed", () => {
    expect(describeResolution("2026-08-05T13:00:00Z", NOW)).toBe("passed");
  });

  it("degrades to an em dash for rows written before the column existed", () => {
    expect(describeResolution(null, NOW)).toBe("&mdash;");
    expect(describeResolution("not a date", NOW)).toBe("&mdash;");
  });
});

describe("renderPage", () => {
  it("shows the empty state only when no market is being tracked at all", () => {
    const html = renderPage([], NOW);
    expect(html).toContain("No earnings markets open");
    expect(html).not.toContain('<article class="card');
  });

  it("splits cards into conviction, watchlist and radar sections", () => {
    const html = renderPage(
      [
        row({ ticker: "STRONG", strength: 62, p_beat: 0.04 }),
        row({ ticker: "WEAK", strength: 22, p_beat: 0.19 }),
        row({ ticker: "EARLY", strength: 0, p_beat: 0.38 }),
      ],
      NOW,
    );
    expect(html).toContain('class="card conviction"');
    expect(html).toContain('class="card watchlist"');
    expect(html).toContain('class="card radar"');
    expect(html.indexOf("STRONG")).toBeLessThan(html.indexOf("WEAK"));
    expect(html.indexOf("WEAK")).toBeLessThan(html.indexOf("EARLY"));
  });

  it("omits a tier section entirely when nothing is in it", () => {
    const html = renderPage([row({ ticker: "EARLY", strength: 0, p_beat: 0.38 })], NOW);
    expect(html).toContain("radar-group");
    expect(html).not.toContain("conviction-group");
    expect(html).not.toContain("watchlist-group");
  });

  it("tells a radar card how far it is from the filter", () => {
    const html = renderPage([row({ ticker: "EARLY", strength: 0, p_beat: 0.38 })], NOW);
    expect(html).toContain("8.0 pts above the 30% filter");
  });

  it("renders drift, book and resolution on the card", () => {
    const html = renderPage(
      [
        row({ ticker: "AAA", strength: 0, p_beat: 0.44, volume: 10 }),
        row({
          ticker: "AAA",
          strength: 0,
          p_beat: 0.34,
          volume: 10,
          resolution_date: "2026-08-10T13:00:00Z",
        }),
      ],
      NOW,
    );
    expect(html).toContain("-10.0 pts");
    expect(html).toContain('class="thin"'); // $10 book, well under the floor
    expect(html).toContain(">$10<");
    expect(html).toContain(">3d<");
  });

  it("formats a four-figure book in thousands", () => {
    const html = renderPage([row({ ticker: "AAA", strength: 10, volume: 2016.23 })], NOW);
    expect(html).toContain(">$2.0k<");
  });

  it("degrades gracefully for rows written before the new columns existed", () => {
    const html = renderPage(
      [row({ ticker: "OLD", strength: 10, volume: null, resolution_date: null })],
      NOW,
    );
    expect(html).toContain("&mdash;");
    expect(html).toContain("OLD");
  });

  it("escapes untrusted market text rather than interpolating it raw", () => {
    const html = renderPage(
      [row({ ticker: "XSS", strength: 60, pm_url: 'https://x.test/"><script>alert(1)</script>' })],
      NOW,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("keeps a stray tag out of the canvas id derived from the ticker", () => {
    const html = renderPage([row({ ticker: "</script><b>", strength: 60 })], NOW);
    expect(html).toContain('id="chart-scriptb"');
  });

  it("neutralises a closing script tag inside the embedded chart JSON", () => {
    // Chart labels are the only free text that reaches the script block: an
    // unparseable timestamp is passed through verbatim.
    const html = renderPage([row({ ticker: "AAA", strength: 60, recorded_at: "</script><b>" })], NOW);
    const embedded = html.slice(html.indexOf("var series ="));
    expect(embedded).not.toContain("</script><b>");
    expect(embedded).toContain("\\u003c/script>\\u003cb>");
  });

  it("omits the price series when no stock price was recorded", () => {
    const html = renderPage([row({ ticker: "NOPRICE", strength: 60 })], NOW);
    expect(html).toContain('"price":[null]');
  });
});

describe("refresh control", () => {
  it("renders on the empty state, which is where it is needed most", () => {
    // A fresh deployment has nothing to show and no way to fix that from the
    // page unless the button lives outside the card grid.
    const html = renderPage([], NOW);
    expect(html).toContain('id="refresh-btn"');
    expect(html).toContain("No earnings markets open");
  });

  it("renders alongside cards too", () => {
    const html = renderPage([row({ ticker: "AAA", strength: 22 })], NOW);
    expect(html).toContain('id="refresh-btn"');
  });

  it("posts to /refresh as a real form, so it works without scripting", () => {
    const html = renderPage([], NOW);
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/refresh"');
    expect(html).toContain('type="submit"');
  });

  it("gives the status region a live role for screen readers", () => {
    const html = renderPage([], NOW);
    expect(html).toContain('aria-live="polite"');
  });

  it("loads the refresh script before the Chart.js CDN tag", () => {
    // The control must survive the CDN being unreachable.
    const html = renderPage([row({ ticker: "AAA", strength: 22 })], NOW);
    expect(html.indexOf("refresh-form")).toBeLessThan(html.indexOf("cdn.jsdelivr.net"));
    expect(html.indexOf("getElementById('refresh-form')")).toBeLessThan(
      html.indexOf("cdn.jsdelivr.net"),
    );
  });
});
