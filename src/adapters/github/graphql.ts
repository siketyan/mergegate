import type { CheckConclusion } from "../../core/policy/gate.ts";
import type { PullRequestState } from "../../core/ports.ts";
import type { PullRequestStateQuery } from "./generated/graphql.ts";

/**
 * One query for everything a decision needs. `reviewDecision` is GitHub's own
 * answer to "does this satisfy the review rules", which beats recounting
 * reviews over REST.
 *
 * The `/* GraphQL *\/` marker is what graphql-codegen picks this up by.
 */
export const pullRequestQuery = /* GraphQL */ `
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
        labels(first: 100) {
          nodes {
            name
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
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
                }
              }
            }
          }
        }
      }
    }
  }
`;

type PullRequestNode = NonNullable<PullRequestStateQuery["repository"]>["pullRequest"];
type StatusContextNode = NonNullable<
  NonNullable<
    NonNullable<
      NonNullable<NonNullable<PullRequestNode>["commits"]["nodes"]>[number]
    >["commit"]["statusCheckRollup"]
  >["contexts"]["nodes"]
>[number];

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

/** Every check on the head commit except the one squashables owns. */
function otherChecks(
  nodes: readonly (StatusContextNode | null)[],
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

export function toPullRequestState(
  response: PullRequestStateQuery,
  ownCheckName: string,
): PullRequestState | null {
  const repository = response.repository;
  const pullRequest = repository?.pullRequest;
  if (
    repository === null ||
    repository === undefined ||
    pullRequest === null ||
    pullRequest === undefined
  ) {
    return null;
  }

  const contexts = pullRequest.commits.nodes?.[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];

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
  };
}
