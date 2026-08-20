# repo-agent

An agentic CLI that explores a codebase, states a plan, and executes changes
step by step using Claude with tool use.

## See it work

Real, unedited transcripts — not mocked output. Same task, same deliberate
bug (`average()` divides by `numbers.length - 1` instead of `numbers.length`),
run twice.

**Dry run** ([full transcript](examples/sample-run.md)) — finds the bug,
tries the fix, and respects the safety boundary when the write is rejected
instead of trying to work around it:

```
[reasoning]
Found the bug: `average()` divides by `numbers.length - 1` instead of `numbers.length`...

  -> calling write_file({"path":"math.js", ...})
  <- write_file result: [DRY RUN] Would write 232 chars to math.js. No changes made.

[reasoning]
The `write_file` call was rejected because the environment is in dry-run mode — no
changes were actually made to `math.js`. ... I don't have a way to disable dry-run
myself — that's an environment setting, not something within my tool permissions.
```

**Live run** ([full transcript](examples/sample-run-live.md)) — same
diagnosis, `--live` this time: the fix lands on disk for real and the agent
verifies it by re-running the test suite itself:

```
[reasoning]
Found the bug: `average()` divides by `numbers.length - 1` instead of `numbers.length`.
Fixing it now.

  -> calling write_file({"path":"math.js", ...})
  <- write_file result: Wrote 232 chars to math.js.
  -> calling run_command({"command":"npm","args":["test"]})
  <- run_command result: stdout:
> node test.js
All tests passed.
```

## Why this exists

To understand what actually happens inside an agent loop: how the model
decides which tool to call, how tool results feed back in, where the loop
can go wrong, and what guardrails matter once a model can touch a real
filesystem.

## How it works

1. You give it a task and a target repo path.
2. The agent explores the repo (`list_directory`, `read_file`) before touching
   anything.
3. It states an explicit, numbered plan.
4. It executes the plan step by step, calling `write_file` / `run_command` as
   needed, explaining its reasoning after each tool result.
5. Every step — reasoning text, tool calls, tool results — is printed live so
   the whole run is auditable, not just the final diff.

Runs in **dry-run mode by default**: file writes are logged but not actually
applied unless you pass `--live`. This was a deliberate design choice, not an
afterthought — an agent with filesystem access needs a safe default.

## Setup

```bash
npm install
cp .env.example .env
# add your ANTHROPIC_API_KEY to .env
```

## Usage

```bash
# Dry run (default) — shows the plan and would-be changes, writes nothing
npm run dev -- --repo ./some-target-repo --task "Add a missing test for the auth module"

# Live run — actually applies file writes
npm run dev -- --repo ./some-target-repo --task "Extract the email-sending logic into its own module" --live

# Cap the number of agent turns (default: 15)
npm run dev -- --repo ./some-target-repo --task "..." --max-steps 25
```

## Design notes / known limitations

- **Sandboxing**: all file tools resolve paths against the target repo root
  and reject anything that escapes it.
- **Command execution**: `run_command` only allows a small whitelist of
  binaries (`npm`, `npx`, `node`, `git`, `pytest`, `python3`) — not arbitrary
  shell execution.
- **No auto-commit**: the agent never runs `git commit` itself; it stops at
  writing files so a human reviews the diff before it's committed.
- **Step limit**: hard-capped via `--max-steps` to avoid runaway loops burning
  API credits on a stuck task.
- **What it doesn't do yet**: no cost/token tracking per run, no persistence
  of past runs, no web UI (a minimal React dashboard visualizing the
  reasoning trace is the planned v2).
