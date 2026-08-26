import type {
  AppContext,
  CheckRunInput,
  Env,
  GitHubApi,
  Logger,
  MergeInput,
  MergeOutcome,
  PullRequestState,
  RepoRef,
} from "../src/core/ports.ts";

export interface FakeGitHubState {
  configSource: string | null;
  pullRequests: Map<number, PullRequestState>;
  checkRuns: CheckRunInput[];
  merges: { pullNumber: number; input: MergeInput }[];
  addedLabels: { pullNumber: number; label: string }[];
  removedLabels: { pullNumber: number; label: string }[];
  deletedBranches: string[];
  /** Sources whose commits the pull request head is deemed to carry. */
  carriedFrom: string[];
  carriesQueries: { base: string; head: string; source: string }[];
  mergeOutcome: MergeOutcome;
  ownCheckNames: string[];
  /** Logins that may push. Anyone else is refused, as in a real repository. */
  pushers: string[];
  permissionQueries: string[];
}

export function pullRequest(overrides: Partial<PullRequestState> = {}): PullRequestState {
  return {
    number: 12,
    title: "Promote develop",
    state: "open",
    draft: false,
    base: "staging",
    head: "develop",
    headSha: "c0ffee",
    isFork: false,
    labels: [],
    mergeable: true,
    behindBase: false,
    reviewDecision: "APPROVED",
    otherChecks: ["success"],
    ...overrides,
  };
}

/** An in-memory GitHub. No network, and every call is recorded. */
export function createFakeGitHub(initial: Partial<FakeGitHubState> = {}): {
  api: GitHubApi;
  state: FakeGitHubState;
} {
  const state: FakeGitHubState = {
    configSource: null,
    pullRequests: new Map(),
    checkRuns: [],
    merges: [],
    addedLabels: [],
    removedLabels: [],
    deletedBranches: [],
    carriedFrom: [],
    carriesQueries: [],
    mergeOutcome: { ok: true, sha: "merged-sha" },
    ownCheckNames: [],
    pushers: ["maintainer"],
    permissionQueries: [],
    ...initial,
  };

  const api: GitHubApi = {
    readDefaultBranchFile: async (_repo: RepoRef, _path: string) => state.configSource,
    getPullRequestState: async (_repo, pullNumber, options) => {
      state.ownCheckNames.push(options.ownCheckName);
      return state.pullRequests.get(pullNumber) ?? null;
    },
    upsertCheckRun: async (_repo, input) => {
      state.checkRuns.push(input);
    },
    carriesCommitsFrom: async (_repo, input) => {
      state.carriesQueries.push(input);
      return state.carriedFrom.includes(input.source);
    },
    findPullRequestsForSha: async () => [...state.pullRequests.keys()],
    mergePullRequest: async (_repo, pullNumber, input) => {
      state.merges.push({ pullNumber, input });
      return state.mergeOutcome;
    },
    addLabel: async (_repo, pullNumber, label) => {
      state.addedLabels.push({ pullNumber, label });
    },
    removeLabel: async (_repo, pullNumber, label) => {
      state.removedLabels.push({ pullNumber, label });
    },
    canPush: async (_repo, login) => {
      state.permissionQueries.push(login);
      return state.pushers.includes(login);
    },
    deleteBranch: async (_repo, branch) => {
      state.deletedBranches.push(branch);
    },
  };

  return { api, state };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => silentLogger,
};

export const testEnv: Env = {
  appId: "1234",
  privateKey: "unused",
  webhookSecret: "secret",
  logLevel: "error",
  configCacheTtl: 60,
};

/** A context whose deferred work starts immediately and can be awaited. */
export function createTestContext(
  api: GitHubApi,
  overrides: Partial<AppContext> = {},
): { context: AppContext; flush: () => Promise<void> } {
  const deferred: Promise<void>[] = [];
  const context: AppContext = {
    github: { forInstallation: () => api },
    logger: silentLogger,
    deferrer: {
      defer: (work) => {
        deferred.push(work());
      },
    },
    env: testEnv,
    ...overrides,
  };

  return {
    context,
    flush: async () => {
      await Promise.all(deferred);
    },
  };
}

export const repo: RepoRef = { owner: "siketyan", repo: "mergegate" };
