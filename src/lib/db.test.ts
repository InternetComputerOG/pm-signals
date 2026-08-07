import { describe, expect, it } from "vitest";

import { REFRESH_COOLDOWN_MINUTES } from "./config";
import { cooldownRemainingSeconds, toIso } from "./db";

const NOW = Date.parse("2026-08-07T20:00:00Z");
const MINUTE = 60_000;

describe("toIso", () => {
  it("converts SQLite's UTC format to ISO-8601", () => {
    expect(toIso("2026-08-07 18:52:43")).toBe("2026-08-07T18:52:43Z");
  });

  it("leaves an already-ISO value alone", () => {
    expect(toIso("2026-08-07T18:52:43Z")).toBe("2026-08-07T18:52:43Z");
  });

  it("passes an empty value straight through", () => {
    expect(toIso("")).toBe("");
  });
});

describe("cooldownRemainingSeconds", () => {
  it("permits a run on an empty table", () => {
    // The fresh-deploy case, and the whole reason the endpoint exists. A null
    // must never be read as "just ran".
    expect(cooldownRemainingSeconds(null, NOW, 10)).toBe(0);
  });

  it("permits a run once the window has fully elapsed", () => {
    const tenMinutesAgo = new Date(NOW - 10 * MINUTE).toISOString();
    expect(cooldownRemainingSeconds(tenMinutesAgo, NOW, 10)).toBe(0);
  });

  it("permits a run long after the window", () => {
    expect(cooldownRemainingSeconds("2026-08-01 00:00:00", NOW, 10)).toBe(0);
  });

  it("reports the seconds left partway through the window", () => {
    const fourMinutesAgo = new Date(NOW - 4 * MINUTE).toISOString();
    expect(cooldownRemainingSeconds(fourMinutesAgo, NOW, 10)).toBe(360);
  });

  it("reports the full window for a run that just happened", () => {
    expect(cooldownRemainingSeconds("2026-08-07 20:00:00", NOW, 10)).toBe(600);
  });

  it("reads SQLite's space-separated format as UTC, not local time", () => {
    // recorded_at is written by SQLite's datetime('now'), so it has no zone
    // marker. Parsing it as local time would shift the cooldown by the host's
    // offset and, west of UTC, make every fresh row look hours old.
    expect(cooldownRemainingSeconds("2026-08-07 19:56:00", NOW, 10)).toBe(360);
  });

  it("caps a future timestamp at the window rather than extrapolating", () => {
    const skewed = new Date(NOW + 60 * MINUTE).toISOString();
    expect(cooldownRemainingSeconds(skewed, NOW, 10)).toBe(600);
  });

  it("fails open on an unparseable timestamp", () => {
    // A bad value must not be able to wedge the endpoint shut permanently.
    expect(cooldownRemainingSeconds("not a timestamp", NOW, 10)).toBe(0);
  });

  it("treats a zero-minute cooldown as disabled", () => {
    expect(cooldownRemainingSeconds("2026-08-07 20:00:00", NOW, 0)).toBe(0);
  });

  it("blocks a second refresh at the configured cooldown", () => {
    // Guards the shipped value against being set to something that makes the
    // endpoint either useless or unprotected.
    const justNow = new Date(NOW).toISOString();
    expect(cooldownRemainingSeconds(justNow, NOW, REFRESH_COOLDOWN_MINUTES)).toBeGreaterThan(0);
    const afterWindow = NOW + REFRESH_COOLDOWN_MINUTES * MINUTE;
    expect(cooldownRemainingSeconds(justNow, afterWindow, REFRESH_COOLDOWN_MINUTES)).toBe(0);
  });
});
