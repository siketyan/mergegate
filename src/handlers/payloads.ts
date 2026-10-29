/**
 * Webhook payloads are external input, so only the handful of fields the app
 * actually reads are described here, and they are validated before use.
 */

import * as v from "valibot";

const repository = v.object({
  name: v.string(),
  owner: v.object({ login: v.string() }),
});

const installation = v.object({ id: v.number() });

const pullRequestRefs = v.optional(v.array(v.object({ number: v.number() })), []);

/** `pull_request` and `pull_request_review` both carry what evaluation needs. */
export const pullRequestEventSchema = v.object({
  action: v.string(),
  installation,
  repository,
  /** The head is what the failing check run goes on when evaluation cannot get far enough to read it. */
  pull_request: v.object({
    number: v.number(),
    head: v.optional(v.object({ sha: v.string() })),
  }),
});

export const checkSuiteEventSchema = v.object({
  action: v.string(),
  installation,
  repository,
  check_suite: v.object({
    head_sha: v.string(),
    app: v.object({ id: v.number() }),
    pull_requests: pullRequestRefs,
  }),
});

export const checkRunEventSchema = v.object({
  action: v.string(),
  installation,
  repository,
  /** Only `requested_action` reads it, so a payload without it still parses. */
  sender: v.optional(v.object({ login: v.string() })),
  check_run: v.object({
    head_sha: v.string(),
    app: v.object({ id: v.number() }),
    pull_requests: pullRequestRefs,
  }),
  /** Only on `requested_action`: which button was pressed. */
  requested_action: v.optional(v.object({ identifier: v.string() })),
});

export const statusEventSchema = v.object({
  installation,
  repository,
  sha: v.string(),
});

export const pushEventSchema = v.object({
  installation,
  repository: v.object({
    name: v.string(),
    owner: v.object({ login: v.string() }),
    default_branch: v.string(),
  }),
  ref: v.string(),
});

export type RepositoryPayload = v.InferOutput<typeof repository>;
