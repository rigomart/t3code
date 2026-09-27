import { MessageId, TurnId, type OrchestrationThread } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  buildStagePrompt,
  deriveStageState,
  selectStageHandoff,
  stageThreadTitle,
} from "./stageModel.ts";

const NOW = "2026-09-26T12:00:00.000Z";
const turnId = TurnId.make("turn-1");

type StageStateInput = Parameters<typeof deriveStageState>[0];
const completedTurn: NonNullable<StageStateInput["latestTurn"]> = {
  turnId,
  state: "completed",
  requestedAt: "2026-09-26T11:00:00.000Z",
  startedAt: "2026-09-26T11:00:01.000Z",
  completedAt: "2026-09-26T11:05:00.000Z",
  assistantMessageId: null,
};

const shell = (overrides: Partial<StageStateInput> = {}): StageStateInput => ({
  latestTurn: completedTurn,
  session: null,
  backgroundLiveness: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: "2026-09-26T11:00:00.000Z",
  ...overrides,
});

describe("deriveStageState", () => {
  it("is idle once the turn completes with nothing pending", () => {
    assert.equal(deriveStageState(shell(), NOW), "idle");
  });

  it("reports a pending approval even while the turn is still running", () => {
    const thread = shell({
      latestTurn: { ...completedTurn, state: "running", completedAt: null },
      hasPendingApprovals: true,
    });
    assert.equal(deriveStageState(thread, NOW), "waiting-approval");
  });

  it("stays running while subagents work after the turn settles", () => {
    assert.equal(deriveStageState(shell({ backgroundLiveness: "working" }), NOW), "running");
  });

  it("treats a sent message the provider has not picked up yet as running", () => {
    const thread = shell({ latestUserMessageAt: "2026-09-26T11:59:30.000Z" });
    assert.equal(deriveStageState(thread, NOW), "running");
  });

  it("separates interrupted and failed turns from idle", () => {
    const interrupted = shell({ latestTurn: { ...completedTurn, state: "interrupted" } });
    assert.equal(deriveStageState(interrupted, NOW), "interrupted");
    const failed = shell({ latestTurn: { ...completedTurn, state: "error" } });
    assert.equal(deriveStageState(failed, NOW), "failed");
  });
});

const message = (
  text: string,
  overrides: Partial<OrchestrationThread["messages"][number]> = {},
): OrchestrationThread["messages"][number] => ({
  id: MessageId.make(`message-${text.length}-${overrides.role ?? "assistant"}`),
  role: "assistant",
  text,
  turnId,
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("selectStageHandoff", () => {
  it("takes the latest finished assistant reply, skipping reasoning and streaming text", () => {
    const handoff = selectStageHandoff({
      messages: [
        message("older reply"),
        message("please implement", { role: "user" }),
        message("final reply"),
        message("thinking about what to say next", { role: "reasoning" }),
        message("still streaming", { streaming: true }),
      ],
    });
    assert.equal(handoff?.text, "final reply");
  });

  it("returns nothing before the stage has replied", () => {
    assert.isNull(
      selectStageHandoff({ messages: [message("design a rate limiter", { role: "user" })] }),
    );
  });

  it("truncates oversized handoffs with a visible marker", () => {
    const handoff = selectStageHandoff({ messages: [message("x".repeat(50))] }, 20);
    assert.isTrue(handoff?.truncated);
    assert.equal(handoff?.originalLength, 50);
    assert.include(handoff?.text ?? "", "[t3 stage: handoff truncated from 50 to 20 characters]");
  });
});

describe("buildStagePrompt", () => {
  it("appends earlier handoffs in order under numbered headings", () => {
    const prompt = buildStagePrompt("Implement the plan.\n", [
      { name: "design.md", text: "the plan\n" },
      { name: "notes.md", text: "extra notes" },
    ]);
    assert.equal(
      prompt,
      [
        "Implement the plan.",
        "# Earlier stage handoffs",
        "## Handoff 1: design.md\n\nthe plan",
        "## Handoff 2: notes.md\n\nextra notes",
      ].join("\n\n") + "\n",
    );
  });

  it("leaves a prompt without handoffs unchanged", () => {
    assert.equal(buildStagePrompt("Design a rate limiter.", []), "Design a rate limiter.\n");
  });
});

describe("stageThreadTitle", () => {
  it("labels the thread from the prompt's first line", () => {
    assert.equal(
      stageThreadTitle("\n# Add rate limiting to /api\nmore", "Design"),
      "[stage] Design · Add rate limiting to /api",
    );
    assert.equal(stageThreadTitle("a".repeat(100)).length, "[stage] ".length + 80);
  });
});
