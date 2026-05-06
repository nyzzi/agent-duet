import { readFileSync } from "node:fs";
import type { Phase } from "./prompt.js";

export interface ResumedState {
  task: string;
  cwd: string;
  reviewer: string;
  reviewerMode: string;
  implementer: string;
  implementerMode: string;
  planRounds: number;
  implRounds: number;
  stopToken: string;
  startPhase: Phase;
  startRound: number;
  initialPreviousOutput: string;
  agreedPlan: string | null;
}

export function parseTranscript(transcriptPath: string): ResumedState {
  const raw = readFileSync(transcriptPath, "utf8");

  const cwd = extract(raw, /^- Project: `(.+)`$/m, "Project");
  const reviewer = extract(raw, /^- Reviewer: \*\*(.+?)\*\* \((.+?)\)$/m, "Reviewer", 1);
  const reviewerMode = extract(raw, /^- Reviewer: \*\*(.+?)\*\* \((.+?)\)$/m, "Reviewer mode", 2);
  const implementer = extract(raw, /^- Implementer: \*\*(.+?)\*\* \((.+?)\)$/m, "Implementer", 1);
  const implementerMode = extract(raw, /^- Implementer: \*\*(.+?)\*\* \((.+?)\)$/m, "Implementer mode", 2);
  const stopToken = extract(raw, /^- Stop token: `(.+)`$/m, "Stop token");

  // Plan/impl rounds — handle both old (Max rounds) and new format.
  const planRoundsMatch = raw.match(/^- Plan rounds: (\d+)$/m);
  const implRoundsMatch = raw.match(/^- Impl rounds: (\d+)$/m);
  const maxRoundsMatch = raw.match(/^- Max rounds: (\d+)$/m);
  const planRounds = parseInt(planRoundsMatch?.[1] ?? "4", 10);
  const implRounds = parseInt(implRoundsMatch?.[1] ?? maxRoundsMatch?.[1] ?? "6", 10);

  // Task block
  const taskMatch = raw.match(/^## Task\n\n([\s\S]+?)(?=\n## )/m);
  if (!taskMatch) throw new Error("Could not parse task from transcript.");
  const task = taskMatch[1].trim();

  // Agreed plan (explicit section written after planning phase)
  const agreedPlanMatch = raw.match(/^### Agreed Plan\n\n([\s\S]+?)(?=\n## |\n### |\z)/m);
  const agreedPlan = agreedPlanMatch ? agreedPlanMatch[1].trim() : null;

  // Detect which phase is active: if implementation phase section exists, we're there.
  const hasImplPhase = /^## Phase 2: Implementation/m.test(raw);
  const startPhase: Phase = hasImplPhase ? "implementation" : "planning";

  // Find all completed rounds (those followed by "_(exit N)_").
  // Scoped to the active phase section.
  const activeSection = hasImplPhase
    ? raw.slice(raw.search(/^## Phase 2: Implementation/m))
    : raw;

  const roundRegex = /^## Round (\d+) — (\w+) \((\w+), (\w+)\)\n\n([\s\S]+?)\n\n_\(exit (\d+)\)_/gm;
  let lastRound: {
    round: number;
    role: string;
    agent: string;
    output: string;
    exitCode: number;
  } | null = null;

  for (const match of activeSection.matchAll(roundRegex)) {
    lastRound = {
      round: parseInt(match[1], 10),
      role: match[2],
      agent: match[3],
      output: match[5].trim(),
      exitCode: parseInt(match[6], 10),
    };
  }

  if (!lastRound) {
    // No completed rounds in the active phase — start from round 1.
    return {
      task,
      cwd,
      reviewer,
      reviewerMode,
      implementer,
      implementerMode,
      planRounds,
      implRounds,
      stopToken,
      startPhase,
      startRound: 1,
      initialPreviousOutput: "",
      agreedPlan,
    };
  }

  return {
    task,
    cwd,
    reviewer,
    reviewerMode,
    implementer,
    implementerMode,
    planRounds,
    implRounds,
    stopToken,
    startPhase,
    startRound: lastRound.round + 1,
    initialPreviousOutput: lastRound.output,
    agreedPlan,
  };
}

function extract(raw: string, re: RegExp, label: string, group = 1): string {
  const m = raw.match(re);
  if (!m) throw new Error(`Could not parse ${label} from transcript.`);
  return m[group].trim();
}
