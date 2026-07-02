// ---------------------------------------------------------------------------
// Credential vault — macOS Keychain via the `security` CLI (execFile, never
// shell-interpolated). The core contract of the whole tool: secret VALUES
// never enter the LLM context. Tool results carry only credential names and
// success/failure; errors are scrubbed. A names-only index lives in
// vault-index.json so vault_list works without dumping the keychain.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VAULT_DOMAINS, VAULT_INDEX, readJsonFile, writeJsonFile } from "./paths.js";
import { audit } from "./audit.js";

const execFileAsync = promisify(execFile);
const SERVICE = "vzt-browser";

interface VaultIndexEntry {
  name: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

function loadIndex(): VaultIndexEntry[] {
  return readJsonFile<VaultIndexEntry[]>(VAULT_INDEX, []);
}

function assertMac(): void {
  if (process.platform !== "darwin") {
    throw new Error("The credential vault currently requires macOS (Keychain via `security`).");
  }
}

export async function vaultStore(name: string, secret: string, note?: string): Promise<void> {
  assertMac();
  if (!name || !secret) throw new Error("Credential name and secret are required.");
  await execFileAsync("security", [
    "add-generic-password",
    "-U", // update if exists
    "-s", SERVICE,
    "-a", name,
    "-w", secret,
  ]);
  const index = loadIndex();
  const now = new Date().toISOString();
  const existing = index.find((e) => e.name === name);
  if (existing) {
    existing.updatedAt = now;
    if (note) existing.note = note;
  } else {
    index.push({ name, note, createdAt: now, updatedAt: now });
  }
  writeJsonFile(VAULT_INDEX, index);
  audit({ kind: "vault_add", outcome: "ok", detail: { credential: name } });
}

/** Server-side only — the returned secret must never be placed in a tool result. */
export async function vaultRead(name: string, context: Record<string, unknown>): Promise<string> {
  assertMac();
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", SERVICE,
      "-a", name,
      "-w",
    ]);
    audit({ kind: "vault_read", outcome: "ok", detail: { credential: name, ...context } });
    return stdout.replace(/\n$/, "");
  } catch {
    audit({ kind: "vault_read", outcome: "error", detail: { credential: name, ...context } });
    throw new Error(
      `Credential "${name}" not found in the vault. Add it with vault_add or: npx vzt-browser-vault add ${name}`,
    );
  }
}

export function vaultList(): Array<{ name: string; note?: string; updatedAt: string }> {
  return loadIndex().map(({ name, note, updatedAt }) => ({ name, note, updatedAt }));
}

export async function vaultDelete(name: string): Promise<boolean> {
  assertMac();
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", SERVICE, "-a", name]);
  } catch {
    return false;
  }
  writeJsonFile(VAULT_INDEX, loadIndex().filter((e) => e.name !== name));
  return true;
}

// --- first-use-per-domain tracking (drives the fill_credential approval gate)

export function isNewDomainForCredential(name: string, domain: string): boolean {
  const map = readJsonFile<Record<string, string[]>>(VAULT_DOMAINS, {});
  return !(map[name] ?? []).includes(domain);
}

export function rememberCredentialDomain(name: string, domain: string): void {
  const map = readJsonFile<Record<string, string[]>>(VAULT_DOMAINS, {});
  const domains = map[name] ?? [];
  if (!domains.includes(domain)) {
    map[name] = [...domains, domain];
    writeJsonFile(VAULT_DOMAINS, map);
  }
}
