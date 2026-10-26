// ---------------------------------------------------------------------------
// VZT-Browser data layout — everything lives under ~/.vzt/browser/ so the
// tool works identically inside the monorepo and as a standalone npm install.
//
//   ~/.vzt/browser/
//     profiles/<name>/        persistent Chrome user-data dirs (logged-in state)
//     profiles/<name>.lock    PID lockfile while a session owns the profile
//     memory/<domain>.md      per-domain site memory ("Dreaming")
//     tasks/<slug>.json       recorded, replayable tasks
//     sessions/<id>/          screenshot trail + actions.jsonl per session
//     vault-index.json        credential NAMES + notes (never secret values)
//     vault-domains.json      credential -> domains it has been filled on
//     audit.log               JSONL audit trail (vault access, approvals)
//     config.json             user config (alwaysAskDomains, etc.)
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const ROOT_DIR = process.env.VZT_BROWSER_HOME || join(homedir(), ".vzt", "browser");
export const PROFILES_DIR = join(ROOT_DIR, "profiles");
export const MEMORY_DIR = join(ROOT_DIR, "memory");
export const TASKS_DIR = join(ROOT_DIR, "tasks");
export const SESSIONS_DIR = join(ROOT_DIR, "sessions");
export const AUDIT_LOG = join(ROOT_DIR, "audit.log");
const CONFIG_FILE = join(ROOT_DIR, "config.json");
export const VAULT_INDEX = join(ROOT_DIR, "vault-index.json");
export const VAULT_DOMAINS = join(ROOT_DIR, "vault-domains.json");

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

interface VztBrowserConfig {
  /** Domains where every mutating action requires approval. */
  alwaysAskDomains: string[];
  /** Extra sensitive keywords merged into the built-in lists. */
  sensitiveKeywords: string[];
}

export function loadConfig(): VztBrowserConfig {
  const defaults: VztBrowserConfig = { alwaysAskDomains: [], sensitiveKeywords: [] };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    return { ...defaults, ...(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<VztBrowserConfig>) };
  } catch {
    return defaults;
  }
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  ensureDir(ROOT_DIR);
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
