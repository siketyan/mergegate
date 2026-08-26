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
      /** Whether `merge.allowCheckAction` lets the button stand in for the label. */
      readonly offerMerge: boolean;
    }
  | { readonly kind: "waiting"; readonly reason: GateReason; readonly label: string }
  | { readonly kind: "merged"; readonly strategy: Strategy }
  | { readonly kind: "merge-failed"; readonly message: string }
  | { readonly kind: "forbidden"; readonly base: string; readonly head: string }
  | { readonly kind: "invalid-config"; readonly errors: readonly string[] };

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

const WAITING: Record<GateReason, { title: string; summary: string }> = {
  draft: {
    title: "Waiting for the pull request to be ready",
    summary: "This pull request is a draft. Mark it ready for review to continue.",
  },
  "mergeability-unknown": {
    title: "Waiting for GitHub to compute mergeability",
    summary:
      "GitHub has not finished computing whether this branch merges cleanly. Retrying shortly.",
  },
  conflict: {
    title: "Cannot merge: conflicts with base",
    summary:
      "This branch conflicts with its base branch. Resolve the conflicts and add the label again.",
  },
  "waiting-checks": {
    title: "Waiting for other checks",
    summary: "mergegate merges once every other check on this commit has succeeded.",
  },
  "waiting-review": {
    title: "Waiting for review approval",
    summary: "This pull request still needs an approving review.",
  },
  "changes-requested": {
    title: "Cannot merge: changes requested",
    summary: "A reviewer requested changes. mergegate never merges over a requested change.",
  },
  "behind-base": {
    title: "Waiting for the branch to be up to date",
    summary: "Update this branch from its base, then add the label again.",
  },
};

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
      // The merge is already armed here, so there is nothing left to press.
      return {
        conclusion: "action_required",
        title: waiting.title,
        summary: waiting.summary,
        actions: [],
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
        actions: [],
      };
    case "forbidden":
      return {
        conclusion: "failure",
        title: `Pull requests into ${state.base} from ${state.head} are not allowed`,
        summary: `\`${CONFIG_PATH}\` forbids this pair of branches. Retarget the pull request or close it.`,
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
