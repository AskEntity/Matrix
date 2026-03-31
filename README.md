# Matrix

One developer, team-quality code — powered by multi-agent AI.

**[Documentation →](https://matrix.dev)**

## What is Matrix?

Matrix is a multi-agent orchestration system for AI-assisted software development. It decomposes complex goals into a recursive task tree, spawns agents in parallel on isolated git worktrees, and merges results — letting one person build well-architected, well-tested projects at the speed of a team.

### Key Features

- **Recursive Task Tree** — Unlimited depth. Any agent can become a sub-orchestrator.
- **Git Worktree Isolation** — Each agent gets its own branch. No conflicts during work, clean merge when done.
- **Cross-Project Communication** — Agents in different projects talk to each other in real-time.
- **Context Compaction + Forking** — Agents work on arbitrarily long tasks and transfer knowledge efficiently.
- **Persistent Memory** — `.mxd/memory.md` survives across sessions and compactions.
- **Test-is-Golden** — Tests are the single source of truth. Architecture improves through mutation testing, and remains replaceable long-term because tests hold.
- **Self-Bootstrapping** — Matrix develops itself using itself.

## Quick Start

```bash
# Prerequisites: Bun, Git 2.5+, Anthropic API key

git clone https://github.com/AskEntity/Matrix.git
cd Matrix
bun install
bun link          # Installs `mxd` CLI globally

# Configure
mxd config auth add default --provider anthropic --key sk-ant-api03-...

# Start the daemon
mxd daemon install

# Initialize a project and start working
cd /path/to/your/project
mxd init .
mxd send "Build a REST API for user management"
```

## Architecture

```
Daemon (Hono HTTP + SSE on :7433)
    ↑               ↑
  CLI (mxd)      Web UI (React)
```

- Two providers: Anthropic (Claude) and OpenAI-compatible APIs
- Three-layer config: global → repo → local
- Agent tree = Task tree, each agent on its own worktree + branch
- JSONL event sourcing — kill the daemon anytime, everything resumes
- Real-time web UI at `localhost:7433`

## Documentation

Full documentation at **[matrix.dev](https://matrix.dev)**:

- [Getting Started](https://matrix.dev/getting-started) — Installation, configuration, CLI reference
- [Why Matrix](https://matrix.dev/why) — Philosophy, test-driven methodology, competitive positioning
- [Core Concepts](https://matrix.dev/concepts) — Task tree, worktrees, memory, cross-project messaging
- [Architecture](https://matrix.dev/architecture) — Internal design, event system, provider abstraction

## Status

Matrix is functional and in daily use for self-development. Not yet published to npm — install from source.

## License

MIT
