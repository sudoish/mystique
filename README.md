# Mystique

**Let any coding agent shapeshift into a Neovim power user.**

Mystique turns your coding agent into a Neovim operator: it navigates, searches, edits and verifies
code through a **live, visible Neovim** instead of writing files behind your back. You watch every motion,
`:` command, LSP rename and test run happen in your editor, in real time.

Like its namesake, Mystique adapts to whatever it finds: it uses your attached LSP servers, your formatter
(conform, else LSP, else `gq`), and your test runner (neotest, else vim-test) — no project-specific wiring.
And it is agent-agnostic: today it drives [pi](https://github.com/earendil-works/pi); Claude Code is on the
roadmap (see [CLAUDE_CODE_PLAN.md](CLAUDE_CODE_PLAN.md)).

## Why

- **Edit through the editor, not the filesystem.** Every change happens in a Neovim buffer you can see and undo.
- **Config-agnostic.** Mystique discovers your LSP, formatter and test runner and uses them. It does not need
  your personal keymaps.
- **Shared.** You and the agent share one editor. Edits, cursor moves and mode changes you make between the
  agent's tool calls are detected; cursor-sensitive actions pause and the agent re-plans around you.
- **Token-efficient.** The agent gets compact, structured snapshots and changed-line diffs, not whole-file dumps.

## Requirements

- **Neovim** 0.10+ (0.11+ recommended).
- **A coding agent** — currently [pi](https://github.com/earendil-works/pi).
- **One way for Mystique to reach a Neovim**, in priority order:
  - **Embedded** — run pi inside a Neovim `:terminal` split (e.g. with
    [sidekick.nvim](https://github.com/folke/sidekick.nvim)). Mystique drives *your* editor: your buffers,
    your LSP, your layout. `$NVIM` is detected automatically.
  - **External** — point it at an editor you started with `nvim --listen <sock>`, via `MYSTIQUE_SOCKET=<sock>`.
  - **herdr** — inside a [herdr](https://github.com/earendil-works/herdr) pane, Mystique splits the pane and
    spawns its own `nvim --listen` instance.

Without any of these, Mystique stays inert: the built-in file tools and bash keep working, so a globally
installed copy never cripples plain pi.

## Install

```bash
git clone https://github.com/<you>/mystique.git ~/dev/mystique
cd ~/dev/mystique/core && npm install && cd ../extension && npm install
```

Load it for a single pi run:

```bash
pi -e ~/dev/mystique/extension/index.ts
```

Or make it the default for every pi session — add it to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["~/dev/mystique/extension/index.ts"] }
```

With [sidekick.nvim](https://github.com/folke/sidekick.nvim) you can register pi as a CLI tool so it launches
inside your editor:

```lua
opts = { cli = { tools = {
  ["pi"] = { cmd = { "pi", "-e", vim.fn.expand("~/dev/mystique/extension/index.ts") } },
} } }
```

## Usage

Start pi inside your editor (or in herdr) and give it a task. Mystique connects on the first tool call (or
run `/nvim`) and the agent works in a Neovim window beside your pi terminal.

```
Rename calc to cartTotal everywhere, fix the type errors, add withDiscount(total, pct) to
src/cart.ts, then run the tests.
```

The agent will prefer the smartest, shortest path: LSP rename and code actions, `nvim_format`,
`:cdo`/`:g`/`:norm` for structural edits, text objects and dot-repeat for local ones, and `nvim_test`
to run tests and read results — iterating red → green in your editor.

### Commands

| Command | Effect |
|---|---|
| `/nvim` | Connect: the host editor, `MYSTIQUE_SOCKET`, or a new herdr pane |
| `/nvim-keymaps` | Show the cheat sheet of your mappings given to the agent |
| `/nvim-capabilities` | Show the capability manifest (format/test/LSP/…) given to the agent |
| `/nvim-speed demo\|fast` | Paced, watchable typing (default) or instant |
| `/nvim-close` | Close a herdr-spawned Neovim, or detach from the host editor |

### Environment

| Variable | Effect |
|---|---|
| `MYSTIQUE_SOCKET=<sock>` | Attach to an existing `nvim --listen <sock>` instead of spawning one |
| `MYSTIQUE_SPEED=fast` | Start in fast (instant) typing mode |
| `MYSTIQUE_POLICY=off` | Keep the built-in read/edit/write tools and don't guard bash |
| `MYSTIQUE_CLOSE=1` | Close a herdr-spawned Neovim pane when the session ends |
| `MYSTIQUE_REFOCUS=0` | Embedded mode: leave the cursor in the editor after each run |
| `MYSTIQUE_AUTOSTART=0` | Don't open Neovim automatically when the interactive TUI starts |
| `MYSTIQUE_KEYMAP_DENY=<vim regex>` | Override which mapping descriptions are left out of the cheat sheet |

> The old `PI_NVIM_*` names still work as aliases.

## Tools

The agent edits through these instead of the built-in file tools:

`nvim_keys`, `nvim_ex`, `nvim_insert`, `nvim_view`, `nvim_grep`, `nvim_lsp`, `nvim_format`, `nvim_test`,
`nvim_tests`, `nvim_check`, `nvim_screen`.

While Mystique is active, the built-in `read`/`edit`/`write`/`grep`/`find`/`ls` tools are disabled, and bash
commands that bypass the editor (`sed -i`, redirects, `cat file`, `rg`) are blocked. All buffers are saved
before every allowed bash call.

## How it works

Mystique attaches to Neovim over msgpack-RPC (the official `neovim` npm client) and loads a small Lua helper
(`core/lua/mystique.lua`) that exposes `_G.Mystique`: compact state snapshots, changed-line tracking, a
human-activity guard, LSP helpers, capability discovery, format/test verbs and screen capture. Keystrokes go
through `nvim_input`, the same path as real typing, so everything renders live.

## Roadmap

- Claude Code support via an MCP server + hooks (see [CLAUDE_CODE_PLAN.md](CLAUDE_CODE_PLAN.md)).
- Expand the [evaluation suite](eval/) (more multi-file tasks, cost reporting). First results: [eval/RESULTS.md](eval/RESULTS.md).

## Demo

`demo/` is a tiny TypeScript project with two type errors and a project-local language server;
`demo-tests/` is a Jest project used to exercise the test-driven flow.
`eval/` is the [evaluation harness](eval/README.md) that A/B-compares Mystique against plain pi (tokens, tool calls, success) on these fixtures.

## Layout

- `core/` — harness-agnostic engine (no pi SDK imports): the `NvimSession` RPC
  driver, the `mystique.lua` helper, the `Snapshot` protocol, capability
  rendering and the power-user playbook (`prompt.md`). Shared by the pi extension
  and (planned) an MCP server for other agents.
- `extension/` — the pi adapter: `defineTool` wrappers, TUI renderers, policy
  guards and slash commands. Imports `../core`.
- `eval/` — the A/B evaluation harness. `demo/`, `demo-tests/` — fixtures.

## Development

```bash
cd core && npm install && npm run check && npm test   # engine + its tests (needs nvim for the integration test)
cd ../extension && npm install && npm run check        # pi adapter typecheck (resolves neovim via ../core)
```

`core/nvim.test.ts` unit-tests the pure helpers (e.g. the capability manifest
renderer); `core/nvim.integration.test.ts` spawns a real `nvim --listen` and drives
it through `NvimSession` end to end (skips when `nvim` isn't on `PATH`). CI
(`.github/workflows/ci.yml`) runs core, the extension typecheck, the `eval/`
harness and the `demo-tests` Jest flow on every push and PR.
