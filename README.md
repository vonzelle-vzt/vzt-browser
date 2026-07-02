<h1 align="center">VZT-Browser</h1>

<p align="center">
  <b>An Aside-class browser agent — MCP · CLI · REPL — with its gaps filled.</b><br>
  Works across your real logged-in sites. Secrets never touch the model. Nothing changes unless you allow it.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-three-surfaces">Surfaces</a> ·
  <a href="#tool-reference-48">Tools</a> ·
  <a href="#safety-model">Safety</a> ·
  <a href="#how-it-works">How it works</a>
</p>

---

## About

**VZT-Browser gives an AI agent a real browser that's already logged into your accounts** — Gmail, GitHub, your CI, dashboards, staging, internal admin tools — and lets it do useful work there: gather review evidence, fill forms, run flows, verify claims, and remember what it learned.

It's an open, self-hostable alternative to [Aside](https://aside.com). Aside is a closed macOS app with no open API, an approval gate it only *implies*, and no audit trail. VZT-Browser matches Aside's whole advertised surface — **CLI, MCP, and REPL for private browser evidence** — as an open tool any model or app can drive, and goes further where it counts:

- **Secrets never enter the model's context.** Credentials live in the macOS Keychain; VZT-Browser types them into the page and returns only success/failure.
- **"Do not change anything" is enforced, not requested.** A read-only *evidence mode* hard-blocks mutations at the tool layer.
- **Everything is auditable.** A JSONL log records every credential access and approval decision.
- **Bring your own model.** The MCP client's model does the reasoning against accessibility snapshots — no server-side API key for core operation, no usage credits.

Built on [`playwright-core`](https://playwright.dev). macOS-first (Keychain vault, dialog fallback); the browser automation itself is cross-platform.

---

## Why

| What you want | Aside | VZT-Browser |
|---|---|---|
| Work on your logged-in sites | ✅ | ✅ persistent Chrome profile (`launchPersistentContext`) |
| Local markdown memory ("Dreaming") | ✅ | ✅ per-site **and** cross-task, auto-injected, editable |
| Agent password manager | ✅ | ✅ macOS Keychain — **secret never in model context** |
| CLI · MCP · REPL | ✅ | ✅ all three, sharing the same stable element refs |
| Approval before sensitive actions | *implied* | ✅ **enforced** (MCP elicitation → macOS dialog) |
| Guaranteed "do not change" | asks the model | ✅ **hard read-only mode** at the tool layer |
| Audit trail | ❌ | ✅ JSONL of every credential access + approval |
| Scheduling / recurring runs | ❌ | ✅ record → deterministic replay; monitor-until-threshold |
| Open API / composable | ❌ closed app | ✅ MCP server + CLI, BYO model, self-hosted |
| Browsing-history recall | ✅ | ✅ reads the profile's real Chrome history (`node:sqlite`) |

---

## Install

Requires **Node ≥ 20** (≥ 22.5 for browsing-history recall) and **Google Chrome** (falls back to `CHROMIUM_PATH` or Playwright's bundled Chromium).

### As an MCP server

Add to your MCP client config (`.mcp.json`, `claude_desktop_config.json`, Cursor, etc.):

```jsonc
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

### From source

```bash
git clone https://github.com/vonzelle-vzt/vzt-browser.git
cd vzt-browser
npm install
npm run build
# MCP server:  node dist/index.js
# CLI:         node dist/cli.js --help   (or: npm link  →  vzt-browser-cli)
```

All state lives under `~/.vzt/browser/` (override with `VZT_BROWSER_HOME`).

---

## Quick start

```
1. Log in once      login_mode({ url: "https://github.com/login" })  → sign in by hand → session_stop
2. Automate         session_start()  → snapshot → click / fill → get_text
3. Store a secret   npx vzt-browser-vault add github-password        (hidden input; never seen by the model)
4. Use it           fill_credential({ name: "github-password", selector: "#password", pressEnter: true })
5. Teach it         save_site_memory(...)   → auto-injected next visit
6. Record + replay  record_save({ task: "..." })  → replay_task({ task: "..." })   (no LLM on replay)
```

The login persists forever (cookies + localStorage) in the profile, so step 2 onward can run fully headless.

---

## The three surfaces

### MCP — for your coding agent

48 tools your agent calls without leaving the editor. The agent reads the page with `snapshot` (an accessibility tree plus stable `[ref=vN]` handles) and acts with `click` / `fill` / `fill_credential` / etc.

### CLI — a browser check inside a dev workflow

```bash
vzt-browser-cli open https://example.com          # → title/url
vzt-browser-cli snapshot                          # aria tree + stable refs
vzt-browser-cli text ".pricing"                   # readable text of a selector
vzt-browser-cli shot out.jpg --full               # full-page screenshot
vzt-browser-cli eval "getComputedStyle(document.querySelector('.card')).transition"
vzt-browser-cli evidence https://ci.example.com/run/74288420 \
     --template ci-triage --title "PR #482 CI" --readonly
vzt-browser-cli monitor https://status.example.com --text-appears "Incident" --every 30000 --for 900000
vzt-browser-cli login https://github.com/login    # headed, log in once
vzt-browser-cli repl https://example.com          # interactive REPL
```

Global flags: `--profile <name>` (default `default`), `--headed`, `--readonly`, `--keep` (leave the browser open).

### REPL — deterministic Playwright-like inspection

```
$ vzt-browser-cli repl https://example.com
vzt> await snap()                      // aria tree + [ref=vN] list
vzt> await ref('v3').click()           // the exact element you saw in snap()
vzt> await $('h1').textContent()       // raw Playwright locator
vzt> await shot()                      // screenshot to a file
vzt> tabs(); net({ failuresOnly:true }); errors(); downloads()
vzt> await evidence('quick look')      // build an evidence bundle
```

The refs from `snap()` are the **same** ones the agent and the MCP `snapshot` use, so what you click in the REPL is what the agent will act on.

---

## Signature workflows

### Review evidence (never changes anything)

`collect_evidence` opens private pages (CI run, PR, Sentry, feature-flag dashboard, staging) and produces a **reviewable bundle** — full-page screenshots, captured **log links** (failing network requests), console errors, downloaded files, and a markdown **note** scaffolded for the job. Templates: `ci-triage`, `pr-packet`, `qa`, `flag-audit`, `incident`, `generic`.

Pair it with a read-only session (`readOnly: true`, `VZT_BROWSER_READONLY=true`, or CLI `--readonly`) for a hard guarantee: fills, selects, and state-changing clicks are blocked at the tool layer; navigation, screenshots, `eval_js`, and monitoring still work.

### Research & claim-drift

Schema-first, like Aside — declare the fields before browsing, then compare runs:

- `research_define_table` — schema (default: `claim, sourceUrl, publisher, dateAccessed, screenshot, status, oldClaim`). Re-defining the same name keeps rows + baseline, so a weekly run compares against the same method.
- `research_capture_source` — open a source read-only, screenshot it, hand back page text/snapshot so **you** extract the fields.
- `research_upsert_row` — store the extracted row with a status (`verified` / `changed` / `missing` / `needs-review`).
- `research_diff` — the **drift report**: changed / missing / new claims vs the last run (e.g. *"Free plan includes 10 seats" → "5 seats"*). `promote:true` sets a new baseline.
- `research_export` — CSV or Markdown.

### Memory that keeps learning

- **Site memory** (`save_site_memory`) — the path that worked on a site; auto-injected next visit.
- **Dreaming** (`remember`) — cross-task people/companies/decisions → `~/.vzt/browser/memory/_workspace.md`, auto-injected at every `session_start`.
- **History recall** (`search_history`) — queries this profile's real Chrome history ("find the page I opened yesterday"); reopen with `navigate`.
- **Inspectable** (`show_memory`) — every memory file is plain markdown on disk. Open it, edit it, delete a wrong line.

---

## Tool reference (48)

| Group | Tools |
|---|---|
| **Session** | `session_start` (`readOnly`, `headed`, `video`), `session_stop`, `login_mode` |
| **Navigate / read** | `navigate`, `snapshot` (aria tree + stable `[ref=vN]`), `screenshot`, `get_text` |
| **Act** | `click`, `fill`, `fill_credential`, `press_key`, `select_option`, `wait_for`, `hover` |
| **Inspect** | `set_viewport` (desktop/tablet/mobile), `list_tabs`, `new_tab`, `switch_tab`, `eval_js`, `read_console`, `read_network`, `list_downloads` |
| **Evidence** | `collect_evidence`, `monitor_page` |
| **Research / drift** | `research_define_table`, `research_capture_source`, `research_upsert_row`, `research_diff`, `research_export`, `research_list_tables`, `research_get_table`, `research_delete_table` |
| **Memory** | `save_site_memory`, `list_site_memory`, `get_site_memory`, `delete_site_memory`, `remember`, `show_memory`, `search_history` |
| **Vault** | `vault_add`, `vault_list`, `vault_delete` |
| **Record / replay** | `record_save`, `task_list`, `task_delete`, `replay_task` |
| **Review** | `session_gif`, `audit_log_path` |

### CLI binaries

| Binary | Purpose |
|---|---|
| `vzt-browser` | the MCP stdio server |
| `vzt-browser-cli` | CLI + REPL |
| `vzt-browser-vault` | store/list/delete credentials from the terminal (hidden input) |

---

## Safety model

- **Secrets never reach the model.** `fill_credential` reads from the Keychain server-side, types via the keyboard, and returns only `{ filled: true }`. Errors are scrubbed of the secret. `fill` refuses `type=password` fields.
- **Enforced approval.** Actions classified sensitive — checkout/payment/delete URLs, buy/pay/send/delete button names, always-ask domains, or the first use of a credential on a new domain — pause for a human via MCP elicitation, falling back to a macOS dialog. `VZT_BROWSER_APPROVAL=off` disables gating (e.g. trusted cron replays).
- **Read-only evidence mode.** `readOnly: true` blocks fills, selects, and state-changing clicks entirely — a real "do not change" guarantee for review and monitoring tasks.
- **Everything audited.** `~/.vzt/browser/audit.log` (JSONL) records every vault access and approval decision — credential *names* only, never values.
- **Recorded trail.** Each session writes a JPEG screenshot per action + `actions.jsonl`; `session_gif` assembles a review GIF (needs `ffmpeg`).

---

## Configuration

### `~/.vzt/browser/config.json`

```json
{
  "alwaysAskDomains": ["your-bank.com", "stripe.com"],
  "sensitiveKeywords": ["cancel subscription", "grant access"]
}
```

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `VZT_BROWSER_HOME` | `~/.vzt/browser` | Data root (profiles, memory, tasks, sessions, vault index, audit log) |
| `VZT_BROWSER_APPROVAL` | `auto` | `auto` (elicitation → dialog) \| `off` |
| `VZT_BROWSER_READONLY` | `false` | `true` = evidence mode: hard-block mutations |
| `CHROMIUM_PATH` | — | Chrome binary if the `chrome` channel isn't found |

### Data layout

```
~/.vzt/browser/
├── profiles/<name>/        persistent Chrome user-data dirs (your logins)
├── memory/<domain>.md      per-site memory ("Dreaming")
├── memory/_workspace.md    cross-task memory
├── tasks/<slug>.json       recorded, replayable tasks
├── sessions/<id>/          screenshot trail + actions.jsonl (+ evidence, downloads)
├── research/<name>.json    schema-first evidence tables
├── vault-index.json        credential NAMES + notes (never secret values)
├── audit.log               JSONL audit trail
└── config.json             always-ask domains, extra sensitive keywords
```

---

## How it works

- **Engine:** `playwright-core` directly. The MCP client's model reasons over accessibility snapshots — no server-side LLM key for core operation.
- **Persistent profiles:** `launchPersistentContext` on a dedicated profile with a PID lockfile (one live context per profile). Your everyday Chrome is untouched.
- **Stable refs:** `playwright-core` exposes no ref engine, so VZT-Browser injects its own `data-vzt-ref` attributes; `snapshot.refs` lists them and `[data-vzt-ref="vN"]` resolves them — identical across snapshot, click, and the REPL. Refs reset on navigation.
- **Vault:** macOS Keychain via the `security` CLI (arguments passed via `execFile`, never shell-interpolated). `vault_add` captures the secret through a headed local form or the `vzt-browser-vault` terminal tool.
- **Replay:** the recorder logs each mutating action with a stable selector; `replay_task` runs steps deterministically and, on drift (selector no longer matches uniquely, or the accessible name changed), stops and returns the failure point + a snapshot so the agent can finish and re-save.
- **History recall:** reads a copy of the profile's Chrome `History` SQLite DB via Node's built-in `node:sqlite`, converting Chrome's 1601-epoch microsecond timestamps.

---

## Roadmap

Auto-distill "Dreaming" via an LLM · TOTP credentials · standalone cron runner · Stagehand-powered drift self-heal · Browserbase transport for cloud scale · Linux `secret-tool` vault backend · publish to npm.

---

## License

[MIT](./LICENSE) © Vonzelle Brown / VZT Tech Consulting
