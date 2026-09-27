import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  BUILTIN_LINES,
  describeStageEvent,
  fitToWidth,
  handoffFileName,
  LineDefinition,
  lineStagePrompt,
  renderLineProgress,
} from "./lineModel.ts";

const decodeLine = Schema.decodeUnknownEffect(LineDefinition);

const stage = {
  label: "Design",
  provider: "claudeAgent",
  model: "claude-opus-5",
  mode: "full-access",
  prompt: "Plan it.",
};

describe("line files", () => {
  it.effect("accept every built-in line, so shipped defaults match the file format", () =>
    Effect.gen(function* () {
      for (const definition of Object.values(BUILTIN_LINES)) {
        yield* decodeLine(definition);
      }
    }),
  );

  it.effect("reject a line without stages", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeLine({ stages: [] }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("reject an unknown runtime mode", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeLine({ stages: [{ ...stage, mode: "yolo" }] }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("lineStagePrompt", () => {
  it("puts the request, the worktree, and the start commit after the stage instructions", () => {
    const prompt = lineStagePrompt("Plan it.\n", "  add rate limiting  ", {
      worktreePath: "/runs/wt",
      startCommit: "abc123",
    });
    assert.isTrue(prompt.startsWith("Plan it.\n\n# Request\n\nadd rate limiting\n\n"));
    assert.include(
      prompt,
      "This run's git worktree is /runs/wt. Keep every read and change inside it",
    );
    assert.include(prompt, "`git diff abc123`");
  });
});

describe("handoffFileName", () => {
  it("numbers from one and makes the label safe for a file name", () => {
    assert.equal(handoffFileName(0, "Design"), "1-design.md");
    assert.equal(handoffFileName(2, "Security Review!"), "3-security-review.md");
    assert.equal(handoffFileName(1, "!!!"), "2-stage.md");
  });
});

describe("renderLineProgress", () => {
  it("aligns stages and shows each one's progress", () => {
    const stages = [
      { label: "Design", provider: "claudeAgent", model: "claude-opus-5" },
      { label: "Implement", provider: "codex", model: "gpt-6-sol" },
    ];
    assert.equal(
      renderLineProgress(stages, ["done", "waiting-approval"]),
      [
        "  1  Design     claude-opus-5  ✓ done",
        "  2  Implement  gpt-6-sol      ◐ waiting for approval",
      ].join("\n"),
    );
  });
});

describe("describeStageEvent", () => {
  const worktree = "/runs/wt";
  const tool = (kind: string, detail: string) =>
    ({
      type: "thread.activity-appended",
      payload: { activity: { kind, summary: "Command run", payload: { detail } } },
    }) as const;
  const message = (role: "reasoning" | "assistant" | "user") =>
    ({ type: "thread.message-sent", payload: { role } }) as const;

  it("shows the command without the worktree cd prefix", () => {
    assert.equal(
      describeStageEvent(tool("tool.updated", "Bash: cd /runs/wt && grep -n  foo src"), worktree),
      "Bash: grep -n foo src",
    );
  });

  it("falls back to the summary while a tool has no input yet", () => {
    assert.equal(describeStageEvent(tool("tool.started", "Bash: {}"), worktree), "Command run");
  });

  it("says thinking or writing for reasoning and replies, and ignores the rest", () => {
    assert.equal(describeStageEvent(message("reasoning"), worktree), "thinking");
    assert.equal(describeStageEvent(message("assistant"), worktree), "writing");
    assert.isNull(describeStageEvent(message("user"), worktree));
    assert.isNull(describeStageEvent(tool("context-window.updated", ""), worktree));
  });
});

describe("fitToWidth", () => {
  it("keeps short text and marks where long text was cut", () => {
    assert.equal(fitToWidth("short", 10), "short");
    assert.equal(fitToWidth("a longer line", 8), "a longe…");
  });
});
