/**
 * VZT-Browser REPL — deterministic browser inspection that feels like Playwright,
 * but with the SAME stable refs the agent/MCP tools use, so a click or assertion
 * lines up with what you saw in snapshot(). (Aside parity: the REPL.)
 *
 * In-scope helpers:
 *   page                current Playwright Page (full API: locator, keyboard, …)
 *   context             the persistent BrowserContext
 *   go(url)             navigate
 *   snap()              print aria tree + stable [ref=vN] list
 *   ref('v3')           Locator for a stable ref  (same ref snap() showed)
 *   $(sel)              page.locator(sel).first()
 *   text(sel?)          readable text
 *   shot(path?)         screenshot to a file
 *   tabs()              list open tabs
 *   net({failuresOnly}) captured network log
 *   errors()            captured console errors/warnings
 *   downloads()         downloaded files
 *   evidence(title,opts) build an evidence bundle
 */

import repl from "node:repl";
import { startSession, stopSession, getPage, getSession } from "./lib/session.js";
import { ariaSnapshot, resolveTarget } from "./lib/snapshot.js";
import * as actions from "./lib/actions.js";
import { getConsole, getNetwork, getDownloads } from "./lib/capture.js";
import { collectEvidence, type EvidenceTemplate } from "./lib/evidence.js";

export async function startRepl(opts: { profile?: string; url?: string; readOnly?: boolean }): Promise<void> {
  const s = await startSession({ profile: opts.profile, headed: true, readOnly: opts.readOnly });
  if (opts.url) await actions.navigate(getPage(), opts.url);

  console.log(`VZT-Browser REPL — profile "${s.profile}"${opts.readOnly ? " (read-only)" : ""}.`);
  console.log("Helpers: go(url) snap() ref('v1') $('sel') text() shot() tabs() net() errors() downloads() evidence(title).");
  console.log("The refs from snap() are the same ones click/fill and the agent use.\n");

  const r = repl.start({ prompt: "vzt> " });
  const ctx = r.context;

  Object.defineProperty(ctx, "page", { get: () => getPage() });
  Object.defineProperty(ctx, "context", { get: () => getSession().context });
  ctx.go = (url: string) => actions.navigate(getPage(), url);
  ctx.snap = async () => {
    const snap = await ariaSnapshot(getPage());
    console.log(snap.snapshot + "\n\nRefs:\n" + snap.refs);
    return undefined;
  };
  ctx.ref = (refId: string) => resolveTarget(getPage(), { ref: refId });
  ctx.$ = (sel: string) => getPage().locator(sel).first();
  ctx.text = (sel?: string) => actions.getText(getPage(), sel);
  ctx.shot = async (path?: string) => {
    const p = path || `vzt-shot-${Date.now()}.jpg`;
    await getPage().screenshot({ path: p, fullPage: true, type: "jpeg", quality: 75 });
    return p;
  };
  ctx.tabs = () => getSession().context.pages().map((pg, i) => ({ index: i, url: pg.url() }));
  ctx.net = (filter?: { failuresOnly?: boolean; match?: string }) => getNetwork(filter);
  ctx.errors = () => getConsole({ errorsOnly: true });
  ctx.downloads = () => getDownloads();
  ctx.evidence = (title: string, o?: { template?: EvidenceTemplate }) =>
    collectEvidence(getPage(), { sessionDir: getSession().sessionDir, title, template: o?.template });

  r.on("exit", async () => {
    await stopSession();
    process.exit(0);
  });
}
