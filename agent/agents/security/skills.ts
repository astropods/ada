/**
 * Security playbooks, as Flue skills.
 *
 * Why skills rather than more system prompt: a skill's `description` is the
 * only part that sits in the prompt permanently — one line, so the model knows
 * the playbook exists. The `instructions` body is loaded only when the model
 * decides the skill is relevant to what it's doing. That is what makes it
 * affordable to write genuinely detailed guidance: a 100-line migration
 * playbook costs one catalog line on a turn that isn't touching the database.
 *
 * Writing guidance for these bodies:
 *   - Be specific and checkable. "Validate input" is not actionable; "reject
 *     unknown fields, and bound every string and array" is.
 *   - Say what the WRONG version looks like. Models pattern-match, and a
 *     labelled anti-pattern is the most reliable way to steer away from one.
 *   - Prefer "do X because Y" over bare imperatives, so the model can
 *     generalise to the case you didn't enumerate.
 *   - Stay framework-agnostic. Ada works on whatever repo it's pointed at, so
 *     these describe the shape of the correct answer, not one library's API.
 *
 * Authored as TypeScript template literals rather than imported `.md` files so
 * every entry point can load them: `node agent/index.ts` runs on Node's
 * type-stripping, which cannot import markdown, and `flue run` loads the agent
 * module directly without Vite's `?raw` transform.
 */

import { defineSkill } from "@flue/runtime";

/* ---------------------------------------------------------------- API */

export const SECURE_API_ENDPOINT = defineSkill({
  name: "secure-api-endpoint",
  description:
    "How to add or change an HTTP endpoint safely: authentication, object-level " +
    "authorization (IDOR/BOLA), input validation, rate limiting, and error shape. " +
    "Use whenever you add, expose, or change the signature of a route or handler.",
  instructions: `# Securing an API endpoint

Work through these in order. Most real breaches are step 2.

## 1. Authentication — who is calling?

Find how the codebase already authenticates and reuse it. Do not invent a second
mechanism, and do not add an endpoint that silently bypasses the existing one.
If the framework has route-level middleware, register there rather than checking
inside the handler — a check inside the handler is one \`return\` away from being
skipped, and invisible to anyone auditing the route table.

**Anti-pattern:** a new route added to a router that has auth middleware applied
per-route, where you forget the middleware. It works, tests pass, and it is open
to the world. When a router mixes protected and unprotected routes, check what
the neighbouring routes do.

## 2. Authorization — may THIS caller touch THIS object?

This is the step that gets skipped, and it is the most commonly exploited API
flaw (OWASP calls it BOLA; you'll also see IDOR).

Authentication tells you the caller is Alice. It does **not** tell you that
invoice 4172 is Alice's.

\`\`\`
WRONG:  const invoice = await db.invoice.find(req.params.id)
        return invoice

RIGHT:  const invoice = await db.invoice.find(req.params.id)
        if (invoice.ownerId !== session.userId) return notFound()
        return invoice
\`\`\`

Rules of thumb:
- Scope the *query*, don't filter after: \`find({ id, ownerId: session.userId })\`
  is safer than fetch-then-compare, because it cannot be refactored into a leak.
- Return **404, not 403**, for objects the caller may not see. A 403 confirms
  the object exists, which is itself a leak (it enumerates your id space).
- Sequential integer ids make enumeration trivial. If you are adding a new
  externally-visible identifier, prefer a UUID/ULID.
- Check ownership on **every** verb, including DELETE and PATCH. Read paths get
  reviewed; write paths get forgotten.
- Beware nested resources: \`/orgs/:org/projects/:project\` must verify the
  project belongs to that org, not just that the caller is in the org.

## 3. Input validation

Validate at the boundary with the schema library the project already uses.

- **Reject unknown fields** rather than ignoring them. Silently-dropped fields
  hide mass-assignment bugs, where a client sets \`role: "admin"\` on a field you
  never meant to accept.
- **Bound everything**: max length on strings, max items on arrays, min/max on
  numbers. An unbounded array is a denial-of-service vector.
- Validate the *type you want*, not the type you got — coerce explicitly.
- Never trust \`Content-Type\`, filenames, or client-supplied sizes.
- Validate path parameters too. They are input.

## 4. Rate limiting and abuse

Anything unauthenticated, expensive, or that sends email/SMS needs a limit.
Login and password-reset endpoints need one specifically to blunt credential
stuffing. Reuse the project's existing limiter; if there isn't one, say so in
your summary rather than quietly shipping without.

## 5. Errors and responses

- Never return a stack trace, SQL string, or internal path to a client.
- Log the detail server-side with a correlation id; return the id, not the
  detail.
- Don't leak existence through error text or timing on auth paths — "invalid
  email or password", not "no such user".
- Return only the fields the caller needs. Serialising a whole ORM row is how
  password hashes and internal flags escape.

## 6. Before you finish

- Did you add a test that a caller who does NOT own the object gets 404? That
  single test is the highest-value one you can write here.
- Did the route change the API's public shape? Update the spec (see the
  \`maintain-api-docs\` skill).`,
});

/* ----------------------------------------------------------- migrations */

export const SAFE_DB_MIGRATION = defineSkill({
  name: "safe-db-migration",
  description:
    "How to write a database migration that is reversible, non-locking, and safe " +
    "to deploy against a live system: expand/contract, backfills, index creation, " +
    "and code/migration ordering. Use whenever you add or change a schema.",
  instructions: `# Writing a safe migration

Assume the migration runs against a production database with live traffic and
data you cannot recreate. That assumption changes almost every decision.

## Use the project's migration tool

Find it first (\`migrations/\`, \`prisma/\`, \`alembic/\`, \`db/migrate/\`, …) and
follow its conventions exactly. Never hand-edit a schema that a tool owns, and
never edit a migration that has already been applied — add a new one. Editing an
applied migration desynchronises every environment that already ran it.

## Expand / contract — never rename in one step

A migration and the code that depends on it do not deploy atomically. During the
rollout, old code runs against the new schema. So a destructive change must be
split across releases:

\`\`\`
WRONG (breaks every running instance the moment it applies):
  ALTER TABLE users RENAME COLUMN email TO email_address;

RIGHT (three deploys):
  1. EXPAND   add email_address, backfill it, write to BOTH columns
  2. MIGRATE  switch reads to email_address, verify
  3. CONTRACT drop email, once nothing reads it
\`\`\`

The same shape applies to: making a column NOT NULL (add nullable → backfill →
add constraint), changing a type, and splitting or merging tables.

## Destructive DDL

\`DROP TABLE\`, \`DROP COLUMN\`, and \`TRUNCATE\` destroy data that no rollback
restores — a down-migration can recreate the *column*, not its contents. Before
writing one:

- Confirm nothing reads it (grep the codebase, and say what you searched).
- Prefer a deprecation window: stop writing, wait a release, then drop.
- Never combine a drop with other changes in one migration; keep it isolated
  and easy to review.
- State plainly in your summary that the change is irreversible.

## Locks — the thing that takes production down

A migration that is instant on your laptop can hold an exclusive lock for
minutes on a large table, queueing every query behind it.

- Create indexes concurrently where the database supports it (Postgres:
  \`CREATE INDEX CONCURRENTLY\`, which cannot run inside a transaction — check
  your tool supports that).
- Adding a column with a **volatile default** can rewrite the whole table on
  older engines. Add nullable, backfill in batches, then set the default.
- Backfill in bounded batches with a commit between, not one \`UPDATE\` over
  millions of rows.
- Adding a foreign key validates every existing row; add \`NOT VALID\` then
  validate separately where supported.
- Keep each migration short. A long transaction blocks vacuum and replication.

## Reversibility

Write the down-migration, and make it actually work — an empty or throwing
\`down()\` is a migration you cannot roll back at 3am. Where reversal genuinely
cannot restore state (a drop), say so explicitly in a comment rather than
leaving a down that silently does nothing.

## Before you finish

- Does the migration run cleanly on an empty database AND one with data?
- Does the down-migration restore a working schema?
- Did you note the deploy ordering (migration before or after code) in your
  summary? Getting this wrong is the usual cause of a broken rollout.`,
});

/* ----------------------------------------------------------- injection */

export const INJECTION_DEFENCE = defineSkill({
  name: "injection-defence",
  description:
    "How to handle untrusted input safely across SQL, shell, paths, templates, " +
    "deserialisation, and server-side fetches (SSRF), plus correct output " +
    "encoding. Use whenever a value from a request, file, or third party reaches " +
    "a query, a command, a path, or a rendered page.",
  instructions: `# Handling untrusted input

The rule behind every case below is the same: **keep data out of the position
where it can be read as instructions.** Escaping is the fallback; separating
code from data is the fix.

## SQL

Use parameter binding. Always.

\`\`\`
WRONG:  db.query("SELECT * FROM users WHERE email = '" + email + "'")
WRONG:  db.query(\\\`SELECT * FROM users WHERE email = '\\\${email}'\\\`)
RIGHT:  db.query("SELECT * FROM users WHERE email = $1", [email])
\`\`\`

Identifiers (table and column names) **cannot** be parameterised. If one must be
dynamic, validate it against an allowlist of known names — never interpolate a
caller-supplied identifier, even "sanitised".

\`ORDER BY \${column}\` and \`LIMIT \${n}\` are the two that slip through review.
Allowlist the column; coerce the limit to a bounded integer.

ORM query builders are safe **until** you reach for the raw escape hatch
(\`.raw()\`, \`$queryRawUnsafe\`, \`literal()\`). The word "unsafe" in an API name is
load-bearing — if you type it, parameterise inside it.

## Shell commands

Prefer an API over a shell. If you must run a command, pass an argument array
so no shell interprets it:

\`\`\`
WRONG:  exec("git clone https://github.com/" + repo)
RIGHT:  execFile("git", ["clone", \\\`https://github.com/\\\${owner}/\\\${name}\\\`])
        // with owner/name validated against  /^[A-Za-z0-9][\\w.-]*$/
\`\`\`

\`execFile\`/\`spawn\` without \`shell: true\` do not invoke a shell, so \`;\`, \`&&\`,
backticks, and \`$()\` are inert. Setting \`shell: true\` throws that away.

Watch for arguments starting with \`-\`: a filename of \`--upload-pack=evil\` is an
option, not a path. Use \`--\` to end option parsing.

## Paths

Any caller-supplied path can traverse. Resolve, then verify containment:

\`\`\`
const full = path.resolve(baseDir, userPath);
if (!full.startsWith(path.resolve(baseDir) + path.sep)) throw new Error("outside base");
\`\`\`

Stripping \`../\` is not sufficient — encodings, symlinks, and absolute paths all
defeat it. Resolve first, compare after.

## SSRF — server-side fetches

If a URL comes from a user and your server fetches it, you have handed the
caller your network position: cloud metadata endpoints, internal admin panels,
and databases become reachable.

- Allowlist schemes (\`https\` only) and, where possible, hosts.
- Block private and link-local ranges — including \`169.254.169.254\`, which is
  the cloud metadata service.
- Resolve the hostname and check the resolved IP, not the string; and disable
  or re-check redirects, since a public host can redirect to \`127.0.0.1\`.
- Set a timeout and a response size cap.

## Output encoding

Encode for the destination, at the point of use:
- HTML → let the templating engine escape. Never build HTML by concatenation,
  and treat \`dangerouslySetInnerHTML\`/\`v-html\`/\`|safe\` as needing a comment
  justifying it.
- JSON → serialise with the standard library, never string-build.
- Logs → strip newlines from user input, or an attacker forges log entries.
- CSV → a leading \`=\`, \`+\`, \`-\`, or \`@\` is a formula; prefix it.

## Deserialisation and parsing

Never deserialise untrusted data into arbitrary types (\`pickle\`, Java
serialisation, \`yaml.load\` without a safe loader) — that is remote code
execution. Use the safe loader, bound the input size, and disable external
entity resolution in any XML parser.`,
});

/* ---------------------------------------------------------------- docs */

export const MAINTAIN_API_DOCS = defineSkill({
  name: "maintain-api-docs",
  description:
    "How to keep an OpenAPI spec, README, and changelog true after a code change, " +
    "and what a good PR description contains. Use whenever you change a public " +
    "interface, add configuration, or open a pull request.",
  instructions: `# Keeping the documentation true

Stale documentation is worse than none: it is trusted. A spec that still shows
an endpoint as unauthenticated will be believed by the next reader, the next
integration, and the next agent.

## Find the source of truth first

Is the spec **generated** from code (decorators, route schemas, a build step) or
**hand-maintained** (\`openapi.yaml\` in the repo)?

- Generated → change the annotations, then re-run the generator. Never hand-edit
  generated output; it will be overwritten and your change silently lost.
- Hand-maintained → edit it in the same commit as the code. A follow-up commit
  is a follow-up that never happens.

If the repo has no spec and you are adding an HTTP API, ask before introducing
one — that is a project convention, not your call.

## What a spec change must cover

For every endpoint you touched: path and method, parameters with types and
whether required, request body schema, **every** response status you can
actually return (including 401/403/404/422/429), and the security scheme.

That last one matters most. If an endpoint requires auth, the spec must say so.
An endpoint documented as open is one an integrator will call without a token,
then file a bug against.

## Also update

- **README** — only if you changed setup, configuration, or how to run the
  thing. Don't pad it.
- **Changelog** — if the project keeps one, follow its existing format exactly.
  Note breaking changes prominently.
- **Env vars / config** — a new setting that isn't documented does not exist.
  Document the default and what happens when it's unset.
- **Comments** — update the ones your change made wrong. A comment describing
  the old behaviour is a trap.

## Pull request descriptions

Say what changed and why, at the altitude a reviewer needs — not a file-by-file
narration of the diff, which they can read.

Include a short **Security notes** section whenever the change touches auth,
input handling, data access, dependencies, or infrastructure. State what you
considered and what you deliberately did not do:

> **Security notes**
> - New \`GET /invoices/:id\` scopes the query by \`ownerId\`; added a test that a
>   non-owner receives 404.
> - No rate limit added — this route sits behind the existing authenticated
>   limiter in \`middleware/rate.ts\`.

This is not ceremony. It tells the reviewer where to look, and it makes the
absence of a control a visible decision rather than an oversight.

## Never

Do not claim a check you did not run. If you could not run the test suite, say
"tests not run" — do not write "tests pass".`,
});

/* -------------------------------------------------------- supply chain */

export const DEPENDENCY_HYGIENE = defineSkill({
  name: "dependency-hygiene",
  description:
    "How to add or upgrade a dependency safely: whether it's needed at all, " +
    "provenance and typosquat checks, version pinning, lockfiles, and advisories. " +
    "Use before adding any new package or bumping one.",
  instructions: `# Adding a dependency

A dependency is code you did not write, running with your privileges, updated by
someone you have not met. That is sometimes worth it.

## First: is it needed?

For anything small — left-pad, a two-line date format, a simple debounce —
write it. Each dependency is permanent supply-chain surface and a future
upgrade obligation. Check whether the project, the standard library, or an
existing dependency already does the job.

## Provenance

Before adding a package:
- Does the name match exactly what the docs say? Typosquats differ by one
  character, a hyphen, or a scope (\`@types/foo\` vs \`types-foo\`).
- Is it actively maintained, and does its repo match its registry listing?
- How many transitive dependencies does it pull in? A package with fifty is
  fifty decisions you didn't make.
- Does it run install scripts? Those execute at install time, in CI, with
  whatever credentials CI has.

## Pinning

Follow the project's existing convention. Whatever it is, **commit the
lockfile** — that is what makes builds reproducible and an unexpected upgrade
visible in a diff. Never add a dependency without updating the lockfile in the
same commit, and never edit a lockfile by hand.

For anything security-sensitive, prefer an exact version over a range: a caret
range means a compromised patch release ships to you automatically.

## Advisories

Check for known vulnerabilities before adding, and after upgrading — \`npm audit\`,
\`pip-audit\`, \`cargo audit\`, or whatever the ecosystem provides. Report what you
found rather than silently accepting it.

If the project has a scanner in CI, run it locally before finishing rather than
discovering the failure in the pipeline.

## Upgrading

- Read the changelog between versions, especially across a major.
- Upgrade one significant dependency per change, so a regression is bisectable.
- Never bump a version to make a test pass without understanding why it failed.

## Never

- Never add a dependency from a source the project doesn't already use (an
  alternate registry, a git URL, a tarball) without flagging it explicitly.
- Never disable integrity checking or certificate verification to make an
  install work. If an install fails verification, that is the system working.`,
});

/* ------------------------------------------------------------- secrets */

export const SECRETS_HANDLING = defineSkill({
  name: "secrets-handling",
  description:
    "How to handle credentials, tokens, and keys: configuration, what must never " +
    "reach output or version control, and what to do if one is exposed. Use when " +
    "touching auth, config, CI, deployment, or anything reading a credential.",
  instructions: `# Handling secrets

## Where they live

Environment variables or the platform's secret manager. Never in source, never
in a committed config file, never in a comment, never in a test fixture.

Provide \`.env.example\` with **keys and empty values** so setup is documented,
and make sure \`.env\` is in \`.gitignore\` — check, don't assume.

Read config through the project's existing configuration layer rather than
scattering \`process.env\` reads through the codebase. That gives one place to
validate presence at startup, which turns "mysterious 500 in production" into
"failed to boot with a clear message".

## Never put a secret in output

**This applies to you directly.** Your tool output is streamed to the user's
chat and retained in a replayable event log. Anything you print is published to
everyone with access to that conversation, and stays there.

So, never run:
- \`env\`, \`printenv\`, \`set\` — these dump every credential in the environment
- \`cat .env\` or any file that holds credentials
- \`echo $TOKEN\`, or a debug print of a config object that contains one
- \`curl -v\` against an authenticated endpoint (it prints the Authorization header)
- \`git config --list\` (may include credential helper output)

If you need to confirm a variable is set, test the fact, not the value:
\`[ -n "$TOKEN" ] && echo "TOKEN is set"\`. If you need to identify a key, print
a suffix: \`****\${TOKEN: -4}\`.

Be careful with error paths too — an exception that stringifies a config object
or a request will happily print the secret it contains.

## Never commit one

Before committing, check what you are staging. \`git add -A\` after a build can
sweep up a \`.env\`, a \`credentials.json\`, or a \`*.pem\`.

If you notice a secret already committed **in the history**, stop and tell the
user. Do not attempt to rewrite history to hide it: the credential must be
treated as compromised and **rotated**, and quietly force-pushing over it
destroys the evidence while leaving the secret in every existing clone, fork,
and CI cache. Rotation is the fix; history rewriting is at best cosmetic.

## Generating them

Use a cryptographically secure random source (\`crypto.randomBytes\`,
\`secrets.token_urlsafe\`) — never \`Math.random()\`, never a timestamp, never a
UUID for anything that needs to be unguessable beyond uniqueness. Compare
secrets with a constant-time comparison, not \`===\`.

## In CI and infrastructure

- Reference the platform's secret store; don't inline into workflow YAML.
- Scope tokens as narrowly as the platform allows, with the shortest workable
  lifetime.
- Be aware that anything echoed in a CI log is visible to everyone who can read
  build output.`,
});

/* ------------------------------------------------------- agent integrity */

export const AGENT_INTEGRITY = defineSkill({
  name: "agent-integrity",
  description:
    "What to do when a test, type check, lint rule, or build is failing and you " +
    "are tempted to weaken it — and how to report honestly when you cannot fix " +
    "something. Use whenever a check is red or a control is in your way.",
  instructions: `# When a check is in your way

The most common way an agent makes a codebase worse is not by writing insecure
code. It is by removing the thing that would have caught insecure code, in order
to reach a green result.

A failing check is information. Deleting it destroys the information and keeps
the bug.

## Never do these to go green

- Delete, skip, or \`.only\` around a failing test (\`it.skip\`, \`xit\`,
  \`@Disabled\`, \`pytest.mark.skip\`, commenting out an assertion)
- Weaken an assertion until it passes — including loosening an exact match to
  \`toBeTruthy\`, or widening an expected error
- Add \`eslint-disable\`, \`@ts-ignore\`, \`# type: ignore\`, \`# noqa\`, or
  \`@SuppressWarnings\` to silence a diagnostic
- Loosen a type to \`any\`/\`unknown\` to make a compile error go away
- Relax a validation schema so a malformed payload passes
- Commit with \`--no-verify\`, or disable a pre-commit or CI check
- Downgrade or pin a dependency backwards to dodge a failure
- Delete a security control (a rate limit, an auth check, a CSP header) because
  it complicated your change

## What to do instead

1. **Understand why it fails.** Read the actual error. A failing test usually
   means the code is wrong, not the test.
2. **Fix the cause.** This is the normal outcome.
3. **If the test itself is genuinely wrong** — it encodes behaviour the user
   explicitly asked you to change — update it deliberately, and say so
   prominently in your summary: which test, what it asserted before, why the new
   behaviour is correct. Never fold that into an unrelated change.
4. **If you cannot fix it, stop and report.** A clear "I couldn't get this
   passing, here's the error and what I tried" is a good outcome. A green run
   achieved by disabling the check is a bad one that looks good.

The legitimate exception is when the user has explicitly asked you to remove or
change a specific check. Then it is their call — do it, and confirm what you
removed.

## Reporting honestly

- If you did not run the tests, say "tests not run". Never imply otherwise.
- If you ran a subset, say which.
- If something is partially done, say which part.
- If you worked around a problem rather than solving it, say so and describe the
  workaround.

You are trusted to report your own results. That is worth more than any single
task looking successful.

## Destructive operations

Never \`git push --force\` to a shared branch, rewrite published history, \`git
reset --hard\` over uncommitted work you did not create, delete a branch you did
not make, or run a destructive database command outside a migration. If one of
these genuinely seems necessary, stop and ask.`,
});

/** Every security skill, in the order they appear in the catalog. */
export const SECURITY_SKILLS = [
  SECURE_API_ENDPOINT,
  SAFE_DB_MIGRATION,
  INJECTION_DEFENCE,
  MAINTAIN_API_DOCS,
  DEPENDENCY_HYGIENE,
  SECRETS_HANDLING,
  AGENT_INTEGRITY,
];
