// ---------------------------------------------------------------------------
// Schema-first evidence tables + drift. The research workflow Aside advertises:
// tell it the fields you need BEFORE browsing, capture sources (screenshot +
// extracted row), and on re-runs compare the new table against last time to
// surface changed/missing/new claims (the "Friday drift report").
//
// Division of labour: VZT-Browser navigates read-only, screenshots, and
// persists/diffs the table; the MCP client model does the actual extraction
// (reads the captured page, fills the schema fields, sets the status). No
// server-side LLM key needed.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, ROOT_DIR } from "./paths.js";

const TABLES_DIR = join(ROOT_DIR, "research");

/** The Aside default evidence schema — enough for a useful first pass. */
export const DEFAULT_FIELDS = ["claim", "sourceUrl", "publisher", "dateAccessed", "screenshot", "status", "oldClaim"];

type Row = Record<string, string>;

interface EvidenceTable {
  name: string;
  fields: string[];
  /** Field used to match rows across runs for drift (default "sourceUrl"). */
  keyField: string;
  /** Field whose change counts as a "changed claim" (default "claim"). */
  valueField: string;
  sources: Array<{ url: string; label?: string }>;
  exclusions: string[];
  rows: Row[];
  /** Snapshot of rows from the previous run, for drift comparison. */
  baseline: Row[];
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

function pathFor(name: string): string {
  return join(TABLES_DIR, `${name.replace(/[^a-z0-9._-]/gi, "_")}.json`);
}

export function defineTable(input: {
  name: string;
  fields?: string[];
  keyField?: string;
  valueField?: string;
  sources?: Array<{ url: string; label?: string }>;
  exclusions?: string[];
}): EvidenceTable {
  ensureDir(TABLES_DIR);
  const existing = getTable(input.name);
  const now = new Date().toISOString();
  const table: EvidenceTable = {
    name: input.name,
    fields: input.fields ?? existing?.fields ?? DEFAULT_FIELDS,
    keyField: input.keyField ?? existing?.keyField ?? "sourceUrl",
    valueField: input.valueField ?? existing?.valueField ?? "claim",
    sources: input.sources ?? existing?.sources ?? [],
    exclusions: input.exclusions ?? existing?.exclusions ?? [],
    rows: existing?.rows ?? [],
    baseline: existing?.baseline ?? [],
    runCount: existing?.runCount ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  write(table);
  return table;
}

export function getTable(name: string): EvidenceTable | null {
  const p = pathFor(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as EvidenceTable;
  } catch {
    return null;
  }
}

export function listTables(): Array<{ name: string; rows: number; runCount: number; updatedAt: string }> {
  ensureDir(TABLES_DIR);
  return readdirSync(TABLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const t = JSON.parse(readFileSync(join(TABLES_DIR, f), "utf-8")) as EvidenceTable;
      return { name: t.name, rows: t.rows.length, runCount: t.runCount, updatedAt: t.updatedAt };
    });
}

export function deleteTable(name: string): boolean {
  const p = pathFor(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

function write(table: EvidenceTable): void {
  ensureDir(TABLES_DIR);
  table.updatedAt = new Date().toISOString();
  writeFileSync(pathFor(table.name), JSON.stringify(table, null, 2), "utf-8");
}

/** Insert or replace a row (matched on keyField). Model supplies the extracted fields. */
export function upsertRow(name: string, row: Row): EvidenceTable {
  const table = getTable(name);
  if (!table) throw new Error(`No evidence table "${name}". Define it first.`);
  if (!row.dateAccessed) row.dateAccessed = new Date().toISOString().slice(0, 10);
  const key = table.keyField;
  const idx = table.rows.findIndex((r) => r[key] && r[key] === row[key]);
  if (idx >= 0) table.rows[idx] = { ...table.rows[idx], ...row };
  else table.rows.push(row);
  write(table);
  return table;
}

interface DriftReport {
  changed: Array<{ key: string; field: string; from: string; to: string }>;
  missing: Array<{ key: string; value: string }>;
  added: Array<{ key: string; value: string }>;
  unchanged: number;
  markdown: string;
}

const IGNORE_FIELDS = new Set(["dateAccessed", "screenshot", "status", "capturedAt"]);

/** Compare current rows against the saved baseline → changed / missing / new. */
export function diffTable(name: string): DriftReport {
  const table = getTable(name);
  if (!table) throw new Error(`No evidence table "${name}".`);
  const key = table.keyField;
  const baseByKey = new Map(table.baseline.map((r) => [r[key], r]));
  const curByKey = new Map(table.rows.map((r) => [r[key], r]));

  const changed: DriftReport["changed"] = [];
  const missing: DriftReport["missing"] = [];
  const added: DriftReport["added"] = [];
  let unchanged = 0;

  for (const [k, cur] of curByKey) {
    const base = baseByKey.get(k);
    if (!base) {
      added.push({ key: k ?? "(no key)", value: cur[table.valueField] ?? "" });
      continue;
    }
    let rowChanged = false;
    for (const field of table.fields) {
      if (IGNORE_FIELDS.has(field)) continue;
      if ((base[field] ?? "") !== (cur[field] ?? "")) {
        changed.push({ key: k ?? "(no key)", field, from: base[field] ?? "", to: cur[field] ?? "" });
        rowChanged = true;
      }
    }
    if (!rowChanged) unchanged += 1;
  }
  for (const [k, base] of baseByKey) {
    if (!curByKey.has(k)) missing.push({ key: k ?? "(no key)", value: base[table.valueField] ?? "" });
  }

  const md: string[] = [`# Drift report — ${name}`, "", `_run ${table.runCount} → ${table.runCount + 1}; ${changed.length} changed, ${missing.length} missing, ${added.length} new, ${unchanged} unchanged_`, ""];
  if (changed.length) {
    md.push("## Changed");
    for (const c of changed) md.push(`- **${c.key}** — \`${c.field}\`: "${c.from}" → "${c.to}"`);
    md.push("");
  }
  if (missing.length) {
    md.push("## Missing (in last run, gone now)");
    for (const m of missing) md.push(`- **${m.key}** — was "${m.value}"`);
    md.push("");
  }
  if (added.length) {
    md.push("## New");
    for (const a of added) md.push(`- **${a.key}** — "${a.value}"`);
    md.push("");
  }
  if (!changed.length && !missing.length && !added.length) md.push("No drift — every claim matches the last run.");

  return { changed, missing, added, unchanged, markdown: md.join("\n") };
}

/** Promote current rows to the baseline and bump the run counter (call after reviewing a diff). */
export function promoteBaseline(name: string): void {
  const table = getTable(name);
  if (!table) throw new Error(`No evidence table "${name}".`);
  table.baseline = JSON.parse(JSON.stringify(table.rows)) as Row[];
  table.runCount += 1;
  write(table);
}

export function exportTable(name: string, format: "csv" | "markdown"): { path: string } {
  const table = getTable(name);
  if (!table) throw new Error(`No evidence table "${name}".`);
  ensureDir(TABLES_DIR);
  const outPath = join(TABLES_DIR, `${table.name}.${format === "csv" ? "csv" : "md"}`);
  const cols = table.fields;
  if (format === "csv") {
    const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(","), ...table.rows.map((r) => cols.map((c) => esc(r[c])).join(","))];
    writeFileSync(outPath, lines.join("\n"), "utf-8");
  } else {
    const lines = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...table.rows.map((r) => `| ${cols.map((c) => (r[c] ?? "").replace(/\|/g, "\\|").slice(0, 200)).join(" | ")} |`)];
    writeFileSync(outPath, lines.join("\n"), "utf-8");
  }
  return { path: outPath };
}
