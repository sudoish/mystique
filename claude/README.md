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
- `install.mjs` — the one-shot installer (below); `hooks/active.mjs` — the "is a Neovim
  reachable?" check that keeps everything inert elsewhere.
- `CLAUDE.md` — the power-user playbook (injected by the context hook).

## Setup

Usually you want the top-level installer (`sh install.sh`, see the main README), which
runs this for you. To set up only Claude Code from a checkout:

```bash
node claude/install.mjs              # install / update (user scope: every project)
node claude/install.mjs --uninstall  # remove everything it added
```

It installs `core/` + `mcp-nvim/` deps if missing, registers the `nvim` MCP server
(`claude mcp add -s user`), and merges into `~/.claude/settings.json` (backup:
`settings.json.bak-mystique`, your own hooks/settings untouched): the context hook,
the two PreToolUse guards, and `mcp__nvim` in `permissions.allow`.

Then just run `claude` **inside a Neovim `:terminal`** (e.g. sidekick.nvim), or with
`MYSTIQUE_SOCKET=<sock>` pointing at an `nvim --listen <sock>`, or in herdr — it drives
that editor, gets the playbook + capabilities + keymaps injected, and the builtin file
tools are blocked. **Anywhere else nothing changes**: the hooks are inert, the MCP
server exposes no tools, and nothing is injected. `MYSTIQUE_POLICY=off` keeps the
nvim tools but lifts the blocking.

The global setup deliberately adds no `permissions.deny` (a deny can't be conditional,
so it would cripple plain `claude`); the hooks do the blocking. For a project that
should *always* be editor-only, `settings.json` here is a stricter template that adds
the deny list — replace `ABS_PATH_TO_MYSTIQUE` and merge into `.claude/settings.json`.
`CLAUDE.md` needs no copying: the context hook injects it.

The hooks run on bare `node` (no build step). `guard-bash.mjs` saves buffers through
`nvim --server $MYSTIQUE_SOCKET` (falls back to `$NVIM`) before allowed commands.

## Tests

```bash
npm test   # bash classifier (blocked vs allowed) + context hook injection
```

Runs in CI. The hook wiring itself (stdin event → exit code) depends on Claude Code's
runtime and is exercised manually; see milestone 4 in [../CLAUDE_CODE_PLAN.md](../CLAUDE_CODE_PLAN.md).
