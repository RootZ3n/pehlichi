/**
 * WorkOrderStore — typed CRUD + lifecycle validation.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { WorkOrderStore, WorkOrderTransitionError, WorkOrderValidationError, assertTransition } from "./work-order-store.js";

const dirs: string[] = [];
function freshStore(): WorkOrderStore {
  const dir = mkdtempSync(join(tmpdir(), "wo-store-"));
  dirs.push(dir);
  return new WorkOrderStore({ dir });
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("create allocates sequential WO ids and starts at open", async () => {
  const store = freshStore();
  const a = await store.create({ title: "A", description: "d", source: "ptah", severity: "high", category: "bug" });
  const b = await store.create({ title: "B", description: "d", source: "ptah", severity: "low", category: "bug" });
  assert.equal(a.id, "WO-0001");
  assert.equal(b.id, "WO-0002");
  assert.equal(a.status, "open");
});

test("get returns null for unknown id; list filters by status", async () => {
  const store = freshStore();
  assert.equal(await store.get("WO-9999"), null);
  await store.create({ title: "open one", description: "d", source: "ptah", severity: "high", category: "bug" });
  const wo2 = await store.create({ title: "assigned one", description: "d", source: "ptah", severity: "low", category: "bug" });
  await store.transition(wo2.id, "assigned", { note: "claimed" });
  const open = await store.list({ status: "open" });
  assert.equal(open.length, 1);
  assert.equal(open[0]?.title, "open one");
});

test("list sorts by severity then recency", async () => {
  const store = freshStore();
  await store.create({ title: "low", description: "d", source: "ptah", severity: "low", category: "bug" });
  await store.create({ title: "critical", description: "d", source: "ptah", severity: "critical", category: "bug" });
  const all = await store.list();
  assert.equal(all[0]?.severity, "critical");
});

test("transition validates the lifecycle and rejects illegal moves", async () => {
  const store = freshStore();
  const wo = await store.create({ title: "x", description: "d", source: "ptah", severity: "high", category: "bug" });
  // open -> done is illegal (must go through assigned/in-progress)
  await assert.rejects(() => store.transition(wo.id, "done", { resolution: { summary: "s", resolvedAt: "t" } }), WorkOrderTransitionError);
  await assert.rejects(() => store.transition(wo.id, "in-progress"), WorkOrderTransitionError);
  await store.transition(wo.id, "assigned", { note: "claimed" });
  await store.transition(wo.id, "in-progress", { note: "starting" });
  const done = await store.transition(wo.id, "done", { resolution: { summary: "fixed", resolvedAt: "2026-01-01" } });
  assert.equal(done?.status, "done");
  assert.equal(done?.resolution?.summary, "fixed");
});

test("transition to done can record only the lifecycle change", async () => {
  const store = freshStore();
  const wo = await store.create({ title: "x", description: "d", source: "ptah", severity: "high", category: "bug" });
  await store.transition(wo.id, "assigned");
  await store.transition(wo.id, "in-progress");
  const done = await store.transition(wo.id, "done");
  assert.equal(done?.status, "done");
});

test("appendNote and appendRouting accumulate", async () => {
  const store = freshStore();
  const wo = await store.create({ title: "x", description: "d", source: "ptah", severity: "high", category: "creative" });
  await store.appendNote(wo.id, "note one");
  const routed = await store.appendRouting(wo.id, "luna");
  assert.equal(routed?.routedTo?.[0], "luna");
  const got = await store.get(wo.id);
  assert.ok(got?.notes?.some((n) => n.includes("note one")));
});

test("reads are lenient about legacy/unknown statuses", () => {
  // a legacy "resolved" status (older Atoni build) can still transition.
  assert.doesNotThrow(() => assertTransition("resolved", "open"));
  // same-status is an idempotent no-op
  assert.doesNotThrow(() => assertTransition("open", "open"));
  // unknown TARGET status is always rejected
  assert.throws(() => assertTransition("open", "frobnicate" as never), WorkOrderTransitionError);
});

test("create validates required fields and enums", async () => {
  const store = freshStore();
  await assert.rejects(
    () => store.create({ title: "", description: "d", source: "ptah", severity: "high", category: "bug" }),
    WorkOrderValidationError,
  );
  await assert.rejects(
    () => store.create({ title: "x", description: "d", source: "bogus" as never, severity: "high", category: "bug" }),
    /invalid source/,
  );
});

test("stats summarizes the queue", async () => {
  const store = freshStore();
  await store.create({ title: "a", description: "d", source: "ptah", severity: "high", category: "bug" });
  const b = await store.create({ title: "b", description: "d", source: "ptah", severity: "low", category: "bug" });
  await store.transition(b.id, "assigned");
  await store.transition(b.id, "in-progress");
  const stats = await store.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.open, 1);
  assert.equal(stats.inProgress, 1);
});
