// ---------------------------------------------------------------------------
// Accessibility snapshots + target resolution.
//
// Snapshot = a readable aria tree PLUS our own stable ref list (see refs.ts):
// interactive nodes carry `[ref=vN]` handles that resolve identically from
// snapshot, click/fill, and the REPL — the "click lines up with what you saw"
// guarantee Aside advertises, made deterministic and DOM-inspectable.
// ---------------------------------------------------------------------------

import type { Locator, Page } from "playwright-core";
import { annotateRefs, isVztRef, refLocator, renderRefList } from "./refs.js";

interface SnapshotResult {
  snapshot: string;
  refs: string;
  hasRefs: boolean;
}

export async function ariaSnapshot(page: Page): Promise<SnapshotResult> {
  let tree: string;
  try {
    tree = await page.locator("body").ariaSnapshot();
  } catch {
    tree = "(page not ready)";
  }
  const nodes = await annotateRefs(page);
  return {
    snapshot: tree,
    refs: renderRefList(nodes),
    hasRefs: nodes.length > 0,
  };
}

export interface Target {
  ref?: string;
  selector?: string;
}

/** Resolve a ref (our injected vN, or a native aria-ref) or CSS selector to a Locator. */
export function resolveTarget(page: Page, target: Target): Locator {
  if (target.ref) {
    return isVztRef(target.ref) ? refLocator(page, target.ref) : page.locator(`aria-ref=${target.ref}`);
  }
  if (target.selector) return page.locator(target.selector).first();
  throw new Error("Provide either `ref` (from snapshot) or `selector` (CSS).");
}

/**
 * A stable CSS selector for a target, used so recorded steps replay even though
 * injected refs reset on navigation. Prefers the element's own id, else the
 * data-vzt-ref attribute (stable within the recorded page), else the raw selector.
 */
export async function stableSelectorFor(page: Page, target: Target): Promise<string | undefined> {
  if (target.selector) return target.selector;
  if (target.ref && isVztRef(target.ref)) {
    const id = await refLocator(page, target.ref)
      .evaluate((el) => (el as HTMLElement).id || "")
      .catch(() => "");
    return id ? `#${id}` : `[data-vzt-ref="${target.ref}"]`;
  }
  return undefined;
}

/** Best-effort accessible description of an element, used for sensitivity checks + recording. */
export async function describeTarget(locator: Locator): Promise<{ role: string; name: string }> {
  try {
    return await locator.evaluate((el) => {
      const e = el as HTMLElement;
      const name =
        e.getAttribute("aria-label") ||
        (e as HTMLInputElement).value ||
        e.textContent?.trim().slice(0, 120) ||
        e.getAttribute("title") ||
        "";
      const role = e.getAttribute("role") || e.tagName.toLowerCase();
      return { role, name };
    });
  } catch {
    return { role: "unknown", name: "" };
  }
}
