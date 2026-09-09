/**
 * PREFIX IDENTITY — the diagnostic that must not become a leak.
 *
 * Two properties are load-bearing: the digest must CHANGE when the stable head changes (or it
 * detects nothing), and it must NOT change when the conversation merely grows (or it reports a
 * violation on every turn and means nothing). The third is that no prompt bytes survive in it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message, ToolSpec } from "./driver.js";
import { PREFIX_SCHEME, prefixIdentity } from "./prefix-identity.js";

const TOOLS: ToolSpec[] = [
  { name: "read_file", description: "Read a file." },
  { name: "terminal", description: "Run a command." },
];
const SYSTEM: Message = { role: "system", content: "You are Peh. Operate under this contract." };
const PROTOCOL: Message = { role: "system", content: "RESPONSE PROTOCOL — follow exactly." };

test("a growing conversation does NOT change the prefix digest", () => {
  const turn1: Message[] = [SYSTEM, PROTOCOL, { role: "user", content: "hello" }];
  const turn2: Message[] = [
    ...turn1,
    { role: "assistant", content: "[narrate] thinking" },
    { role: "tool", content: "TOOL RESULT: ok" },
    { role: "user", content: "and now?" },
  ];
  assert.equal(prefixIdentity(turn2, TOOLS).digest, prefixIdentity(turn1, TOOLS).digest);
});

test("a changed system head DOES change the digest", () => {
  const base: Message[] = [SYSTEM, PROTOCOL, { role: "user", content: "hi" }];
  const edited: Message[] = [{ ...SYSTEM, content: `${SYSTEM.content} Extra.` }, PROTOCOL, { role: "user", content: "hi" }];
  assert.notEqual(prefixIdentity(edited, TOOLS).digest, prefixIdentity(base, TOOLS).digest);
});

test("a changed tool surface changes the digest — set, order, and description alike", () => {
  const msgs: Message[] = [SYSTEM, { role: "user", content: "hi" }];
  const base = prefixIdentity(msgs, TOOLS).digest;
  assert.notEqual(prefixIdentity(msgs, [...TOOLS].reverse()).digest, base, "order matters: it is sent order");
  assert.notEqual(prefixIdentity(msgs, TOOLS.slice(0, 1)).digest, base, "membership matters");
  assert.notEqual(
    prefixIdentity(msgs, [{ name: "read_file", description: "Read a file, differently." }, TOOLS[1]!]).digest,
    base,
    "descriptions are prompt bytes too",
  );
});

test("the encoding is unambiguous: re-cutting the same characters is a different digest", () => {
  // Without length prefixes, ["ab","c"] and ["a","bc"] would concatenate identically.
  const a = prefixIdentity([{ role: "system", content: "ab" }, { role: "system", content: "c" }], []);
  const b = prefixIdentity([{ role: "system", content: "a" }, { role: "system", content: "bc" }], []);
  assert.notEqual(a.digest, b.digest);
});

test("only LEADING system messages count — a later system turn is conversation, not head", () => {
  const withTrailing: Message[] = [SYSTEM, { role: "user", content: "hi" }, { role: "system", content: "late" }];
  const without: Message[] = [SYSTEM, { role: "user", content: "hi" }];
  assert.equal(prefixIdentity(withTrailing, TOOLS).digest, prefixIdentity(without, TOOLS).digest);
});

test("the digest carries no prompt bytes and is a stable hex sha256", () => {
  const id = prefixIdentity([SYSTEM, PROTOCOL], TOOLS);
  assert.equal(id.scheme, PREFIX_SCHEME);
  assert.match(id.digest, /^[0-9a-f]{64}$/);
  // Nothing recognisable from the prompt may appear in the recorded value.
  for (const secretish of ["Peh", "contract", "read_file", "RESPONSE"]) {
    assert.ok(!id.digest.includes(secretish.toLowerCase()), `digest leaked ${secretish}`);
  }
});

test("the same inputs always produce the same digest", () => {
  const msgs: Message[] = [SYSTEM, PROTOCOL, { role: "user", content: "hi" }];
  assert.equal(prefixIdentity(msgs, TOOLS).digest, prefixIdentity(msgs, TOOLS).digest);
});
