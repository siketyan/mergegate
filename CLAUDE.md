# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

**squashables** is a GitHub App that enforces the merge strategy per pull request in repositories with
several long-lived branches. It looks up a rule from the PR's `(base, head)` pair, fails the check run for
PRs that must not be squashed — which blocks the merge through a ruleset — and merges PRs that need a merge
commit itself once the `ready-to-merge` label is added.

The full user-facing specification lives in **[README.md](./README.md)**. **Whenever behaviour changes,
update the README as well.** The README is the specification; the implementation follows it.

## Current state

Scaffolded. `core` is implemented and tested: configuration parsing, the policy that turns
`(base, head)` into a decision, the merge gate, check run rendering, webhook signature verification and
the event handlers. The Cloudflare and Node adapters wire it up, and the Octokit adapter implements the
`GitHubApi` port. Nothing has been deployed and the app has never talked to real GitHub yet.

## Stack

- **Language**: TypeScript (strict, ESM only)
- **Toolchain**: [Vite+](https://viteplus.dev) (`vp`) — Vite, Vitest, Oxlint, Oxfmt and tsdown behind one CLI
- **Primary runtime**: Cloudflare Workers (`wrangler`)
- **GitHub API**: Octokit (`@octokit/core` plus `@octokit/auth-app`, in a WebCrypto-compatible setup)

### Commands

```console
$ vp install          # Install dependencies
$ vp check            # Format + lint + typecheck (always run before committing)
$ vp check --fix      # Auto-fix
$ vp test             # Vitest (single run)
$ vp fmt              # Oxfmt only
$ vp lint             # Oxlint only
$ wrangler dev        # Run the Worker locally
$ wrangler deploy     # Deploy
```

- **Bundling is wrangler's job.** Point wrangler at the Worker entry point directly; do not use `vp build`.
  Vite+ is used for check, test and task running.
- If tests need `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`), note that its
  incompatibility with Vite+ was fixed in cloudflare/workers-sdk#13075 — but **write core tests so they do
  not need workerd** (see the testing policy below).

## Layout and direction of dependencies

```
src/
  core/                    # Runtime-agnostic. Web standard APIs only
    config/                # Parsing and validation of .github/squashables.yml
    policy/                # (base, head, config) -> Decision, pure functions. The heart of the app
    check/                 # Building check run output (title / summary)
    handlers/              # Per-event webhook handling, talking to GitHub through ports
    policy/gate.ts         # Merge readiness: the gates GitHub would apply if we did not bypass it
    ports.ts               # GitHubApi, Env, Cache, Logger, Clock, Deferrer interfaces
    webhook.ts             # Signature verification and dispatch. (Request) => Promise<Response>
  adapters/
    github/                # GitHubApi implementation over Octokit (REST + GraphQL)
    cloudflare/            # Workers entry: env bindings, ctx.waitUntil, KV
    node/                  # node:http entry (self-hosting and local verification)
    shared/                # Adapter-side helpers both runtimes use (logger, env, memory cache)
test/
  fixtures/                # Real webhook payload samples
  fake-github.ts           # In-memory GitHubApi and test context
  architecture.test.ts     # Checks the layering rules below rather than trusting them
```

Unit tests live next to the code they cover as `*.test.ts`. `test/` holds fixtures and anything shared
between test files.

**Dependencies always point `adapters -> core`.**

- Never import from `adapters` inside `core`.
- Never import `node:*` inside `core`, and never touch `process.env` (everything goes through the `Env` port).
- `core` may only use web standard APIs (`fetch`, `crypto.subtle`, `URL`, `TextEncoder`, …).
- Adding a new runtime must only require changes under `adapters/`.

## Invariants

These map directly onto promises the README makes to users. Do not break them.

1. **Configuration is read from the default branch only**, never from the PR head, so rules cannot be
   tampered with from a PR.
2. **Fail closed.** When a decision cannot be made (invalid config, API error), fail the check. Never let
   an ambiguous case through.
3. **Upsert check runs.** Never create a duplicate check run for the same `(name, head_sha)`: look up the
   existing one and update it, create only if absent.
4. **Ignore our own events.** Return early from `check_run` / `check_suite` events produced by this app, to
   avoid infinite loops.
5. **Pass the head SHA when merging.** Always send `sha` to `PUT /pulls/{n}/merge` with the SHA that was
   evaluated. On 409, abort and re-evaluate — unreviewed commits must never be merged.
6. **The label is not a sufficient condition.** Re-verify mergeability, other checks and `reviewDecision`
   before every assisted merge; the app bypasses the ruleset, so GitHub's own gates do not apply.
7. **Never process a request that fails signature verification.** Compare in constant time.
8. **Respond 202 immediately and continue the work through the `Deferrer` port**, to stay inside GitHub's
   10-second webhook timeout.
9. **First matching rule wins**, in the order written in the configuration file.
10. **Own no state.** Caches and deduplication stores must be safe to lose at any time.

## Testing policy

- **`core/policy` comes first.** Table-driven tests over `(config, base, head)` -> `Decision`. The
  configuration examples in the README (develop/staging/production and main/release) become test cases
  verbatim.
- Test `core/config` for both valid input and failures: unknown keys, version mismatch, malformed globs.
- Test `core/handlers` against an in-memory fake `GitHubApi`. No network.
- Test signature verification with fixed vectors.
- Keep real webhook payloads under `test/fixtures/` and use them typed.
- **Tests that need workerd stay in `adapters/cloudflare`.** Core tests run in a plain Node environment.

## Conventions

- TypeScript strict. No `any`, no non-null assertions (`!`). Validate all external input.
- Model domain types (`Decision`, `Strategy`, `Rule`, `MergeGate`) as discriminated unions and branch with
  `switch` so exhaustiveness checking applies.
- Keep the config schema and its validation in one place, deriving the types from the schema.
- Do not let errors escape untyped: distinguish "transient, retryable" from "permanent, drop the label" in
  the type system.
- Structured JSON logs. Include `X-GitHub-Delivery` as the request id on every log line.
- Documentation and user-visible strings (check run title / summary) are in English.
- Conventional Commits for commit messages.

## GitHub API notes

- `pull_requests` in `check_suite.completed` is empty for PRs from forks. Fall back to
  `GET /repos/{owner}/{repo}/commits/{sha}/pulls`.
- Use GraphQL `reviewDecision` for review state instead of recounting reviews over REST.
- `mergeable` is computed asynchronously and can be `null`. Treat that as undetermined and re-fetch with a
  short backoff — but do not wait forever.
- A merge method disabled in repository settings returns 405 from the API too. Surface the message in the
  check output as-is.
- Install retry and throttling plugins for rate limits and secondary rate limits.
- Detect forks with `head.repo.full_name !== base.repo.full_name`.

## Do not

- Leak Cloudflare-specific types (`ExecutionContext`, `KVNamespace`, …) into `core`.
- Inline decision logic into webhook handlers; it belongs in the pure functions under `core/policy`.
- Bolt runtime-dependent arguments onto `core` functions for testing. Add a port instead.
- Log secrets (app private key, webhook secret, tokens).
- Swallow a failure and report the check as success.
