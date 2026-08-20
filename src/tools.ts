import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * All filesystem tools are sandboxed to a single root directory (the target
 * repo). Every path the model gives us is resolved against that root and
 * checked to make sure it doesn't escape it — an agent that can read/write
 * arbitrary paths on the host is not something you want running with a
 * model-generated plan.
 */
export class Sandbox {
  constructor(private readonly root: string) {}

  resolve(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(
        `Path escapes sandbox root: ${relativePath} -> ${resolved}`
      );
    }
    return resolved;
  }
}

// Anthropic tool schemas — this is what gets sent in the `tools` param.
export const toolSchemas = [
  {
    name: "list_directory",
    description:
      "List files and subdirectories at a given path relative to the repo root.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path from repo root. Use '.' for root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a text file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path from repo root." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file, overwriting it if it exists. Requires dry_run mode to be off, or the call will be logged and rejected.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative path from repo root." },
        content: { type: "string", description: "Full new file contents." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a whitelisted shell command (e.g. test runner) inside the repo root. Not arbitrary shell execution — only whitelisted binaries are allowed, and some of them are further restricted: git is read-only (status/diff/log/show/branch/ls-files/rev-parse — no commit, push, reset, clean, or checkout), npm blocks registry/credential subcommands (no publish/owner/token/login), and npx/node/python3 block their inline code-execution flags (-c/-e/-p/--eval/--print).",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "Binary to run, e.g. 'npm', 'pytest'." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Arguments to pass to the command.",
        },
      },
      required: ["command", "args"],
    },
  },
];

const ALLOWED_COMMANDS = new Set(["npm", "npx", "node", "pytest", "python3", "git"]);

/**
 * Being in ALLOWED_COMMANDS only means the binary itself is trusted — several
 * of these binaries have subcommands or flags that are as dangerous as
 * unrestricted shell (git push/reset/clean, npx running an arbitrary
 * package, node/python's inline-eval flags). A per-command policy narrows
 * what's actually allowed once the binary check passes.
 *
 * - `allowedSubcommands`: if set, args[0] must be one of these.
 * - `blockedFlags`: if set, refuse the call if any arg is one of these,
 *   regardless of position (covers inline code-execution flags).
 */
interface CommandPolicy {
  allowedSubcommands?: Set<string>;
  blockedFlags?: Set<string>;
}

const COMMAND_POLICIES: Partial<Record<string, CommandPolicy>> = {
  git: {
    // Read-only / inspection only. No commit, push, reset, clean, checkout,
    // rebase, merge, or anything else that mutates history or the working
    // tree — the agent's job is to propose changes via write_file, not to
    // manage git state itself.
    allowedSubcommands: new Set([
      "status",
      "diff",
      "log",
      "show",
      "branch",
      "ls-files",
      "rev-parse",
    ]),
  },
  npm: {
    // No publish/owner/token/access/login/adduser/deprecate — nothing that
    // touches the registry or credentials.
    allowedSubcommands: new Set([
      "test",
      "run",
      "run-script",
      "install",
      "ci",
      "list",
      "ls",
      "outdated",
      "audit",
    ]),
  },
  npx: {
    // npx's whole job is "fetch and run a package" — that's already close to
    // arbitrary code execution. At minimum, block its own inline-eval flags.
    blockedFlags: new Set(["-c", "--call"]),
  },
  node: {
    // -e/-p/--eval/--print run a string as code directly — no file, no
    // sandbox visibility into what actually ran.
    blockedFlags: new Set(["-e", "--eval", "-p", "--print"]),
  },
  python3: {
    blockedFlags: new Set(["-c"]),
  },
};

export interface ToolExecutionOptions {
  dryRun: boolean;
  onWrite?: (relPath: string, content: string) => void;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * Never rejects. Every failure mode a tool can hit — a path that escapes the
 * sandbox, a missing file, a refused command — is reported back as a normal
 * ToolResult with isError: true, the same way the Anthropic API expects a
 * failed tool_result to look. That's what lets the model see its own
 * mistake and recover (try a different path, ask for clarification) instead
 * of one bad tool call crashing the entire multi-step run.
 */
export async function executeTool(
  name: string,
  input: any,
  sandbox: Sandbox,
  opts: ToolExecutionOptions
): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_directory": {
        const dir = sandbox.resolve(input.path);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return {
          content: entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .join("\n"),
        };
      }

      case "read_file": {
        const filePath = sandbox.resolve(input.path);
        return { content: await fs.readFile(filePath, "utf-8") };
      }

      case "write_file": {
        // Validate the path even in dry-run — a preview that skips this
        // would silently accept a path-escape attempt and report it as a
        // harmless would-be write, only to actually fail once --live is
        // passed. Resolving first keeps dry-run and live behavior in sync.
        const filePath = sandbox.resolve(input.path);
        if (opts.dryRun) {
          opts.onWrite?.(input.path, input.content);
          return {
            content: `[DRY RUN] Would write ${input.content.length} chars to ${input.path}. No changes made.`,
          };
        }
        await fs.writeFile(filePath, input.content, "utf-8");
        opts.onWrite?.(input.path, input.content);
        return { content: `Wrote ${input.content.length} chars to ${input.path}.` };
      }

      case "run_command": {
        if (!ALLOWED_COMMANDS.has(input.command)) {
          return {
            content: `Command '${input.command}' is not in the allowed list (${[...ALLOWED_COMMANDS].join(", ")}). Refused.`,
            isError: true,
          };
        }

        const args: string[] = input.args ?? [];
        const policy = COMMAND_POLICIES[input.command];

        if (policy?.allowedSubcommands) {
          const subcommand = args[0];
          if (!subcommand || !policy.allowedSubcommands.has(subcommand)) {
            return {
              content: `Subcommand '${subcommand ?? "(none)"}' is not allowed for '${input.command}'. Allowed: ${[...policy.allowedSubcommands].join(", ")}. Refused.`,
              isError: true,
            };
          }
        }

        if (policy?.blockedFlags) {
          const blocked = args.find((a) => policy.blockedFlags!.has(a));
          if (blocked) {
            return {
              content: `Flag '${blocked}' is not allowed for '${input.command}' (inline code execution is blocked). Refused.`,
              isError: true,
            };
          }
        }

        try {
          const { stdout, stderr } = await execFileAsync(input.command, args, {
            cwd: sandbox.resolve("."),
            timeout: 30_000,
          });
          return { content: `stdout:\n${stdout}\nstderr:\n${stderr}` };
        } catch (err: any) {
          return {
            content: `Command failed: ${err.message}\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? ""}`,
            isError: true,
          };
        }
      }

      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err: any) {
    // Catches everything an individual case doesn't already handle itself —
    // Sandbox.resolve() rejecting a path-escape attempt, ENOENT/EACCES from
    // fs calls, malformed input, etc.
    return { content: `Error: ${err.message}`, isError: true };
  }
}
