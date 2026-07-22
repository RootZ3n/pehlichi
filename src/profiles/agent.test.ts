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

// Trio parity: the tool allowlist is the shared union (swappable). 38 base tools
// + 9 phone-body tools + 7 git-ops + 1 lab_shell + 8 luak (benchmark ground operation).
test("agent toolset is the canonical union", () => {
  assert.equal(agentToolNames.length, 63);
  for (const t of ["bridge.health", "bridge.list", "bridge.request", "lab_status_digest", "lab_recall_conversation"]) {
    assert.ok(agentToolNames.includes(t), `missing ${t}`);
  }
  for (const t of ["phone_take_photo", "phone_battery", "phone_read_text", "phone_speak", "phone_torch"]) {
    assert.ok(agentToolNames.includes(t), `missing phone tool ${t}`);
  }
  for (const t of ["git_status", "git_diff", "git_commit", "git_push", "git_clone"]) {
    assert.ok(agentToolNames.includes(t), `missing git tool ${t}`);
  }
  assert.ok(agentToolNames.includes("lab_shell"), "missing lab_shell");
  for (const t of ["luak_registry", "luak_add_model", "luak_update_model", "luak_run", "luak_leaderboard"]) {
    assert.ok(agentToolNames.includes(t), `missing luak tool ${t}`);
  }
});
