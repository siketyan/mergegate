/**
 * Everything the core needs from the outside world. Adapters implement these;
 * the core never reaches past them.
 */

import type { Strategy } from "./config/schema.ts";
import type { CheckConclusion as GateCheckConclusion, ReviewDecision } from "./policy/gate.ts";
import type { CheckConclusion } from "./check/render.ts";

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

export interface Clock {
  now(): Date;
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
  /** Every check on the head commit except the one squashables owns. */
  readonly otherChecks: readonly GateCheckConclusion[];
}

export interface CheckRunInput {
  readonly name: string;
  readonly headSha: string;
  readonly conclusion: CheckConclusion;
  readonly title: string;
  readonly summary: string;
}

export interface MergeInput {
  readonly method: Strategy;
  /** The head SHA that was evaluated. A different head must abort the merge. */
  readonly sha: string;
  readonly commitTitle: string;
  readonly commitMessage: string;
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
  /** `check_suite.pull_requests` is empty for forks, so this is the fallback. */
  findPullRequestsForSha(repo: RepoRef, sha: string): Promise<readonly number[]>;
  mergePullRequest(repo: RepoRef, pullNumber: number, input: MergeInput): Promise<MergeOutcome>;
  removeLabel(repo: RepoRef, pullNumber: number, label: string): Promise<void>;
  deleteBranch(repo: RepoRef, branch: string): Promise<void>;
}

export interface GitHubApiFactory {
  forInstallation(installationId: number): GitHubApi;
}

export interface AppContext {
  readonly github: GitHubApiFactory;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly deferrer: Deferrer;
  readonly env: Env;
  readonly cache?: Cache;
  /** The app's own id, so its own check run events can be ignored. */
  readonly appId: string;
}
