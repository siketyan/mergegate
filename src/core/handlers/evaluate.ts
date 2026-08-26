import { renderCheck } from "../check/render.ts";
import type { CheckState } from "../check/render.ts";
import { type Config, FALLBACK_CHECK_NAME, type Strategy } from "../config/schema.ts";
import { decide } from "../policy/decide.ts";
import { isLiteral, matchesPattern } from "../policy/glob.ts";
import { evaluateGate } from "../policy/gate.ts";
import type { AppContext, GitHubApi, MergeOutcome, PullRequestState, RepoRef } from "../ports.ts";
import { loadConfig } from "./config.ts";

const TRANSIENT: ReadonlySet<string> = new Set(["head-changed", "not-ready"]);

/**
 * GitHub computes mergeability asynchronously, so the first look at a freshly
 * labelled pull request often finds it undetermined. Nothing is guaranteed to
 * wake the app again — a repository with no other checks gets no further events
 * — so it waits here rather than leaving the pull request blocked for good.
 * Bounded, because "do not wait forever" is the other half of that rule.
 */
const MERGEABILITY_BACKOFF_MS = [2000, 4000, 8000] as const;

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

function commitValues(pullRequest: PullRequestState): Record<string, string> {
  return {
    base: pullRequest.base,
    head: pullRequest.head,
    number: String(pullRequest.number),
    title: pullRequest.title,
  };
}

async function report(
  api: GitHubApi,
  repo: RepoRef,
  name: string,
  headSha: string,
  state: CheckState,
): Promise<void> {
  const output = renderCheck(state);
  await api.upsertCheckRun(repo, {
    name,
    headSha,
    conclusion: output.conclusion,
    title: output.title,
    summary: output.summary,
    actions: output.actions,
  });
}

async function merge(
  api: GitHubApi,
  repo: RepoRef,
  config: Config,
  pullRequest: PullRequestState,
  strategy: Strategy,
): Promise<MergeOutcome> {
  const values = commitValues(pullRequest);
  return api.mergePullRequest(repo, pullRequest.number, {
    method: strategy,
    // The SHA that was evaluated: a commit pushed since must not be merged.
    sha: pullRequest.headSha,
    commitTitle: renderTemplate(config.merge.commitTitle, values),
    commitMessage: renderTemplate(config.merge.commitMessage, values),
  });
}

async function runAssistedMerge(
  context: AppContext,
  api: GitHubApi,
  repo: RepoRef,
  config: Config,
  pullRequest: PullRequestState,
  strategy: Strategy,
  labelled: boolean,
): Promise<void> {
  const checkName = config.check.name;
  const outcome = await merge(api, repo, config, pullRequest, strategy);

  if (outcome.ok) {
    context.logger.info("merged", { pull: pullRequest.number, strategy, sha: outcome.sha });
    await report(api, repo, checkName, pullRequest.headSha, { kind: "merged", strategy });
    if (config.merge.deleteBranchOnMerge && !pullRequest.isFork) {
      await api.deleteBranch(repo, pullRequest.head);
    }
    return;
  }

  context.logger.warn("merge refused", {
    pull: pullRequest.number,
    kind: outcome.kind,
    reason: outcome.message,
  });
  await report(api, repo, checkName, pullRequest.headSha, {
    kind: "merge-failed",
    message: outcome.message,
    strategy,
    // Nothing brings mergegate back to an unlabelled pull request, so the way
    // to retry has to stay on the check run itself.
    offerMerge: config.merge.allowCheckAction && !labelled,
  });

  // A transient failure is retried by the next event; a permanent one drops the
  // label so that re-adding it is the retry. A merge that was armed from the
  // Checks tab and failed before the label went on has nothing to drop.
  if (!TRANSIENT.has(outcome.kind) && labelled && config.merge.removeLabelOnFailure) {
    await api.removeLabel(repo, pullRequest.number, config.merge.label);
  }
}

/**
 * Ask GitHub which of the configured source branches this pull request actually
 * brings commits from. Only rules that opted in are looked up, and only their
 * literal head branches, so a configuration without `includeTransitive` costs
 * nothing.
 */
async function resolveCarriedFrom(
  api: GitHubApi,
  repo: RepoRef,
  config: Config,
  pullRequest: PullRequestState,
): Promise<ReadonlySet<string>> {
  const sources = new Set<string>();
  for (const rule of config.rules) {
    if (!rule.includeTransitive || !matchesPattern(rule.base, pullRequest.base)) {
      continue;
    }
    for (const pattern of rule.head) {
      // A head that already matches by name needs no lookup.
      if (isLiteral(pattern) && pattern !== pullRequest.head) {
        sources.add(pattern);
      }
    }
  }

  const carried = new Set<string>();
  for (const source of sources) {
    const carries = await api.carriesCommitsFrom(repo, {
      base: pullRequest.base,
      head: pullRequest.head,
      source,
    });
    if (carries) {
      carried.add(source);
    }
  }
  return carried;
}

/** A press of the "Merge now" button, as it reached the webhook. */
export interface MergeRequest {
  /** The head the check run carrying the button was rendered on. */
  readonly headSha: string;
  /** Who pressed it. */
  readonly actor: string;
}

export interface EvaluateOptions {
  readonly mergeRequest?: MergeRequest;
}

/**
 * Whether a press of the button is honoured. The app bypasses the ruleset, so
 * this is the only thing between a button in a browser and a merge: the feature
 * has to be enabled, the button has to belong to the commit being evaluated,
 * and whoever pressed it has to be able to push.
 */
async function acceptMergeRequest(
  context: AppContext,
  api: GitHubApi,
  repo: RepoRef,
  config: Config,
  pullRequest: PullRequestState,
  request: MergeRequest | undefined,
): Promise<boolean> {
  if (request === undefined) {
    return false;
  }
  if (!config.merge.allowCheckAction) {
    context.logger.info("merge action disabled by configuration", { pull: pullRequest.number });
    return false;
  }
  if (request.headSha !== pullRequest.headSha) {
    // The button was rendered on a commit that is no longer the head, so
    // nobody has asked for *this* commit to be merged.
    context.logger.warn("merge action ignored: head moved", {
      pull: pullRequest.number,
      requested: request.headSha,
      head: pullRequest.headSha,
    });
    return false;
  }
  if (!(await api.canPush(repo, request.actor))) {
    context.logger.warn("merge action refused: no write access", {
      pull: pullRequest.number,
      actor: request.actor,
    });
    return false;
  }
  context.logger.info("merge requested from the checks tab", {
    pull: pullRequest.number,
    actor: request.actor,
  });

  return true;
}

/**
 * Re-read the pull request while GitHub is still working out whether it merges
 * cleanly. Returns the last state seen — still undetermined if the backoff runs
 * out — or `null` when the head moved and this evaluation is stale.
 */
async function settleMergeability(
  context: AppContext,
  api: GitHubApi,
  repo: RepoRef,
  checkName: string,
  pullRequest: PullRequestState,
): Promise<PullRequestState | null> {
  let current = pullRequest;
  for (const delay of MERGEABILITY_BACKOFF_MS) {
    if (current.mergeable !== null) {
      return current;
    }
    await context.sleep(delay);
    const refreshed = await api.getPullRequestState(repo, current.number, {
      ownCheckName: checkName,
    });
    if (refreshed === null || refreshed.state !== "open") {
      return current;
    }
    if (refreshed.headSha !== pullRequest.headSha) {
      return null;
    }
    current = refreshed;
  }
  return current;
}

/**
 * Decide what a pull request is allowed to do, say so in the check run, and
 * merge it when it is an assisted merge that has cleared every gate.
 */
export async function evaluatePullRequest(
  context: AppContext,
  api: GitHubApi,
  repo: RepoRef,
  pullNumber: number,
  options: EvaluateOptions = {},
): Promise<void> {
  const result = await loadConfig(context, api, repo);

  // With a broken configuration the configured check name is unknown, so fail
  // closed under the default name -- the one a ruleset is normally pointed at.
  const checkName = result.ok ? result.config.check.name : FALLBACK_CHECK_NAME;

  const pullRequest = await api.getPullRequestState(repo, pullNumber, { ownCheckName: checkName });
  if (pullRequest === null || pullRequest.state !== "open") {
    return;
  }

  if (!result.ok) {
    await report(api, repo, checkName, pullRequest.headSha, {
      kind: "invalid-config",
      errors: result.errors,
    });
    return;
  }

  const config = result.config;
  const decision = decide(config, {
    base: pullRequest.base,
    head: pullRequest.head,
    isFork: pullRequest.isFork,
    carriedFrom: await resolveCarriedFrom(api, repo, config, pullRequest),
  });

  switch (decision.kind) {
    case "manual":
      await report(api, repo, checkName, pullRequest.headSha, {
        kind: "manual",
        strategy: decision.strategy,
      });
      return;

    case "forbidden":
      await report(api, repo, checkName, pullRequest.headSha, {
        kind: "forbidden",
        base: pullRequest.base,
        head: pullRequest.head,
      });
      return;

    case "assisted": {
      const labelled = pullRequest.labels.includes(config.merge.label);
      const requested =
        !labelled &&
        (await acceptMergeRequest(context, api, repo, config, pullRequest, options.mergeRequest));

      if (!labelled && !requested) {
        await report(api, repo, checkName, pullRequest.headSha, {
          kind: "awaiting-label",
          strategy: decision.strategy,
          label: config.merge.label,
          offerMerge: config.merge.allowCheckAction,
        });
        return;
      }

      const settled = await settleMergeability(context, api, repo, checkName, pullRequest);
      if (settled === null) {
        // The head moved while waiting; the push's own event re-evaluates it.
        return;
      }

      const gate = evaluateGate(settled, config.merge);
      if (!gate.ready) {
        // A press merges or it does not; it leaves nothing behind that would
        // make mergegate come back. Only the label does that, so an unlabelled
        // pull request keeps the button and is told as much.
        await report(api, repo, checkName, settled.headSha, {
          kind: "waiting",
          reason: gate.reason,
          label: config.merge.label,
          strategy: decision.strategy,
          armed: labelled,
          offerMerge: config.merge.allowCheckAction && !labelled,
        });
        return;
      }

      await runAssistedMerge(context, api, repo, config, settled, decision.strategy, labelled);
      return;
    }
  }
}
