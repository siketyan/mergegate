import { renderCheck } from "../check/render.ts";
import type { CheckState } from "../check/render.ts";
import { FALLBACK_CHECK_NAME, type Config, type Strategy } from "../config/index.ts";
import { decide } from "../policy/decide.ts";
import { evaluateGate } from "../policy/gate.ts";
import type { AppContext, GitHubApi, MergeOutcome, PullRequestState, RepoRef } from "../ports.ts";
import { loadConfig } from "./config.ts";

const TRANSIENT: ReadonlySet<string> = new Set(["head-changed", "not-ready"]);

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
  });

  // A transient failure is retried by the next event; a permanent one drops the
  // label so that re-adding it is the retry.
  if (!TRANSIENT.has(outcome.kind) && config.merge.removeLabelOnFailure) {
    await api.removeLabel(repo, pullRequest.number, config.merge.label);
  }
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
      if (!pullRequest.labels.includes(config.merge.label)) {
        await report(api, repo, checkName, pullRequest.headSha, {
          kind: "awaiting-label",
          strategy: decision.strategy,
          label: config.merge.label,
        });
        return;
      }

      const gate = evaluateGate(pullRequest, config.merge);
      if (!gate.ready) {
        await report(api, repo, checkName, pullRequest.headSha, {
          kind: "waiting",
          reason: gate.reason,
          label: config.merge.label,
        });
        return;
      }

      await runAssistedMerge(context, api, repo, config, pullRequest, decision.strategy);
      return;
    }
  }
}
