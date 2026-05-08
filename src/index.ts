#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { CopilotAdapter } from "./adapters/copilot.js";
import type { Adapter, AgentMode } from "./adapters/types.js";
import { printDone, printError, printStartBanner } from "./console.js";
import { runDuet } from "./orchestrator.js";
import { parseTranscript } from "./resume.js";
import { Transcript } from "./transcript.js";

// ── Default role instructions ──────────────────────────────────────────────

const PLANNING_REVIEWER = `You are the architect reviewing the codebase to produce an implementation plan.

FIRST TURN — produce the initial plan:
1. Read the relevant source files thoroughly.
2. Produce a numbered list of findings. For each item include:
   - What the issue is (with file:line)
   - Why it matters (correctness, security, performance, debt)
   - Proposed fix approach (specific, not vague)
   - Risk level: LOW / MEDIUM / HIGH
3. Be concrete. Do NOT make any code changes.

SUBSEQUENT TURNS — after the implementer has reviewed your plan:
1. Write a COMPLETE revised plan that:
   - Removes items the implementer deferred or rejected (note why they were excluded)
   - Incorporates improvements they suggested
   - Keeps items you still believe are necessary, with your counter-reasoning if they pushed back
2. This revised plan is the exact list the implementer will execute — nothing more, nothing less.
3. When the revised plan is final, emit the stop token on its own line to lock it in.

IMPORTANT: Only you (the reviewer) can end the planning phase. Do not emit the stop token on your first turn.`;

const PLANNING_IMPLEMENTER = `You are validating a proposed implementation plan before any code is written.
For each item in the plan:
1. Is the finding real? (Does the code actually have this issue? State the evidence.)
2. Is the proposed fix correct and complete? What's missing or wrong?
3. Is the risk assessment accurate?
4. Flag anything that seems unnecessary, overly risky, out of scope, or that you would defer.

Do NOT make any code changes. This is a planning review only.
Do NOT emit the stop token — only the reviewer finalises the plan.
Instead, clearly state which items you accept, which you want changed, and which you think should be deferred. The reviewer will write the final revised plan in their next turn.`;

const IMPL_IMPLEMENTER = `You are executing the agreed implementation plan.
For each item in the agreed plan:
1. Implement it, OR defer it with a clear reason, OR push back if you disagree (with reasoning).
2. Make the actual code edits for items you accept.
3. After making changes, summarize what you changed (file:line), what you skipped, and why.
Do not invent work beyond the agreed plan.
Do NOT emit the stop token — the reviewer will validate your work and certify completion.`;

const IMPL_REVIEWER = `You are validating the implementation against the agreed plan.
- Read the changed files carefully.
- For each plan item: did the implementer address it correctly? Are there regressions or new issues?
- Report remaining issues with file:line. Be specific.
- If all plan items are correctly resolved and there are no regressions, emit the stop token on its own line.

IMPORTANT: Only you (the reviewer) can end the implementation phase.`;

// ── Helpers ────────────────────────────────────────────────────────────────

type AgentName = "claude" | "copilot" | "codex";

function makeAdapter(name: AgentName, squad: boolean, yolo: boolean): Adapter {
  if (name === "claude") return new ClaudeAdapter();
  if (name === "copilot") return new CopilotAdapter({ squad, yolo });
  if (name === "codex") return new CodexAdapter();
  throw new Error(`Unknown agent: ${name as string}`);
}

function parseAgent(value: string): AgentName {
  if (value === "claude" || value === "copilot" || value === "codex") return value;
  throw new Error(`Invalid agent "${value}". Expected "claude", "copilot", or "codex".`);
}

function parseMode(value: string): AgentMode {
  if (value === "read" || value === "write") return value;
  throw new Error(`Invalid mode "${value}". Expected "read" or "write".`);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("agent-duet")
  .description("Two AI agents: plan together, then implement and review in rounds.")
  .option("--project <path>", "project directory both agents work in")
  .option("--task <text>", "what the agents should accomplish together")
  .option("--reviewer <name>", "reviewer agent: claude | copilot | codex", "claude")
  .option("--implementer <name>", "implementer agent: claude | copilot | codex", "copilot")
  .option("--reviewer-mode <mode>", "implementer file access during implementation: read | write", "read")
  .option("--implementer-mode <mode>", "implementer file access during implementation: read | write", "write")
  .option("--plan-rounds <n>", "max rounds for planning phase", (v) => parseInt(v, 10), 4)
  .option("--impl-rounds <n>", "max rounds for implementation phase", (v) => parseInt(v, 10), 6)
  .option("--stop-token <text>", "token an agent emits to signal agreement/completion", "APPROVED")
  .option("--squad", "invoke copilot via `copilot --agent squad`", false)
  .option("--yolo", "pass --yolo to copilot (auto-approve tool calls, required for headless squad)", false)
  .option("--no-confirm", "skip the user confirmation prompt between planning and implementation")
  .option("--transcript <path>", "where to write the run transcript")
  .option("--resume <path>", "resume a previous run from its transcript file")
  .option("--planning-reviewer-instructions <text>", "override planning-phase reviewer instructions")
  .option("--planning-implementer-instructions <text>", "override planning-phase implementer instructions")
  .option("--impl-reviewer-instructions <text>", "override implementation-phase reviewer instructions")
  .option("--impl-implementer-instructions <text>", "override implementation-phase implementer instructions")
  .action(async (opts) => {
    // ── Resume ───────────────────────────────────────────────────────────
    let resumedState: ReturnType<typeof parseTranscript> | null = null;
    let resumedFromPath: string | undefined;

    if (opts.resume) {
      resumedFromPath = resolve(opts.resume);
      try {
        resumedState = parseTranscript(resumedFromPath);
      } catch (err) {
        printError(`Could not parse resume transcript: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

    // ── Validate required args ───────────────────────────────────────────
    if (!opts.project && !resumedState) {
      printError("--project is required (or use --resume to continue a prior run).");
      process.exit(1);
    }
    if (!opts.task && !resumedState) {
      printError("--task is required (or use --resume to continue a prior run).");
      process.exit(1);
    }

    // ── Merge CLI + resumed state ────────────────────────────────────────
    const cwd = resolve(opts.project ?? resumedState!.cwd);
    const task = (opts.task ?? resumedState!.task) as string;
    const reviewerName = parseAgent(opts.reviewer ?? resumedState?.reviewer ?? "claude");
    const implementerName = parseAgent(opts.implementer ?? resumedState?.implementer ?? "copilot");
    const reviewerMode = parseMode(opts.reviewerMode ?? resumedState?.reviewerMode ?? "read");
    const implementerMode = parseMode(opts.implementerMode ?? resumedState?.implementerMode ?? "write");
    const planRounds: number = opts.planRounds ?? resumedState?.planRounds ?? 4;
    const implRounds: number = opts.implRounds ?? resumedState?.implRounds ?? 6;
    const stopToken: string = opts.stopToken ?? resumedState?.stopToken ?? "APPROVED";
    const confirm = opts.confirm !== false; // --no-confirm sets opts.confirm = false

    if (reviewerName === implementerName) {
      printError("Reviewer and implementer must be different agents.");
      process.exit(1);
    }

    const startPhase = resumedState?.startPhase;
    const startRound = resumedState?.startRound;
    const initialPreviousOutput = resumedState?.initialPreviousOutput;
    const agreedPlan = resumedState?.agreedPlan ?? undefined;

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    // When resuming, append to the original transcript unless --transcript overrides.
    const transcriptPath = opts.transcript
      ? resolve(opts.transcript)
      : resumedFromPath ?? resolve(cwd, `transcripts/run-${ts}.md`);
    const appendToExisting = !!resumedState && !opts.transcript;

    const reviewer = makeAdapter(reviewerName, false, false); // reviewer never uses squad
    const implementer = makeAdapter(implementerName, opts.squad as boolean, opts.yolo as boolean);

    const transcript = new Transcript(transcriptPath, {
      task,
      cwd,
      reviewer: reviewerName,
      reviewerMode,
      implementer: implementerName,
      implementerMode,
      planRounds,
      implRounds,
      stopToken,
    }, appendToExisting);

    printStartBanner({
      project: cwd,
      reviewer: reviewerName,
      reviewerMode,
      implementer: implementerName,
      implementerMode,
      planRounds,
      implRounds,
      task,
      resumingFromPhase: startPhase,
      resumingFromRound: startRound,
    });

    const result = await runDuet({
      task,
      cwd,
      reviewer: { adapter: reviewer, mode: reviewerMode },
      implementer: { adapter: implementer, mode: implementerMode },
      planning: {
        maxRounds: planRounds,
        reviewerInstructions: opts.planningReviewerInstructions ?? PLANNING_REVIEWER,
        implementerInstructions: opts.planningImplementerInstructions ?? PLANNING_IMPLEMENTER,
      },
      implementation: {
        maxRounds: implRounds,
        reviewerInstructions: opts.implReviewerInstructions ?? IMPL_REVIEWER,
        implementerInstructions: opts.implImplementerInstructions ?? IMPL_IMPLEMENTER,
      },
      stopToken,
      confirmBeforeImplementing: confirm,
      transcript,
      startPhase,
      startRound,
      initialPreviousOutput: initialPreviousOutput || undefined,
      agreedPlan,
    });

    printDone({
      rounds: result.planningRounds + result.implRounds,
      stoppedReason: result.stoppedReason,
      transcriptPath,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
