/**
 * PEAD Whale Signals - a single Cloudflare Worker that both serves the public
 * feed and runs the 12-hourly discovery pass.
 *
 * Showcase only. This is not a trading system and produces no advice.
 */

import { Hono } from "hono";

import { HISTORY_WINDOW_DAYS } from "./lib/config";
import { getHistory, toIso } from "./lib/db";
import { runDiscoveryPass, type Env } from "./lib/pipeline";
import { renderPage } from "./lib/render";

const app = new Hono<{ Bindings: Env }>();

/** Landing page: one card per active ticker, strongest first. */
app.get("/", async (c) => {
  const rows = await getHistory(c.env.DB, HISTORY_WINDOW_DAYS);
  return c.html(renderPage(rows));
});

/**
 * The same rolling window as the page, as plain JSON, for programmatic
 * consumers. Timestamps are converted from SQLite's format to ISO-8601 here.
 */
app.get("/feed.json", async (c) => {
  const rows = await getHistory(c.env.DB, HISTORY_WINDOW_DAYS);
  return c.json(rows.map((row) => ({ ...row, recorded_at: toIso(row.recorded_at) })));
});

app.onError((err, c) => {
  console.error("request failed", err);
  return c.text("Internal error", 500);
});

export default {
  fetch: app.fetch,

  /**
   * Cron entry point (every 12 hours). Awaited rather than handed to
   * waitUntil so that a failure surfaces as a failed scheduled invocation
   * instead of disappearing.
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runDiscoveryPass(env);
  },
} satisfies ExportedHandler<Env>;
