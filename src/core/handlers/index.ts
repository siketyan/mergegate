import * as v from "valibot";
import { MERGE_ACTION_IDENTIFIER } from "../check/render.ts";
import type { AppContext, GitHubApi, RepoRef } from "../ports.ts";
import { invalidateConfig } from "./config.ts";
import { evaluatePullRequest, type EvaluateOptions } from "./evaluate.ts";
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

/**
 * Invariant: never react to a check run of ours *finishing*, or the app loops
 * forever. The Re-run and requested-action deliveries are the other way round —
 * GitHub only sends those to the app that owns the check run, so they are
 * handled precisely when this is true.
 */
function isOwnApp(context: AppContext, appId: number): boolean {
  return String(appId) === context.env.appId;
}

async function evaluateSha(
  context: AppContext,
  api: GitHubApi,
  repo: RepoRef,
  sha: string,
  known: readonly number[],
  options: EvaluateOptions = {},
): Promise<void> {
  // `pull_requests` is empty for pull requests from forks, hence the fallback.
  const numbers = known.length > 0 ? known : await api.findPullRequestsForSha(repo, sha);
  for (const number of numbers) {
    await evaluatePullRequest(context, api, repo, number, options);
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
      if (!parsed.success) {
        return;
      }
      const suite = parsed.output.check_suite;
      const own = isOwnApp(context, suite.app.id);
      // `completed` from our own suite would loop. `rerequested` is "Re-run all
      // checks", which only ever reaches the app whose suite it is.
      const handled =
        (parsed.output.action === "completed" && !own) ||
        (parsed.output.action === "rerequested" && own);
      if (!handled) {
        return;
      }
      const api = context.github.forInstallation(parsed.output.installation.id);
      await evaluateSha(
        context,
        api,
        toRepo(parsed.output.repository),
        suite.head_sha,
        suite.pull_requests.map((pull) => pull.number),
      );
      return;
    }

    case "check_run": {
      const parsed = v.safeParse(checkRunEventSchema, payload);
      if (!parsed.success) {
        return;
      }
      const { action, check_run: checkRun, repository, sender } = parsed.output;
      const own = isOwnApp(context, checkRun.app.id);
      const repo = toRepo(repository);
      const known = checkRun.pull_requests.map((pull) => pull.number);

      switch (action) {
        // Someone else's check finishing can change whether an assisted merge
        // is ready. Our own finishing would loop.
        case "completed": {
          if (own) {
            return;
          }
          const api = context.github.forInstallation(parsed.output.installation.id);
          await evaluateSha(context, api, repo, checkRun.head_sha, known);
          return;
        }

        // The Re-run button on our own check run. The app remembers nothing
        // between deliveries, so re-evaluating from scratch is the whole of it.
        case "rerequested": {
          if (!own) {
            return;
          }
          const api = context.github.forInstallation(parsed.output.installation.id);
          await evaluateSha(context, api, repo, checkRun.head_sha, known);
          return;
        }

        // A button in the Checks tab. Whether the press may stand in for the
        // label is `evaluatePullRequest`'s call; here it is only routed.
        case "requested_action": {
          if (!own || parsed.output.requested_action?.identifier !== MERGE_ACTION_IDENTIFIER) {
            return;
          }
          const actor = sender?.login;
          if (actor === undefined) {
            context.logger.warn("merge action without a sender");
            return;
          }
          const api = context.github.forInstallation(parsed.output.installation.id);
          const numbers =
            known.length > 0 ? known : await api.findPullRequestsForSha(repo, checkRun.head_sha);
          // The press names a commit, not a pull request. A commit that heads
          // more than one leaves no way to tell which button was pressed, so
          // nothing is merged off the back of it.
          if (numbers.length > 1) {
            context.logger.warn("merge action ignored: the commit heads several pull requests", {
              pulls: numbers,
            });
          }
          const request: EvaluateOptions =
            numbers.length === 1 ? { mergeRequest: { headSha: checkRun.head_sha, actor } } : {};
          for (const number of numbers) {
            await evaluatePullRequest(context, api, repo, number, request);
          }
          return;
        }

        default:
          return;
      }
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
