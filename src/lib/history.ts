// ---------------------------------------------------------------------------
// Browsing-history recall — "find the page I opened yesterday." Aside turns
// browsing history into memory; because we own the persistent Chrome profile,
// its history is a local SQLite DB we can query directly (node:sqlite, Node 22+).
// We read a COPY so we never touch/corrupt the live DB, and convert Chrome's
// 1601-epoch microsecond timestamps to normal dates.
// ---------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { PROFILES_DIR } from "./paths.js";

const require = createRequire(import.meta.url);

export interface HistoryHit {
  url: string;
  title: string;
  visitCount: number;
  lastVisited: string;
}

function historyDbPath(profile: string): string | null {
  const base = join(PROFILES_DIR, profile);
  for (const candidate of [join(base, "Default", "History"), join(base, "History")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Chrome time = microseconds since 1601-01-01; Unix ms = t/1000 - 11644473600000.
function chromeTimeToIso(t: number): string {
  if (!t) return "";
  return new Date(t / 1000 - 11_644_473_600_000).toISOString();
}

export function searchHistory(opts: { profile?: string; query?: string; sinceDays?: number; limit?: number }): HistoryHit[] {
  const profile = opts.profile ?? "default";
  const dbPath = historyDbPath(profile);
  if (!dbPath) {
    throw new Error(
      `No browsing history for profile "${profile}" yet (visit some sites via session_start/login_mode first).`,
    );
  }

  let DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
    prepare(sql: string): { all(...params: unknown[]): unknown[]; setReadBigInts(v: boolean): void };
    close(): void;
  };
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("Browsing-history recall needs Node's built-in node:sqlite (Node 22.5+). Upgrade Node, or read history from Chrome directly.");
  }

  // Copy the DB (Chrome may hold a write lock on the original).
  const tmp = join(mkdtempSync(join(tmpdir(), "vzt-hist-")), "History");
  copyFileSync(dbPath, tmp);

  const db = new DatabaseSync(tmp, { readOnly: true });
  try {
    const limit = Math.min(opts.limit ?? 50, 500);
    // Chrome timestamps are 1601-epoch microseconds — far past JS safe-integer,
    // so read integer columns as BigInt and bind the `since` bound as BigInt too.
    const since = opts.sinceDays
      ? BigInt(Math.trunc((Date.now() + 11_644_473_600_000 - opts.sinceDays * 86_400_000) * 1000))
      : 0n;
    const like = opts.query ? `%${opts.query}%` : "%";
    const stmt = db.prepare(
      `SELECT url, title, visit_count AS visitCount, last_visit_time AS t
         FROM urls
        WHERE (url LIKE ? OR title LIKE ?) AND last_visit_time >= ?
     ORDER BY last_visit_time DESC
        LIMIT ?`,
    );
    stmt.setReadBigInts(true);
    const rows = stmt.all(like, like, since, BigInt(limit)) as Array<{ url: string; title: string; visitCount: bigint; t: bigint }>;
    return rows.map((r) => ({
      url: r.url,
      title: r.title ?? "",
      visitCount: Number(r.visitCount),
      lastVisited: chromeTimeToIso(Number(r.t)),
    }));
  } finally {
    db.close();
  }
}
