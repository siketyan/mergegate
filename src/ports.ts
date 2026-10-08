/**
 * Everything the core needs from the outside world. Adapters implement these;
 * the core never reaches past them.
 */

import type { Strategy } from "./config/schema.ts";
import type { CheckConclusion as GateCheckConclusion, ReviewDecision } from "./policy/gate.ts";
import type { CheckAction, CheckConclusion } from "./check/render.ts";

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A child logger that repeats `fields` on every line (the delivery id). */
  with(fields: Record<string, unknown>): Logger;
}

/** Work that continues after the 202 response. */
export interface Deferrer {
  defer(work: () => Promise<void>): void;
}

/** Best-effort only: losing everything in here must stay correct. */
export interface Cache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  /** Also how the app recognises its own check run events. */
  readonly appId: string;
  readonly privateKey: string;
  readonly webhookSecret: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /** Seconds to cache the configuration file for. */
  readonly configCacheTtl: number;
}

export interface PullRequestState {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly base: string;
  readonly head: string;
  readonly headSha: string;
  readonly isFork: boolean;
  readonly labels: readonly string[];
  readonly mergeable: boolean | null;
  readonly behindBase: boolean;
  readonly reviewDecision: ReviewDecision;
  /** Every check on the head commit except the one mergegate owns. */
  readonly otherChecks: readonly GateCheckConclusion[];
  /** `true` when the check rollup was longer than mergegate read. */
  readonly checksTruncated: boolean;
  /** `true` when GitHub refused a check in the rollup, so its result is unknown. */
  readonly checksRefused: boolean;
}

export interface CheckRunInput {
  readonly name: string;
  readonly headSha: string;
  readonly conclusion: CheckConclusion;
  readonly title: string;
  readonly summary: string;
  /** Buttons for the Checks tab. Always sent, so an update clears stale ones. */
  readonly actions: readonly CheckAction[];
}

export interface MergeInput {
  readonly method: Strategy;
  /** The head SHA that was evaluated. A different head must abort the merge. */
  readonly sha: string;
  /** Left out entirely when the configuration names neither. */
  readonly commitTitle?: string;
  readonly commitMessage?: string;
}

export type MergeOutcome =
  | { readonly ok: true; readonly sha: string }
  | {
      readonly ok: false;
      /**
       * `head-changed` and `not-ready` are transient; the rest are permanent and
       * drop the label.
       */
      readonly kind: "head-changed" | "not-ready" | "conflict" | "method-not-allowed" | "refused";
      readonly message: string;
    };

export interface GitHubApi {
  /** Reads a file from the default branch. Never from the pull request head. */
  readDefaultBranchFile(repo: RepoRef, path: string): Promise<string | null>;
  getPullRequestState(
    repo: RepoRef,
    pullNumber: number,
    options: { readonly ownCheckName: string },
  ): Promise<PullRequestState | null>;
  /** Updates the existing check run for `(name, headSha)`, or creates one. */
  upsertCheckRun(repo: RepoRef, input: CheckRunInput): Promise<void>;
  /**
   * Whether the pull request brings commits from `source` that `base` does not
   * already have: "is this a promotion of source" asked of the history rather
   * than of the branch's name.
   */
  carriesCommitsFrom(
    repo: RepoRef,
    input: { readonly base: string; readonly head: string; readonly source: string },
  ): Promise<boolean>;
  /** `check_suite.pull_requests` is empty for forks, so this is the fallback. */
  findPullRequestsForSha(repo: RepoRef, sha: string): Promise<readonly number[]>;
  mergePullRequest(repo: RepoRef, pullNumber: number, input: MergeInput): Promise<MergeOutcome>;
  removeLabel(repo: RepoRef, pullNumber: number, label: string): Promise<void>;
  /**
   * Whether a user may push to the repository. Pressing a button in the Checks
   * tab carries no permission of its own, so the assisted merge asks here
   * before it stands in for the label.
   */
  canPush(repo: RepoRef, login: string): Promise<boolean>;
  deleteBranch(repo: RepoRef, branch: string): Promise<void>;
}

export interface GitHubApiFactory {
  forInstallation(installationId: number): GitHubApi;
}

export interface AppContext {
  readonly github: GitHubApiFactory;
  readonly logger: Logger;
  readonly deferrer: Deferrer;
  /** Waiting on GitHub to catch up, in the deferred work after the 202. */
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly env: Env;
  readonly cache?: Cache;
}

/**
 * A GitHub API call that came back an error.
 *
 * Every call the adapter makes is wrapped in one of these, so a failure carries
 * the endpoint that produced it: "Resource not accessible by integration" says
 * nothing on its own, and an app that cannot say which call was refused cannot
 * be debugged from its logs. The core reads `forbidden` to tell a permission
 * problem -- which no retry fixes and which a human has to act on -- from the
 * rest.
 */
export class GitHubApiError extends Error {
  readonly status: number | null;
  readonly method: string | null;
  /** The route, as Octokit names it: `GET /repos/{owner}/{repo}/pulls/{n}`. */
  readonly url: string | null;
  /**
   * For GraphQL, the field each error was raised on -- `FORBIDDEN at
   * repository.pullRequest.commits.nodes.0.commit.statusCheckRollup`. A refusal
   * names one field, and knowing which is the whole diagnosis.
   */
  readonly graphqlErrors: readonly string[];

  constructor(
    message: string,
    details: {
      readonly status?: number | null;
      readonly method?: string | null;
      readonly url?: string | null;
      readonly graphqlErrors?: readonly string[];
    } = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.status = details.status ?? null;
    this.method = details.method ?? null;
    this.url = details.url ?? null;
    this.graphqlErrors = details.graphqlErrors ?? [];
  }

  /** 401 and 403: the installation may not do this, and retrying changes nothing. */
  get forbidden(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** What belongs on a log line next to the message. */
  fields(): Record<string, unknown> {
    return {
      status: this.status,
      method: this.method,
      url: this.url,
      ...(this.graphqlErrors.length === 0 ? {} : { graphqlErrors: this.graphqlErrors }),
    };
  }
}
