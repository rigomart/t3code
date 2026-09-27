/**
 * `t3 line` - run a line of stages on a fresh worktree, attended in the terminal.
 *
 * This is the command people type: everything but the request lives in a line
 * file (`<T3 home>/lines/<name>.json`, or a built-in line). `run` creates the
 * worktree, runs each stage with the `t3 stage` machinery, shows progress, and
 * pauses between stages so the handoff can be read or edited. Agents and
 * scripts that want full control use `t3 stage` directly.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { CommandId, type OrchestrationThreadShell, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";

import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  BUILTIN_LINES,
  decodeLineDefinitionJson,
  describeProgress,
  handoffFileName,
  type LineDefinition,
  type LineStageProgress,
  lineStagePrompt,
  renderLineProgress,
} from "./lineModel.ts";
import {
  findProjectForCheckout,
  git,
  interruptStage,
  parseModelSelection,
  prettyJson,
  readStage,
  readStageHandoff,
  resolveCheckout,
  resolveStageWorktree,
  STAGE_POLL_INTERVAL,
  type StageClient,
  StageCommandError,
  startStage,
  withStageClient,
} from "./stage.ts";
import { buildStagePrompt, stageIsBusy, type StageState, stageThreadTitle } from "./stageModel.ts";

export class LineCommandError extends Schema.TaggedError<LineCommandError>()("LineCommandError", {
  reason: Schema.Literals(["unknown-line", "invalid-line"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const HANDOFF_PREVIEW_LINES = 12;
/** Polls before a newly started stage must be visible to the server's reads. */
const STAGE_APPEAR_POLLS = 15;

const linesDir = (path: Path.Path, baseDir: string) => path.join(baseDir, "lines");

// ---------------------------------------------------------------------------
// Line files

const listLineNames = Effect.fn("listLineNames")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = linesDir(path, baseDir);
  const files = (yield* fs.exists(dir)) ? yield* fs.readDirectory(dir) : [];
  const fromFiles = files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  return [...new Set([...fromFiles, ...Object.keys(BUILTIN_LINES)])].sort();
});

/** A line file path, a name in `<T3 home>/lines`, or a built-in line, in that order. */
const loadLine = Effect.fn("loadLine")(function* (baseDir: string, nameOrPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const isPath = nameOrPath.includes("/") || nameOrPath.endsWith(".json");
  const file = isPath
    ? path.resolve(nameOrPath)
    : path.join(linesDir(path, baseDir), `${nameOrPath}.json`);
  const name = isPath ? path.basename(file, ".json") : nameOrPath;

  if (yield* fs.exists(file)) {
    const definition = yield* decodeLineDefinitionJson(yield* fs.readFileString(file)).pipe(
      Effect.mapError(
        (cause) =>
          new LineCommandError({
            reason: "invalid-line",
            detail: `Line file ${file} is invalid: ${cause.message}`,
            cause,
          }),
      ),
    );
    return { name, file: Option.some(file), definition };
  }
  const builtin = isPath ? undefined : BUILTIN_LINES[nameOrPath];
  if (builtin) return { name, file: Option.none<string>(), definition: builtin };

  const available = yield* listLineNames(baseDir);
  return yield* new LineCommandError({
    reason: "unknown-line",
    detail: `No line '${nameOrPath}'. Available: ${available.join(", ")}.`,
  });
});

const resolveLineConfig = (flags: { readonly baseDir: Option.Option<string> }) =>
  GlobalFlag.LogLevel.pipe(Effect.flatMap((logLevel) => resolveCliAuthConfig(flags, logLevel)));

// ---------------------------------------------------------------------------
// Terminal interaction

/**
 * One reader for the whole run, so piped answers are not lost between prompts.
 * End of input reads as "q", which stops the run instead of hanging.
 */
const makeAnswerReader = Effect.acquireRelease(
  Effect.sync(() => {
    const rl = NodeReadline.createInterface({ input: process.stdin, terminal: false });
    const queued: Array<string> = [];
    let waiting: ((line: string) => void) | undefined;
    let closed = false;
    const deliver = (line: string) => {
      if (waiting === undefined) return void queued.push(line);
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    };
    rl.on("line", (line) => deliver(line.trim()));
    rl.on("close", () => {
      closed = true;
      if (waiting !== undefined) deliver("q");
    });
    return {
      rl,
      isClosed: () => closed,
      next: Effect.promise<string>(
        () =>
          new Promise((resolve) => {
            const line = queued.shift();
            if (line !== undefined) resolve(line);
            else if (closed) resolve("q");
            else waiting = resolve;
          }),
      ),
    };
  }),
  (reader) => Effect.sync(() => reader.rl.close()),
);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Opens `file` in `$VISUAL` or `$EDITOR`, falling back to vi. */
const editFile = (reader: Effect.Success<typeof makeAnswerReader>, file: string) =>
  Effect.sync(() => {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    // The editor owns the terminal while it runs; piped input may already be closed.
    const open = !reader.isClosed();
    if (open) reader.rl.pause();
    try {
      return NodeChildProcess.spawnSync(`${editor} ${shellQuote(file)}`, {
        stdio: "inherit",
        shell: true,
      }).status;
    } finally {
      if (open) reader.rl.resume();
    }
  });

const formatElapsed = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
};

// ---------------------------------------------------------------------------
// Run

type LineRunStatus = "running" | "completed" | "stopped" | "failed";

/** Written to `<T3 home>/lines/runs/<id>/run.json` after every change. */
interface LineRunRecord {
  readonly id: string;
  readonly line: string;
  readonly request: string;
  readonly projectId: string;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly startCommit: string;
  readonly createdAt: string;
  status: LineRunStatus;
  readonly stages: Array<
    LineDefinition["stages"][number] & {
      threadId: string | null;
      handoffFile: string | null;
      outcome: LineStageProgress;
    }
  >;
}

/** Polls a started stage until it stops working, printing each state change. */
const waitForStage = Effect.fn("waitForStage")(function* (
  client: StageClient,
  threadId: string,
  label: string,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  let lastState: StageState | undefined;
  let lastThread: OrchestrationThreadShell | undefined;
  let missingPolls = 0;
  const poll = Effect.gen(function* () {
    while (true) {
      const read = yield* readStage(client, threadId).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason === "stage-not-found" && ++missingPolls < STAGE_APPEAR_POLLS,
          () => Effect.succeedNone,
        ),
      );
      if (Option.isSome(read)) {
        const { thread, state } = read.value;
        lastThread = thread;
        if (state !== lastState) {
          lastState = state;
          const hint =
            state === "waiting-approval" || state === "waiting-input"
              ? " (open the thread in T3 to respond, or Ctrl-C to stop)"
              : "";
          const elapsed = formatElapsed((yield* Clock.currentTimeMillis) - startedAt);
          yield* Console.log(`  ${label}: ${describeProgress(state)} · ${elapsed}${hint}`);
        }
        if (!stageIsBusy(state)) return read.value;
      }
      yield* Effect.sleep(STAGE_POLL_INTERVAL);
    }
  });
  // Ctrl-C stops the stage too, so nothing keeps editing the worktree unseen.
  return yield* poll.pipe(
    Effect.onInterrupt(() =>
      lastThread === undefined
        ? Effect.void
        : interruptStage(client, lastThread).pipe(
            Effect.andThen(Console.log(`\nStopped ${label}.`)),
            Effect.ignore,
          ),
    ),
  );
});

const lineUuid = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));

/** The checkout's T3 project, added on first use so a line runs in any repository. */
const ensureProject = Effect.fn("ensureProject")(function* (
  client: StageClient,
  mainCheckout: string,
) {
  const path = yield* Path.Path;
  const existing = yield* findProjectForCheckout(yield* client.shell, mainCheckout).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason === "project-not-found",
      () => Effect.succeedNone,
    ),
  );
  if (Option.isSome(existing)) return existing.value;

  yield* client.dispatch({
    type: "project.create",
    commandId: CommandId.make(yield* lineUuid),
    projectId: ProjectId.make(yield* lineUuid),
    title: path.basename(mainCheckout),
    workspaceRoot: mainCheckout,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
  yield* Console.log(`Added ${mainCheckout} as a T3 project.`);
  return yield* findProjectForCheckout(yield* client.shell, mainCheckout);
});

const printDiffSummary = (worktreePath: string, startCommit: string) =>
  Effect.gen(function* () {
    const stat = yield* git(worktreePath, ["diff", "--stat", startCommit]);
    const untracked = yield* git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
    yield* Console.log(stat.length > 0 ? stat : "No changes to tracked files.");
    if (untracked.length > 0) yield* Console.log(`New files:\n${untracked}`);
  }).pipe(Effect.ignore);

const lineRunCommand = Command.make("run", {
  ...projectLocationFlags,
  line: Argument.String("line").pipe(
    Argument.withDescription("Line name (see `t3 line list`) or path to a line file."),
  ),
  request: Argument.String("request").pipe(Argument.withDescription("What the line should do.")),
  project: Flag.String("project").pipe(
    Flag.withDescription("Any directory in the project's repository. Default: current directory."),
    Flag.optional,
  ),
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription("Run in this existing worktree instead of creating one."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Run a line on a new worktree, pausing between stages to review each handoff.",
  ),
  Command.withHandler((flags) =>
    withStageClient(flags, (client, config) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const line = yield* loadLine(config.baseDir, flags.line);
          const stages = line.definition.stages;
          const selections = yield* Effect.forEach(stages, (stage) =>
            parseModelSelection(stage.provider, stage.model),
          );
          const request = flags.request.trim();
          if (request.length === 0) {
            return yield* new StageCommandError({
              reason: "invalid-input",
              detail: "The request is empty.",
            });
          }

          const runId = (yield* lineUuid).slice(0, 8);
          const worktree = yield* Option.match(flags.worktree, {
            onSome: (existing) => resolveStageWorktree(existing),
            onNone: () =>
              Effect.gen(function* () {
                const { mainCheckout } = yield* resolveCheckout(
                  Option.getOrElse(flags.project, () => process.cwd()),
                );
                const dir = path.join(
                  linesDir(path, config.baseDir),
                  "worktrees",
                  `${path.basename(mainCheckout)}-${runId}`,
                );
                yield* fs.makeDirectory(path.dirname(dir), { recursive: true });
                yield* git(
                  mainCheckout,
                  ["worktree", "add", "-b", `lines/${runId}`, dir, "HEAD"],
                  `Could not create a worktree for ${mainCheckout}.`,
                );
                return yield* resolveStageWorktree(dir);
              }),
          });
          const project = yield* ensureProject(client, worktree.mainCheckout);

          const runDir = path.join(linesDir(path, config.baseDir), "runs", runId);
          yield* fs.makeDirectory(runDir, { recursive: true });
          const record: LineRunRecord = {
            id: runId,
            line: line.name,
            request,
            projectId: project.id,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            startCommit: worktree.headCommit,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            status: "running",
            stages: stages.map((stage) => ({
              ...stage,
              threadId: null,
              handoffFile: null,
              outcome: "pending" as const,
            })),
          };
          // Suspended so each save serializes the record as it is at that moment.
          const save = Effect.suspend(() =>
            fs.writeFileString(path.join(runDir, "run.json"), `${prettyJson(record)}\n`),
          );
          const progress = () =>
            renderLineProgress(
              stages,
              record.stages.map((stage) => stage.outcome),
            );
          const finish = (status: LineRunStatus) =>
            Effect.gen(function* () {
              record.status = status;
              yield* save;
              yield* Console.log(`\n${progress()}\n`);
              yield* Console.log(`Worktree: ${worktree.worktreePath}`);
              if (worktree.branch) yield* Console.log(`Branch:   ${worktree.branch}`);
              yield* Console.log(`Run:      ${runDir}\n`);
              yield* printDiffSummary(worktree.worktreePath, worktree.headCommit);
              if (status === "failed") process.exitCode = 1;
            });
          yield* save;

          yield* Console.log(`\n${line.name} · run ${runId} · ${worktree.worktreePath}\n`);
          yield* Console.log(`${progress()}\n`);
          const reader = yield* makeAnswerReader;
          const handoffFiles: Array<string> = [];

          for (const [index, stage] of stages.entries()) {
            const entry = record.stages[index]!;
            const inputs = yield* Effect.forEach(handoffFiles, (file) =>
              fs
                .readFileString(file)
                .pipe(Effect.map((text) => ({ name: path.basename(file), text }))),
            );
            const { threadId } = yield* startStage(client, {
              worktree,
              modelSelection: selections[index]!,
              runtimeMode: stage.mode,
              title: stageThreadTitle(request, stage.label),
              text: buildStagePrompt(
                lineStagePrompt(stage.prompt, request, {
                  worktreePath: worktree.worktreePath,
                  startCommit: worktree.headCommit,
                }),
                inputs,
              ),
            });
            entry.threadId = threadId;
            entry.outcome = "running";
            yield* save;

            const settled = yield* waitForStage(client, threadId, stage.label).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  entry.outcome = "interrupted";
                  record.status = "stopped";
                  yield* save.pipe(Effect.ignore);
                }),
              ),
            );
            if (settled.state !== "idle") {
              entry.outcome = settled.state;
              if (settled.thread.session?.lastError) {
                yield* Console.log(`  ${settled.thread.session.lastError}`);
              }
              return yield* finish(settled.state === "failed" ? "failed" : "stopped");
            }

            const handoff = yield* readStageHandoff(client, threadId);
            const handoffFile = path.join(runDir, handoffFileName(index, stage.label));
            yield* fs.writeFileString(handoffFile, `${handoff.text.trim()}\n`);
            handoffFiles.push(handoffFile);
            entry.handoffFile = handoffFile;
            entry.outcome = "done";
            yield* save;

            const lines = handoff.text.trim().split("\n");
            yield* Console.log(`\n── ${stage.label} handoff ──`);
            yield* Console.log(lines.slice(0, HANDOFF_PREVIEW_LINES).join("\n"));
            if (lines.length > HANDOFF_PREVIEW_LINES) {
              yield* Console.log(`… ${lines.length - HANDOFF_PREVIEW_LINES} more lines`);
            }
            yield* Console.log(`Saved to ${handoffFile}`);

            const next = stages[index + 1];
            if (next === undefined) break;
            yield* Console.log(`\n${progress()}\n`);
            while (true) {
              yield* Effect.sync(() =>
                process.stdout.write(
                  `Enter: start ${next.label} · e: edit the handoff · q: stop here › `,
                ),
              );
              const answer = (yield* reader.next).toLowerCase();
              // A terminal echoes the answer's newline; piped input does not.
              if (!process.stdin.isTTY) yield* Console.log("");
              if (answer === "") break;
              if (answer === "q") return yield* finish("stopped");
              if (answer === "e") {
                const status = yield* editFile(reader, handoffFile);
                if (status !== 0) yield* Console.log("The editor exited with an error.");
              }
            }
          }
          yield* finish("completed");
        }),
      ),
    ),
  ),
);

const lineListCommand = Command.make("list", { ...projectLocationFlags }).pipe(
  Command.withDescription("List available lines: files in <T3 home>/lines and built-in lines."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveLineConfig(flags);
      for (const name of yield* listLineNames(config.baseDir)) {
        const { definition } = yield* loadLine(config.baseDir, name);
        const labels = definition.stages.map((stage) => stage.label).join(" → ");
        yield* Console.log(
          `${name}  ${labels}${definition.description ? `  ${definition.description}` : ""}`,
        );
      }
    }),
  ),
);

const lineShowCommand = Command.make("show", {
  ...projectLocationFlags,
  line: Argument.String("line").pipe(Argument.withDescription("Line name or path.")),
}).pipe(
  Command.withDescription(
    "Print a line as JSON. Save it to <T3 home>/lines/<name>.json to make your own.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveLineConfig(flags);
      const { definition } = yield* loadLine(config.baseDir, flags.line);
      yield* Console.log(prettyJson(definition));
    }),
  ),
);

export const lineCommand = Command.make("line").pipe(
  Command.withDescription("Run lines of agent stages on a worktree from the terminal."),
  Command.withSubcommands([lineRunCommand, lineListCommand, lineShowCommand]),
);
