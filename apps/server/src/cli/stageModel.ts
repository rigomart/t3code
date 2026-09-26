/**
 * Pure rules behind `t3 stage`. A stage is an ordinary thread; these functions
 * decide what state it is in, what it hands to the next stage, and how the
 * next stage's opening prompt is assembled. No IO lives here.
 */
import type { OrchestrationThread, OrchestrationThreadShell } from "@t3tools/contracts";

import { threadHasQueuedTurnStart } from "../orchestration/ThreadSettlementPolicy.ts";

export type StageState =
  | "idle"
  | "running"
  | "waiting-approval"
  | "waiting-input"
  | "interrupted"
  | "failed";

/** `t3 stage status` exit codes, so scripts and agents branch without parsing output. */
export const stageStateExitCode: Record<StageState, number> = {
  idle: 0,
  failed: 1,
  running: 2,
  "waiting-approval": 3,
  "waiting-input": 3,
  interrupted: 4,
};

/** States in which the stage can take another turn. */
export const stageAcceptsTurns = (state: StageState) =>
  state === "idle" || state === "interrupted" || state === "failed";

/** States in which another stage must not start on the same worktree. */
export const stageIsBusy = (state: StageState) =>
  state === "running" || state === "waiting-approval" || state === "waiting-input";

type StageStateInput = Pick<
  OrchestrationThreadShell,
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestUserMessageAt"
>;

/**
 * Mirrors the server's idle definition (see `storageCleanupThreadIdle`) minus
 * the session-stopped condition. Waiting on a human wins over running, because
 * a turn stays running while it waits on an approval or answer.
 */
export function deriveStageState(thread: StageStateInput, now: string): StageState {
  if (thread.hasPendingApprovals) return "waiting-approval";
  if (thread.hasPendingUserInput) return "waiting-input";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "failed";
  if (
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null ||
    threadHasQueuedTurnStart(thread, now)
  ) {
    return "running";
  }
  if (thread.latestTurn?.state === "interrupted") return "interrupted";
  return "idle";
}

/** Generous enough for a detailed design, small enough for any provider's opening prompt. */
export const HANDOFF_CHARACTER_LIMIT = 120_000;

export interface StageHandoff {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

/** The stage's latest finished assistant reply, capped at `limit` characters. */
export function selectStageHandoff(
  thread: Pick<OrchestrationThread, "messages">,
  limit = HANDOFF_CHARACTER_LIMIT,
): StageHandoff | null {
  const reply = thread.messages.findLast(
    (message) =>
      message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
  );
  if (reply === undefined) return null;
  const text = reply.text;
  if (text.length <= limit) return { text, truncated: false, originalLength: text.length };
  return {
    text: `${text.slice(0, limit)}\n\n[t3 stage: handoff truncated from ${text.length} to ${limit} characters]`,
    truncated: true,
    originalLength: text.length,
  };
}

export interface StageInput {
  readonly name: string;
  readonly text: string;
}

/** The stage prompt, then each earlier handoff in order under a fixed heading. */
export function buildStagePrompt(prompt: string, inputs: ReadonlyArray<StageInput>): string {
  const sections = inputs.map(
    (input, index) => `## Handoff ${index + 1}: ${input.name}\n\n${input.text.trim()}`,
  );
  return [prompt.trim(), ...(sections.length > 0 ? ["# Earlier stage handoffs", ...sections] : [])]
    .join("\n\n")
    .concat("\n");
}

const TITLE_SUMMARY_LIMIT = 80;

/** `[stage] <label> · <first prompt line>`, so stage threads stand out in the sidebar. */
export function stageThreadTitle(prompt: string, label?: string): string {
  const firstLine =
    prompt
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "stage";
  const summary =
    firstLine.length > TITLE_SUMMARY_LIMIT
      ? `${firstLine.slice(0, TITLE_SUMMARY_LIMIT - 1)}…`
      : firstLine;
  const trimmedLabel = label?.trim();
  return trimmedLabel ? `[stage] ${trimmedLabel} · ${summary}` : `[stage] ${summary}`;
}
