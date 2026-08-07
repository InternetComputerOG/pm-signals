/**
 * Server-rendered landing page. No framework, no build step, no client-side
 * data fetching - the chart series are serialised straight into the document,
 * so the page paints complete in a single round trip.
 */

import { HISTORY_WINDOW_DAYS, MIN_PUBLISH_SCORE } from "./config";
import { toIso, type SignalRow } from "./db";

const CHART_JS_CDN = "https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js";

export interface TickerSeries {
  ticker: string;
  latest: SignalRow;
  rows: SignalRow[];
}

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
 * Active signals are, per spec, any ticker with at least one record inside the
 * window. Rows arrive oldest-first, so the last one is the latest.
 */
export function groupByTicker(rows: SignalRow[]): TickerSeries[] {
  const byTicker = new Map<string, SignalRow[]>();
  for (const row of rows) {
    const existing = byTicker.get(row.ticker);
    if (existing) existing.push(row);
    else byTicker.set(row.ticker, [row]);
  }

  return [...byTicker.entries()]
    .map(([ticker, tickerRows]) => ({
      ticker,
      rows: tickerRows,
      latest: tickerRows[tickerRows.length - 1],
    }))
    .sort((a, b) => b.latest.strength - a.latest.strength);
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

function renderCard(series: TickerSeries): string {
  const { ticker, latest, rows } = series;
  const isConviction = latest.strength >= MIN_PUBLISH_SCORE;
  const tier = isConviction ? "conviction" : "watchlist";
  const tierLabel = isConviction
    ? `Conviction &middot; cleared score ${MIN_PUBLISH_SCORE}`
    : `Watchlist &middot; below score ${MIN_PUBLISH_SCORE}`;
  const imbalance = describeImbalance(latest.imbalance);
  const price =
    latest.current_stock_price === null ? "&mdash;" : `$${latest.current_stock_price.toFixed(2)}`;
  const canvasId = `chart-${ticker.replace(/[^A-Za-z0-9]/g, "")}`;
  const link = latest.pm_url
    ? `<a href="${escapeHtml(latest.pm_url)}" target="_blank" rel="noopener noreferrer">Polymarket</a>`
    : "";

  return `      <article class="card ${tier}">
        <div class="card-head">
          <span class="ticker">${escapeHtml(ticker)}</span>
          <span class="strength">${latest.strength}<span>/100</span></span>
        </div>
        <div class="tier">${tierLabel}</div>
        <dl class="stats">
          <div class="stat"><dt>P(beat)</dt><dd>${(latest.p_beat * 100).toFixed(1)}%</dd></div>
          <div class="stat"><dt>Whale flow</dt><dd class="${imbalance.cls}">${imbalance.text}</dd></div>
          <div class="stat"><dt>Stock</dt><dd>${price}</dd></div>
        </dl>
        <div class="chart-box"><canvas id="${canvasId}" data-ticker="${escapeHtml(ticker)}"></canvas></div>
        <div class="card-foot">
          <span>${rows.length} observation${rows.length === 1 ? "" : "s"} &middot; ${formatTimestamp(latest.recorded_at)}</span>
          ${link}
        </div>
      </article>`;
}

function renderEmptyState(): string {
  return `      <div class="empty">
        <h2>No active signals right now</h2>
        <p>
          No open Polymarket earnings market currently clears the primary filter of
          P(beat) &le; 0.30 together with the volume gate. Liquidity on these markets
          concentrates in the few days before each resolution date, so the board
          repopulates as earnings approach. The scheduled pass re-checks every 12 hours.
        </p>
      </div>`;
}

export function renderPage(rows: SignalRow[]): string {
  const series = groupByTicker(rows);

  const chartData = series.map((s) => ({
    canvasId: `chart-${s.ticker.replace(/[^A-Za-z0-9]/g, "")}`,
    labels: s.rows.map((r) => formatChartLabel(r.recorded_at)),
    pBeat: s.rows.map((r) => Number((r.p_beat * 100).toFixed(2))),
    strength: s.rows.map((r) => r.strength),
    price: s.rows.map((r) => r.current_stock_price),
  }));

  const body = series.length > 0 ? series.map(renderCard).join("\n") : renderEmptyState();

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
      30% or less, ranked by signal strength. Large-trade order-flow imbalance acts as a
      conviction multiplier on top of that primary filter. Charts cover the last
      ${HISTORY_WINDOW_DAYS} days.
    </p>
    <span class="disclaimer">Showcase only &middot; not investment advice</span>
  </header>

  <main class="grid">
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
