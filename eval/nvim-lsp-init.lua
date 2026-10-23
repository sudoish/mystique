-- Opt-in LSP bootstrap for the eval's headless Neovim (used when run-eval is passed
-- --lsp). No plugins: it starts whatever `typescript-language-server` is on PATH for
-- TS/JS buffers, so Mystique's capability probe reports a live LSP and the agent can
-- use nvim_lsp (rename/definition/code actions) instead of a :cdo sweep.
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "typescript", "javascript", "typescriptreact", "javascriptreact" },
  callback = function(args)
    if vim.fn.executable("typescript-language-server") == 0 then
      return
    end
    local root = vim.fs.root(args.buf, { "tsconfig.json", "package.json", ".git" }) or vim.fn.getcwd()
    vim.lsp.start({
      name = "ts_ls",
      cmd = { "typescript-language-server", "--stdio" },
      root_dir = root,
    })
  end,
})
