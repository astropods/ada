/**
 * Secret scrubbing for trace content.
 *
 * Ada now exports prompts, completions and tool payloads to the collector (see
 * telemetry/otel.ts). That is a deliberate trade — a trace that cannot show
 * which command the agent ran is not much of a trace — and this module is the
 * mitigation that makes it survivable: everything on its way to a span goes
 * through here first.
 *
 * ── What this is, and what it is not ─────────────────────────────────────
 *
 * It is a pattern scrubber for CREDENTIALS: the shapes that are catastrophic
 * to leak and mechanically recognisable. It is NOT a general privacy filter.
 * Source code, filenames, ticket numbers, customer identifiers and anything
 * else a private repository contains WILL reach the collector, because that is
 * the content the operator asked to see. Treat the collector as holding
 * repository contents, and scope its retention and access accordingly.
 *
 * Nor is it complete even for credentials. A high-entropy string with no
 * recognisable prefix and no `key=` around it is indistinguishable from a
 * hash, a git SHA or a base64 blob, and guessing costs more than it saves —
 * the failure mode of an over-eager scrubber is a trace with the useful parts
 * removed, which sends people back to reading logs. What is here is the set of
 * shapes worth being confident about.
 *
 * Set `ADA_TRACE_CONTENT=off` to send no content at all.
 */

/** What replaces a match. Keeps the shape visible so a trace still reads. */
const MASK = "[redacted]";

/**
 * Ordered patterns. Each is anchored on something structural — a vendor
 * prefix, an assignment, a URL's credential slot — rather than on entropy,
 * because entropy alone cannot tell a token from a commit hash.
 */
const PATTERNS: Array<{ name: string; re: RegExp; replace?: (m: string, ...g: string[]) => string }> = [
  // PEM private keys. First, because the body would otherwise be chewed on by
  // every later pattern and the block is unmistakable.
  {
    name: "private-key",
    re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replace: () => `-----BEGIN PRIVATE KEY-----${MASK}-----END PRIVATE KEY-----`,
  },

  // GitHub. `ghs_` is the one Ada mints for itself on every clone — an App
  // installation token — so this is the pattern most likely to actually fire.
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g },

  // Credentials in a URL, including the `x-access-token:<tok>@github.com`
  // form that `cloneCommand` builds. The host is kept: knowing the agent
  // cloned from github.com is the useful half.
  {
    name: "url-credentials",
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(:[^/\s@]*)?@/gi,
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`,
  },

  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google-key", re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },

  // JWTs — three base64url segments. Session and identity tokens land here.
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },

  // `Authorization: Bearer <anything>` and friends.
  {
    name: "auth-header",
    re: /\b(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*\S+/gi,
    replace: (_m, head: string) => `${head}${MASK}`,
  },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: () => `Bearer ${MASK}` },

  /**
   * Assignment shapes: `SECRET=…`, `"api_key": "…"`, `--password …`.
   *
   * The catch-all, and the one that has to be careful. It keeps the KEY — which
   * is what makes a trace readable, since seeing that a token was passed is
   * usually the fact you needed — and masks only the value. A quoted value ends
   * at the quote; an unquoted one ends at whitespace, so a shell command keeps
   * its later flags.
   *
   * The separator swallows a closing quote on the KEY, because the JSON form
   * (`"api_key": "…"`) puts one between the name and the colon and the pattern
   * silently matched nothing without it.
   *
   * The lookahead is what stops this undoing an earlier pattern's work. Run
   * after `url-credentials`, `https://x-access-token:[redacted]@github.com/o/r`
   * reads as `x-access-token` = `[redacted]@github.com/o/r` — so the host, the
   * one genuinely useful part of that URL, was being masked as part of the
   * value. Anything already masked is left alone.
   *
   * Requiring a real assignment operator (or a 4+ character value after
   * whitespace) is what keeps prose like "the token is fine" intact.
   */
  {
    name: "assignment",
    re: /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*|\s+)(["']?)(?!\[redacted\])([^\s"'&]{4,})\3/gi,
    replace: (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${MASK}${quote}`,
  },
];

/** Scrub one string. Exported for tests; `redactContent` is the entry point. */
export function redactString(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    // `replace` handles both arities: a plain mask, or a callback that keeps a
    // structural prefix (the key, the scheme, the header name).
    out = p.replace ? out.replace(p.re, p.replace as never) : out.replace(p.re, MASK);
  }
  return out;
}

/**
 * The depth at which we stop walking and drop the value.
 *
 * Content arrives as whatever the framework projected — message arrays, tool
 * argument objects, nested tool results. A cyclic or pathologically deep
 * structure must not turn a trace export into a stack overflow inside the
 * agent's own process, and content this deep is not being read by a human
 * anyway.
 */
const MAX_DEPTH = 12;

/**
 * Walk any content value and scrub every string in it.
 *
 * Structure is preserved — the framework serializes this into a span attribute
 * and a trace UI renders the shape — so this rebuilds objects and arrays rather
 * than stringifying. Non-string leaves (numbers, booleans, null) pass through:
 * they cannot carry a credential in any form this can recognise.
 */
export function redactContent(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactString(value);
  if (value == null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) return value.map((v) => redactContent(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // A key that NAMES a secret has its value dropped whole, whatever shape the
    // value is. The assignment pattern above only sees strings that carry their
    // own key; `{ token: "…" }` puts the key outside the string, where it can't.
    out[k] = /secret|token|password|passwd|api[_-]?key|access[_-]?key|credential|authorization/i.test(k)
      ? MASK
      : redactContent(v, depth + 1);
  }
  return out;
}
