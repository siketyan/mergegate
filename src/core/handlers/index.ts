import * as v from "valibot";
import type { AppContext, GitHubApi, RepoRef } from "../ports.ts";
import { invalidateConfig } from "./config.ts";
import { evaluatePullRequest } from "./evaluate.ts";
import {
  checkRunEventSchema,
  checkSuiteEventSchema,
  pullRequestEventSchema,
  pushEventSchema,
  type RepositoryPayload,
  statusEventSchema,
} from "./payloads.ts";

/** Actions that can change what a pull request is allowed to do. */
const PULL_REQUEST_ACTIONS: ReadonlySet<string> = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "converted_to_draft",
  "labeled",
  "unlabeled",
]);

const REVIEW_ACTIONS: ReadonlySet<string> = new Set(["submitted", "dismissed", "edited"]);

function toRepo(repository: RepositoryPayload): RepoRef {
  return { owner: repository.owner.login, repo: repository.name };
}

/** Invariant: never react to our own check runs, or the app loops forever. */
function isOwnApp(context: AppContext, appId: number): boolean {
  return String(appId) === context.env.appId;
}

async function evaluateSha(
  context: AppContext,
  api: GitHubApi,
  repo: RepoRef,
  sha: string,
  known: readonly number[],
): Promise<void> {
  // `pull_requests` is empty for pull requests from forks, hence the fallback.
  const numbers = known.length > 0 ? known : await api.findPullRequestsForSha(repo, sha);
  for (const number of numbers) {
    await evaluatePullRequest(context, api, repo, number);
  }
}

export async function handleDelivery(
  context: AppContext,
  event: string,
  payload: unknown,
): Promise<void> {
  switch (event) {
    case "pull_request":
    case "pull_request_review": {
      const parsed = v.safeParse(pullRequestEventSchema, payload);
      const allowed = event === "pull_request" ? PULL_REQUEST_ACTIONS : REVIEW_ACTIONS;
      if (!parsed.success || !allowed.has(parsed.output.action)) {
        return;
      }
      const api = context.github.forInstallation(parsed.output.installation.id);
      await evaluatePullRequest(
        context,
        api,
        toRepo(parsed.output.repository),
        parsed.output.pull_request.number,
      );
      return;
    }

    case "check_suite": {
      const parsed = v.safeParse(checkSuiteEventSchema, payload);
      if (!parsed.success || parsed.output.action !== "completed") {
        return;
      }
      if (isOwnApp(context, parsed.output.check_suite.app.id)) {
        return;
      }
      const api = context.github.forInstallation(parsed.output.installation.id);
      await evaluateSha(
        context,
        api,
        toRepo(parsed.output.repository),
        parsed.output.check_suite.head_sha,
        parsed.output.check_suite.pull_requests.map((pull) => pull.number),
      );
      return;
    }

    case "check_run": {
      const parsed = v.safeParse(checkRunEventSchema, payload);
      if (!parsed.success || parsed.output.action !== "completed") {
        return;
      }
      if (isOwnApp(context, parsed.output.check_run.app.id)) {
        return;
      }
      const api = context.github.forInstallation(parsed.output.installation.id);
      await evaluateSha(
        context,
        api,
        toRepo(parsed.output.repository),
        parsed.output.check_run.head_sha,
        [],
      );
      return;
    }

    case "status": {
      const parsed = v.safeParse(statusEventSchema, payload);
      if (!parsed.success) {
        return;
      }
      const api = context.github.forInstallation(parsed.output.installation.id);
      await evaluateSha(context, api, toRepo(parsed.output.repository), parsed.output.sha, []);
      return;
    }

    case "push": {
      const parsed = v.safeParse(pushEventSchema, payload);
      if (!parsed.success) {
        return;
      }
      // The configuration lives on the default branch, so only that branch can
      // have changed it.
      if (parsed.output.ref !== `refs/heads/${parsed.output.repository.default_branch}`) {
        return;
      }
      await invalidateConfig(context, toRepo(parsed.output.repository));
      return;
    }

    default:
      context.logger.debug("event ignored");
  }
}
