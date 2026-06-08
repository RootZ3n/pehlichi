import assert from "node:assert/strict";
import { test } from "node:test";

import type { DriverContext, ToolSpec } from "../driver.js";
import {
  completionToAction,
  LlamaCppDriver,
  LlamaCppError,
  LLAMACPP_RESPONSE_PROTOCOL,
  parseChatCompletion,
  toProviderTools,
  toWireMessages,
  type FetchLike,
} from "./llamacpp.js";

// All tests here are OFFLINE: canned provider JSON fixtures + a fake fetch.

function completion(message: Record<string, unknown>, finishReason: string): unknown {
  return { choices: [{ finish_reason: finishReason, message }] };
}

function fakeFetch(canned: unknown): { fn: FetchLike; seen: () => { url: string; headers: Record<string, string>; body: string } } {
  let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
  const fn: FetchLike = async (url, init) => {
    captured = { url: String(url), headers: init.headers, body: init.body };
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

// ── toProviderTools ─────────────────────────────────────────────────────────

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
  const fn1 = (mapped[1] as { function: { parameters: Record<string, unknown> } }).function;
  assert.equal(fn1.parameters["type"], "object");
});

// ── toWireMessages ──────────────────────────────────────────────────────────

test("toWireMessages injects the protocol and relabels tool turns", () => {
  const wire = toWireMessages([
    { role: "system", content: "S" },
    { role: "user", content: "U" },
    { role: "tool", content: "R" },
  ]);
  assert.equal(wire[0]?.["content"], "S");
  assert.equal(wire[1]?.["content"], LLAMACPP_RESPONSE_PROTOCOL);
  assert.equal(wire[2]?.["role"], "user");
  assert.equal(wire[3]?.["role"], "user");
  assert.match(wire[3]?.["content"] ?? "", /^TOOL RESULT:/);
});

test("toWireMessages prepends protocol when no system message present", () => {
  const wire = toWireMessages([{ role: "user", content: "hello" }]);
  assert.equal(wire[0]?.["role"], "system");
  assert.equal(wire[0]?.["content"], LLAMACPP_RESPONSE_PROTOCOL);
});

// ── parseChatCompletion ─────────────────────────────────────────────────────

test("parseChatCompletion: extracts content, tool calls, finish reason", () => {
  const parsed = parseChatCompletion(
    completion({ content: "hello", tool_calls: [] }, "stop"),
  );
  assert.equal(parsed.content, "hello");
  assert.deepEqual(parsed.toolCalls, []);
  assert.equal(parsed.finishReason, "stop");
});

test("parseChatCompletion: null content becomes empty string", () => {
  const parsed = parseChatCompletion(completion({ content: null }, "stop"));
  assert.equal(parsed.content, "");
});

test("parseChatCompletion: no choices throws", () => {
  assert.throws(() => parseChatCompletion({ choices: [] }), LlamaCppError);
  assert.throws(() => parseChatCompletion({}), LlamaCppError);
});

test("parseChatCompletion: non-object throws", () => {
  assert.throws(() => parseChatCompletion("not an object"), LlamaCppError);
  assert.throws(() => parseChatCompletion(null), LlamaCppError);
});

// ── completionToAction ──────────────────────────────────────────────────────

test("completionToAction: tool call becomes a tool action with parsed args", () => {
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

test("completionToAction: non-JSON tool arguments throw", () => {
  assert.throws(
    () =>
      completionToAction(
        parseChatCompletion(
          completion({ content: null, tool_calls: [{ id: "c1", function: { name: "read", arguments: "not json" } }] }, "tool_calls"),
        ),
      ),
    LlamaCppError,
  );
});

test("completionToAction: root-cause JSON becomes a root-cause action", () => {
  const action = completionToAction(
    parseChatCompletion(completion({ content: '{"kind":"root-cause","text":"the value is wrong"}' }, "stop")),
  );
  assert.deepEqual(action, { kind: "root-cause", text: "the value is wrong" });
});

test("completionToAction: narrate JSON becomes a narrate action", () => {
  const action = completionToAction(
    parseChatCompletion(completion({ content: '{"kind":"narrate","phase":"investigate","text":"looking"}' }, "stop")),
  );
  assert.deepEqual(action, { kind: "narrate", phase: "investigate", text: "looking" });
});

test("completionToAction: valid done JSON becomes a done action", () => {
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

test("completionToAction: prose without control JSON falls back to narration", () => {
  const action = completionToAction(parseChatCompletion(completion({ content: "I will start by reading the files." }, "stop")));
  assert.deepEqual(action, { kind: "narrate", phase: "other", text: "I will start by reading the files." });
});

test("completionToAction: finish_reason=length is a clean error", () => {
  assert.throws(
    () =>
      completionToAction(
        parseChatCompletion(
          completion({ content: '{"kind":"done","summary":{"rootCause":"r","changes":["c"],"verification":["v"]}}' }, "length"),
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof LlamaCppError);
      assert.match(err.message, /finish_reason=length|token cap/);
      return true;
    },
  );
});

// ── textual tool-call detection ─────────────────────────────────────────────

const TOOLS = ["read", "search", "write", "terminal"];

test("completionToAction: tool call written as prose -> textual-call-detected", () => {
  for (const content of [
    'read({"path":"x"})',
    'call terminal({"command":"sh app.sh"})',
  ]) {
    const action = completionToAction(parseChatCompletion(completion({ content }, "stop")), TOOLS);
    assert.equal(action.kind, "textual-call-detected", `content: ${content}`);
  }
});

test("detector is NARROW: discussion does NOT trigger", () => {
  for (const content of [
    "I will use read next to inspect the file.",
    "Next step: search the workspace, then write the fix.",
  ]) {
    const action = completionToAction(parseChatCompletion(completion({ content }, "stop")), TOOLS);
    assert.equal(action.kind, "narrate", `discussion must narrate: ${content}`);
  }
});

// ── LlamaCppDriver (integration with fake fetch) ────────────────────────────

test("LlamaCppDriver: defaults are sensible", () => {
  const driver = new LlamaCppDriver({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }) as any });
  assert.equal(driver.baseUrl, "http://localhost:8080");
  assert.equal(driver.model, "local");
});

test("LlamaCppDriver: sends correct URL and body shape", async () => {
  const canned = completion({ content: '{"kind":"narrate","phase":"other","text":"ok"}' }, "stop");
  const f = fakeFetch(canned);
  const driver = new LlamaCppDriver({ fetchImpl: f.fn, temperature: 0.5, topP: 0.8 });
  const ctx: DriverContext = { messages: [{ role: "system", content: "s" }], tools: [] };
  await driver.next(ctx);

  assert.equal(f.seen().url, "http://localhost:8080/v1/chat/completions");
  const body = JSON.parse(f.seen().body) as Record<string, unknown>;
  assert.equal(body["model"], "local");
  assert.equal(body["temperature"], 0.5);
  assert.equal(body["top_p"], 0.8);
  assert.equal(body["stream"], false);
});

test("LlamaCppDriver: no auth header (local server)", async () => {
  const canned = completion({ content: '{"kind":"narrate","phase":"other","text":"ok"}' }, "stop");
  const f = fakeFetch(canned);
  const driver = new LlamaCppDriver({ fetchImpl: f.fn });
  await driver.next({ messages: [{ role: "system", content: "s" }], tools: [] });
  assert.ok(!("authorization" in f.seen().headers), "no auth header for local server");
  assert.ok(!("api-key" in f.seen().headers), "no api-key header for local server");
});

test("LlamaCppDriver: network error throws LlamaCppError", async () => {
  const driver = new LlamaCppDriver({
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  await assert.rejects(
    () => driver.next({ messages: [{ role: "system", content: "s" }], tools: [] }),
    (err: unknown) => {
      assert.ok(err instanceof LlamaCppError);
      assert.match(err.message, /network error/);
      return true;
    },
  );
});

test("LlamaCppDriver: HTTP error throws with status", async () => {
  const driver = new LlamaCppDriver({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "model loading" }) as any,
  });
  await assert.rejects(
    () => driver.next({ messages: [{ role: "system", content: "s" }], tools: [] }),
    (err: unknown) => {
      assert.ok(err instanceof LlamaCppError);
      assert.match(err.message, /503/);
      return true;
    },
  );
});

test("LlamaCppDriver: custom params are passed through", async () => {
  const canned = completion({ content: '{"kind":"narrate","phase":"other","text":"ok"}' }, "stop");
  const f = fakeFetch(canned);
  const driver = new LlamaCppDriver({
    fetchImpl: f.fn,
    baseUrl: "http://gpu-server:9090",
    model: "qwen2.5-7b",
    maxTokens: 8192,
    temperature: 0.3,
    topP: 0.95,
    topK: 20,
    repeatPenalty: 1.2,
    minP: 0.05,
    mirostat: 2,
    nCtx: 4096,
    nGpuLayers: 99,
    seed: 42,
  });
  await driver.next({ messages: [{ role: "system", content: "s" }], tools: [] });

  assert.equal(f.seen().url, "http://gpu-server:9090/v1/chat/completions");
  const body = JSON.parse(f.seen().body) as Record<string, unknown>;
  assert.equal(body["model"], "qwen2.5-7b");
  assert.equal(body["max_tokens"], 8192);
  assert.equal(body["temperature"], 0.3);
  assert.equal(body["top_p"], 0.95);
  assert.equal(body["top_k"], 20);
  assert.equal(body["repeat_penalty"], 1.2);
  assert.equal(body["min_p"], 0.05);
  assert.equal(body["mirostat"], 2);
  assert.equal(body["n_ctx"], 4096);
  assert.equal(body["n_gpu_layers"], 99);
  assert.equal(body["seed"], 42);
});
