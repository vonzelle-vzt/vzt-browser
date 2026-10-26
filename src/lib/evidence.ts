// ---------------------------------------------------------------------------
// Evidence bundles — the developer/reviewer workflow Aside advertises: open
// private pages (CI run, PR, Sentry, feature-flag dashboard, staging), and
// bring back log links, screenshots, files, rollout state, and a *reviewable
// note* — WITHOUT posting or changing anything. Templates shape the note for
// the common jobs (CI triage, PR packet, QA, flag audit, incident).
//
// This never mutates the page: it navigates, screenshots, reads text, and dumps
// the passively-captured console/network. Pair with a read-only session for a
// hard "do not change" guarantee.
// ---------------------------------------------------------------------------

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { getConsole, getNetwork, getDownloads } from "./capture.js";
import { getText } from "./actions.js";

export type EvidenceTemplate = "generic" | "ci-triage" | "pr-packet" | "qa" | "flag-audit" | "incident";

interface EvidencePage {
  label?: string;
  url?: string;
  viewport?: { width: number; height: number } | "desktop" | "mobile" | "tablet";
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

const TEMPLATE_HEADINGS: Record<EvidenceTemplate, string[]> = {
  generic: ["Summary", "Evidence", "Log links", "Console errors", "Files", "For the reviewer"],
  "ci-triage": ["Failing job", "First failing step + log link", "Diff vs last green run", "PR comment draft", "Suggested next step"],
  "pr-packet": ["Summary", "Checks & log links", "Preview / staging screenshots", "Sentry / errors", "Rollout state", "Known risks", "Reviewer decisions needed"],
  qa: ["Flow", "Desktop screenshots", "Mobile screenshots", "Console / layout issues", "QA checklist"],
  "flag-audit": ["Flag", "Plan (from docs)", "Live value (from dashboard)", "Match?", "Evidence links", "Recommended action (NOT applied)"],
  incident: ["Monitor that changed", "Time window", "Log / trace links", "Top failing endpoint", "Likely blast radius", "Action left for a human"],
};

interface EvidenceResult {
  notePath: string;
  note: string;
  dir: string;
  screenshots: string[];
  logLinks: string[];
  consoleErrors: string[];
  files: string[];
}

/**
 * Capture an evidence bundle across one or more pages into the session dir.
 * Writes screenshots + a markdown note (the reviewable artifact / PR-comment
 * draft scaffold) and returns everything by path. Read-only by nature.
 */
export async function collectEvidence(
  page: Page,
  opts: {
    sessionDir: string;
    title: string;
    template?: EvidenceTemplate;
    pages?: EvidencePage[];
    notes?: string;
  },
): Promise<EvidenceResult> {
  const template = opts.template ?? "generic";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(opts.sessionDir, "evidence", `${stamp}-${template}`);
  mkdirSync(dir, { recursive: true });

  const screenshots: string[] = [];
  const captured: Array<{ label: string; url: string; title: string; textPath: string; shot: string }> = [];

  const targets: EvidencePage[] = opts.pages && opts.pages.length ? opts.pages : [{ url: undefined }];
  for (const [i, t] of targets.entries()) {
    if (t.url) await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
    if (t.viewport) {
      const vp = typeof t.viewport === "string" ? VIEWPORTS[t.viewport] : t.viewport;
      await page.setViewportSize(vp).catch(() => {});
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
    const label = t.label || `page-${i + 1}`;
    const safe = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const shot = join(dir, `${String(i + 1).padStart(2, "0")}-${safe}.jpg`);
    await page.screenshot({ path: shot, fullPage: true, type: "jpeg", quality: 70 }).catch(() => {});
    screenshots.push(shot);
    const text = await getText(page).catch(() => ({ url: page.url(), title: "", text: "" }));
    const textPath = join(dir, `${String(i + 1).padStart(2, "0")}-${safe}.txt`);
    writeFileSync(textPath, `${text.title}\n${text.url}\n\n${text.text}`, "utf-8");
    captured.push({ label, url: text.url, title: text.title, textPath, shot });
  }

  const failures = getNetwork({ failuresOnly: true }).slice(-40);
  const logLinks = failures.map((f) => `${f.status} ${f.method} ${f.url}`);
  const consoleErrors = getConsole({ errorsOnly: true }).slice(-40).map((c) => `[${c.type}] ${c.text}`);
  const files = getDownloads().map((d) => d.path);

  const note = renderNote(template, opts.title, { captured, logLinks, consoleErrors, files, notes: opts.notes });
  const notePath = join(dir, "evidence.md");
  writeFileSync(notePath, note, "utf-8");

  return { notePath, note, dir, screenshots, logLinks, consoleErrors, files };
}

function renderNote(
  template: EvidenceTemplate,
  title: string,
  data: {
    captured: Array<{ label: string; url: string; title: string; shot: string }>;
    logLinks: string[];
    consoleErrors: string[];
    files: string[];
    notes?: string;
  },
): string {
  const lines: string[] = [`# ${title}`, "", `_Template: ${template} · generated by VZT-Browser · read-only evidence — nothing was posted or changed._`, ""];

  lines.push("## Pages captured");
  for (const c of data.captured) {
    lines.push(`- **${c.label}** — [${c.title || c.url}](${c.url})`);
    lines.push(`  - screenshot: \`${c.shot}\``);
  }
  lines.push("");

  for (const heading of TEMPLATE_HEADINGS[template]) {
    lines.push(`## ${heading}`);
    if (/log link/i.test(heading)) {
      lines.push(data.logLinks.length ? data.logLinks.map((l) => `- ${l}`).join("\n") : "_No failing requests captured._");
    } else if (/console/i.test(heading)) {
      lines.push(data.consoleErrors.length ? "```\n" + data.consoleErrors.join("\n") + "\n```" : "_No console errors/warnings captured._");
    } else if (/file/i.test(heading)) {
      lines.push(data.files.length ? data.files.map((f) => `- \`${f}\``).join("\n") : "_No files downloaded._");
    } else if (/comment draft/i.test(heading)) {
      lines.push("> _Draft — review before posting:_\n>\n> (diagnosis) The first failure is …\n> Log: …\n> Suggested next step: …");
    } else {
      lines.push("_(fill in)_");
    }
    lines.push("");
  }

  if (data.notes) {
    lines.push("## Notes", data.notes, "");
  }
  return lines.join("\n");
}
