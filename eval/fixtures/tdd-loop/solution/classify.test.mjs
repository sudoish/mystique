import assert from "node:assert/strict";
import test from "node:test";
import { classify } from "./classify.mjs";

test("positive numbers", () => {
  assert.equal(classify(5), "positive");
  assert.equal(classify(1), "positive");
});

test("negative numbers", () => {
  assert.equal(classify(-3), "negative");
});

test("zero", () => {
  assert.equal(classify(0), "zero");
});
