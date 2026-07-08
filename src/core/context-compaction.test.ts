/**
 * CONTEXT COMPACTION (P1.1) — the compressor triggers past the window threshold and, with no
 * summarizer model available, deterministically drops middle turns (no network). This is the
 * mechanism the kernel run now enables by default via KernelChatSession's context window.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ContextCompressor } from "./context-compressor.js";

function bigMessages(n: number, chars: number): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = [{ role: "system", content: "sys" }];
  for (let i = 0; i < n; i++) msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(chars) });
  return msgs;
}

test("shouldCompress is false below the threshold and true above it", () => {
  const c = new ContextCompressor({ apiKey: "" });
  const small = [{ role: "user", content: "hello" }];
  assert.equal(c.shouldCompress(small, 128_000), false);
  // ~ (20 msgs * 4000 chars)/4 ≈ 20k tokens > 80% of a 1000-token window.
  assert.equal(c.shouldCompress(bigMessages(20, 4000), 1000), true);
});

test("compress deterministically drops middle turns when no summarizer model is available", async () => {
  // apiKey '' ⇒ generateSummary returns null ⇒ deterministic (no-network) fallback.
  const c = new ContextCompressor({ apiKey: "" });
  const messages = bigMessages(30, 2000);
  const result = await c.compress(messages, { contextWindow: 1000 });
  assert.equal(result.compressed, true, "a long transcript is compacted");
  assert.ok(result.compressedCount < result.originalCount, "message count is reduced");
});
