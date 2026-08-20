# Sample run — live mode

A companion to [`sample-run.md`](sample-run.md), which shows a dry run
stopping short of writing anything. This is the same task, same bug, run a
second time with `--live` against a fresh copy of the throwaway repo — real,
unedited transcript, and the fix actually lands on disk and makes the test
suite pass.

```
npm run dev -- --repo ./throwaway-repo --task "Find and fix the bug in the average() function in math.js so that npm test passes" --max-steps 6 --live
```

```
Repo:     ./throwaway-repo
Task:     Find and fix the bug in the average() function in math.js so that npm test passes
Mode:     LIVE
Max steps: 6
------------------------------------------------------------
```

## Step 1 — explore before touching anything

```
  -> calling list_directory({"path":"."})
  <- list_directory result: README.md
math.js
package.json
test.js

  -> calling read_file({"path":"math.js"})
  <- read_file result: // Simple math utilities.

function add(a, b) {
  return a + b;
}

function average(numbers) {
  let total = 0;
  for (const n of numbers) {
    total += n;
  }
  return total / (numbers.length - 1);
}

module.exports = { add, average };

  -> calling read_file({"path":"test.js"})
  <- read_file result: const assert = require("assert");
const { add, average } = require("./math.js");

assert.strictEqual(add(2, 3), 5, "add(2, 3) should be 5");
assert.strictEqual(average([2, 4, 6]), 4, "average([2, 4, 6]) should be 4");

console.log("All tests passed.");

  -> calling read_file({"path":"package.json"})
  <- read_file result: {
  "name": "throwaway-repo",
  "version": "1.0.0",
  "description": "Minimal scratch repo for smoke-testing repo-agent's tool-calling loop.",
  "main": "math.js",
  "scripts": {
    "test": "node test.js"
  }
}
```

## Step 2 — diagnoses the bug and writes the fix for real

```
[reasoning]
Found the bug: `average()` divides by `numbers.length - 1` instead of `numbers.length`.
Fixing it now.

  -> calling write_file({"path":"math.js","content":"// Simple math utilities.\n\nfunction add(a, b) {\n  return a + b;\n}\n\nfunction average(numbers) {\n  let total = 0;\n  for (const n of numbers) {\n    total += n;\n  }\n  return total / numbers.length;\n}\n\nmodule.exports = { add, average };\n"})
  <- write_file result: Wrote 232 chars to math.js.
```

No dry-run message this time — `--live` was passed, so `executeTool()` took the
real write branch instead of the logged/rejected one, and the file on disk
actually changed.

## Step 3 — verifies against the real test suite

```
  -> calling run_command({"command":"npm","args":["test"]})
  <- run_command result: stdout:

> throwaway-repo@1.0.0 test
> node test.js

All tests passed.

stderr:


[reasoning]
Test passes now. The fix was a one-line change in `average()`: it was dividing the
sum by `numbers.length - 1` (an off-by-one error) instead of `numbers.length`, which
gave `12/2=6` instead of `12/3=4` for `[2,4,6]`. Corrected to `total / numbers.length`.

------------------------------------------------------------
Done. 14 steps recorded.
```

Confirmed independently after the run — the file on disk really did change, and
running the test suite outside the agent entirely still passes:

```
$ grep "numbers.length" throwaway-repo/math.js
  return total / numbers.length;

$ node throwaway-repo/test.js
All tests passed.
```

## What this adds beyond the dry-run example

`sample-run.md` shows the agent correctly *stopping* at a safety boundary.
This one shows the same reasoning carried all the way through to a verified,
working fix — same diagnosis, same plan, but with `--live` the write actually
lands and the agent closes the loop by re-running the test suite itself
rather than just claiming success.
