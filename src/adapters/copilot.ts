import { spawn } from "node:child_process";
import type { Adapter, AgentTurnInput, AgentTurnResult } from "./types.js";
import { formatElapsed } from "./progress.js";
import { printHeartbeat } from "../console.js";

const HEARTBEAT_MS = 30_000;

export interface CopilotAdapterOptions {
  squad?: boolean;
  yolo?: boolean;
  binary?: string;
  extraArgs?: string[];
}

export class CopilotAdapter implements Adapter {
  readonly name = "copilot";

  constructor(private readonly opts: CopilotAdapterOptions = {}) {}

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const args: string[] = [];
    if (this.opts.squad) args.push("--agent", "squad");
    if (this.opts.yolo) args.push("--yolo");
    if (input.mode === "read") {
      args.push("--deny-tool", "write");
    } else {
      args.push("--allow-all-tools");
    }
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    // Prompt is delivered via stdin to avoid Windows shell quoting issues.

    const binary = this.opts.binary ?? "copilot";
    const startTime = Date.now();
    let lastActivity = startTime;

    return new Promise<AgentTurnResult>((resolve) => {
      const child = spawn(binary, args, {
        cwd: input.cwd,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin.write(input.prompt);
      child.stdin.end();

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const heartbeat = setInterval(() => {
        if (Date.now() - lastActivity >= HEARTBEAT_MS) {
          const elapsed = formatElapsed(Date.now() - startTime);
          printHeartbeat("copilot", elapsed, "still working… (no output yet)");
          lastActivity = Date.now();
        }
      }, HEARTBEAT_MS);

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdoutChunks.push(text);
        lastActivity = Date.now();
        input.onStream?.(text);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrChunks.push(data.toString());
        lastActivity = Date.now();
      });

      child.on("error", (err) => {
        clearInterval(heartbeat);
        resolve({ output: `[copilot spawn error: ${err.message}]`, exitCode: 1 });
      });

      child.on("close", (code) => {
        clearInterval(heartbeat);
        const stdout = stdoutChunks.join("").trim();
        const stderr = stderrChunks.join("").trim();
        resolve({ output: stdout || stderr, exitCode: code ?? 0 });
      });
    });
  }
}
