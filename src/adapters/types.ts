export type AgentMode = "read" | "write";

export interface AgentTurnInput {
  prompt: string;
  cwd: string;
  mode: AgentMode;
  onStream?: (chunk: string) => void;
}

export interface AgentTurnResult {
  output: string;
  exitCode: number;
}

export interface Adapter {
  readonly name: string;
  run(input: AgentTurnInput): Promise<AgentTurnResult>;
}
