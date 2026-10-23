#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for Bash. Mirrors the pi extension's bash guard:
 *   1. Block shell commands that bypass the editor (sed -i, cat/rg/grep/find, redirects…).
 *   2. Otherwise save all Neovim buffers first, so the shell sees current content.
 *
 * Claude Code runs this with the tool-call event as JSON on stdin. Exit 2 blocks the
 * call and shows stderr to the model; exit 0 allows it. Register under
 * hooks.PreToolUse with matcher "Bash".
 */
import { spawnSync } from "node:child_process";
import { blockMessage, classifyBash } from "./bash-policy.mjs";

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let event = {};
  try {
    event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    event = {};
  }
  const command = String(event?.tool_input?.command ?? "");

  const what = classifyBash(command);
  if (what) {
    process.stderr.write(`${blockMessage(what)}\n`);
    process.exit(2);
  }

  // Allowed: save all buffers so the command runs against current content (best effort).
  const sock = process.env.MYSTIQUE_SOCKET || process.env.NVIM;
  if (sock) {
    spawnSync("nvim", ["--server", sock, "--remote-send", "<C-\\><C-n>:silent! wall<CR>"], {
      stdio: "ignore",
      timeout: 3000,
    });
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
