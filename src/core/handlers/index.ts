import type { AppContext, GitHubApi, RepoRef } from "../ports.ts";
import { invalidateConfig } from "./config.ts";
import { evaluatePullRequest } from "./evaluate.ts";
import {
  checkRunEventSchema,
  checkSuiteEventSchema,
  pullRequestEventSchema,
  pullRequestReviewEventSchema,
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
  return String(appId) === context.appId;
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
    case "pull_request": {
      const parsed = pullRequestEventSchema.safeParse(payload);
      if (!parsed.success || !PULL_REQUEST_ACTIONS.has(parsed.data.action)) {
        return;
      }
      const api = context.github.forInstallation(parsed.data.installation.id);
      await evaluatePullRequest(
        context,
        api,
        toRepo(parsed.data.repository),
        parsed.data.pull_request.number,
      );
      return;
    }

    case "pull_request_review": {
      const parsed = pullRequestReviewEventSchema.safeParse(payload);
      if (!parsed.success || !REVIEW_ACTIONS.has(parsed.data.action)) {
        return;
      }
      const api = context.github.forInstallation(parsed.data.installation.id);
      await evaluatePullRequest(
        context,
        api,
        toRepo(parsed.data.repository),
        parsed.data.pull_request.number,
      );
      return;
    }

    case "check_suite": {
      const parsed = checkSuiteEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.action !== "completed") {
        return;
      }
      if (isOwnApp(context, parsed.data.check_suite.app.id)) {
        return;
      }
      const api = context.github.forInstallation(parsed.data.installation.id);
      await evaluateSha(
        context,
        api,
        toRepo(parsed.data.repository),
        parsed.data.check_suite.head_sha,
        parsed.data.check_suite.pull_requests.map((pull) => pull.number),
      );
      return;
    }

    case "check_run": {
      const parsed = checkRunEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.action !== "completed") {
        return;
      }
      if (isOwnApp(context, parsed.data.check_run.app.id)) {
        return;
      }
      const api = context.github.forInstallation(parsed.data.installation.id);
      await evaluateSha(
        context,
        api,
        toRepo(parsed.data.repository),
        parsed.data.check_run.head_sha,
        [],
      );
      return;
    }

    case "status": {
      const parsed = statusEventSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      const api = context.github.forInstallation(parsed.data.installation.id);
      await evaluateSha(context, api, toRepo(parsed.data.repository), parsed.data.sha, []);
      return;
    }

    case "push": {
      const parsed = pushEventSchema.safeParse(payload);
      if (!parsed.success) {
        return;
      }
      // The configuration lives on the default branch, so only that branch can
      // have changed it.
      if (parsed.data.ref !== `refs/heads/${parsed.data.repository.default_branch}`) {
        return;
      }
      await invalidateConfig(context, toRepo(parsed.data.repository));
      return;
    }

    default:
      context.logger.debug("event ignored");
  }
}

export { evaluatePullRequest } from "./evaluate.ts";
export { invalidateConfig, loadConfig } from "./config.ts";
