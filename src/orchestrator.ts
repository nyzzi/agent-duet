import type { Adapter, AgentMode } from "./adapters/types.js";
import { buildPrompt, type Phase } from "./prompt.js";
import {
  printNote,
  printPhaseHeader,
  printPlanAgreed,
  printRoundHeader,
  printTextDivider,
  promptUserConfirmation,
  type ConfirmationResult,
} from "./console.js";
import type { Transcript } from "./transcript.js";

export interface RoleConfig {
  adapter: Adapter;
  mode: AgentMode;
}

export interface PhaseConfig {
  maxRounds: number;
  reviewerInstructions: string;
  implementerInstructions: string;
}

export interface OrchestratorConfig {
  task: string;
  cwd: string;
  reviewer: RoleConfig;
  implementer: RoleConfig;
  planning: PhaseConfig;
  implementation: PhaseConfig;
  stopToken: string;
  confirmBeforeImplementing: boolean;
  transcript: Transcript;
  // resume options
  startPhase?: Phase;
  startRound?: number;
  initialPreviousOutput?: string;
  agreedPlan?: string;
}

export interface OrchestratorResult {
  planningRounds: number;
  implRounds: number;
  stoppedReason: "max-rounds" | "stop-token" | "non-zero-exit" | "user-aborted";
}

interface PhaseResult {
  rounds: number;
  stoppedReason: "max-rounds" | "stop-token" | "non-zero-exit";
  agreedPlan: string | null;
}

export async function runDuet(cfg: OrchestratorConfig): Promise<OrchestratorResult> {
  const startPhase = cfg.startPhase ?? "planning";
  let planningResult: PhaseResult = {
    rounds: 0,
    stoppedReason: "max-rounds",
    agreedPlan: cfg.agreedPlan ?? null,
  };
  let implResult: PhaseResult = { rounds: 0, stoppedReason: "max-rounds", agreedPlan: null };

  // ── Phase 1: Planning (may loop if user requests revisions) ───────────────
  if (startPhase === "planning") {
    let planStartRound = cfg.startRound ?? 1;
    let planPreviousOutput: string | null = cfg.initialPreviousOutput ?? null;
    let revisionCycle = 0;

    cfg.transcript.startPhase("planning");

    while (true) {
      printPhaseHeader("planning");

      planningResult = await runPhase({
        phase: "planning",
        firstRole: "reviewer",
        task: cfg.task,
        cwd: cfg.cwd,
        reviewer: { adapter: cfg.reviewer.adapter, mode: "read" },
        implementer: { adapter: cfg.implementer.adapter, mode: "read" },
        maxRounds: cfg.planning.maxRounds,
        reviewerInstructions: cfg.planning.reviewerInstructions,
        implementerInstructions: cfg.planning.implementerInstructions,
        stopToken: cfg.stopToken,
        transcript: cfg.transcript,
        startRound: planStartRound,
        initialPreviousOutput: planPreviousOutput,
      });

      if (planningResult.stoppedReason === "non-zero-exit") {
        return { planningRounds: planningResult.rounds, implRounds: 0, stoppedReason: "non-zero-exit" };
      }

      if (planningResult.agreedPlan) {
        printPlanAgreed();
        cfg.transcript.recordAgreedPlan(planningResult.agreedPlan);
      }

      if (!cfg.confirmBeforeImplementing) break;

      const confirmation: ConfirmationResult = await promptUserConfirmation();

      if (confirmation.action === "proceed") break;

      if (confirmation.action === "abort") {
        cfg.transcript.note("User aborted before implementation.");
        return { planningRounds: planningResult.rounds, implRounds: 0, stoppedReason: "user-aborted" };
      }

      // User wants to revise — feed their feedback back into a new planning cycle.
      revisionCycle++;
      cfg.transcript.startPlanRevision(revisionCycle, confirmation.feedback);
      planStartRound = 1;
      planPreviousOutput = buildRevisionContext(
        planningResult.agreedPlan ?? "",
        confirmation.feedback,
      );
    }
  }

  // ── Phase 2: Implementation ────────────────────────────────────────────────
  printPhaseHeader("implementation");
  cfg.transcript.startPhase("implementation");

  implResult = await runPhase({
    phase: "implementation",
    // Implementation starts with the implementer (who applies the plan first),
    // then the reviewer validates. This prevents wasting a round on the reviewer
    // reading unchanged code.
    firstRole: "implementer",
    task: cfg.task,
    cwd: cfg.cwd,
    reviewer: cfg.reviewer,
    implementer: cfg.implementer,
    maxRounds: cfg.implementation.maxRounds,
    reviewerInstructions: cfg.implementation.reviewerInstructions,
    implementerInstructions: cfg.implementation.implementerInstructions,
    stopToken: cfg.stopToken,
    transcript: cfg.transcript,
    startRound: startPhase === "implementation" ? (cfg.startRound ?? 1) : 1,
    initialPreviousOutput: startPhase === "implementation" ? (cfg.initialPreviousOutput ?? null) : null,
    agreedPlan: planningResult.agreedPlan ?? cfg.agreedPlan ?? undefined,
  });

  return {
    planningRounds: planningResult.rounds,
    implRounds: implResult.rounds,
    stoppedReason: implResult.stoppedReason,
  };
}

// ── Internal phase runner ──────────────────────────────────────────────────

interface RunPhaseArgs {
  phase: Phase;
  firstRole: "reviewer" | "implementer";
  task: string;
  cwd: string;
  reviewer: RoleConfig;
  implementer: RoleConfig;
  maxRounds: number;
  reviewerInstructions: string;
  implementerInstructions: string;
  stopToken: string;
  transcript: Transcript;
  startRound: number;
  initialPreviousOutput: string | null;
  agreedPlan?: string;
}

async function runPhase(args: RunPhaseArgs): Promise<PhaseResult> {
  const turns: Array<{
    role: "reviewer" | "implementer";
    adapter: Adapter;
    mode: AgentMode;
    instructions: string;
  }> = [
    { role: "reviewer", adapter: args.reviewer.adapter, mode: args.reviewer.mode, instructions: args.reviewerInstructions },
    { role: "implementer", adapter: args.implementer.adapter, mode: args.implementer.mode, instructions: args.implementerInstructions },
  ];

  // firstRole controls which agent takes round 1.
  // reviewer → turns[0] first (round 1 = reviewer, round 2 = implementer, ...)
  // implementer → turns[1] first (round 1 = implementer, round 2 = reviewer, ...)
  const firstIndex = args.firstRole === "reviewer" ? 0 : 1;

  const startRound = args.startRound;
  let previousOutput: string | null = args.initialPreviousOutput;
  let previousAgent =
    startRound > 1
      ? turns[(firstIndex + startRound - 2) % 2].adapter.name
      : "";
  let lastReviewerOutput: string | null = null;
  let completedRounds = startRound - 1;
  let stoppedReason: PhaseResult["stoppedReason"] = "max-rounds";

  const stopRegex = new RegExp(`(?:^|\\n)\\s*${escapeRegex(args.stopToken)}\\s*$`);

  for (let round = startRound; round <= args.maxRounds; round++) {
    const turn = turns[(firstIndex + round - 1) % 2];
    const otherTurn = turns[(firstIndex + round) % 2];
    const otherAgent = previousAgent || otherTurn.adapter.name;

    const prompt = buildPrompt({
      phase: args.phase,
      role: turn.role,
      agent: turn.adapter.name,
      otherAgent,
      round,
      maxRounds: args.maxRounds,
      cwd: args.cwd,
      mode: turn.mode,
      task: args.task,
      previousOutput,
      roleInstructions: turn.instructions,
      stopToken: args.stopToken,
      agreedPlan: args.agreedPlan,
    });

    printRoundHeader(round, args.maxRounds, turn.role, turn.adapter.name, turn.mode);
    args.transcript.startTurn(round, turn.role, turn.adapter.name, turn.mode);

    let firstChunk = true;
    const result = await turn.adapter.run({
      prompt,
      cwd: args.cwd,
      mode: turn.mode,
      onStream: (chunk) => {
        if (firstChunk) { printTextDivider(); firstChunk = false; }
        process.stdout.write(chunk);
      },
    });

    args.transcript.endTurn(result.output, result.exitCode);
    completedRounds = round;

    if (turn.role === "reviewer") {
      lastReviewerOutput = result.output;
    }

    if (result.exitCode !== 0) {
      const msg = `Turn exited with code ${result.exitCode}. Stopping.`;
      printNote(msg);
      args.transcript.note(msg);
      stoppedReason = "non-zero-exit";
      break;
    }

    // Only the reviewer can end a phase with the stop token.
    // If the implementer emits it, treat it as "I agree — please finalize"
    // and let the reviewer have the last word (revise plan / validate changes).
    if (stopRegex.test(result.output)) {
      if (turn.role === "reviewer") {
        const msg = args.phase === "planning"
          ? "Reviewer finalised the plan."
          : "Reviewer approved the implementation.";
        printNote(msg);
        args.transcript.note(msg);
        stoppedReason = "stop-token";
        break;
      } else {
        // Implementer signalled agreement — tell transcript but keep going.
        const msg = `Implementer signalled agreement. Continuing to reviewer for final ${args.phase === "planning" ? "plan" : "validation"}.`;
        printNote(msg);
        args.transcript.note(msg);
      }
    }

    previousOutput = result.output;
    previousAgent = turn.adapter.name;
  }

  if (stoppedReason === "max-rounds") {
    const msg = `Reached max rounds (${args.maxRounds}).`;
    printNote(msg);
    args.transcript.note(msg);
  }

  // The agreed plan / validation is always the reviewer's last output.
  return {
    rounds: completedRounds,
    stoppedReason,
    agreedPlan: lastReviewerOutput,
  };
}

function buildRevisionContext(agreedPlan: string, userFeedback: string): string {
  return [
    "[USER REQUESTED PLAN REVISION]",
    "The plan below was agreed by both agents, but the user has requested changes before implementation.",
    "",
    "User feedback:",
    userFeedback,
    "",
    "Previously agreed plan:",
    agreedPlan,
    "",
    "Please revise the plan to address the user's feedback. Emit the stop token when the revised plan is final.",
  ].join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
