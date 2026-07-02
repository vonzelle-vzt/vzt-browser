# VZT-Browser

An **Aside-class browser agent** — MCP · CLI · REPL — with its gaps filled.

[Aside](https://aside.com) is a closed AI browser: it works on your logged-in
sites, keeps local markdown memory, has an "agent password manager," and offers
**CLI · MCP · REPL** for private browser evidence in a coding workflow. It's also
macOS-app-only, has no open API, only *implies* its approval gate, and keeps no
audit trail. VZT-Browser matches all three surfaces (CLI · MCP · REPL) as an
**open tool any model/app can drive**, and fills what Aside lacks.

## Three surfaces (Aside parity)

- **MCP** (`vzt-browser`) — 48 tools your coding agent calls without leaving the editor.
- **CLI** (`vzt-browser-cli`) — a private-browser check from a dev workflow: `open`, `snapshot`, `text`, `shot`, `eval`, `evidence`, `monitor`, `login`, `repl`.
- **REPL** (`vzt-browser-cli repl`) — deterministic inspection that feels like Playwright (`page`, `$()`, `tabs()`, `shot()`, `net()`) **using the same stable refs the agent uses**, so `ref('v3')` is the element you saw in `snap()`.

## The developer/reviewer workflow

`collect_evidence` opens private pages (CI run, PR, Sentry, feature-flag
dashboard, staging) and returns a **reviewable bundle**: full-page screenshots,
captured **log links** (failing network requests), console errors, downloaded
files, and a markdown **note** (PR-comment / incident scaffold). Templates:
`ci-triage`, `pr-packet`, `qa`, `flag-audit`, `incident`, `generic`.

It **never posts or changes anything** — and unlike Aside (which asks the model
to behave), that's *enforced*: start the session `readOnly:true` (or
`VZT_BROWSER_READONLY=true`, or CLI `--readonly`) and fills/selects and
state-changing clicks are hard-blocked at the tool layer. Navigation clicks,
screenshots, `eval_js`, and `monitor_page` still work.

```bash
# CI triage from the terminal, guaranteed read-only:
vzt-browser-cli evidence https://ci.example.com/run/74288420 \
  --template ci-triage --title "PR #482 CI" --readonly
# → screenshots + evidence.md note with the first failing log link
```

`monitor_page` watches a dashboard (Datadog/rollout) on an interval until a
threshold trips, then hands back so you `collect_evidence`. Schedule it (or
`replay_task`) from your MCP client for recurring **Routines**.

## Research & claim-drift

Schema-first, just like Aside: declare the fields you want *before* browsing,
capture sources, and on re-runs compare the new table against last time.

- `research_define_table` — declare the schema (default: claim, sourceUrl, publisher, dateAccessed, screenshot, status, oldClaim). Re-defining the same name keeps rows + baseline, so a weekly run compares against the same method.
- `research_capture_source` — open a source read-only, screenshot it, hand back the page text/snapshot so *you* extract the fields (interpretation stays with you).
- `research_upsert_row` — store the extracted row with a status (verified / changed / missing / needs-review).
- `research_diff` — the **Friday drift report**: changed / missing / new claims vs the last run (e.g. "Free plan includes 10 seats" → "5 seats"). `promote:true` sets a new baseline.
- `research_export` — CSV or Markdown.

PDFs and other downloads auto-save to the session's `downloads/` folder
(`list_downloads`), so citations stay linked to their source rows.

## Memory that keeps learning

- **Site memory** — `save_site_memory` stores the path that worked on a site; auto-injected next visit.
- **Dreaming (cross-task)** — `remember` saves the people, companies, and decisions that matter to `~/.vzt/browser/memory/_workspace.md`, auto-injected at every `session_start`, so the agent continues from past work.
- **Browsing-history recall** — `search_history` queries this profile's real Chrome history ("find the page I opened yesterday"); reopen a hit with `navigate`.
- **Inspectable** — `show_memory` lists every memory file + path. It's plain markdown on your device — open it, edit it, delete a wrong line.

## Aside parity + the gaps we fill

| Aside | VZT-Browser | Aside's gap → how we fill it |
|---|---|---|
| Works on logged-in sites | Persistent Chrome profile (`launchPersistentContext`) | **No API / closed app** → it's an MCP server; composes with the rest of the VZT suite and any MCP client |
| Local markdown memory ("Dreaming") | `~/.vzt/browser/memory/<domain>.md`, auto-injected | **No scheduling** → saved tasks + deterministic replay (cron-ready) |
| "Agent password manager" | macOS Keychain vault; secret never enters model context | **Approval only implied** → *enforced* gates (MCP elicitation → macOS dialog) |
| Runs on your Mac | Same, plus **headless** | **No audit** → JSONL audit log of every credential access + approval |
| Locked engine + usage credits | **BYO model** — the MCP client reasons; no server-side key for core ops | **Undefined pricing** → free/self-hosted |
| CLI · MCP · REPL | all three (`vzt-browser-cli`, `vzt-browser`, `… repl`) | **"do not change" only asked of the model** → *enforced* read-only mode |
| Evidence: log links, screenshots, note | `collect_evidence` + templates | **No audit / no hard read-only** → JSONL audit + tool-layer read-only |
| REPL "stable refs" | our injected `[ref=vN]` — same in snapshot, click, REPL | Refs are deterministic + DOM-inspectable (`data-vzt-ref`) |

## Two ways to run it

**1. Inside the VZT protocol** — already registered in `.mcp.json` as `vzt-browser`.

**2. Standalone, in anyone's project** — no monorepo needed:

```jsonc
// .mcp.json / claude_desktop_config.json / cursor mcp config
{
  "mcpServers": {
    "vzt-browser": {
      "command": "npx",
      "args": ["-y", "@vzt-protocol/vzt-browser"],
      "env": { "VZT_BROWSER_APPROVAL": "auto" }
    }
  }
}
```

Requires Node ≥ 20 and Google Chrome installed (falls back to `CHROMIUM_PATH`
or Playwright's bundled Chromium). All state lives under `~/.vzt/browser/`
(override with `VZT_BROWSER_HOME`).

## First run

1. **Log into your sites once** — `login_mode({ url: "https://github.com/login" })`
   opens a real Chrome window on the `default` profile. Log in by hand, then
   `session_stop`. The login persists forever (cookies + localStorage).
2. **Then automate headless** — `session_start()` reuses that profile. `snapshot`
   to see the page, `click`/`fill` to act, `get_text` to read.
3. **Store secrets out-of-band** — `npx vzt-browser-vault add github-password`
   (hidden terminal input) or the `vault_add` tool (secure in-browser form).
   Then `fill_credential({ name: "github-password", selector: "#password" })` —
   the value is typed into the page but never returned to the model.
4. **Teach it the site** — `save_site_memory` at the end; next visit it's injected.
5. **Record once, replay forever** — after a successful flow, `record_save({ task: "..." })`,
   then `replay_task({ task: "..." })` runs it deterministically with no LLM calls.

## Tools (48)

- **Session:** `session_start` (with `readOnly`) `session_stop` `login_mode`
- **Navigate/read:** `navigate` `snapshot` (aria tree + stable `[ref=vN]`) `screenshot` `get_text`
- **Act:** `click` `fill` `fill_credential` `press_key` `select_option` `wait_for` `hover`
- **Inspect:** `set_viewport` `list_tabs` `new_tab` `switch_tab` `eval_js` `read_console` `read_network` `list_downloads`
- **Evidence:** `collect_evidence` `monitor_page`
- **Research/drift:** `research_define_table` `research_capture_source` `research_upsert_row` `research_diff` `research_export` `research_list_tables` `research_get_table` `research_delete_table`
- **Memory:** `save_site_memory` `list_site_memory` `get_site_memory` `delete_site_memory` `remember` `show_memory` `search_history`
- **Vault:** `vault_add` `vault_list` `vault_delete`
- **Record/replay:** `record_save` `task_list` `task_delete` `replay_task`
- **Review:** `session_gif` `audit_log_path`

## Safety model

- **Secrets never reach the model.** `fill_credential` reads from Keychain
  server-side, types via the keyboard, and returns only `{filled:true}`. Errors
  are scrubbed of the secret. `fill` refuses `type=password` fields.
- **Enforced approval.** Actions classified sensitive (checkout/payment/delete
  URLs, buy/pay/send/delete button names, always-ask domains in
  `~/.vzt/browser/config.json`, first credential use per domain) pause for a
  human via MCP elicitation, falling back to a macOS dialog. `VZT_BROWSER_APPROVAL=off`
  disables gating (e.g. trusted cron replays).
- **Everything audited.** `~/.vzt/browser/audit.log` (JSONL) records every vault
  access and approval decision — names only, never values.
- **Recorded trail.** Each session writes a JPEG screenshot per action +
  `actions.jsonl`; `session_gif` assembles a review GIF (needs ffmpeg).

## Config (`~/.vzt/browser/config.json`)

```json
{
  "alwaysAskDomains": ["your-bank.com", "stripe.com"],
  "sensitiveKeywords": ["cancel subscription", "grant access"]
}
```

## Environment

| Var | Default | Purpose |
|---|---|---|
| `VZT_BROWSER_HOME` | `~/.vzt/browser` | Data root |
| `VZT_BROWSER_APPROVAL` | `auto` | `auto` \| `off` |
| `VZT_BROWSER_READONLY` | `false` | `true` = evidence mode: hard-block mutations |
| `CHROMIUM_PATH` | — | Chrome binary if `channel:"chrome"` isn't found |

## Roadmap (fast-follow)

Auto-distill "Dreaming" via Anthropic API · TOTP credentials · standalone cron
runner (`cronLineFor`) · Stagehand-powered drift self-heal · Browserbase
transport for cloud scale · Linux `secret-tool` vault backend.
