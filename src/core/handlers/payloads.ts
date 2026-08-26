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

/** `pull_request` and `pull_request_review` both carry what evaluation needs. */
export const pullRequestEventSchema = v.object({
  action: v.string(),
  installation,
  repository,
  pull_request: v.object({ number: v.number() }),
});

export const checkSuiteEventSchema = v.object({
  action: v.string(),
  installation,
  repository,
  check_suite: v.object({
    head_sha: v.string(),
    app: v.object({ id: v.number() }),
    pull_requests: v.optional(v.array(v.object({ number: v.number() })), []),
  }),
});

export const checkRunEventSchema = v.object({
  action: v.string(),
  installation,
  repository,
  check_run: v.object({
    head_sha: v.string(),
    app: v.object({ id: v.number() }),
  }),
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
