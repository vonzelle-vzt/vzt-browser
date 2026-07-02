#!/usr/bin/env node

/**
 * vzt-browser-cli — the CLI face of VZT-Browser (Aside parity: CLI · MCP · REPL).
 * Run a private-browser check from a dev workflow without a separate chat.
 *
 *   vzt-browser-cli login <url> [--profile p]      log into a site once (headed)
 *   vzt-browser-cli open <url> [--headed]          open + print title/url
 *   vzt-browser-cli snapshot                        aria tree + stable refs
 *   vzt-browser-cli text [selector]                 readable page text
 *   vzt-browser-cli shot [path] [--full]           screenshot to file
 *   vzt-browser-cli eval "<js>"                    evaluate JS, print result
 *   vzt-browser-cli evidence <url...> [--template ci-triage|pr-packet|qa|flag-audit|incident] [--title "..."]
 *   vzt-browser-cli monitor <url> --number-selector ".err" --above 2 [--every 30000] [--for 900000]
 *   vzt-browser-cli repl [url] [--profile p]       interactive Playwright-like REPL
 *
 * Global flags: --profile <name> (default "default"), --headed, --readonly, --keep (leave browser open)
 */

import { startSession, stopSession, getPage } from "./lib/session.js";
import { ariaSnapshot } from "./lib/snapshot.js";
import * as actions from "./lib/actions.js";
import { collectEvidence, type EvidenceTemplate } from "./lib/evidence.js";
import { monitorPage } from "./lib/monitor.js";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): boolean {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) { argv.splice(i, 1); return true; }
  return false;
}
function opt(name: string, dflt?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) { const v = argv[i + 1]; argv.splice(i, 2); return v; }
  return dflt;
}
function out(v: unknown): void {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

const profile = opt("profile", "default");
const headed = flag("headed");
const readOnly = flag("readonly");
const keep = flag("keep");
// Read positional args LAZILY — only after a command has spliced out its own
// value-flags (e.g. --template <v>), so those values don't leak in as args.
const rest = () => argv.slice(1).filter((a) => !a.startsWith("--"));

async function withSession<T>(fn: () => Promise<T>, forceHeaded = false): Promise<void> {
  await startSession({ profile, headed: headed || forceHeaded, readOnly });
  try {
    out(await fn());
  } finally {
    if (!keep) await stopSession();
  }
}

switch (cmd) {
  case "login": {
    const url = rest()[0];
    if (!url) { console.error("Usage: vzt-browser-cli login <url>"); process.exit(1); }
    await startSession({ profile, headed: true, readOnly: false });
    await actions.navigate(getPage(), url);
    out(`Logged-in window open at ${url}. Sign in, then press Ctrl+C (the profile keeps the login).`);
    await new Promise(() => {}); // keep alive until Ctrl+C
    break;
  }
  case "open": {
    const url = rest()[0];
    if (!url) { console.error("Usage: vzt-browser-cli open <url>"); process.exit(1); }
    await withSession(async () => actions.navigate(getPage(), url));
    break;
  }
  case "snapshot":
    await withSession(async () => ariaSnapshot(getPage()));
    break;
  case "text":
    await withSession(async () => actions.getText(getPage(), rest()[0]));
    break;
  case "shot": {
    const path = rest()[0] || `vzt-shot-${Date.now()}.jpg`;
    await withSession(async () => {
      await getPage().screenshot({ path, fullPage: flag("full"), type: "jpeg", quality: 75 });
      return { screenshot: path };
    });
    break;
  }
  case "eval": {
    const expr = rest()[0];
    if (!expr) { console.error('Usage: vzt-browser-cli eval "<js expression>"'); process.exit(1); }
    await withSession(async () => {
      const value = await getPage().evaluate((e) => {
        // eslint-disable-next-line no-eval
        const r = eval(e); try { JSON.stringify(r); return r; } catch { return String(r); }
      }, expr);
      return { value };
    });
    break;
  }
  case "evidence": {
    const template = (opt("template", "generic") as EvidenceTemplate);
    const title = opt("title", `Evidence (${template})`) as string;
    const urls = rest();
    await withSession(async () => {
      const s = await startSession({ profile, readOnly });
      const pages = urls.length ? urls.map((u, i) => ({ label: `page-${i + 1}`, url: u })) : undefined;
      const res = await collectEvidence(getPage(), { sessionDir: s.sessionDir, title, template, pages });
      return { note: res.notePath, dir: res.dir, screenshots: res.screenshots, logLinks: res.logLinks.slice(0, 10) };
    });
    break;
  }
  case "monitor": {
    const mOpts = {
      everyMs: Number(opt("every", "30000")),
      forMs: Number(opt("for", "900000")),
      textAppears: opt("text-appears"),
      selectorChanges: opt("selector-changes"),
      numberSelector: opt("number-selector"),
      above: opt("above") ? Number(opt("above")) : undefined,
      below: opt("below") ? Number(opt("below")) : undefined,
    };
    const url = rest()[0];
    await withSession(async () => monitorPage(getPage(), { url, ...mOpts }));
    break;
  }
  case "repl": {
    const { startRepl } = await import("./repl.js");
    await startRepl({ profile: profile as string, url: rest()[0], readOnly });
    break;
  }
  default:
    out(
      [
        "vzt-browser-cli — CLI · MCP · REPL browser evidence",
        "",
        "Commands: login open snapshot text shot eval evidence monitor repl",
        'Run "vzt-browser-cli <cmd>" — see the file header for full usage.',
        "Global flags: --profile <name> --headed --readonly --keep",
      ].join("\n"),
    );
    process.exit(cmd ? 1 : 0);
}
