import { createInterface } from "node:readline";
import chalk, { type ChalkInstance } from "chalk";

const AGENT_COLORS: Record<string, ChalkInstance> = {
  claude: chalk.cyan,
  copilot: chalk.magenta,
  codex: chalk.green,
};

function agentChalk(agent: string): ChalkInstance {
  return AGENT_COLORS[agent] ?? chalk.white;
}

const RULE_WIDE = "━".repeat(58);
const RULE_THIN = "─".repeat(58);

export function printStartBanner(opts: {
  project: string;
  reviewer: string;
  reviewerMode: string;
  implementer: string;
  implementerMode: string;
  planRounds: number;
  implRounds: number;
  task: string;
  resumingFromPhase?: string;
  resumingFromRound?: number;
}): void {
  const task = opts.task.length > 72 ? opts.task.slice(0, 71) + "…" : opts.task;
  console.log("\n" + chalk.bold(RULE_WIDE));
  console.log(chalk.bold("  agent-duet"));
  console.log(`  ${chalk.dim("project")}     ${chalk.white(opts.project)}`);
  console.log(
    `  ${chalk.dim("reviewer")}    ${agentChalk(opts.reviewer).bold(opts.reviewer)}` +
    chalk.dim(` (${opts.reviewerMode})`),
  );
  console.log(
    `  ${chalk.dim("implementer")} ${agentChalk(opts.implementer).bold(opts.implementer)}` +
    chalk.dim(` (${opts.implementerMode})`),
  );
  console.log(`  ${chalk.dim("plan rounds")} ${opts.planRounds}  ${chalk.dim("impl rounds")} ${opts.implRounds}`);
  console.log(`  ${chalk.dim("task")}        ${chalk.white(task)}`);
  if (opts.resumingFromPhase !== undefined) {
    console.log(
      `  ${chalk.dim("resuming")}    phase ${chalk.bold(opts.resumingFromPhase)}, ` +
      `round ${chalk.bold(String(opts.resumingFromRound))}`,
    );
  }
  console.log(chalk.bold(RULE_WIDE) + "\n");
}

export function printPhaseHeader(phase: "planning" | "implementation"): void {
  const label = phase === "planning"
    ? chalk.blue.bold("  ◆  Planning Phase")
    : chalk.green.bold("  ◆  Implementation Phase");
  const sub = phase === "planning"
    ? chalk.dim("  Agents agree on a plan before any code changes")
    : chalk.dim("  Implementer applies the plan; reviewer validates");
  console.log("\n" + chalk.dim(RULE_WIDE));
  console.log(label);
  console.log(sub);
  console.log(chalk.dim(RULE_WIDE) + "\n");
}

export function printRoundHeader(
  round: number,
  maxRounds: number,
  role: string,
  agent: string,
  mode: string,
): void {
  const agentLabel = agentChalk(agent).bold(agent);
  const roleLabel = chalk.bold(role);
  const modeLabel = chalk.dim(`${mode} access`);
  console.log("\n" + chalk.dim(RULE_THIN));
  console.log(
    `  ${chalk.bold.white(`Round ${round}/${maxRounds}`)}` +
    chalk.dim("  ·  ") +
    roleLabel +
    chalk.dim("  ·  ") +
    agentLabel +
    "  " +
    modeLabel,
  );
  console.log(chalk.dim(RULE_THIN) + "\n");
}

export function printTool(
  agent: string,
  elapsed: string,
  toolName: string,
  detail: string,
): void {
  const prefix = chalk.dim(`  › [${elapsed}] `);
  const name = agentChalk(agent)(toolName);
  const det = detail ? chalk.dim("  " + detail) : "";
  process.stdout.write(prefix + name + det + "\n");
}

export function printHeartbeat(agent: string, elapsed: string, detail: string): void {
  process.stdout.write(
    chalk.dim(`  · [${elapsed}] `) + chalk.yellow(detail) + "\n",
  );
}

export function printTextDivider(): void {
  process.stdout.write("\n");
}

export function printNote(msg: string): void {
  console.log("\n" + chalk.yellow("  ⚠  ") + chalk.yellow(msg));
}

export function printPlanAgreed(): void {
  console.log("\n" + chalk.blue(RULE_WIDE));
  console.log(chalk.blue("  ✔  Plan agreed by both agents."));
  console.log(chalk.blue(RULE_WIDE));
}

export type ConfirmationResult =
  | { action: "proceed" }
  | { action: "abort" }
  | { action: "revise"; feedback: string };

export async function promptUserConfirmation(): Promise<ConfirmationResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    console.log(chalk.bold.white("\n  Ready to implement. What would you like to do?"));
    console.log(`  ${chalk.bold("Y")}${chalk.dim(" · proceed with implementation")}`);
    console.log(`  ${chalk.bold("N")}${chalk.dim(" · abort")}`);
    console.log(`  ${chalk.bold("or type changes")}${chalk.dim(" · revise the plan and re-run planning")}\n`);
    rl.question(chalk.bold.white("  > "), (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "" || trimmed.toLowerCase() === "y") {
        console.log(chalk.green("  → Proceeding with implementation.\n"));
        resolve({ action: "proceed" });
      } else if (trimmed.toLowerCase() === "n") {
        console.log(chalk.yellow("  → Aborted.\n"));
        resolve({ action: "abort" });
      } else {
        console.log(chalk.blue("  → Sending your feedback back to planning.\n"));
        resolve({ action: "revise", feedback: trimmed });
      }
    });
  });
}

export function printError(msg: string): void {
  console.error("\n" + chalk.red("  ✖  ") + chalk.red(msg));
}

export function printDone(opts: {
  rounds: number;
  stoppedReason: string;
  transcriptPath: string;
}): void {
  const ok = opts.stoppedReason === "stop-token";
  const color = ok ? chalk.green : chalk.yellow;
  const icon = ok ? "✔" : "⚠";
  console.log("\n" + color(RULE_WIDE));
  console.log(
    color(`  ${icon}  Done`) +
    chalk.dim("  ·  ") +
    color(`${opts.rounds} round(s)`) +
    chalk.dim("  ·  ") +
    color(opts.stoppedReason),
  );
  console.log(chalk.dim(`  Transcript: ${opts.transcriptPath}`));
  console.log(color(RULE_WIDE) + "\n");
}
