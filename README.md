# agent-duet

Two AI coding agents in a peer-review loop on a shared project.

`agent-duet` orchestrates a turn-by-turn exchange between **Claude** (via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) and **GitHub Copilot** (via the `copilot` CLI, optionally as a [Squad](https://github.com/bradygaster/squad) agent). One agent is the **reviewer** (read-only by default), the other is the **implementer** (read + write). The orchestrator pipes each turn's output into the next turn's prompt and writes a single Markdown transcript of the whole exchange.

## Why

If you've ever fed Claude's review notes to Copilot by hand, then handed Copilot's reply back to Claude, then repeated that two more times — this automates that loop.

## Prerequisites

- **Node.js ≥ 20**
- **GitHub Copilot CLI** installed and authenticated (`copilot --version`)
- **Anthropic credentials** for the Claude Agent SDK — either `ANTHROPIC_API_KEY` in env, or an authenticated Claude Code install on the same machine
- (Optional) [Squad](https://github.com/bradygaster/squad) installed if you want `--squad`

## Install

```bash
git clone <this repo>
cd agent-duet
npm install
npm run build
```

For local invocation without publishing:

```bash
node dist/index.js --help
# or
npm link    # then `agent-duet --help` from anywhere
```

## Usage

Minimal — relies on defaults for everything except project and task:

```bash
agent-duet \
  --project ./my-app \
  --task "Review this codebase for quality and security issues."
```

Or directly from the build output:

```bash
node dist/index.js \
  --project ./my-app \
  --task "Review this codebase for quality and security issues."
```

Full form with every knob:

```bash
agent-duet \
  --project ./my-app \
  --task "Review this codebase for quality and security issues. Reviewer flags issues with file:line. Implementer fixes accepted issues, pushes back on disagreements." \
  --reviewer claude \
  --reviewer-mode read \
  --implementer copilot \
  --implementer-mode write \
  --squad \
  --max-rounds 6 \
  --stop-token APPROVED
```

Defaults: `--reviewer claude --implementer copilot --reviewer-mode read --implementer-mode write --max-rounds 6 --stop-token APPROVED`. Roles **must** be different agents.

### Resuming a run

Pass `--resume` with the transcript file from a previous run; project, task, and other settings are recovered from its frontmatter:

```bash
node dist/index.js --resume transcripts\<run file name>.md --squad --yolo
```

### What happens each round

1. Round 1 (reviewer turn): reviewer reads project, writes findings.
2. Round 2 (implementer turn): implementer receives the findings, makes edits, summarizes.
3. Round 3 (reviewer): reviewer validates the changes, flags anything still missing.
4. ...continues until `--max-rounds`, the stop token appears on its own line at the end of an output, or a turn exits non-zero.

### Read vs. write enforcement

- **Claude (read mode):** the SDK is invoked with `disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"]`.
- **Claude (write mode):** `permissionMode: "acceptEdits"`, edit tools allowed.
- **Copilot (read mode):** spawned as `copilot --deny-tool write -p "..."`.
- **Copilot (write mode):** spawned as `copilot --allow-all-tools -p "..."`.

With `--squad`, the Copilot invocation becomes `copilot --agent squad ...`.

## Output

A single Markdown file at `./transcripts/run-<timestamp>.md` (override with `--transcript`):

```markdown
# agent-duet run

- Started: 2026-05-06T...
- Project: `./my-app`
- Reviewer: **claude** (read)
- Implementer: **copilot** (write)
- ...

## Task

...

## Round 1 — reviewer (claude, read)

<reviewer output>

## Round 2 — implementer (copilot, write)

<implementer output>
```

The same content is also streamed to stdout while the run is in progress.

## Customizing role instructions

The defaults are tuned for a security/perf peer review, but you can override either side:

```bash
agent-duet \
  --project ./my-app \
  --task "Migrate Express middlewares to Fastify equivalents." \
  --reviewer-instructions "You are a Fastify expert. Identify each Express middleware and propose a Fastify replacement with the exact API mapping. Do not modify code." \
  --implementer-instructions "Apply the proposed migrations one at a time, running the test suite after each. Report what passed and what regressed."
```

## Project layout

```
src/
  index.ts            CLI entry (commander)
  orchestrator.ts     the alternating-turn loop
  prompt.ts           per-turn prompt template
  transcript.ts       Markdown transcript writer
  adapters/
    types.ts          Adapter interface
    claude.ts         Claude Agent SDK adapter
    copilot.ts        copilot CLI subprocess adapter
```

## Status

v0.1.0 — fixed roles per run (reviewer / implementer), two agents (claude / copilot). Roadmap: per-round role swapping, more agents, stricter Copilot tool filtering.
