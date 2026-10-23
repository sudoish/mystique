# Mystique — drive the live Neovim

This project uses **Mystique**: you edit through a live, visible Neovim via the
`nvim_*` MCP tools, never the builtin file tools. `Read`/`Edit`/`Write`/`Grep`/`Glob`
are denied; use the editor. `Bash` is only for git, tests and builds — not for reading
(`cat`/`head`), searching (`rg`/`grep`/`find`) or editing (`sed -i`, redirects) files.
Buffers are saved automatically before each allowed bash call.

Be economical: tokens scale with round-trips, so do the most per call and the fewest
calls. Trust the snapshot each tool returns (mode, file:line:col, cursor context,
diagnostics, changed lines); do NOT re-read what you just saw or re-view to confirm an
edit. Prefer one `nvim_ex` (`%s`, `g/…/…`, `:cdo … | update`) or one LSP action over
many `nvim_keys`. Batch motions into one `nvim_keys` call; use `.` and macros to repeat.

Tool choice, smartest first:
1. `nvim_lsp` — `rename` (jump to the declaration with `definition` first; renaming at
   an import makes an alias), `definition`/`references` to navigate,
   `code_actions`+`apply_code_action` for fixes/imports. Never rename by hand.
2. `nvim_grep` (scope with `path`, not `glob`) → hits grouped by file, or per-file counts when there are many
   (narrow, don't raise `limit` by reflex). Every hit is in quickfix: `nvim_ex` `cdo s/old/new/g | update`.
   Sharpen with `word` (whole word), `literal` (no regex escaping), `case`; `context: 2` shows surrounding lines
   so you can skip a follow-up `nvim_view`. To find a file by name use `nvim_find` (fuzzy, best first).
3. `nvim_ex` for structural edits: `%s/\<old\>/new/g`, `g/pat/norm A;`, `g/pat/d`,
   `10,20norm I// `, `e path`, `b name`.
4. `nvim_keys` for local edits with motions/text objects: `ciw`, `ci"`, `da(`, `dap`,
   `>i{`, `*`, `n`, `.`, `%`, counts, macros (`qa…q`, `@a`), registers (`"ayy`, `"ap`).
   Search moves the cursor (`/pat<CR>`); jump to a line with `42G`. Vim notation:
   `<CR>`, `<Esc>`, literal `<` is `<lt>`. End in Normal mode.
5. `nvim_insert` only for genuinely new text (pastes literally, so auto-pairs can't corrupt it).
6. `nvim_format` to format; `nvim_test` (scope nearest|file|suite) to run tests and read results.

Verify with `nvim_check` (saves all buffers, returns settled LSP diagnostics) before
running tests. If a snapshot shows a `BLOCKING` prompt or an error, resolve it first
(often `<Esc>`). Where a capability is absent (no LSP attached, no test runner), fall
back to `bash` or hand-editing.

Reaching the editor: the `nvim` MCP server connects to `MYSTIQUE_SOCKET` (an
`nvim --listen` you started), `$NVIM` (Claude running in a Neovim terminal), or herdr.
If the tools report "No Neovim to drive", start one and set `MYSTIQUE_SOCKET`.
