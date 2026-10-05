import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The watch grant, on a DEPLOYMENT.
 *
 * `watch-ui.spec.ts` runs locally, where `watcherIsOwner` short-circuits
 * because there is no ALB and nothing to match — so the branches that actually
 * protect a conversation are unreachable there. This stands a deployment up:
 * a deploy `ASTRO_AUTHZ_TOKEN` whose issuer points at a stub authorize server,
 * and forged ALB identity headers, so `resolveIdentity` resolves a real
 * platform user and the token's binding is tested against it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8231;
const AUTHZ_PORT = 8232;
const BASE = `http://localhost:${PORT}`;

/** A deploy token: an `iss` the agent will call, and no `typ`. */
function deployToken(issuer: string): string {
  const payload = Buffer.from(JSON.stringify({ iss: issuer, sub: "dep_1" })).toString("base64url");
  return `h.${payload}.sig`;
}

/** The ALB's identity header, which is the only thing that names the caller. */
const asUser = (id: string) => ({ "x-amzn-oidc-identity": id });

let server: ChildProcess;
let authz: Server;

test.beforeAll(async () => {
  // Stands in for the control plane: echoes the identity back as the platform
  // user id, which is the contract `resolveIdentity` relies on.
  authz = createServer((req, res) => {
    const id = new URL(req.url ?? "", `http://x`).searchParams.get("identity_id") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ allowed: true, user_id: id }));
  });
  await new Promise<void>((r) => authz.listen(AUTHZ_PORT, r));

  server = spawn("node", ["agent/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      ADA_TEST_HOOKS: "1",
      ASTRO_AUTHZ_TOKEN: deployToken(`http://localhost:${AUTHZ_PORT}`),
      // Without an allowlist, `mayViewOthers` lets ANY authorized user read
      // any conversation — intended, but it would leave the ownership gate
      // disengaged and these assertions testing nothing.
      ADMIN_EMAILS: "admin@example.com",
      WORKSPACE_ROOT: join(ROOT, "test-results", "watch-authz-workspace"),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await fetch(BASE, { signal: AbortSignal.timeout(1_000) });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("agent did not start");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

test.afterAll(async () => {
  server?.kill("SIGKILL");
  await new Promise<void>((r) => authz.close(() => r()));
});

async function seed(userId: string): Promise<string> {
  const res = await fetch(`${BASE}/test/seed`, {
    method: "POST",
    headers: { "content-type": "application/json", ...asUser(userId) },
    body: JSON.stringify({ kind: "slack", userId }),
  });
  expect(res.status, "seeding must succeed").toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

async function watchLink(sessionId: string, userId: string): Promise<string> {
  const res = await fetch(`${BASE}/test/watch-link?session=${sessionId}&user=${userId}`, {
    headers: asUser(userId),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { url: string }).url;
}

const linkPath = (url: string) => url.slice(url.indexOf("/watch"));

test("a bad or expired link is refused", async () => {
  for (const q of ["?link=garbage", "?link=", ""]) {
    const res = await fetch(`${BASE}/watch${q}`, { redirect: "manual", headers: asUser("user_A") });
    expect(res.status, q || "(no link)").toBe(401);
  }
});

test("a valid link grants a cookie and opens the conversation", async () => {
  const sessionId = await seed("user_A");
  const res = await fetch(`${BASE}${linkPath(await watchLink(sessionId, "user_A"))}`, {
    redirect: "manual",
    headers: asUser("user_A"),
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/?watch=${sessionId}`);
  expect(res.headers.get("set-cookie") ?? "", "httpOnly, so script cannot read it").toContain("HttpOnly");
  expect(res.headers.get("set-cookie") ?? "").toContain("ada_watch=");
});

test("a link belongs to the person it was minted for, not whoever holds it", async () => {
  // The case that matters: a link posted in a Slack thread is visible to
  // everyone in it, so the token alone cannot be the whole answer.
  const sessionId = await seed("user_A");
  const link = linkPath(await watchLink(sessionId, "user_A"));

  const thief = await fetch(`${BASE}${link}`, { redirect: "manual", headers: asUser("user_B") });
  expect(thief.status, "signed in as someone else").toBe(401);

  const owner = await fetch(`${BASE}${link}`, { redirect: "manual", headers: asUser("user_A") });
  expect(owner.status).toBe(302);
});

test("a grant reaches only the conversation its token names", async () => {
  const mine = await seed("user_A");
  const other = await seed("user_A");
  const res = await fetch(`${BASE}${linkPath(await watchLink(mine, "user_A"))}`, {
    redirect: "manual",
    headers: asUser("user_A"),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

  const allowed = await fetch(`${BASE}/sessions/${mine}/events?lastEventId=-1`, {
    headers: { cookie, ...asUser("user_A") },
    signal: AbortSignal.timeout(5_000),
  });
  await allowed.body?.cancel();
  expect(allowed.status, "the conversation the token names").toBe(200);

  // Same user, same valid cookie, a different session they do not own.
  const refused = await fetch(`${BASE}/sessions/${other}/events?lastEventId=-1`, {
    headers: { cookie, ...asUser("user_B") },
    signal: AbortSignal.timeout(5_000),
  });
  await refused.body?.cancel();
  expect(refused.status, "a grant is not a key to every conversation").toBe(403);
});

test("a grant cannot drive or delete the conversation it can watch", async () => {
  // Read-only is meant to hold by construction: only `/` and the event stream
  // consult the grant at all.
  const sessionId = await seed("user_A");
  const res = await fetch(`${BASE}${linkPath(await watchLink(sessionId, "user_A"))}`, {
    redirect: "manual",
    headers: asUser("user_A"),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];

  const drive = await fetch(`${BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...asUser("user_B") },
    body: JSON.stringify({ prompt: "do something" }),
  });
  expect(drive.status, "driving is not watching").toBe(403);

  const del = await fetch(`${BASE}/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { cookie, ...asUser("user_B") },
  });
  expect(del.status, "nor is deleting").toBe(403);
});
