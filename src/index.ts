import "dotenv/config";
import path from "path";
import { runAgent } from "./agent.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : fallback;
  };

  const repoRoot = get("--repo");
  const task = get("--task");
  const dryRun = !args.includes("--live"); // safe by default: dry-run unless --live is passed
  const maxSteps = parseInt(get("--max-steps", "15")!, 10);

  if (!repoRoot || !task) {
    console.error(
      "Usage: npm run dev -- --repo <path> --task \"<description>\" [--live] [--max-steps N]\n" +
        "  --live       actually write files (default: dry-run, no changes made)\n" +
        "  --max-steps  hard cap on agent turns (default: 15)"
    );
    process.exit(1);
  }

  return { repoRoot: path.resolve(repoRoot), task, dryRun, maxSteps };
}

async function main() {
  const { repoRoot, task, dryRun, maxSteps } = parseArgs();

  console.log(`\nRepo:     ${repoRoot}`);
  console.log(`Task:     ${task}`);
  console.log(`Mode:     ${dryRun ? "DRY RUN (no files will be changed)" : "LIVE"}`);
  console.log(`Max steps: ${maxSteps}\n${"-".repeat(60)}\n`);

  const trace = await runAgent({
    task,
    repoRoot,
    dryRun,
    maxSteps,
    onStep: (step) => {
      if (step.type === "text") {
        console.log(`\n[reasoning]\n${step.content}\n`);
      } else if (step.type === "tool_call") {
        console.log(`  -> calling ${step.toolName}(${step.content})`);
      } else if (step.type === "tool_result") {
        const preview =
          step.content.length > 300 ? step.content.slice(0, 300) + "..." : step.content;
        console.log(`  <- ${step.toolName} result: ${preview}`);
      }
    },
  });

  console.log(`\n${"-".repeat(60)}\nDone. ${trace.length} steps recorded.`);
}

main().catch((err) => {
  console.error("Agent run failed:", err);
  process.exit(1);
});
