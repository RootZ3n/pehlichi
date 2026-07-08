/**
 * TOOL-CALL ARGUMENT REPAIR (P1.2) — near-JSON tool arguments are repaired, valid input is
 * never rewritten, and irreparable input fails cleanly.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToolArguments } from "./tool-arg-repair.js";
import { completionToAction } from "../drivers/mimo.js";

test("valid JSON is parsed and NOT marked repaired", () => {
  const r = parseToolArguments('{"path":"a.txt","n":3}');
  assert.deepEqual(r?.value, { path: "a.txt", n: 3 });
  assert.equal(r?.repaired, false);
});

test("empty arguments parse to an empty object", () => {
  assert.deepEqual(parseToolArguments("")?.value, {});
  assert.deepEqual(parseToolArguments("   ")?.value, {});
});

test("a trailing comma is repaired", () => {
  const r = parseToolArguments('{"a":1,"b":2,}');
  assert.deepEqual(r?.value, { a: 1, b: 2 });
  assert.equal(r?.repaired, true);
});

test("single-quoted JSON is repaired", () => {
  const r = parseToolArguments("{'path':'x/y.txt'}");
  assert.deepEqual(r?.value, { path: "x/y.txt" });
  assert.equal(r?.repaired, true);
});

test("Python literals True/False/None are repaired", () => {
  const r = parseToolArguments('{"ok":True,"bad":False,"x":None}');
  assert.deepEqual(r?.value, { ok: true, bad: false, x: null });
});

test("a ```json fence is stripped", () => {
  const r = parseToolArguments('```json\n{"path":"a"}\n```');
  assert.deepEqual(r?.value, { path: "a" });
});

test("prose around the object is dropped", () => {
  const r = parseToolArguments('Here you go: {"path":"a"} thanks');
  assert.deepEqual(r?.value, { path: "a" });
});

test("irreparable input returns null (caller fails loud)", () => {
  assert.equal(parseToolArguments("not json at all <<<"), null);
});

test("an array is not a valid tool-args object", () => {
  assert.equal(parseToolArguments("[1,2,3]"), null);
});

test("driver: a tool call with a trailing comma is repaired into a tool action", () => {
  const action = completionToAction(
    { content: "", toolCalls: [{ id: "1", name: "write_file", arguments: '{"path":"a.txt","content":"hi",}' }], finishReason: "tool_calls" },
    ["write_file"],
  );
  assert.equal(action.kind, "tool");
  if (action.kind === "tool") {
    assert.equal(action.tool, "write_file");
    assert.deepEqual(action.args, { path: "a.txt", content: "hi" });
  }
});
