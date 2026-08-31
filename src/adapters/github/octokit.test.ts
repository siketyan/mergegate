import { expect, test } from "vite-plus/test";
import { graphqlErrors, partialPullRequest, refusedRollupOnly, toGraphqlError } from "./octokit.ts";

/** What Octokit throws: the message, plus the entries GitHub answered with. */
function graphqlResponseError(errors: unknown): Error {
  return Object.assign(new Error("Resource not accessible by integration"), { errors });
}

test("a refused field is a 403 and says which field", () => {
  const error = toGraphqlError(
    graphqlResponseError([
      {
        type: "FORBIDDEN",
        path: ["repository", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"],
      },
    ]),
  );
  expect(error.status).toBe(403);
  expect(error.url).toBe("/graphql");
  expect(error.graphqlErrors).toEqual([
    "FORBIDDEN at repository.pullRequest.commits.nodes.0.commit.statusCheckRollup",
  ]);
  // The field reaches the check run through the message.
  expect(error.message).toContain("statusCheckRollup");
  expect(error.fields()).toMatchObject({ status: 403, method: "POST", url: "/graphql" });
});

test("an error entry without a path still names its type", () => {
  const error = toGraphqlError(graphqlResponseError([{ type: "FORBIDDEN" }]));
  expect(error.status).toBe(403);
  expect(error.graphqlErrors).toEqual(["FORBIDDEN"]);
});

test("a response without error entries is left as it came", () => {
  const error = toGraphqlError(Object.assign(new Error("bad gateway"), { status: 502 }));
  expect(error.status).toBe(502);
  expect(error.message).toBe("bad gateway");
  expect(error.graphqlErrors).toEqual([]);
  expect(error.fields()).not.toHaveProperty("graphqlErrors");
});

/** The shape Octokit throws for a 200 that carried both data and errors. */
function partialResponseError(path: readonly (string | number)[], data: unknown): Error {
  return Object.assign(new Error("Resource not accessible by integration"), {
    errors: [{ type: "FORBIDDEN", path }],
    data,
  });
}

const REFUSED_CONTEXT = [
  "repository",
  "pullRequest",
  "commits",
  "nodes",
  0,
  "commit",
  "statusCheckRollup",
  "contexts",
  "nodes",
  7,
] as const;

test("a refusal confined to the rollup contexts is one mergegate can carry on from", () => {
  const error = partialResponseError(REFUSED_CONTEXT, {
    repository: { pullRequest: { number: 3 } },
  });
  expect(refusedRollupOnly(graphqlErrors(error))).toBe(true);
  expect(partialPullRequest(error)).not.toBeNull();
});

test("a refusal anywhere else is not carried on from", () => {
  const error = partialResponseError(["repository", "pullRequest", "mergeStateStatus"], {
    repository: { pullRequest: { number: 3 } },
  });
  expect(refusedRollupOnly(graphqlErrors(error))).toBe(false);
});

test("a refusal in the rollup with no pull request left is not carried on from", () => {
  // Nothing to decide with, so this has to fail rather than look like an empty
  // pull request.
  expect(
    partialPullRequest(partialResponseError(REFUSED_CONTEXT, { repository: null })),
  ).toBeNull();
  expect(partialPullRequest(partialResponseError(REFUSED_CONTEXT, undefined))).toBeNull();
});
