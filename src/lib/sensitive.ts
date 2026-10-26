// ---------------------------------------------------------------------------
// Sensitive-action classification. Aside only *implies* its approval gate;
// VZT-Browser enforces one. An action is sensitive when the URL, the target
// element's accessible name, or user config says so.
// ---------------------------------------------------------------------------

import { domainKey } from "./memory.js";
import { loadConfig } from "./paths.js";

const URL_KEYWORDS = [
  "checkout", "payment", "billing", "pay", "purchase", "order",
  "transfer", "withdraw", "wire", "invoice",
  "delete", "remove", "close-account", "deactivate",
  "settings/security", "password", "admin",
];

const NAME_KEYWORDS = [
  "buy", "pay", "pay now", "place order", "purchase", "checkout", "subscribe",
  "send", "submit order", "transfer", "withdraw", "confirm payment",
  "delete", "remove", "deactivate", "close account", "unsubscribe all",
  "post", "publish", "tweet", "reply all",
];

interface SensitivityVerdict {
  sensitive: boolean;
  reason: string;
}

export function classifySensitive(input: {
  url: string;
  elementName?: string;
  explicit?: boolean;
}): SensitivityVerdict {
  if (input.explicit) return { sensitive: true, reason: "caller flagged sensitive:true" };

  const config = loadConfig();
  const domain = domainKey(input.url);
  if (config.alwaysAskDomains.some((d) => domainKey(d) === domain)) {
    return { sensitive: true, reason: `domain ${domain} is on the always-ask list` };
  }

  // Match keywords as tokens (bounded by non-letters) so "pay" flags "/pay" and
  // "payment" but not "display"/"repayment"; matched against path+query+host only.
  const hasToken = (haystack: string, kw: string) =>
    new RegExp(`(?<![a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(haystack);

  let urlPart = input.url;
  try {
    const u = new URL(input.url);
    urlPart = `${u.hostname}${u.pathname}${u.search}`;
  } catch {
    // non-standard URL (e.g. data:) — fall back to the raw string
  }
  const urlHit = URL_KEYWORDS.find((k) => hasToken(urlPart, k));
  if (urlHit) return { sensitive: true, reason: `URL contains "${urlHit}"` };

  const name = (input.elementName ?? "").toLowerCase().trim();
  if (name) {
    const all = [...NAME_KEYWORDS, ...config.sensitiveKeywords.map((k) => k.toLowerCase())];
    const nameHit = all.find((k) => name === k || hasToken(name, k));
    if (nameHit) return { sensitive: true, reason: `element "${input.elementName}" matches "${nameHit}"` };
  }

  return { sensitive: false, reason: "" };
}
