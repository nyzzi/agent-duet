import type { AgentMode } from "./adapters/types.js";

export type Phase = "planning" | "implementation";

export interface PromptContext {
  phase: Phase;
  role: "reviewer" | "implementer";
  agent: string;
  otherAgent: string;
  round: number;
  maxRounds: number;
  cwd: string;
  mode: AgentMode;
  task: string;
  previousOutput: string | null;
  roleInstructions: string;
  stopToken: string;
  agreedPlan?: string;
}

export function buildPrompt(ctx: PromptContext): string {
  const access = ctx.mode === "read"
    ? "READ-ONLY — do not modify any files"
    : "READ + WRITE — you may edit files";

  const phaseLabel = ctx.phase === "planning"
    ? "PLANNING PHASE — no code changes yet"
    : "IMPLEMENTATION PHASE";

  const previous = ctx.previousOutput
    ? `\n\n--- Previous turn (${ctx.otherAgent}) ---\n${ctx.previousOutput}\n--- end ---\n`
    : "\n\n(This is the first turn — no previous output.)\n";

  const planSection = ctx.agreedPlan
    ? `\n\n--- Agreed implementation plan ---\n${ctx.agreedPlan}\n--- end plan ---\n`
    : "";

  return `[${phaseLabel}]
You are the ${ctx.role} in a peer-review loop with ${ctx.otherAgent}.
Round ${ctx.round} of ${ctx.maxRounds}.
Project root: ${ctx.cwd}
File access: ${access}

Overall task:
${ctx.task}
${planSection}${previous}
Your role this turn:
${ctx.roleInstructions}

When you are fully satisfied and have nothing more to add, end your final message with the literal token "${ctx.stopToken}" on its own line. Do not emit it while you still want another round.`;
}
