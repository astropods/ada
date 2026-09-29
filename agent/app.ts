/**
 * Application entry — the project's route map.
 *
 *   GET  /                         -> built-in AG-UI test client (public/index.html)
 *   POST /sessions {prompt,...}    -> {sessionId} (starts a new multi-turn session)
 *   POST /sessions/:id/messages    -> continue a session with a follow-up turn
 *                                     (both take JSON, or multipart with files)
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
import { bodyLimit } from "hono/body-limit";
import { SessionRegistry } from "./session/registry.ts";
import { SessionRunner } from "./session/runner.ts";
import { startWorkspaceGc } from "./session/workspace.ts";
import {
  checkUploadLimits,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_FILES,
  type UploadInput,
} from "./session/uploads.ts";
import { installTelemetry } from "./telemetry/otel.ts";
import { InMemoryResultStore } from "./persistence/results.ts";
import { createStore, type Store } from "./store/index.ts";
import { persistenceMode } from "./db.ts";
import { describePg } from "./store/pg-config.ts";
import { describeSandbox } from "./session/sandbox-mode.ts";
import { authorizeUrl, exchangeCode, listConnectedRepos } from "./auth/github-app.ts";
import { githubConfigured, getAppCreds, saveAppCreds, loadAppCreds } from "./auth/app-config.ts";
import {
  verifyState, buildManifest, convertManifestCode, renderManifestForm,
  isAdmin, adminListConfigured, canProvision, describeAdmin } from "./auth/setup.ts";
import {
  getServerSecret,
  mintLink,
  verifyLink,
  verifyLinkClaims,
  WATCH_TTL_MS,
} from "./auth/connect.ts";
import { resolveBaseUrl } from "./auth/base-url.ts";
import { Authorizer, oidcIdentity, oidcEmail, tokenKind, type AuthzResult } from "./auth/authz.ts";
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
    // Registered globally, before any agent can run, so it covers sessions
    // driven through Flue's native routes as well as our own.
    await installTelemetry();
    store = await createStore();
    await loadAppCreds(store);
    await getServerSecret(store); // stable HMAC secret for messaging connect links
    runner = new SessionRunner(registry, store, resultStore);
    runner.start();

    console.log(`[ada] ${describeAuth()}`);
    // "Where do the model's commands run" is the first thing to check.
    console.log(`[ada] sandbox: ${describeSandbox()}`);
    console.log(`[ada] web authz: ${authorizer.describe()}`);
    // Never silent: "anyone unauthenticated is admin here" has to be visible.
    console.log(`[ada] admin: ${describeAdmin()}`);
    console.log(
      persistenceMode() === "postgres"
        ? `[ada] conversations: postgres ${describePg()} — durable across restarts`
        : "[ada] conversations: sqlite — NOT durable across a restart unless WORKSPACE_ROOT is a volume",
    );
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
 * Whether `id` may address the session `sessionId` — read it, drive it, delete
 * it. `id.allowed` says the caller may use Ada at all; this says WHOSE
 * conversations they may touch.
 *
 * Being authorized is not the same as being the owner. Session ids are the
 * only thing standing between one authorized user and another's conversation,
 * and a session carries a repo checkout, that user's GitHub identity, and their
 * private-repo content.
 *
 * An UNKNOWN session passes, so the caller answers 404 rather than 403. That
 * keeps "no such session" distinguishable from "not yours" for a user's own
 * tooling, and matches what /events already did.
 *
 * A session with no recorded owner falls back to the admin gate. Those come
 * from paths that predate the meta rather than from a known user, so treating
 * them as nobody's (deniable to non-admins) is the safe reading.
 */
function maySession(sessionId: string, id: Identity): boolean {
  if (!id.allowed) return false;
  if (!registry.has(sessionId)) return true; // let the caller 404
  // Slack/web conversations belong to other users by construction.
  if (registry.kind(sessionId) === "slack") return mayViewOthers(id);
  const owner = registry.owner(sessionId);
  if (!owner) return mayViewOthers(id);
  return owner === id.userKey || mayViewOthers(id);
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

/**
 * `@flue/sdk` clients and Flue tooling talk to /agents/ada/:id. Ada's own
 * AG-UI routes below address the same durable instances.
 *
 * THAT is why this needs a gate. The router was mounted bare while every
 * /sessions/* route resolved an identity and checked it, so the native path was
 * an unauthenticated way to reach exactly the same conversations the AG-UI path
 * gates — read them, drive them, and act as their owner's GitHub identity.
 *
 * Restricted to `mayViewOthers` (an admin, or any authorized user when no admin
 * list is configured) rather than to per-session ownership, deliberately. The
 * session registry that would answer "who owns this instance?" is IN-MEMORY
 * while Flue's instances are DURABLE, so after a restart a live Slack
 * conversation is absent from the registry and an ownership check would read as
 * "unknown, allow". An admin gate does not depend on that. It is also the
 * conservative direction: it can only ever grant less than the AG-UI routes.
 *
 * Neither the built-in client nor the test suite uses this router, so the gate
 * costs nothing today; local dev and no-admin-list deployments still pass, the
 * same posture as /conversations.
 */
const gateNativeRouter = async (c: Ctx, next: () => Promise<void>): Promise<Response | void> => {
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  if (!mayViewOthers(id)) return c.text("forbidden", 403);
  await next();
};
app.use("/agents/ada", gateNativeRouter);
app.use("/agents/ada/*", gateNativeRouter);

/**
 * The native router may READ a conversation. It may not START a turn.
 *
 * `POST /agents/ada/:id` is Flue's prompt dispatch, and it renders the agent
 * WITHOUT going through SessionRunner. `session-env.ts` is process-local and
 * published by the runner immediately before it dispatches, so a render that
 * skips the runner finds nothing and falls back to `fallbackEnv()` — which,
 * before this, meant `local({ cwd: process.cwd() })`. A turn dispatched here
 * ran the model's shell and file tools in the CONTROL PLANE container, on its
 * own source tree, with no per-conversation workspace and none of the sandbox
 * isolation — even with a sandbox container deployed.
 *
 * Chose to REFUSE rather than to wire the setup into this path. Publishing a
 * session env here would fix the isolation and still leave native dispatch
 * bypassing the concurrency limiter, the translator and its registry mirroring
 * (so no AG-UI stream, no SSE, no conversation-review record) and the run
 * records. That is a second, half-instrumented way to run a turn — which is the
 * kind of divergence that produced this bug in the first place. One supported
 * path, and it is the one that sets up isolation.
 *
 * Everything the router is documented for still works: reading the same durable
 * instances (`GET|HEAD /:id`), aborting (`POST /:id/abort`) and attachment reads
 * are all untouched. Only prompt dispatch is refused, and nothing in this repo
 * used it. Registered BEFORE `app.route` so it wins for this exact method and
 * path; `:id` matches a single segment, so `/:id/abort` is unaffected.
 */
app.post("/agents/ada/:id", (c) =>
  c.json(
    {
      error: "native prompt dispatch is not supported",
      detail:
        "Starting a turn here would run the agent's tools in the control-plane " +
        "container with no sandbox isolation, because this path does not go through " +
        "the session runner. Use POST /sessions to start a conversation, or " +
        "POST /sessions/:id/messages to continue one; both stream over " +
        "GET /sessions/:id/events. Reading a conversation through " +
        "GET /agents/ada/:id still works.",
    },
    405,
  ),
);
app.route("/agents/ada", createAgentRouter(Ada));

/* ---------------- static client ---------------- */

const WATCH_COOKIE = "ada_watch";

/**
 * Whether this browser may watch `sessionId`.
 *
 * TWO THINGS MUST AGREE: a signed token naming the conversation, and a signed-in
 * platform identity matching the user it was minted for. The token alone is a
 * bearer credential, and a link posted in a Slack thread is visible to everyone
 * in it — so the token bounds WHAT a holder can reach and the identity bounds
 * WHO. Requiring both means a link forwarded to a colleague does nothing for
 * them; they are sent to sign in, and then refused because it is not theirs.
 *
 * The two ids are the same by construction: the authorize call returns the
 * platform user id the sidecar keys chat on, which is what the token carries.
 *
 * Off a deployment there is no ALB and so no identity to match, exactly as with
 * `isAdmin` — local runs are already ungated, so the token alone stands.
 *
 * Read-only by construction: only `GET /` and the event stream consult this.
 * Driving or deleting a session never does, so a grant cannot do either.
 */
async function watchGrant(c: Ctx, sessionId?: string): Promise<boolean> {
  const claims = verifyLinkClaims(getCookie(c, WATCH_COOKIE), "watch", await getServerSecret(store));
  if (!claims?.sessionId) return false;
  if (sessionId !== undefined && claims.sessionId !== sessionId) return false;
  return watcherIsOwner(await resolveIdentity(c), claims.userId);
}

/** The signed-in viewer is the user a watch token was minted for. */
function watcherIsOwner(id: Identity, mintedFor: string): boolean {
  if (tokenKind() !== "deploy") return true;
  return id.allowed && id.userId === mintedFor;
}

/**
 * Follow a turn from chat. Trades the link for a cookie and opens the client.
 *
 * The cookie carries the same token, so the grant survives a reload without
 * leaving a bearer token in the address bar for the rest of the session.
 */
app.get("/watch", async (c) => {
  const token = c.req.query("link") ?? "";
  const claims = verifyLinkClaims(token, "watch", await getServerSecret(store));
  if (!claims?.sessionId) return c.html(render401(), 401);
  // Refuse here as well as at the grant, so someone handed the link is told
  // now rather than after a redirect into an empty client.
  if (!watcherIsOwner(await resolveIdentity(c), claims.userId)) return c.html(render401(), 401);
  setCookie(c, WATCH_COOKIE, token, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    maxAge: Math.floor(WATCH_TTL_MS / 1000),
  });
  return c.redirect(`/?watch=${encodeURIComponent(claims.sessionId)}`);
});

app.get("/", async (c) => {
  ensureUid(c); // establish client identity on first load
  // Gate the UI itself: a request the grants table denies never sees the app
  // shell — it gets the themed 401 instead. Local dev / anonymous-with-`anyone`
  // resolve as allowed, so they still load normally.
  const { allowed } = await resolveIdentity(c);
  if (!allowed && !(await watchGrant(c))) return c.html(render401(), 401);
  try {
    return c.html(readFileSync(join(PUBLIC_DIR, "index.html"), "utf8"));
  } catch {
    return c.text("client not found", 404);
  }
});
app.get("/index.html", (c) => c.redirect("/"));

/* ---------------- sessions ---------------- */

const DEFAULT_TITLE_LEN = 80;

/**
 * Read `{ prompt, uploads }` from a turn request, in either encoding.
 *
 * JSON stays the contract for a plain prompt — the messaging adapter, external
 * AG-UI clients and every existing test speak it, and a turn with no files must
 * keep producing byte-identical requests. Multipart is added ALONGSIDE it,
 * chosen by content-type, purely so the browser can attach files without
 * base64-inflating them by a third into a JSON body.
 *
 * Returns an error string instead of throwing: every caller turns it straight
 * into a 4xx, and the limit messages are written to be shown to the user.
 */
async function readTurnRequest(
  c: Context,
): Promise<{ prompt: string; uploads: UploadInput[] } | { error: string }> {
  const contentType = c.req.header("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    const body = await c.req.json<{ prompt?: string }>().catch(() => ({}) as { prompt?: string });
    if (!body.prompt) return { error: "prompt required" };
    return { prompt: body.prompt, uploads: [] };
  }

  // `all: true` so repeated `files` parts arrive as an array rather than the
  // last one winning — attaching three files and silently sending one is the
  // failure this flag exists to avoid.
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form) return { error: "malformed multipart body" };

  const prompt = typeof form.prompt === "string" ? form.prompt : "";
  if (!prompt) return { error: "prompt required" };

  const parts = form.files;
  const list = (Array.isArray(parts) ? parts : parts ? [parts] : []).filter(
    (f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f,
  );
  if (list.length > MAX_UPLOAD_FILES) {
    // Rejected before the parts are copied into our own buffers. Note this is
    // not a memory guard: `parseBody` has already read the whole body, so the
    // real ceiling on an oversized request is whatever fronts this process.
    return { error: `too many files — ${list.length} attached, limit is ${MAX_UPLOAD_FILES}` };
  }

  const uploads: UploadInput[] = [];
  for (const f of list) {
    uploads.push({
      filename: f.name,
      mimeType: f.type,
      bytes: new Uint8Array(await f.arrayBuffer()),
    });
  }
  const limit = checkUploadLimits(uploads);
  if (limit) return { error: limit };
  return { prompt, uploads };
}

/**
 * Outer ceiling on a turn request, ahead of any parsing.
 *
 * `checkUploadLimits` is the friendly limit — it names the file and the cap, so
 * the user can act on it — but it cannot run until `parseBody` has already
 * pulled the whole body into memory. This refuses on `Content-Length`, or by
 * counting the stream when there isn't one, before that happens.
 *
 * Deliberately ABOVE the per-message total, so a batch that busts the real
 * limit still gets the message that explains which file to drop rather than a
 * bare 413. Only a request too big to be worth reading at all lands here.
 */
const turnBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BYTES,
  onError: (c) => c.text("attachments too large", 413),
});

app.post("/sessions", turnBodyLimit, async (c) => {
  // Resolve + authorize the caller the same way the sidecar does; the GitHub
  // token is keyed by the resolved platform id so git/gh act as the same
  // identity the user connected in chat.
  //
  // BEFORE the body is read, so an unauthorized caller cannot make us buffer
  // 50MB of attachments to be told no.
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  const req = await readTurnRequest(c);
  if ("error" in req) return c.text(req.error, 400);
  try {
    const sessionId = await runner.startSession({
      prompt: req.prompt,
      uploads: req.uploads,
      userKey: id.userKey,
      userId: id.userId ?? undefined,
      meta: { kind: "browser", userId: id.userKey, title: req.prompt.slice(0, DEFAULT_TITLE_LEN) },
      // Answer as soon as the session exists; the turn streams over SSE. This
      // used to await the whole turn, so the client only got its id once there
      // was nothing left to stream and replayed a finished turn in one block.
      background: true,
    });
    return c.json({ sessionId }, 201);
  } catch (e) {
    return c.text(`run failed: ${(e as Error).message}`, 500);
  }
});

app.post("/sessions/:id/messages", turnBodyLimit, async (c) => {
  const sessionId = c.req.param("id");
  // AUTHORIZATION FIRST, before anything that reveals the session's state.
  // Driving another user's conversation is at least as serious as reading it:
  // the turn runs in their workspace, against their checkout, as their GitHub
  // identity. Same gate as /events and DELETE.
  //
  // The order matters beyond the check itself — this used to sit below the
  // existence and busy tests, so a non-owner probing ids still learned which
  // ones existed and which were mid-turn. `maySession` passes UNKNOWN sessions
  // through precisely so the 404 below still answers for them, which is what
  // lets the gate move up here without changing any status a legitimate caller
  // sees.
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  if (!maySession(sessionId, id)) return c.text("forbidden", 403);
  if (!runner.has(sessionId)) return c.text("unknown session", 404);
  // Flue serializes concurrent deliveries to one instance, but the AG-UI client
  // relies on 409 to keep its own turn state coherent — so keep refusing here.
  // Ahead of the body read for the same reason as the authorization gate: a
  // turn we are going to refuse should not cost us the upload first.
  //
  // CLAIMED, not probed. The body read below takes real time for a multipart
  // turn, and a plain `busy()` test would let a second follow-up through that
  // window — both would dispatch and neither would see a 409.
  const release = runner.reserveTurn(sessionId);
  if (!release) return c.text("session busy", 409);
  // Every path from here must reach `release()`, including a throw: the body
  // read is not exception-free, and a leaked reservation is PERMANENT — the
  // session stays "starting", which `busy()` reads as busy forever.
  try {
    const req = await readTurnRequest(c);
    if ("error" in req) {
      release();
      return c.text(req.error, 400);
    }
    await runner.continueSession(sessionId, {
      prompt: req.prompt,
      uploads: req.uploads,
      userKey: id.userKey,
      userId: id.userId ?? undefined,
      // Same reasoning as POST /sessions: a follow-up turn is just as long, and
      // the client is already watching the stream this will arrive on.
      background: true,
    });
    // The follow-up turn streams over the session's already-open SSE.
    return c.json({ sessionId }, 202);
  } catch (e) {
    // Safe after a successful dispatch too: `release` only rolls back a slot
    // still sitting at "starting", so it cannot take a live turn's.
    release();
    return c.text(`turn failed: ${(e as Error).message}`, 500);
  }
});

app.delete("/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  const id = await resolveIdentity(c);
  if (!id.allowed) return c.text("forbidden", 403);
  // `allowed` alone let any authorized user destroy any session — its Flue
  // state and its workspace — by id. Deleting is the least recoverable thing
  // this API does, so it takes the same ownership gate as reading.
  if (!maySession(sessionId, id)) return c.text("forbidden", 403);
  const existed = await runner.delete(sessionId);
  return c.body(null, existed ? 204 : 404);
});

app.get("/sessions/:id/events", async (c) => {
  const sessionId = c.req.param("id");
  if (!registry.has(sessionId)) return c.text("unknown session", 404);

  // Slack/web conversations belong to other users — gate their replay to
  // admins. Browser sessions were assumed to be "the viewer's own", which holds
  // for the viewer's OWN session and not for anyone else's: the id is the only
  // thing separating them. maySession keeps the Slack rule exactly as it was
  // and adds the ownership check for browser sessions, so this can only refuse
  // more than before, never less.
  // A watch grant stands in for identity, but only for THIS conversation: the
  // token names it, so a chat user following their own turn needs no platform
  // identity in the browser — and cannot reach anything else with it.
  if (!(await watchGrant(c, sessionId)) && !maySession(sessionId, await resolveIdentity(c))) {
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
/**
 * Test-only: configure (or clear) GitHub App credentials.
 *
 * The OAuth routes are inert without an App, and credentials come only from the
 * manifest setup flow into the store — there is no env path. So the routing
 * these tests exist to pin (authorize by default, install only on request) had
 * no way to run, and the assertions silently skipped, which is worse than not
 * having them: the bug they cover shipped once already.
 *
 * Fake credentials, never exchanged — the tests read the redirect's Location and
 * stop there. Reversible so a spec restores the deployment's real state.
 */
app.post("/test/github-app", async (c) => {
  if (process.env.ADA_TEST_HOOKS !== "1") return c.text("not found", 404);
  type Creds = { clientId?: string; slug?: string | null };
  const body = await c.req.json<Creds>().catch((): Creds => ({}));
  if (!body.clientId) {
    await saveAppCreds(store, { clientId: "", clientSecret: "" });
    // saveAppCreds caches whatever it is given; an empty id must read as
    // unconfigured, which is what loadAppCreds would conclude from the same row.
    await loadAppCreds(store);
    return c.json({ configured: githubConfigured() });
  }
  await saveAppCreds(store, {
    clientId: body.clientId,
    clientSecret: "test-secret",
    slug: body.slug ?? null,
  });
  return c.json({ configured: githubConfigured() });
});

app.post("/test/seed", async (c) => {
  if (process.env.ADA_TEST_HOOKS !== "1") return c.text("not found", 404);
  // An optional `{kind, userId}` stamps the session's ownership metadata. The
  // authorization rules on /sessions/* are all functions of that metadata, and
  // the only other way to create an owned session is to run a real turn against
  // a real model — so without this they could not be asserted end to end.
  const meta = await c.req
    .json<{ kind?: "browser" | "slack"; userId?: string }>()
    .catch(() => ({}) as { kind?: "browser" | "slack"; userId?: string });
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
    if (meta.kind || meta.userId) registry.setMeta(sessionId, meta);
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

  /**
   * AUTHORIZE by default. Install only when explicitly asked for.
   *
   * A GitHub App has two independent grants and they are easy to conflate:
   *
   *   INSTALLATION  — an org owner decides which repositories the App may
   *                   touch. Once per org, by someone with rights to do it.
   *   AUTHORIZATION — each person authorizes the App so it can act AS them.
   *                   Once per user, by anyone.
   *
   * A user-to-server token reaches the intersection: repos the installation
   * covers AND the user can see. So a new colleague joining an org where the
   * App is already installed needs ONLY the second one.
   *
   * This used to send everyone to `installations/new`, on the reasoning that
   * `request_oauth_on_install` makes an install authorize too. It does — but it
   * asks every user to configure an installation, which most of them cannot do
   * and none of them need. In an org where IT had already installed the App,
   * the picker offered an installation the user had no rights to modify and
   * GitHub refused: "access denied", on a step that was unnecessary. Picking
   * their personal account instead produced a token with no access to the org's
   * repos, so the clone failed and the agent reported being unauthenticated —
   * a loop with no exit for the person in it.
   *
   * `?install=1` is the escape hatch for the cases that genuinely need it: the
   * first install in an org (an owner doing it deliberately), or adding
   * personal repos. Offered when a push or clone comes back 403 — see
   * github-guidance.ts — rather than demanded up front from everyone.
   */
  const slug = getAppCreds()?.slug;
  const wantsInstall = c.req.query("install") === "1";
  if (wantsInstall && !slug) {
    // The install URL is built from the App slug, and nothing else can stand in
    // for it. GitHub's manifest conversion does return one, so this is the
    // degenerate case (an App configured before the slug was recorded) — but
    // falling through to authorize without a word would leave an admin
    // wondering why "install" authorized instead, so say so.
    console.warn(
      "[github] install requested but no App slug is known — falling back to authorization. " +
        "Install the App from GitHub directly, or re-run setup so the slug is recorded.",
    );
  }
  return c.redirect(
    slug && wantsInstall
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
    // Always the authorize flow now — that is the default, and it is what this
    // recovery needs in both cases. Arriving here after an install (case 1)
    // means the installation already exists and only the user token is
    // missing; arriving after an expired state (case 2) means retrying the
    // whole thing, and sending someone back to a picker they did not ask for
    // is what this route exists to undo.
    return c.redirect("/auth/github/login");
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
    // Land back on the app frontend — but ONLY for someone who can actually
    // open it. A chat user connecting from Slack has no reason to be authorized
    // for the web UI, and redirecting them into it served the themed 401: the
    // connection had already succeeded, and the last thing they saw said access
    // denied. Indistinguishable, from the user's side, from the flow failing.
    const viewer = await resolveIdentity(c);
    if (!viewer.allowed) {
      return c.html(
        renderPage(
          "GitHub connected",
          `Connected as <b>${rec.githubLogin ?? "your account"}</b>. You can close this tab and ` +
            "carry on in chat.",
        ),
      );
    }
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
    // `?install=1` because this is the ONE place that genuinely needs the
    // picker: the App has just been created and is installed nowhere, so the
    // admin who provisioned it has to choose repositories before it can reach
    // any. The login route defaults to plain authorization now — correct for
    // every other caller, and a silent no-op here, which is what this flag
    // exists to say. (Provisioning also has to work when `slug` is missing;
    // see the login route.)
    return c.redirect("/auth/github/login?install=1");
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
