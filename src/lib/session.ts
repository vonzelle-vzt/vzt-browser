// ---------------------------------------------------------------------------
// Persistent-profile session lifecycle.
//
// Unlike mcp-scraper's fresh stealth contexts, VZT-Browser launches a
// *persistent* Chrome profile (launchPersistentContext) so logins survive
// across sessions — the Aside model. No fingerprint randomization: a
// logged-in profile must look consistent to the sites it's logged into.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { PROFILES_DIR, SESSIONS_DIR, ensureDir } from "./paths.js";
import { attachContextCapture, setCaptureSession } from "./capture.js";

interface SessionState {
  context: BrowserContext;
  page: Page;
  sessionId: string;
  profile: string;
  headed: boolean;
  /** Evidence mode — blocks every page mutation (fill/select) and gates all clicks. */
  readOnly: boolean;
  sessionDir: string;
  startedAt: string;
}

let session: SessionState | null = null;
let launching: Promise<SessionState> | null = null;

function lockPath(profile: string): string {
  return join(PROFILES_DIR, `${profile}.lock`);
}

function acquireLock(profile: string): void {
  ensureDir(PROFILES_DIR);
  const p = lockPath(profile);
  if (existsSync(p)) {
    try {
      const { pid } = JSON.parse(readFileSync(p, "utf-8")) as { pid: number };
      process.kill(pid, 0); // throws if not alive
      if (pid !== process.pid) {
        throw new Error(
          `Profile "${profile}" is locked by a live process (pid ${pid}). ` +
            `Close that session first, or delete ${p} if you're sure it's stale.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("is locked by")) throw err;
      // ESRCH etc. — stale lock, steal it.
    }
  }
  writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");
}

function releaseLock(profile: string): void {
  try {
    rmSync(lockPath(profile), { force: true });
  } catch {
    // best-effort
  }
}

function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

interface StartOptions {
  profile?: string;
  headed?: boolean;
  video?: boolean;
  readOnly?: boolean;
}

async function launch(opts: StartOptions): Promise<SessionState> {
  const profile = opts.profile ?? "default";
  const headed = opts.headed ?? false;
  acquireLock(profile);

  const profileDir = ensureDir(join(PROFILES_DIR, profile));
  const sessionId = newSessionId();
  const sessionDir = ensureDir(join(SESSIONS_DIR, sessionId));

  const { chromium } = await import("playwright-core");
  const baseOptions = {
    headless: !headed,
    viewport: headed ? null : { width: 1440, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreHTTPSErrors: false,
    ...(opts.video ? { recordVideo: { dir: sessionDir } } : {}),
  };

  let context: BrowserContext;
  try {
    // System Chrome first — best compatibility with Google-family logins.
    context = await chromium.launchPersistentContext(profileDir, { ...baseOptions, channel: "chrome" });
  } catch {
    // Fall back to a custom binary or Playwright's bundled Chromium.
    context = await chromium.launchPersistentContext(profileDir, {
      ...baseOptions,
      executablePath: process.env.CHROMIUM_PATH || undefined,
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  setCaptureSession(sessionDir);
  attachContextCapture(context);
  const state: SessionState = {
    context,
    page,
    sessionId,
    profile,
    headed,
    readOnly: opts.readOnly ?? String(process.env.VZT_BROWSER_READONLY).toLowerCase() === "true",
    sessionDir,
    startedAt: new Date().toISOString(),
  };

  context.on("close", () => {
    if (session?.sessionId === sessionId) {
      releaseLock(profile);
      session = null;
    }
  });

  session = state;
  return state;
}

/** Start (or return the already-running) session. */
export async function startSession(opts: StartOptions = {}): Promise<SessionState> {
  if (session) return session;
  if (!launching) {
    launching = launch(opts)
      .then((s) => {
        launching = null;
        return s;
      })
      .catch((err) => {
        launching = null;
        throw err;
      });
  }
  return launching;
}

export function getSession(): SessionState {
  if (!session) {
    throw new Error("No browser session. Call session_start first (or login_mode to log into sites).");
  }
  return session;
}

export function currentSession(): SessionState | null {
  return session;
}

/** Active page — follows the most recently opened page in the context. */
export function getPage(): Page {
  const s = getSession();
  const pages = s.context.pages();
  const last = pages[pages.length - 1];
  if (last && !last.isClosed()) s.page = last;
  if (s.page.isClosed()) {
    const open = pages.find((p) => !p.isClosed());
    if (!open) throw new Error("All pages are closed. Call navigate to open one.");
    s.page = open;
  }
  return s.page;
}

export async function stopSession(): Promise<{ sessionId: string; sessionDir: string } | null> {
  if (!session) return null;
  const { context, profile, sessionId, sessionDir } = session;
  session = null;
  await context.close().catch(() => {});
  releaseLock(profile);
  return { sessionId, sessionDir };
}

process.on("exit", () => {
  if (session) releaseLock(session.profile);
});
