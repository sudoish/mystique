import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atLeast, claudeState, doctor, parseVersion, piReferences, renderDoctor, ROOT } from "./mystique.mjs";

test("version parsing and comparison", () => {
  assert.deepEqual(parseVersion("NVIM v0.12.6"), [0, 12, 6]);
  assert.deepEqual(parseVersion("2.1.309 (Claude Code)"), [2, 1, 309]);
  assert.deepEqual(parseVersion("v20.1"), [20, 1, 0]);
  assert.equal(parseVersion("nope"), undefined);
  assert.ok(atLeast([0, 10, 0], [0, 10, 0]));
  assert.ok(atLeast([0, 11, 2], [0, 10, 0]));
  assert.ok(!atLeast([0, 9, 5], [0, 10, 0]));
  assert.ok(atLeast([22, 0, 0], [20, 0, 0]));
});

test("pi references: finds every way pi would load this checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "mystique-pi-"));
  try {
    const settingsFile = join(dir, "settings.json");
    const extensionsDir = join(dir, "extensions");
    mkdirSync(extensionsDir);
    const paths = { settingsFile, extensionsDir };
    writeFileSync(settingsFile, JSON.stringify({ packages: ["https://github.com/other/pkg"], extensions: ["/elsewhere/x.ts"] }));
    assert.deepEqual(piReferences(ROOT, paths), []);

    writeFileSync(settingsFile, JSON.stringify({ extensions: [join(ROOT, "extension", "index.ts")] }));
    assert.equal(piReferences(ROOT, paths).length, 1);

    symlinkSync(join(ROOT, "extension"), join(extensionsDir, "nvim-dev"));
    assert.equal(piReferences(ROOT, paths).length, 2); // the duplicate the doctor warns about

    writeFileSync(settingsFile, JSON.stringify({ packages: ["git:github.com/sudoish/mystique@v1", { source: ROOT }] }));
    rmSync(join(extensionsDir, "nvim-dev"));
    assert.deepEqual(piReferences(ROOT, paths), ["packages: git:github.com/sudoish/mystique@v1", `packages: ${ROOT}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude state: server registration and hooks are detected per checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "mystique-claude-"));
  try {
    const claudeJson = join(dir, ".claude.json");
    const settingsFile = join(dir, "settings.json");
    assert.deepEqual(claudeState(ROOT, { claudeJson, settingsFile }), { server: false, serverHere: false, serverArgs: "", hooks: false });
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { nvim: { command: "tsx", args: [join(ROOT, "mcp-nvim", "index.ts")] } } }));
    writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `node "${join(ROOT, "claude", "hooks", "nvim-context.mjs")}"` }] }] } }));
    const st = claudeState(ROOT, { claudeJson, settingsFile });
    assert.equal(st.serverHere && st.hooks, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: every check has a level and the report summarizes it", () => {
  const checks = doctor();
  for (const c of checks) assert.ok(["ok", "warn", "fail", "info"].includes(c.level), JSON.stringify(c));
  for (const name of ["node", "npm", "neovim", "dependencies", "editor"]) {
    assert.ok(checks.some((c) => c.name === name), `missing check ${name}`);
  }
  const text = renderDoctor([{ level: "fail", name: "neovim", detail: "not found", fix: "brew install neovim" }]);
  assert.match(text, /✖ neovim +not found\n +→ brew install neovim\n1 problem/);
});
