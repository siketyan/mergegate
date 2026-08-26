import type { CheckConclusion } from "../../core/policy/gate.ts";
import type { PullRequestState } from "../../core/ports.ts";
import type { PullRequestStateQuery, RollupContextFragment } from "./generated/graphql.ts";

/**
 * The rollup selects the same fields wherever it is read, so both queries take
 * them from here and codegen types them once.
 *
 * The `/* GraphQL *\/` marker is what graphql-codegen picks these literals up by.
 */
const rollupContextFragment = /* GraphQL */ `
  fragment RollupContext on StatusCheckRollupContext {
    __typename
    ... on CheckRun {
      name
      status
      conclusion
    }
    ... on StatusContext {
      state
    }
  }
`;

/**
 * One query for everything a decision needs. `reviewDecision` is GitHub's own
 * answer to "does this satisfy the review rules", which beats recounting
 * reviews over REST.
 */
const pullRequestOperation = /* GraphQL */ `
  query PullRequestState($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      nameWithOwner
      pullRequest(number: $number) {
        number
        title
        state
        isDraft
        mergeable
        mergeStateStatus
        reviewDecision
        baseRefName
        headRefName
        headRefOid
        headRepository {
          nameWithOwner
        }
        # 100 labels on one pull request is not a thing, and missing one only
        # means the label looks absent, which blocks rather than merges.
        labels(first: 100) {
          nodes {
            name
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    ...RollupContext
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** The rest of the rollup, when the first page did not hold all of it. */
const checkContextsOperation = /* GraphQL */ `
  query PullRequestCheckContexts(
    $owner: String!
    $repo: String!
    $oid: GitObjectID!
    $after: String!
  ) {
    repository(owner: $owner, name: $repo) {
      object(oid: $oid) {
        ... on Commit {
          statusCheckRollup {
            contexts(first: 100, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                ...RollupContext
              }
            }
          }
        }
      }
    }
  }
`;

/** A query carries its fragment with it: GitHub is sent one document. */
export const pullRequestQuery = `${pullRequestOperation}\n${rollupContextFragment}`;
export const checkContextsQuery = `${checkContextsOperation}\n${rollupContextFragment}`;

function checkRunConclusion(
  status: string,
  conclusion: string | null | undefined,
): CheckConclusion {
  if (status !== "COMPLETED") {
    return "pending";
  }
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "NEUTRAL":
      return "neutral";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    case "TIMED_OUT":
      return "timed_out";
    case "ACTION_REQUIRED":
      return "action_required";
    case "STALE":
      return "stale";
    default:
      return "failure";
  }
}

function statusContextConclusion(state: string): CheckConclusion {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "failure";
  }
}

/** Every check on the head commit except the one mergegate owns. */
function otherChecks(
  nodes: readonly (RollupContextFragment | null)[],
  ownCheckName: string,
): CheckConclusion[] {
  const conclusions: CheckConclusion[] = [];
  for (const node of nodes) {
    if (node === null) {
      continue;
    }
    switch (node.__typename) {
      case "CheckRun":
        // Never gate on our own check run: it is failing on purpose.
        if (node.name !== ownCheckName) {
          conclusions.push(checkRunConclusion(node.status, node.conclusion));
        }
        break;
      case "StatusContext":
        conclusions.push(statusContextConclusion(node.state));
        break;
      default:
        break;
    }
  }
  return conclusions;
}

/** The head commit and the first page of its check rollup. */
export function rollupPage(response: PullRequestStateQuery): {
  readonly oid: string | null;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} {
  const commit = response.repository?.pullRequest?.commits.nodes?.[0]?.commit;
  const page = commit?.statusCheckRollup?.contexts.pageInfo;
  return {
    oid: commit?.oid ?? null,
    hasNextPage: page?.hasNextPage ?? false,
    endCursor: page?.endCursor ?? null,
  };
}

export function toPullRequestState(
  response: PullRequestStateQuery,
  ownCheckName: string,
  extraContexts: readonly (RollupContextFragment | null)[] = [],
  checksTruncated = false,
): PullRequestState | null {
  const repository = response.repository;
  const pullRequest = repository?.pullRequest;
  if (!repository || !pullRequest) {
    return null;
  }

  const contexts = [
    ...(pullRequest.commits.nodes?.[0]?.commit.statusCheckRollup?.contexts.nodes ?? []),
    ...extraContexts,
  ];

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    state:
      pullRequest.state === "OPEN" ? "open" : pullRequest.state === "MERGED" ? "merged" : "closed",
    draft: pullRequest.isDraft,
    base: pullRequest.baseRefName,
    head: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    isFork: pullRequest.headRepository?.nameWithOwner !== repository.nameWithOwner,
    labels: (pullRequest.labels?.nodes ?? []).flatMap((label) =>
      label === null || label === undefined ? [] : [label.name],
    ),
    // MERGEABLE / CONFLICTING / UNKNOWN, where UNKNOWN means GitHub is still
    // computing it: undetermined, not "fine to merge".
    mergeable:
      pullRequest.mergeable === "MERGEABLE"
        ? true
        : pullRequest.mergeable === "CONFLICTING"
          ? false
          : null,
    behindBase: pullRequest.mergeStateStatus === "BEHIND",
    reviewDecision: pullRequest.reviewDecision ?? null,
    otherChecks: otherChecks(contexts, ownCheckName),
    checksTruncated,
  };
}
