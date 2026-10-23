#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for the builtin file tools (Read/Edit/Write/Grep/Glob/LS/
 * NotebookEdit). Blocks them and tells the model to use the nvim_* MCP tools instead —
 * the belt-and-suspenders layer behind permissions.deny, and the one that carries the
 * redirect message. Exit 2 = block, stderr shown to the model.
 *
 * Register under hooks.PreToolUse with matcher "Read|Edit|Write|Grep|Glob|LS|NotebookEdit".
 */
const MAP = {
  Read: "nvim_view (live buffer contents)",
  Edit: "nvim_keys / nvim_ex / nvim_insert, or nvim_lsp rename",
  Write: "nvim_ex `e <path>` then nvim_insert",
  Grep: "nvim_grep",
  Glob: "nvim_find (fuzzy file names) or nvim_grep",
  LS: "nvim_ex `:!ls` is fine, or just nvim_view a file",
  NotebookEdit: "the nvim_* editing tools",
};

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let tool = "";
  try {
    tool = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")?.tool_name ?? "";
  } catch {
    tool = "";
  }
  const alt = MAP[tool] ?? "the nvim_* MCP tools";
  process.stderr.write(
    `Mystique drives a live Neovim: don't use ${tool || "the builtin file tools"}. Use ${alt}. ` +
    "All navigation, reading and editing goes through the nvim_* MCP tools so the human sees it.\n",
  );
  process.exit(2);
}

main().catch(() => process.exit(2));
