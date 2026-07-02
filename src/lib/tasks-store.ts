// ---------------------------------------------------------------------------
// Task registry — saved, named, replayable action sequences. Adapted from
// mcp-scraper/src/lib/robots-store.ts. Steps come from the session recorder;
// string args support {{param}} templating filled at replay time.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS_DIR, ensureDir } from "./paths.js";
import type { RecordedStep } from "./recorder.js";

export interface SavedTask {
  id: string;
  name: string;
  steps: RecordedStep[];
  /** Params that may appear as {{key}} inside step args. */
  paramKeys: string[];
  /** Standard cron expression, informational — drives the printed cron line. */
  schedule?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return base ? `${base}-${hash}` : hash;
}

function pathFor(id: string): string {
  return join(TASKS_DIR, `${id}.json`);
}

export function saveTask(input: {
  name: string;
  steps: RecordedStep[];
  paramKeys?: string[];
  schedule?: string;
}): SavedTask {
  ensureDir(TASKS_DIR);
  const now = new Date().toISOString();
  const id = slugId(input.name);
  const existing = getTask(id);
  const task: SavedTask = {
    id,
    name: input.name,
    steps: input.steps,
    paramKeys: input.paramKeys ?? [],
    schedule: input.schedule ?? existing?.schedule,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
  };
  writeFileSync(pathFor(id), JSON.stringify(task, null, 2), "utf-8");
  return task;
}

export function getTask(idOrName: string): SavedTask | null {
  ensureDir(TASKS_DIR);
  for (const candidate of [idOrName, slugId(idOrName)]) {
    const p = pathFor(candidate);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8")) as SavedTask;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function listTasks(): SavedTask[] {
  ensureDir(TASKS_DIR);
  const tasks: SavedTask[] = [];
  for (const file of readdirSync(TASKS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      tasks.push(JSON.parse(readFileSync(join(TASKS_DIR, file), "utf-8")) as SavedTask);
    } catch {
      // skip corrupt
    }
  }
  return tasks.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function deleteTask(idOrName: string): boolean {
  const task = getTask(idOrName);
  if (!task) return false;
  unlinkSync(pathFor(task.id));
  return true;
}

export function markTaskRun(id: string): void {
  const task = getTask(id);
  if (!task) return;
  task.lastRunAt = new Date().toISOString();
  writeFileSync(pathFor(id), JSON.stringify(task, null, 2), "utf-8");
}
