# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

**mergegate** is a GitHub App that enforces the merge strategy per pull request in repositories with
several long-lived branches. It looks up a rule from the PR's `(base, head)` pair, fails the check run for
PRs that must not be squashed — which blocks the merge through a ruleset — and merges PRs that need a merge
commit itself once the `ready-to-merge` label is added.

The full user-facing specification lives in **[README.md](./README.md)**. **Whenever behaviour changes,
update the README as well.** The README is the specification; the implementation follows it.

## Stack

- **Language**: TypeScript (strict, ESM only)
- **Toolchain**: [Vite+](https://viteplus.dev) (`vp`) — Vite, Vitest, Oxlint, Oxfmt and tsdown behind one CLI
- **Package manager**: pnpm, pinned through `devEngines`. Vite+ itself comes from the `pnpm-workspace.yaml`
  catalog
- **Runtime**: Cloudflare Workers (`wrangler`). There is deliberately no second runtime adapter yet
- **Validation**: valibot (small enough to ship in a Worker)
- **GitHub API**: Octokit — `@octokit/core` with `restEndpointMethods`, `retry` and `throttling`, plus
  `@octokit/auth-app` in a WebCrypto-compatible setup

### Commands

```console
$ vp install          # Install dependencies (pnpm underneath)
$ vp check            # Format + lint + typecheck (always run before committing)
$ vp check --fix      # Auto-fix
$ vp test             # Vitest (single run)
$ vp fmt              # Oxfmt only
$ vp lint             # Oxlint only
$ vp run codegen      # Regenerate GraphQL types after editing a query
$ vp run schema       # Regenerate the JSON Schema after editing the config schema
$ wrangler dev        # Run the Worker locally
$ wrangler deploy     # Deploy
```

- **Bundling is wrangler's job.** Point wrangler at the Worker entry point directly; do not use `vp build`.
  Vite+ is used for check, test and task running.
- If tests need `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`), note that its
  incompatibility with Vite+ was fixed in cloudflare/workers-sdk#13075 — but **write core tests so they do
  not need workerd** (see the testing policy below).

## Layout and direction of dependencies

Everything under `src/` except `adapters/` is the core: runtime-agnostic, web standard APIs only.

```
src/
  config/                  # Parsing and validation of .github/mergegate.yml
  policy/                  # (base, head, config) -> Decision, pure functions. The heart of the app
  policy/gate.ts           # Merge readiness: the gates GitHub would apply if we did not bypass it
  check/                   # Building check run output (title / summary)
  handlers/                # Per-event webhook handling, talking to GitHub through ports
  ports.ts                 # GitHubApi, Env, Cache, Logger, Deferrer interfaces
  webhook.ts               # Signature verification and dispatch. (Request) => Promise<Response>
  adapters/                # The only place a runtime or a vendor SDK may be named
    github/                # GitHubApi implementation over Octokit (REST + GraphQL)
    github/generated/      # graphql-codegen output. Never edit by hand
    cloudflare/            # Workers entry: env bindings, ctx.waitUntil, KV
    shared/                # Adapter-side helpers (logger, env)
schema/                    # JSON Schema for the config file, generated. Never edit by hand
scripts/                   # Generators run through `vp run`
test/
  fixtures/                # Real webhook payload samples
  fake-github.ts           # In-memory GitHubApi and test context
  architecture.test.ts     # Checks the layering rules below rather than trusting them
```

Unit tests live next to the code they cover as `*.test.ts`. `test/` holds fixtures and anything shared
between test files.

The entry point is a plain `(request: Request) => Promise<Response>` plus four ports, which is all another
runtime has to provide:

| Port       | Responsibility                            | Cloudflare implementation |
| ---------- | ----------------------------------------- | ------------------------- |
| `Env`      | Secrets and settings                      | Worker `env` bindings     |
| `Deferrer` | Work that continues after the response    | `ctx.waitUntil`           |
| `Cache`    | Config cache and deduplication (optional) | Workers KV                |
| `Logger`   | Structured logging                        | `console` (JSON)          |

`schema/` is also the Workers assets directory, with `not_found_handling: "none"` so that everything which
is not an asset still reaches the Worker. A request that matches one never reaches the script, which is why
serving the JSON Schema costs no invocations.

**Dependencies always point `adapters -> core`.**

- Never import from `adapters` inside core.
- Never import `node:*` inside core, and never touch `process.env` (everything goes through the `Env` port).
- Core may only use web standard APIs (`fetch`, `crypto.subtle`, `URL`, `TextEncoder`, …).
- Adding a new runtime must only require changes under `adapters/`.
- The first two rules are enforced by `no-restricted-imports` in `vite.config.ts`, which sets them for all
  of `src/` and takes them off `src/adapters/`, so `vp check` catches them;
  `test/architecture.test.ts` covers what a lint rule cannot see.

## Invariants

These map directly onto promises the README makes to users. Do not break them.

1. **Configuration is read from the default branch only**, never from the PR head, so rules cannot be
   tampered with from a PR.
2. **Fail closed.** When a decision cannot be made (invalid config, API error), fail the check. Never let
   an ambiguous case through.
3. **Upsert check runs.** Never create a duplicate check run for the same `(name, head_sha)`: look up the
   existing one and update it, create only if absent.
4. **Ignore our own results.** Return early from a `check_run` / `check_suite` **completion** produced by
   this app, to avoid infinite loops. `rerequested` and `requested_action` are the opposite: GitHub sends
   them only to the app owning the check run, so handle them precisely when the app _is_ ours.
5. **Pass the head SHA when merging.** Always send `sha` to `PUT /pulls/{n}/merge` with the SHA that was
   evaluated. On 409, abort and re-evaluate — unreviewed commits must never be merged.
6. **The label is not a sufficient condition.** Re-verify mergeability, other checks and `reviewDecision`
   before every assisted merge; the app bypasses the ruleset, so GitHub's own gates do not apply.
   The `Merge now` check run action goes through the same gates, plus a write-access check on whoever
   pressed it and a head SHA that still matches the check run the button was on. It merges or it reports
   why it cannot; it never writes a label, because the label is the user's instruction, not the app's.
7. **Never process a request that fails signature verification.** Compare in constant time.
8. **Respond 202 immediately and continue the work through the `Deferrer` port**, to stay inside GitHub's
   10-second webhook timeout.
9. **First matching rule wins**, in the order written in the configuration file.
10. **Own no state.** Caches and deduplication stores must be safe to lose at any time.

## Testing policy

- **`policy/` comes first.** Table-driven tests over `(config, base, head)` -> `Decision`. The
  configuration examples in the README (develop/staging/production and main/release) become test cases
  verbatim.
- Test `config/` for both valid input and failures: unknown keys, version mismatch, malformed globs.
- Test `handlers/` against an in-memory fake `GitHubApi`. No network.
- Test signature verification with fixed vectors.
- Keep real webhook payloads under `test/fixtures/` and use them typed.
- **Tests that need workerd stay in `adapters/cloudflare`.** Core tests run in a plain Node environment.

## Conventions

- TypeScript strict. No `any`, no non-null assertions (`!`). Validate all external input.
- Pin every dependency to an exact version. No `^`, no `~`.
- No barrel files: import from the module that defines the thing.
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
- Check run `actions` are capped at three per run, with a 20 character label, a 40 character description and
  a 20 character identifier. Send the list on every upsert: it replaces, so omitting it leaves a stale button.
- REST goes through the typed wrappers (`octokit.rest.checks.create`, …), never raw `octokit.request`.
- GraphQL responses are typed by graphql-codegen from GitHub's published schema, so a query and its types
  cannot drift. Edit the query, then run `vp run codegen`.
- The JSON Schema users point their editor at is generated from the valibot schema by `vp run schema`. Both
  generated artefacts are committed, excluded from the formatter, and checked for drift in CI.
- `mergeable` is computed asynchronously and can be `null`. Treat that as undetermined and re-fetch with a
  short backoff — but do not wait forever.
- `statusCheckRollup.contexts` pages at 100. Walk the rest against the head commit, bound the walk, and
  report a rollup that could not be read to the end as truncated: an unread check is not a passing one, so
  the gate must refuse rather than merge on the part it saw.
- Decide `includeTransitive` from two merge bases — where the base and the source last agreed, against how
  much of the source the head has. Never from tip containment: that answer changes the moment someone
  pushes to the source branch while the pull request is open.
- A merge method disabled in repository settings returns 405 from the API too. Surface the message in the
  check output as-is.
- Install retry and throttling plugins for rate limits and secondary rate limits.
- Detect forks with `head.repo.full_name !== base.repo.full_name`.

## Do not

- Leak Cloudflare-specific types (`ExecutionContext`, `KVNamespace`, …) into core.
- Inline decision logic into webhook handlers; it belongs in the pure functions under `policy/`.
- Bolt runtime-dependent arguments onto core functions for testing. Add a port instead.
- Log secrets (app private key, webhook secret, tokens).
- Swallow a failure and report the check as success.
