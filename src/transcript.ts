import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Phase } from "./prompt.js";

export interface TranscriptHeader {
  task: string;
  cwd: string;
  reviewer: string;
  reviewerMode: string;
  implementer: string;
  implementerMode: string;
  planRounds: number;
  implRounds: number;
  stopToken: string;
  resumedFrom?: string;
}

export class Transcript {
  constructor(private readonly path: string, header: TranscriptHeader, append = false) {
    mkdirSync(dirname(path), { recursive: true });
    if (append) {
      // Resuming into the same file — just add a divider so it's clear where the run continued.
      appendFileSync(path, `\n\n---\n\n> **resumed:** ${new Date().toISOString()}\n`);
      return;
    }
    const lines = [
      `# agent-duet run`,
      ``,
      `- Started: ${new Date().toISOString()}`,
      `- Project: \`${header.cwd}\``,
      `- Reviewer: **${header.reviewer}** (${header.reviewerMode})`,
      `- Implementer: **${header.implementer}** (${header.implementerMode})`,
      `- Plan rounds: ${header.planRounds}`,
      `- Impl rounds: ${header.implRounds}`,
      `- Stop token: \`${header.stopToken}\``,
      ``,
      `## Task`,
      ``,
      header.task,
      ``,
    ].filter((l) => l !== null);
    writeFileSync(path, lines.join("\n"));
  }

  startPhase(phase: Phase): void {
    const label = phase === "planning" ? "Phase 1: Planning" : "Phase 2: Implementation";
    appendFileSync(this.path, `\n## ${label}\n\n`);
  }

  recordAgreedPlan(plan: string): void {
    appendFileSync(this.path, `\n### Agreed Plan\n\n${plan}\n\n`);
  }

  startPlanRevision(cycle: number, userFeedback: string): void {
    appendFileSync(
      this.path,
      `\n## Plan Revision ${cycle}\n\n> User feedback: ${userFeedback}\n\n`,
    );
  }

  startTurn(round: number, role: string, agent: string, mode: string): void {
    appendFileSync(this.path, `\n## Round ${round} — ${role} (${agent}, ${mode})\n\n`);
  }

  endTurn(output: string, exitCode: number): void {
    appendFileSync(this.path, `${output}\n\n_(exit ${exitCode})_\n`);
  }

  note(msg: string): void {
    appendFileSync(this.path, `\n> **note:** ${msg}\n`);
  }

  get filePath(): string {
    return this.path;
  }
}
