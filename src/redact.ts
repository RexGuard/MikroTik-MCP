/**
 * Optional hiding of secrets (passwords, Wi-Fi passphrases, WireGuard/IPsec keys,
 * SNMP communities, ...) in tool results, so they never reach the AI model.
 * Enabled with MIKROTIK_HIDE_SENSITIVE=true.
 *
 * The idea and the set of sensitive key names come from wiresage/mikrotik-mcp
 * (src/mcp_mikrotik/sensitive.py), Copyright (c) 2024 Jeff Nasseri, MIT License.
 * This is an independent TypeScript implementation.
 */

export const REDACTED = "***";

const SENSITIVE_KEY =
  "(?:password|passphrase|private[-_. ]?key|pre[-_. ]?shared[-_. ]?key|preshared[-_. ]?key|shared[-_. ]?secret|" +
  "auth(?:entication)?[-_. ]?key|enc(?:ryption)?[-_. ]?key|token|secret|community)";

/** Property names such as `password`, `wpa2-pre-shared-key`, `private-key`, `secret`. */
const KEY_RE = new RegExp(`${SENSITIVE_KEY}$`, "i");
/** `key=value`, `key="value"` and `Key = value` inside free text (exports, scripts, configs). */
const QUOTED_RE = new RegExp(`(?<!\\w)(${SENSITIVE_KEY}\\s*[=:]\\s*)"(?:\\\\.|[^"\\\\\\n])*"`, "gi");
const BARE_RE = new RegExp(`(?<!\\w)(${SENSITIVE_KEY}\\s*[=:]\\s*)(?!")[^\\s"',;\\]}]+`, "gi");
const PEM_RE = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g;

export function isSensitiveKey(key: string): boolean {
  return KEY_RE.test(key);
}

export function redactText(text: string): string {
  return text.replace(PEM_RE, REDACTED).replace(QUOTED_RE, `$1"${REDACTED}"`).replace(BARE_RE, `$1${REDACTED}`);
}

/** Recursively hide secrets in a tool result: values of sensitive keys, and secrets inside strings. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, isSensitiveKey(k) && v !== "" && v != null ? REDACTED : redact(v)]),
    );
  }
  return value;
}

export function hideSensitiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env.MIKROTIK_HIDE_SENSITIVE ?? "").toLowerCase());
}
