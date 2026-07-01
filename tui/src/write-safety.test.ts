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
    extraTools: createFullToolRegistry({ workspaceRoot: ws, agentServerUrl: "http://x" }),
    approvalCallback: defaultApprovalPolicy({ allowWrites: true }),
  });
}

test("session journals a write and undo() deletes a newly-created file", async () => {
  const ws = tmp("ws-");
  const store = tmp("store-");
  try {
    const session = writeSession(ws, store, [
      { kind: "tool", tool: "write_file", args: { path: "note.txt", content: "v1" } },
      { kind: "done", summary: { rootCause: "wrote note", changes: ["note.txt"], verification: ["wrote file"] } },
    ]);
    await session.send("write the note");

    const changes = session.changedFiles();
    assert.equal(changes.length, 1, "one edit journaled");
    assert.equal(changes[0]!.before, null, "note.txt was newly created");
    const notePath = changes[0]!.path;
    assert.equal(readFileSync(notePath, "utf8"), "v1");

    const u = session.undo();
    assert.equal(u.reverted, notePath);
    assert.ok(!existsSync(notePath), "undo deletes a created file");
    assert.equal(session.changedFiles().length, 0, "journal is popped");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test("undo() restores an OVERWRITTEN file to its prior content", async () => {
  const ws = tmp("ws-");
  const store = tmp("store-");
  try {
    writeFileSync(join(ws, "cfg.txt"), "original");
    const session = writeSession(ws, store, [
      { kind: "tool", tool: "write_file", args: { path: "cfg.txt", content: "clobbered" } },
      { kind: "done", summary: { rootCause: "changed cfg", changes: ["cfg.txt"], verification: ["wrote file"] } },
    ]);
    await session.send("change the config");
    assert.equal(readFileSync(join(ws, "cfg.txt"), "utf8"), "clobbered");

    const u = session.undo();
    assert.equal(u.error, undefined);
    assert.equal(readFileSync(join(ws, "cfg.txt"), "utf8"), "original", "undo restores the prior content");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

test("undo() with nothing journaled reports nothing to revert", async () => {
  const ws = tmp("ws-");
  const store = tmp("store-");
  try {
    const session = writeSession(ws, store, [
      { kind: "done", summary: { rootCause: "answered", changes: [], verification: [], noChangeRequired: true } },
    ]);
    await session.send("just answer");
    const u = session.undo();
    assert.equal(u.reverted, null);
    assert.equal(u.error, undefined);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── HTTP: /session/changes + /undo endpoints ───────────────────────────────────

test("HTTP: a write via /chat is listed by /session/changes and reverted by /undo", async () => {
  const ws = tmp("ws-");
  const store = tmp("store-");
  const actions: DriverAction[] = [
    { kind: "tool", tool: "write_file", args: { path: "endpoint.txt", content: "written-by-agent" } },
    { kind: "done", summary: { rootCause: "wrote the file", changes: ["endpoint.txt"], verification: ["wrote file"] } },
  ];
  try {
    await withServer(
      { driver: new ScriptedDriver(actions), workspaceRoot: ws, labStoreRoot: store, allowWrites: true },
      async (base) => {
        const chat = await fetch(`${base}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "write the endpoint file" }),
        });
        assert.equal(chat.status, 200);
        assert.equal(existsSync(join(ws, "endpoint.txt")), true, "the agent wrote the file");

        const list = await (await fetch(`${base}/session/changes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })).json() as { count: number; changes: { path: string; created: boolean }[] };
        assert.equal(list.count, 1);
        assert.equal(list.changes[0]!.created, true);

        const undo = await (await fetch(`${base}/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })).json() as { reverted: string | null };
        assert.ok(undo.reverted, "undo reports the reverted path");
        assert.equal(existsSync(join(ws, "endpoint.txt")), false, "the created file is gone after /undo");
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(store, { recursive: true, force: true });
  }
});

// ── HTTP: /capabilities reports the TRUE runtime state (P0.4) ───────────────────

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
        assert.equal(caps.capabilities.providerSwitch, false, "P2: still not wired");
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
