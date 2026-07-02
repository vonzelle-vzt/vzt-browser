// ---------------------------------------------------------------------------
// Passive capture — console messages, network responses, and downloads for the
// current session. This is the raw material for browser *evidence*: the log
// links (network URLs + statuses), console errors, and downloaded files a
// reviewer needs. Attached to every page/tab automatically; ring-buffered so a
// long session can't grow unbounded. Resets when the session changes.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import type { BrowserContext, Download, Page } from "playwright-core";
import { ensureDir } from "./paths.js";

export interface ConsoleEntry {
  type: string;
  text: string;
  url?: string;
  ts: string;
}
export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  ok: boolean;
  ts: string;
}
export interface DownloadEntry {
  url: string;
  filename: string;
  path: string;
  ts: string;
}

const CAP = 800;
let consoleLog: ConsoleEntry[] = [];
let networkLog: NetworkEntry[] = [];
let downloads: DownloadEntry[] = [];
let capSessionDir: string | null = null;
const attached = new WeakSet<Page>();

function ringPush<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > CAP) arr.shift();
}

/** Called by session.ts on launch so capture is self-contained (no circular import). */
export function setCaptureSession(sessionDir: string): void {
  capSessionDir = sessionDir;
  consoleLog = [];
  networkLog = [];
  downloads = [];
}

export function attachCapture(page: Page): void {
  if (attached.has(page)) return;
  attached.add(page);

  page.on("console", (msg) => {
    ringPush(consoleLog, {
      type: msg.type(),
      text: msg.text().slice(0, 2000),
      url: msg.location()?.url,
      ts: new Date().toISOString(),
    });
  });
  page.on("pageerror", (err) => {
    ringPush(consoleLog, { type: "error", text: String(err?.message ?? err).slice(0, 2000), ts: new Date().toISOString() });
  });
  page.on("response", (res) => {
    ringPush(networkLog, {
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
      ok: res.ok(),
      ts: new Date().toISOString(),
    });
  });
  page.on("download", (dl: Download) => {
    void saveDownload(dl);
  });
}

async function saveDownload(dl: Download): Promise<void> {
  if (!capSessionDir) return;
  const dir = ensureDir(join(capSessionDir, "downloads"));
  const filename = dl.suggestedFilename() || `download-${Date.now()}`;
  const path = join(dir, filename);
  try {
    await dl.saveAs(path);
    ringPush(downloads, { url: dl.url(), filename, path, ts: new Date().toISOString() });
  } catch {
    // download failed / cancelled — ignore
  }
}

/** Attach capture to the initial page and any tab opened later. */
export function attachContextCapture(context: BrowserContext): void {
  for (const p of context.pages()) attachCapture(p);
  context.on("page", (p) => attachCapture(p));
}

export function getConsole(filter?: { errorsOnly?: boolean; match?: string }): ConsoleEntry[] {
  let out = consoleLog;
  if (filter?.errorsOnly) out = out.filter((e) => e.type === "error" || e.type === "warning");
  if (filter?.match) out = out.filter((e) => e.text.includes(filter.match as string));
  return out;
}

export function getNetwork(filter?: { failuresOnly?: boolean; match?: string }): NetworkEntry[] {
  let out = networkLog;
  if (filter?.failuresOnly) out = out.filter((e) => !e.ok || e.status >= 400);
  if (filter?.match) out = out.filter((e) => e.url.includes(filter.match as string));
  return out;
}

export function getDownloads(): DownloadEntry[] {
  return downloads;
}
