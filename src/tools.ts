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
      "Run a whitelisted shell command (e.g. test runner) inside the repo root. Not arbitrary shell execution — only whitelisted binaries are allowed.",
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

export interface ToolExecutionOptions {
  dryRun: boolean;
  onWrite?: (relPath: string, content: string) => void;
}

export async function executeTool(
  name: string,
  input: any,
  sandbox: Sandbox,
  opts: ToolExecutionOptions
): Promise<string> {
  switch (name) {
    case "list_directory": {
      const dir = sandbox.resolve(input.path);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join("\n");
    }

    case "read_file": {
      const filePath = sandbox.resolve(input.path);
      return await fs.readFile(filePath, "utf-8");
    }

    case "write_file": {
      if (opts.dryRun) {
        opts.onWrite?.(input.path, input.content);
        return `[DRY RUN] Would write ${input.content.length} chars to ${input.path}. No changes made.`;
      }
      const filePath = sandbox.resolve(input.path);
      await fs.writeFile(filePath, input.content, "utf-8");
      opts.onWrite?.(input.path, input.content);
      return `Wrote ${input.content.length} chars to ${input.path}.`;
    }

    case "run_command": {
      if (!ALLOWED_COMMANDS.has(input.command)) {
        return `Command '${input.command}' is not in the allowed list (${[...ALLOWED_COMMANDS].join(", ")}). Refused.`;
      }
      try {
        const { stdout, stderr } = await execFileAsync(input.command, input.args, {
          cwd: sandbox.resolve("."),
          timeout: 30_000,
        });
        return `stdout:\n${stdout}\nstderr:\n${stderr}`;
      } catch (err: any) {
        return `Command failed: ${err.message}\nstdout:\n${err.stdout ?? ""}\nstderr:\n${err.stderr ?? ""}`;
      }
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
