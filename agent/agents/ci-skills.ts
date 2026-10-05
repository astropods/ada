/**
 * Playbooks for work that is not about security, in the same shape as
 * `security/skills.ts` — a one-line description in the prompt permanently, and
 * a body the model loads only when it decides the skill applies. See that
 * file's header for the authoring rules these follow.
 */

import { defineSkill } from "@flue/runtime";

export const INVESTIGATE_CI_FAILURE = defineSkill({
  name: "investigate-ci-failure",
  description:
    "How to find and read the logs of a failed CI run from a chat message about it — " +
    "locating the run with `gh`, reading only the failing step, and telling a real " +
    "failure apart from a flake. Use whenever someone reports a build, workflow, " +
    "check or pipeline failing, or links to one.",
  instructions: `# Investigating a CI failure

A notification in chat usually names the workflow and branch and little else.
That is enough: find the run yourself rather than asking for more.

## 1. Find the run

\`\`\`bash
gh run list --workflow "<workflow name>" --branch <branch> --limit 5 \\
  --json databaseId,status,conclusion,headSha,createdAt,displayTitle
\`\`\`

Take the most recent with \`"conclusion": "failure"\`. If the message named a
commit or PR, match on \`headSha\` instead of assuming the newest is the one
being discussed — a branch often has several runs within minutes.

**Do not fetch the run's web URL.** A "View workflow" button links to an HTML
page: it needs a browser session for a private repo, and it renders logs rather
than returning them. \`gh\` is already authenticated with the user's token and
returns the real thing.

## 2. Read the FAILING step, not the whole log

\`\`\`bash
gh run view <run-id> --log-failed
\`\`\`

\`--log-failed\` is the important part. A full \`--log\` of a real CI run is
routinely tens of megabytes, and your sandbox caps command output at about 1
MiB per stream — so you would get a silently truncated prefix, which usually
contains the setup steps and not the error. If even the failed step is large,
narrow it further:

\`\`\`bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | {name, databaseId}'
gh run view --job <job-id> --log | tail -200
\`\`\`

## 3. Decide whether it is actually about the change

Before reporting a cause, rule out the two cases that look identical to a real
failure in the log:

- **Pre-existing.** Check whether the same job fails on the base branch, or
  whether the previous run on the same branch failed the same way. A failure
  that predates the change is not evidence about the change.
- **Infrastructure.** Timeouts, a runner losing the network, an out-of-memory
  kill, a registry 500. These say nothing about the code. Name them as
  environmental rather than reporting them as a defect.

If you cannot tell, say so. "This test also times out on \`main\`, so it looks
pre-existing" is a useful answer; silently attributing it to the change is not.

## 4. Report the cause, not the log

Quote the failing assertion or error line and the file it came from. Do not
paste the log back — the person already has a link to it, and what they lack is
which line mattered.

Say what you verified and what you did not. "Three tests fail, all on the same
missing fixture" is a finding. "CI is broken" is not.

## Do not re-run without being asked

\`gh run rerun\` costs minutes and, when the failure is real, produces the same
result. Diagnose first, and offer a re-run only when you have reason to believe
the failure was environmental.
`,
});

export const WORKFLOW_SKILLS = [INVESTIGATE_CI_FAILURE];
