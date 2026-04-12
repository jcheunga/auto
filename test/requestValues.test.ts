import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBoolean,
  parseLimit,
  parseNullableInteger,
  parseNullableString,
  parseStatusValue
} from "../src/lib/requestValues";

test("parseLimit clamps and falls back sanely", () => {
  assert.equal(parseLimit(undefined), 100);
  assert.equal(parseLimit("12"), 12);
  assert.equal(parseLimit("12.8"), 12);
  assert.equal(parseLimit(-5), 100);
  assert.equal(parseLimit("not-a-number"), 100);
  assert.equal(parseLimit(9999, 10, 250), 250);
  assert.equal(parseLimit(["7"], 10, 250), 7);
});

test("parseStatusValue normalizes and validates known workflow statuses", () => {
  assert.equal(parseStatusValue("PR_OPEN"), "pr_open");
  assert.equal(parseStatusValue(" ready_to_merge "), "ready_to_merge");
  assert.equal(parseStatusValue("unknown"), null);
  assert.equal(parseStatusValue(null), null);
});

test("parseNullableString trims empty-ish values", () => {
  assert.equal(parseNullableString(undefined), null);
  assert.equal(parseNullableString(null), null);
  assert.equal(parseNullableString("  hello  "), "hello");
  assert.equal(parseNullableString(["  world  "]), "world");
  assert.equal(parseNullableString("   "), null);
});

test("parseNullableInteger distinguishes null, valid integers, and invalid values", () => {
  assert.equal(parseNullableInteger(undefined), null);
  assert.equal(parseNullableInteger(null), null);
  assert.equal(parseNullableInteger(""), null);
  assert.equal(parseNullableInteger("42"), 42);
  assert.equal(parseNullableInteger(["17"]), 17);
  assert.equal(parseNullableInteger("17.5"), undefined);
  assert.equal(parseNullableInteger("abc"), undefined);
});

test("parseBoolean understands common truthy and falsy strings", () => {
  assert.equal(parseBoolean(undefined), undefined);
  assert.equal(parseBoolean(true), true);
  assert.equal(parseBoolean(false), false);
  assert.equal(parseBoolean("YES"), true);
  assert.equal(parseBoolean("off"), false);
  assert.equal(parseBoolean(["1"]), true);
  assert.equal(parseBoolean(["0"]), false);
});
