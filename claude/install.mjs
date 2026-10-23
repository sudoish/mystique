#!/usr/bin/env node
/**
 * One-shot, idempotent setup of Mystique for Claude Code (user scope, every project):
 *
 *   node claude/install.mjs              install / update
 *   node claude/install.mjs --uninstall  remove everything it added
 *
 * 1. Installs core/ and mcp-nvim/ dependencies when missing.
 * 2. Registers the `nvim` MCP server at user scope (`claude mcp add -s user`).
 * 3. Merges into ~/.claude/settings.json (backup first): the context hook
 *    (SessionStart/UserPromptSubmit), the PreToolUse guards, and `mcp__nvim` in
 *    permissions.allow so the editor tools don't prompt.
 *
 * Everything is inert outside Neovim (see hooks/active.mjs and mcp-nvim's startup
 * check), so plain `claude` keeps working; run it inside a Neovim :terminal (or with
 * MYSTIQUE_SOCKET / herdr) and it drives that editor. No permissions.deny is added
 * globally because a deny can't be made conditional; the hooks do the blocking.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SERVER = "nvim";
const ALLOW = `mcp__${SERVER}`;
const FILE_TOOLS = "Read|Edit|Write|Grep|Glob|LS|NotebookEdit";

/** Hook groups Mystique owns, keyed by event, for a checkout at `root`. */
export function mystiqueHooks(root) {
  const cmd = (name) => ({ type: "command", command: `node "${join(root, "claude", "hooks", name)}"` });
  return {
    SessionStart: [{ hooks: [cmd("nvim-context.mjs")] }],
    UserPromptSubmit: [{ hooks: [cmd("nvim-context.mjs")] }],
    PreToolUse: [
      { matcher: FILE_TOOLS, hooks: [cmd("redirect-to-nvim.mjs")] },
      { matcher: "Bash", hooks: [cmd("guard-bash.mjs")] },
    ],
  };
}

const isOurs = (root, h) => typeof h?.command === "string" && h.command.includes(join(root, "claude", "hooks"));

/** Remove every hook/allow entry Mystique added; leaves the user's own settings intact. */
export function removeMystique(settings, root) {
  const out = structuredClone(settings ?? {});
  for (const [event, groups] of Object.entries(out.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(root, h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) out.hooks[event] = kept;
    else delete out.hooks[event];
  }
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
  if (Array.isArray(out.permissions?.allow)) {
    out.permissions.allow = out.permissions.allow.filter((a) => a !== ALLOW);
    if (!out.permissions.allow.length) delete out.permissions.allow;
    if (!Object.keys(out.permissions).length) delete out.permissions;
  }
  return out;
}

/** Add (or refresh) Mystique's hooks and allow entry; idempotent. */
export function addMystique(settings, root) {
  const out = removeMystique(settings, root);
  out.hooks ??= {};
  for (const [event, groups] of Object.entries(mystiqueHooks(root))) {
    out.hooks[event] = [...(out.hooks[event] ?? []), ...groups];
  }
  out.permissions ??= {};
  out.permissions.allow = [...(out.permissions.allow ?? []), ALLOW];
  return out;
}

function readSettings(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").trim();
  if (!text) return {};
  return JSON.parse(text); // a malformed file aborts the install rather than being clobbered
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function main() {
  const uninstall = process.argv.includes("--uninstall");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const settingsFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  const log = (m) => process.stdout.write(`mystique: ${m}\n`);

  if (!sh("claude", ["--version"]).ok) throw new Error("`claude` CLI not found on PATH");

  sh("claude", ["mcp", "remove", "-s", "user", SERVER]); // idempotent: drop any previous registration
  if (!uninstall) {
    for (const pkg of ["core", "mcp-nvim"]) {
      if (!existsSync(join(root, pkg, "node_modules"))) {
        log(`installing ${pkg} dependencies…`);
        const r = sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: join(root, pkg) });
        if (!r.ok) throw new Error(`npm install failed in ${pkg}:\n${r.out}`);
      }
    }
    const tsx = join(root, "mcp-nvim", "node_modules", ".bin", "tsx");
    const r = sh("claude", ["mcp", "add", "-s", "user", SERVER, "--", tsx, join(root, "mcp-nvim", "index.ts")]);
    if (!r.ok) throw new Error(`claude mcp add failed:\n${r.out}`);
    log(`registered MCP server "${SERVER}" (user scope)`);
  } else {
    log(`removed MCP server "${SERVER}"`);
  }

  const before = readSettings(settingsFile);
  const after = uninstall ? removeMystique(before, root) : addMystique(before, root);
  mkdirSync(dirname(settingsFile), { recursive: true });
  if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.bak-mystique`);
  writeFileSync(settingsFile, `${JSON.stringify(after, null, 2)}\n`);
  log(`${uninstall ? "removed hooks from" : "merged hooks + permissions into"} ${settingsFile} (backup: settings.json.bak-mystique)`);
  if (!uninstall) {
    log("done. Run `claude` inside a Neovim :terminal (or set MYSTIQUE_SOCKET) and it drives that editor;");
    log("anywhere else Claude Code behaves as usual. MYSTIQUE_POLICY=off lifts enforcement.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`mystique: ${e.message}\n`);
    process.exit(1);
  }
}
