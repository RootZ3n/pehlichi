/**
 * OCCASIO BRIDGE — configured Trio loop closure for detector findings.
 *
 * Occasio finds issues — repeated-failure,
 * stale-open-loop, regression-watch, provider-degradation, broken-demo,
 * missing-image. Historically the handoff to the rest of the trio was manual:
 * This module wires a detection into the bridge layer so a
 * single call:
 *
 *   1. opens a typed work order (the authoritative queue record), and
 *   2. when the finding is creative/asset-related (broken demo, missing image)
 *      ALSO dispatches an asset job to the configured creative target,
 *   3. announces every newly-created order to the configured coordinator so it holds
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
  type WorkOrderSource,
} from "../tools/work-order-store.js";
import { createBridgeToolHandlers } from "../tools/bridge-tools.js";

/** The detector categories, plus the creative ones that route to the configured target. */
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
  /** For creative findings: a structured spec handed to the configured target. */
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
  /** Whether the finding was routed to the configured creative target. */
  routedToCreative: boolean;
  /** Whether the order was announced to the configured coordinator target. */
  announcedToCoordinator: boolean;
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
  deps: {
    store: WorkOrderStore;
    bridgeRequest: BridgeRequestFn;
    sourceAgentId: string;
    routingTargets: { readonly creative: string; readonly coordinator: string; readonly workOrderSource: WorkOrderSource };
  },
): Promise<FileFindingResult> {
  const { woCategory, severity } = classify(String(finding.category));
  const effectiveSeverity = finding.severity ?? severity;

  const wo = await deps.store.create({
    title: finding.title,
    description: `${finding.description}\n\n[occasio:${finding.category}]`,
    source: deps.routingTargets.workOrderSource,
    severity: effectiveSeverity,
    category: woCategory,
    ...(finding.repos ? { repos: finding.repos } : {}),
    ...(finding.files ? { files: finding.files } : {}),
    tags: ["occasio", "auto", String(finding.category)],
  });

  const bridgeErrors: string[] = [];
  let routedToCreative = false;
  let announcedToCoordinator = false;

  // (a) Creative findings get a real asset job dispatched to the configured creative target.
  if (isCreativeFinding(finding)) {
    const assetSpec = finding.assetSpec ?? {};
    const message =
      `Repair-driven asset job from ${deps.sourceAgentId} (${wo.id}): ${finding.title}. ${finding.description}`;
    const res = await deps.bridgeRequest(deps.routingTargets.creative, "POST", "/chat", {
      message,
      context: { source: deps.sourceAgentId, workOrderId: wo.id, kind: "asset-repair", assetSpec },
    });
    if (res.ok) {
      routedToCreative = true;
      await deps.store.appendRouting(wo.id, deps.routingTargets.creative);
    } else {
      bridgeErrors.push(`${deps.routingTargets.creative}: ${res.error ?? "dispatch failed"}`);
    }
  }

  // (b) Announce every newly-created order to the configured coordinator.
  const intake = await deps.bridgeRequest(deps.routingTargets.coordinator, "POST", "/intake", {
    workOrderId: wo.id,
    title: wo.title,
    severity: wo.severity,
    category: wo.category,
    status: wo.status,
    source: `${deps.sourceAgentId}-occasio`,
  });
  if (intake.ok) {
    announcedToCoordinator = true;
    await deps.store.appendRouting(wo.id, deps.routingTargets.coordinator);
  } else {
    bridgeErrors.push(`${deps.routingTargets.coordinator}: ${intake.error ?? "intake failed"}`);
  }

  return { workOrder: wo, routedToCreative, announcedToCoordinator, bridgeErrors };
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
      "findings (broken-demo, missing-image) are dispatched to the configured creative target, and every " +
      "new order is announced to the configured coordinator. Bridge failures are " +
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
        creative: { type: "boolean", description: "force routing to the configured creative target" },
      },
      ["title", "description", "category"],
    ),
  },
];

export interface OccasioToolConfig {
  store?: WorkOrderStore;
  bridgeRequest?: BridgeRequestFn;
  agentId: string;
  routingTargets: { readonly creative: string; readonly coordinator: string; readonly workOrderSource: WorkOrderSource };
}

/** Build a default bridge.request seam from the canonical (retrying) bridge tool handler. */
function defaultBridgeRequest(agentId: string): BridgeRequestFn {
  const handlers = createBridgeToolHandlers({ agentId });
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

export function createOccasioToolHandlers(config: OccasioToolConfig): Map<string, ToolHandler> {
  if (!config || typeof config.agentId !== 'string' || config.agentId.length === 0
      || typeof config.routingTargets?.creative !== 'string'
      || typeof config.routingTargets?.coordinator !== 'string'
      || typeof config.routingTargets?.workOrderSource !== 'string') {
    throw new Error('occasio requires canonical identity and declarative routing targets');
  }
  const store = config.store ?? new WorkOrderStore();
  const bridgeRequest = config.bridgeRequest ?? defaultBridgeRequest(config.agentId);
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
      const result = await fileFinding(finding, {
        store,
        bridgeRequest,
        sourceAgentId: config.agentId,
        routingTargets: config.routingTargets,
      });
      const lines = [
        `Filed ${result.workOrder.id} (${result.workOrder.severity}/${result.workOrder.category}): ${result.workOrder.title}`,
        `routed→creative=${result.routedToCreative} announced→coordinator=${result.announcedToCoordinator}`,
      ];
      if (result.bridgeErrors.length > 0) lines.push(`bridge warnings: ${result.bridgeErrors.join("; ")}`);
      return { ok: true, output: lines.join("\n") };
    } catch (err) {
      return { ok: false, output: "", error: err instanceof Error ? err.message : String(err) };
    }
  });

  return handlers;
}
