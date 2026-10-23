#!/usr/bin/env node
/**
 * mystique — install, check and update Mystique for pi and Claude Code.
 *
 *   mystique doctor                    check prerequisites and integrations (exit 1 on problems)
 *   mystique install [pi] [claude]     install deps + enable for the given agents (default: all found)
 *   mystique uninstall [pi] [claude]   disable for the given agents (default: all)
 *   mystique update                    git pull, reinstall deps, refresh integrations, run doctor
 *
 * Plain Node, no dependencies: it has to run before `npm install` has.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeSettingsFile, installClaude, SERVER, tsxPath } from "../claude/install.mjs";

export const ROOT = real(join(dirname(fileURLToPath(import.meta.url)), ".."));
const MIN = { node: [20, 0, 0], nvim: [0, 10, 0], nvimRecommended: [0, 11, 0] };
const REPO_RE = /github\.com[/:]sudoish\/mystique/;

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60000, ...opts });
  return { ok: r.status === 0, missing: r.error?.code === "ENOENT", out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function readJson(file) {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

export function parseVersion(text) {
  const m = String(text ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}

export function atLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
  }
  return true;
}

const fmt = (v) => v.join(".");
const tilde = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Every place pi would load this checkout from: settings `packages`/`extensions` and the
 * auto-discovered extensions dir. More than one means pi may load Mystique twice.
 */
export function piReferences(root, { settingsFile, extensionsDir }) {
  const refs = [];
  const targets = new Set([root, join(root, "extension"), join(root, "extension", "index.ts")].map(real));
  const base = dirname(settingsFile);
  const local = (p) => real(isAbsolute(tilde(p)) ? tilde(p) : join(base, p));
  const s = readJson(settingsFile) ?? {};
  for (const entry of s.packages ?? []) {
    const src = typeof entry === "string" ? entry : entry?.source;
    if (typeof src !== "string") continue;
    if (REPO_RE.test(src)) refs.push(`packages: ${src}`);
    else if (!/^(npm|git):|^https?:/.test(src) && targets.has(local(src))) refs.push(`packages: ${src}`);
  }
  for (const src of s.extensions ?? []) {
    if (typeof src === "string" && targets.has(local(src))) refs.push(`extensions: ${src}`);
  }
  let names = [];
  try {
    names = readdirSync(extensionsDir);
  } catch { }
  for (const name of names) {
    if (targets.has(real(join(extensionsDir, name)))) refs.push(`auto-discovered: ${join(extensionsDir, name)}`);
  }
  return refs;
}

export function piPaths(home = homedir()) {
  const agent = process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  return { settingsFile: join(agent, "settings.json"), extensionsDir: join(agent, "extensions") };
}

/** Claude Code integration state: MCP server registration (user scope) + our hooks. */
export function claudeState(root, { claudeJson = join(homedir(), ".claude.json"), settingsFile = claudeSettingsFile() } = {}) {
  const server = readJson(claudeJson)?.mcpServers?.[SERVER];
  const serverArgs = [server?.command, ...(server?.args ?? [])].join(" ");
  const hooksDir = join(root, "claude", "hooks");
  const hooks = JSON.stringify(readJson(settingsFile)?.hooks ?? {});
  return {
    server: Boolean(server),
    serverHere: serverArgs.includes(join(root, "mcp-nvim", "index.ts")),
    serverArgs,
    hooks: hooks.includes(hooksDir),
  };
}

function depsInstalled(root) {
  const has = (dirs, pkg) => dirs.some((d) => existsSync(join(root, d, "node_modules", pkg, "package.json")));
  return {
    neovim: has([".", "core"], "neovim"),
    mcp: has([".", "mcp-nvim"], "@modelcontextprotocol/sdk"),
    tsx: Boolean(tsxPath(root)),
  };
}

/** Run every check. Each: { level: ok|warn|fail|info, name, detail, fix? }. */
export function doctor(root = ROOT) {
  const checks = [];
  const add = (level, name, detail, fix) => checks.push({ level, name, detail, fix });

  const node = parseVersion(process.versions.node);
  if (atLeast(node, MIN.node)) add("ok", "node", `v${fmt(node)}`);
  else add("fail", "node", `v${fmt(node)} (need ≥ ${fmt(MIN.node)})`, "install Node.js 20+ (https://nodejs.org or `brew install node`)");

  const npm = run("npm", ["--version"]);
  if (npm.ok) add("ok", "npm", npm.out);
  else add("fail", "npm", "not found", "npm ships with Node.js; reinstall Node");

  const git = run("git", ["--version"]);
  if (git.ok) add("ok", "git", parseVersion(git.out) ? fmt(parseVersion(git.out)) : git.out);
  else add("warn", "git", "not found (needed for `mystique update`)", "install git");

  const nvimOut = run("nvim", ["--version"]);
  const nvim = parseVersion(nvimOut.out.split("\n")[0]);
  if (!nvimOut.ok || !nvim) {
    add("fail", "neovim", "not found", "install Neovim ≥ 0.10 (`brew install neovim`, or https://github.com/neovim/neovim/releases)");
  } else if (!atLeast(nvim, MIN.nvim)) {
    add("fail", "neovim", `${fmt(nvim)} (need ≥ ${fmt(MIN.nvim)})`, "upgrade Neovim");
  } else {
    add(atLeast(nvim, MIN.nvimRecommended) ? "ok" : "warn", "neovim", `${fmt(nvim)}${atLeast(nvim, MIN.nvimRecommended) ? "" : " (0.11+ recommended)"}`);
    const lua = join(root, "core", "lua", "mystique.lua");
    const probe = run("nvim", ["--headless", "-u", "NONE", "-i", "NONE", "-c", `luafile ${lua}`, "-c", "lua io.stdout:write('mystique:' .. type(_G.Mystique))", "-c", "qa!"], { timeout: 15000 });
    if (probe.out.includes("mystique:table")) add("ok", "lua engine", "loads in headless Neovim");
    else add("fail", "lua engine", `failed to load core/lua/mystique.lua: ${probe.out.split("\n").slice(0, 2).join(" ")}`, "report a bug; try `mystique update`");
  }

  const rg = run("rg", ["--version"]);
  if (rg.ok) add("ok", "ripgrep", fmt(parseVersion(rg.out) ?? [0, 0, 0]));
  else add("warn", "ripgrep", "not found (nvim_grep/nvim_find need it)", "`brew install ripgrep` (or your package manager)");

  const deps = depsInstalled(root);
  const missing = Object.entries(deps).filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) add("ok", "dependencies", "installed");
  else add("fail", "dependencies", `missing: ${missing.join(", ")}`, "mystique install");

  const pi = run("pi", ["--version"]);
  const claude = run("claude", ["--version"]);
  if (!pi.ok && !claude.ok) add("fail", "agent", "neither pi nor claude found on PATH", "install pi (https://pi.dev) or Claude Code");

  if (pi.ok) {
    const refs = piReferences(root, piPaths());
    if (refs.length === 1) add("ok", "pi", `${pi.out.split("\n")[0]} — enabled (${refs[0]})`);
    else if (!refs.length) add("warn", "pi", `${pi.out.split("\n")[0]} — Mystique not enabled`, "mystique install pi");
    else add("warn", "pi", `Mystique referenced ${refs.length}× (may load twice): ${refs.join("; ")}`, "keep one reference; remove the others from pi settings / extensions dir");
  } else {
    add("info", "pi", "not installed (optional)");
  }

  if (claude.ok) {
    const st = claudeState(root);
    const version = parseVersion(claude.out);
    const label = `claude ${version ? fmt(version) : ""}`.trim();
    if (st.serverHere && st.hooks) add("ok", "claude code", `${label} — MCP server "${SERVER}" + hooks enabled`);
    else if (st.server && !st.serverHere) add("warn", "claude code", `MCP server "${SERVER}" points elsewhere: ${st.serverArgs}`, "mystique install claude");
    else add("warn", "claude code", `${label} — not enabled${st.serverHere ? " (hooks missing)" : ""}`, "mystique install claude");
  } else {
    add("info", "claude code", "not installed (optional)");
  }

  const reach = process.env.MYSTIQUE_SOCKET && existsSync(process.env.MYSTIQUE_SOCKET) ? `MYSTIQUE_SOCKET=${process.env.MYSTIQUE_SOCKET}`
    : process.env.NVIM && existsSync(process.env.NVIM) ? "inside a Neovim terminal ($NVIM)"
      : process.env.HERDR_ENV === "1" ? "herdr" : undefined;
  add("info", "editor", reach ? `reachable now: ${reach}` : "no Neovim reachable from this shell — run your agent inside a Neovim :terminal, set MYSTIQUE_SOCKET, or use herdr");

  return checks;
}

const ICON = { ok: "✔", warn: "!", fail: "✖", info: "·" };

export function renderDoctor(checks, root = ROOT) {
  const lines = [`Mystique doctor — ${root}`];
  for (const c of checks) {
    lines.push(`  ${ICON[c.level]} ${c.name.padEnd(13)} ${c.detail}`);
    if (c.fix && c.level !== "ok") lines.push(`  ${" ".repeat(15)}→ ${c.fix}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  lines.push(fails ? `${fails} problem(s), ${warns} warning(s): fix the ✖ items above.` : warns ? `Ready, with ${warns} warning(s).` : "All good: Mystique is ready.");
  return lines.join("\n");
}

const log = (m) => process.stdout.write(`mystique: ${m}\n`);

function ensureDeps(root) {
  const deps = depsInstalled(root);
  if (deps.neovim && deps.mcp && deps.tsx) return;
  log("installing dependencies (npm install)…");
  const r = run("npm", ["install", "--no-audit", "--no-fund", "--omit=peer"], { cwd: root, timeout: 600000 });
  if (!r.ok) throw new Error(`npm install failed:\n${r.out}`);
}

function installPi(root, uninstall) {
  const refs = piReferences(root, piPaths());
  if (uninstall) {
    if (refs.some((r) => r.startsWith("packages:"))) run("pi", ["remove", root]);
    const manual = refs.filter((r) => !r.startsWith("packages:"));
    log(manual.length ? `pi: remove these by hand: ${manual.join("; ")}` : "pi: disabled");
    return;
  }
  if (refs.length) {
    log(`pi: already enabled (${refs.join("; ")})`);
    return;
  }
  const r = run("pi", ["install", root]);
  if (!r.ok) throw new Error(`pi install failed:\n${r.out}`);
  log(`pi: enabled (pi install ${root})`);
}

/** Put `mystique` on PATH via ~/.local/bin (only if that slot is free or already ours). */
function linkCli(root) {
  const binDir = join(homedir(), ".local", "bin");
  const link = join(binDir, "mystique");
  const target = join(root, "bin", "mystique.mjs");
  try {
    mkdirSync(binDir, { recursive: true });
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
      if (real(link) === real(target)) return;
      if (!lstatSync(link).isSymbolicLink()) return log(`left ${link} alone (not a symlink)`);
      unlinkSync(link);
    }
    symlinkSync(target, link);
    const onPath = (process.env.PATH ?? "").split(delimiter).includes(binDir);
    log(`linked ${link}${onPath ? "" : ` — add ${binDir} to PATH to run \`mystique\` directly`}`);
  } catch (e) {
    log(`could not link the CLI: ${e.message}`);
  }
}

function agentsFrom(args) {
  const named = args.filter((a) => a === "pi" || a === "claude");
  if (named.length) return named;
  return ["pi", "claude"].filter((a) => run(a, ["--version"]).ok);
}

function main(argv) {
  const [cmd = "help", ...args] = argv;
  if (cmd === "doctor") {
    const checks = doctor();
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
    else process.stdout.write(`${renderDoctor(checks)}\n`);
    return checks.some((c) => c.level === "fail") ? 1 : 0;
  }
  if (cmd === "install" || cmd === "update") {
    if (cmd === "update") {
      const r = run("git", ["-C", ROOT, "pull", "--ff-only"]);
      log(r.ok ? `updated: ${r.out.split("\n").pop()}` : `git pull failed (continuing with the current checkout): ${r.out}`);
    }
    ensureDeps(ROOT);
    let agents = agentsFrom(args);
    if (cmd === "update") {
      // Refresh only what is already enabled.
      agents = agents.filter((a) => (a === "pi" ? piReferences(ROOT, piPaths()).length : claudeState(ROOT).server));
    }
    if (!agents.length && cmd === "install") log("no agent found (pi or claude); installed dependencies only");
    for (const a of agents) {
      if (a === "pi") installPi(ROOT, false);
      else installClaude({ root: ROOT, log: (m) => log(`claude: ${m}`) });
    }
    linkCli(ROOT);
    process.stdout.write("\n");
    return main(["doctor"]);
  }
  if (cmd === "uninstall") {
    const named = args.filter((a) => a === "pi" || a === "claude");
    for (const a of named.length ? named : ["pi", "claude"]) {
      if (!run(a, ["--version"]).ok) continue;
      if (a === "pi") installPi(ROOT, true);
      else installClaude({ root: ROOT, uninstall: true, log: (m) => log(`claude: ${m}`) });
    }
    return 0;
  }
  process.stdout.write(
    "usage: mystique <doctor [--json] | install [pi] [claude] | uninstall [pi] [claude] | update>\n",
  );
  return cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(real(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`mystique: ${e.message}\n`);
    process.exit(1);
  }
}
