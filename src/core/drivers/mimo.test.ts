import assert from "node:assert/strict";
import { test } from "node:test";

import type { DriverContext, ToolSpec } from "../driver.js";
import {
  completionToAction,
  MimoDriver,
  MimoError,
  MIMO_RESPONSE_PROTOCOL,
  parseChatCompletion,
  toProviderTools,
  toWireMessages,
  type FetchLike,
} from "./mimo.js";

// All tests here are OFFLINE: canned provider JSON fixtures + a fake fetch.

function completion(message: Record<string, unknown>, finishReason: string): unknown {
  return { choices: [{ finish_reason: finishReason, message }] };
}

function fakeFetch(canned: unknown): { fn: FetchLike; seen: () => { headers: Record<string, string>; body: string } } {
  let captured: { headers: Record<string, string>; body: string } | undefined;
  const fn: FetchLike = async (_url, init) => {
    captured = { headers: init.headers, body: init.body };
    return { ok: true, status: 200, json: async () => canned, text: async () => "" };
  };
  return {
    fn,
    seen: () => {
      assert.ok(captured, "fetch was called");
      return captured;
    },
  };
}

test("toProviderTools maps name/description/parameters into the function format", () => {
  const specs: ToolSpec[] = [
    { name: "read", description: "read a file", parameters: { type: "object", properties: { path: {} } } },
    { name: "noparams", description: "no schema" },
  ];
  const mapped = toProviderTools(specs);
  assert.deepEqual(mapped[0], {
    type: "function",
    function: { name: "read", description: "read a file", parameters: { type: "object", properties: { path: {} } } },
  });
  // a spec without parameters gets a permissive default object schema
  const fn1 = (mapped[1] as { function: { parameters: Record<string, unknown> } }).function;
  assert.equal(fn1.parameters["type"], "object");
});

test("toWireMessages injects the protocol and relabels tool turns", () => {
  const wire = toWireMessages([
    { role: "system", content: "S" },
    { role: "user", content: "U" },
    { role: "tool", content: "R" },
  ]);
  assert.equal(wire[0]?.["content"], "S");
  assert.equal(wire[1]?.["content"], MIMO_RESPONSE_PROTOCOL); // injected after first system
  assert.equal(wire[2]?.["role"], "user");
  assert.equal(wire[3]?.["role"], "user");
  assert.match(wire[3]?.["content"] ?? "", /^TOOL RESULT:/);
});

test("completionToAction: a tool call becomes a tool action with parsed args", () => {
  const action = completionToAction(
    parseChatCompletion(
      completion(
        { content: null, tool_calls: [{ id: "c1", function: { name: "write", arguments: '{"path":"a.sh","content":"x"}' } }] },
        "tool_calls",
      ),
    ),
  );
  assert.equal(action.kind, "tool");
  assert.deepEqual(action, { kind: "tool", tool: "write", args: { path: "a.sh", content: "x" } });
});

test("completionToAction: non-JSON tool arguments throw a clean error", () => {
  assert.throws(
    () =>
      completionToAction(
        parseChatCompletion(
          completion({ content: null, tool_calls: [{ id: "c1", function: { name: "read", arguments: "not json" } }] }, "tool_calls"),
        ),
      ),
    MimoError,
  );
});

test("completionToAction: root-cause JSON content becomes a root-cause action", () => {
  const action = completionToAction(
    parseChatCompletion(completion({ content: '{"kind":"root-cause","text":"the value is wrong"}' }, "stop")),
  );
  assert.deepEqual(action, { kind: "root-cause", text: "the value is wrong" });
});

test("completionToAction: narrate JSON content becomes a narrate action with phase", () => {
  const action = completionToAction(
    parseChatCompletion(completion({ content: '{"kind":"narrate","phase":"investigate","text":"looking"}' }, "stop")),
  );
  assert.deepEqual(action, { kind: "narrate", phase: "investigate", text: "looking" });
});

test("completionToAction: a valid done JSON becomes a done action with arrays", () => {
  const action = completionToAction(
    parseChatCompletion(
      completion(
        { content: '{"kind":"done","summary":{"rootCause":"r","changes":["c1"],"verification":["v1"]}}' },
        "stop",
      ),
    ),
  );
  assert.deepEqual(action, {
    kind: "done",
    summary: { rootCause: "r", changes: ["c1"], verification: ["v1"] },
  });
});

test("completionToAction: a done with empty arrays parses through (the loop's gate rejects it)", () => {
  const action = completionToAction(
    parseChatCompletion(completion({ content: '{"kind":"done","summary":{"rootCause":"r","changes":[],"verification":[]}}' }, "stop")),
  );
  assert.equal(action.kind, "done");
  // parser does NOT silently fix it — it surfaces the empty arrays for the gate.
  assert.ok(action.kind === "done" && action.summary.changes.length === 0);
});

test("completionToAction: prose without control JSON falls back to narration", () => {
  const action = completionToAction(parseChatCompletion(completion({ content: "I will start by reading the files." }, "stop")));
  assert.deepEqual(action, { kind: "narrate", phase: "other", text: "I will start by reading the files." });
});

test("completionToAction: finish_reason=length is a clean error, NOT a silent done", () => {
  assert.throws(
    () =>
      completionToAction(
        // even though the content looks like a valid done, a truncated turn must error
        parseChatCompletion(
          completion({ content: '{"kind":"done","summary":{"rootCause":"r","changes":["c"],"verification":["v"]}}' }, "length"),
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof MimoError);
      assert.match(err.message, /finish_reason=length|token cap/);
      return true;
    },
  );
});

test("parseChatCompletion: a body with no choices throws", () => {
  assert.throws(() => parseChatCompletion({ choices: [] }), MimoError);
  assert.throws(() => parseChatCompletion({}), MimoError);
});

test("next(): keyed driver sends an api-key header (not Bearer), keyless sends none", async () => {
  const ctx: DriverContext = { messages: [{ role: "system", content: "s" }], tools: [] };
  const canned = completion({ content: '{"kind":"narrate","phase":"other","text":"ok"}' }, "stop");

  const keyed = fakeFetch(canned);
  const keyedDriver = new MimoDriver({ apiKey: "sk-test", fetchImpl: keyed.fn });
  assert.equal(keyedDriver.keyed, true);
  await keyedDriver.next(ctx);
  assert.equal(keyed.seen().headers["api-key"], "sk-test");
  assert.ok(!("authorization" in keyed.seen().headers), "no Bearer auth header");

  const keyless = fakeFetch(canned);
  const keylessDriver = new MimoDriver({ apiKey: "", fetchImpl: keyless.fn }); // empty => keyless
  assert.equal(keylessDriver.keyed, false);
  await keylessDriver.next(ctx);
  assert.ok(!("api-key" in keyless.seen().headers), "no api-key header when keyless");
});

test("next(): a canned tool-call response drives a tool action (offline, fake fetch)", async () => {
  const canned = completion(
    { content: null, tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"app.sh"}' } }] },
    "tool_calls",
  );
  const f = fakeFetch(canned);
  const driver = new MimoDriver({ apiKey: "sk-test", fetchImpl: f.fn });
  const action = await driver.next({ messages: [{ role: "system", content: "s" }], tools: [] });
  assert.deepEqual(action, { kind: "tool", tool: "read", args: { path: "app.sh" } });
  // the request carried the MiMo conventions
  const body = JSON.parse(f.seen().body) as Record<string, unknown>;
  assert.deepEqual(body["thinking"], { type: "disabled" });
  assert.equal(body["model"], "mimo-v2.5");
  assert.equal(body["max_completion_tokens"], 12288);
});

// ── step 2c-fix: textual tool-call detection (Half 1) ─────────────────────────

const TOOLS = ["read", "search", "write", "terminal", "skill_view", "skill_manage_create"];

test("completionToAction: a tool call written as prose -> textual-call-detected (not a tool action)", () => {
  for (const content of [
    'read({"path":"x"})',
    'call terminal({"command":"sh app.sh"})',
    '[act] call write({"path":"a.sh","content":"y"})',
  ]) {
    const action = completionToAction(parseChatCompletion(completion({ content }, "stop")), TOOLS);
    assert.equal(action.kind, "textual-call-detected", `content: ${content}`);
    assert.ok(action.kind === "textual-call-detected" && action.offendingText.length > 0);
  }
});

test("detector is NARROW: mere discussion of a tool does NOT trigger detection", () => {
  for (const content of [
    "I will use read next to inspect the file.",
    "Next step: search the workspace, then write the fix.",
    "I considered calling terminal but decided to read first.",
  ]) {
    const action = completionToAction(parseChatCompletion(completion({ content }, "stop")), TOOLS);
    assert.equal(action.kind, "narrate", `discussion must narrate, not detect: ${content}`);
  }
});

test("detector does not fire on a valid narrate control JSON that mentions a call in its text", () => {
  const content = '{"kind":"narrate","phase":"act","text":"call write({...}) is what I will do"}';
  const action = completionToAction(parseChatCompletion(completion({ content }, "stop")), TOOLS);
  assert.equal(action.kind, "narrate");
});

test("a REAL function tool-call still executes (no regression) even with knownTools set", () => {
  const action = completionToAction(
    parseChatCompletion(
      completion({ content: null, tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"x"}' } }] }, "tool_calls"),
    ),
    TOOLS,
  );
  assert.deepEqual(action, { kind: "tool", tool: "read", args: { path: "x" } });
});
