import { z } from "zod";
import type { CheckConclusion, ReviewDecision } from "../../core/policy/gate.ts";
import type { PullRequestState } from "../../core/ports.ts";

/**
 * One query for everything a decision needs. `reviewDecision` is GitHub's own
 * answer to "does this satisfy the review rules", which beats recounting
 * reviews over REST.
 */
export const pullRequestQuery = `
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
                      context
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

const checkRunNode = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

const statusContextNode = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(),
  state: z.string(),
});

const contextNode = z.union([
  checkRunNode,
  statusContextNode,
  z.object({ __typename: z.string() }),
]);

export const pullRequestResponseSchema = z.object({
  repository: z.object({
    nameWithOwner: z.string(),
    pullRequest: z
      .object({
        number: z.number(),
        title: z.string(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
        isDraft: z.boolean(),
        mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
        mergeStateStatus: z.string().nullish(),
        reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
        baseRefName: z.string(),
        headRefName: z.string(),
        headRefOid: z.string(),
        headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
        labels: z.object({ nodes: z.array(z.object({ name: z.string() })).nullish() }).nullish(),
        commits: z.object({
          nodes: z
            .array(
              z.object({
                commit: z.object({
                  statusCheckRollup: z
                    .object({
                      contexts: z.object({ nodes: z.array(contextNode).nullish() }),
                    })
                    .nullish(),
                }),
              }),
            )
            .nullish(),
        }),
      })
      .nullable(),
  }),
});

export type PullRequestResponse = z.output<typeof pullRequestResponseSchema>;

function checkRunConclusion(status: string, conclusion: string | null): CheckConclusion {
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

function mergeableOf(value: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"): boolean | null {
  switch (value) {
    case "MERGEABLE":
      return true;
    case "CONFLICTING":
      return false;
    case "UNKNOWN":
      // Computed asynchronously by GitHub: undetermined, not "fine to merge".
      return null;
  }
}

export function toPullRequestState(
  response: PullRequestResponse,
  ownCheckName: string,
): PullRequestState | null {
  const { nameWithOwner, pullRequest } = response.repository;
  if (pullRequest === null) {
    return null;
  }

  const contexts = pullRequest.commits.nodes?.[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];

  const otherChecks: CheckConclusion[] = [];
  for (const context of contexts) {
    if (context.__typename === "CheckRun") {
      const node = checkRunNode.parse(context);
      // Never gate on our own check run: it is failing on purpose.
      if (node.name !== ownCheckName) {
        otherChecks.push(checkRunConclusion(node.status, node.conclusion));
      }
      continue;
    }
    if (context.__typename === "StatusContext") {
      const node = statusContextNode.parse(context);
      otherChecks.push(statusContextConclusion(node.state));
    }
  }

  return {
    number: pullRequest.number,
    title: pullRequest.title,
    state: pullRequest.state.toLowerCase() as PullRequestState["state"],
    draft: pullRequest.isDraft,
    base: pullRequest.baseRefName,
    head: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    isFork: pullRequest.headRepository?.nameWithOwner !== nameWithOwner,
    labels: (pullRequest.labels?.nodes ?? []).map((label) => label.name),
    mergeable: mergeableOf(pullRequest.mergeable),
    behindBase: pullRequest.mergeStateStatus === "BEHIND",
    reviewDecision: pullRequest.reviewDecision as ReviewDecision,
    otherChecks,
  };
}
