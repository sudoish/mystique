import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBash } from "./hooks/bash-policy.mjs";

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
