/**
 * THE LATENT PREFIX TRAPS.
 *
 * Neither flag is enabled in production, and the point of these cases is to keep it that way
 * accidentally-proof: the guard must be invisible when they are off, and must refuse — with the
 * reason — the moment one is on and per-turn context would reach the system head.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertDynamicContextIsPrefixSafe,
  enabledPrefixRiskFlags,
  PrefixStabilityError,
} from "./prefix-stability-guard.js";

test("production shape: neither flag set, so the guard is a no-op", () => {
  const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;
  assert.deepEqual(enabledPrefixRiskFlags(env), []);
  // Even with context present, nothing is refused: no per-turn contributor is enabled.
  assert.doesNotThrow(() => assertDynamicContextIsPrefixSafe(env, true));
});

test("no per-turn context means nothing to refuse, whatever the flags say", () => {
  const env = { LAB_TRUTH: "1", LAB_TRANSCRIPT_DIR: "/tmp/x" } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => assertDynamicContextIsPrefixSafe(env, false));
});

test("LAB_TRANSCRIPT_DIR is read as PRESENCE, matching how the server derives LAB_MEMORY_ON", () => {
  assert.deepEqual(enabledPrefixRiskFlags({ LAB_TRANSCRIPT_DIR: "/tmp/t" } as NodeJS.ProcessEnv), ["LAB_TRANSCRIPT_DIR"]);
  // Empty string is absence: `!!""` is false, and the guard must agree with the server.
  assert.deepEqual(enabledPrefixRiskFlags({ LAB_TRANSCRIPT_DIR: "" } as NodeJS.ProcessEnv), []);
});

test("LAB_TRUTH is read as the exact string '1', matching truthLayerEnabled", () => {
  assert.deepEqual(enabledPrefixRiskFlags({ LAB_TRUTH: "1" } as NodeJS.ProcessEnv), ["LAB_TRUTH"]);
  for (const v of ["true", "0", "yes", ""]) {
    assert.deepEqual(enabledPrefixRiskFlags({ LAB_TRUTH: v } as NodeJS.ProcessEnv), [], `LAB_TRUTH=${v}`);
  }
});

test("enabling a contributor FAILS CLOSED and names both the cost and the alternative", () => {
  const env = { LAB_TRUTH: "1" } as NodeJS.ProcessEnv;
  assert.throws(
    () => assertDynamicContextIsPrefixSafe(env, true),
    (e: unknown) => {
      assert.ok(e instanceof PrefixStabilityError);
      assert.match(e.message, /LAB_TRUTH/);
      assert.match(e.message, /truth-cognition/);
      assert.match(e.message, /append-only history channel/);
      return true;
    },
  );
});

test("both flags are named together when both are on", () => {
  const env = { LAB_TRUTH: "1", LAB_TRANSCRIPT_DIR: "/tmp/t" } as NodeJS.ProcessEnv;
  assert.throws(() => assertDynamicContextIsPrefixSafe(env, true), (e: unknown) => {
    assert.match((e as Error).message, /LAB_TRANSCRIPT_DIR/);
    assert.match((e as Error).message, /LAB_TRUTH/);
    return true;
  });
});
