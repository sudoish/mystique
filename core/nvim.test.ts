import assert from "node:assert/strict";
import { test } from "node:test";
import { type Caps, renderCapabilities } from "./nvim.ts";

test("renderCapabilities: full-featured config advertises the stable verbs", () => {
  const caps: Caps = {
    nvim: "0.12.6",
    lsp: { attached: ["ts_ls"], active: ["ts_ls", "lua_ls"] },
    format: { backend: "conform", how: "require('conform').format()" },
    test: { backend: "neotest" },
    comment: { backend: "builtin", how: "gc operator (gcc, gcap)" },
    treesitter: { available: true, textobjects: true },
    grep: { prg: "rg --vimgrep", ripgrep: true },
    commands: ["ConformInfo", "EslintFixAll", "Gdiffsplit", "DBUIToggle"],
  };
  const out = renderCapabilities(caps);
  assert.match(out, /Neovim 0\.12\.6/);
  assert.match(out, /format: conform .* use nvim_format/);
  assert.match(out, /test: neotest .* use nvim_test/);
  assert.match(out, /lsp: ts_ls attached/);
  assert.match(out, /treesitter text-objects: yes/);
  assert.match(out, /grep: ripgrep/);
  // Only editing-relevant commands are surfaced.
  assert.match(out, /notable :commands:.*ConformInfo/);
  assert.match(out, /EslintFixAll/);
  assert.doesNotMatch(out, /Gdiffsplit|DBUIToggle/);
});

test("renderCapabilities: bare config tells the agent to fall back", () => {
  const caps: Caps = {
    nvim: "0.10.0",
    lsp: { attached: [], active: [] },
    format: { backend: "builtin", how: "gggqG or =" },
    test: { backend: "none" },
    comment: { backend: "builtin", how: "gc operator" },
    treesitter: { available: false, textobjects: false },
    grep: { prg: "grep -n", ripgrep: false },
    commands: [],
  };
  const out = renderCapabilities(caps);
  assert.match(out, /test: none .* bash/);
  assert.match(out, /lsp: none .* edit by hand/);
  assert.match(out, /treesitter: no .* plain motions/);
  assert.doesNotMatch(out, /notable :commands:/);
});

test("renderCapabilities: LSP active elsewhere nudges opening a real file", () => {
  const out = renderCapabilities({
    nvim: "0.11.0",
    lsp: { attached: [], active: ["ts_ls"] },
    format: { backend: "lsp", how: "vim.lsp.buf.format()" },
    test: { backend: "vim-test" },
    treesitter: { available: true, textobjects: false },
    grep: { ripgrep: true },
  });
  assert.match(out, /none on the current buffer .*active elsewhere: ts_ls/);
  assert.match(out, /treesitter text-objects: no/);
});
