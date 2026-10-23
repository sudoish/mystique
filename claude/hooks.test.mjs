import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBash } from "./hooks/bash-policy.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "./hooks/nvim-context.mjs";

test("blocks shell commands that bypass the editor", () => {
  const blocked = [
    "sed -i 's/a/b/' file.ts",
    "perl -pi -e 's/a/b/' file.ts",
    "echo hi > out.txt",
    "cat file.ts",
    "tail -n 20 log.txt",
    "rg TODO src",
    "grep -r foo .",
    "find . -name '*.ts'",
    "tee out.txt",
    "node -e \"require('fs').writeFileSync('x', 'y')\"",
  ];
  for (const cmd of blocked) {
    assert.ok(classifyBash(cmd), `expected BLOCK: ${cmd}`);
  }
});

test("allows git, tests, builds and other safe commands", () => {
  const allowed = [
    "git status",
    "git commit -m 'x'",
    "npm test",
    "npx tsc --noEmit",
    "jest --runInBand",
    "ls -la",
    "echo hi > /dev/null",
    "node --test",
    "mkdir -p build",
  ];
  for (const cmd of allowed) {
    assert.equal(classifyBash(cmd), null, `expected ALLOW: ${cmd}`);
  }
});

test("context hook: SessionStart injects capabilities + keymaps; prompts only on change", () => {
  const dir = mkdtempSync(join(tmpdir(), "mystique-ctx-"));
  try {
    const start = { hook_event_name: "SessionStart", session_id: "s1" };
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1" };
    assert.match(buildContext(start, dir), /call the nvim_capabilities tool/); // nothing cached yet

    writeFileSync(join(dir, "capabilities.txt"), "lsp: none\n");
    writeFileSync(join(dir, "keymaps.txt"), "Leader is <Space>.\n");
    const ctx = buildContext(start, dir);
    assert.match(ctx, /<nvim_capabilities>\nlsp: none\n<\/nvim_capabilities>/);
    assert.match(ctx, /<nvim_keymaps>\nLeader is <Space>\.\n<\/nvim_keymaps>/);

    assert.equal(buildContext(prompt, dir), ""); // unchanged since SessionStart
    writeFileSync(join(dir, "capabilities.txt"), "lsp: ts_ls attached\n");
    const changed = buildContext(prompt, dir);
    assert.match(changed, /<nvim_capabilities>\nlsp: ts_ls attached\n/);
    assert.doesNotMatch(changed, /nvim_keymaps/); // keymaps stay in the SessionStart copy
    assert.equal(buildContext(prompt, dir), "");
    // Another session hasn't seen the new manifest yet.
    assert.match(buildContext({ ...prompt, session_id: "s2" }, dir), /ts_ls attached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("context hook binary: stdin event → hookSpecificOutput JSON, silent when nothing to add", () => {
  const dir = mkdtempSync(join(tmpdir(), "mystique-ctx-"));
  try {
    writeFileSync(join(dir, "capabilities.txt"), "lsp: none\n");
    const run = (event) =>
      spawnSync("node", [new URL("./hooks/nvim-context.mjs", import.meta.url).pathname], {
        input: JSON.stringify(event),
        env: { ...process.env, MYSTIQUE_CACHE_DIR: dir },
        encoding: "utf8",
      });
    const start = run({ hook_event_name: "SessionStart", session_id: "b" });
    assert.equal(start.status, 0);
    const out = JSON.parse(start.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "SessionStart");
    assert.match(out.additionalContext, /<nvim_capabilities>\nlsp: none/);
    const prompt = run({ hook_event_name: "UserPromptSubmit", session_id: "b" });
    assert.equal(prompt.status, 0);
    assert.equal(prompt.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
