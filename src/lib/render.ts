/**
 * Server-rendered landing page. No framework, no build step, no client-side
 * data fetching - the chart series are serialised straight into the document,
 * so the page paints complete in a single round trip.
 */

import {
  HISTORY_WINDOW_DAYS,
  MIN_PUBLISH_SCORE,
  PEAD_FILTER_CEILING,
  RADAR_PBEAT_CEILING,
  VOLUME_ABSOLUTE_FLOOR,
} from "./config";
import { toIso, type SignalRow } from "./db";

const CHART_JS_CDN = "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js";

const MS_PER_DAY = 86_400_000;

const FILTER_PCT = Math.round(PEAD_FILTER_CEILING * 100);
const RADAR_PCT = Math.round(RADAR_PBEAT_CEILING * 100);

export type Tier = "conviction" | "watchlist" | "radar";

export interface TickerSeries {
  ticker: string;
  latest: SignalRow;
  rows: SignalRow[];
  tier: Tier;
}

/** Rendered in this order, strongest evidence first. */
const TIER_ORDER: readonly Tier[] = ["conviction", "watchlist", "radar"];

const TIER_HEADINGS: Record<Tier, { title: string; blurb: string }> = {
  conviction: {
    title: "Conviction",
    blurb: `Inside the P(beat) &le; ${FILTER_PCT}% filter and scoring ${MIN_PUBLISH_SCORE} or
      better, which in practice needs strong net selling from large traders on top of a low
      price.`,
  },
  watchlist: {
    title: "Watchlist",
    blurb: `Inside the filter but below ${MIN_PUBLISH_SCORE}. Almost always a price-only
      signal: away from resolution dates these books have no trades large enough to read
      whale flow from, so the conviction multiplier stays at zero.`,
  },
  radar: {
    title: "Radar",
    blurb: `Not across the filter yet, so these score zero by definition. They are tracked
      anyway because the useful early signal is the drift - a market falling toward
      ${FILTER_PCT}% arrives with history behind it rather than appearing from nowhere.`,
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Safe to drop inside a <script> block: escaping "<" prevents a "</script>"
 * inside any string value from terminating the element early.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Which tier a card renders in, derived entirely from stored columns.
 *
 * strength alone cannot do this. A radar row scores 0 because it never passed
 * the primary filter, and a watchlist row sitting exactly on the filter also
 * scores 0 - computePeadsStrength returns 0 at pBeat 0.30. p_beat is what
 * separates "has not crossed yet" from "across it, just weak".
 */
export function tierOf(row: SignalRow): Tier {
  if (row.strength >= MIN_PUBLISH_SCORE) return "conviction";
  if (row.p_beat <= PEAD_FILTER_CEILING) return "watchlist";
  return "radar";
}

/**
 * Active signals are, per spec, any ticker with at least one record inside the
 * window. Rows arrive oldest-first, so the last one is the latest.
 *
 * The composite sort reproduces the tier order without knowing about tiers.
 * Conviction rows outrank everything on strength; radar rows always score 0
 * and always sit above PEAD_FILTER_CEILING, so on the strength tie they lose
 * the p_beat comparison to any watchlist row, including one that has decayed
 * to the boundary and scores 0 itself.
 */
export function groupByTicker(rows: SignalRow[]): TickerSeries[] {
  const byTicker = new Map<string, SignalRow[]>();
  for (const row of rows) {
    const existing = byTicker.get(row.ticker);
    if (existing) existing.push(row);
    else byTicker.set(row.ticker, [row]);
  }

  return [...byTicker.entries()]
    .map(([ticker, tickerRows]) => {
      const latest = tickerRows[tickerRows.length - 1];
      return { ticker, rows: tickerRows, latest, tier: tierOf(latest) };
    })
    .sort((a, b) => b.latest.strength - a.latest.strength || a.latest.p_beat - b.latest.p_beat);
}

function formatTimestamp(sqliteTimestamp: string): string {
  const date = new Date(toIso(sqliteTimestamp));
  if (Number.isNaN(date.getTime())) return sqliteTimestamp;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function formatChartLabel(sqliteTimestamp: string): string {
  const date = new Date(toIso(sqliteTimestamp));
  if (Number.isNaN(date.getTime())) return sqliteTimestamp;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  });
}

function describeImbalance(imbalance: number): { text: string; cls: string } {
  if (imbalance < 0) return { text: `${(imbalance * 100).toFixed(0)}% sell`, cls: "sell" };
  if (imbalance > 0) return { text: `+${(imbalance * 100).toFixed(0)}% buy`, cls: "buy" };
  return { text: "no whale flow", cls: "" };
}

/**
 * Movement in the crowd's beat probability across the recorded window, in
 * percentage points.
 *
 * This is the whole reason radar rows are worth storing. They all score 0, so
 * drift is the only thing that separates a market drifting down toward the
 * filter from one parked well above it. Falling is the interesting direction
 * on a short-side dashboard, hence the colour.
 */
export function describeDrift(rows: SignalRow[]): { text: string; cls: string } {
  if (rows.length < 2) return { text: "first reading", cls: "" };

  const delta = (rows[rows.length - 1].p_beat - rows[0].p_beat) * 100;
  if (Math.abs(delta) < 0.05) return { text: `flat, ${rows.length} obs`, cls: "" };

  const sign = delta < 0 ? "" : "+";
  return { text: `${sign}${delta.toFixed(1)} pts`, cls: delta < 0 ? "falling" : "rising" };
}

/**
 * Days until the market resolves. A book priced at 40% the day before it
 * settles is a different proposition from one priced at 40% three weeks out,
 * and the score cannot express that.
 */
export function describeResolution(iso: string | null, now: number): string {
  if (!iso) return "&mdash;";
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "&mdash;";

  // Whole days remaining, so anything inside the next 24 hours reads "today"
  // rather than rounding a few spare hours up into a full extra day.
  const days = Math.floor((at - now) / MS_PER_DAY);
  if (days < 0) return "passed";
  if (days === 0) return "today";
  return `${days}d`;
}

/**
 * Book size. Volume no longer gates discovery, so the card has to carry it -
 * otherwise a $10 market and a $900 one look equally credible.
 */
function describeVolume(volume: number | null): { text: string; cls: string } {
  if (volume === null || !Number.isFinite(volume)) return { text: "&mdash;", cls: "" };
  const text = volume >= 1000 ? `$${(volume / 1000).toFixed(1)}k` : `$${Math.round(volume)}`;
  return { text, cls: volume < VOLUME_ABSOLUTE_FLOOR ? "thin" : "" };
}

/**
 * The per-card status line. The section heading already states the tier, so
 * this carries what is specific to this card instead of repeating it.
 */
function describeStatus(series: TickerSeries): string {
  const { tier, latest } = series;
  if (tier === "conviction") return `Cleared score ${MIN_PUBLISH_SCORE}`;
  if (tier === "watchlist") return `Inside the filter &middot; below score ${MIN_PUBLISH_SCORE}`;
  const gap = (latest.p_beat - PEAD_FILTER_CEILING) * 100;
  return `${gap.toFixed(1)} pts above the ${FILTER_PCT}% filter`;
}

function canvasIdFor(ticker: string): string {
  return `chart-${ticker.replace(/[^A-Za-z0-9]/g, "")}`;
}

function renderCard(series: TickerSeries, now: number): string {
  const { ticker, latest, rows, tier } = series;
  const imbalance = describeImbalance(latest.imbalance);
  const drift = describeDrift(rows);
  const book = describeVolume(latest.volume);
  const price =
    latest.current_stock_price === null ? "&mdash;" : `$${latest.current_stock_price.toFixed(2)}`;
  const link = latest.pm_url
    ? `<a href="${escapeHtml(latest.pm_url)}" target="_blank" rel="noopener noreferrer">Polymarket</a>`
    : "";

  return `        <article class="card ${tier}">
          <div class="card-head">
            <span class="ticker">${escapeHtml(ticker)}</span>
            <span class="strength">${latest.strength}<span>/100</span></span>
          </div>
          <div class="tier">${describeStatus(series)}</div>
          <dl class="stats">
            <div class="stat"><dt>P(beat)</dt><dd>${(latest.p_beat * 100).toFixed(1)}%</dd></div>
            <div class="stat"><dt>Drift</dt><dd class="${drift.cls}">${drift.text}</dd></div>
            <div class="stat"><dt>Whale flow</dt><dd class="${imbalance.cls}">${imbalance.text}</dd></div>
            <div class="stat"><dt>Stock</dt><dd>${price}</dd></div>
            <div class="stat"><dt>Book</dt><dd class="${book.cls}">${book.text}</dd></div>
            <div class="stat"><dt>Resolves</dt><dd>${describeResolution(latest.resolution_date, now)}</dd></div>
          </dl>
          <div class="chart-box"><canvas id="${canvasIdFor(ticker)}" data-ticker="${escapeHtml(ticker)}"></canvas></div>
          <div class="card-foot">
            <span>${rows.length} observation${rows.length === 1 ? "" : "s"} &middot; ${formatTimestamp(latest.recorded_at)}</span>
            ${link}
          </div>
        </article>`;
}

function renderTierSection(tier: Tier, members: TickerSeries[], now: number): string {
  const { title, blurb } = TIER_HEADINGS[tier];
  return `      <section class="tier-group ${tier}-group">
        <h2 class="tier-heading">${title}<span class="tier-count">${members.length}</span></h2>
        <p class="tier-blurb">${blurb}</p>
        <div class="grid">
${members.map((s) => renderCard(s, now)).join("\n")}
        </div>
      </section>`;
}

/**
 * Only reachable when no earnings market is open anywhere. Selection now
 * floor-fills to MIN_TRACKED_MARKETS regardless of price, so a board that is
 * merely quiet produces radar cards rather than this.
 */
function renderEmptyState(): string {
  return `      <div class="empty">
        <h2>No earnings markets open</h2>
        <p>
          Polymarket is not currently listing any open earnings markets, so there is
          nothing to track at any tier. Listings reappear as the next reporting season
          approaches. The scheduled pass re-checks every 12 hours.
        </p>
      </div>`;
}

export function renderPage(rows: SignalRow[], now: number = Date.now()): string {
  const series = groupByTicker(rows);

  const chartData = series.map((s) => ({
    canvasId: canvasIdFor(s.ticker),
    labels: s.rows.map((r) => formatChartLabel(r.recorded_at)),
    pBeat: s.rows.map((r) => Number((r.p_beat * 100).toFixed(2))),
    strength: s.rows.map((r) => r.strength),
    price: s.rows.map((r) => r.current_stock_price),
  }));

  const sections = TIER_ORDER.map((tier) => ({
    tier,
    members: series.filter((s) => s.tier === tier),
  })).filter((group) => group.members.length > 0);

  const body =
    sections.length > 0
      ? sections.map((g) => renderTierSection(g.tier, g.members, now)).join("\n")
      : renderEmptyState();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PEAD Whale Signals</title>
<meta name="description" content="Conditional PEAD-short and whale order-flow imbalance signals from Polymarket earnings markets. Showcase only.">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap">
  <header>
    <h1>PEAD Whale Signals</h1>
    <p class="sub">
      Open Polymarket earnings markets where the crowd puts the probability of a beat at
      ${FILTER_PCT}% or less, ranked by signal strength, with large-trade order-flow
      imbalance as a conviction multiplier on top of that primary filter. Markets up to
      ${RADAR_PCT}% are tracked on the radar tier so their drift toward the filter is
      visible before they cross it. Charts cover the last ${HISTORY_WINDOW_DAYS} days.
    </p>
    <div class="header-foot">
      <span class="disclaimer">Showcase only &middot; not investment advice</span>
      <form class="refresh" id="refresh-form" method="post" action="/refresh">
        <button type="submit" id="refresh-btn">Refresh now</button>
        <span class="refresh-status" id="refresh-status" role="status" aria-live="polite"></span>
      </form>
    </div>
  </header>

  <main>
${body}
  </main>

  <footer>
    <p>
      Method follows Feng (2026), &ldquo;Minority Report: Contrarian Traders, Prediction
      Markets, and the Return of Post-Earnings Drift&rdquo;. Prediction-market data from
      Polymarket; equity prices from Alpaca (IEX). Machine-generated, unaudited, and
      published as a code sample. Raw data at <a href="/feed.json">/feed.json</a>.
    </p>
  </footer>
</div>

<script>
// Refresh button. Deliberately ahead of the Chart.js tag and independent of
// it, so a CDN failure cannot take the control with it.
(function () {
  var form = document.getElementById('refresh-form');
  var btn = document.getElementById('refresh-btn');
  var out = document.getElementById('refresh-status');
  if (!form || !btn || !out) return;

  // Without fetch, leave the form alone: the plain POST still works, and the
  // route answers a navigation with a redirect back to this page.
  if (!window.fetch) return;

  function say(text, cls) {
    out.textContent = text;
    out.className = 'refresh-status' + (cls ? ' ' + cls : '');
  }

  function wait(seconds) {
    if (seconds >= 60) {
      var m = Math.ceil(seconds / 60);
      return m + ' minute' + (m === 1 ? '' : 's');
    }
    return seconds + ' second' + (seconds === 1 ? '' : 's');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    btn.disabled = true;
    say('Scanning the board\\u2026');

    fetch('/refresh', { method: 'POST', headers: { accept: 'application/json' } })
      .then(function (res) {
        // An unhandled failure returns text/plain, so the body is read as text
        // first and only then parsed - res.json() would throw on it.
        return res.text().then(function (raw) {
          var body = null;
          try { body = JSON.parse(raw); } catch (err) {}
          return { status: res.status, body: body };
        });
      })
      .then(function (r) {
        if (r.status === 429 && r.body) {
          say('Just refreshed. Try again in ' + wait(r.body.retry_after_seconds) + '.');
          btn.disabled = false;
          return;
        }
        if (r.status !== 200 || !r.body) {
          say('Refresh failed (HTTP ' + r.status + ').', 'error');
          btn.disabled = false;
          return;
        }
        say('Recorded ' + r.body.recorded + ' of ' + r.body.discovered +
            ' open markets. Reloading\\u2026', 'ok');
        window.setTimeout(function () { window.location.reload(); }, 800);
      })
      .catch(function (err) {
        say('Refresh failed. ' + err.message, 'error');
        btn.disabled = false;
      });
  });
})();
</script>

<script src="${CHART_JS_CDN}"></script>
<script>
(function () {
  var series = ${embedJson(chartData)};
  if (!window.Chart || !series.length) return;

  Chart.defaults.color = '#8d9bb5';
  Chart.defaults.font.size = 11;

  series.forEach(function (s) {
    var canvas = document.getElementById(s.canvasId);
    if (!canvas) return;

    var datasets = [
      {
        label: 'P(beat) %',
        data: s.pBeat,
        yAxisID: 'yPct',
        borderColor: '#4aa8ff',
        backgroundColor: '#4aa8ff',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 2
      },
      {
        label: 'Strength',
        data: s.strength,
        yAxisID: 'yPct',
        borderColor: '#ff5c72',
        backgroundColor: '#ff5c72',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 2
      }
    ];

    // Only plot the price series, and its axis, when Alpaca returned data for
    // this particular ticker. Decided per chart, not per page.
    var hasPrice = s.price.some(function (p) { return p !== null; });
    if (hasPrice) {
      datasets.push({
        label: 'Stock $',
        data: s.price,
        yAxisID: 'yPrice',
        borderColor: '#f0b429',
        backgroundColor: '#f0b429',
        borderWidth: 2,
        borderDash: [4, 3],
        tension: 0.25,
        pointRadius: 2,
        spanGaps: true
      });
    }

    new Chart(canvas, {
      type: 'line',
      data: { labels: s.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: { backgroundColor: '#1a2130', borderColor: '#232c3d', borderWidth: 1 }
        },
        scales: {
          x: { grid: { color: '#1c2333' }, ticks: { maxTicksLimit: 5 } },
          // P(beat) is plotted as a percentage so it shares the 0-100 axis
          // with strength; price gets its own axis on the right.
          yPct: {
            position: 'left',
            min: 0,
            max: 100,
            grid: { color: '#1c2333' },
            title: { display: true, text: '% / score' }
          },
          yPrice: {
            position: 'right',
            display: hasPrice,
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'USD' }
          }
        }
      }
    });
  });
})();
</script>
</body>
</html>
`;
}
