/**
 * WRITE SAFETY (P0.3) — mutations on the live path are REVERSIBLE. write_file/patch now
 * report a before/after diff; the KernelChatSession journals every edit and can undo it,
 * so a mutation the agent makes on the real workspace is never unrecoverable.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AddressInfo } from "node:net";

import { ScriptedDriver, type DriverAction, type ToolContext } from "../../src/core/index.js";
import { createFullToolRegistry } from "../../src/core/agent-tools/index.js";
import { createEnhancedFileToolHandlers } from "../../src/core/agent-tools/enhanced-file-tools.js";
import { defaultApprovalPolicy } from "../../src/core/approval-policy.js";
import type { AgentProfile } from "../../src/core/profile.js";
import { KernelChatSession } from "./lib/kernel-session.js";
import { createPehServer, type PehServerOptions } from "./server.js";

async function withServer<T>(opts: PehServerOptions, fn: (base: string) => Promise<T>): Promise<T> {
  const { server } = createPehServer(opts);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const testProfile: AgentProfile = {
  name: "WriteSafetyAgent",
  role: "test",
  personaPreamble: "You are a generic test agent.",
  skillTags: ["test"],
};

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── tool-level: write_file / patch report a reversible diff ────────────────────

test("write_file returns a diff with before=null for a NEW file", async () => {
  const ws = tmp("ws-");
  try {
    const handlers = createEnhancedFileToolHandlers(ws);
    const write = handlers.get("write_file")!;
    const res = await write({ path: "new.txt", content: "hello" }, {} as ToolContext);
    assert.equal(res.ok, true);
    assert.ok(res.diff, "write_file must report a diff for reversibility");
    assert.equal(res.diff!.before, null, "a new file has no prior content");
    assert.equal(res.diff!.after, "hello");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("patch returns a diff carrying the exact pre-patch content", async () => {
  const ws = tmp("ws-");
  try {
    writeFileSync(join(ws, "f.txt"), "alpha beta gamma");
    const handlers = createEnhancedFileToolHandlers(ws);
    const patch = handlers.get("patch")!;
    const res = await patch({ path: "f.txt", old_string: "beta", new_string: "BETA" }, {} as ToolContext);
    assert.equal(res.ok, true);
    assert.ok(res.diff);
    assert.equal(res.diff!.before, "alpha beta gamma");
    assert.equal(res.diff!.after, "alpha BETA gamma");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── P1.3: pre-write syntax gate (JSON) ─────────────────────────────────────────

test("write_file REFUSES invalid JSON and makes no change", async () => {
  const ws = tmp("ws-");
  try {
    const handlers = createEnhancedFileToolHandlers(ws);
    const write = handlers.get("write_file")!;
    const res = await write({ path: "cfg.json", content: '{"a": 1,,}' }, {} as ToolContext);
    assert.equal(res.ok, false, "invalid JSON is rejected");
    assert.match(res.error ?? "", /invalid JSON/);
    assert.equal(existsSync(join(ws, "cfg.json")), false, "no file was written");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("write_file ALLOWS valid JSON and non-JSON content", async () => {
  const ws = tmp("ws-");
  try {
    const handlers = createEnhancedFileToolHandlers(ws);
    const write = handlers.get("write_file")!;
    assert.equal((await write({ path: "ok.json", content: '{"a":1}' }, {} as ToolContext)).ok, true);
    assert.equal((await write({ path: "notes.md", content: "# not json {" }, {} as ToolContext)).ok, true, "non-JSON is not gated");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("patch REFUSES an edit that would corrupt a JSON file", async () => {
  const ws = tmp("ws-");
  try {
    writeFileSync(join(ws, "pkg.json"), '{"name":"x","version":"1"}');
    const handlers = createEnhancedFileToolHandlers(ws);
    const patch = handlers.get("patch")!;
    // Remove the closing brace → invalid JSON.
    const res = await patch({ path: "pkg.json", old_string: '"version":"1"}', new_string: '"version":"1"' }, {} as ToolContext);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /invalid JSON/);
    assert.equal(readFileSync(join(ws, "pkg.json"), "utf8"), '{"name":"x","version":"1"}', "file is unchanged");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ── session-level: journal + undo ──────────────────────────────────────────────

function writeSession(ws: string, store: string, actions: DriverAction[]): KernelChatSession {
  return new KernelChatSession({
    profile: testProfile,
    driver: new ScriptedDriver(actions),
    workspaceRoot: ws,
    labStoreRoot: store,
    extraTools: createFullToolRegistry({ workspaceRoot: ws, agentServerUrl: "http://x", agentId: "test-agent" }),
    toolNames: ["write_file"],
    approvalCallback: defaultApprovalPolicy({ allowWrites: true }),
  });
}

test("HTTP: /capabilities reflects the real write posture, undo, and unwired features", async () => {
  const ws = tmp("ws-");
  const store = tmp("store-");
  try {
    // Writes OFF: the report must say so and must NOT over-claim compaction/schema-repair.
    await withServer(
      { driver: new ScriptedDriver([]), workspaceRoot: ws, labStoreRoot: store, allowWrites: false },
      async (base) => {
        const caps = (await (await fetch(`${base}/capabilities`)).json()) as {
          capabilities: Record<string, unknown>;
          writePosture: string;
          endpoints: string[];
        };
        assert.equal(caps.capabilities.writesEnabled, false, "writes off ⇒ reported false");
        assert.equal(caps.writePosture, "read-only");
        assert.equal(caps.capabilities.undo, true, "undo is always available");
        assert.equal(caps.capabilities.reversibleWrites, true);
        assert.equal(caps.capabilities.contextCompaction, true, "P1.1: compaction is wired");
        assert.equal(caps.capabilities.schemaRepair, true, "P1.2: live-path arg repair is wired");
        assert.equal(caps.capabilities.providerSwitch, true, "P2: runtime model hot-swap is wired");
        assert.ok(caps.endpoints.includes("/undo"), "new endpoints are advertised");
      },
    );
    // Writes ON: posture flips truthfully.
    await withServer(
      { driver: new ScriptedDriver([]), workspaceRoot: ws, labStoreRoot: store, allowWrites: true },
      async (base) => {
        const caps = (await (await fetch(`${base}/capabilities`)).json()) as {
          capabilities: Record<string, unknown>;
          writePosture: string;
        };
        assert.equal(caps.capabilities.writesEnabled, true);
        assert.equal(caps.writePosture, "writes-enabled");
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── production admission ───────────────────────────────────────────────────────────────────
//
// ADMISSION_REFUSED_AS_REQUIRED. The journal and undo path is populated by a completed turn,
// so it cannot be exercised while the agent is locked. The tool-level write safety above --
// workspace confinement and approval gating -- is unaffected and still enforced, and it is
// the half that decides whether a write is allowed to be attempted at all.

test('a session that is refused admission writes nothing and journals nothing', async () => {
  const ws = tmp("ws-");
  const store = tmp("store-");
  try {
    const session = writeSession(ws, store, [
      { kind: "tool", tool: "write_file", args: { path: "note.txt", content: "v1" } },
      { kind: "done", summary: { rootCause: "wrote note", changes: ["note.txt"], verification: ["wrote file"] } },
    ]);
    await assert.rejects(() => session.send("write the note"), /OPERATIONAL_WORK_NOT_AUTHORIZED/);
    assert.deepEqual(session.changedFiles(), [], "a refused turn journaled an edit");
    assert.equal(existsSync(join(ws, "note.txt")), false, "a refused turn wrote a file");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});
