/**
 * ReportStore — persisted multi-model comparison ledger + trend query.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { ReportStore } from "./report-store.js";

const dirs: string[] = [];
function freshStore(clock?: () => number): ReportStore {
  const dir = mkdtempSync(join(tmpdir(), "report-store-"));
  dirs.push(dir);
  return new ReportStore({ path: join(dir, "reports.jsonl"), ...(clock ? { clock } : {}) });
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("record appends JSONL and all() returns newest first", async () => {
  let t = 1000;
  const store = freshStore(() => (t += 1000));
  await store.record({ taskId: "t1", results: [{ model: "mimo-v2.5", latencyMs: 100, tokens: 50, success: true }] });
  await store.record({ taskId: "t2", results: [{ model: "mimo-v2.5", latencyMs: 200, tokens: 60, success: true }] });
  const all = await store.all();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.taskId, "t2"); // newest first
});

test("trends aggregates per model and computes averages + success rate", async () => {
  let t = 1_000_000_000_000;
  const store = freshStore(() => t);
  await store.record({
    taskId: "compare",
    role: "validation-model",
    results: [
      { model: "mimo-v2.5", latencyMs: 100, tokens: 50, success: true, qualityScore: 0.8 },
      { model: "gpt-4", latencyMs: 300, tokens: 80, success: false, qualityScore: 0.6 },
    ],
  });
  await store.record({
    taskId: "compare2",
    role: "validation-model",
    results: [{ model: "mimo-v2.5", latencyMs: 200, tokens: 70, success: true, qualityScore: 0.9 }],
  });
  const trends = await store.trends({ role: "validation-model", days: 30 });
  assert.equal(trends.reportCount, 2);
  const mimo = trends.models.find((m) => m.model === "mimo-v2.5");
  assert.ok(mimo);
  assert.equal(mimo?.count, 2);
  assert.equal(mimo?.avgLatencyMs, 150);
  assert.equal(mimo?.successRate, 1);
  assert.equal(mimo?.avgQuality, 0.85);
});

test("trends filters by role and by model", async () => {
  let t = 1_000_000_000_000;
  const store = freshStore(() => t);
  await store.record({ taskId: "a", role: "validation-model", results: [{ model: "mimo-v2.5", latencyMs: 100, tokens: 1, success: true }] });
  await store.record({ taskId: "b", role: "drafting-model", results: [{ model: "gpt-4", latencyMs: 100, tokens: 1, success: true }] });
  const v = await store.trends({ role: "validation-model" });
  assert.equal(v.models.length, 1);
  assert.equal(v.models[0]?.model, "mimo-v2.5");
  const byModel = await store.trends({ model: "gpt-4" });
  assert.equal(byModel.models.length, 1);
  assert.equal(byModel.models[0]?.model, "gpt-4");
});

test("trends honors the days window", async () => {
  const now = 1_000_000_000_000;
  const old = now - 40 * 24 * 60 * 60 * 1000;
  const store = freshStore(() => now);
  // Write an old record by temporarily overriding the clock via a second store on same file.
  const oldStore = new ReportStore({ path: store.filePath, clock: () => old });
  await oldStore.record({ taskId: "old", results: [{ model: "mimo-v2.5", latencyMs: 999, tokens: 1, success: true }] });
  await store.record({ taskId: "new", results: [{ model: "mimo-v2.5", latencyMs: 100, tokens: 1, success: true }] });
  const last30 = await store.trends({ days: 30 });
  assert.equal(last30.reportCount, 1); // the 40-day-old one is excluded
  assert.equal(last30.models[0]?.avgLatencyMs, 100);
});

test("trends on an empty/missing file is safe", async () => {
  const store = freshStore();
  const trends = await store.trends();
  assert.equal(trends.reportCount, 0);
  assert.deepEqual(trends.models, []);
});
