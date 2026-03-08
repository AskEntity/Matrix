# OpenGraft — CLAUDE.md

**A self-bootstrapping autonomous AI programming system.**

> This file is the cold-start anchor for every AI session. Read it first.
> Full methodology: `OpenGraft.md`. This file keeps only key decisions and current state.

## Current Phase: Phase 0 — Minimal Loop

**Goal**: Prove the daemon → agent loop works. Daemon-first architecture, all interaction via HTTP/SSE/WS API.

**Autonomy**: Level 10. Work continuously: implement → test → commit → pick up next feature. Do not ask questions — make decisions and keep moving.

## Tech Stack

| Decision | Choice | Reason |
|----------|--------|--------|
| Language | TypeScript strict | Strong type inference, large training data, unified front/back, fast compiler feedback |
| Runtime | Bun | Fast startup, built-in test framework, native TS support |
| Lint/Format | Biome | Single tool, minimal config, AI-friendly |
| Test | bun:test | Zero config, integrated with runtime, fast (tests colocated in src/) |
| Package manager | Bun | Fastest dependency installs |
| HTTP framework | Hono | Lightweight, Bun-native, TS-first, built-in WS helper |
| AI engine (Phase 0) | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Reuse existing tool impl, sandbox, context management |

## Architecture

```
Daemon (Hono: HTTP + SSE + WS on :7433)
    ↑               ↑
   CLI            Web UI
```

Daemon is the single core process. CLI and frontend are API consumers.

**Project lifecycle is deterministic code, not agent work.** The daemon initializes directories, creates `.ai/` structure, and hands the prepared project to agents.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Daemon health check |
| POST | /projects | Init project at `{path}` (create or convert existing) |
| GET | /projects | List all projects |
| GET | /projects/:id | Get project by ID |
| DELETE | /projects/:id | Remove project metadata (keeps code) |
| POST | /projects/:id/run | Execute agent task (one-shot, returns result) |
| POST | /projects/:id/stream | Execute agent task (SSE streaming events) |

## Code Rules

1. **All code and comments in English.** No exceptions.
2. **All user-facing text must go through i18n.** No raw string literals in HTML/UI.
3. **Pre-commit hooks enforce all checks** (typecheck, lint, test).
4. Three repetitions before abstracting. No premature helpers.

## Commands

```bash
bun test           # Run tests
bun run typecheck  # Type check
bun run check      # Biome lint + format
bun run dev        # Start daemon (watch mode)
```

## Testing

- Unit/integration tests: `bun test` (skips E2E by default)
- E2E tests (requires token): `CLAUDE_CODE_OAUTH_TOKEN=... bun test src/e2e.test.ts`

## Methodology Summary (read every session)

### Vertical Iteration
One feature at a time: types → implementation → tests → all passing. Never spread horizontally.

### Test-Driven Self-Correction
- Hallucinations die to test results, not prompt engineering
- Deterministic tests: condition-wait not fixed delay, independent setup/teardown per test
- Flaky test = Bug. Never "fix" with retries.

### Execute to Eliminate Hallucination
- Don't guess APIs — read docs or run --help first
- Don't say "should work" — run it and see
- Don't blame the framework — suspect your own code first

### Debug Protocol
Identify layer → add logs → trust logs → isolate → minimize

### Prohibitions
- No old-system fallbacks when replacing
- No single-use helpers
- No guessing bug causes without logs

## Build Log

### Phase 0
- [x] Project init (package.json, tsconfig, biome, hono)
- [x] Core types (TaskNode, AgentResult, Project, HealthResponse)
- [x] Daemon skeleton + /health + tests
- [x] AgentProvider interface + ClaudeCodeProvider (decoupled for future swap)
- [x] ProjectManager: init(path) — create new or convert existing projects
- [x] Projects CRUD API (POST/GET/DELETE /projects)
- [x] Agent execution endpoints: POST /run (one-shot) + POST /stream (SSE)
- [x] E2E test scaffold (agent creates calculator, verifies tests pass)
- [ ] E2E validation: run with real token, confirm agent loop works
- [ ] Pre-commit hooks setup (typecheck + lint + test)
- [ ] Task tracker (Phase 1 prep)
