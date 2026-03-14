# OpenGraft Changelog

## v0.2.0 — Multi-Provider Support & UI Overhaul (2026-03-12)

### New: OpenAI-Compatible Provider
- **OpenAI/OpenRouter support**: New `OpenAIProvider` for any OpenAI-compatible API (GPT-4o, DeepSeek, OpenRouter models, local models via Ollama/LMStudio)
- **Provider selection**: `OG_PROVIDER=openai|direct|claude-code` env var, or auto-detect from model name prefix (`gpt-`, `o3-`, `deepseek-`)
- **No SDK dependency**: Uses raw `fetch` for maximum compatibility
- **Per-project model override**: Settings UI allows typing any model name (free text input)
- **Model priority**: API param > project settings > `OG_MODEL` env var > `ANTHROPIC_MODEL` > `OPENAI_MODEL` > provider default

### UI Redesign: Activity Log
- **Tool cards**: Tool calls now render as collapsible cards with descriptive titles, status icons, and expandable bodies
- **MCP tool cards**: Purple accent with special rendering for orchestration tools (create_task shows title+description, execute_tasks shows task count, etc.)
- **Title-only cards**: get_tree, yield, delete_task, update_task show as compact single-line entries
- **Clean log**: Status events ("Starting agent loop", "Context window") filtered from activity log — only meaningful events shown
- **Error boundary**: Graceful React error recovery instead of white screen crash

### Stability Improvements
- **Orphan task reset**: When orchestrator crashes or is stopped, in_progress children are automatically reset to `failed`
- **WebSocket stability**: `onMessageRef` pattern prevents reconnection when callback changes
- **Compaction simplification**: Returns single user message (checkpoint + recent transcript) — no more tool_result orphaning or role alternation issues
- **Compaction streaming**: Uses `stream().finalMessage()` to avoid 10-minute timeout on large summaries
- **Post-compaction guidance**: Agents now immediately call `yield()` when resuming with running children

### Agent Quality
- **System prompts strengthened**: Mandatory `done()` call notices, parallelism guidance, stimulus priority for post-compaction
- **CWD sandboxing**: Warn-only approach when agents navigate outside their worktree
- **ORCHESTRATION_KNOWLEDGE**: Now included in root orchestrator prompt (was previously only in child prompts)

### Search Tool
- **Multiline search**: `multiline: true` parameter now works — applies regex across multiple lines with `dotAll` flag
- **Context lines**: `context: N` parameter shows N lines before/after each match with deduplication

### Code Quality
- **App.tsx modularization**: Split from 3546→843 lines into 14 component files
- **CSS audit**: Removed 14 unused CSS classes (173 lines)
- **IME input fix**: Triple-check (composingRef + keyCode 229 + isComposing) for reliable CJK input
- **Read file output**: Shows total line count and range (`[file — lines X–Y of Z]`)
- **Cost visibility**: Shows total USD cost in activity header after orchestration completes

### Breaking Changes
- Model/Child Model dropdowns removed from project settings (use Model Override text input or daemon env vars)
- Default provider changed from `claude-code` to `direct` (Anthropic API) when no `OG_PROVIDER` set

---

## v0.1.0 — Initial Release

- Core orchestration engine with task tree, worktrees, and branch lifecycle
- Claude Code and Direct (Anthropic API) providers
- 10 MCP tools for recursive multi-agent orchestration
- Web UI with real-time WebSocket streaming
- CLI for project management
- Session persistence and auto-resume on daemon restart
"}]
