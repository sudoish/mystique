# pi-nvim-dev

A pi coding agent that works like a Neovim power user: it navigates, searches, edits and verifies code through a
live, visible Neovim. Either the Neovim you already have open (pi runs in a terminal split inside it, e.g. with
sidekick.nvim), or one it spawns in a herdr pane next to the pi session.

See [PLAN.md](PLAN.md) for the design.

## Usage

```bash
cd extension && npm install   # once
# inside a herdr pane, from your project directory:
pi -e ~/dev/pi-nvim-dev/extension/index.ts
```

On startup the extension picks a Neovim to drive, in this order:

| Mode | Detected by | What happens |
|---|---|---|
| external | `PI_NVIM_SOCKET=<sock>` | Attaches to that `nvim --listen <sock>` |
| embedded | `$NVIM` (pi runs inside a Neovim `:terminal`) | Drives the editor it lives in, over its own socket |
| herdr | `HERDR_ENV=1` | Splits the current herdr pane to the right and starts `nvim --listen <sock>` there |

Without any of these the extension stays inert (built-in tools and bash work as usual) and says so.

### Inside Neovim (sidekick.nvim)

Start pi from a terminal split inside your editor and the agent edits in *your* windows: no second instance,
your buffers, your LSP clients, your layout. With [sidekick.nvim](https://github.com/folke/sidekick.nvim) the
built-in `pi` tool just runs `pi`, so either add the extension to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["~/dev/pi-nvim-dev/extension/index.ts"] }
```

or register an explicit tool in your sidekick config:

```lua
opts = { cli = { tools = {
  ["pi-nvim"] = { cmd = { "pi", "-e", vim.fn.expand("~/dev/pi-nvim-dev/extension/index.ts") } },
} } }
```

How the embedded flow behaves:

- Every tool starts by moving the cursor from the pi terminal into an editor window (the previous window, else
  the largest file window, else a new split). The agent never types into a terminal window: if a mapping lands
  in one while a tool runs (a test output panel, the sidekick split), focus bounces straight back.
- When the agent loop ends, focus returns to the terminal it was taken from, in terminal mode, so you can keep
  typing in pi. Set `PI_NVIM_REFOCUS=0` to leave the cursor in the editor instead.
- The `🤖 pi:` badge sits over the window the agent works in. `nvim_screen` renders the editor's screen to text
  from inside Neovim (terminal windows blanked), so nothing depends on herdr.
- `/nvim-close` and session end only detach: they restore the options the helper changed (`more`, `confirm`,
  `grepprg`, swap-file prompts) and never quit your editor. Only a herdr-spawned instance is ever closed.
- Keystrokes you type while the agent holds focus go to the editor window as normal-mode commands, not to pi.
  The activity guard reports such edits to the agent, but wait for the badge to disappear before typing.

### Inside herdr

Inside herdr (and not inside Neovim), the first `nvim_*` tool call (or `/nvim`) splits the current pane to the
right, starts `nvim --listen <sock>` there with your normal config, and drives it over msgpack-RPC.

| Command | Effect |
|---|---|
| `/nvim` | Connect: the host editor, `PI_NVIM_SOCKET`, or a new herdr pane |
| `/nvim-keymaps` | Show the cheat sheet of your mappings given to the agent |
| `/nvim-speed demo\|fast` | Paced, watchable typing (default) or instant |
| `/nvim-close` | Close a herdr-spawned Neovim, or detach from the host editor |

| Env var | Effect |
|---|---|
| `PI_NVIM_SOCKET=<sock>` | Attach to an existing `nvim --listen <sock>` instead of spawning one |
| `PI_NVIM_SPEED=fast` | Start in fast mode |
| `PI_NVIM_POLICY=off` | Keep the built-in read/edit/write tools and don't guard bash |
| `PI_NVIM_CLOSE=1` | Close a herdr-spawned Neovim pane when the pi session ends |
| `PI_NVIM_REFOCUS=0` | Embedded mode: don't move focus back to the pi terminal after each run |
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

`nvim_keys`, `nvim_ex`, `nvim_insert`, `nvim_view`, `nvim_grep`, `nvim_lsp`, `nvim_check`, `nvim_screen`, `nvim_format`.
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
