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
import { getSessionEnv } from "./session-env.ts";

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
      const result = await ensureRepo(env.cwd, spec, { githubToken: token });
      log.info(result.cloned ? `Cloned into ${result.dir}` : `Reusing existing checkout at ${result.dir}`);
      return { output: result };
    },
  });
}
