/**
 * On-disk cache of the keymap cheat sheet and capability manifest, shared by every
 * harness: the pi extension injects them into its system prompt, the MCP server
 * refreshes them as it drives Neovim, and the Claude Code context hook (plain .mjs,
 * no deps) reads the rendered text files.
 *
 * Files (under $MYSTIQUE_CACHE_DIR, default ~/.cache/mystique):
 *   keymaps.txt        rendered <nvim_keymaps> section
 *   capabilities.json  structured manifest (source of truth, re-rendered on load)
 *   capabilities.txt   rendered <nvim_capabilities> section, for consumers without the renderer
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Caps, renderCapabilities } from "./nvim.ts";

/** Resolved per call so tests (and users) can redirect it via MYSTIQUE_CACHE_DIR. */
export function cacheDir(): string {
  return process.env.MYSTIQUE_CACHE_DIR || join(homedir(), ".cache", "mystique");
}

function read(name: string): string | undefined {
  try {
    return readFileSync(join(cacheDir(), name), "utf8");
  } catch {
    return undefined;
  }
}

/** Write only when the content differs; returns whether it changed. Best effort. */
function write(name: string, text: string): boolean {
  if (read(name) === text) return false;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), name), text);
    return true;
  } catch {
    return false;
  }
}

export function loadCheatsheet(): string | undefined {
  return read("keymaps.txt");
}

export function saveCheatsheet(text: string): boolean {
  return write("keymaps.txt", text);
}

/** The cached capability manifest, rendered from the structured JSON so reconnects stay consistent. */
export function loadCapabilities(): string | undefined {
  const json = read("capabilities.json");
  if (!json) return undefined;
  try {
    return renderCapabilities(JSON.parse(json) as Caps);
  } catch {
    return undefined;
  }
}

export function saveCapabilities(caps: Caps): boolean {
  const jsonChanged = write("capabilities.json", JSON.stringify(caps));
  const textChanged = write("capabilities.txt", renderCapabilities(caps));
  return jsonChanged || textChanged;
}
