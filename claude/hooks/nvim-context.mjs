#!/usr/bin/env node
/**
 * Claude Code SessionStart + UserPromptSubmit hook: give the model the playbook and live editor
 * context the pi extension puts in its system prompt each turn — the capability
 * manifest (<nvim_capabilities>) and the user's keymap cheat sheet (<nvim_keymaps>).
 *
 * The mcp-nvim server keeps both cached as it drives Neovim (see core/cache.ts); this
 * hook only reads the rendered text files, so it has no dependencies and adds ~no latency.
 *
 * Claude Code keeps hook output in the transcript, so unlike pi (which replaces a system
 * prompt section) re-injecting every turn would pile up copies. Instead:
 *   - SessionStart (startup/resume/clear/compact): inject the playbook (claude/CLAUDE.md),
 *     capabilities and keymaps.
 *   - UserPromptSubmit: inject <nvim_capabilities> only when it changed since this
 *     session last saw it (e.g. an LSP attached after opening a source file).
 * Outside Neovim (see active.mjs) it adds nothing, so a global install is harmless.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nvimActive } from "./active.mjs";

export function cacheDir() {
  return process.env.MYSTIQUE_CACHE_DIR || join(homedir(), ".cache", "mystique");
}

/** The power-user playbook (claude/CLAUDE.md), injected so no global CLAUDE.md edit is needed. */
function readPlaybook() {
  return read(join(dirname(fileURLToPath(import.meta.url)), "..", "CLAUDE.md"))?.trim();
}

function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Session ids come from Claude Code; keep them filename-safe anyway. */
function seenFile(dir, sessionId) {
  return join(dir, "claude-sessions", `${String(sessionId || "default").replace(/[^\w.-]/g, "_")}.caps`);
}

/**
 * Decide what to inject for a hook event. Returns the additionalContext text, or "" for
 * nothing. Records the injected capabilities per session so unchanged turns stay silent.
 */
export function buildContext(event, dir = cacheDir(), { active = nvimActive(), playbook = readPlaybook() } = {}) {
  if (!active) return ""; // no Neovim here: plain Claude Code, add nothing
  const name = event?.hook_event_name;
  const caps = read(join(dir, "capabilities.txt"))?.trim();
  const sheet = read(join(dir, "keymaps.txt"))?.trim();
  const seen = seenFile(dir, event?.session_id);
  const remember = () => {
    try {
      mkdirSync(join(dir, "claude-sessions"), { recursive: true });
      writeFileSync(seen, caps ?? "");
    } catch { }
  };

  if (name === "SessionStart") {
    remember();
    const parts = playbook ? [`<nvim_playbook>\n${playbook}\n</nvim_playbook>`] : [];
    if (caps) parts.push(`<nvim_capabilities>\n${caps}\n</nvim_capabilities>`);
    else parts.push("No cached Neovim capabilities yet: call nvim_capabilities before editing.");
    if (sheet) parts.push(`<nvim_keymaps>\n${sheet}\n</nvim_keymaps>`);
    return `Mystique is active: this session drives a live Neovim (refresh context with nvim_capabilities).\n\n${parts.join("\n\n")}`;
  }

  if (name === "UserPromptSubmit") {
    if (!caps || (read(seen) ?? "") === caps) return "";
    remember();
    return `Neovim capabilities changed:\n<nvim_capabilities>\n${caps}\n</nvim_capabilities>`;
  }
  return "";
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let event = {};
  try {
    event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    event = {};
  }
  const text = buildContext(event);
  if (text) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: text } }),
    );
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => process.exit(0));
}
