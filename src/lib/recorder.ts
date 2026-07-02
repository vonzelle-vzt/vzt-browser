// ---------------------------------------------------------------------------
// Session recorder — always on. Every mutating action appends a step to the
// in-memory log (source for record_save) and to sessions/<id>/actions.jsonl,
// plus a JPEG frame for the reviewable screenshot trail / GIF.
// Credential fills record the credential NAME only, never the value.
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { currentSession } from "./session.js";

export interface RecordedStep {
  tool: string;
  args: Record<string, unknown>;
  resolvedSelector?: string;
  aria?: { role: string; name: string };
  urlBefore: string;
  ts: string;
}

let steps: RecordedStep[] = [];
let frame = 0;
let recorderSessionId: string | null = null;

function syncSession(): string | null {
  const s = currentSession();
  if (!s) return null;
  if (recorderSessionId !== s.sessionId) {
    recorderSessionId = s.sessionId;
    steps = [];
    frame = 0;
  }
  return s.sessionDir;
}

export function getRecordedSteps(): RecordedStep[] {
  syncSession();
  return steps;
}

export async function recordStep(
  page: Page,
  step: Omit<RecordedStep, "ts">,
  opts: { screenshot?: boolean } = {},
): Promise<void> {
  const sessionDir = syncSession();
  if (!sessionDir) return;

  const full: RecordedStep = { ...step, ts: new Date().toISOString() };
  steps.push(full);
  try {
    appendFileSync(join(sessionDir, "actions.jsonl"), JSON.stringify(full) + "\n", "utf-8");
  } catch {
    // recording must never break the action itself
  }

  if (opts.screenshot !== false) {
    frame += 1;
    const name = `${String(frame).padStart(3, "0")}-${step.tool}.jpg`;
    await page
      .screenshot({ path: join(sessionDir, name), type: "jpeg", quality: 55 })
      .catch(() => {});
  }
}
