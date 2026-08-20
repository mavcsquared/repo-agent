import Anthropic from "@anthropic-ai/sdk";
import { Sandbox, toolSchemas, executeTool } from "./tools.js";

const SYSTEM_PROMPT = `You are a careful senior software engineer agent working inside a sandboxed repository.

Your job, given a task, is to:
1. Explore the repo structure first (list_directory, read_file) before proposing any change.
2. State a short, explicit plan before you start writing files. Number the steps.
3. Execute the plan one step at a time, using tools. After each tool result, briefly say what you learned or what changed before moving to the next step.
4. Prefer small, reviewable changes over large rewrites.
5. If something is ambiguous or risky, say so explicitly instead of guessing silently.

You are in a review workflow — a human will read your plan and your reasoning trace, not just the final diff. Explain your reasoning, not just your actions.`;

export interface AgentStep {
  type: "text" | "tool_call" | "tool_result";
  content: string;
  toolName?: string;
}

export interface AgentRunOptions {
  task: string;
  repoRoot: string;
  dryRun: boolean;
  maxSteps: number;
  onStep?: (step: AgentStep) => void;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentStep[]> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  const sandbox = new Sandbox(opts.repoRoot);
  const trace: AgentStep[] = [];

  const emit = (step: AgentStep) => {
    trace.push(step);
    opts.onStep?.(step);
  };

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.task },
  ];

  let stepCount = 0;

  while (stepCount < opts.maxSteps) {
    stepCount++;

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: toolSchemas,
      messages,
    });

    // Log any text reasoning the model produced this turn.
    const textBlocks = response.content.filter((b) => b.type === "text");
    for (const block of textBlocks) {
      if (block.type === "text" && block.text.trim()) {
        emit({ type: "text", content: block.text });
      }
    }

    const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

    // No tool calls means the model is done (or is stuck) — stop.
    if (toolUseBlocks.length === 0) {
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      if (block.type !== "tool_use") continue;

      emit({
        type: "tool_call",
        toolName: block.name,
        content: JSON.stringify(block.input),
      });

      const result = await executeTool(block.name, block.input, sandbox, {
        dryRun: opts.dryRun,
      });

      emit({ type: "tool_result", toolName: block.name, content: result });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });

    if (response.stop_reason === "end_turn") {
      break;
    }
  }

  if (stepCount >= opts.maxSteps) {
    emit({
      type: "text",
      content: `[Stopped: reached max step limit of ${opts.maxSteps}. Increase --max-steps if this task needs more turns.]`,
    });
  }

  return trace;
}
