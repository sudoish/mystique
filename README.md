# pi-nvim-dev

A pi coding agent that works like a Neovim power user: it navigates, searches, edits and verifies code through a
live, visible Neovim instance running in a herdr pane next to the pi session.

See [PLAN.md](PLAN.md) for the design.

## Usage

```bash
cd extension && npm install   # once
# inside a herdr pane, from your project directory:
pi -e ~/dev/pi-nvim-dev/extension/index.ts
```

On the first `nvim_*` tool call (or `/nvim`), the extension splits the current herdr pane to the right, starts
`nvim --listen <sock>` there with your normal config, and drives it over msgpack-RPC.

| Command | Effect |
|---|---|
| `/nvim` | Open or attach to the agent's Neovim pane |
| `/nvim-keymaps` | Show the cheat sheet of your mappings given to the agent |
| `/nvim-speed demo\|fast` | Paced, watchable typing (default) or instant |
| `/nvim-close` | Quit Neovim and close its pane |

| Env var | Effect |
|---|---|
| `PI_NVIM_SOCKET=<sock>` | Attach to an existing `nvim --listen <sock>` instead of spawning one |
| `PI_NVIM_SPEED=fast` | Start in fast mode |
| `PI_NVIM_POLICY=off` | Keep the built-in read/edit/write tools and don't guard bash |
| `PI_NVIM_CLOSE=1` | Close the Neovim pane when the pi session ends |
| `PI_NVIM_AUTOSTART=0` | Don't open Neovim automatically when the interactive TUI starts |
| `PI_NVIM_KEYMAP_DENY=<vim regex>` | Override which mapping descriptions are left out of the cheat sheet |

### Shared editor

The editor is shared with you. Edits, cursor moves, buffer switches and mode changes you make between the agent's
tool calls are detected. Cursor-sensitive tools (`nvim_keys`, `nvim_ex`, `nvim_insert`, cursor-based `nvim_lsp`)
then do **not** run. The agent gets a report of what you did (including your edited lines) and re-plans.
Other tools run and include the report.

### Your mappings

On connect, the extension reads your normal, operator-pending and visual mappings that have descriptions. It
filters out pickers, AI, git and terminal UIs, and gives the agent a compact cheat sheet (treesitter text objects
and motions first, then leader maps). It's cached in `~/.cache/pi-nvim-dev/keymaps.txt`, and `<leader>` in
`nvim_keys` is expanded to your leader key.

### Tools

`nvim_keys`, `nvim_ex`, `nvim_insert`, `nvim_view`, `nvim_grep`, `nvim_lsp`, `nvim_check`, `nvim_screen`.
The built-in `read`/`edit`/`write`/`grep`/`find`/`ls` tools are disabled. Bash commands that bypass the editor
(`sed -i`, redirects, `cat file`, `rg`) are blocked, and all buffers are saved before every allowed bash call.

## Demo

`demo/` is a tiny TypeScript project with two type errors and a project-local `typescript-language-server`
(added to nvim's PATH automatically):

```bash
cd demo && npm install
pi -e ../extension/index.ts "Rename calc to cartTotal everywhere, fix all type errors, add withDiscount(total, pct) to src/cart.ts and print a 'Discounted:' line in main.ts. Verify with LSP diagnostics, then run npm run typecheck."
```

First recorded run: 11 tool calls, about 47k input tokens, $0.04. The agent used LSP rename, multi-command `:s`
chains, `nvim_insert` for new code, and `nvim_check` (ts_ls: 0 errors), then confirmed with `tsc --noEmit`.

Interactive run (pi TUI and Neovim side by side in a herdr tab, with a human typing mid-task): the guard blocked
the agent's action after a human edit. The agent read the human's comment ("keep cart.ts pure"), put its code in
`main.ts` instead, and left the human's edit alone.
