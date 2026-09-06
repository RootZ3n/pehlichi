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
  toWireToolName,
  fromWireToolName,
  withReasoning,
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
  assert.equal(body["model"], "mimo-v2.5");
  assert.equal(body["max_completion_tokens"], 12288);
  /*
    NO PROVIDER-SPECIFIC FIELD unless a provider asked for one.

    This assertion used to require `thinking: {type:"disabled"}` on every request -- a MiMo
    parameter that the driver sent to whatever endpoint it was pointed at, including GLM and
    DeepSeek, where it is at best ignored and at worst a malformed request. Provider extras now
    travel with the root-owned provider profile, so a deployment with no profile sends none.
  */
  assert.equal("thinking" in body, false, "a provider-specific field was sent without a provider asking");
  assert.equal("stream" in body, false, "streaming was requested without being negotiated");
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

// ── wire-safe tool names: the lab's namespace vs the wire's rules ────────────────────────────

test('a dotted tool name is made wire-safe, and mapped back', () => {
  /*
    OpenAI-style function calling specifies ^[a-zA-Z0-9_-]{1,64}$. Three lab tools are namespaced
    with a dot; GLM and MiMo accept them and DeepSeek refuses the WHOLE request, so an agent with
    its full lane could not make a single call. The translation belongs at the boundary between the
    lab's namespace and the wire's rules, not in a rename across skills, prompts and authority.
  */
  assert.equal(toWireToolName('bridge.health'), 'bridge_health');
  assert.equal(toWireToolName('read_file'), 'read_file', 'a compliant name must pass through untouched');
  assert.equal(toWireToolName('a-b_9'), 'a-b_9');
  const offered = ['bridge.health', 'bridge.list', 'read_file'];
  assert.equal(fromWireToolName('bridge_health', offered), 'bridge.health');
  assert.equal(fromWireToolName('read_file', offered), 'read_file');
  // An unknown name is returned unchanged so the lane check refuses it, which is where an unknown
  // tool belongs — inventing a mapping would be guessing what the model meant.
  assert.equal(fromWireToolName('not_a_tool', offered), 'not_a_tool');
});

test('every name a provider is offered satisfies the wire contract', () => {
  const spec = (name: string): ToolSpec => ({ name, description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } });
  const wire = toProviderTools(['bridge.health', 'bridge.list', 'bridge.request', 'read_file', 'terminal'].map(spec));
  for (const entry of wire) {
    const name = (entry.function as { name: string }).name;
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/, `${name} would be refused by a strict provider`);
  }
});

test('a name collision on the wire is refused, not silently merged', () => {
  const spec = (name: string): ToolSpec => ({ name, description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } });
  // Two tools that map to one wire name would merge into a single function the model can call,
  // and the runtime would have no way to know which one it meant.
  assert.throws(() => toProviderTools([spec('bridge.health'), spec('bridge_health')]),
    /both become bridge_health/);
});

test("a thinking model's reasoning is carried out of the completion", () => {
  const parsed = parseChatCompletion({ choices: [{ finish_reason: 'stop',
    message: { content: 'BLUE', reasoning_content: 'The user asked for a colour.' } }] });
  assert.equal(parsed.reasoningContent, 'The user asked for a colour.');
  assert.equal(parsed.content, 'BLUE');
  // Absent or empty reasoning stays absent rather than becoming an empty string, so the driver
  // never sends a field claiming the model thought nothing.
  assert.equal(parseChatCompletion(completion({ content: 'x' }, 'stop')).reasoningContent, undefined);
  assert.equal(parseChatCompletion({ choices: [{ finish_reason: 'stop',
    message: { content: 'x', reasoning_content: '' } }] }).reasoningContent, undefined);
});

test('the reasoning is returned on the assistant turn being continued', () => {
  /*
    DeepSeek refuses a continuation whose assistant turn dropped its reasoning:
    400 "The `reasoning_content` in the thinking mode must be passed back to the API".
    It attaches to the LAST assistant message because that is the turn being continued.
  */
  const wire = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: 'first' },
    { role: 'user', content: 'TOOL RESULT:\nok' },
    { role: 'assistant', content: 'second' },
  ];
  const out = withReasoning(wire, ['first thoughts', 'second thoughts']);
  assert.equal(out[3]?.['reasoning_content'], 'second thoughts', 'the continued turn carries the latest');
  assert.equal(out[1]?.['reasoning_content'], 'first thoughts', 'the earlier turn carries its own');
  assert.equal(out[3]?.['content'], 'second', 'the content must be untouched');
});

test('every assistant turn carries its own reasoning, paired from the end', () => {
  /*
    Attaching only to the last turn was not enough: the earlier tool-calling turn stayed bare and
    DeepSeek still refused. Pairing runs from the END because the most recent completion produced
    the most recent assistant message.
  */
  const wire = [
    { role: 'assistant', content: 'seeded, no completion behind it' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'TOOL RESULT:\nok' },
    { role: 'assistant', content: 'b' },
  ];
  const out = withReasoning(wire, ['ra', 'rb']);
  assert.equal(out[3]?.['reasoning_content'], 'rb');
  assert.equal(out[1]?.['reasoning_content'], 'ra');
  assert.equal(out[0]?.['reasoning_content'], undefined, 'a turn with no completion is left alone');
});

test('a completion that emitted no reasoning contributes no field', () => {
  // The empty entry still consumes its turn, so later turns stay aligned with their completions.
  const out = withReasoning([
    { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' },
  ], ['ra', '']);
  assert.equal(out[1]?.['reasoning_content'], undefined, 'no reasoning means no field');
  assert.equal(out[0]?.['reasoning_content'], 'ra', 'alignment must not shift');
});

test('no reasoning means no field, and no assistant turn means no change', () => {
  const wire = () => [{ role: 'user', content: 'u' }];
  assert.deepEqual(withReasoning(wire(), []), wire());
  // A conversation with no assistant turn yet is left exactly as it was.
  assert.deepEqual(withReasoning(wire(), ['because']), wire());
});
