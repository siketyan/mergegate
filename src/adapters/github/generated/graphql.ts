/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
/** The possible states for a check suite or run conclusion. */
export type CheckConclusionState =
  /** The check suite or run requires action. */
  | 'ACTION_REQUIRED'
  /** The check suite or run has been cancelled. */
  | 'CANCELLED'
  /** The check suite or run has failed. */
  | 'FAILURE'
  /** The check suite or run was neutral. */
  | 'NEUTRAL'
  /** The check suite or run was skipped. */
  | 'SKIPPED'
  /** The check suite or run was marked stale by GitHub. Only GitHub can use this conclusion. */
  | 'STALE'
  /** The check suite or run has failed at startup. */
  | 'STARTUP_FAILURE'
  /** The check suite or run has succeeded. */
  | 'SUCCESS'
  /** The check suite or run has timed out. */
  | 'TIMED_OUT';

/** The possible states for a check suite or run status. */
export type CheckStatusState =
  /** The check suite or run has been completed. */
  | 'COMPLETED'
  /** The check suite or run is in progress. */
  | 'IN_PROGRESS'
  /** The check suite or run is in pending state. */
  | 'PENDING'
  /** The check suite or run has been queued. */
  | 'QUEUED'
  /** The check suite or run has been requested. */
  | 'REQUESTED'
  /** The check suite or run is in waiting state. */
  | 'WAITING';

/** Detailed status information about a pull request merge. */
export type MergeStateStatus =
  /** The head ref is out of date. */
  | 'BEHIND'
  /** The merge is blocked. */
  | 'BLOCKED'
  /** Mergeable and passing commit status. */
  | 'CLEAN'
  /** The merge commit cannot be cleanly created. */
  | 'DIRTY'
  /** The merge is blocked due to the pull request being a draft. */
  | 'DRAFT'
  /** Mergeable with passing commit status and pre-receive hooks. */
  | 'HAS_HOOKS'
  /** The state cannot currently be determined. */
  | 'UNKNOWN'
  /** Mergeable with non-passing commit status. */
  | 'UNSTABLE';

/** Whether or not a PullRequest can be merged. */
export type MergeableState =
  /** The pull request cannot be merged due to merge conflicts. */
  | 'CONFLICTING'
  /** The pull request can be merged. */
  | 'MERGEABLE'
  /** The mergeability of the pull request is still being calculated. */
  | 'UNKNOWN';

/** The review status of a pull request. */
export type PullRequestReviewDecision =
  /** The pull request has received an approving review. */
  | 'APPROVED'
  /** Changes have been requested on the pull request. */
  | 'CHANGES_REQUESTED'
  /** A review is required before the pull request can be merged. */
  | 'REVIEW_REQUIRED';

/** The possible states of a pull request. */
export type PullRequestState =
  /** A pull request that has been closed without being merged. */
  | 'CLOSED'
  /** A pull request that has been closed by being merged. */
  | 'MERGED'
  /** A pull request that is still open. */
  | 'OPEN';

/** The possible commit status states. */
export type StatusState =
  /** Status is errored. */
  | 'ERROR'
  /** Status is expected. */
  | 'EXPECTED'
  /** Status is failing. */
  | 'FAILURE'
  /** Status is pending. */
  | 'PENDING'
  /** Status is successful. */
  | 'SUCCESS';

type RollupContext_CheckRun_Fragment = { __typename: 'CheckRun', name: string, status: CheckStatusState, conclusion: CheckConclusionState | null };

type RollupContext_StatusContext_Fragment = { __typename: 'StatusContext', state: StatusState };

export type RollupContextFragment =
  | RollupContext_CheckRun_Fragment
  | RollupContext_StatusContext_Fragment
;

export type PullRequestStateQueryVariables = Exact<{
  owner: string;
  repo: string;
  number: number;
}>;


export type PullRequestStateQuery = { repository: { nameWithOwner: string, pullRequest: { number: number, title: string, state: PullRequestState, isDraft: boolean, mergeable: MergeableState, mergeStateStatus: MergeStateStatus, reviewDecision: PullRequestReviewDecision | null, baseRefName: string, headRefName: string, headRefOid: string, headRepository: { nameWithOwner: string } | null, labels: { nodes: Array<{ name: string } | null> | null } | null, commits: { nodes: Array<{ commit: { oid: string, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<
                  | { __typename: 'CheckRun', name: string, status: CheckStatusState, conclusion: CheckConclusionState | null }
                  | { __typename: 'StatusContext', state: StatusState }
                 | null> | null } } | null } } | null> | null } } | null } | null };

export type PullRequestCheckContextsQueryVariables = Exact<{
  owner: string;
  repo: string;
  oid: string;
  after: string;
}>;


export type PullRequestCheckContextsQuery = { repository: { object:
      | { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<
              | { __typename: 'CheckRun', name: string, status: CheckStatusState, conclusion: CheckConclusionState | null }
              | { __typename: 'StatusContext', state: StatusState }
             | null> | null } } | null }
      | Record<PropertyKey, never>
     | null } | null };
