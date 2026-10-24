# Mystique

**Your coding agent edits code through your Neovim, live, instead of writing files behind your back.**

Mystique gives an AI coding agent ([pi](https://github.com/earendil-works/pi) or Claude Code) a set of
`nvim_*` tools and takes away its direct file access. Every search, edit, rename, format and test run
then happens in a Neovim you can see, as motions, `:` commands and LSP actions, using your own setup.

## Why it matters

- **You see every change as it happens.** Edits land in buffers you're watching, not in files you have to
  diff afterwards. Undo, your git tools and your usual review habits all still work.
- **The agent uses real editor tools.** A rename is an LSP rename across the project, not find-and-replace on
  text. Formatting goes through your formatter and tests through your test runner (conform/LSP/`gq`,
  neotest/vim-test), all discovered automatically with nothing to configure per project.
- **The editor is shared.** If you type, move the cursor or switch buffers between the agent's steps,
  Mystique notices. The agent's next cursor-dependent action is skipped and it re-plans around what you did.
- **The same tools work in pi and Claude Code.** Both agents get the same playbook and the same guardrails.

## How it works

```
 agent (pi / Claude Code)
   │  nvim_keys · nvim_ex · nvim_lsp · nvim_grep · nvim_test · …     builtin read/edit/write: blocked
   ▼
 Mystique ── msgpack-RPC ──▶ your Neovim  (+ a small Lua helper, core/lua/mystique.lua)
   ▲                              │
   └── compact snapshot ◀─────────┘   mode, file:line:col, cursor context, changed lines, diagnostics
```

1. **It connects to a Neovim.** It uses whichever it finds first: the editor the agent is running inside
   (a `:terminal`, detected via `$NVIM`), `MYSTIQUE_SOCKET=<sock>` for an `nvim --listen <sock>` you
   started, or a new pane in [herdr](https://github.com/earendil-works/herdr) or [Rex](https://rex.computer).
   With none of these it stays **inert** and your agent behaves exactly as before.
2. **It tells the agent about your editor.** The agent gets a short playbook, the backends your config
   provides (LSP, formatter, test runner, treesitter) and a cheat sheet of your keymaps.
3. **It keeps edits inside the editor.** Builtin file tools are turned off (pi) or blocked by hooks
   (Claude Code). Bash commands that would bypass the editor (`sed -i`, `cat`, `rg`, redirects) are
   refused, and all buffers are saved before any allowed bash command.
4. **The agent works through `nvim_*` tools.** Keystrokes go through `nvim_input` like real typing. Each
   call returns a compact snapshot of the editor state rather than whole files.

## Install

You need Neovim 0.10+, Node.js 20+, and pi or Claude Code. ripgrep is recommended.

**Easiest: paste this into pi or Claude Code:**

```text
Install Mystique for me: clone https://github.com/sudoish/mystique into ~/.local/share/mystique
(or git pull if it's already there), run `sh ~/.local/share/mystique/install.sh`, then walk me
through fixing every ✖ or ! item that `mystique doctor` reports until it's all green.
```

**Or run it yourself:**

```bash
curl -fsSL https://raw.githubusercontent.com/sudoish/mystique/main/install.sh | sh
```

The installer clones the repo to `~/.local/share/mystique`, installs its dependencies and enables Mystique
for each agent it finds: pi through `pi install`, Claude Code through a user-scope MCP server plus hooks
(your settings are backed up first). It then links a `mystique` command into `~/.local/bin` and ends by
running **`mystique doctor`**. The doctor checks every prerequisite and integration and prints the fix
for anything missing. You can re-run the installer at any time.

```bash
mystique doctor                    # check prerequisites + integrations
mystique install [pi] [claude]     # (re)enable for specific agents
mystique update                    # pull the latest version, refresh everything
mystique uninstall [pi] [claude]   # remove it again
```

pi only, without the CLI: `pi install git:github.com/sudoish/mystique`.

## Use

Run your agent **inside Neovim**, for example in a `:terminal` split or via
[sidekick.nvim](https://github.com/folke/sidekick.nvim), then give it a task:

```text
Rename calc to cartTotal everywhere, fix the type errors, add withDiscount(total, pct) to
src/cart.ts, then run the tests.
```

The agent picks the shortest editor-native path it can: an LSP rename, `:cdo`/`:g`/`:norm` for
structural edits, text objects and `.` for local ones, `nvim_format`, and `nvim_test` until the tests
pass.

**Tools:** `nvim_keys`, `nvim_ex`, `nvim_insert`, `nvim_view`, `nvim_grep`, `nvim_find`, `nvim_lsp`,
`nvim_format`, `nvim_test`, `nvim_tests`, `nvim_check`, `nvim_screen`, and `nvim_capabilities` (Claude Code).

**pi commands:** `/nvim` (connect), `/nvim-keymaps`, `/nvim-capabilities`, `/nvim-speed demo|fast`
(paced, watchable typing or instant), `/nvim-close`.

| Environment variable | Effect |
|---|---|
| `MYSTIQUE_SOCKET=<sock>` | Drive an `nvim --listen <sock>` you started |
| `MYSTIQUE_POLICY=off` | Keep the agent's builtin file tools (no blocking) |
| `MYSTIQUE_SPEED=fast` | Instant typing instead of paced (pi) |
| `MYSTIQUE_AUTOSTART=0` | Don't connect when pi's TUI starts |
| `MYSTIQUE_REFOCUS=0` | Leave the cursor in the editor after each run (embedded pi) |
| `MYSTIQUE_CLOSE=1` | Close a herdr/Rex-spawned Neovim when the session ends |
| `MYSTIQUE_KEYMAP_DENY=<regex>` | Which mappings to leave out of the keymap cheat sheet |

## Status

Mystique works day to day with pi and Claude Code. An [A/B evaluation](eval/RESULTS.md) against plain pi
gives an honest picture so far:
- **Semantic, multi-site changes win clearly.** A project-wide rename through the LSP used **18% fewer
  tokens and 79% fewer tool calls**.
- **Small single-file fixes cost more tokens.** The extra cost of the editor round-trips outweighs the
  benefit there.

Next up: Claude Code equivalents of pi's `/nvim*` commands, and more eval tasks.

## Development

```
core/       harness-agnostic engine: NvimSession (RPC), mystique.lua, snapshots, playbook
extension/  pi adapter (tools, TUI renderers, guards, slash commands)
mcp-nvim/   MCP server exposing the same tools to Claude Code and other MCP agents
claude/     Claude Code hooks, installer and playbook
bin/        the `mystique` CLI (install / doctor / update)
eval/       A/B evaluation harness · demo/, demo-tests/: fixtures
```

```bash
sh install.sh                                          # install your checkout in place
cd core && npm install && npm run check && npm test   # engine (integration test needs nvim)
cd ../mcp-nvim && npm install && npm test              # MCP server end to end against a headless nvim
```

CI runs every package's typecheck and tests, plus a fresh-install-and-doctor run, on each push.
Details: [mcp-nvim/README.md](mcp-nvim/README.md), [claude/README.md](claude/README.md),
[eval/README.md](eval/README.md).

## License

MIT
