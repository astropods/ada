/**
 * Ada's application tools — the capabilities that aren't just "a shell".
 *
 * The file and shell verbs (`read`/`write`/`edit`/`bash`/`grep`/`glob`) come
 * free from `useSandbox()`, so this module only carries work that needs a
 * credential or a server-side decision the model must not make itself.
 *
 * Security note (the reason `checkout_repo` exists at all): the model could
 * `bash git clone` on its own, but then the clone URL — and therefore the host
 * a credential helper would answer to — is model-controlled. Here the model
 * supplies only `owner/repo`; Ada resolves the token and the host. That follows
 * Flue's guidance that the APPLICATION, not the model, decides which repository
 * and which credential a tool may use.
 */

import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import { ensureRepo, parseRepoSpec } from "../session/repo.ts";
import { ensureRepoInSandbox, remoteSandboxDriver } from "../session/remote-sandbox.ts";
import { getSessionEnv, setCheckoutDir } from "./session-env.ts";

/**
 * Clone (or reuse) a GitHub repository into the session's workspace, using the
 * connected user's App token. Bound to one instance id so the token and cwd are
 * resolved from that session's context rather than passed through the model.
 */
export function checkoutRepo(instanceId: string) {
  return defineTool({
    name: "checkout_repo",
    description:
      "Clone a GitHub repository into the working directory so you can read and edit it. " +
      "Reuses the existing checkout if it is already present (work in progress is preserved). " +
      "Takes owner/repo — you never supply a URL or a credential.",
    input: v.object({
      repo: v.pipe(
        v.string(),
        v.description("The repository as owner/repo, e.g. astropods/ada."),
      ),
    }),
    output: v.object({
      dir: v.string(),
      cloned: v.boolean(),
    }),
    async run({ data, log }) {
      const spec = parseRepoSpec(data.repo);
      if (!spec) {
        throw new Error(`"${data.repo}" is not a valid repository — use the form owner/repo.`);
      }
      const env = getSessionEnv(instanceId);
      const token = env.sandboxEnv.GH_TOKEN;
      if (!token) {
        throw new Error(
          "GitHub is not connected for this user, so private repositories are unreachable. " +
            "Ask the user to send `connect github` in chat.",
        );
      }
      log.info(`Checking out ${spec.owner}/${spec.repo}…`);

      // Clone WHERE EXECUTION HAPPENS. This tool used to always clone locally,
      // which was invisible to a deployment running the isolated sandbox: the
      // clone reported success at a control-plane path the agent's own bash
      // could never reach, and every subsequent tool call failed. The clone has
      // to land in the same filesystem the shell runs in.
      const result = env.remote
        ? await ensureRepoInSandbox(
            remoteSandboxDriver({
              baseUrl: env.remote.baseUrl,
              token: env.remote.token,
              id: instanceId,
              env: env.sandboxEnv,
            }),
            spec,
            { githubToken: token },
          )
        : await ensureRepo(env.cwd, spec, { githubToken: token });

      log.info(result.cloned ? `Cloned into ${result.dir}` : `Reusing existing checkout at ${result.dir}`);
      // Root the NEXT turn inside the checkout, so Flue's own workspace
      // discovery (AGENTS.md, .agents/skills) sees the repo rather than the
      // directory it happens to sit in.
      setCheckoutDir(instanceId, result.dir);
      return { output: result };
    },
  });
}
