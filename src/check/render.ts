import { CONFIG_PATH, type Strategy } from "../config/schema.ts";
import type { GateReason } from "../policy/gate.ts";

export type CheckConclusion = "success" | "failure" | "action_required";

/**
 * A button rendered under the check run in the Checks tab. GitHub caps a label
 * at 20 characters, a description at 40 and an identifier at 20, and accepts at
 * most three of them per check run.
 */
export interface CheckAction {
  readonly label: string;
  readonly description: string;
  readonly identifier: string;
}

/** The only button mergegate offers: arm the assisted merge without the label. */
export const MERGE_ACTION_IDENTIFIER = "merge";

export interface CheckOutput {
  readonly conclusion: CheckConclusion;
  readonly title: string;
  readonly summary: string;
  /** Empty for every state where there is nothing for a human to press. */
  readonly actions: readonly CheckAction[];
}

/** Everything the check run has to be able to say. */
export type CheckState =
  | { readonly kind: "manual"; readonly strategy: Strategy }
  | {
      readonly kind: "awaiting-label";
      readonly strategy: Strategy;
      readonly label: string;
      /** Whether `merge.allowCheckAction` lets the button merge without a label. */
      readonly offerMerge: boolean;
    }
  | {
      readonly kind: "waiting";
      readonly reason: GateReason;
      readonly label: string;
      readonly strategy: Strategy;
      /**
       * Whether the label is on. Only then does mergegate come back by itself;
       * a merge asked for with the button happens once and is not remembered.
       */
      readonly armed: boolean;
      readonly offerMerge: boolean;
    }
  | { readonly kind: "merged"; readonly strategy: Strategy }
  | {
      readonly kind: "merge-failed";
      readonly message: string;
      readonly strategy: Strategy;
      readonly offerMerge: boolean;
    }
  | { readonly kind: "forbidden"; readonly base: string; readonly head: string }
  | { readonly kind: "invalid-config"; readonly errors: readonly string[] }
  | {
      /** GitHub refused a call, so there is no decision to report. */
      readonly kind: "error";
      readonly message: string;
      /** A 401 or 403: a permission a human has to grant, not a hiccup. */
      readonly forbidden: boolean;
    };

const STRATEGY_LABEL: Record<Strategy, string> = {
  squash: "squash merge",
  merge: "merge commit",
  rebase: "rebase merge",
};

function capitalise(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function mergeAction(strategy: Strategy): CheckAction {
  return {
    label: "Merge now",
    // 40 characters at most, so it names the strategy and nothing else.
    description: `Merge with a ${STRATEGY_LABEL[strategy]}`,
    identifier: MERGE_ACTION_IDENTIFIER,
  };
}

/**
 * How a wait ends.
 *
 * - `resumes`: an ordinary event brings mergegate back, so a labelled pull
 *   request clears this without anyone doing anything.
 * - `retry`: nothing is guaranteed to wake the app again, so someone has to ask
 *   for another attempt.
 * - `manual`: mergegate cannot merge this one at all.
 */
type Recovery = "resumes" | "retry" | "manual";

interface Waiting {
  readonly title: string;
  /** What is in the way. What happens next is `nextStep`'s to say. */
  readonly summary: string;
  readonly recovery: Recovery;
}

const WAITING: Record<GateReason, Waiting> = {
  draft: {
    title: "Waiting for the pull request to be ready",
    summary: "This pull request is a draft. Mark it ready for review to continue.",
    recovery: "resumes",
  },
  "mergeability-unknown": {
    title: "Waiting for GitHub to compute mergeability",
    summary:
      "GitHub had not finished working out whether this branch merges cleanly, and it did not settle " +
      "while mergegate waited.",
    // The backoff is spent, and a repository with no other checks produces no
    // further event to come back on.
    recovery: "retry",
  },
  conflict: {
    title: "Cannot merge: conflicts with base",
    summary: "This branch conflicts with its base branch. Resolve the conflicts to continue.",
    recovery: "resumes",
  },
  "waiting-checks": {
    title: "Waiting for other checks",
    summary: "Every other check on this commit has to succeed first.",
    recovery: "resumes",
  },
  "checks-unreadable": {
    title: "Cannot read every check on this commit",
    summary:
      "This commit has more checks than mergegate reads, so it cannot tell whether they all passed. " +
      "Merge this pull request by hand, or reduce the number of checks on the commit.",
    recovery: "manual",
  },
  "checks-refused": {
    title: "Cannot read every check on this commit",
    summary:
      "GitHub refused one of the checks on this commit, so mergegate cannot tell whether it passed. " +
      "A commit status needs the app's **Commit statuses: read** permission, which is separate from " +
      "Checks. Grant it, or merge this pull request by hand.",
    recovery: "manual",
  },
  "waiting-review": {
    title: "Waiting for review approval",
    summary: "This pull request still needs an approving review.",
    recovery: "resumes",
  },
  "changes-requested": {
    title: "Cannot merge: changes requested",
    summary: "A reviewer requested changes. mergegate never merges over a requested change.",
    recovery: "resumes",
  },
  "behind-base": {
    title: "Waiting for the branch to be up to date",
    summary: "Update this branch from its base to continue.",
    recovery: "resumes",
  },
};

interface Trigger {
  readonly label: string;
  /** Whether the label is on, and so whether mergegate returns by itself. */
  readonly armed: boolean;
  readonly offerMerge: boolean;
}

/**
 * The label is a standing instruction, so mergegate comes back to a labelled
 * pull request on its own. A press of the button is a one-off, and saying so is
 * the difference between an honest check run and a promise nobody keeps.
 */
function nextStep(state: Trigger, recovery: Recovery): string {
  switch (recovery) {
    case "manual":
      // The summary already says the only thing that works.
      return "";
    case "retry": {
      if (state.armed) {
        return `Push to the branch or re-add the \`${state.label}\` label to try again.`;
      }
      return state.offerMerge
        ? `Add the \`${state.label}\` label, or press **Merge now** again, to try again.`
        : `Add the \`${state.label}\` label to try again.`;
    }
    case "resumes": {
      if (state.armed) {
        return `mergegate merges as soon as that clears, while the \`${state.label}\` label is on.`;
      }
      const label = `Add the \`${state.label}\` label to have mergegate merge as soon as that clears`;
      return state.offerMerge ? `${label}, or press **Merge now** again yourself.` : `${label}.`;
    }
  }
}

export function renderCheck(state: CheckState): CheckOutput {
  switch (state.kind) {
    case "manual":
      return {
        conclusion: "success",
        title: capitalise(STRATEGY_LABEL[state.strategy]),
        summary: `Merge this pull request with a ${STRATEGY_LABEL[state.strategy]}.`,
        actions: [],
      };
    case "awaiting-label":
      return {
        conclusion: "action_required",
        title: "Merge commit required",
        summary: [
          `This pull request must be merged with a ${STRATEGY_LABEL[state.strategy]}, which the merge`,
          `button cannot do here. Add the \`${state.label}\` label`,
          state.offerMerge ? "or press **Merge now** below," : "",
          "and mergegate will merge it for you.",
        ]
          .filter((part) => part !== "")
          .join(" "),
        actions: state.offerMerge ? [mergeAction(state.strategy)] : [],
      };
    case "waiting": {
      const waiting = WAITING[state.reason];
      const step = nextStep(state, waiting.recovery);
      return {
        conclusion: "action_required",
        title: waiting.title,
        summary: step === "" ? waiting.summary : `${waiting.summary} ${step}`,
        // Nothing to press where a press could never clear it either.
        actions:
          state.offerMerge && waiting.recovery !== "manual" ? [mergeAction(state.strategy)] : [],
      };
    }
    case "merged":
      return {
        conclusion: "success",
        title: "Merged by mergegate",
        summary: `Merged with a ${STRATEGY_LABEL[state.strategy]}.`,
        actions: [],
      };
    case "merge-failed":
      return {
        conclusion: "action_required",
        title: "Cannot merge",
        summary: state.message,
        actions: state.offerMerge ? [mergeAction(state.strategy)] : [],
      };
    case "forbidden":
      return {
        conclusion: "failure",
        title: `Pull requests into ${state.base} from ${state.head} are not allowed`,
        summary: `\`${CONFIG_PATH}\` forbids this pair of branches. Retarget the pull request or close it.`,
        actions: [],
      };
    case "error":
      return {
        // Fail closed: mergegate could not decide, so it must not read as a
        // pull request that is free to be merged.
        conclusion: "failure",
        title: state.forbidden
          ? "mergegate is missing a permission"
          : "mergegate could not evaluate this pull request",
        summary: (state.forbidden
          ? [
              "GitHub refused a call mergegate needs to make:",
              "",
              `> ${state.message}`,
              "",
              "The installation is missing a permission. Check the app's repository permissions" +
                " (Checks: read & write, Contents: read & write, Pull requests: read & write," +
                " Metadata: read), and that this installation has **accepted** them: adding a" +
                " permission to a GitHub App leaves every existing installation on the old set" +
                " until its owner approves the request, and every call is refused until they do.",
              "",
              "Re-run this check once the permissions are in place.",
            ]
          : [
              "mergegate could not decide how this pull request may be merged:",
              "",
              `> ${state.message}`,
              "",
              "Re-run this check to try again.",
            ]
        ).join("\n"),
        actions: [],
      };
    case "invalid-config":
      return {
        conclusion: "failure",
        title: `Invalid ${CONFIG_PATH}`,
        summary: [
          `mergegate could not read \`${CONFIG_PATH}\` from the default branch, so it cannot decide`,
          "how this pull request may be merged:",
          "",
          ...state.errors.map((error) => `- ${error}`),
        ].join("\n"),
        actions: [],
      };
  }
}
