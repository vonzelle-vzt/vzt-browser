// ---------------------------------------------------------------------------
// Monitor a page until a condition holds (or a deadline passes), then hand
// back so the caller can collect evidence — the "watch Datadog / rollout
// dashboard and wake me when the signal changes" job. Read-only: it only
// reads page text / a selector on an interval. For true recurring Routines,
// an MCP client wires this (or replay_task) to its scheduler; here we do the
// bounded in-session watch.
// ---------------------------------------------------------------------------

import type { Page } from "playwright-core";

export interface MonitorResult {
  triggered: boolean;
  reason: string;
  checks: number;
  elapsedMs: number;
  lastValue: string;
  url: string;
}

export async function monitorPage(
  page: Page,
  opts: {
    url?: string;
    everyMs?: number;
    forMs?: number;
    /** Trigger when this text APPEARS anywhere on the page. */
    textAppears?: string;
    /** Trigger when the text content of this selector CHANGES from its first reading. */
    selectorChanges?: string;
    /** Trigger when a number scraped from this selector crosses a threshold. */
    numberSelector?: string;
    above?: number;
    below?: number;
  },
): Promise<MonitorResult> {
  const everyMs = Math.max(2_000, opts.everyMs ?? 30_000);
  const forMs = Math.min(opts.forMs ?? 15 * 60_000, 60 * 60_000);
  if (opts.url) await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 45_000 });

  const start = Date.now();
  let checks = 0;
  let baseline: string | null = null;
  let lastValue = "";

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (Date.now() - start < forMs) {
    checks += 1;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    if (opts.textAppears) {
      const found = await page.getByText(opts.textAppears).first().isVisible().catch(() => false);
      lastValue = String(found);
      if (found) return done(true, `text "${opts.textAppears}" appeared`);
    }
    if (opts.selectorChanges) {
      const v = (await page.locator(opts.selectorChanges).first().textContent().catch(() => "")) ?? "";
      lastValue = v.trim().slice(0, 200);
      if (baseline === null) baseline = lastValue;
      else if (lastValue !== baseline) return done(true, `"${opts.selectorChanges}" changed from "${baseline}" to "${lastValue}"`);
    }
    if (opts.numberSelector) {
      const raw = (await page.locator(opts.numberSelector).first().textContent().catch(() => "")) ?? "";
      const num = parseFloat(raw.replace(/[^0-9.-]/g, ""));
      lastValue = String(num);
      if (!Number.isNaN(num)) {
        if (opts.above !== undefined && num > opts.above) return done(true, `${num} > ${opts.above}`);
        if (opts.below !== undefined && num < opts.below) return done(true, `${num} < ${opts.below}`);
      }
    }
    await sleep(everyMs);
  }
  return done(false, `no trigger within ${Math.round(forMs / 1000)}s`);

  function done(triggered: boolean, reason: string): MonitorResult {
    return { triggered, reason, checks, elapsedMs: Date.now() - start, lastValue, url: page.url() };
  }
}
