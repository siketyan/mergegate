import { expect, test } from "vite-plus/test";
import { toGraphqlError } from "./octokit.ts";

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
