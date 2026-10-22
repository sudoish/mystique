# Plan — config-agnostic operation + capability discovery

## Problem

Today the agent leans on the *user's personal keymaps* for high-level actions:
`<leader>fm` to format, `<leader>tt`/`<leader>tf`/`<leader>ts` to run tests, treesitter
text-object maps (`daf`, `]f`, `<leader>xa`). Those only exist in configs like this one.
On a vanilla or differently-configured Neovim the agent has no format/test path.

Meanwhile the low-level surface is already config-agnostic: `nvim_ex` runs any `:command`,
`nvim_lsp` talks to whatever LSP is attached, and `M.tests` calls `require('neotest')`
directly (not a keymap). So the fix is to push *every* high-level action down to native
`:commands` / Lua APIs, and to **discover** per-user what backs each action.

## Principles

1. **Prefer native `:commands` and Lua APIs over keymaps.** `vim.lsp.buf.format()`,
   `require('neotest').run.run()`, built-in `gc`, `:vimgrep`/`grepprg`, `=`/`gq`.
2. **Discover, don't assume.** On connect, probe what the config supports and inject a
   `<nvim_capabilities>` manifest. Keymaps become an optional *convenience* layer, not
   the contract.
3. **One stable verb surface.** The agent calls the same action ("format", "test file")
   regardless of config; the in-editor helper dispatches to whatever backs it, with
   graceful fallbacks.

## Capability discovery (`M.capabilities()` in pi_agent.lua)

Run once on connect (cache like the keymap sheet). Returns a manifest:

| Capability | Probe | Fallback chain |
|---|---|---|
| Neovim version | `vim.version()` | — |
| LSP | `vim.lsp.get_clients()` + per-buffer | drives rename/refs/format/actions |
| Formatter | `pcall(require,'conform')` → `require('conform')` | conform → `vim.lsp.buf.format()` → `gggqG`/`=` |
| Test runner | `pcall(require,'neotest')`; else `:TestFile` exists? (vim-test) | neotest → vim-test → bash |
| Comment | Neovim ≥ 0.10 built-in `gc` | `gc` → Comment.nvim → manual |
| Treesitter | `pcall(require,'nvim-treesitter')`; textobjects module? | ts text objects → plain motions |
| Grep | `vim.o.grepprg` (ripgrep?) | rg → `:vimgrep` |
| File explorer | oil / netrw | — (we use `:e` anyway) |
| User commands | `getcompletion('', 'command')` | surface relevant `:Cmd`s |

The manifest is injected as a prompt section and tells the agent *which* path is live
(e.g. "format = conform", "tests = neotest", "comment = built-in gc").

## Stable verb surface (remove keymap dependency)

Add helper functions dispatched over RPC (exposed either as new `nvim_*` tool actions or
as `:Pi*` user-commands the setup step defines):

- `format(range?)` → conform.format() → vim.lsp.buf.format() → `gggqG`.
- `test_run(scope)` where scope ∈ nearest|file|suite:
  - neotest: `require('neotest').run.run(file|nil|{suite=true})`
  - vim-test: `:TestNearest` / `:TestFile` / `:TestSuite`
  - else: report "no runner; use bash".
- Keep `M.tests` (read results) as-is — already backend-driven.

These replace the prompt's `<leader>fm` / `<leader>tt` instructions.

## Setup step

"Setup" = what runs on connect, before the first agent action:

1. Load `pi_agent.lua` into the editor (already happens).
2. Define the `:Pi*` user-commands (format/test) so there is always a stable command
   surface, whatever the user's config.
3. Run `M.capabilities()`, cache to `~/.cache/pi-nvim-dev/capabilities.json`, and build
   the `<nvim_capabilities>` prompt section.
4. Keep the keymap cheat sheet, but demote it in the prompt to "optional shortcuts".
5. Expose `/nvim-capabilities` (like `/nvim-keymaps`) to show the manifest to the human.

## Prompt changes (prompt.md)

- Reorder "tool choice" to: LSP → native `:commands` / `:Pi*` verbs → `nvim_ex`
  structural edits → `nvim_keys` motions → `nvim_insert`.
- Replace the "prefer the user's mappings" paragraph with "a `<nvim_capabilities>`
  manifest tells you what's available; use the stable format/test verbs. The keymap
  sheet lists optional shortcuts you *may* use but never need."
- Tests section: call the stable test verb instead of `<leader>t*`.

## Milestones

1. `M.capabilities()` probe + `/nvim-capabilities` + cached manifest injected.
2. (done) `format` verb (conform -> LSP -> gq) wired as `nvim_format`; the format keymap dropped from prompt.
3. `test_run` verb (neotest → vim-test) wired; drop `<leader>t*` from the prompt.
4. Prompt rewrite; keymaps demoted to optional.
5. Validate on this config *and* a stock `nvim -u NONE`-ish config (no neotest/conform).
