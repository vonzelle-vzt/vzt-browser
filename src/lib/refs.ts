// ---------------------------------------------------------------------------
// Stable element refs — our own, injected. Playwright-core 1.61 doesn't expose
// the internal ref engine, and Aside touts "stable element refs the agent and
// REPL share so a click lines up with what you saw." We do one better: the
// refs are deterministic (data-vzt-ref attributes we assign), inspectable in
// the DOM, and identical across snapshot / click / REPL. Idempotent per page —
// re-annotating reuses existing refs; a navigation resets them.
// ---------------------------------------------------------------------------

import type { Locator, Page } from "playwright-core";

interface RefNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  enabled: boolean;
}

const ANNOTATE = () => {
  const w = window as unknown as { __vztRefN?: number };
  if (typeof w.__vztRefN !== "number") w.__vztRefN = 0;
  const INTERACTIVE = "a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[contenteditable=true],summary,[onclick]";
  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el as HTMLElement);
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const accName = (el: Element): string => {
    const e = el as HTMLElement & { value?: string; placeholder?: string };
    return (
      e.getAttribute("aria-label") ||
      (e.getAttribute("aria-labelledby") ? document.getElementById(e.getAttribute("aria-labelledby") as string)?.textContent?.trim() || "" : "") ||
      e.getAttribute("title") ||
      e.getAttribute("placeholder") ||
      (e.tagName === "INPUT" || e.tagName === "TEXTAREA" ? (e.value || "") : "") ||
      (e.textContent || "").replace(/\s+/g, " ").trim()
    ).slice(0, 140);
  };
  const out: Array<Record<string, unknown>> = [];
  document.querySelectorAll(INTERACTIVE).forEach((el) => {
    if (!isVisible(el)) return;
    let ref = el.getAttribute("data-vzt-ref");
    if (!ref) {
      ref = "v" + ++(w.__vztRefN as number);
      el.setAttribute("data-vzt-ref", ref);
    }
    const e = el as HTMLElement & { disabled?: boolean };
    out.push({
      ref,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: accName(el),
      tag: el.tagName.toLowerCase(),
      enabled: !e.disabled,
    });
  });
  return out;
};

/** Annotate interactive elements and return their stable refs. */
export async function annotateRefs(page: Page): Promise<RefNode[]> {
  try {
    return (await page.evaluate(ANNOTATE)) as unknown as RefNode[];
  } catch {
    return [];
  }
}

/** Compact, model-readable listing of the interactive elements with their refs. */
export function renderRefList(nodes: RefNode[]): string {
  if (nodes.length === 0) return "(no interactive elements found)";
  return nodes
    .map((n) => `[ref=${n.ref}] ${n.role}${n.name ? ` "${n.name}"` : ""}${n.enabled ? "" : " (disabled)"}`)
    .join("\n");
}

/** True when a target string is one of our injected refs. */
export function isVztRef(ref?: string): boolean {
  return !!ref && /^v\d+$/.test(ref);
}

export function refLocator(page: Page, ref: string): Locator {
  return page.locator(`[data-vzt-ref="${ref}"]`);
}
