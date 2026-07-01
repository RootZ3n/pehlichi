/**
 * WORK ORDER TOOLS — agent-facing surface over the typed WorkOrderStore.
 *
 * Replaces the fragile inline `python3 -c "import json..."` the occasio /
 * work-orders skills used to mutate raw JSON. The model now triages the repair
 * queue through typed tools whose lifecycle is validated:
 *
 *   wo_list       — list work orders (optionally filtered by status/severity)
 *   wo_get        — read one work order by id
 *   wo_transition — move a work order to a new status (lifecycle-validated)
 */
import type { ToolSpec } from "../core/driver.js";
import type { ToolHandler, ToolResult } from "../core/tools.js";
import {
  WorkOrderStore,
  WorkOrderTransitionError,
  type WorkOrderStatus,
} from "./work-order-store.js";

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

export const workOrderToolSpecs: ToolSpec[] = [
  {
    name: "wo_list",
    description:
      "List repair work orders from the lab queue, newest/most-severe first. Read-only. " +
      "Filter by status (open, assigned, in-progress, blocked, done, wontfix) and/or severity.",
    parameters: obj(
      {
        status: { type: "string", description: "Filter by status (e.g. 'open'). Omit for all." },
        severity: { type: "string", description: "Filter by severity (critical|high|medium|low|info)." },
        limit: { type: "number", description: "Max rows to return (default 50)." },
      },
      [],
    ),
  },
  {
    name: "wo_get",
    description: "Read a single work order by id (e.g. 'WO-0004'). Read-only.",
    parameters: obj({ id: { type: "string", description: "Work order id, e.g. WO-0004" } }, ["id"]),
  },
  {
    name: "wo_transition",
    description:
      "Move a work order to a new status. The lifecycle is validated (open → assigned → " +
      "in-progress → done/blocked/wontfix).",
    parameters: obj(
      {
        id: { type: "string", description: "Work order id, e.g. WO-0004" },
        status: { type: "string", description: "Target status" },
        note: { type: "string", description: "Optional note recorded with the transition" },
        resolution: { type: "string", description: "Optional resolution summary recorded when status=done" },
        reason: { type: "string", description: "Reason (recorded when status=wontfix)" },
      },
      ["id", "status"],
    ),
  },
];

export interface WorkOrderToolConfig {
  /** Inject a store (tests point it at a temp dir). Defaults to the lab work-order dir. */
  store?: WorkOrderStore;
}

export function createWorkOrderToolHandlers(config: WorkOrderToolConfig = {}): Map<string, ToolHandler> {
  const store = config.store ?? new WorkOrderStore();
  const handlers = new Map<string, ToolHandler>();

  handlers.set("wo_list", async (args): Promise<ToolResult> => {
    try {
      const filter: Record<string, unknown> = {};
      if (typeof args.status === "string") filter.status = args.status;
      if (typeof args.severity === "string") filter.severity = args.severity;
      const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 50;
      const orders = (await store.list(filter)).slice(0, limit);
      const rows = orders.map((w) => ({
        id: w.id,
        title: w.title,
        severity: w.severity,
        status: w.status,
        category: w.category,
        ageHours: ageHours(w.createdAt),
      }));
      return { ok: true, output: JSON.stringify({ count: rows.length, workOrders: rows }, null, 2) };
    } catch (err) {
      return { ok: false, output: "", error: messageOf(err) };
    }
  });

  handlers.set("wo_get", async (args): Promise<ToolResult> => {
    const id = String(args.id ?? "");
    const wo = await store.get(id);
    if (!wo) return { ok: false, output: "", error: `work order not found: ${id}` };
    return { ok: true, output: JSON.stringify(wo, null, 2) };
  });

  handlers.set("wo_transition", async (args): Promise<ToolResult> => {
    const id = String(args.id ?? "");
    const status = String(args.status ?? "") as WorkOrderStatus;
    try {
      const opts: Record<string, unknown> = {};
      if (typeof args.note === "string") opts.note = args.note;
      if (typeof args.reason === "string") opts.reason = args.reason;
      if (typeof args.resolution === "string") {
        opts.resolution = { summary: args.resolution, resolvedAt: new Date().toISOString() };
      }
      const wo = await store.transition(id, status, opts);
      if (!wo) return { ok: false, output: "", error: `work order not found: ${id}` };
      return { ok: true, output: `${wo.id} → ${wo.status}` };
    } catch (err) {
      if (err instanceof WorkOrderTransitionError) {
        return { ok: false, output: "", error: err.message };
      }
      return { ok: false, output: "", error: messageOf(err) };
    }
  });

  return handlers;
}

function ageHours(createdAt: string): number {
  const t = new Date(createdAt || 0).getTime();
  if (!t) return 0;
  return Math.round(((Date.now() - t) / 3_600_000) * 10) / 10;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
