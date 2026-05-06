import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Adapter, AgentTurnInput, AgentTurnResult } from "./types.js";
import { formatElapsed } from "./progress.js";
import { printHeartbeat, printTool } from "../console.js";

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const HEARTBEAT_MS = 30_000;

export class ClaudeAdapter implements Adapter {
  readonly name = "claude";

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const chunks: string[] = [];
    let exitCode = 0;
    let toolCount = 0;
    const startTime = Date.now();
    let lastActivity = startTime;

    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity >= HEARTBEAT_MS) {
        const elapsed = formatElapsed(Date.now() - startTime);
        printHeartbeat("claude", elapsed, `still working… ${toolCount} tool call(s) so far`);
        lastActivity = Date.now();
      }
    }, HEARTBEAT_MS);

    try {
      const stream = query({
        prompt: input.prompt,
        options: {
          cwd: input.cwd,
          disallowedTools: input.mode === "read" ? WRITE_TOOLS : [],
          permissionMode: input.mode === "read" ? "default" : "acceptEdits",
        },
      });

      for await (const message of stream) {
        const m = message as { type: string; [k: string]: unknown };
        if (m.type === "assistant") {
          const content = (
            m as { message?: { content?: Array<Record<string, unknown>> } }
          ).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && typeof block.text === "string") {
                chunks.push(block.text);
                input.onStream?.(block.text);
                lastActivity = Date.now();
              } else if (block.type === "tool_use" && typeof block.name === "string") {
                toolCount++;
                const elapsed = formatElapsed(Date.now() - startTime);
                printTool("claude", elapsed, block.name, summarizeToolInput(block.input));
                lastActivity = Date.now();
              }
            }
          }
        } else if (m.type === "result") {
          const subtype = (m as { subtype?: string }).subtype;
          if (subtype && subtype !== "success") exitCode = 1;
        }
      }
    } catch (err) {
      exitCode = 1;
      const msg = err instanceof Error ? err.message : String(err);
      chunks.push(`[claude error: ${msg}]`);
    } finally {
      clearInterval(heartbeat);
    }

    return { output: chunks.join("\n\n").trim(), exitCode };
  }
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return i.file_path;
  if (typeof i.path === "string") return i.path;
  if (typeof i.pattern === "string") return JSON.stringify(i.pattern);
  if (typeof i.command === "string") return truncate(i.command, 72);
  if (typeof i.url === "string") return i.url;
  if (typeof i.query === "string") return JSON.stringify(i.query);
  return "";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
