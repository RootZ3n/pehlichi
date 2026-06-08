import assert from "node:assert/strict";
import { test } from "node:test";

import type { DriverContext, ToolSpec } from "../driver.js";
import {
  completionToAction,
  OllamaDriver,
  OllamaError,
  OLLAMA_RESPONSE_PROTOCOL,
  parseOllamaResponse,
  toProviderTools,
  toWireMessages,
  type FetchLike,
} from "./ollama.js";

// All tests here are OFFLINE: canned Ollama JSON fixtures + a fake fetch.

function ollamaResponse(message: Record<string, unknown>, done = true): unknown {
  return { message, done };
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

test("toProviderTools maps name/description/parameters", () => {
  const specs: ToolSpec[] = [
    { name: "read", description: "read a file", parameters: { type: "object", properties: { path: {} } } },
    { name: "noparams", description: "no schema" },
  ];
  const mapped = toProviderTools(specs);
  assert.equal(mapped[0]?.["type"], "function");
  const fn0 = (mapped[0] as { function: { name: string } }).function;
  assert.equal(fn0.name, "read");
});

// ── toWireMessages ──────────────────────────────────────────────────────────

test("toWireMessages injects protocol and relabels tool turns", () => {
  const wire = toWireMessages([
    { role: "system", content: "S" },
    { role: "user", content: "U" },
    { role: "tool", content: "R" },
  ]);
  assert.equal(wire[0]?.["content"], "S");
  assert.equal(wire[1]?.["content"], OLLAMA_RESPONSE_PROTOCOL);
  assert.equal(wire[2]?.["role"], "user");
  assert.match(wire[3]?.["content"] ?? "", /^TOOL RESULT:/);
});

// ── parseOllamaResponse ─────────────────────────────────────────────────────

test("parseOllamaResponse: extracts content and done flag", () => {
  const parsed = parseOllamaResponse(ollamaResponse({ role: "assistant", content: "hello" }, true));
  assert.equal(parsed.content, "hello");
  assert.deepEqual(parsed.toolCalls, []);
  assert.equal(parsed.finishReason, "stop");
});

test("parseOllamaResponse: done=false maps to length", () => {
  const parsed = parseOllamaResponse(ollamaResponse({ role: "assistant", content: "partial" }, false));
  assert.equal(parsed.finishReason, "length");
});

test("parseOllamaResponse: null content becomes empty string", () => {
  const parsed = parseOllamaResponse(ollamaResponse({ role: "assistant", content: null }, true));
  assert.equal(parsed.content, "");
});

test("parseOllamaResponse: no message throws", () => {
  assert.throws(() => parseOllamaResponse({ done: true }), OllamaError);
});

test("parseOllamaResponse: non-object throws", () => {
  assert.throws(() => parseOllamaResponse("not an object"), OllamaError);
});

test("parseOllamaResponse: tool calls are parsed", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "read", arguments: { path: "x" } } }],
    }, true),
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0]?.name, "read");
  // Ollama returns arguments as object — normalized to string
  assert.equal(typeof parsed.toolCalls[0]?.arguments, "string");
});

// ── completionToAction ──────────────────────────────────────────────────────

test("completionToAction: tool call becomes a tool action", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "write", arguments: '{"path":"a.sh","content":"x"}' } }],
    }, true),
  );
  const action = completionToAction(parsed);
  assert.deepEqual(action, { kind: "tool", tool: "write", args: { path: "a.sh", content: "x" } });
});

test("completionToAction: tool call with object arguments (Ollama native)", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "read", arguments: { path: "/tmp/test" } } }],
    }, true),
  );
  const action = completionToAction(parsed);
  assert.equal(action.kind, "tool");
  assert.ok(action.kind === "tool" && action.args.path === "/tmp/test");
});

test("completionToAction: root-cause JSON becomes root-cause action", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({ role: "assistant", content: '{"kind":"root-cause","text":"bad config"}' }, true),
  );
  const action = completionToAction(parsed);
  assert.deepEqual(action, { kind: "root-cause", text: "bad config" });
});

test("completionToAction: narrate JSON becomes narrate action", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({ role: "assistant", content: '{"kind":"narrate","phase":"act","text":"fixing"}' }, true),
  );
  const action = completionToAction(parsed);
  assert.deepEqual(action, { kind: "narrate", phase: "act", text: "fixing" });
});

test("completionToAction: done JSON becomes done action", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({
      role: "assistant",
      content: '{"kind":"done","summary":{"rootCause":"r","changes":["c"],"verification":["v"]}}',
    }, true),
  );
  const action = completionToAction(parsed);
  assert.deepEqual(action, {
    kind: "done",
    summary: { rootCause: "r", changes: ["c"], verification: ["v"] },
  });
});

test("completionToAction: prose without control JSON falls back to narration", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({ role: "assistant", content: "Let me think about this." }, true),
  );
  const action = completionToAction(parsed);
  assert.deepEqual(action, { kind: "narrate", phase: "other", text: "Let me think about this." });
});

test("completionToAction: finish_reason=length (done=false) throws", () => {
  const parsed = parseOllamaResponse(
    ollamaResponse({ role: "assistant", content: "partial" }, false),
  );
  assert.throws(() => completionToAction(parsed), OllamaError);
});

// ── textual tool-call detection ─────────────────────────────────────────────

const TOOLS = ["read", "search", "write", "terminal"];

test("completionToAction: tool call written as prose -> textual-call-detected", () => {
  for (const content of [
    'read({"path":"x"})',
    'call terminal({"command":"sh app.sh"})',
  ]) {
    const parsed = parseOllamaResponse(
      ollamaResponse({ role: "assistant", content }, true),
    );
    const action = completionToAction(parsed, TOOLS);
    assert.equal(action.kind, "textual-call-detected", `content: ${content}`);
  }
});

test("detector is NARROW: discussion does NOT trigger", () => {
  for (const content of [
    "I will use read next to inspect the file.",
    "Next step: search the workspace.",
  ]) {
    const parsed = parseOllamaResponse(
      ollamaResponse({ role: "assistant", content }, true),
    );
    const action = completionToAction(parsed, TOOLS);
    assert.equal(action.kind, "narrate", `discussion must narrate: ${content}`);
  }
});

// ── OllamaDriver (integration with fake fetch) ──────────────────────────────

test("OllamaDriver: defaults are sensible", () => {
  const driver = new OllamaDriver({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }) as any });
  assert.equal(driver.baseUrl, "http://localhost:11434");
  assert.equal(driver.model, "llama3.2");
});

test("OllamaDriver: sends correct URL and body shape", async () => {
  const canned = ollamaResponse({ role: "assistant", content: '{"kind":"narrate","phase":"other","text":"ok"}' }, true);
  const f = fakeFetch(canned);
  const driver = new OllamaDriver({ fetchImpl: f.fn, temperature: 0.5, topP: 0.8 });
  const ctx: DriverContext = { messages: [{ role: "system", content: "s" }], tools: [] };
  await driver.next(ctx);

  assert.equal(f.seen().url, "http://localhost:11434/api/chat");
  const body = JSON.parse(f.seen().body) as Record<string, unknown>;
  assert.equal(body["model"], "llama3.2");
  assert.equal(body["stream"], false);
  assert.equal(body["keep_alive"], "5m");
  const opts = body["options"] as Record<string, unknown>;
  assert.equal(opts["temperature"], 0.5);
  assert.equal(opts["top_p"], 0.8);
  assert.equal(opts["repeat_penalty"], 1.1);
});

test("OllamaDriver: no auth header (local server)", async () => {
  const canned = ollamaResponse({ role: "assistant", content: '{"kind":"narrate","phase":"other","text":"ok"}' }, true);
  const f = fakeFetch(canned);
  const driver = new OllamaDriver({ fetchImpl: f.fn });
  await driver.next({ messages: [{ role: "system", content: "s" }], tools: [] });
  assert.ok(!("authorization" in f.seen().headers), "no auth header");
});

test("OllamaDriver: network error throws OllamaError", async () => {
  const driver = new OllamaDriver({
    fetchImpl: async () => { throw new Error("connection refused"); },
  });
  await assert.rejects(
    () => driver.next({ messages: [{ role: "system", content: "s" }], tools: [] }),
    (err: unknown) => {
      assert.ok(err instanceof OllamaError);
      assert.match(err.message, /network error/);
      return true;
    },
  );
});

test("OllamaDriver: custom params passed in options object", async () => {
  const canned = ollamaResponse({ role: "assistant", content: '{"kind":"narrate","phase":"other","text":"ok"}' }, true);
  const f = fakeFetch(canned);
  const driver = new OllamaDriver({
    fetchImpl: f.fn,
    baseUrl: "http://gpu:11434",
    model: "qwen2.5:7b",
    temperature: 0.3,
    numCtx: 4096,
    numGpu: 99,
    mirostat: 2,
    seed: 42,
    keepAlive: "10m",
  });
  await driver.next({ messages: [{ role: "system", content: "s" }], tools: [] });

  assert.equal(f.seen().url, "http://gpu:11434/api/chat");
  const body = JSON.parse(f.seen().body) as Record<string, unknown>;
  assert.equal(body["model"], "qwen2.5:7b");
  assert.equal(body["keep_alive"], "10m");
  const opts = body["options"] as Record<string, unknown>;
  assert.equal(opts["temperature"], 0.3);
  assert.equal(opts["num_ctx"], 4096);
  assert.equal(opts["num_gpu"], 99);
  assert.equal(opts["mirostat"], 2);
  assert.equal(opts["seed"], 42);
});
