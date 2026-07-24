# Contributing to Ada

Thanks for your interest in contributing to **Ada** — a coding agent (powered by Claude Code) you talk to over Slack, web chat, or an AG-UI/SSE frontend. Ada is packaged to run on the Astro AI platform, with either the Astropods CLI (`ast`) or from astropods.com. This document outlines the process for contributing and provides specific guidance for code contributions.

---

## Issues

The easiest way to contribute is to open an issue with a bug report or a suggestion for improvement. We do not have a prescriptive issue template at this time. We request that you take the time to communicate clearly so that we can understand what is being requested and respond appropriately.

- For bug reports, give as much detail as you can about exactly what you were doing when the problem occurred, and use transcripts or screenshots to show the problematic behavior. Include the `ast` version (`ast --version`) and your platform.
- For enhancement requests, give the context. Ideally, explain why the improvement would be broadly useful. Then be as explicit as you can about how you see the change looking and behaving.
- Check other open issues and add comments to existing issues rather than creating duplicates.

---

## How to contribute

1. **Fork** the repository
2. **Create a branch** for your changes
3. **Open a pull request** with a description of the change and how to test it

---

## Contributions of source code

All such contributions should be in the form of pull requests. The exact format of the pull request description is not important but it should include

- _motivation_: what problem the contribution is trying to solve and why it should be regarded as helpful
- _externals_: what visible changes to Ada's behavior (or to `ast` workflows) will occur if the pull request is merged
- (optionally) _internals_: anything that will help orient a reviewer in reading the code.

By opening a pull request

- You agree that your contributions will be licensed under the [Apache 2.0 License](LICENSE).
- When you open a pull request with your contributions, **you are certifying that you wrote the code** in the corresponding patch pursuant to the [Developer Certificate of Origin](#developer-certificate-of-origin) included below for your reference.
- You must conform to the project's style and validation rules. Before submitting:
  - Run `ast spec validate` against `astropods.yml` if you changed it.
  - Typecheck: `bun run typecheck` (or `npm run typecheck`).
  - Run the end-to-end tests: `npx playwright test` — no model credential needed (see [`README.md`](README.md) → "Tests" for the one-time browser install).
  - Verify the agent still boots with `ast dev` (or `node agent/index.ts`) from the repo root.

---

## Contact us

We're always happy to help you with any issues you encounter. The best place to reach us is by opening an issue or discussion in this repository. For platform-level questions, see the docs at <https://docs.astropods.com>.

---

## Developer Certificate of Origin

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.
1 Letterman Drive
Suite D4700
San Francisco, CA, 94129

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```
