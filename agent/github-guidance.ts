/**
 * System-prompt guidance so the model uses Ada's managed GitHub flow instead of
 * improvising credential advice.
 *
 * Without this, Claude Code — asked to "auth to github" — runs `gh auth status`,
 * finds nothing, and suggests pasting a Personal Access Token or running
 * `gh auth login` (neither works headlessly, and pasting a token into chat is a
 * security anti-pattern). Ada instead manages GitHub via a per-user GitHub App
 * OAuth flow triggered by the `/connect-github` chat command; a connected user's
 * token is injected as GH_TOKEN. This guidance tells the model that.
 */
export function githubPromptGuidance(opts: { configured: boolean; connected: boolean }): string {
  const base =
    "GitHub access on this agent (called Ada) is managed for the user. " +
    "NEVER ask the user to paste a Personal Access Token, never run `gh auth login`, " +
    "never tell them to set GH_TOKEN, and never accept a token pasted into the conversation.";
  if (!opts.configured) {
    return (
      base +
      " GitHub is not set up on this agent yet — an administrator must set up the GitHub App first " +
      "(in the web app: Settings → \"Set up GitHub App\"). " +
      "If the task needs GitHub, tell the user it isn't available yet rather than suggesting any manual auth."
    );
  }
  if (opts.connected) {
    return (
      base +
      " You ARE authenticated to GitHub as this user via a GitHub App token (GH_TOKEN is set). " +
      "Use `git`/`gh` normally — clone, create a branch, push, and open a PR — acting as them. " +
      "IMPORTANT about the App model: your access is limited to the repositories the Ada GitHub " +
      "App is INSTALLED on, with Contents + Pull requests write. So to propose changes, push a branch " +
      "to the repo and open a PR (via `gh pr create`) — do NOT try to fork (the App token cannot create " +
      "forks; it will 403). If a `git push`/`gh` call returns 403 or 'not found' on a repo, the App simply " +
      "isn't installed on that repo (or the org) — do NOT retry, fork, or suggest a PAT. " +
      "Be precise about WHOSE problem that is, because getting it wrong sends people in circles: " +
      "the user has already done their part (authorizing). What is missing is the App INSTALLATION on " +
      "that repository, which is an ORG OWNER's action, once per org — not something the user can fix by " +
      "reconnecting. Say the App needs installing on <org>/<repo> by someone who administers that org — " +
      "in the Ada web app that is Settings → \"Add a repository on GitHub\" (or \"Manage <org> on GitHub\" " +
      "when it is already installed elsewhere). " +
      "Do NOT tell the user to re-run `connect github` and grant repo access: they will be shown an " +
      "installation they have no rights to change, and GitHub will refuse."
    );
  }
  return (
    base +
    " The user has NOT connected their GitHub account yet, so `git`/`gh` are unauthenticated. " +
    "If the task needs GitHub, tell the user to send the message `connect github` here in chat " +
    "(no leading slash — it's not a Slack command) — I'll reply with a link that connects their " +
    "account securely through Ada's GitHub App, with no tokens to paste. " +
    "It only asks them to authorize Ada to act as them; it does NOT ask them to choose repositories, " +
    "so do not tell them to grant access to a repo or to install anything — for a repo in an org where " +
    "the App is already installed, authorizing is the whole of their part. " +
    "Do not attempt any other authentication method."
  );
}
