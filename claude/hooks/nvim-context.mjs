#!/usr/bin/env node
/**
 * Claude Code SessionStart + UserPromptSubmit hook: give the model the live editor
 * context the pi extension puts in its system prompt each turn — the capability
 * manifest (<nvim_capabilities>) and the user's keymap cheat sheet (<nvim_keymaps>).
 *
 * The mcp-nvim server keeps both cached as it drives Neovim (see core/cache.ts); this
 * hook only reads the rendered text files, so it has no dependencies and adds ~no latency.
 *
 * Claude Code keeps hook output in the transcript, so unlike pi (which replaces a system
 * prompt section) re-injecting every turn would pile up copies. Instead:
 *   - SessionStart (startup/resume/clear/compact): inject both sections.
 *   - UserPromptSubmit: inject <nvim_capabilities> only when it changed since this
 *     session last saw it (e.g. an LSP attached after opening a source file).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function cacheDir() {
  return process.env.MYSTIQUE_CACHE_DIR || join(homedir(), ".cache", "mystique");
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
export function buildContext(event, dir = cacheDir()) {
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
    const parts = [];
    if (caps) parts.push(`<nvim_capabilities>\n${caps}\n</nvim_capabilities>`);
    if (sheet) parts.push(`<nvim_keymaps>\n${sheet}\n</nvim_keymaps>`);
    if (!parts.length) {
      return "No cached Neovim capabilities yet: call the nvim_capabilities tool before editing to learn the " +
        "format/test/LSP backends and the user's keymaps.";
    }
    return `Editor context from the last Neovim connection (refresh with nvim_capabilities):\n${parts.join("\n\n")}`;
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
