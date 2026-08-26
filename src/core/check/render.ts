import { CONFIG_PATH, type Strategy } from "../config/schema.ts";
import type { GateReason } from "../policy/gate.ts";

export type CheckConclusion = "success" | "failure" | "action_required";

export interface CheckOutput {
  readonly conclusion: CheckConclusion;
  readonly title: string;
  readonly summary: string;
}

/** Everything the check run has to be able to say. */
export type CheckState =
  | { readonly kind: "manual"; readonly strategy: Strategy }
  | {
      readonly kind: "awaiting-label";
      readonly strategy: Strategy;
      readonly label: string;
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
    summary: "squashables merges once every other check on this commit has succeeded.",
  },
  "waiting-review": {
    title: "Waiting for review approval",
    summary: "This pull request still needs an approving review.",
  },
  "changes-requested": {
    title: "Cannot merge: changes requested",
    summary: "A reviewer requested changes. squashables never merges over a requested change.",
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
      };
    case "awaiting-label":
      return {
        conclusion: "action_required",
        title: "Merge commit required",
        summary: [
          `This pull request must be merged with a ${STRATEGY_LABEL[state.strategy]}, which the merge`,
          `button cannot do here. Add the \`${state.label}\` label and squashables will merge it for you.`,
        ].join(" "),
      };
    case "waiting": {
      const waiting = WAITING[state.reason];
      return { conclusion: "action_required", title: waiting.title, summary: waiting.summary };
    }
    case "merged":
      return {
        conclusion: "success",
        title: "Merged by squashables",
        summary: `Merged with a ${STRATEGY_LABEL[state.strategy]}.`,
      };
    case "merge-failed":
      return {
        conclusion: "action_required",
        title: "Cannot merge",
        summary: state.message,
      };
    case "forbidden":
      return {
        conclusion: "failure",
        title: `Pull requests into ${state.base} from ${state.head} are not allowed`,
        summary: `\`${CONFIG_PATH}\` forbids this pair of branches. Retarget the pull request or close it.`,
      };
    case "invalid-config":
      return {
        conclusion: "failure",
        title: `Invalid ${CONFIG_PATH}`,
        summary: [
          `squashables could not read \`${CONFIG_PATH}\` from the default branch, so it cannot decide`,
          "how this pull request may be merged:",
          "",
          ...state.errors.map((error) => `- ${error}`),
        ].join("\n"),
      };
  }
}
