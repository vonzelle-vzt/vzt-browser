// ---------------------------------------------------------------------------
// JSONL audit trail — every credential access and every approval decision.
// This is what Aside lacks for team/regulated use: an inspectable record.
// Secrets are never written here, only credential NAMES.
// ---------------------------------------------------------------------------

import { appendFileSync } from "node:fs";
import { AUDIT_LOG, ROOT_DIR, ensureDir } from "./paths.js";

export interface AuditEntry {
  ts?: string;
  kind: "vault_read" | "vault_add" | "vault_fill" | "approval" | "replay";
  outcome: "ok" | "denied" | "error";
  detail: Record<string, unknown>;
}

export function audit(entry: AuditEntry): void {
  ensureDir(ROOT_DIR);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(AUDIT_LOG, line + "\n", "utf-8");
}
