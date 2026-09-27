/**
 * `t3 stage` - run one agent stage on a worktree through a running T3 server.
 *
 * A stage is an ordinary thread: `start` creates it and sends the first turn,
 * and every other subcommand reads it back from the server by id. Commands
 * never prompt and never block longer than `--timeout`, so scripts and agents
 * drive them the same way people do. Approvals, questions, and reading the
 * conversation happen in the T3 app. Rules live in `stageModel.ts`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import {
  AuthAdministrativeScopes,
  type ClientOrchestrationCommand,
  CommandId,
  EnvironmentHttpApi,
  MessageId,
  type ModelSelection,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  buildStagePrompt,
  deriveStageState,
  selectStageHandoff,
  stageAcceptsTurns,
  stageIsBusy,
  type StageState,
  stageStateExitCode,
  stageThreadTitle,
} from "./stageModel.ts";

export class StageCommandError extends Schema.TaggedError<StageCommandError>()(
  "StageCommandError",
  {
    reason: Schema.Literals([
      "no-server",
      "server-request",
      "not-a-worktree",
      "main-checkout",
      "project-not-found",
      "worktree-busy",
      "stage-not-found",
      "stage-not-ready",
      "no-handoff",
      "invalid-input",
    ]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const STAGE_REQUEST_TIMEOUT = Duration.seconds(15);
export const STAGE_POLL_INTERVAL = Duration.seconds(2);

const decodeProviderInstanceId = Schema.decodeEffect(ProviderInstanceId);
const stageUuid = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

// ---------------------------------------------------------------------------
// Server access

const makeStageClient = (origin: string, token: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
    const headers = { authorization: `Bearer ${token}` };
    const request = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.timeout(STAGE_REQUEST_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new StageCommandError({
              reason: "server-request",
              detail: `Request to the T3 server at ${origin} failed.`,
              cause,
            }),
        ),
      );
    return {
      // The shell is the only read that carries pending approvals and background work.
      shell: request(client.orchestration.shellSnapshot({ headers })),
      thread: (threadId: ThreadId) =>
        request(
          client.orchestration.threadSnapshot({ params: { threadId }, headers, payload: {} }),
        ),
      // Same cast as `t3 project`: the generated client cannot relate the command union to its overloads.
      dispatch: (command: ClientOrchestrationCommand) =>
        request(
          client.orchestration.dispatch({ headers, payload: command } as Parameters<
            typeof client.orchestration.dispatch
          >[0]),
        ),
    };
  });

export type StageClient = Effect.Success<ReturnType<typeof makeStageClient>>;
type StageCliConfig = Effect.Success<ReturnType<typeof resolveCliAuthConfig>>;

/** Runs against the server that owns `--base-dir`, with a session revoked on exit. */
export const withStageClient = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (client: StageClient, config: StageCliConfig) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.gen(function* () {
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* new StageCommandError({
          reason: "no-server",
          detail: `No running T3 server found for ${config.baseDir}. Start one, or pass --base-dir.`,
        });
      }
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 stage cli" }),
        (issued) =>
          makeStageClient(runtimeState.value.origin, issued.token).pipe(
            Effect.flatMap((client) => run(client, config)),
          ),
        (issued) =>
          environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const findStage = (shell: OrchestrationShellSnapshot, stageId: string) => {
  const thread = shell.threads.find((candidate) => candidate.id === stageId);
  return thread === undefined
    ? Effect.fail(
        new StageCommandError({ reason: "stage-not-found", detail: `No stage ${stageId}.` }),
      )
    : Effect.succeed(thread);
};

export const readStage = (client: StageClient, stageId: string) =>
  Effect.gen(function* () {
    const thread = yield* findStage(yield* client.shell, stageId);
    return { thread, state: deriveStageState(thread, yield* nowIso) };
  });

// ---------------------------------------------------------------------------
// Worktree resolution

export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  failure = `${cwd} is not inside a git repository.`,
) =>
  Effect.try({
    try: () =>
      NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    catch: (cause) => new StageCommandError({ reason: "not-a-worktree", detail: failure, cause }),
  });

const realPathOr = (fs: FileSystem.FileSystem, path: string) =>
  fs.realPath(path).pipe(Effect.orElseSucceed(() => path));

/** The checkout containing `input` and the main checkout its repository belongs to. */
export const resolveCheckout = Effect.fn("resolveCheckout")(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = path.resolve(input);
  const worktreePath = yield* realPathOr(fs, yield* git(cwd, ["rev-parse", "--show-toplevel"]));
  const commonDir = yield* git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return { worktreePath, mainCheckout: yield* realPathOr(fs, path.dirname(commonDir)) };
});

export const resolveStageWorktree = Effect.fn("resolveStageWorktree")(function* (input: string) {
  const { worktreePath, mainCheckout } = yield* resolveCheckout(input);
  if (worktreePath === mainCheckout) {
    return yield* new StageCommandError({
      reason: "main-checkout",
      detail: `${worktreePath} is the project's main checkout. Stages run in a git worktree.`,
    });
  }
  const branch = yield* git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    worktreePath,
    mainCheckout,
    branch: branch === "HEAD" ? null : branch,
    headCommit: yield* git(worktreePath, ["rev-parse", "HEAD"]),
  };
});

export type StageWorktree = Effect.Success<ReturnType<typeof resolveStageWorktree>>;

export const findProjectForCheckout = Effect.fn("findProjectForCheckout")(function* (
  shell: OrchestrationShellSnapshot,
  mainCheckout: string,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const project of shell.projects) {
    if ((yield* realPathOr(fs, project.workspaceRoot)) === mainCheckout) return project;
  }
  return yield* new StageCommandError({
    reason: "project-not-found",
    detail: `No T3 project for ${mainCheckout}. Add it with \`t3 project add ${mainCheckout}\`.`,
  });
});

/** Two stages writing one worktree at once would interleave edits, so any busy thread there blocks. */
const findBusyThreadOnWorktree = Effect.fn("findBusyThreadOnWorktree")(function* (
  shell: OrchestrationShellSnapshot,
  worktreePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* nowIso;
  for (const thread of shell.threads) {
    if (thread.archivedAt !== null || thread.worktreePath === null) continue;
    if (!stageIsBusy(deriveStageState(thread, now))) continue;
    if ((yield* realPathOr(fs, thread.worktreePath)) === worktreePath) return Option.some(thread);
  }
  return Option.none<OrchestrationThreadShell>();
});

// ---------------------------------------------------------------------------
// Stage operations, shared with `t3 line`

export const parseModelSelection = (provider: string, model: string) =>
  decodeProviderInstanceId(provider).pipe(
    Effect.map((instanceId): ModelSelection => ({ instanceId, model })),
    Effect.mapError(
      (cause) =>
        new StageCommandError({
          reason: "invalid-input",
          detail: `'${provider}' is not a provider instance id.`,
          cause,
        }),
    ),
  );

/** Creates the stage's thread on the worktree and sends its first turn. */
export const startStage = Effect.fn("startStage")(function* (
  client: StageClient,
  input: {
    readonly worktree: StageWorktree;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly title: string;
    readonly text: string;
  },
) {
  const { worktree } = input;
  const shell = yield* client.shell;
  const project = yield* findProjectForCheckout(shell, worktree.mainCheckout);
  const busy = yield* findBusyThreadOnWorktree(shell, worktree.worktreePath);
  if (Option.isSome(busy)) {
    return yield* new StageCommandError({
      reason: "worktree-busy",
      detail: `Thread ${busy.value.id} (${busy.value.title}) is still working in ${worktree.worktreePath}.`,
    });
  }

  const threadId = ThreadId.make(yield* stageUuid);
  const createdAt = yield* nowIso;
  const common = {
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: "default" as const,
  };
  yield* client.dispatch({
    type: "thread.create",
    commandId: CommandId.make(yield* stageUuid),
    threadId,
    projectId: ProjectId.make(project.id),
    title: input.title,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    createdAt,
    ...common,
  });
  yield* client.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(yield* stageUuid),
    threadId,
    message: {
      messageId: MessageId.make(yield* stageUuid),
      role: "user",
      text: input.text,
      attachments: [],
    },
    createdAt,
    ...common,
  });
  return { threadId, projectId: project.id };
});

/** The handoff of an idle stage. Refused while the stage could still change it. */
export const readStageHandoff = Effect.fn("readStageHandoff")(function* (
  client: StageClient,
  stageId: string,
) {
  const { thread, state } = yield* readStage(client, stageId);
  if (state !== "idle") {
    return yield* new StageCommandError({
      reason: "stage-not-ready",
      detail: `Stage ${thread.id} is ${state}; its output is only final once it is idle.`,
    });
  }
  const handoff = selectStageHandoff((yield* client.thread(thread.id)).thread);
  if (handoff === null) {
    return yield* new StageCommandError({
      reason: "no-handoff",
      detail: `Stage ${thread.id} has no assistant reply yet.`,
    });
  }
  return handoff;
});

export const interruptStage = (client: StageClient, thread: OrchestrationThreadShell) =>
  Effect.gen(function* () {
    yield* client.dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(yield* stageUuid),
      threadId: thread.id,
      ...(thread.latestTurn ? { turnId: thread.latestTurn.turnId } : {}),
      createdAt: yield* nowIso,
    });
  });

// ---------------------------------------------------------------------------
// Output

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON."),
  Flag.withDefault(false),
);

export const prettyJson = (value: unknown) => JSON.stringify(value, null, 2);
const printJson = (value: unknown) => Console.log(prettyJson(value));

const stageSummary = (thread: OrchestrationThreadShell, state: StageState) => ({
  stageId: thread.id,
  state,
  title: thread.title,
  provider: thread.modelSelection.instanceId,
  model: thread.modelSelection.model,
  worktreePath: thread.worktreePath,
  branch: thread.branch,
  ...(state === "failed" && thread.session?.lastError ? { error: thread.session.lastError } : {}),
});

const stateHints: Partial<Record<StageState, string>> = {
  "waiting-approval": "Respond to the approval in the T3 app.",
  "waiting-input": "Answer the question in the T3 app.",
};

const stageIdArgument = Argument.String("stage").pipe(
  Argument.withDescription("Stage id, as printed by `t3 stage start`."),
);

// ---------------------------------------------------------------------------
// Commands

const stageStartCommand = Command.make("start", {
  ...projectLocationFlags,
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription("Git worktree the stage runs in. Never the project's main checkout."),
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id, for example claudeAgent or codex."),
  ),
  model: Flag.String("model").pipe(Flag.withDescription("Model slug for that provider.")),
  mode: Flag.Literals("mode", [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ]).pipe(Flag.withDescription("Runtime mode. Required so full access is never an accident.")),
  promptFile: Flag.String("prompt-file").pipe(
    Flag.withDescription("File with the stage's instructions and the request."),
  ),
  input: Flag.String("input").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Earlier handoff file, appended in order. Repeatable."),
  ),
  label: Flag.String("label").pipe(
    Flag.withDescription("Short stage name for the thread title, for example Design."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a stage and return its id without waiting for it."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prompt = yield* fs.readFileString(flags.promptFile);
      if (prompt.trim().length === 0) {
        return yield* new StageCommandError({
          reason: "invalid-input",
          detail: `Prompt file ${flags.promptFile} is empty.`,
        });
      }
      const inputs = yield* Effect.forEach(flags.input, (file) =>
        fs.readFileString(file).pipe(Effect.map((text) => ({ name: path.basename(file), text }))),
      );
      const modelSelection = yield* parseModelSelection(flags.provider, flags.model);
      const worktree = yield* resolveStageWorktree(flags.worktree);

      return yield* withStageClient(flags, (client) =>
        Effect.gen(function* () {
          const { threadId, projectId } = yield* startStage(client, {
            worktree,
            modelSelection,
            runtimeMode: flags.mode,
            title: stageThreadTitle(prompt, Option.getOrUndefined(flags.label)),
            text: buildStagePrompt(prompt, inputs),
          });
          if (!flags.json) return yield* Console.log(threadId);
          yield* printJson({
            stageId: threadId,
            projectId,
            worktreePath: worktree.worktreePath,
            branch: worktree.branch,
            startCommit: worktree.headCommit,
            provider: modelSelection.instanceId,
            model: modelSelection.model,
          });
        }),
      );
    }),
  ),
);

const stageStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  stage: stageIdArgument,
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Wait while the stage is working, until its state changes."),
    Flag.withDefault(false),
  ),
  timeout: Flag.Int("timeout").pipe(
    Flag.withDescription("Seconds --wait may block before returning the current state."),
    Flag.withDefault(300),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Print a stage's state. Exit codes: 0 idle, 1 failed, 2 running, 3 waiting on you, 4 interrupted.",
  ),
  Command.withHandler((flags) =>
    withStageClient(flags, (client) =>
      Effect.gen(function* () {
        const initial = yield* readStage(client, flags.stage);
        const settled =
          flags.wait && stageIsBusy(initial.state)
            ? yield* readStage(client, flags.stage).pipe(
                Effect.delay(STAGE_POLL_INTERVAL),
                Effect.repeat({ until: (current) => current.state !== initial.state }),
                Effect.timeoutOption(Duration.seconds(flags.timeout)),
                Effect.map(Option.getOrElse(() => initial)),
              )
            : initial;
        process.exitCode = stageStateExitCode[settled.state];
        if (flags.json) return yield* printJson(stageSummary(settled.thread, settled.state));
        const detail =
          settled.state === "failed"
            ? settled.thread.session?.lastError
            : stateHints[settled.state];
        yield* Console.log(detail ? `${settled.state}: ${detail}` : settled.state);
      }),
    ),
  ),
);

const stageOutputCommand = Command.make("output", {
  ...projectLocationFlags,
  stage: stageIdArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print an idle stage's handoff: its latest assistant reply."),
  Command.withHandler((flags) =>
    withStageClient(flags, (client) =>
      Effect.gen(function* () {
        const handoff = yield* readStageHandoff(client, flags.stage);
        if (flags.json) return yield* printJson({ stageId: flags.stage, ...handoff });
        yield* Console.log(handoff.text);
      }),
    ),
  ),
);

const stageSendCommand = Command.make("send", {
  ...projectLocationFlags,
  stage: stageIdArgument,
  message: Argument.String("message").pipe(Argument.withDescription("Follow-up message.")),
}).pipe(
  Command.withDescription("Send a follow-up turn to a stage that is not working."),
  Command.withHandler((flags) =>
    withStageClient(flags, (client) =>
      Effect.gen(function* () {
        const { thread, state } = yield* readStage(client, flags.stage);
        if (!stageAcceptsTurns(state)) {
          return yield* new StageCommandError({
            reason: "stage-not-ready",
            detail: `Stage ${thread.id} is ${state}; wait until it is idle.`,
          });
        }
        yield* client.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* stageUuid),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(yield* stageUuid),
            role: "user",
            text: flags.message,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: yield* nowIso,
        });
        yield* Console.log(`Sent to ${thread.id}.`);
      }),
    ),
  ),
);

const stageStopCommand = Command.make("stop", {
  ...projectLocationFlags,
  stage: stageIdArgument,
}).pipe(
  Command.withDescription("Interrupt a stage's running turn."),
  Command.withHandler((flags) =>
    withStageClient(flags, (client) =>
      Effect.gen(function* () {
        const { thread, state } = yield* readStage(client, flags.stage);
        if (!stageIsBusy(state)) return yield* Console.log(`Stage ${thread.id} is ${state}.`);
        yield* interruptStage(client, thread);
        yield* Console.log(`Stopping ${thread.id}.`);
      }),
    ),
  ),
);

export const stageCommand = Command.make("stage").pipe(
  Command.withDescription("Run agent stages on a worktree through a running T3 server."),
  Command.withSubcommands([
    stageStartCommand,
    stageStatusCommand,
    stageOutputCommand,
    stageSendCommand,
    stageStopCommand,
  ]),
);
