# Plan — Neovim-driven editing in Claude Code

Goal: get the same capability we have in pi — the agent does *all* reads, edits and
verification through a live, visible Neovim, with the filesystem read/write tools
disabled — working inside Claude Code.

Claude Code can't load pi extensions (no `defineTool`, no `extensions` setting, no
builtin-tool disabling API). Its extension surface is **MCP servers** (to add tools)
plus **hooks** and **settings** (to constrain the builtin tools). So the port is:
expose our `nvim_*` tools as an MCP server, and use a PreToolUse hook to steer the
model away from `Read`/`Edit`/`Write`.

## What is already portable (harness-agnostic)

From `extension/nvim.ts` — none of this imports the pi SDK:

- `detectMode()` — picks embedded (`$NVIM`) / external (`PI_NVIM_SOCKET`) / herdr.
- `NvimSession` — attaches the `neovim` npm client over the unix socket, runs
  `nvim_input`, drives the `pi_agent.lua` helper, returns `Snapshot` objects.
- `lua/pi_agent.lua` — the in-editor helper (snapshots, changed-line diffs, activity
  guard, screen capture, keymap cheat sheet).
- The `Snapshot` protocol and all the snapshot/diff formatting.

Only `extension/index.ts` is pi-specific: `defineTool`, the TUI renderers, and the
`DISABLED_BUILTINS` list. That file gets replaced by an MCP adapter.

## Architecture

```
┌── terminal / tmux / weztab ─────────────────────────────┐
│ claude  ── stdio ──▶ mcp-nvim server (node)             │
│                         │                                │
│                         └── msgpack-RPC ──▶ nvim --listen $SOCK
│                                                (user config + pi_agent.lua)
│ PreToolUse hook: deny Read/Edit/Write/Grep/Glob,         │
│   point the model at the nvim_* MCP tools                │
└──────────────────────────────────────────────────────────┘
```

## Work breakdown

### 1. Extract the shared core into a package
- Move `nvim.ts` + `lua/pi_agent.lua` + `prompt.md` into a `core/` module that has
  no pi imports. `extension/index.ts` (pi) and the new MCP server both depend on it.
- Keeps one source of truth for the session, the Lua helper and the playbook text.

### 2. Build the MCP server (`mcp-nvim`)
- A stdio MCP server (TypeScript, `@modelcontextprotocol/sdk`) that registers the
  same tools: `nvim_keys`, `nvim_ex`, `nvim_insert`, `nvim_view`, `nvim_grep`,
  `nvim_lsp`, `nvim_check`, `nvim_screen`, `nvim_tests`.
- Each tool body is the existing `NvimSession` call; return the snapshot text as the
  tool result (drop the pi-only `details`/renderer object — Claude Code shows text).
- Reuse `detectMode()` so it stays inert when no Neovim is reachable.
- Register it: `claude mcp add nvim -- node /path/to/mcp-nvim/dist/index.js`
  (or a `.mcp.json` entry so it loads in every project).

### 3. Disable the builtin file tools (the hard part)
Claude Code has no API to delete `Read`/`Edit`/`Write`. Two layers:
- **`permissions.deny`** in settings: deny `Edit`, `Write`, `Read`, `Grep`, `Glob`,
  and the bash escapes (`Bash(sed -i:*)`, redirects, `Bash(cat:*)`, `Bash(rg:*)`).
- **PreToolUse hook**: a script that returns a deny decision for those tools with a
  message like "edit through the nvim_* MCP tools" — the equivalent of our
  `DISABLED_BUILTINS` + bash guard. This is what actually forces the model over.
- Save-before-bash: a PreToolUse hook on `Bash` that first calls the MCP server's
  "save all buffers" path (mirrors our "all buffers saved before every bash call").

### 4. Teach the model the workflow
- Put the `prompt.md` playbook + the keymap cheat sheet into `CLAUDE.md` (project or
  `~/.claude/CLAUDE.md`) so every session gets the Neovim-power-user instructions and
  the user's mappings, the way the pi extension injects them.

### 5. Parity checklist
- [ ] Shared editor activity guard (cursor-sensitive tools no-op after a human edit).
- [ ] Embedded focus handling (move out of the pi/claude terminal window, bounce back).
- [ ] neotest results via `nvim_tests`.
- [ ] Keymap cheat sheet generation + `<leader>` expansion.
- [ ] `/nvim*`-style controls → expose as MCP tools or slash-command scripts.

## Open questions / limits
- A denied builtin still costs a round-trip (hook deny → model retries). pi removes
  the tools outright, which is cleaner; Claude Code can only refuse them.
- MCP tool results are plain text — we lose the rich TUI renderers, but the model
  sees the same snapshot text, which is what matters.
- Confirm hook deny semantics can fully block `Read`/`Write` in the installed Claude
  Code version before committing to the approach.

## Milestones
1. `core/` extracted; pi extension still green against it.
2. `mcp-nvim` server driving Neovim end to end (manual test, no guard).
3. Permissions + PreToolUse hooks enforcing editor-only edits.
4. `CLAUDE.md` playbook + keymaps; run the shipping/fibonacci TDD flow in Claude Code.
5. Activity guard + focus parity.
