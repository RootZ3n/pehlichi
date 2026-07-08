/**
 * OCCASIO BRIDGE — trio loop closure for Ptah's detections.
 *
 * Occasio (Ptah's pattern detector) FINDS issues — repeated-failure,
 * stale-open-loop, regression-watch, provider-degradation, broken-demo,
 * missing-image. Historically the handoff to the rest of the trio was manual:
 * Ptah was a silo. This module wires a detection into the bridge layer so a
 * single call:
 *
 *   1. opens a typed work order (the authoritative queue record), and
 *   2. when the finding is creative/asset-related (broken demo, missing image)
 *      ALSO dispatches an asset job to Luna via `bridge.request("luna", POST, "/chat")`,
 *   3. announces every newly-created order to Pehlichi via
 *      `bridge.request("pehlichi", POST, "/intake")` so the orchestrator holds
 *      authoritative queue state.
 *
 * Bridge failures are non-fatal: the work order is still created and the failure
 * is reported in the result (quarantine-and-flag, never lose the finding).
 */
import type { ToolSpec } from "./driver.js";
import type { ToolHandler, ToolResult } from "./tools.js";
import {
  WorkOrderStore,
  type WorkOrder,
  type WorkOrderCategory,
  type WorkOrderSeverity,
} from "../tools/work-order-store.js";
import { createBridgeToolHandlers } from "../tools/bridge-tools.js";

/** The occasio detector categories, plus the creative ones that route to Luna. */
export type OccasioCategory =
  | "repeated-failure"
  | "stale-open-loop"
  | "regression-watch"
  | "provider-degradation"
  | "broken-demo"
  | "missing-image"
  | "missing-asset"
  | "broken-asset";

export interface OccasioFinding {
  title: string;
  description: string;
  category: OccasioCategory | string;
  severity?: WorkOrderSeverity;
  repos?: string[];
  files?: string[];
  /** Force creative routing regardless of category (e.g. a model-judged asset gap). */
  creative?: boolean;
  /** For creative findings: a structured spec handed to Luna. */
  assetSpec?: Record<string, unknown>;
}

/** A minimal bridge.request seam so tests inject a fake and never hit the network. */
export type BridgeRequestFn = (
  service: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) => Promise<{ ok: boolean; output: string; error?: string }>;

export interface FileFindingResult {
  workOrder: WorkOrder;
  /** Whether the finding was routed to Luna as a creative asset job. */
  routedToLuna: boolean;
  /** Whether the order was announced to Pehlichi. */
  announcedToPehlichi: boolean;
  /** Non-fatal bridge errors (the work order is created regardless). */
  bridgeErrors: string[];
}

const CREATIVE_CATEGORIES = new Set([
  "broken-demo", "missing-image", "missing-asset", "broken-asset",
]);

/** Map an occasio category onto a work-order category + default severity. */
function classify(category: string): { woCategory: WorkOrderCategory; severity: WorkOrderSeverity } {
  switch (category) {
    case "repeated-failure": return { woCategory: "bug", severity: "high" };
    case "regression-watch": return { woCategory: "regression", severity: "high" };
    case "stale-open-loop": return { woCategory: "maintenance", severity: "medium" };
    case "provider-degradation": return { woCategory: "report", severity: "medium" };
    case "broken-demo":
    case "missing-image":
    case "missing-asset":
    case "broken-asset": return { woCategory: "creative", severity: "medium" };
    default: return { woCategory: "bug", severity: "medium" };
  }
}

export function isCreativeFinding(finding: OccasioFinding): boolean {
  return finding.creative === true || CREATIVE_CATEGORIES.has(String(finding.category));
}

/**
 * File an occasio finding as a work order and close the trio loop. The work order
 * is ALWAYS created; bridge routing is best-effort and reported in the result.
 */
export async function fileFinding(
  finding: OccasioFinding,
  deps: { store: WorkOrderStore; bridgeRequest: BridgeRequestFn },
): Promise<FileFindingResult> {
  const { woCategory, severity } = classify(String(finding.category));
  const effectiveSeverity = finding.severity ?? severity;

  const wo = await deps.store.create({
    title: finding.title,
    description: `${finding.description}\n\n[occasio:${finding.category}]`,
    source: "ptah",
    severity: effectiveSeverity,
    category: woCategory,
    ...(finding.repos ? { repos: finding.repos } : {}),
    ...(finding.files ? { files: finding.files } : {}),
    tags: ["occasio", "auto", String(finding.category)],
  });

  const bridgeErrors: string[] = [];
  let routedToLuna = false;
  let announcedToPehlichi = false;

  // (a) Creative findings get a real asset job dispatched to Luna.
  if (isCreativeFinding(finding)) {
    const assetSpec = finding.assetSpec ?? {};
    const message =
      `Repair-driven asset job from Ptah (${wo.id}): ${finding.title}. ${finding.description}`;
    const res = await deps.bridgeRequest("luna", "POST", "/chat", {
      message,
      context: { source: "ptah", workOrderId: wo.id, kind: "asset-repair", assetSpec },
    });
    if (res.ok) {
      routedToLuna = true;
      await deps.store.appendRouting(wo.id, "luna");
    } else {
      bridgeErrors.push(`luna: ${res.error ?? "dispatch failed"}`);
    }
  }

  // (b) Announce every newly-created order to Pehlichi for authoritative queue state.
  const intake = await deps.bridgeRequest("pehlichi", "POST", "/intake", {
    workOrderId: wo.id,
    title: wo.title,
    severity: wo.severity,
    category: wo.category,
    status: wo.status,
    source: "ptah-occasio",
  });
  if (intake.ok) {
    announcedToPehlichi = true;
    await deps.store.appendRouting(wo.id, "pehlichi");
  } else {
    bridgeErrors.push(`pehlichi: ${intake.error ?? "intake failed"}`);
  }

  return { workOrder: wo, routedToLuna, announcedToPehlichi, bridgeErrors };
}

// ── Agent tool surface ────────────────────────────────────────────────────────

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

export const occasioToolSpecs: ToolSpec[] = [
  {
    name: "wo_file_finding",
    description:
      "File an occasio detection as a work order AND close the trio loop: creative/asset " +
      "findings (broken-demo, missing-image) are dispatched to Luna as an asset job, and every " +
      "new order is announced to Pehlichi for authoritative queue state. Bridge failures are " +
      "non-fatal — the work order is always created.",
    parameters: obj(
      {
        title: { type: "string" },
        description: { type: "string" },
        category: {
          type: "string",
          description:
            "occasio category: repeated-failure | stale-open-loop | regression-watch | " +
            "provider-degradation | broken-demo | missing-image | missing-asset | broken-asset",
        },
        severity: { type: "string", description: "critical|high|medium|low|info (optional override)" },
        repos: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
        creative: { type: "boolean", description: "force routing to Luna as an asset job" },
      },
      ["title", "description", "category"],
    ),
  },
];

export interface OccasioToolConfig {
  store?: WorkOrderStore;
  bridgeRequest?: BridgeRequestFn;
}

/** Build a default bridge.request seam from the canonical (retrying) bridge tool handler. */
function defaultBridgeRequest(): BridgeRequestFn {
  const handlers = createBridgeToolHandlers({ agentId: process.env.AGENT_ID ?? "ptah" });
  // The bridge handlers ignore their tool context, so we drive them with args only.
  const request = handlers.get("bridge.request") as
    | ((args: Record<string, unknown>) => Promise<ToolResult>)
    | undefined;
  return async (service, method, path, body) => {
    if (!request) return { ok: false, output: "", error: "bridge.request unavailable" };
    const r = await request({ service, method, path, ...(body ? { body } : {}) });
    return { ok: r.ok, output: r.output, ...(r.error !== undefined ? { error: r.error } : {}) };
  };
}

export function createOccasioToolHandlers(config: OccasioToolConfig = {}): Map<string, ToolHandler> {
  const store = config.store ?? new WorkOrderStore();
  const bridgeRequest = config.bridgeRequest ?? defaultBridgeRequest();
  const handlers = new Map<string, ToolHandler>();

  handlers.set("wo_file_finding", async (args): Promise<ToolResult> => {
    try {
      const finding: OccasioFinding = {
        title: String(args.title ?? ""),
        description: String(args.description ?? ""),
        category: String(args.category ?? "repeated-failure"),
        ...(typeof args.severity === "string" ? { severity: args.severity as WorkOrderSeverity } : {}),
        ...(Array.isArray(args.repos) ? { repos: args.repos as string[] } : {}),
        ...(Array.isArray(args.files) ? { files: args.files as string[] } : {}),
        ...(typeof args.creative === "boolean" ? { creative: args.creative } : {}),
      };
      const result = await fileFinding(finding, { store, bridgeRequest });
      const lines = [
        `Filed ${result.workOrder.id} (${result.workOrder.severity}/${result.workOrder.category}): ${result.workOrder.title}`,
        `routed→luna=${result.routedToLuna} announced→pehlichi=${result.announcedToPehlichi}`,
      ];
      if (result.bridgeErrors.length > 0) lines.push(`bridge warnings: ${result.bridgeErrors.join("; ")}`);
      return { ok: true, output: lines.join("\n") };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  });

  return handlers;
}
