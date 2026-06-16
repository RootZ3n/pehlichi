/**
 * GBRAIN BRIDGE TESTS — mocked. No real brain, no `gbrain` binary, no network.
 *
 * Every test swaps the runner via `__setGbrainRunner` so we assert on the exact argv
 * (and stdin) the bridge would hand the CLI, and on how it parses / fails. The default
 * runner (execFileSync with the 30s timeout + ~/.bun/bin PATH) is exercised indirectly
 * by the "constants" check; we never spawn a real process here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GBRAIN_TIMEOUT_MS,
  GbrainError,
  __setGbrainRunner,
  searchBrain,
  thinkBrain,
  putPage,
  syncMemory,
} from "./gbrain-bridge.js";

/** Record calls and return scripted stdout per invocation. */
function recorder(outputs: string[]) {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  let i = 0;
  const restore = __setGbrainRunner((args, opts) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    return outputs[i++] ?? "";
  });
  return { calls, restore };
}

test("GBRAIN_TIMEOUT_MS is the contracted 30s wall-clock cap", () => {
  assert.equal(GBRAIN_TIMEOUT_MS, 30_000);
});

test("searchBrain calls `gbrain search <query>` and parses JSON", () => {
  const { calls, restore } = recorder([JSON.stringify({ results: [{ slug: "a" }] })]);
  try {
    const out = searchBrain("hedge knight") as { results: unknown[] };
    assert.deepEqual(calls[0]!.args, ["search", "hedge knight"]);
    assert.equal(out.results.length, 1);
  } finally {
    restore();
  }
});

test("searchBrain threads --limit when provided", () => {
  const { calls, restore } = recorder(["[]"]);
  try {
    searchBrain("q", { limit: 3 });
    assert.deepEqual(calls[0]!.args, ["search", "q", "--limit", "3"]);
  } finally {
    restore();
  }
});

test("thinkBrain calls `gbrain think <question>` and parses JSON", () => {
  const { calls, restore } = recorder([JSON.stringify({ answer: "42", citations: [] })]);
  try {
    const out = thinkBrain("meaning?") as { answer: string };
    assert.deepEqual(calls[0]!.args, ["think", "meaning?"]);
    assert.equal(out.answer, "42");
  } finally {
    restore();
  }
});

test("non-JSON stdout degrades to a { raw } envelope instead of throwing", () => {
  const { restore } = recorder(["not json at all"]);
  try {
    const out = searchBrain("q") as { raw: string };
    assert.equal(out.raw, "not json at all");
  } finally {
    restore();
  }
});

test("empty stdout degrades to { raw: '' }", () => {
  const { restore } = recorder([""]);
  try {
    assert.deepEqual(thinkBrain("q"), { raw: "" });
  } finally {
    restore();
  }
});

test("putPage pipes content to stdin and uses `gbrain put <slug>`", () => {
  const { calls, restore } = recorder(["wrote page peh-notes\n"]);
  try {
    const md = "---\ntype: note\n---\nhello";
    const out = putPage("peh-notes", md);
    assert.deepEqual(calls[0]!.args, ["put", "peh-notes"]);
    assert.equal(calls[0]!.input, md);
    assert.equal(out, "wrote page peh-notes"); // trimmed
  } finally {
    restore();
  }
});

test("syncMemory imports the tree then embeds --all, returning both transcripts", () => {
  const { calls, restore } = recorder(["imported 12 pages\n", "embedded 12 pages\n"]);
  try {
    const out = syncMemory("/pehverse/repos/lab-memory");
    assert.deepEqual(calls[0]!.args, ["import", "/pehverse/repos/lab-memory"]);
    assert.deepEqual(calls[1]!.args, ["embed", "--all"]);
    assert.deepEqual(out, { import: "imported 12 pages", embed: "embedded 12 pages" });
  } finally {
    restore();
  }
});

test("a runner throw (GbrainError) propagates with exit code + stderr intact", () => {
  const restore = __setGbrainRunner(() => {
    throw new GbrainError("gbrain search: boom", {
      args: ["search", "q"],
      exitCode: 1,
      stderr: "PGLite locked",
      timedOut: false,
    });
  });
  try {
    assert.throws(
      () => searchBrain("q"),
      (err: unknown) => {
        assert.ok(err instanceof GbrainError);
        assert.equal(err.exitCode, 1);
        assert.equal(err.stderr, "PGLite locked");
        assert.equal(err.timedOut, false);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("syncMemory surfaces a timeout on the embed step as a GbrainError", () => {
  let n = 0;
  const restore = __setGbrainRunner(() => {
    if (n++ === 0) return "imported 1 page";
    throw new GbrainError(`gbrain embed: gbrain timed out after ${GBRAIN_TIMEOUT_MS}ms`, {
      args: ["embed", "--all"],
      exitCode: null,
      stderr: "",
      timedOut: true,
    });
  });
  try {
    assert.throws(
      () => syncMemory("/x"),
      (err: unknown) => err instanceof GbrainError && err.timedOut === true,
    );
  } finally {
    restore();
  }
});
