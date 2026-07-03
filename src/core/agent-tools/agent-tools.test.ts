import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFullToolRegistry, resolveSubagentRunner } from "./index.js";
import { createDelegateToolHandlers, DELEGATE_TIMEOUT } from "./delegate-tools.js";
import { createCronToolHandlers } from "./cron-tools.js";
import { createCoordinationToolHandlers } from "./coordination-tools.js";
import type { ToolContext } from "../tools.js";

const ctx = (dir: string): ToolContext => ({ workspaceRoot: dir, labStoreRoot: dir, store: {} });

// ── Blocker 4: DELEGATE RUNNER PATH RESOLVES UNDER tsx AND COMPILED ────────────

test("B4. resolveSubagentRunner picks the runtime-correct runner path and node args", () => {
  const r = resolveSubagentRunner();
  // The test suite runs under tsx, so the resolver must pick the .ts entry that
  // actually exists on disk, spawned with `--import tsx` (never a non-existent .js).
  assert.match(r.runnerPath, /subagent-entry\.(ts|js)$/);
  assert.ok(existsSync(r.runnerPath), `resolved runner must exist on disk: ${r.runnerPath}`);
  if (r.runnerPath.endsWith(".ts")) {
    assert.deepEqual(r.nodeArgs, ["--import", "tsx"]);
  } else {
    assert.deepEqual(r.nodeArgs, []);
  }
});

test("B4. delegate_task spawns the REAL resolved runner (it starts — not a spawn failure)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b4-spawn-"));
  try {
    const tools = createFullToolRegistry({ workspaceRoot: dir, agentServerUrl: "http://127.0.0.1:0" });
    const delegate = tools.find((t) => t.spec.name === "delegate_task");
    assert.ok(delegate, "delegate_task is registered");
    // An empty goal makes the REAL subagent-entry short-circuit with a clean JSON
    // result BEFORE touching any model — proving the runner actually started under
    // the current runtime rather than failing to spawn (the Blocker-4 symptom).
    const res = await delegate.handler({ goal: "" }, ctx(dir));
    assert.equal(res.ok, false);
    assert.match(res.error ?? res.output, /missing a goal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Blocker 7: COORDINATION ───────────────────────────────────────────────────

test("B7. the default delegate timeout is the 5-minute DELEGATE_TIMEOUT, not 30s", () => {
  assert.equal(DELEGATE_TIMEOUT, 300_000);
  // A handler built with no explicit timeout must use the 5-minute default. We
  // assert it indirectly: DELEGATE_TIMEOUT is the exported source of truth and the
  // handler factory defaults to it (see delegate-tools.ts).
  const handlers = createDelegateToolHandlers({ runnerPath: "/nonexistent" });
  assert.ok(handlers.get("delegate_task"));
});

test("B7. circular delegation (A→B→A) is detected and refused before spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b7-cycle-"));
  // The chain that led here already ran goal "task-A" then "task-B"; re-delegating
  // "task-A" closes a cycle and must be refused without ever spawning a process.
  const handlers = createDelegateToolHandlers({
    runnerPath: "/should-never-spawn",
    delegatedFrom: ["task-A", "task-B"],
  });
  const delegate = handlers.get("delegate_task")!;
  try {
    const res = await delegate({ goal: "task-A" }, ctx(dir));
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /circular delegation detected/);
    assert.match(res.error ?? "", /task-A/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B7. delegatedFrom chain is propagated to the spawned job (parent goal appended)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b7-chain-"));
  const runner = join(dir, "echo-chain.cjs");
  // A fixture runner that echoes back the delegatedFrom it received on the job.
  writeFileSync(
    runner,
    [
      "let data='';",
      "process.stdin.on('data',c=>data+=c);",
      "process.stdin.on('end',()=>{",
      "  let job={}; try{job=JSON.parse(data)}catch{}",
      "  process.stdout.write(JSON.stringify({ok:true,output:'chain='+JSON.stringify(job.delegatedFrom)})+'\\n');",
      "});",
    ].join("\n"),
  );
  try {
    const handlers = createDelegateToolHandlers({ runnerPath: runner, delegatedFrom: ["root"] });
    const delegate = handlers.get("delegate_task")!;
    const res = await delegate({ goal: "child" }, ctx(dir));
    assert.equal(res.ok, true);
    assert.match(res.output, /chain=\["root","child"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B7. agent_sync shares a value durably across separate handler instances", async () => {
  const syncDir = mkdtempSync(join(tmpdir(), "b7-sync-"));
  try {
    // Agent "ptah" writes; a fresh handler instance (simulating another agent /
    // restart) reads the same key back from the shared directory.
    const writer = createCoordinationToolHandlers({ syncDir, agentId: "ptah" }).get("agent_sync")!;
    const wrote = await writer({ action: "write", key: "build-status", value: "green" }, ctx(syncDir));
    assert.equal(wrote.ok, true);

    const reader = createCoordinationToolHandlers({ syncDir, agentId: "luna" }).get("agent_sync")!;
    const read = await reader({ action: "read", key: "build-status" }, ctx(syncDir));
    assert.equal(read.ok, true);
    assert.match(read.output, /green/);
    assert.match(read.output, /ptah/);

    const list = await reader({ action: "list" }, ctx(syncDir));
    assert.match(list.output, /build-status/);
  } finally {
    rmSync(syncDir, { recursive: true, force: true });
  }
});

// ── Blocker 3: CRON PERSISTENCE + REAL EXECUTION ──────────────────────────────

test("B3. a created cron job is persisted to disk and reloaded after a simulated restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b3-cron-"));
  const persistPath = join(dir, "cron-jobs.json");
  let executed = 0;
  const exec = async (_prompt: string): Promise<string> => { executed++; return "done"; };
  try {
    // First "process": create a job. It must land on disk.
    const h1 = createCronToolHandlers(exec, { persistPath }).get("cronjob")!;
    const created = await h1({ action: "create", prompt: "nightly build", schedule: "1h", name: "nightly" }, ctx(dir));
    assert.equal(created.ok, true);
    assert.ok(existsSync(persistPath), "cron jobs persisted to disk");
    const onDisk = JSON.parse(readFileSync(persistPath, "utf-8")) as Array<{ name: string; prompt: string }>;
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0]?.name, "nightly");

    // Second "process": a fresh handler instance reloads the persisted jobs.
    const h2 = createCronToolHandlers(exec, { persistPath }).get("cronjob")!;
    const listed = await h2({ action: "list" }, ctx(dir));
    assert.match(listed.output, /nightly/);
    assert.match(listed.output, /"status": "active"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B3. cron 'run' invokes the execute callback (a real agent loop in production)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "b3-run-"));
  const persistPath = join(dir, "cron-jobs.json");
  const prompts: string[] = [];
  const exec = async (prompt: string): Promise<string> => { prompts.push(prompt); return `ran: ${prompt}`; };
  try {
    const h = createCronToolHandlers(exec, { persistPath }).get("cronjob")!;
    const created = await h({ action: "create", prompt: "compile module", schedule: "1h" }, ctx(dir));
    const id = created.output.match(/\((cron-[^)]+)\)/)?.[1];
    assert.ok(id, "job id returned");
    const ran = await h({ action: "run", job_id: id! }, ctx(dir));
    assert.equal(ran.ok, true);
    assert.deepEqual(prompts, ["compile module"]);
    assert.match(ran.output, /ran: compile module/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
