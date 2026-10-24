import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBash } from "./hooks/bash-policy.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext } from "./hooks/nvim-context.mjs";
import { addMystique, removeMystique } from "./install.mjs";
import { nvimActive } from "./hooks/active.mjs";
import { detectMode } from "../core/detect.mjs";

test("detectMode: multiplexers, their precedence, and none", () => {
  const base = { NVIM: undefined, MYSTIQUE_SOCKET: undefined, HERDR_ENV: undefined, REX_SESSION: undefined, REX_BLOCK: undefined };
  const rex = { ...base, REX_SESSION: "session:1", REX_BLOCK: "block:1" };
  const herdr = { ...base, HERDR_ENV: "1" };
  // herdr inside Rex: HERDR_ENV wins because herdr is the inner multiplexer.
  const herdrInRex = { ...base, HERDR_ENV: "1", REX_SESSION: "session:1", REX_BLOCK: "block:1" };

  assert.equal(detectMode(rex), "rex");
  assert.equal(detectMode(herdr), "herdr");
  assert.equal(detectMode(herdrInRex), "herdr");
  assert.equal(detectMode(base), undefined);
  // Rex needs both session and block.
  assert.equal(detectMode({ ...base, REX_SESSION: "session:1" }), undefined);
  assert.equal(detectMode({ ...base, REX_BLOCK: "block:1" }), undefined);

  assert.equal(nvimActive(rex), true);
  assert.equal(nvimActive(herdr), true);
  assert.equal(nvimActive(herdrInRex), true);
  assert.equal(nvimActive(base), false);
});

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
    const on = { active: true, playbook: "" };
    const start = { hook_event_name: "SessionStart", session_id: "s1" };
    const prompt = { hook_event_name: "UserPromptSubmit", session_id: "s1" };
    assert.match(buildContext(start, dir, on), /No cached Neovim capabilities yet/); // nothing cached yet

    writeFileSync(join(dir, "capabilities.txt"), "lsp: none\n");
    writeFileSync(join(dir, "keymaps.txt"), "Leader is <Space>.\n");
    const ctx = buildContext(start, dir, on);
    assert.match(ctx, /<nvim_capabilities>\nlsp: none\n<\/nvim_capabilities>/);
    assert.match(ctx, /<nvim_keymaps>\nLeader is <Space>\.\n<\/nvim_keymaps>/);

    assert.equal(buildContext(prompt, dir, on), ""); // unchanged since SessionStart
    writeFileSync(join(dir, "capabilities.txt"), "lsp: ts_ls attached\n");
    const changed = buildContext(prompt, dir, on);
    assert.match(changed, /<nvim_capabilities>\nlsp: ts_ls attached\n/);
    assert.doesNotMatch(changed, /nvim_keymaps/); // keymaps stay in the SessionStart copy
    assert.equal(buildContext(prompt, dir, on), "");
    // Another session hasn't seen the new manifest yet.
    assert.match(buildContext({ ...prompt, session_id: "s2" }, dir, on), /ts_ls attached/);
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
        env: { ...process.env, MYSTIQUE_CACHE_DIR: dir, MYSTIQUE_SOCKET: dir }, // any existing path counts as reachable
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

test("context hook: silent outside Neovim; playbook injected at SessionStart when active", () => {
  const dir = mkdtempSync(join(tmpdir(), "mystique-ctx-"));
  try {
    writeFileSync(join(dir, "capabilities.txt"), "lsp: none\n");
    const start = { hook_event_name: "SessionStart", session_id: "p" };
    assert.equal(buildContext(start, dir, { active: false, playbook: "PLAY" }), "");
    assert.match(buildContext(start, dir, { active: true, playbook: "PLAY" }), /<nvim_playbook>\nPLAY\n<\/nvim_playbook>/);
    // The real playbook ships with the hook.
    assert.match(buildContext(start, dir, { active: true }), /<nvim_playbook>\n# Mystique/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installer: merges idempotently next to the user's settings and uninstalls cleanly", () => {
  const root = "/opt/mystique";
  const user = {
    model: "opus",
    permissions: { allow: ["Bash(git:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-hook" }] }] },
  };
  const once = addMystique(user, root);
  assert.deepEqual(addMystique(once, root), once); // re-running doesn't duplicate
  assert.deepEqual(once.permissions.allow, ["Bash(git:*)", "mcp__nvim"]);
  assert.equal(once.hooks.PreToolUse.length, 3); // user's hook + 2 guards
  assert.equal(once.hooks.PreToolUse[0].hooks[0].command, "my-own-hook");
  assert.match(once.hooks.SessionStart[0].hooks[0].command, /^node "\/opt\/mystique\/claude\/hooks\/nvim-context\.mjs"$/);
  assert.deepEqual(removeMystique(once, root), user);
  assert.deepEqual(removeMystique(addMystique({}, root), root), {});
});

test("guards are inert outside Neovim", () => {
  const env = { ...process.env };
  delete env.NVIM;
  delete env.MYSTIQUE_SOCKET;
  delete env.HERDR_ENV;
  delete env.REX_SESSION;
  delete env.REX_BLOCK;
  const hook = (name, event) =>
    spawnSync("node", [new URL(`./hooks/${name}`, import.meta.url).pathname], {
      input: JSON.stringify(event),
      env,
      encoding: "utf8",
    });
  assert.equal(hook("redirect-to-nvim.mjs", { tool_name: "Read" }).status, 0);
  assert.equal(hook("guard-bash.mjs", { tool_input: { command: "cat file.ts" } }).status, 0);
  const inside = { ...env, MYSTIQUE_SOCKET: tmpdir() };
  const blocked = spawnSync("node", [new URL("./hooks/redirect-to-nvim.mjs", import.meta.url).pathname], {
    input: JSON.stringify({ tool_name: "Read" }),
    env: inside,
    encoding: "utf8",
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /nvim_view/);
});
