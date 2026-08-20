# repo-agent

An agentic CLI that explores a codebase, states a plan, and executes changes
step by step using Claude with tool use.

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

## Examples

Two real, unedited transcripts of the same task against the same bug:

- [`examples/sample-run.md`](examples/sample-run.md) — dry run. The agent
  finds the bug, proposes the correct fix, and when `write_file` is rejected
  by dry-run mode, explains that and asks for confirmation instead of trying
  to work around it.
- [`examples/sample-run-live.md`](examples/sample-run-live.md) — the same
  task with `--live`. The fix actually lands on disk and the agent verifies
  it by re-running the test suite itself.
