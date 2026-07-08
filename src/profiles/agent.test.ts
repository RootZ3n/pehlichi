import assert from "node:assert/strict";
import { test } from "node:test";
import { agentProfile, agentToolNames } from "./agent.js";

// Per-agent identity pins (OVERLAY — personality; differs per agent).
// Structural invariants live in the shared src/profile.test.ts.
test("agent identity overlay", () => {
  assert.equal(agentProfile.name, "Pehlichi");
  assert.equal(agentProfile.role, "coordinator");
  assert.deepEqual(agentProfile.skillTags, ["coordination", "memory", "routing", "planning", "archivum", "career", "learning", "toba", "nusika", "security"]);
});

// Trio parity: the tool allowlist is the shared 38-tool union (swappable).
test("agent toolset is the canonical union", () => {
  assert.equal(agentToolNames.length, 38);
  for (const t of ["bridge.health", "bridge.list", "bridge.request", "lab_status_digest", "lab_recall_conversation"]) {
    assert.ok(agentToolNames.includes(t), `missing ${t}`);
  }
});
