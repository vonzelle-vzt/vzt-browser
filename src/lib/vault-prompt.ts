// ---------------------------------------------------------------------------
// Headed secret capture — vault_add opens a local form page in the persistent
// context; the human types the secret there. The value travels page ->
// server process -> Keychain and never through the LLM.
// ---------------------------------------------------------------------------

import type { BrowserContext } from "playwright-core";

const CAPTURE_HTML = (name: string) => `<!doctype html>
<html><head><title>VZT-Browser vault</title><style>
  body { font: 15px -apple-system, sans-serif; background:#0d1117; color:#e6edf3;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:32px; width:380px; }
  h1 { font-size:17px; margin:0 0 6px; } p { color:#8b949e; font-size:13px; margin:0 0 18px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px;
          border:1px solid #30363d; background:#0d1117; color:#e6edf3; font-size:15px; }
  button { margin-top:14px; width:100%; padding:10px; border-radius:8px; border:0;
           background:#238636; color:#fff; font-size:15px; cursor:pointer; }
</style></head><body>
  <form class="card" onsubmit="event.preventDefault();
      window.__vztSecret = document.getElementById('s').value;
      window.__vztDone = true;
      document.body.innerHTML = '<p style=&quot;color:#3fb950&quot;>Saved to Keychain. You can close this tab.</p>';">
    <h1>Store credential: ${name.replace(/[<>&"]/g, "")}</h1>
    <p>Typed here, saved straight to your macOS Keychain. The AI never sees this value.</p>
    <input id="s" type="password" autofocus placeholder="Secret value" />
    <button type="submit">Save to Keychain</button>
  </form>
</body></html>`;

export async function captureSecretHeaded(context: BrowserContext, name: string, timeoutMs = 120_000): Promise<string> {
  const page = await context.newPage();
  try {
    await page.setContent(CAPTURE_HTML(name));
    await page.bringToFront().catch(() => {});
    await page.waitForFunction(() => (window as unknown as { __vztDone?: boolean }).__vztDone === true, undefined, {
      timeout: timeoutMs,
    });
    const secret = await page.evaluate(() => {
      const w = window as unknown as { __vztSecret?: string };
      const v = w.__vztSecret ?? "";
      w.__vztSecret = ""; // clear from page memory
      return v;
    });
    if (!secret) throw new Error("Empty secret submitted.");
    return secret;
  } finally {
    await page.close().catch(() => {});
  }
}
