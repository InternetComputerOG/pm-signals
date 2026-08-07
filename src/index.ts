/**
 * PEAD Whale Signals - a single Cloudflare Worker that both serves the public
 * feed and runs the 12-hourly discovery pass.
 *
 * Showcase only. This is not a trading system and produces no advice.
 */

import { Hono } from "hono";

import { HISTORY_WINDOW_DAYS, REFRESH_COOLDOWN_MINUTES } from "./lib/config";
import { cooldownRemainingSeconds, getHistory, latestRecordedAt, toIso } from "./lib/db";
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

/**
 * Run the discovery pass on demand, so a fresh deployment does not sit empty
 * until the next cron. The cron fires twice a day, so without this the page
 * can show nothing for up to 12 hours after a deploy - which is exactly what
 * happened on the v2.2 rollout.
 *
 * Responds with the RunSummary, so the caller learns what happened without
 * having to go and read logs.
 *
 * POST, not GET, because it has side effects. A GET would eventually be fired
 * by a prefetcher, uptime monitor or crawler, and each firing is a full pass.
 *
 * Unauthenticated on purpose: this is a public showcase and there is no secret
 * worth managing. The cooldown is the safeguard that matters, since the real
 * risk is not disclosure but cost - a pass spends ~37 subrequests against a
 * finite daily allowance, so an unbounded refresh is the one thing a visitor
 * could use to break the free tier.
 */
app.post("/refresh", async (c) => {
  // The page's button is a real <form>, so it still posts when its script does
  // not run. A navigation wants a page back rather than a JSON body; the
  // fetch() path sends `accept: application/json`, so this only catches the
  // no-JS case. 303 so the reload is a GET and the post is not resubmittable.
  const wantsHtml = c.req.header("accept")?.includes("text/html") ?? false;

  const latest = await latestRecordedAt(c.env.DB);
  const retryAfter = cooldownRemainingSeconds(latest, Date.now(), REFRESH_COOLDOWN_MINUTES);

  if (retryAfter > 0) {
    if (wantsHtml) return c.redirect("/", 303);
    c.header("Retry-After", String(retryAfter));
    return c.json(
      {
        status: "cooldown",
        retry_after_seconds: retryAfter,
        last_recorded_at: latest ? toIso(latest) : null,
      },
      429,
    );
  }

  const summary = await runDiscoveryPass(c.env);
  if (wantsHtml) return c.redirect("/", 303);
  return c.json({ status: "ok", ...summary });
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
