# mcp-nvim

An [MCP](https://modelcontextprotocol.io) server that exposes Mystique's `nvim_*`
tools so **any MCP-capable agent** — Claude Code, etc. — can drive a live, visible
Neovim, the same way the pi extension does. The tool bodies come from
[`@mystique/core`](../core); this package is just the MCP adapter.

## Tools

`nvim_keys`, `nvim_ex`, `nvim_insert`, `nvim_view`, `nvim_grep`, `nvim_find`, `nvim_lsp`,
`nvim_check`, `nvim_tests`, `nvim_test`, `nvim_screen`, `nvim_format` — each returns
the compact snapshot text (mode, file:line:col, cursor context, diagnostics, changed
lines) the model reasons over.

## Reaching Neovim

Like the extension, in priority order: **external** (`MYSTIQUE_SOCKET=<sock>` from an
`nvim --listen <sock>` you started), **embedded** (`$NVIM`, i.e. pi/claude running in
a Neovim `:terminal`), or **herdr**. With none reachable, every tool returns a clear
error instead of hanging.

## Install & run

```bash
cd core && npm install          # engine deps (neovim)
cd ../mcp-nvim && npm install    # MCP SDK + tooling
```

Register it with Claude Code (TypeScript is run through tsx):

```bash
# Terminal 1: an editor the server will drive
nvim --listen /tmp/nvim.sock

# Terminal 2: register the server (adjust the path)
claude mcp add nvim \
  --env MYSTIQUE_SOCKET=/tmp/nvim.sock \
  -- node --import tsx /abs/path/to/mystique/mcp-nvim/index.ts
```

Or add it to a project `.mcp.json`:

```json
{
  "mcpServers": {
    "nvim": {
      "command": "node",
      "args": ["--import", "tsx", "/abs/path/to/mystique/mcp-nvim/index.ts"],
      "env": { "MYSTIQUE_SOCKET": "/tmp/nvim.sock" }
    }
  }
}
```

To make the agent *prefer* these tools (and stop using its own file read/edit/write),
deny those built-ins and drop the Mystique playbook into `CLAUDE.md` — see
[../CLAUDE_CODE_PLAN.md](../CLAUDE_CODE_PLAN.md) milestones 3–4 (not yet automated).

## Development

```bash
npm run check   # strict type-check
npm test        # in-memory MCP client drives a headless nvim through the server
```

`index.test.ts` links an in-memory client to the server and runs `nvim_ex` /
`nvim_view` / `nvim_keys` against a real `nvim --listen`; it skips when `nvim` isn't
on `PATH`. Runs in CI.
