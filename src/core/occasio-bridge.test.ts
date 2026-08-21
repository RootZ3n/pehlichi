/**
 * Occasio bridge — trio loop closure: file WO + route creative→Luna + announce→Pehlichi.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fileFinding, isCreativeFinding, type BridgeRequestFn } from "./occasio-bridge.js";
import { WorkOrderStore } from "../tools/work-order-store.js";

const dirs: string[] = [];
function freshStore(): WorkOrderStore {
  const dir = mkdtempSync(join(tmpdir(), "occasio-"));
  dirs.push(dir);
  return new WorkOrderStore({ dir });
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A bridge stub recording every call; configurable per-service ok/err. */
function recordingBridge(overrides: Record<string, boolean> = {}): { fn: BridgeRequestFn; calls: Array<{ service: string; path: string; body?: any }> } {
  const calls: Array<{ service: string; path: string; body?: any }> = [];
  const fn: BridgeRequestFn = async (service, _method, path, body) => {
    calls.push({ service, path, body });
    const ok = overrides[service] ?? true;
    return ok ? { ok: true, output: "{}" } : { ok: false, output: "", error: "unreachable" };
  };
  return { fn, calls };
}
const configuredRouting = {
  sourceAgentId: 'mad-ptah',
  routingTargets: { creative: 'luna', coordinator: 'pehlichi', workOrderSource: 'ptah' as const },
};

test("isCreativeFinding keys off category and the explicit flag", () => {
  assert.equal(isCreativeFinding({ title: "t", description: "d", category: "broken-demo" }), true);
  assert.equal(isCreativeFinding({ title: "t", description: "d", category: "missing-image" }), true);
  assert.equal(isCreativeFinding({ title: "t", description: "d", category: "repeated-failure" }), false);
  assert.equal(isCreativeFinding({ title: "t", description: "d", category: "repeated-failure", creative: true }), true);
});

test("a non-creative finding creates a WO and announces to pehlichi only", async () => {
  const store = freshStore();
  const { fn, calls } = recordingBridge();
  const res = await fileFinding(
    { title: "repeated build failure", description: "ikbi build failed 5x", category: "repeated-failure", repos: ["ikbi"] },
    { store, bridgeRequest: fn, ...configuredRouting },
  );
  assert.equal(res.workOrder.category, "bug");
  assert.equal(res.workOrder.severity, "high");
  assert.equal(res.routedToCreative, false);
  assert.equal(res.announcedToCoordinator, true);
  // exactly one bridge call, to pehlichi /intake
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.service, "pehlichi");
  assert.equal(calls[0]?.path, "/intake");
  // routing recorded on the WO
  const wo = await store.get(res.workOrder.id);
  assert.ok(wo?.routedTo?.includes("pehlichi"));
});

test("a creative finding dispatches to Luna AND announces to pehlichi", async () => {
  const store = freshStore();
  const { fn, calls } = recordingBridge();
  const res = await fileFinding(
    { title: "missing hero image", description: "demo page has a broken image", category: "missing-image", assetSpec: { dimensions: "1024x1024" } },
    { store, bridgeRequest: fn, ...configuredRouting },
  );
  assert.equal(res.workOrder.category, "creative");
  assert.equal(res.routedToCreative, true);
  assert.equal(res.announcedToCoordinator, true);
  const services = calls.map((c) => c.service);
  assert.deepEqual(services, ["luna", "pehlichi"]);
  const lunaCall = calls.find((c) => c.service === "luna");
  assert.equal(lunaCall?.path, "/chat");
  assert.equal(lunaCall?.body?.context?.workOrderId, res.workOrder.id);
});

test("bridge failures are non-fatal: the WO is still created and errors are reported", async () => {
  const store = freshStore();
  const { fn } = recordingBridge({ luna: false, pehlichi: false });
  const res = await fileFinding(
    { title: "broken demo", description: "the demo crashes", category: "broken-demo" },
    { store, bridgeRequest: fn, ...configuredRouting },
  );
  assert.ok(res.workOrder.id.startsWith("WO-"));
  assert.equal(res.routedToCreative, false);
  assert.equal(res.announcedToCoordinator, false);
  assert.equal(res.bridgeErrors.length, 2);
  // the work order persists regardless of bridge outcome
  assert.ok(await store.get(res.workOrder.id));
});
