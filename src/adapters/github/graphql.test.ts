import { expect, test } from "vite-plus/test";
import type { CheckConclusionState, PullRequestStateQuery } from "./generated/graphql.ts";
import { rollupPage, type RollupContext, toPullRequestState } from "./graphql.ts";

function response(options: {
  contexts?: (RollupContext | null)[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}): PullRequestStateQuery {
  return {
    repository: {
      nameWithOwner: "siketyan/mergegate",
      pullRequest: {
        number: 12,
        title: "Promote develop",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        baseRefName: "staging",
        headRefName: "develop",
        headRefOid: "c0ffee",
        headRepository: { nameWithOwner: "siketyan/mergegate" },
        labels: { nodes: [{ name: "ready-to-merge" }] },
        commits: {
          nodes: [
            {
              commit: {
                oid: "c0ffee",
                statusCheckRollup: {
                  contexts: {
                    pageInfo: {
                      hasNextPage: options.hasNextPage ?? false,
                      endCursor: options.endCursor ?? null,
                    },
                    nodes: options.contexts ?? [],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

function checkRun(name: string, conclusion: CheckConclusionState): RollupContext {
  return { __typename: "CheckRun", name, status: "COMPLETED", conclusion };
}

test("a full rollup needs no second page", () => {
  const page = rollupPage(response({ contexts: [checkRun("build", "SUCCESS")] }));
  expect(page).toEqual({ oid: "c0ffee", hasNextPage: false, endCursor: null });
});

test("a truncated rollup reports where to carry on from", () => {
  const page = rollupPage(response({ hasNextPage: true, endCursor: "Y3Vyc29y" }));
  expect(page).toEqual({ oid: "c0ffee", hasNextPage: true, endCursor: "Y3Vyc29y" });
});

test("checks beyond the first page still gate the merge", () => {
  // The failure this covers: reading only the first page of the rollup would
  // report every other check as green and let the merge through.
  const state = toPullRequestState(
    response({ contexts: [checkRun("build", "SUCCESS")], hasNextPage: true }),
    "mergegate",
    [checkRun("e2e", "FAILURE")],
  );

  expect(state?.otherChecks).toEqual(["success", "failure"]);
});

test("our own check is dropped wherever in the rollup it lands", () => {
  const state = toPullRequestState(
    response({ contexts: [checkRun("mergegate", "ACTION_REQUIRED")] }),
    "mergegate",
    [checkRun("mergegate", "ACTION_REQUIRED"), checkRun("lint", "SUCCESS")],
  );

  expect(state?.otherChecks).toEqual(["success"]);
});

test("an unread page of the rollup is carried into the state", () => {
  const state = toPullRequestState(
    response({ contexts: [checkRun("build", "SUCCESS")], hasNextPage: true }),
    "mergegate",
    [],
    true,
  );

  expect(state?.checksTruncated).toBe(true);
});

test("a rollup read to the end is not truncated", () => {
  const state = toPullRequestState(response({ contexts: [] }), "mergegate");
  expect(state?.checksTruncated).toBe(false);
});

test("a pull request that is gone has no rollup to page through", () => {
  const page = rollupPage({
    repository: { nameWithOwner: "siketyan/mergegate", pullRequest: null },
  });
  expect(page).toEqual({ oid: null, hasNextPage: false, endCursor: null });
});
