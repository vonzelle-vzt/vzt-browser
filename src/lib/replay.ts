// ---------------------------------------------------------------------------
// Deterministic replay of recorded tasks — the Stagehand-cache idea with
// full control: no LLM calls on the happy path, drift detection per step,
// approval gates re-triggered, credential fills re-resolved from the vault.
// On drift the replay STOPS and returns what happened so the client model
// can finish the run by hand and re-save the healed task.
// ---------------------------------------------------------------------------

import type { Page } from "playwright-core";
import type { RecordedStep } from "./recorder.js";
import type { SavedTask } from "./tasks-store.js";
import { markTaskRun } from "./tasks-store.js";
import { describeTarget } from "./snapshot.js";
import * as actions from "./actions.js";
import { ariaSnapshot } from "./snapshot.js";
import { audit } from "./audit.js";

const DRIFT_TIMEOUT = 5_000;

export interface ReplayResult {
  ok: boolean;
  task: string;
  completedSteps: number;
  totalSteps: number;
  failedStep?: { index: number; step: RecordedStep; error: string };
  /** Snapshot at the failure point so the client model can take over. */
  snapshot?: string;
  url: string;
}

function applyParams(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, key: string) => params[key] ?? m);
  }
  if (Array.isArray(value)) return value.map((v) => applyParams(v, params));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, applyParams(v, params)]));
  }
  return value;
}

/** A step's selector must resolve to exactly one visible element whose aria roughly matches. */
async function assertNoDrift(page: Page, step: RecordedStep): Promise<void> {
  const selector = step.resolvedSelector ?? (step.args.selector as string | undefined);
  if (!selector) throw new Error("Recorded step has no stable selector (ref-only steps can't replay). Re-record using CSS selectors.");
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: DRIFT_TIMEOUT });
  const count = await page.locator(selector).count();
  if (count !== 1) throw new Error(`Selector "${selector}" matched ${count} elements (expected exactly 1).`);
  if (step.aria?.name) {
    const now = await describeTarget(locator);
    const recorded = step.aria.name.toLowerCase().slice(0, 40);
    if (recorded && !now.name.toLowerCase().includes(recorded.slice(0, 20))) {
      throw new Error(
        `Element drift: recorded "${step.aria.name}" but found "${now.name}" at "${selector}".`,
      );
    }
  }
}

export async function replayTask(
  page: Page,
  task: SavedTask,
  params: Record<string, string>,
): Promise<ReplayResult> {
  let completed = 0;
  for (const [index, rawStep] of task.steps.entries()) {
    const step: RecordedStep = { ...rawStep, args: applyParams(rawStep.args, params) as Record<string, unknown> };
    const selector = step.resolvedSelector ?? (step.args.selector as string | undefined);
    const target = { selector };
    try {
      switch (step.tool) {
        case "navigate":
          await actions.navigate(page, String(step.args.url));
          break;
        case "click": {
          await assertNoDrift(page, step);
          const res = await actions.click(page, target);
          if (res.denied) throw new Error("Approval denied during replay.");
          break;
        }
        case "fill":
          await assertNoDrift(page, step);
          await actions.fill(page, target, String(step.args.text));
          break;
        case "fill_credential": {
          await assertNoDrift(page, step);
          const res = await actions.fillCredential(
            page,
            target,
            String(step.args.credential),
            Boolean(step.args.pressEnter),
          );
          if (res.denied) throw new Error("Approval denied during replay.");
          break;
        }
        case "press_key":
          await actions.pressKey(page, String(step.args.key));
          break;
        case "select_option":
          await assertNoDrift(page, step);
          await actions.selectOption(page, target, String(step.args.value));
          break;
        default:
          throw new Error(`Unknown recorded tool "${step.tool}".`);
      }
      completed += 1;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const { snapshot } = await ariaSnapshot(page).catch(() => ({ snapshot: "", hasRefs: false }));
      audit({
        kind: "replay",
        outcome: "error",
        detail: { task: task.name, failedStep: index, error },
      });
      return {
        ok: false,
        task: task.name,
        completedSteps: completed,
        totalSteps: task.steps.length,
        failedStep: { index, step, error },
        snapshot,
        url: page.url(),
      };
    }
  }
  markTaskRun(task.id);
  audit({ kind: "replay", outcome: "ok", detail: { task: task.name, steps: completed } });
  return { ok: true, task: task.name, completedSteps: completed, totalSteps: task.steps.length, url: page.url() };
}
