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
import { parseRepoSpec } from "../session/repo.ts";
import { getSessionEnv, setCheckoutDir } from "./session-env.ts";
import { readRepoRules, renderRules, sandboxExec } from "./repo-rules.ts";

/**
 * Clone (or reuse) a GitHub repository, using the connected user's App token,
 * and hand back the project's own conventions along with it.
 *
 * Bound to one instance id so the token is resolved from that session's context
 * rather than passed through the model.
 */
export function checkoutRepo(instanceId: string) {
  return defineTool({
    name: "checkout_repo",
    description:
      "Clone a GitHub repository into the working directory so you can read and edit it. " +
      "Reuses the existing checkout if it is already present (work in progress is preserved). " +
      "Also returns the repository's own conventions, which you must follow. " +
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
      conventions: v.optional(v.string()),
    }),
    // Harness access so the clone runs in the agent's OWN sandbox — the same
    // filesystem its shell and file tools see. Branching on local-vs-remote
    // here is what previously put a clone in the control-plane container that
    // the agent could never reach.
    harness: true,
    async run({ data, log, harness }) {
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

      const sandbox = harness.sandbox;
      const dir = spec.repo;
      const cloned = !(await sandbox.exists(`${dir}/.git`));
      if (cloned) {
        log.info(`Cloning ${spec.owner}/${spec.repo}…`);
        // owner/repo have been through parseRepoSpec, whose pattern excludes
        // every shell metacharacter — they are safe to interpolate here.
        const result = await sandbox.exec(
          `git clone --depth=1 https://github.com/${spec.owner}/${spec.repo}.git ${dir}`,
          { env: { GH_TOKEN: token, GITHUB_TOKEN: token }, timeoutMs: 10 * 60 * 1000 },
        );
        if (result.exitCode !== 0) {
          throw new Error(`clone failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
        }
      } else {
        log.info(`Reusing existing checkout at ${dir}`);
      }

      // Surface the project's conventions HERE, with the clone.
      //
      // The start-of-turn hook cannot help a repository that does not exist
      // yet: on a first turn the workspace is empty, the agent clones
      // mid-turn, and it would otherwise branch, commit and open a pull
      // request without ever having read the rules. That is exactly how a PR
      // shipped with no changelog entry against a repo whose `agents.md`
      // requires one. Flue's own AGENTS.md discovery has the same blind spot,
      // for the same reason — it reads at submission start.
      const rules = await readRepoRules(sandboxExec(sandbox));
      const conventions = renderRules(rules);
      if (conventions) {
        log.info(`Read repository conventions: ${rules.map((r) => r.path).join(", ")}`);
      }

      // Root the NEXT turn inside the checkout, so Flue's own workspace
      // discovery sees the repo rather than the directory it sits in.
      setCheckoutDir(instanceId, dir);
      return { output: { dir, cloned, conventions } };
    },
  });
}
