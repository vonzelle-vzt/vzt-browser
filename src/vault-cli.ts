#!/usr/bin/env node

/**
 * vzt-browser-vault — terminal companion for the credential vault.
 * Lets the human store secrets with hidden input so they never pass
 * through any model context or shell history.
 *
 *   npx vzt-browser-vault add <name> [--note "..."]
 *   npx vzt-browser-vault list
 *   npx vzt-browser-vault delete <name>
 */

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { vaultStore, vaultList, vaultDelete } from "./lib/vault.js";

function readHidden(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    // Mute echo while the secret is typed.
    let muted = false;
    const mutable = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: mutable, terminal: true });
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

const [, , command, name] = process.argv;
const noteFlag = process.argv.indexOf("--note");
const note = noteFlag !== -1 ? process.argv[noteFlag + 1] : undefined;

switch (command) {
  case "add": {
    if (!name) {
      console.error("Usage: vzt-browser-vault add <name> [--note \"...\"]");
      process.exit(1);
    }
    const secret = await readHidden(`Secret for "${name}" (hidden): `);
    if (!secret) {
      console.error("Empty secret — nothing stored.");
      process.exit(1);
    }
    await vaultStore(name, secret, note);
    console.log(`Stored "${name}" in the macOS Keychain (service: vzt-browser).`);
    break;
  }
  case "list": {
    const entries = vaultList();
    if (entries.length === 0) console.log("Vault is empty.");
    for (const e of entries) console.log(`- ${e.name}${e.note ? `  (${e.note})` : ""}  updated ${e.updatedAt}`);
    break;
  }
  case "delete": {
    if (!name) {
      console.error("Usage: vzt-browser-vault delete <name>");
      process.exit(1);
    }
    console.log((await vaultDelete(name)) ? `Deleted "${name}".` : `No credential named "${name}".`);
    break;
  }
  default:
    console.log("Usage: vzt-browser-vault <add|list|delete> [name] [--note \"...\"]");
    process.exit(command ? 1 : 0);
}
