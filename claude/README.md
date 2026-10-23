# Claude Code integration

Makes Claude Code drive a live Neovim like the pi extension does: the `nvim_*` MCP
tools (from [`../mcp-nvim`](../mcp-nvim)) do the editing, and these hooks/settings
stop Claude from falling back to its builtin file tools.

Scaffolds CLAUDE_CODE_PLAN milestones 3 (enforcement) and 4 (playbook). The pieces:

- `settings.json` — a template: denies `Read/Edit/Write/Grep/Glob/NotebookEdit` and
  registers the PreToolUse hooks plus the SessionStart/UserPromptSubmit context hook.
- `hooks/redirect-to-nvim.mjs` — blocks the builtin file tools with a message pointing
  at the `nvim_*` tools (the layer that actually redirects the model).
- `hooks/guard-bash.mjs` — blocks shell file-bypasses (`sed -i`, `cat`/`rg`/`grep`/
  `find`, redirects, `tee`, scripted writes) and otherwise saves all Neovim buffers
  before the command runs.
- `hooks/bash-policy.mjs` — the shared, tested classifier (same patterns as the pi
  extension's bash guard).
- `hooks/nvim-context.mjs` — injects `<nvim_capabilities>` + `<nvim_keymaps>` (what the
  pi extension puts in its system prompt): both at session start, then capabilities
  only when they change, so the transcript doesn't pile up copies. It reads the cache
  the MCP server keeps current (`~/.cache/mystique`, or `$MYSTIQUE_CACHE_DIR`).
- `CLAUDE.md` — the power-user playbook to drop into your project (or `~/.claude`).

## Setup

```bash
# 1. Install the engine + MCP server
cd core && npm install && cd ../mcp-nvim && npm install

# 2. Start an editor for Claude to drive
nvim --listen /tmp/nvim.sock

# 3. Register the MCP server (adjust the absolute path)
claude mcp add nvim \
  --env MYSTIQUE_SOCKET=/tmp/nvim.sock \
  -- node --import tsx /abs/path/to/mystique/mcp-nvim/index.ts
```

Then enable enforcement + playbook:

- Merge `settings.json` into your project `.claude/settings.json` (or `~/.claude/
  settings.json`), replacing `ABS_PATH_TO_MYSTIQUE` with your checkout path.
- Copy `CLAUDE.md` into your project root (or append to `~/.claude/CLAUDE.md`).

The hooks run on bare `node` (no build step). `guard-bash.mjs` saves buffers through
`nvim --server $MYSTIQUE_SOCKET` (falls back to `$NVIM`); set one of those in the hook
environment if it isn't already.

## Tests

```bash
npm test   # bash classifier (blocked vs allowed) + context hook injection
```

Runs in CI. The hook wiring itself (stdin event → exit code) depends on Claude Code's
runtime and is exercised manually; see milestone 4 in [../CLAUDE_CODE_PLAN.md](../CLAUDE_CODE_PLAN.md).
