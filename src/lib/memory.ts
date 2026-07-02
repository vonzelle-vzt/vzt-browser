// ---------------------------------------------------------------------------
// Site memory ("Dreaming") — plain markdown per eTLD+1 domain under
// ~/.vzt/browser/memory/<domain>.md. Written by the MCP client model via
// save_site_memory; auto-injected into session_start / navigate results so
// the agent never re-learns a site from scratch.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR, ensureDir } from "./paths.js";

const INJECT_LIMIT = 4096;

// Minimal two-level public-suffix handling — enough for the common cases.
const TWO_LEVEL_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "co.in", "com.br", "com.mx", "co.nz", "co.za", "com.sg",
]);

/** Reduce a hostname to its registrable domain (eTLD+1). */
export function domainKey(hostnameOrUrl: string): string {
  let host = hostnameOrUrl;
  try {
    if (hostnameOrUrl.includes("://")) host = new URL(hostnameOrUrl).hostname;
  } catch {
    // treat as bare hostname
  }
  const parts = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_LEVEL_TLDS.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function memoryPath(domain: string): string {
  const safe = domain.replace(/[^a-z0-9.-]/g, "_");
  return join(MEMORY_DIR, `${safe}.md`);
}

export function readSiteMemory(domainOrUrl: string): string | null {
  const p = memoryPath(domainKey(domainOrUrl));
  if (!existsSync(p)) return null;
  const content = readFileSync(p, "utf-8");
  return content.length > INJECT_LIMIT
    ? content.slice(0, INJECT_LIMIT) + "\n\n[...truncated — full file at " + p + "]"
    : content;
}

export function writeSiteMemory(domainOrUrl: string, content: string, mode: "replace" | "append"): string {
  ensureDir(MEMORY_DIR);
  const domain = domainKey(domainOrUrl);
  const p = memoryPath(domain);
  const stamped = content.trimEnd() + "\n";
  if (mode === "append" && existsSync(p)) {
    appendFileSync(p, "\n" + stamped, "utf-8");
  } else {
    writeFileSync(p, `# ${domain}\n\n${stamped}`.replace(/^# .*\n\n# /, "# "), "utf-8");
  }
  return p;
}

export function listSiteMemories(): Array<{ domain: string; path: string; bytes: number }> {
  ensureDir(MEMORY_DIR);
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const p = join(MEMORY_DIR, f);
      return { domain: f.replace(/\.md$/, ""), path: p, bytes: readFileSync(p, "utf-8").length };
    });
}

export function deleteSiteMemory(domain: string): boolean {
  const p = memoryPath(domainKey(domain));
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

// --- Dreaming: cross-task workspace memory ---------------------------------
// Not tied to a domain — the people, companies, and decisions that matter, so
// the agent continues from past work instead of starting cold. Auto-injected
// at session_start. Plain markdown on disk; inspect/edit it directly.

const WORKSPACE_MEMORY = join(MEMORY_DIR, "_workspace.md");

export function readWorkspaceMemory(): string | null {
  if (!existsSync(WORKSPACE_MEMORY)) return null;
  const content = readFileSync(WORKSPACE_MEMORY, "utf-8");
  return content.length > INJECT_LIMIT ? content.slice(0, INJECT_LIMIT) + "\n[...truncated]" : content;
}

/** Append a "dreamed" fact (person/company/decision/task) with its source. */
export function remember(fact: string, source?: string): string {
  ensureDir(MEMORY_DIR);
  const stamp = new Date().toISOString().slice(0, 10);
  const line = `- ${fact}${source ? ` _(source: ${source})_` : ""} _[${stamp}]_\n`;
  if (existsSync(WORKSPACE_MEMORY)) appendFileSync(WORKSPACE_MEMORY, line, "utf-8");
  else writeFileSync(WORKSPACE_MEMORY, `# Workspace memory\n\nPeople, companies, decisions, and task context that carry across sessions.\n\n${line}`, "utf-8");
  return WORKSPACE_MEMORY;
}

export function workspaceMemoryPath(): string {
  return WORKSPACE_MEMORY;
}
