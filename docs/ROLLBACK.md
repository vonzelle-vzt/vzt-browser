# Rollback

vzt-browser is a Node MCP server/CLI installed from GitHub (not yet on npm). It has no hosted deployment, mobile app, or database migrations.

## Roll back a release

1. Find the last good commit or tag: `git log --oneline` / `git tag`.
2. Revert the bad change on `main`: `git revert <sha>` and open a PR (or `git revert -m 1 <merge-sha>` for a merge commit).
3. Consumers pin a known-good version: `npm install github:vonzelle-vzt/vzt-browser#<tag-or-sha>`, then rebuild (`npm install` runs `prepare`).
4. If published to npm later: `npm deprecate @vzt-protocol/vzt-browser@<bad> "use <good>"` and publish a fixed patch (avoid `unpublish`).

## Local data

State lives under `VZT_BROWSER_HOME` (default `~/.vzt/browser`): profiles, site memory, audit logs. Nothing is migrated on upgrade; back up that directory before trying a risky version, and restore it when downgrading.

## Database migrations

None in this repo.
