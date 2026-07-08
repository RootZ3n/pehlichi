/**
 * RUNTIME CAPABILITIES (P0.4) — the report must reflect the ACTUAL wiring, so the agent
 * never advertises a capability that is not active.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { runtimeCapabilities, activeCapabilityList } from "./runtime-capabilities.js";

test("wiring-dependent capabilities reflect the real inputs (not hardcoded true)", () => {
  const caps = runtimeCapabilities({
    allowWrites: false,
    requireEvidence: true,
    schemaRepair: false,
    providerSwitch: false,
    memoryWired: true,
    toolCount: 30,
    // contextWindow omitted ⇒ compaction inactive
  });
  assert.equal(caps.writesEnabled, false, "writes off ⇒ report false");
  assert.equal(caps.evidenceGate, true);
  assert.equal(caps.contextCompaction, false, "no contextWindow ⇒ compaction off");
  assert.equal(caps.schemaRepair, false);
  assert.equal(caps.providerSwitch, false);
  assert.equal(caps.memory, true);
  assert.equal(caps.toolCount, 30);
  // Always-on kernel guarantees stay true.
  assert.equal(caps.kernelLoop, true);
  assert.equal(caps.undo, true);
  assert.equal(caps.reversibleWrites, true);
});

test("compaction flips true only when a context window is wired", () => {
  const off = runtimeCapabilities({ allowWrites: true, requireEvidence: false, schemaRepair: false, providerSwitch: false, memoryWired: false, toolCount: 1 });
  const on = runtimeCapabilities({ allowWrites: true, requireEvidence: false, schemaRepair: false, providerSwitch: false, memoryWired: false, toolCount: 1, contextWindow: 128000 });
  assert.equal(off.contextCompaction, false);
  assert.equal(on.contextCompaction, true);
});

test("activeCapabilityList only lists what is truly on", () => {
  const caps = runtimeCapabilities({ allowWrites: false, requireEvidence: false, schemaRepair: false, providerSwitch: false, memoryWired: false, toolCount: 5 });
  const active = activeCapabilityList(caps);
  assert.ok(active.includes("kernelLoop"));
  assert.ok(active.includes("undo"));
  assert.ok(!active.includes("writesEnabled"), "writes off ⇒ not listed as active");
  assert.ok(!active.includes("schemaRepair"));
  assert.ok(!active.includes("contextCompaction"));
});
