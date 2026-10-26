// ---------------------------------------------------------------------------
// Page actions with the three hooks every mutating action passes through:
// sensitivity classification -> approval gate -> recorder.
// ---------------------------------------------------------------------------

import type { Page } from "playwright-core";
import { describeTarget, resolveTarget, stableSelectorFor, type Target } from "./snapshot.js";
import { classifySensitive } from "./sensitive.js";
import { requestApproval } from "./approval.js";
import { recordStep } from "./recorder.js";
import { domainKey, readSiteMemory } from "./memory.js";
import { vaultRead, isNewDomainForCredential, rememberCredentialDomain } from "./vault.js";
import { audit } from "./audit.js";
import { currentSession } from "./session.js";

const ACTION_TIMEOUT = 10_000;

/** Evidence/read-only mode blocks page mutations entirely (stronger than a prompt "please don't change"). */
function assertReadWrite(action: string): void {
  if (currentSession()?.readOnly) {
    throw new Error(
      `Blocked: session is in read-only/evidence mode, so "${action}" cannot run. ` +
        `Start a normal session (readOnly:false) to make changes.`,
    );
  }
}

interface ActionResult {
  ok: boolean;
  denied?: boolean;
  url: string;
  title: string;
  detail?: string;
}

async function pageState(page: Page): Promise<{ url: string; title: string }> {
  return { url: page.url(), title: await page.title().catch(() => "") };
}

export async function navigate(page: Page, url: string): Promise<ActionResult & { siteMemory: string | null }> {
  const urlBefore = page.url();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await recordStep(page, { tool: "navigate", args: { url }, urlBefore });
  return { ok: true, ...(await pageState(page)), siteMemory: readSiteMemory(url) };
}

export async function click(
  page: Page,
  target: Target & { sensitive?: boolean },
): Promise<ActionResult> {
  const locator = resolveTarget(page, target);
  await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });
  const aria = await describeTarget(locator);

  const verdict = classifySensitive({ url: page.url(), elementName: aria.name, explicit: target.sensitive });
  if (verdict.sensitive && currentSession()?.readOnly) {
    return {
      ok: false,
      denied: true,
      ...(await pageState(page)),
      detail: `Blocked in read-only/evidence mode (sensitive: ${verdict.reason}). Navigation clicks are allowed; this one looks state-changing.`,
    };
  }
  if (verdict.sensitive) {
    const approved = await requestApproval({
      action: `click "${aria.name || target.selector || target.ref}"`,
      url: page.url(),
      reason: verdict.reason,
    });
    if (!approved) {
      return { ok: false, denied: true, ...(await pageState(page)), detail: `Denied by user: ${verdict.reason}` };
    }
  }

  const urlBefore = page.url();
  const stable = await stableSelectorFor(page, target);
  await locator.click({ timeout: ACTION_TIMEOUT });
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await recordStep(page, {
    tool: "click",
    args: { ref: target.ref, selector: target.selector },
    resolvedSelector: stable,
    aria,
    urlBefore,
  });
  return { ok: true, ...(await pageState(page)) };
}

export async function fill(page: Page, target: Target, text: string): Promise<ActionResult> {
  assertReadWrite("fill");
  const locator = resolveTarget(page, target);
  await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });

  const inputType = await locator
    .evaluate((el) => (el as HTMLInputElement).type ?? "")
    .catch(() => "");
  if (inputType === "password") {
    throw new Error(
      "Refusing to fill a password field with plain text. Use fill_credential so the secret stays out of the model context.",
    );
  }

  const aria = await describeTarget(locator);
  const urlBefore = page.url();
  const stable = await stableSelectorFor(page, target);
  await locator.fill(text, { timeout: ACTION_TIMEOUT });
  await recordStep(page, {
    tool: "fill",
    args: { ref: target.ref, selector: target.selector, text },
    resolvedSelector: stable,
    aria,
    urlBefore,
  });
  return { ok: true, ...(await pageState(page)) };
}

export async function fillCredential(
  page: Page,
  target: Target,
  credentialName: string,
  pressEnter: boolean,
): Promise<ActionResult & { credential: string }> {
  assertReadWrite("fill_credential");
  const locator = resolveTarget(page, target);
  await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });
  const domain = domainKey(page.url());

  if (isNewDomainForCredential(credentialName, domain)) {
    const approved = await requestApproval({
      action: `fill credential "${credentialName}" on ${domain} (first use on this domain)`,
      url: page.url(),
      reason: "credential used on a new domain",
    });
    if (!approved) {
      audit({ kind: "vault_fill", outcome: "denied", detail: { credential: credentialName, domain } });
      return {
        ok: false,
        denied: true,
        credential: credentialName,
        ...(await pageState(page)),
        detail: "Denied: first use of this credential on this domain.",
      };
    }
  }

  const secret = await vaultRead(credentialName, { domain, url: page.url() });
  const urlBefore = page.url();
  const stable = await stableSelectorFor(page, target);
  try {
    await locator.click({ timeout: ACTION_TIMEOUT });
    await locator.fill("");
    await page.keyboard.type(secret, { delay: 25 });
    if (pressEnter) await page.keyboard.press("Enter");
  } catch (err) {
    // Scrub the secret from any error text before it can reach a tool result.
    const msg = (err instanceof Error ? err.message : String(err)).split(secret).join("[redacted]");
    audit({ kind: "vault_fill", outcome: "error", detail: { credential: credentialName, domain } });
    throw new Error(msg);
  }
  rememberCredentialDomain(credentialName, domain);
  audit({ kind: "vault_fill", outcome: "ok", detail: { credential: credentialName, domain, url: urlBefore } });
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  // Record name only; screenshot AFTER the fill (password fields render dots).
  await recordStep(page, {
    tool: "fill_credential",
    args: { ref: target.ref, selector: target.selector, credential: credentialName, pressEnter },
    resolvedSelector: stable,
    urlBefore,
  });
  return { ok: true, credential: credentialName, ...(await pageState(page)) };
}

export async function pressKey(page: Page, key: string): Promise<ActionResult> {
  const urlBefore = page.url();
  await page.keyboard.press(key);
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await recordStep(page, { tool: "press_key", args: { key }, urlBefore });
  return { ok: true, ...(await pageState(page)) };
}

export async function selectOption(page: Page, target: Target, value: string): Promise<ActionResult> {
  assertReadWrite("select_option");
  const locator = resolveTarget(page, target);
  await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });
  const aria = await describeTarget(locator);
  const urlBefore = page.url();
  const stable = await stableSelectorFor(page, target);
  // Match by value, label, or index — whichever the caller supplied.
  await locator
    .selectOption({ value }, { timeout: ACTION_TIMEOUT })
    .catch(() => locator.selectOption({ label: value }, { timeout: ACTION_TIMEOUT }));
  await recordStep(page, {
    tool: "select_option",
    args: { ref: target.ref, selector: target.selector, value },
    resolvedSelector: stable,
    aria,
    urlBefore,
  });
  return { ok: true, ...(await pageState(page)) };
}

export async function waitFor(
  page: Page,
  opts: { selector?: string; text?: string; timeoutMs?: number },
): Promise<ActionResult> {
  const timeout = opts.timeoutMs ?? 15_000;
  if (opts.selector) {
    await page.locator(opts.selector).first().waitFor({ state: "visible", timeout });
  } else if (opts.text) {
    await page.getByText(opts.text).first().waitFor({ state: "visible", timeout });
  } else {
    await page.waitForLoadState("networkidle", { timeout });
  }
  return { ok: true, ...(await pageState(page)) };
}

export async function hover(page: Page, target: Target): Promise<ActionResult> {
  const locator = resolveTarget(page, target);
  await locator.waitFor({ state: "visible", timeout: ACTION_TIMEOUT });
  await locator.hover({ timeout: ACTION_TIMEOUT });
  return { ok: true, ...(await pageState(page)) };
}

/** Resize the viewport — QA at desktop/mobile widths. Presets or explicit w/h. */
export async function setViewport(page: Page, opts: { preset?: "desktop" | "mobile" | "tablet"; width?: number; height?: number }): Promise<ActionResult & { viewport: { width: number; height: number } }> {
  const presets = {
    desktop: { width: 1440, height: 900 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 },
  };
  const vp = opts.preset ? presets[opts.preset] : { width: opts.width ?? 1440, height: opts.height ?? 900 };
  await page.setViewportSize(vp);
  return { ok: true, viewport: vp, ...(await pageState(page)) };
}

export async function getText(page: Page, selector?: string): Promise<{ url: string; title: string; text: string }> {
  const text = selector
    ? ((await page.locator(selector).first().textContent({ timeout: ACTION_TIMEOUT })) ?? "")
    : await page.locator("body").innerText({ timeout: ACTION_TIMEOUT });
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    text: trimmed.length > 40_000 ? trimmed.slice(0, 40_000) + "\n[...truncated]" : trimmed,
  };
}
