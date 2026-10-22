# Mystique — Initial Plan

A specialized [pi](https://github.com/earendil-works/pi) coding agent that works like a real Neovim power user.
The agent does **all** navigation, search, editing and verification through a live Neovim instance instead of
editing files directly. The human watches both sides at once: the pi session in one herdr pane, and Neovim
visibly navigating and editing in the pane beside it.

## Goals

- **Edit through the editor, not the filesystem.** No direct file writes; every change happens in Neovim buffers.
- **Visible.** Every motion, `:` command, quickfix list and LSP action shows up in the Neovim pane in real time.
- **Power-user efficiency.** Prefer the smartest, shortest command: LSP rename/code actions, `:cdo`, `:g` + `:norm`,
  text objects, dot-repeat, macros, registers. Minimize keystrokes *and* tokens.
- **Editor-first verification.** Use language servers and editor diagnostics first, then tests.
- **Token-efficient feedback.** The agent never scrapes the screen or re-reads whole files; it gets compact,
  structured state snapshots and changed-line diffs.

## Verified feasibility

Checked on the dev machine:

| Check | Result |
|---|---|
| herdr 0.9.5 | Installed; pi runs inside herdr (`HERDR_ENV=1`). |
| herdr control | `pane split --direction right --no-focus`, `pane run`, `pane read`, `pane send-keys`, `pane rename` all available. |
| Neovim 0.12.6 | NvChad config with LSP, lspsaga, harpoon, oil, conform, testing, treesitter text objects. |
| RPC proof of concept | `nvim --listen sock` + `--remote-send 'gg/y<CR>ciwz<Esc>:w<CR>'` edited and saved a file; `--remote-expr` returned mode, file, cursor, diagnostics and attached LSP clients as JSON. |

## Architecture

```
┌──────────────────── herdr tab ─────────────────────┐
│ pane A: pi + nvim-dev extension                    │ pane B: nvim --listen $SOCK
│   tools ──── msgpack-RPC over unix socket ───────▶ │   (user config + mystique.lua helper)
│   herdr CLI (split / rename / read) ─────────────▶ │
└────────────────────────────────────────────────────┘
```

- **Transport:** official `neovim` npm client attached to the socket (persistent, async, event subscriptions).
- **Visibility:** input goes through `nvim_input`, the same path as real typing, so everything renders in pane B.
- **Agent "eyes":** structured JSON snapshots produced by a Lua helper module inside Neovim.
  `herdr pane read` is only a fallback for floating UIs (Telescope, lazygit, etc.).

## Project layout (planned)

```
extension/
  index.ts          # session_start + /nvim command, tool registration, policy guards
  nvim.ts           # RPC client, pacing, snapshot/diff helpers
  lua/mystique.lua  # loaded via: nvim --listen $SOCK -c "luafile .../mystique.lua"
  prompt.md         # Neovim power-user playbook injected via before_agent_start
  package.json      # dependency: neovim
```

Installed by symlinking or adding to pi's extension paths (`~/.pi/agent/extensions/nvim-dev`).

## Expected behavior

### Startup
1. `/nvim` (or automatically on `session_start`) checks `HERDR_ENV=1`.
2. `herdr pane split --current --direction right --cwd $PWD --no-focus`.
3. `herdr pane run <pane> "nvim --listen /tmp/pi-nvim-<session>.sock -c 'luafile …/mystique.lua'"`.
4. Wait for the socket, attach the RPC client, rename the pane to `nvim (pi)`.
5. Read the user's leader mappings (`nvim_get_keymap`) and build a compact cheat sheet for the prompt.

### Tools

Small tool set. Each tool returns a compact snapshot.

| Tool | Purpose | Mechanism |
|---|---|---|
| `nvim_keys(keys)` | Motions and edits: `ciw`, `dap`, `.`, macros, `*`, `%`, `>i{` | `nvim_input` → snapshot |
| `nvim_ex(cmd)` | `:g/x/norm A;`, `:cdo s//y/ \| up`, `:%s`, `:norm`, `:e`, `:b` | Typed visibly on the `:` line; output captured via `execute()` |
| `nvim_insert(text)` | Inserting larger blocks of new code | `nvim_paste` (single undo step, bypasses auto-pairs/completion) |
| `nvim_view(range?)` | Replaces `read` | Numbered lines from the live buffer, not disk |
| `nvim_grep(pattern)` | Project search | `:grep` (ripgrep) → visible quickfix list → compact `file:line` hits |
| `nvim_lsp(action)` | definition, references, rename, code action, hover, symbols, diagnostics | Trigger the user's real keymaps (visible); collect results via `buf_request_sync` / quickfix |
| `nvim_check()` | Verification | `:wa`, wait for diagnostics to settle, return errors only; optionally run tests (neotest / `:terminal`) |

### Snapshot format

```json
{"mode":"n","file":"src/a.ts","cur":[42,7],"mod":true,
 "changed":[[40,44]],"ctx":"40│…\n41│…\n42│▌…","diag":{"E":1,"W":0},
 "msg":"E492: Not an editor command","blocking":false}
```

- `changed` comes from `nvim_buf_attach` line events, so the model sees only what changed, never whole files.
- `blocking` comes from `nvim_get_mode()` and catches hit-enter, swap-file and confirm prompts before they hang.

### Policy (enforcing the "real developer" behavior)
- Disable built-in `edit`, `write` and `read` via `pi.setActiveTools()`.
- `tool_call` guard on `bash`: block `sed -i`, `cat >`, `perl -pi`, `tee`, etc. with reason "edit through nvim".
- Auto-run `:wa` before any allowed `bash` call (git, tests) so disk matches buffers.

### Prompt playbook

Preference order the agent is taught:
1. LSP rename / code actions
2. `:cdo` / `:g` + `:norm` for multi-location changes
3. Text objects, dot-repeat, macros
4. Registers for copying (`"ayip`, `<C-r>a`)
5. `nvim_insert` only for genuinely new code

Plus a ~40-line cheat sheet of the user's own mappings (harpoon, oil, lspsaga, …).

### Visual feedback for the human
- Pacing modes via `/nvim-speed demo|fast`: demo sends keys in small chunks (~30 ms apart) so they can be followed;
  fast sends them at once.
- A `🤖 pi: <action>` winbar/notification in Neovim while a tool runs.
- A custom pi tool renderer showing the keys sent, e.g. `⌨ ciw → foo`.

## Known pitfalls to design for

1. **Auto-pairs / completion corrupt typed insert-mode text.** Use `nvim_paste`, or pause those plugins while the
   agent types (`vim.g.pi_agent`).
2. **Format-on-save (conform) rewrites buffers.** Always re-snapshot after `:w`.
3. **Simultaneous human input.** Show a "pi is typing" indicator/lock; check mode before sending input.
4. **LSP not ready yet.** Wait for the language server to attach/settle before trusting diagnostics.
5. **tmux-aware `<C-h/j/k/l>` mappings** in the user config shell out to tmux, which doesn't exist under herdr.
   Use `:wincmd` in tools.
6. **Blocking prompts** (swap files, `Press ENTER`, confirms) must be detected and resolved, never left hanging.

## Status

- [x] Visible proof of concept: herdr split, RPC, `nvim_keys` + snapshots
- [x] `nvim_ex`, `nvim_insert`, `nvim_view`, policy (built-in file tools off, bash guard, auto `:wall`)
- [x] `nvim_grep`, `nvim_lsp`, `nvim_check`
- [x] Prompt playbook, keymap cheat sheet, custom TUI renderers, pacing modes
- [x] Human activity detection + guard (shared editor)
- [x] Watchdog for blocking prompts
- [ ] Evaluation suite (5-10 tasks; tokens/keystrokes vs plain pi)
- [ ] Run tests inside nvim (neotest / `:terminal`) and read results
- [ ] Close stale quickfix windows / tidy layout between tasks

## Build order

1. **Visible proof of concept:** spawn the split, attach RPC, `nvim_keys` + snapshot.
2. `nvim_ex`, `nvim_insert`, `nvim_view`, and the policy disabling `edit`/`write`/`read`.
3. `nvim_grep` + `nvim_lsp`.
4. `nvim_check` + test running.
5. Prompt playbook, keymap cheat sheet, custom tool renderer, pacing modes.
6. **Evaluation:** 5–10 representative tasks, comparing tokens and keystrokes against plain pi.
