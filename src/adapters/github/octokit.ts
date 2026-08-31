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

export interface GraphqlErrorEntry {
  /** `FORBIDDEN`, `NOT_FOUND`, ... */
  readonly type: string | null;
  /** `repository.pullRequest.commits.nodes.0.commit.statusCheckRollup`. */
  readonly path: string | null;
}

/**
 * The entries of a GraphQL error response.
 *
 * The path is the whole point: GraphQL refuses one *field*, and which field it
 * was is the difference between "the app is broken" and "the app is missing one
 * permission". GitHub does not put it in the message, so it is read off here.
 */
export function graphqlErrors(error: unknown): readonly GraphqlErrorEntry[] {
  if (typeof error !== "object" || error === null || !("errors" in error)) {
    return [];
  }
  const errors = (error as { errors: unknown }).errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((entry: unknown): GraphqlErrorEntry[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const type = "type" in entry ? String((entry as { type: unknown }).type) : null;
    const path = "path" in entry ? (entry as { path: unknown }).path : null;
    return [{ type, path: Array.isArray(path) ? path.map(String).join(".") : null }];
  });
}

/** `FORBIDDEN at repository.pullRequest...`, for the log and the check run. */
function describe(entry: GraphqlErrorEntry): string {
  const type = entry.type ?? "error";
  return entry.path === null ? type : `${type} at ${entry.path}`;
}

/**
 * GraphQL answers 200 even when it refuses a field, so a refusal has to be read
 * off the error entries rather than off the status line. Without this a missing
 * permission on the pull request query looks like an ordinary crash.
 */
export function toGraphqlError(error: unknown): GitHubApiError {
  if (error instanceof GitHubApiError) {
    return error;
  }
  const entries = graphqlErrors(error);
  const forbidden = entries.some((entry) => entry.type === "FORBIDDEN");
  const described = entries.map(describe);
  return new GitHubApiError(
    // The field GitHub refused, in the message, so it reaches the check run too.
    described.length === 0 ? messageOf(error) : `${messageOf(error)} (${described.join("; ")})`,
    {
      status: forbidden ? 403 : statusOf(error),
      method: "POST",
      url: "/graphql",
      graphqlErrors: described,
    },
  );
}

/** Where in the query a refused rollup context shows up. */
const ROLLUP_CONTEXTS = "statusCheckRollup.contexts";

/**
 * Whether every error GitHub raised was about a context inside the rollup.
 *
 * GraphQL refuses one field at a time: a commit status the installation may not
 * read (that is `Commit statuses: read`, which is a permission of its own,
 * separate from Checks) comes back as a null node with an error beside it,
 * while the rest of the answer is intact. That is worth carrying on with --
 * deciding how a pull request may be merged needs no checks at all. What it is
 * not worth is merging on it, and `refused` is what stops that.
 */
export function refusedRollupOnly(entries: readonly GraphqlErrorEntry[]): boolean {
  return (
    entries.length > 0 && entries.every((entry) => entry.path?.includes(ROLLUP_CONTEXTS) === true)
  );
}

/**
 * The partial answer that came with the errors, if it holds a pull request.
 *
 * GraphQL nulls only the field it refused, so everything else keeps the shape
 * codegen describes -- rollup context nodes are already typed nullable.
 */
export function partialPullRequest(error: unknown): PullRequestStateQuery | null {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    return null;
  }
  const data = (error as { data: unknown }).data;
  if (typeof data !== "object" || data === null || !("repository" in data)) {
    return null;
  }
  const repository = (data as { repository: unknown }).repository;
  if (typeof repository !== "object" || repository === null || !("pullRequest" in repository)) {
    return null;
  }
  const pullRequest = (repository as { pullRequest: unknown }).pullRequest;
  return typeof pullRequest === "object" && pullRequest !== null
    ? (data as PullRequestStateQuery)
    : null;
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
    const { response, refused } = await this.#pullRequest(repo, pullNumber);
    // A check beyond the first page of the rollup still gates the merge, so the
    // rest of it is read rather than assumed to be empty.
    const rest = await this.#restOfRollup(repo, response);
    return toPullRequestState(response, options.ownCheckName, {
      contexts: rest.contexts,
      truncated: rest.truncated,
      refused: refused || rest.refused,
    });
  }

  /** The pull request, and whether GitHub refused any of its rollup contexts. */
  async #pullRequest(
    repo: RepoRef,
    pullNumber: number,
  ): Promise<{ readonly response: PullRequestStateQuery; readonly refused: boolean }> {
    try {
      const response = await this.#octokit.graphql<PullRequestStateQuery>(pullRequestQuery, {
        owner: repo.owner,
        repo: repo.repo,
        number: pullNumber,
        // `mergeStateStatus` still lives behind this media type.
        headers: { accept: "application/vnd.github.merge-info-preview+json" },
      });
      return { response, refused: false };
    } catch (error) {
      const partial = refusedRollupOnly(graphqlErrors(error)) ? partialPullRequest(error) : null;
      if (partial === null) {
        throw toGraphqlError(error);
      }
      return { response: partial, refused: true };
    }
  }

  async #restOfRollup(
    repo: RepoRef,
    response: PullRequestStateQuery,
  ): Promise<{
    readonly contexts: readonly (RollupContextFragment | null)[];
    readonly truncated: boolean;
    readonly refused: boolean;
  }> {
    const first = rollupPage(response);
    if (!first.hasNextPage) {
      return { contexts: [], truncated: false, refused: false };
    }
    if (first.oid === null || first.endCursor === null) {
      // GitHub says there is more but not where to carry on from. Nothing to
      // read, and nothing to claim about the checks that were not read.
      return { contexts: [], truncated: true, refused: false };
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
        return { contexts, truncated: true, refused: false };
      }
      contexts.push(...(rollup.contexts.nodes ?? []));
      after = rollup.contexts.pageInfo.hasNextPage ? rollup.contexts.pageInfo.endCursor : null;
    }
    // `after` still set means the page bound stopped the walk, not GitHub.
    return { contexts, truncated: after !== null, refused: false };
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
