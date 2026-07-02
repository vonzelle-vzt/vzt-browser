#!/usr/bin/env node

/**
 * VZT-Browser — Aside-class browser agent MCP server.
 *
 * Persistent logged-in Chrome profiles + per-domain site memory ("Dreaming")
 * + Keychain credential vault (secrets never enter model context) + enforced
 * approval gates + action record/replay + session recording. The MCP client's
 * model does the reasoning against accessibility snapshots — no server-side
 * LLM key required for core operation.
 *
 * Works inside the VZT protocol monorepo (registered in .mcp.json) and as a
 * standalone tool: `npx -y @vzt-protocol/vzt-browser`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { startSession, stopSession, getSession, getPage, currentSession } from "./lib/session.js";
import { ariaSnapshot } from "./lib/snapshot.js";
import * as actions from "./lib/actions.js";
import { readSiteMemory, writeSiteMemory, listSiteMemories, deleteSiteMemory, domainKey, readWorkspaceMemory, remember, workspaceMemoryPath } from "./lib/memory.js";
import { defineTable, upsertRow, diffTable, promoteBaseline, exportTable, getTable, listTables, deleteTable, DEFAULT_FIELDS } from "./lib/evidence-table.js";
import { searchHistory } from "./lib/history.js";
import { vaultStore, vaultList, vaultDelete } from "./lib/vault.js";
import { captureSecretHeaded } from "./lib/vault-prompt.js";
import { setApprovalServer } from "./lib/approval.js";
import { getRecordedSteps } from "./lib/recorder.js";
import { saveTask, getTask, listTasks, deleteTask } from "./lib/tasks-store.js";
import { replayTask } from "./lib/replay.js";
import { assembleGif } from "./lib/gif.js";
import { getConsole, getNetwork, getDownloads } from "./lib/capture.js";
import { collectEvidence } from "./lib/evidence.js";
import { monitorPage } from "./lib/monitor.js";
import { AUDIT_LOG, ROOT_DIR } from "./lib/paths.js";

function wrap<T>(fn: (params: T) => Promise<unknown>) {
  return async (params: T) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(params), null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    }
  };
}

const target = {
  ref: z.string().optional().describe("Element ref from snapshot (e.g. 'e12')"),
  selector: z.string().optional().describe("CSS selector — preferred for recordable/replayable steps"),
};

const server = new McpServer({ name: "vzt-browser", version: "1.0.0" });
setApprovalServer(server);

// --- session -----------------------------------------------------------------

server.tool(
  "session_start",
  "Start a browser session on a persistent logged-in Chrome profile. Returns site memory for the start URL if any. Headless by default.",
  {
    profile: z.string().default("default").describe("Named profile under ~/.vzt/browser/profiles/"),
    headed: z.boolean().default(false),
    url: z.string().url().optional().describe("Optional URL to open immediately"),
    video: z.boolean().default(false).describe("Also record a webm video of the session"),
    readOnly: z.boolean().default(false).describe("Evidence mode: hard-blocks fills/selects and state-changing clicks — a real 'do not post or change' guarantee for review/monitoring tasks"),
  },
  wrap(async (p) => {
    const s = await startSession({ profile: p.profile, headed: p.headed, video: p.video, readOnly: p.readOnly });
    let nav: Record<string, unknown> = {};
    if (p.url) nav = { ...(await actions.navigate(getPage(), p.url)) };
    return {
      sessionId: s.sessionId,
      profile: s.profile,
      headed: s.headed,
      readOnly: s.readOnly,
      sessionDir: s.sessionDir,
      dataDir: ROOT_DIR,
      workspaceMemory: readWorkspaceMemory(),
      ...nav,
    };
  }),
);

server.tool(
  "session_stop",
  "Close the browser session, release the profile lock, and return the session recording directory.",
  {},
  wrap(async () => {
    const stopped = await stopSession();
    return stopped ?? { note: "No session was running." };
  }),
);

server.tool(
  "login_mode",
  "Open a HEADED browser at a URL so the human can log in manually. Logins persist in the profile for all future (including headless) sessions. Tell the user to log in, then call session_stop.",
  {
    url: z.string().url(),
    profile: z.string().default("default"),
  },
  wrap(async (p) => {
    const existing = currentSession();
    if (existing && !existing.headed) {
      await stopSession();
    }
    await startSession({ profile: p.profile, headed: true });
    const nav = await actions.navigate(getPage(), p.url);
    return {
      ...nav,
      instructions:
        "A Chrome window is open. Ask the user to log into the site there. When they confirm, call session_stop — the login persists in the profile.",
    };
  }),
);

// --- navigation + reading ------------------------------------------------------

server.tool(
  "navigate",
  "Navigate to a URL. Returns title, URL, and this domain's site memory (selectors/quirks learned on past visits).",
  { url: z.string().url() },
  wrap(async (p) => actions.navigate(getPage(), p.url)),
);

server.tool(
  "snapshot",
  "Accessibility snapshot of the current page: `snapshot` is the readable aria tree; `refs` lists interactive elements with stable `[ref=vN]` handles you can pass as `ref` to click/fill/select (the same refs the REPL uses). Refs reset on navigation — snapshot again after navigating.",
  {},
  wrap(async () => {
    const page = getPage();
    const snap = await ariaSnapshot(page);
    const memory = readSiteMemory(page.url());
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      ...snap,
      siteMemoryHint: memory ? `Site memory exists for ${domainKey(page.url())} — returned by navigate/session_start.` : null,
    };
  }),
);

server.tool(
  "screenshot",
  "JPEG screenshot of the current page (base64).",
  { fullPage: z.boolean().default(false) },
  wrap(async (p) => {
    const buf = await getPage().screenshot({ fullPage: p.fullPage, type: "jpeg", quality: 70 });
    return { base64: buf.toString("base64"), size: buf.length };
  }),
);

server.tool(
  "get_text",
  "Readable text of the page (or of a CSS selector).",
  { selector: z.string().optional() },
  wrap(async (p) => actions.getText(getPage(), p.selector)),
);

// --- actions -------------------------------------------------------------------

server.tool(
  "click",
  "Click an element by snapshot ref or CSS selector. Sensitive targets (pay/send/delete/checkout URLs or button names) pause for human approval.",
  { ...target, sensitive: z.boolean().default(false).describe("Force the approval gate for this click") },
  wrap(async (p) => actions.click(getPage(), p)),
);

server.tool(
  "fill",
  "Fill a text input. Refuses password fields — use fill_credential for those.",
  { ...target, text: z.string() },
  wrap(async (p) => actions.fill(getPage(), p, p.text)),
);

server.tool(
  "fill_credential",
  "Type a vaulted secret (macOS Keychain) into a field. The secret value NEVER enters the model context — only the credential name. First use on a new domain requires human approval. All access is audit-logged.",
  { ...target, name: z.string().describe("Credential name in the vault"), pressEnter: z.boolean().default(false) },
  wrap(async (p) => actions.fillCredential(getPage(), p, p.name, p.pressEnter)),
);

server.tool("press_key", "Press a keyboard key (e.g. 'Enter', 'Escape', 'Tab').", { key: z.string() },
  wrap(async (p) => actions.pressKey(getPage(), p.key)));

server.tool("select_option", "Select an option in a <select> by value or label.", { ...target, value: z.string() },
  wrap(async (p) => actions.selectOption(getPage(), p, p.value)));

server.tool(
  "wait_for",
  "Wait for a selector or text to become visible (or network idle when neither given).",
  { selector: z.string().optional(), text: z.string().optional(), timeoutMs: z.number().int().min(500).max(60_000).optional() },
  wrap(async (p) => actions.waitFor(getPage(), p)),
);

// --- site memory ("Dreaming") ----------------------------------------------------

server.tool(
  "save_site_memory",
  "Persist what you learned about a site (working selectors, quirks, login flow notes, people/decisions) to local markdown memory. Auto-injected on the next visit. Call this at the end of any session where you learned something.",
  {
    domain: z.string().optional().describe("Domain or URL — defaults to the current page"),
    content: z.string().describe("Markdown — keep it dense: selectors that worked, gotchas, state"),
    mode: z.enum(["replace", "append"]).default("append"),
  },
  wrap(async (p) => {
    const domain = p.domain ?? currentSession()?.page.url();
    if (!domain) throw new Error("No domain given and no session running.");
    return { saved: writeSiteMemory(domain, p.content, p.mode) };
  }),
);

server.tool("list_site_memory", "List all site memory files.", {},
  wrap(async () => listSiteMemories()));

server.tool("get_site_memory", "Read the full site memory for a domain.", { domain: z.string() },
  wrap(async (p) => ({ domain: domainKey(p.domain), content: readSiteMemory(p.domain) })));

server.tool("delete_site_memory", "Delete a domain's site memory.", { domain: z.string() },
  wrap(async (p) => ({ deleted: deleteSiteMemory(p.domain) })));

// --- Dreaming: cross-task workspace memory ------------------------------------------

server.tool(
  "remember",
  "Save a cross-task fact — a person, company, decision, or task-context detail — to workspace memory (auto-injected at session_start). This is 'Dreaming': after a task, capture what mattered so future work continues from it. Markdown on disk; editable.",
  { fact: z.string(), source: z.string().optional().describe("Where it came from — a URL or task name") },
  wrap(async (p) => ({ saved: remember(p.fact, p.source) })),
);

server.tool("show_memory", "Show where all memory lives (workspace + per-site files) so you can inspect or edit it.", {},
  wrap(async () => ({
    workspaceMemory: { path: workspaceMemoryPath(), content: readWorkspaceMemory() },
    siteMemories: listSiteMemories(),
    dataDir: ROOT_DIR,
  })));

// --- browsing-history recall --------------------------------------------------------

server.tool(
  "search_history",
  "Search this profile's real Chrome browsing history — 'find the page I opened yesterday.' Returns url, title, visit count, last-visited date. Reopen a hit with navigate.",
  {
    query: z.string().optional().describe("Substring to match in URL or title"),
    sinceDays: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(500).default(50),
    profile: z.string().default("default"),
  },
  wrap(async (p) => searchHistory(p)),
);

// --- research: schema-first evidence tables + drift ---------------------------------

server.tool(
  "research_define_table",
  "Schema FIRST: declare the fields you want before browsing (default: claim, sourceUrl, publisher, dateAccessed, screenshot, status, oldClaim). Re-defining the same name preserves rows/baseline so weekly runs compare against the same method (Routine-ready).",
  {
    name: z.string(),
    fields: z.array(z.string()).optional().describe(`Defaults to: ${DEFAULT_FIELDS.join(", ")}`),
    keyField: z.string().optional().describe("Field to match rows across runs (default sourceUrl)"),
    valueField: z.string().optional().describe("Field whose change = a changed claim (default claim)"),
    sources: z.array(z.object({ url: z.string(), label: z.string().optional() })).optional(),
    exclusions: z.array(z.string()).optional(),
  },
  wrap(async (p) => defineTable(p)),
);

server.tool(
  "research_capture_source",
  "Open a source read-only, full-page screenshot it into the table's evidence, and return the page text + snapshot so YOU extract the schema fields. Then call research_upsert_row with the values + a status. (You do the interpretation; the tool captures + persists.)",
  { table: z.string(), url: z.string().url(), label: z.string().optional() },
  wrap(async (p) => {
    const s = await startSession({ readOnly: true });
    await actions.navigate(getPage(), p.url);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safe = (p.label || domainKey(p.url)).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const shotPath = `${s.sessionDir}/research-${safe}-${stamp}.jpg`;
    await getPage().screenshot({ path: shotPath, fullPage: true, type: "jpeg", quality: 70 }).catch(() => {});
    const text = await actions.getText(getPage());
    return { screenshot: shotPath, url: getPage().url(), title: text.title, text: text.text.slice(0, 12_000), reminder: "Extract the fields and call research_upsert_row (include this screenshot path + a status: verified|changed|missing|needs-review)." };
  }),
);

server.tool(
  "research_upsert_row",
  "Add/replace a row in an evidence table (matched on the key field). You supply the extracted field values + status; dateAccessed auto-stamps.",
  { table: z.string(), row: z.record(z.string()) },
  wrap(async (p) => {
    const t = upsertRow(p.table, p.row);
    return { rows: t.rows.length };
  }),
);

server.tool(
  "research_diff",
  "Compare the table's current rows against the previous run's baseline → changed / missing / new claims (the 'Friday drift report'). Set promote:true to make the current rows the new baseline after you've reviewed.",
  { table: z.string(), promote: z.boolean().default(false) },
  wrap(async (p) => {
    const report = diffTable(p.table);
    if (p.promote) promoteBaseline(p.table);
    return report;
  }),
);

server.tool("research_export", "Export an evidence table to CSV or Markdown.", { table: z.string(), format: z.enum(["csv", "markdown"]).default("csv") },
  wrap(async (p) => exportTable(p.table, p.format)));

server.tool("research_list_tables", "List evidence tables (name, row count, run count).", {},
  wrap(async () => listTables()));

server.tool("research_get_table", "Get a full evidence table (schema + rows + baseline).", { table: z.string() },
  wrap(async (p) => getTable(p.table)));

server.tool("research_delete_table", "Delete an evidence table.", { table: z.string() },
  wrap(async (p) => ({ deleted: deleteTable(p.table) })));

// --- vault -----------------------------------------------------------------------

server.tool(
  "vault_add",
  "Store a credential in the macOS Keychain WITHOUT the secret passing through the model: opens a secure capture form in a headed browser window for the human to type into. (Terminal alternative: `npx vzt-browser-vault add <name>`.)",
  { name: z.string().describe("Credential name, e.g. 'github-password'"), note: z.string().optional() },
  wrap(async (p) => {
    const s = currentSession() ?? (await startSession({ headed: true }));
    if (!s.headed) {
      throw new Error(
        "vault_add needs a headed session for the secure capture form. Run session_stop, then vault_add again (it will open one), or use: npx vzt-browser-vault add " + p.name,
      );
    }
    const secret = await captureSecretHeaded(getSession().context, p.name);
    await vaultStore(p.name, secret, p.note);
    return { stored: p.name, note: p.note ?? null };
  }),
);

server.tool("vault_list", "List credential NAMES in the vault (never values).", {},
  wrap(async () => vaultList()));

server.tool("vault_delete", "Delete a credential from the Keychain vault.", { name: z.string() },
  wrap(async (p) => ({ deleted: await vaultDelete(p.name) })));

// --- record / replay ----------------------------------------------------------------

server.tool(
  "record_save",
  "Save this session's recorded actions as a named replayable task. Use CSS selectors in your actions (not refs) for reliable replays. String args may contain {{param}} placeholders — list them in paramKeys.",
  {
    task: z.string().describe("Task name, e.g. 'asc-check-review-status'"),
    paramKeys: z.array(z.string()).default([]),
    schedule: z.string().optional().describe("Optional cron expression (informational)"),
  },
  wrap(async (p) => {
    const steps = getRecordedSteps();
    if (steps.length === 0) throw new Error("No recorded steps in this session yet.");
    const saved = saveTask({ name: p.task, steps, paramKeys: p.paramKeys, schedule: p.schedule });
    return { id: saved.id, name: saved.name, steps: saved.steps.length, paramKeys: saved.paramKeys };
  }),
);

server.tool("task_list", "List saved replayable tasks.", {},
  wrap(async () => listTasks().map((t) => ({ id: t.id, name: t.name, steps: t.steps.length, paramKeys: t.paramKeys, schedule: t.schedule ?? null, lastRunAt: t.lastRunAt ?? null }))));

server.tool("task_delete", "Delete a saved task.", { task: z.string() },
  wrap(async (p) => ({ deleted: deleteTask(p.task) })));

server.tool(
  "replay_task",
  "Deterministically replay a saved task — no LLM needed on the happy path (sub-second per step). Approval gates still fire. On page drift it stops and returns the failure point + a snapshot so you can finish manually and re-save.",
  { task: z.string(), params: z.record(z.string()).default({}) },
  wrap(async (p) => {
    const task = getTask(p.task);
    if (!task) throw new Error(`No saved task "${p.task}". See task_list.`);
    await startSession({});
    return replayTask(getPage(), task, p.params);
  }),
);

// --- recording review -----------------------------------------------------------------

server.tool(
  "session_gif",
  "Assemble the session's screenshot trail into a GIF (needs ffmpeg on PATH; otherwise returns the frames directory).",
  { sessionId: z.string().optional().describe("Defaults to the current session") },
  wrap(async (p) => {
    const id = p.sessionId ?? currentSession()?.sessionId;
    if (!id) throw new Error("No sessionId given and no session running.");
    return assembleGif(id);
  }),
);

server.tool("audit_log_path", "Path of the JSONL audit log (vault access + approval decisions).", {},
  wrap(async () => ({ auditLog: AUDIT_LOG, dataDir: ROOT_DIR })));

// --- inspection: hover / viewport / tabs / eval / console / network / downloads ----

server.tool("hover", "Hover an element (menus, tooltips, hover animations). Safe in read-only mode.", { ...target },
  wrap(async (p) => actions.hover(getPage(), p)));

server.tool(
  "set_viewport",
  "Resize the viewport for QA at different widths. Use a preset (desktop 1440×900, tablet 834×1112, mobile 390×844) or explicit width/height.",
  { preset: z.enum(["desktop", "tablet", "mobile"]).optional(), width: z.number().int().optional(), height: z.number().int().optional() },
  wrap(async (p) => actions.setViewport(getPage(), p)),
);

server.tool("list_tabs", "List open tabs (index, url, title).", {},
  wrap(async () => {
    const pages = getSession().context.pages();
    return pages.map((pg, i) => ({ index: i, url: pg.url(), active: pg === getPage() }));
  }));

server.tool("new_tab", "Open a new tab (optionally at a URL) and make it active.", { url: z.string().url().optional() },
  wrap(async (p) => {
    const pg = await getSession().context.newPage();
    if (p.url) await pg.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    getSession().page = pg;
    return { index: getSession().context.pages().indexOf(pg), url: pg.url(), title: await pg.title().catch(() => "") };
  }));

server.tool("switch_tab", "Switch the active tab by index (see list_tabs).", { index: z.number().int().min(0) },
  wrap(async (p) => {
    const pages = getSession().context.pages();
    const pg = pages[p.index];
    if (!pg) throw new Error(`No tab at index ${p.index}.`);
    getSession().page = pg;
    await pg.bringToFront().catch(() => {});
    return { index: p.index, url: pg.url(), title: await pg.title().catch(() => "") };
  }));

server.tool(
  "eval_js",
  "Evaluate a JavaScript expression in the page and return the JSON-serializable result. For reading computed styles, DOM state, animation timing, etc. (Read-only mode still allows this — use it to inspect, not to mutate.)",
  { expression: z.string().describe("A JS expression, e.g. getComputedStyle(document.querySelector('.card')).transition") },
  wrap(async (p) => {
    const value = await getPage().evaluate((expr) => {
      // eslint-disable-next-line no-eval
      const r = eval(expr);
      try { JSON.stringify(r); return r; } catch { return String(r); }
    }, p.expression);
    return { value };
  }),
);

server.tool(
  "read_console",
  "Console messages captured this session (log links, errors, warnings). Filter to errors/warnings or by substring.",
  { errorsOnly: z.boolean().default(false), match: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) },
  wrap(async (p) => getConsole({ errorsOnly: p.errorsOnly, match: p.match }).slice(-p.limit)),
);

server.tool(
  "read_network",
  "Network responses captured this session — the log links a reviewer needs. Filter to failures (status ≥400) or by URL substring.",
  { failuresOnly: z.boolean().default(false), match: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) },
  wrap(async (p) => getNetwork({ failuresOnly: p.failuresOnly, match: p.match }).slice(-p.limit)),
);

server.tool("list_downloads", "Files downloaded this session (url, filename, saved path).", {},
  wrap(async () => getDownloads()));

// --- evidence + monitoring (the developer/reviewer workflow) -------------------------

server.tool(
  "collect_evidence",
  "Open one or more private pages (CI run, PR, Sentry, feature-flag dashboard, staging) and produce a REVIEWABLE evidence bundle — full-page screenshots, captured log links, console errors, downloaded files, and a markdown note (PR-comment/incident scaffold). Never posts or changes anything. Use a read-only session for a hard guarantee. Templates: ci-triage, pr-packet, qa, flag-audit, incident, generic.",
  {
    title: z.string().describe("Bundle title, e.g. 'PR #482 evidence packet'"),
    template: z.enum(["generic", "ci-triage", "pr-packet", "qa", "flag-audit", "incident"]).default("generic"),
    pages: z
      .array(
        z.object({
          label: z.string().optional(),
          url: z.string().url().optional(),
          viewport: z.union([z.enum(["desktop", "tablet", "mobile"]), z.object({ width: z.number(), height: z.number() })]).optional(),
        }),
      )
      .default([])
      .describe("Pages to capture; omit to capture the current page"),
    notes: z.string().optional(),
  },
  wrap(async (p) => {
    const s = await startSession({});
    return collectEvidence(getPage(), { sessionDir: s.sessionDir, title: p.title, template: p.template, pages: p.pages, notes: p.notes });
  }),
);

server.tool(
  "monitor_page",
  "Watch a page on an interval until a signal fires or a deadline passes, then return so you can collect_evidence — e.g. a Datadog error rate crossing a threshold, or a rollout value changing. Read-only. For recurring Routines, have your MCP client schedule this (or replay_task).",
  {
    url: z.string().url().optional(),
    everyMs: z.number().int().min(2_000).default(30_000),
    forMs: z.number().int().max(3_600_000).default(900_000),
    textAppears: z.string().optional(),
    selectorChanges: z.string().optional(),
    numberSelector: z.string().optional(),
    above: z.number().optional(),
    below: z.number().optional(),
  },
  wrap(async (p) => {
    await startSession({});
    return monitorPage(getPage(), p);
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
