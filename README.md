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
| `/nvim-speed demo\|fast` | Paced, watchable typing (default) or instant |
| `/nvim-close` | Quit Neovim and close its pane |

| Env var | Effect |
|---|---|
| `PI_NVIM_SOCKET=<sock>` | Attach to an existing `nvim --listen <sock>` instead of spawning one |
| `PI_NVIM_SPEED=fast` | Start in fast mode |
| `PI_NVIM_POLICY=off` | Keep the built-in read/edit/write tools and don't guard bash |
| `PI_NVIM_CLOSE=1` | Close the Neovim pane when the pi session ends |

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
