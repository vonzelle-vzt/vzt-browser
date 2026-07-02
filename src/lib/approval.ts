// ---------------------------------------------------------------------------
// Human approval gate. Priority:
//   1. MCP elicitation (spec-correct; the human answers, the model can't
//      self-approve) — requires an elicitation-capable client (Claude Code).
//   2. macOS dialog via osascript — true out-of-band gate.
// VZT_BROWSER_APPROVAL=off disables gating (e.g. trusted cron replays).
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";

const execFileAsync = promisify(execFile);

export interface ApprovalRequest {
  action: string; // e.g. 'click "Place order"'
  url: string;
  reason: string;
}

let mcpServer: McpServer | null = null;
export function setApprovalServer(server: McpServer): void {
  mcpServer = server;
}

async function elicitApproval(req: ApprovalRequest): Promise<boolean | null> {
  if (!mcpServer) return null;
  try {
    const result = await mcpServer.server.elicitInput({
      message:
        `VZT-Browser wants to perform a SENSITIVE action:\n` +
        `  Action: ${req.action}\n  Page: ${req.url}\n  Why flagged: ${req.reason}\n\nApprove?`,
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Approve this action", description: "true to allow, false to deny" },
        },
        required: ["approve"],
      },
    });
    if (result.action !== "accept") return false;
    return Boolean((result.content as { approve?: boolean } | undefined)?.approve);
  } catch {
    return null; // client doesn't support elicitation — fall through
  }
}

async function osascriptApproval(req: ApprovalRequest): Promise<boolean | null> {
  if (process.platform !== "darwin") return null;
  const text = `VZT-Browser sensitive action:\n\n${req.action}\n\nPage: ${req.url}\nFlagged: ${req.reason}`
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      `display dialog "${text}" buttons {"Deny", "Approve"} default button "Deny" with icon caution with title "VZT-Browser approval"`,
    ]);
    return stdout.includes("Approve");
  } catch {
    return false; // user hit Deny (osascript exits non-zero) or dialog failed
  }
}

/**
 * Request approval for a sensitive action. Returns true when approved.
 * Every decision is written to the audit log.
 */
export async function requestApproval(req: ApprovalRequest): Promise<boolean> {
  const mode = (process.env.VZT_BROWSER_APPROVAL ?? "auto").toLowerCase();
  let approved: boolean;
  let via: string;

  if (mode === "off") {
    approved = true;
    via = "disabled";
  } else {
    const elicited = await elicitApproval(req);
    if (elicited !== null) {
      approved = elicited;
      via = "elicitation";
    } else {
      const dialog = await osascriptApproval(req);
      approved = dialog === true;
      via = dialog === null ? "no-mechanism-deny" : "osascript";
    }
  }

  audit({
    kind: "approval",
    outcome: approved ? "ok" : "denied",
    detail: { action: req.action, url: req.url, reason: req.reason, via },
  });
  return approved;
}
