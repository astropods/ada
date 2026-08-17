/**
 * Application entry — the project's route map.
 *
 *   GET  /                         -> built-in AG-UI test client (public/index.html)
 *   POST /sessions {prompt,...}    -> {sessionId} (starts a new multi-turn session)
 *   POST /sessions/:id/messages    -> continue a session with a follow-up turn
 *   DELETE /sessions/:id           -> drop a session (log, workspace, Flue state)
 *   GET  /sessions/:id/events      -> SSE AG-UI stream; honours Last-Event-ID
 *   GET  /conversations            -> list handled conversations (admin-gated)
 *   GET  /auth/github/login        -> 302 to GitHub App authorize (?link=<t> connects a chat user)
 *   GET  /auth/github/callback     -> code exchange; stores the user's token
 *   GET  /auth/github/status       -> { connected, login, configured }
 *   GET  /api/whoami               -> { userId, email, admin, github... }
 *   GET  /api/github/repos         -> { connected, installations: [...], appSlug }
 *   GET  /api/setup/status         -> { configured, appSlug }
 *   GET  /api/setup/github/start   -> manifest auto-POST page (provision-gated)
 *   GET  /api/setup/github/callback-> manifest-code exchange; stores App creds
 *   ALL  /agents/ada/*             -> Flue's native agent routes (see below)
 *
 * Two front doors, deliberately. `/sessions/*` is Ada's own AG-UI-over-SSE
 * contract, which `public/index.html`, the messaging adapter, and external
 * AG-UI clients (CopilotKit et al.) speak — it is preserved verbatim across the
 * Flue rewrite. `/agents/ada/*` is Flue's native router, mounted alongside so
 * `@flue/sdk` clients and Flue tooling work out of the box. Both address the
 * SAME durable instances by id, so a session started over one is readable over
 * the other.
 *
 * GitHub App provisioning is web-driven: an authorized user clicks "Set up
 * GitHub App" in the UI, and the two setup routes drive GitHub's App-Manifest
 * flow to create the App (auth/setup.ts). Who may provision is governed by
 * canProvision: admins (ADMIN_EMAILS, matched against the ALB-verified email),
 * or — when no admin list is set — any signed-in user for the initial setup
 * only. Resolved creds live in auth/app-config.ts (stored in the DB).
 *
 * SCAFFOLD skeleton — CSRF-state GC, cookie signing, token encryption-at-rest,
 * backpressure, and session GC are marked TODO.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createAgentRouter } from "@flue/runtime/routing";
import type { FlueEvent } from "@flue/runtime";
import { Ada } from "./agents/ada.ts";
import { Translator } from "./translate/translator.ts";
import { describeAuth } from "./config/model.ts";
import { SessionRegistry } from "./session/registry.ts";
import { SessionRunner } from "./session/runner.ts";
import { startWorkspaceGc } from "./session/workspace.ts";
import { createTelemetry } from "./telemetry/otel.ts";
import { InMemoryResultStore } from "./persistence/results.ts";
import { createStore, type Store } from "./store/index.ts";
import { authorizeUrl, exchangeCode, listConnectedRepos } from "./auth/github-app.ts";
import { githubConfigured, getAppCreds, saveAppCreds, loadAppCreds } from "./auth/app-config.ts";
import {
  verifyState, buildManifest, convertManifestCode, renderManifestForm,
  isAdmin, adminListConfigured, canProvision,
} from "./auth/setup.ts";
import { getServerSecret, mintLink, verifyLink } from "./auth/connect.ts";
import { resolveBaseUrl } from "./auth/base-url.ts";
import { Authorizer, oidcIdentity, oidcEmail, type AuthzResult } from "./auth/authz.ts";
import { SSE_HEADERS, frameLogged, sseHeartbeat, parseLastEventId } from "./transport/sse.ts";
import { render401, renderPage } from "./transport/pages.ts";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/* ---------------- shared runtime ---------------- */

export const registry = new SessionRegistry();
const resultStore = new InMemoryResultStore();

/**
 * How long an OAuth round-trip may take. Generous because it spans GitHub's
 * install and repo-picker screens, not just a consent click.
 */
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;
/** Guards the one automatic retry below; short-lived, cleared on settle. */
const RETRY_COOKIE = "gh_connect_retry";
/** Manual-authz client: resolves the platform user id the sidecar keys chat on. */
const authorizer = new Authorizer();

let store: Store;
let runner: SessionRunner;

/**
 * One-time process bootstrap.
 *
 * Kicked off eagerly at module scope AND awaited by every request. Both,
 * deliberately:
 *
 *   - Eagerly, because the messaging sidecar registers in here. A deploy whose
 *     traffic arrives over Slack rather than HTTP would otherwise never
 *     register, and chat would silently never work.
 *   - Awaited per request, because the eager call is fire-and-forget: a request
 *     that lands mid-boot must still see a resolved `store`/`runner`.
 *
 * NOT a top-level `await`: Vite's generated entry imports this module before
 * the server listens, and blocking module evaluation on a Postgres connection
 * would turn a slow database into a failure to start at all.
 */
let booted: Promise<void> | null = null;
function boot(): Promise<void> {
  booted ??= (async () => {
    // NB: providers are registered at agent-module scope (agents/ada.ts), which
    // this module imports — so they are already in place by the time any route
    // can run, on every entry point including `flue run`.
    const telemetry = await createTelemetry();
    store = await createStore();
    await loadAppCreds(store);
    await getServerSecret(store); // stable HMAC secret for messaging connect links
    runner = new SessionRunner(registry, store, telemetry, resultStore);
    runner.start();

    console.log(`[ada] ${describeAuth()}`);
    console.log(
      `[ada] github: ${
        githubConfigured()
          ? `GitHub App OAuth configured${getAppCreds()?.slug ? ` (${getAppCreds()!.slug})` : ""}`
          : "not configured — an admin can provision it from the web UI"
      }`,
    );
    await startMessaging();
    // Reclaim idle per-thread workspaces so multi-repo checkouts don't fill the disk.
    startWorkspaceGc();
  })();
  return booted;
}

/** Accessors for modules wired after boot (the messaging adapter). */
export function getRunner(): SessionRunner {
  return runner;
}
export function getStore(): Store {
  return store;
}

/* ---------------- messaging (web / Slack via the sidecar) ---------------- */

/**
 * Register Ada as an AgentAdapter with the platform's messaging sidecar so
 * users can converse over Slack / web chat. The sidecar injects
 * GRPC_SERVER_ADDR only when `agent.interfaces.messaging: true` is deployed;
 * outside that there is nothing to bind to, so this is a no-op.
 * `@astropods/adapter-core` and the adapter are imported dynamically so the
 * process runs without the package present.
 */
async function startMessaging(): Promise<void> {
  if (!process.env.GRPC_SERVER_ADDR) {
    console.log("[ada] messaging: no GRPC_SERVER_ADDR — sidecar not attached, Slack/web chat off");
    return;
  }
  try {
    const { serve } = (await import("@astropods/adapter-core")) as {
      serve: (adapter: unknown, options?: unknown) => void;
    };
    const { AdaMessagingAdapter } = await import("./messaging/adapter.ts");
    // The runner already mirrors every turn into the shared registry, so
    // Slack/web conversations show up in the frontend's review UI unaided.
    serve(new AdaMessagingAdapter(store, runner));
    console.log("[ada] messaging: registered adapter with sidecar (web/slack)");
  } catch (e) {
    console.warn(`[ada] messaging: adapter not started: ${(e as Error).message}`);
  }
}

/* ---------------- identity ---------------- */

/** Any Hono handler context — the identity helpers don't care about the route. */
type Ctx = Context;

interface Identity {
  allowed: boolean;
  userKey: string;
  userId: string | null;
  email: string;
}

/** Return the stable client id, minting + setting the cookie if absent. */
function ensureUid(c: Ctx): string {
  const existing = getCookie(c, "bridge_uid");
  if (existing) return existing;
  const uid = randomUUID();
  // TODO: sign the cookie so a client can't spoof another user's identity.
  setCookie(c, "bridge_uid", uid, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: 31536000,
  });
  return uid;
}

/**
 * Resolve the identity a browser request acts as, keyed the SAME way chat is.
 *
 * In a deployment the ALB injects `x-amzn-oidc-identity`; we run it through the
 * manual-authz endpoint and use the returned platform `user_id` — the exact key
 * the messaging sidecar uses (StreamOptions.userId). So a GitHub token connected
 * over chat is found here for the same person, and vice versa.
 *
 * Locally (no ASTRO_AUTHZ_TOKEN / no ALB headers) authorize() is a no-op allow
 * with no userId, and we fall back to the bridge_uid cookie so dev isn't blocked.
 * `allowed:false` means the grants table denied this user — callers should
 * refuse rather than fall back.
 */
async function resolveIdentity(c: Ctx): Promise<Identity> {
  const headers = Object.fromEntries(c.req.raw.headers) as Record<string, string>;
  const identityId = oidcIdentity({ headers });
  const email = oidcEmail({ headers });
  let authz: AuthzResult;
  try {
    authz = await authorizer.authorize(identityId);
  } catch {
    // Fail closed, matching the sidecar: an authz error is a denial.
    return { allowed: false, userKey: "", userId: null, email };
  }
  if (!authz.allowed) return { allowed: false, userKey: "", userId: authz.userId ?? null, email };
  const userId = authz.userId ?? (identityId || null);
  // Prefer the resolved platform id; fall back to the cookie for local dev /
  // anonymous so those requests still have a stable per-browser token key.
  return { allowed: true, userKey: userId ?? ensureUid(c), userId, email };
}

/** Admin gate for cross-user views: an admin email, or no admin list configured. */
function mayViewOthers(id: Identity): boolean {
  return id.allowed && (isAdmin(id.email) || !adminListConfigured());
}

/**
 * The public base URL for THIS request — what we register with GitHub and hand
 * to the browser. Derived from the request so a local run on a non-default port
 * works; explicit config still wins. See auth/base-url.ts.
 */
function baseUrlFor(c: Ctx): string {
  return resolveBaseUrl({ headers: Object.fromEntries(c.req.raw.headers) });
}

/* ---------------- app ---------------- */

const app = new Hono();

// Every request boots the runtime once. Cheap after the first.
app.use("*", async (c, next) => {
  await boot();
  await next();
});

/* ---------------- Flue's native agent routes ---------------- */

// `@flue/sdk` clients and Flue tooling talk to /agents/ada/:id. Ada's own
// AG-UI routes below address the same durable instances.
app.route("/agents/ada", createAgentRouter(Ada));

/* ---------------- static client ---------------- */

app.get("/", async (c) => {
  ensureUid(c); // establish client identity on first load
  // Gate the UI itself: a request the grants table denies never sees the app
  // shell — it gets the themed 401 instead. Local dev / anonymous-with-`anyone`
  // resolve as allowed, so they still load normally.
  const { allowed } = await resolveIdentity(c);
  if (!allowed) return c.html(render401(), 401);
  try {
    return c.html(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
  } catch {
    return c.text("client not found", 404);
  }
});
app.get("/index.html", (c) => c.redirect("/"));

/* ---------------- sessions ---------------- */

const DEFAULT_TITLE_LEN = 80;

app.post("/sessions", async (c) => {
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string });
  if (!body.prompt) return c.text("prompt required", 400);
  // Resolve + authorize the caller the same way the sidecar does; the GitHub
  // token is keyed by the resolved platform id so git/gh act as the same
  // identity the user connected in chat.
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  try {
    const sessionId = await runner.startSession({
      prompt: body.prompt,
      userKey: id.userKey,
      userId: id.userId ?? undefined,
      meta: { kind: "browser", userId: id.userKey, title: body.prompt.slice(0, DEFAULT_TITLE_LEN) },
    });
    return c.json({ sessionId }, 201);
  } catch (e) {
    return c.text(`run failed: ${(e as Error).message}`, 500);
  }
});

app.post("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  if (!runner.has(sessionId)) return c.text("unknown session", 404);
  const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string });
  if (!body.prompt) return c.text("prompt required", 400);
  // Flue serializes concurrent deliveries to one instance, but the AG-UI client
  // relies on 409 to keep its own turn state coherent — so keep refusing here.
  if (runner.busy(sessionId)) return c.text("session busy", 409);
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  try {
    await runner.continueSession(sessionId, {
      prompt: body.prompt,
      userKey: id.userKey,
      userId: id.userId ?? undefined,
    });
    // The follow-up turn streams over the session's already-open SSE.
    return c.json({ sessionId }, 202);
  } catch (e) {
    return c.text(`run failed: ${(e as Error).message}`, 500);
  }
});

app.delete("/sessions/:id", async (c) => {
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  const existed = await runner.delete(c.req.param("id"));
  return c.body(null, existed ? 204 : 404);
});

app.get("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  if (!registry.has(sessionId)) return c.text("unknown session", 404);

  // Slack/web conversations belong to other users — gate their replay to
  // admins. Browser sessions are the viewer's own, so they stay open.
  if (registry.kind(sessionId) === "slack" && !mayViewOthers(await resolveIdentity(c))) {
    return c.text("forbidden", 403);
  }

  // Prefer the browser's Last-Event-ID header over the URL query param. On an
  // automatic EventSource reconnect the URL is unchanged (it may still carry
  // the initial ?lastEventId=-1), but the browser sends Last-Event-ID with the
  // last delivered seq — honour that so a reconnect resumes from the gap
  // instead of re-replaying the whole log (which duplicated the client's
  // timeline on every reconnect). The query param is the first-connect cursor.
  const headerSeq = parseLastEventId(c.req.header("last-event-id"));
  const q = c.req.query("lastEventId");
  const querySeq = q != null ? Number.parseInt(q, 10) : -1;
  const candidate = headerSeq >= 0 ? headerSeq : querySeq;
  const lastSeq = Number.isFinite(candidate) ? candidate : -1;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const seen = new Set<number>();
      let closed = false;
      const write = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          closed = true; // client went away mid-write
        }
      };

      // Drain the replay buffer first, then join the live tail, de-duping by
      // seq to cover events appended between the two calls.
      for (const logged of registry.since(sessionId, lastSeq)) {
        seen.add(logged.seq);
        write(frameLogged(logged));
      }
      const unsubscribe = registry.subscribe(sessionId, (logged) => {
        if (seen.has(logged.seq)) return;
        seen.add(logged.seq);
        write(frameLogged(logged));
      });

      // Keep-alive: short enough that a proxy is less likely to reap the idle
      // stream and that a dead socket surfaces promptly. The client also
      // re-establishes the stream on each follow-up turn, so delivery doesn't
      // hinge on this alone.
      const heartbeat = setInterval(() => write(sseHeartbeat()), 10_000);

      const teardown = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      c.req.raw.signal.addEventListener("abort", teardown, { once: true });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
});

/* ---------------- test hooks (ADA_TEST_HOOKS=1 only) ---------------- */

/**
 * TEST-ONLY: build a *finished* session by running the recorded read→edit→report
 * fixture through the Translator into the registry. Lets e2e tests seed a
 * replayable session (for SSE resume / delete assertions) without a real model
 * call or credential.
 *
 * The fixture is now a stream of Flue events rather than Claude `stream-json`,
 * but it drives the same translator and yields the same 23 AG-UI events, so the
 * assertions in test/server-sse.spec.ts are unchanged.
 */
app.post("/test/seed", (c) => {
  if (process.env.ADA_TEST_HOOKS !== "1") return c.text("not found", 404);
  try {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "fixtures",
      "read-edit-report.flue.jsonl",
    );
    const sessionId = `sess_seed_${randomUUID()}`;
    registry.ensure(sessionId);
    const translator = new Translator({ includeRawEvent: false });
    let lastSeq = 0;
    for (const line of readFileSync(fixture, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const ev of translator.handle(JSON.parse(trimmed) as FlueEvent)) {
        lastSeq = registry.append(sessionId, ev).seq;
      }
    }
    registry.setStatus(sessionId, "finished");
    return c.json({ sessionId, lastSeq }, 201);
  } catch (e) {
    return c.text(`seed failed: ${(e as Error).message}`, 500);
  }
});

/* ---------------- conversation review ---------------- */

/**
 * List the conversations the agent handled (Slack/web + browser) so the
 * frontend can review them. Admin-gated: when ADMIN_EMAILS is set, requires a
 * match against the ALB-verified email; when no admin list is configured
 * (local/dev), any authorized user may view. This exposes OTHER users'
 * conversations (incl. private-repo content), so set ADMIN_EMAILS in any real
 * deployment.
 */
app.get("/conversations", async (c) => {
  if (!mayViewOthers(await resolveIdentity(c))) return c.json({ error: "forbidden" }, 403);
  return c.json({ conversations: registry.list() });
});

/* ---------------- GitHub OAuth ---------------- */

app.get("/auth/github/login", async (c) => {
  if (!githubConfigured()) return c.text("GitHub App not configured", 503);
  // A `link` param carries a signed messaging userId (minted by the chat
  // adapter). When present, connect THAT identity instead of a browser
  // bridge_uid, so the token lands under the key the adapter resolves
  // (StreamOptions.userId). Otherwise fall back to the resolved web identity.
  const link = c.req.query("link");
  let userKey: string;
  if (link) {
    const bound = verifyLink(link, "connect", await getServerSecret(store));
    if (!bound) return c.text("invalid or expired connect link", 400);
    userKey = bound;
  } else {
    // Browser-initiated connect (the frontend "Connect GitHub" button). The ALB
    // already authenticated the user, so key the token by their platform
    // identity — the same key status/whoami/chat read. Falls back to the cookie
    // in dev.
    const id = await resolveIdentity(c);
    if (!id.allowed) return c.text("forbidden", 403);
    userKey = id.userKey;
  }
  // The OAuth `state` is a SIGNED TOKEN CARRYING the user key, not a nonce
  // indexing a server-side map.
  //
  // It used to be `randomUUID()` plus an in-memory `pendingStates` Map. That
  // broke in two ways: the Map died on every restart (fatal under
  // `node --watch`), and it made the callback unable to identify anyone whose
  // flow didn't originate here. Signing the user key into the state makes the
  // round-trip stateless — restart-proof, no GC, and still unforgeable and
  // time-limited, which is all CSRF protection needs. Reuses the same
  // primitives as the chat connect links.
  const state = mintLink("connect", userKey, await getServerSecret(store), OAUTH_STATE_TTL_MS);

  // Route through the App INSTALLATION (repo picker + write grant), not the
  // bare OAuth authorize. With `request_oauth_on_install` on the App,
  // installing also authorizes, and GitHub redirects back to
  // /auth/github/callback with `code` (+ installation_id).
  //
  // `?authorize=1` skips the picker and goes straight to OAuth — used when the
  // App is ALREADY installed and only the user authorization is missing (see
  // the callback's recovery path). Sending them back to the install screen in
  // that case just shows a confusing "configure" page.
  const slug = getAppCreds()?.slug;
  const authorizeOnly = c.req.query("authorize") === "1";
  return c.redirect(
    slug && !authorizeOnly
      ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
      : authorizeUrl(state, baseUrlFor(c)),
  );
});

app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const uid = state ? verifyLink(state, "connect", await getServerSecret(store)) : null;

  // No usable state. Two ways to get here, and neither is the user's fault:
  //
  //   1. The flow started on GitHub rather than in Ada — someone opened
  //      github.com/apps/<slug>/installations/new directly, or an org owner
  //      approved an installation request. GitHub then calls back with
  //      `code` + `installation_id` + `setup_action=install` and NO state,
  //      because there was no Ada redirect to put one there.
  //   2. The state genuinely expired (>30 min on GitHub's screens).
  //
  // We deliberately do NOT consume `code` here. Without a valid state nothing
  // binds this callback to a session, and trusting it anyway is precisely the
  // login-CSRF that state exists to prevent — an attacker could graft their
  // GitHub account onto someone else's Ada identity.
  //
  // Instead, restart the flow properly: one redirect through /auth/github/login
  // mints a real state and returns here able to identify the user. The App is
  // already installed in case (1), so skip the picker with `authorize=1`. A
  // short-lived cookie bounds this to a single attempt so a persistently
  // failing state can't ping-pong.
  if (!uid) {
    if (getCookie(c, RETRY_COOKIE)) {
      deleteCookie(c, RETRY_COOKIE, { path: "/" });
      return c.html(
        renderPage(
          "Couldn't complete the connection",
          "The GitHub authorization couldn't be matched to your session. Open the app and click " +
            "<b>Connect GitHub</b> in Settings to try again. If this keeps happening, check that " +
            "cookies are enabled for this origin.",
        ),
        400,
      );
    }
    setCookie(c, RETRY_COOKIE, "1", { httpOnly: true, path: "/", sameSite: "Lax", maxAge: 300 });
    const installed = Boolean(c.req.query("installation_id"));
    return c.redirect(`/auth/github/login${installed ? "?authorize=1" : ""}`);
  }

  if (!code) return c.text("invalid OAuth callback (no code)", 400);
  deleteCookie(c, RETRY_COOKIE, { path: "/" });
  try {
    // Same base as the authorize redirect — GitHub compares the two
    // `redirect_uri`s and rejects a mismatch.
    const rec = await exchangeCode(code, baseUrlFor(c));
    await store.putGithubToken(uid, rec);
    const installationId = c.req.query("installation_id");
    console.log(
      `[github] connected ${rec.githubLogin ?? "?"}${
        installationId
          ? ` (installation ${installationId})`
          : " — no installation_id; token has no repo access until the App is installed"
      }`,
    );
    // Land back on the app frontend rather than a dead-end confirmation page.
    return c.redirect("/?github=connected");
  } catch (e) {
    console.error(`[github] code exchange failed: ${(e as Error).message}`);
    return c.html(
      renderPage("Connection failed", "GitHub OAuth exchange failed. Please try connecting again."),
      502,
    );
  }
});

app.get("/auth/github/status", async (c) => {
  // Key the lookup by the resolved platform identity (same as chat), falling
  // back to the bridge_uid cookie for local dev / anonymous browsers.
  const { userKey } = await resolveIdentity(c);
  const rec = userKey ? await store.getGithubToken(userKey) : null;
  return c.json({
    configured: githubConfigured(),
    connected: Boolean(rec),
    login: rec?.githubLogin ?? null,
  });
});

/**
 * The browser counterpart to the chat `whoami` directive. Reports the caller's
 * resolved identity and GitHub connection state so the frontend can render the
 * same info the messaging adapter replies with.
 */
app.get("/api/whoami", async (c) => {
  const { allowed, userKey, userId, email } = await resolveIdentity(c);
  const rec = allowed && githubConfigured() && userKey ? await store.getGithubToken(userKey) : null;
  const github = !githubConfigured()
    ? "not set up on this agent"
    : rec
      ? `connected as ${rec.githubLogin ?? "your account"}`
      : "not connected (use Connect GitHub)";
  return c.json({
    allowed,
    userId, // resolved platform user id (null when anonymous / local dev)
    email: email || null,
    admin: isAdmin(email), // admin is keyed on the verified email (ADMIN_EMAILS)
    adminConfigured: adminListConfigured(),
    canSetup: canProvision(email, { allowed, configured: githubConfigured() }),
    githubConfigured: githubConfigured(),
    githubConnected: Boolean(rec),
    githubLogin: rec?.githubLogin ?? null,
    github, // human-readable summary
  });
});

/**
 * The App installations the connected user can reach and the repos each grants,
 * so the Settings panel can show "connected repos" and a link to add/remove
 * them on GitHub. `appSlug` lets the UI offer an install link when the user is
 * connected but the App isn't installed anywhere yet.
 */
app.get("/api/github/repos", async (c) => {
  const { allowed, userKey } = await resolveIdentity(c);
  if (!allowed) return c.text("forbidden", 403);
  const appSlug = getAppCreds()?.slug ?? null;
  const rec = githubConfigured() && userKey ? await store.getGithubToken(userKey) : null;
  if (!rec) {
    return c.json({ configured: githubConfigured(), connected: false, installations: [], appSlug });
  }
  return c.json({
    configured: true,
    connected: true,
    installations: await listConnectedRepos(store, userKey),
    appSlug,
  });
});

/* ---------------- GitHub App setup (App-Manifest) ---------------- */

app.get("/api/setup/status", (c) =>
  c.json({ configured: githubConfigured(), appSlug: getAppCreds()?.slug ?? null }),
);

/**
 * Starts App provisioning. Reached via the frontend "Set up GitHub App" button.
 * Authorization is by canProvision: admins (ADMIN_EMAILS) resolved from the ALB
 * identity, or — when no admin list is set — any authorized user for the
 * initial setup. Either way it needs the ALB-verified identity, so setup is
 * web-only. Renders a page that POSTs the manifest to GitHub.
 */
app.get("/api/setup/github/start", async (c) => {
  const { allowed, email } = await resolveIdentity(c);
  if (!allowed) {
    return c.html(renderPage("Not authorized", "You must be signed in to set up the GitHub App."), 403);
  }
  if (!canProvision(email, { allowed, configured: githubConfigured() })) {
    return c.html(
      renderPage(
        "Not authorized",
        adminListConfigured()
          ? "Setting up the GitHub App requires an admin (ADMIN_EMAILS)."
          : "The GitHub App is already configured. Set ADMIN_EMAILS to allow re-provisioning.",
      ),
      403,
    );
  }
  const { manifest, manifestUrl } = buildManifest(await getServerSecret(store), {
    org: c.req.query("org") || undefined,
    // Registered with GitHub permanently — see ManifestOptions.baseUrl.
    baseUrl: baseUrlFor(c),
  });
  return c.html(renderManifestForm(manifest, manifestUrl));
});

/**
 * GitHub redirects here after the App is created. The signed `state` proves the
 * request follows a real start; we exchange the code for the App's credentials,
 * store them, and redirect the admin straight into the install-based connect
 * flow rather than dead-ending at a confirmation page.
 */
app.get("/api/setup/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !verifyState(state ?? null, await getServerSecret(store))) {
    return c.html(
      renderPage("Invalid setup callback", "This request is invalid or expired. Start setup again."),
      400,
    );
  }
  try {
    const creds = await convertManifestCode(code);
    await saveAppCreds(store, creds);
    console.log(`[setup] GitHub App '${creds.slug ?? "?"}' provisioned; OAuth is now configured`);
    return c.redirect("/auth/github/login");
  } catch (e) {
    console.error(`[setup] manifest conversion failed: ${(e as Error).message}`);
    return c.html(
      renderPage("Setup failed", "The GitHub App could not be created. Check the logs and try again."),
      502,
    );
  }
});

// Start booting as soon as the module is evaluated (see boot()'s note). Errors
// are logged here and re-surfaced to the first request, which awaits the same
// promise.
void boot().catch((e) => console.error("[ada] boot failed:", e));

export default app;
