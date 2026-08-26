import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type {
  CheckRunInput,
  Env,
  GitHubApi,
  GitHubApiFactory,
  Logger,
  MergeInput,
  MergeOutcome,
  PullRequestState,
  RepoRef,
} from "../../core/ports.ts";
import { decodeContent } from "./content.ts";
import type { PullRequestCheckContextsQuery, PullRequestStateQuery } from "./generated/graphql.ts";
import {
  checkContextsQuery,
  pullRequestQuery,
  type RollupContext,
  rollupPage,
  toPullRequestState,
} from "./graphql.ts";

const AppOctokit = Octokit.plugin(restEndpointMethods, retry, throttling);

type AppOctokitInstance = InstanceType<typeof AppOctokit>;

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OctokitGitHubApi implements GitHubApi {
  readonly #octokit: AppOctokitInstance;
  readonly #appId: number;

  constructor(octokit: AppOctokitInstance, appId: number) {
    this.#octokit = octokit;
    this.#appId = appId;
  }

  async readDefaultBranchFile(repo: RepoRef, path: string): Promise<string | null> {
    try {
      // No `ref`, so GitHub serves the default branch. The raw media type asks
      // for the file itself rather than a base64 envelope.
      const { data } = await this.#octokit.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.repo,
        path,
        mediaType: { format: "raw" },
      });
      return decodeContent(path, data);
    } catch (error) {
      if (statusOf(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  async getPullRequestState(
    repo: RepoRef,
    pullNumber: number,
    options: { readonly ownCheckName: string },
  ): Promise<PullRequestState | null> {
    const response = await this.#octokit.graphql<PullRequestStateQuery>(pullRequestQuery, {
      owner: repo.owner,
      repo: repo.repo,
      number: pullNumber,
      // `mergeStateStatus` still lives behind this media type.
      headers: { accept: "application/vnd.github.merge-info-preview+json" },
    });
    // A check beyond the first page of the rollup still gates the merge, so the
    // rest of it is read rather than assumed to be empty.
    const rest = await this.#restOfRollup(repo, response);
    return toPullRequestState(response, options.ownCheckName, rest.contexts, rest.truncated);
  }

  async #restOfRollup(
    repo: RepoRef,
    response: PullRequestStateQuery,
  ): Promise<{
    readonly contexts: readonly (RollupContext | null)[];
    readonly truncated: boolean;
  }> {
    const first = rollupPage(response);
    if (!first.hasNextPage) {
      return { contexts: [], truncated: false };
    }
    if (first.oid === null || first.endCursor === null) {
      // GitHub says there is more but not where to carry on from. Nothing to
      // read, and nothing to claim about the checks that were not read.
      return { contexts: [], truncated: true };
    }

    const contexts: (RollupContext | null)[] = [];
    let after: string | null = first.endCursor;
    // Bounded: a pull request with more than a thousand checks on one commit is
    // a repository problem, not something to page through forever.
    for (let page = 0; page < 10 && after !== null; page += 1) {
      const next: PullRequestCheckContextsQuery =
        await this.#octokit.graphql<PullRequestCheckContextsQuery>(checkContextsQuery, {
          owner: repo.owner,
          repo: repo.repo,
          oid: first.oid,
          after,
        });
      const object = next.repository?.object;
      const rollup =
        object !== null && object !== undefined && "statusCheckRollup" in object
          ? object.statusCheckRollup
          : null;
      if (rollup === null || rollup === undefined) {
        return { contexts, truncated: true };
      }
      contexts.push(...(rollup.contexts.nodes ?? []));
      after = rollup.contexts.pageInfo.hasNextPage ? rollup.contexts.pageInfo.endCursor : null;
    }
    // `after` still set means the page bound stopped the walk, not GitHub.
    return { contexts, truncated: after !== null };
  }

  async upsertCheckRun(repo: RepoRef, input: CheckRunInput): Promise<void> {
    // Invariant: one check run per (name, head sha). Look first, then update.
    const { data } = await this.#octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.repo,
      ref: input.headSha,
      check_name: input.name,
      app_id: this.#appId,
    });

    const output = { title: input.title, summary: input.summary };
    const existing = data.check_runs[0];

    if (existing !== undefined) {
      await this.#octokit.rest.checks.update({
        owner: repo.owner,
        repo: repo.repo,
        check_run_id: Number(existing.id),
        status: "completed",
        conclusion: input.conclusion,
        output,
      });
      return;
    }

    await this.#octokit.rest.checks.create({
      owner: repo.owner,
      repo: repo.repo,
      name: input.name,
      head_sha: input.headSha,
      status: "completed",
      conclusion: input.conclusion,
      output,
    });
  }

  async #mergeBase(repo: RepoRef, base: string, head: string): Promise<string> {
    const { data } = await this.#octokit.rest.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.repo,
      basehead: `${base}...${head}`,
      // Only the merge base and the status are read; the commit list is not.
      per_page: 1,
    });
    return data.merge_base_commit.sha;
  }

  async carriesCommitsFrom(
    repo: RepoRef,
    input: { readonly base: string; readonly head: string; readonly source: string },
  ): Promise<boolean> {
    // Where the base and the source last agreed, and how much of the source the
    // head has. Comparing those two, rather than the source's tip, keeps the
    // answer stable when the source branch moves on afterwards.
    const [agreed, carried] = await Promise.all([
      this.#mergeBase(repo, input.base, input.source),
      this.#mergeBase(repo, input.source, input.head),
    ]);
    if (agreed === carried) {
      return false;
    }
    const { data } = await this.#octokit.rest.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.repo,
      basehead: `${agreed}...${carried}`,
      per_page: 1,
    });
    return data.status === "ahead";
  }

  async findPullRequestsForSha(repo: RepoRef, sha: string): Promise<readonly number[]> {
    const { data } = await this.#octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: repo.owner,
      repo: repo.repo,
      commit_sha: sha,
    });
    return data.map((pull) => pull.number);
  }

  async mergePullRequest(
    repo: RepoRef,
    pullNumber: number,
    input: MergeInput,
  ): Promise<MergeOutcome> {
    try {
      const { data } = await this.#octokit.rest.pulls.merge({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber,
        merge_method: input.method,
        sha: input.sha,
        ...(input.commitTitle === "" ? {} : { commit_title: input.commitTitle }),
        ...(input.commitMessage === "" ? {} : { commit_message: input.commitMessage }),
      });
      return { ok: true, sha: data.sha };
    } catch (error) {
      return toMergeFailure(error);
    }
  }

  async removeLabel(repo: RepoRef, pullNumber: number, label: string): Promise<void> {
    try {
      await this.#octokit.rest.issues.removeLabel({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: pullNumber,
        name: label,
      });
    } catch (error) {
      // Already gone is the state we wanted.
      if (statusOf(error) !== 404) {
        throw error;
      }
    }
  }

  async deleteBranch(repo: RepoRef, branch: string): Promise<void> {
    try {
      await this.#octokit.rest.git.deleteRef({
        owner: repo.owner,
        repo: repo.repo,
        ref: `heads/${branch}`,
      });
    } catch (error) {
      const status = statusOf(error);
      if (status !== 404 && status !== 422) {
        throw error;
      }
    }
  }
}

function toMergeFailure(error: unknown): MergeOutcome {
  const status = statusOf(error);
  const message = messageOf(error);

  if (status === 409) {
    // 409 covers both "someone pushed since we evaluated" and a real conflict.
    return message.toLowerCase().includes("modified")
      ? { ok: false, kind: "head-changed", message }
      : { ok: false, kind: "conflict", message };
  }
  if (status === 405) {
    return message.toLowerCase().includes("merge method")
      ? { ok: false, kind: "method-not-allowed", message }
      : { ok: false, kind: "not-ready", message };
  }
  if (status === 403 || status === 422) {
    return { ok: false, kind: "refused", message };
  }
  throw error;
}

export function createGitHubApiFactory(env: Env, logger: Logger): GitHubApiFactory {
  const appId = Number(env.appId);

  return {
    forInstallation(installationId: number): GitHubApi {
      const octokit = new AppOctokit({
        authStrategy: createAppAuth,
        auth: { appId: env.appId, privateKey: env.privateKey, installationId },
        throttle: {
          onRateLimit: (retryAfter: number, options: { method: string; url: string }): boolean => {
            logger.warn("rate limited", { retryAfter, url: options.url, method: options.method });
            return true;
          },
          onSecondaryRateLimit: (
            retryAfter: number,
            options: { method: string; url: string },
          ): boolean => {
            logger.warn("secondary rate limited", { retryAfter, url: options.url });
            return true;
          },
        },
      });
      return new OctokitGitHubApi(octokit, appId);
    },
  };
}
