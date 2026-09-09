import { test, expect } from "@playwright/test";
import { redactContent, redactString } from "../agent/telemetry/redact.ts";
import { contentPolicy } from "../agent/telemetry/otel.ts";

/**
 * The scrubber that makes trace content capture survivable.
 *
 * Ada exports prompts, completions and tool payloads now, so this is the thing
 * standing between a credential and the collector. Two failure modes matter and
 * they pull in opposite directions: a secret that gets through, and a scrubber
 * so eager that the trace it produces is unreadable and people go back to logs.
 * Both are covered here.
 */

const leaks = (s: string) => expect(redactString(s));

test("the credential shapes that actually appear in Ada's traces are scrubbed", () => {
  // The one Ada mints for itself on every clone — an App installation token.
  leaks("git clone https://x-access-token:ghs_ABCDEFGHIJKLMNOP0123456789@github.com/o/r").not.toContain("ghs_");
  // …and the host survives, because "it cloned from github.com" is the useful half.
  leaks("https://x-access-token:ghs_ABCDEFGHIJKLMNOP0123456789@github.com/o/r").toContain("github.com/o/r");

  leaks("token ghp_0123456789abcdefghijABCDEFGHIJ").not.toContain("ghp_0123");
  leaks("github_pat_11ABCDEFG0abcdefghijkl_LONGERSTRINGHERE1234").not.toContain("github_pat_11ABCDEFG");
  leaks("ANTHROPIC_API_KEY=sk-ant-api03-AAAAbbbbCCCCddddEEEE").not.toContain("sk-ant-api03");
  leaks("xoxb-1234567890-ABCDEFGHIJKLMNOP").not.toContain("xoxb-1234567890");
  leaks("AKIAIOSFODNN7EXAMPLE").not.toContain("AKIAIOSFODNN7EXAMPLE");
  leaks("Authorization: Bearer abcdef0123456789ghijkl").not.toContain("abcdef0123456789");
  leaks("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")
    .not.toContain("eyJzdWIiOiIxMjM0NTY3ODkw");
});

test("a private key block is removed whole, not chewed at the edges", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxx\nyyyyzzzz\n-----END RSA PRIVATE KEY-----";
  const out = redactString(`here is the deploy key:\n${pem}\ndone`);
  expect(out).not.toContain("MIIEowIBAAKCAQEA");
  expect(out).not.toContain("yyyyzzzz");
  // Still legible as "a private key was here".
  expect(out).toContain("PRIVATE KEY");
  expect(out).toContain("done");
});

test("an assignment keeps its key and loses its value", () => {
  // Keeping the key is what makes a trace readable: you can see a token was
  // passed to the command, which is usually the fact you needed.
  const out = redactString("run with API_KEY=supersecretvalue123 --verbose");
  expect(out).toContain("API_KEY=");
  expect(out).not.toContain("supersecretvalue123");
  // An unquoted value ends at whitespace, so the rest of the command survives.
  expect(out, "later flags are not eaten").toContain("--verbose");

  const json = redactString('{"api_key": "abcd1234efgh", "repo": "astropods/ada"}');
  expect(json).not.toContain("abcd1234efgh");
  expect(json, "unrelated fields are untouched").toContain("astropods/ada");
});

test("the scrubber does not eat the content people open a trace to read", () => {
  // This is the other failure mode, and the reason the patterns are anchored on
  // structure rather than on entropy.
  const command = "npm test -- --grep 'thread context' && git commit -m 'fix: ordering'";
  expect(redactString(command)).toBe(command);

  // A git SHA is high-entropy and is not a secret.
  const sha = "checked out 4674caeb1f2a9c3d5e6f7a8b9c0d1e2f3a4b5c6d";
  expect(redactString(sha)).toBe(sha);

  // Prose that merely mentions a token must survive — no assignment operator.
  const prose = "the token is refreshed on every turn, so a stale secret is not a concern";
  expect(redactString(prose)).toBe(prose);

  // Source code is content, not credentials. It is exported deliberately.
  const code = "const rec = await this.store.getGithubToken(options.userId);";
  expect(redactString(code)).toBe(code);
});

test("structure is preserved, so a trace UI still renders the shape", () => {
  const out = redactContent({
    role: "assistant",
    content: [{ type: "text", text: "cloning with ghp_0123456789abcdefghijABCDEFGHIJ" }],
    usage: { input: 12, output: 3 },
    ok: true,
    nothing: null,
  }) as Record<string, unknown>;

  expect(out.role, "strings that are clean pass through").toBe("assistant");
  expect(out.usage, "numbers are left alone").toEqual({ input: 12, output: 3 });
  expect(out.ok).toBe(true);
  expect(out.nothing).toBeNull();
  expect(JSON.stringify(out)).not.toContain("ghp_0123");
  expect(Array.isArray(out.content), "arrays stay arrays").toBe(true);
});

test("a key that names a secret drops its value whatever shape it is", () => {
  // `{ token: "…" }` puts the key OUTSIDE the string, where the assignment
  // pattern cannot see it — so the walk checks keys as well as values.
  const out = redactContent({
    token: "plainlookingvalue",
    githubToken: { nested: "still-a-secret" },
    Authorization: "anything at all",
    description: "clone the repo",
  }) as Record<string, unknown>;

  expect(out.token).toBe("[redacted]");
  expect(out.githubToken).toBe("[redacted]");
  expect(out.Authorization).toBe("[redacted]");
  expect(out.description, "an innocent key is untouched").toBe("clone the repo");
});

test("a pathological structure cannot take the agent's process down with it", () => {
  // Content is whatever the framework projected. A trace export must not be
  // able to blow the stack inside the process it is instrumenting.
  const cyclic: Record<string, unknown> = { name: "root" };
  cyclic.self = cyclic;
  expect(() => redactContent(cyclic)).not.toThrow();

  let deep: unknown = "leaf";
  for (let i = 0; i < 200; i++) deep = { next: deep };
  expect(() => redactContent(deep)).not.toThrow();
});

test("the kill switch turns content capture off without a deploy", () => {
  // The safety valve for the trade this feature makes. `installTelemetry`
  // registers process-global providers and runs once, so the switch is checked
  // here rather than through it.
  const on = contentPolicy({} as NodeJS.ProcessEnv);
  expect(on, "content is captured by default").not.toBe(false);
  expect(typeof (on as { transform: unknown }).transform, "…through the scrubber").toBe("function");
  // And the transform that gets installed is the real one.
  expect(
    (on as { transform(c: unknown): unknown }).transform("ghp_0123456789abcdefghijABCDEFGHIJ"),
  ).toBe("[redacted]");

  for (const value of ["off", "OFF", "0", "false"]) {
    expect(contentPolicy({ ADA_TRACE_CONTENT: value } as NodeJS.ProcessEnv), value).toBe(false);
  }
  // An unrecognised value must not silently disable it — failing open on the
  // operator's stated intent is the wrong direction for a typo.
  expect(contentPolicy({ ADA_TRACE_CONTENT: "yes" } as NodeJS.ProcessEnv)).not.toBe(false);
});
