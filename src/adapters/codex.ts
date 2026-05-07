import spawn from "cross-spawn";
import type { Adapter, AgentTurnInput, AgentTurnResult } from "./types.js";
import { formatElapsed } from "./progress.js";
import { printHeartbeat } from "../console.js";

const HEARTBEAT_MS = 30_000;

export interface CodexAdapterOptions {
  binary?: string;
  extraArgs?: string[];
}

export class CodexAdapter implements Adapter {
  readonly name = "codex";

  constructor(private readonly opts: CodexAdapterOptions = {}) {}

  async run(input: AgentTurnInput): Promise<AgentTurnResult> {
    const args: string[] = ["exec", "--ask-for-approval", "never"];
    if (input.mode === "read") {
      args.push("--sandbox", "read-only");
    } else {
      args.push("--sandbox", "workspace-write");
    }
    if (this.opts.extraArgs) args.push(...this.opts.extraArgs);
    args.push("-"); // read prompt from stdin

    const binary = this.opts.binary ?? "codex";
    const startTime = Date.now();
    let lastActivity = startTime;

    return new Promise<AgentTurnResult>((resolve) => {
      const child = spawn(binary, args, {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin!.write(input.prompt);
      child.stdin!.end();

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const heartbeat = setInterval(() => {
        if (Date.now() - lastActivity >= HEARTBEAT_MS) {
          const elapsed = formatElapsed(Date.now() - startTime);
          printHeartbeat("codex", elapsed, "still working… (no output yet)");
          lastActivity = Date.now();
        }
      }, HEARTBEAT_MS);

      child.stdout!.on("data", (data: Buffer) => {
        const text = data.toString();
        stdoutChunks.push(text);
        lastActivity = Date.now();
        input.onStream?.(text);
      });

      child.stderr!.on("data", (data: Buffer) => {
        stderrChunks.push(data.toString());
        lastActivity = Date.now();
      });

      child.on("error", (err) => {
        clearInterval(heartbeat);
        resolve({ output: `[codex spawn error: ${err.message}]`, exitCode: 1 });
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
