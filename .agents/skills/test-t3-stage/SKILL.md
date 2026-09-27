---
name: test-t3-stage
description: Smoke-test the `t3 stage` CLI end to end against an isolated dev server, with real providers on a throwaway repository. Use after changing apps/server/src/cli/stage.ts or stageModel.ts, or to check that stages still start, settle, hand off, and stop.
---

# Test `t3 stage`

Unit tests cover the rules (`vp test run apps/server/src/cli/stageModel.test.ts`).
This skill proves the commands work against a real server and real providers.
Never point anything at `~/.t3/userdata`.

## Start an isolated server

1. Seed the worktree's ignored `.t3` with a copy of real data, as described in
   AGENTS.md under Test data. Copy only; never open the live database read-write.
2. Start `vp run dev:server` from the worktree root in the background and
   capture its PID. The dev runner spawns `vp` by name, so if `vp` is not on
   `PATH`, prefix the command with `PATH="$PWD/node_modules/.bin:$PATH"`.
3. Wait for `Listening on` in its output. Pass `--base-dir "$PWD/.t3"` to every
   `t3` command so the CLI finds this server and never the user's install.

Run the CLI as `node apps/server/src/bin.ts stage …`.

## Make a throwaway project

Create a scratch repository outside the worktree (for example under `$TMPDIR`)
with one commit, add a git worktree of it, and register the main checkout with
`node apps/server/src/bin.ts project add <repo> --base-dir "$PWD/.t3"`.
Stages refuse the main checkout, so always pass the worktree.

## Smoke run

Use the cheapest model you have access to (for example `claudeAgent` with
`claude-haiku-4-5`) and `--mode full-access`, so no approval stalls the run.

1. `stage start --json` with a prompt that writes a known file and replies with
   one word. Keep the returned `stageId`.
2. Loop `stage status <id> --wait --timeout 100` while it exits 2.
3. Check it ends `idle` (exit 0), `stage output` prints the reply, and the file
   exists in the worktree.
4. Start a second stage on another provider (for example `codex`) with
   `--input` pointing at the first stage's saved output, asking it to edit the
   same file. Confirm it sees the first stage's change.

Exit codes: 0 idle, 1 failed, 2 running, 3 waiting on a human, 4 interrupted.

## `t3 line`

`t3 line run` is the attended front end over the same machinery. To smoke it:

1. Put a cheap test line in `.t3/lines/<name>.json` (copy the shape from
   `t3 line show design-implement-review`) with short prompts that write a file
   and reply with a known word, and a request that tells stages to follow them.
2. Create the run's worktree outside this repository (for example
   `git -C <repo> worktree add $TMPDIR/…`) and pass it with `--worktree`.
   Without that, `run` creates it under `.t3/lines/worktrees/`, inside this
   repository, where Claude loads this repo's CLAUDE.md and has written to
   this worktree instead of its own.
3. Run `node apps/server/src/bin.ts line run <name> "<request>" --worktree <path>`
   with answers piped on stdin: an empty line continues, `e` opens `$EDITOR`
   (point it at a script that edits the file in place), `q` stops. End of input
   also stops.
4. Check that an edited handoff reaches the next stage, `git status` in this
   repository stays clean, and `.t3/lines/runs/<id>/run.json` records each
   stage's outcome. SIGINT to the captured PID must leave the running
   stage `interrupted` on the server.

## When the change touches these paths

- Busy guard: a second `start` on a worktree with a running stage must fail.
- Approvals: a stage in `--mode approval-required` asked to run a shell command
  should report `waiting-approval` (exit 3) and must not have run it.
- Stop: `stage stop` on a running or waiting stage should end `interrupted`
  (exit 4), and `stage output` must then refuse.

## Clean up

Stop the dev server by the PID you captured, never by name. Delete the scratch
repository. Leave `.t3` in place unless the user asks otherwise.
