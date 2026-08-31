import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import {
  type CheckRunInput,
  type Env,
  type GitHubApi,
  GitHubApiError,
  type GitHubApiFactory,
  type Logger,
  type MergeInput,
  type MergeOutcome,
  type PullRequestState,
  type RepoRef,
} from "../../ports.ts";
import { decodeContent } from "./content.ts";
import type {
  PullRequestCheckContextsQuery,
  PullRequestStateQuery,
  RollupContextFragment,
} from "./generated/graphql.ts";
import { checkContextsQuery, pullRequestQuery, rollupPage, toPullRequestState } from "./graphql.ts";

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

/** The `type` of every entry in a GraphQL error response, or nothing. */
function graphqlErrorTypes(error: unknown): readonly string[] {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return [];
  }
  const errors = (error as { errors: unknown }).errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((entry: unknown) =>
    typeof entry === "object" && entry !== null && "type" in entry
      ? [String((entry as { type: unknown }).type)]
      : [],
  );
}

/**
 * GraphQL answers 200 even when it refuses a field, so a refusal has to be read
 * off the error entries rather than off the status line. Without this a missing
 * permission on the pull request query looks like an ordinary crash.
 */
function toGraphqlError(error: unknown): GitHubApiError {
  if (error instanceof GitHubApiError) {
    return error;
  }
  const forbidden = graphqlErrorTypes(error).includes("FORBIDDEN");
  return new GitHubApiError(messageOf(error), {
    status: forbidden ? 403 : statusOf(error),
    method: "POST",
    url: "/graphql",
  });
}

class OctokitGitHubApi implements GitHubApi {
  readonly #octokit: AppOctokitInstance;
  readonly #appId: number;

  constructor(octokit: AppOctokitInstance, appId: number) {
    this.#octokit = octokit;
    this.#appId = appId;
  }

  /** Every GraphQL call, so a refused field reads like a refused request. */
  async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      return await this.#octokit.graphql<T>(query, variables);
    } catch (error) {
      throw toGraphqlError(error);
    }
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
    const response = await this.#graphql<PullRequestStateQuery>(pullRequestQuery, {
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
    readonly contexts: readonly (RollupContextFragment | null)[];
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

    const contexts: (RollupContextFragment | null)[] = [];
    let after: string | null = first.endCursor;
    // Bounded: a pull request with more than a thousand checks on one commit is
    // a repository problem, not something to page through forever.
    for (let page = 0; page < 10 && after !== null; page += 1) {
      const next: PullRequestCheckContextsQuery =
        await this.#graphql<PullRequestCheckContextsQuery>(checkContextsQuery, {
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
    // Always sent: `actions` replaces the list, so this clears a button that the
    // new state no longer offers.
    const actions = input.actions.map((action) => ({ ...action }));
    const existing = data.check_runs[0];

    if (existing !== undefined) {
      await this.#octokit.rest.checks.update({
        owner: repo.owner,
        repo: repo.repo,
        check_run_id: Number(existing.id),
        status: "completed",
        conclusion: input.conclusion,
        output,
        actions,
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
      actions,
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
        ...(input.commitTitle === undefined ? {} : { commit_title: input.commitTitle }),
        ...(input.commitMessage === undefined ? {} : { commit_message: input.commitMessage }),
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

  async canPush(repo: RepoRef, login: string): Promise<boolean> {
    try {
      const { data } = await this.#octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: repo.owner,
        repo: repo.repo,
        username: login,
      });
      // `maintain` and `triage` collapse into `write` and `read` in this field.
      return data.permission === "admin" || data.permission === "write";
    } catch (error) {
      const status = statusOf(error);
      // Fail closed: not a collaborator, or the app cannot see the answer.
      if (status === 403 || status === 404) {
        return false;
      }
      throw error;
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

      // Outermost of the plugins' own hooks, so this sees the failure that
      // survived the retries -- with the route that produced it attached.
      octokit.hook.wrap("request", async (request, options) => {
        try {
          return await request(options);
        } catch (error) {
          throw error instanceof GitHubApiError
            ? error
            : new GitHubApiError(messageOf(error), {
                status: statusOf(error),
                method: options.method,
                url: options.url,
              });
        }
      });

      return new OctokitGitHubApi(octokit, appId);
    },
  };
}
