/**
 * Pure rules behind `t3 line`: the line file format, the built-in line, and
 * how a run is prompted and shown. A line is stages run in order on one
 * worktree; each stage is started with the same machinery as `t3 stage`.
 */
import {
  type OrchestrationMessageRole,
  type OrchestrationThreadActivity,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { StageState } from "./stageModel.ts";

export const LineStage = Schema.Struct({
  label: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  mode: RuntimeMode,
  prompt: TrimmedNonEmptyString,
});
export type LineStage = typeof LineStage.Type;

/** Contents of `<T3 home>/lines/<name>.json`. */
export const LineDefinition = Schema.Struct({
  description: Schema.optional(Schema.String),
  stages: Schema.NonEmptyArray(LineStage),
});
export type LineDefinition = typeof LineDefinition.Type;

export const decodeLineDefinitionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LineDefinition),
);

// Nobody watches a line from the T3 app, so every stage is told not to ask
// questions and runs in full access: an approval request would wait forever.
// The run's worktree is disposable, which is what makes that acceptable.
const NO_HUMAN =
  "Nobody is watching this stage and nobody can answer questions. Where something is ambiguous, choose the most reasonable interpretation and state it as an assumption.";

export const BUILTIN_LINES: Readonly<Record<string, LineDefinition>> = {
  "design-implement-review": {
    description: "Plan with Claude, build with Codex, review with Claude.",
    stages: [
      {
        label: "Design",
        provider: "claudeAgent",
        model: "claude-opus-5",
        mode: "full-access",
        prompt: [
          "You are the Design stage of a line: Design, then Implement, then Review. Each stage is a separate agent that shares this git worktree but not this conversation. The Implement stage receives only your final reply.",
          "Understand the request, inspect the relevant code and the project's conventions, and produce an implementation plan. Do not modify files.",
          NO_HUMAN,
          "End with one self-contained final reply that is the plan: the intended outcome, relevant constraints, the chosen approach, concrete steps with file paths, how to verify the result, and your assumptions. Keep it proportionate to the task.",
        ].join("\n\n"),
      },
      {
        label: "Implement",
        provider: "codex",
        model: "gpt-6-sol",
        mode: "full-access",
        prompt: [
          "You are the Implement stage of a line: Design, then Implement, then Review. Each stage is a separate agent that shares this git worktree but not this conversation. You receive the request and the Design stage's plan below.",
          "Build the solution in this worktree. Follow the project's own instructions (AGENTS.md, CLAUDE.md, READMEs) and verify the affected behavior with the project's tests or checks where practical. The plan is guidance: adjust technical details when the code shows a better way, but keep the requested outcome and constraints. Leave your changes uncommitted.",
          NO_HUMAN,
          "End with one self-contained final reply: what changed and where, how you verified it, and any departures from the plan with the reason for each.",
        ].join("\n\n"),
      },
      {
        label: "Review",
        provider: "claudeAgent",
        model: "claude-opus-5",
        mode: "full-access",
        prompt: [
          "You are the Review stage of a line: Design, then Implement, then Review. Each stage is a separate agent that shares this git worktree but not this conversation. You receive the request, the plan, and the implementer's summary below.",
          "Review the changes in this worktree against the request and the plan. Inspect them yourself with `git status` and `git diff` against the run's start commit; new files appear only in `git status`. Do not modify files.",
          NO_HUMAN,
          "End with one self-contained final reply that is the review: concrete problems (bugs, missed requirements, risky changes, missing verification), each with its file and why it matters, most severe first; the results of any checks you ran; and a one-line verdict: ready, ready after minor fixes, or not ready.",
        ].join("\n\n"),
      },
    ],
  },
};

/**
 * The stage's instructions, the request, and where the run lives. The absolute
 * worktree path matters: stages run in full access, and a model that guesses
 * "the repository root" from surrounding context can write outside the run.
 */
export function lineStagePrompt(
  stagePrompt: string,
  request: string,
  run: { readonly worktreePath: string; readonly startCommit: string },
) {
  return [
    stagePrompt.trim(),
    `# Request\n\n${request.trim()}`,
    `This run's git worktree is ${run.worktreePath}. Keep every read and change inside it; "the repository root" means that directory. The run started at commit ${run.startCommit}. \`git diff ${run.startCommit}\` and \`git status\` show everything earlier stages changed.`,
  ].join("\n\n");
}

/** `1-design.md`: ordered, readable, and safe as a file name. */
export function handoffFileName(index: number, label: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${index + 1}-${slug || "stage"}.md`;
}

export type LineStageProgress = StageState | "pending" | "done";

const progressText: Record<LineStageProgress, string> = {
  pending: "○ pending",
  running: "● running",
  "waiting-approval": "◐ waiting for approval",
  "waiting-input": "◐ waiting for an answer",
  idle: "✓ done",
  done: "✓ done",
  interrupted: "■ stopped",
  failed: "✗ failed",
};

export function describeProgress(progress: LineStageProgress) {
  return progressText[progress];
}

/** One aligned row per stage, for the run's progress display. */
export function renderLineProgress(
  stages: ReadonlyArray<Pick<LineStage, "label" | "provider" | "model">>,
  progress: ReadonlyArray<LineStageProgress>,
) {
  const labelWidth = Math.max(...stages.map((stage) => stage.label.length));
  const modelWidth = Math.max(...stages.map((stage) => stage.model.length));
  return stages
    .map((stage, index) =>
      [
        `  ${index + 1}`,
        stage.label.padEnd(labelWidth),
        stage.model.padEnd(modelWidth),
        describeProgress(progress[index] ?? "pending"),
      ].join("  "),
    )
    .join("\n");
}

/** The thread events that say what a working stage is doing right now. */
export type StageActivityEvent =
  | {
      readonly type: "thread.activity-appended";
      readonly payload: {
        readonly activity: Pick<OrchestrationThreadActivity, "kind" | "summary" | "payload">;
      };
    }
  | {
      readonly type: "thread.message-sent";
      readonly payload: { readonly role: OrchestrationMessageRole };
    };

/**
 * A short phrase for the live status line: the tool call being made, or
 * "thinking" / "writing". Null keeps the previous phrase.
 */
export function describeStageEvent(event: StageActivityEvent, worktreePath: string) {
  if (event.type === "thread.message-sent") {
    if (event.payload.role === "reasoning") return "thinking";
    if (event.payload.role === "assistant") return "writing";
    return null;
  }
  const { activity } = event.payload;
  if (activity.kind !== "tool.started" && activity.kind !== "tool.updated") return null;
  const detail =
    Predicate.isObject(activity.payload) && typeof activity.payload.detail === "string"
      ? activity.payload.detail
      : "";
  // Agents prefix nearly every command with `cd <worktree> &&`; it says nothing.
  const phrase = detail.replaceAll(`cd ${worktreePath} && `, "").replace(/\s+/g, " ").trim();
  // A started tool often has no input yet ("Bash: {}"); its summary reads better.
  return phrase.length === 0 || phrase.endsWith(": {}") ? activity.summary : phrase;
}

/** Cuts `text` to one terminal row, marking the cut. */
export function fitToWidth(text: string, width: number) {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
