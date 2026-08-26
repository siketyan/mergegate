/**
 * Webhook payloads are external input, so only the handful of fields the app
 * actually reads are described here, and they are validated before use.
 */

import { z } from "zod";

const repository = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
});

const installation = z.object({ id: z.number() });

export const pullRequestEventSchema = z.object({
  action: z.string(),
  installation,
  repository,
  pull_request: z.object({ number: z.number() }),
});

export const pullRequestReviewEventSchema = z.object({
  action: z.string(),
  installation,
  repository,
  pull_request: z.object({ number: z.number() }),
});

export const checkSuiteEventSchema = z.object({
  action: z.string(),
  installation,
  repository,
  check_suite: z.object({
    head_sha: z.string(),
    app: z.object({ id: z.number() }),
    pull_requests: z.array(z.object({ number: z.number() })).default([]),
  }),
});

export const checkRunEventSchema = z.object({
  action: z.string(),
  installation,
  repository,
  check_run: z.object({
    head_sha: z.string(),
    app: z.object({ id: z.number() }),
  }),
});

export const statusEventSchema = z.object({
  installation,
  repository,
  sha: z.string(),
});

export const pushEventSchema = z.object({
  installation,
  repository: z.object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
    default_branch: z.string(),
  }),
  ref: z.string(),
});

export type RepositoryPayload = z.output<typeof repository>;
