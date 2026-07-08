/**
 * WORK ORDER STORE — first-class, typed CRUD over the lab work-order queue.
 *
 * Work orders are single JSON files in /pehverse/state/work-orders/ (WO-NNNN.json).
 * Historically they were mutated by ad-hoc inline `python3 -c "import json..."` in
 * the occasio/work-orders skills — brittle, untyped, and opaque to a beginner. This
 * module replaces that shell/Python with typed helpers that:
 *
 *   - read  : list(filter) / get(id)
 *   - create: create(input) → allocates the next WO-NNNN id
 *   - transition: transition(id, toStatus, ...) — validates the status lifecycle
 *   - notes : appendNote(id, note)
 *   - resolve: appendResolution(id, resolution) — convenience for the `done` edge
 *
 * The status lifecycle (open → assigned → in-progress → done/blocked/wontfix) is
 * ENFORCED on transition so a beginner cannot drive a work order into an illegal
 * state. Reads stay lenient: a file with an unknown legacy status (e.g. "resolved"
 * from an older Atoni build) is returned as-is rather than rejected.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Schema (kept local so the agent build never imports from /pehverse/state) ──

export type WorkOrderSource = "zen" | "peh" | "luna" | "julian" | "atoni" | "ptah" | "unknown";

export type WorkOrderStatus =
  | "open"
  | "assigned"
  | "in-progress"
  | "blocked"
  | "done"
  | "wontfix"
  | "duplicate";

export type WorkOrderSeverity = "critical" | "high" | "medium" | "low" | "info";

export type WorkOrderCategory =
  | "bug"
  | "regression"
  | "test-failure"
  | "service-down"
  | "code-quality"
  | "audit"
  | "report"
  | "enhancement"
  | "maintenance"
  | "creative";

export interface WorkOrderResolution {
  summary: string;
  commits?: string[];
  filesChanged?: string[];
  testResults?: string;
  resolvedAt: string;
}

export interface WorkOrder {
  id: string;
  title: string;
  description: string;
  source: WorkOrderSource;
  status: WorkOrderStatus | string; // lenient on read for legacy statuses
  severity: WorkOrderSeverity;
  category: WorkOrderCategory | string;
  createdAt: string;
  updatedAt: string;
  repos?: string[];
  files?: string[];
  attachments?: string[];
  notes?: string[];
  resolution?: WorkOrderResolution;
  wontfixReason?: string;
  duplicateOf?: string;
  tags?: string[];
  scheduledFor?: string;
  /** Optional cross-trio routing record (set by the occasio bridge). */
  routedTo?: string[];
}

export const WORK_ORDER_STATUSES: readonly WorkOrderStatus[] = Object.freeze([
  "open", "assigned", "in-progress", "blocked", "done", "wontfix", "duplicate",
]);

/**
 * Allowed status transitions. The first-class lifecycle is intentionally narrow:
 * open → assigned → in-progress → done/blocked/wontfix.
 */
const TRANSITIONS: Record<WorkOrderStatus, readonly WorkOrderStatus[]> = {
  "open": ["assigned"],
  "assigned": ["in-progress"],
  "in-progress": ["done", "blocked", "wontfix"],
  "blocked": [],
  "done": [],
  "wontfix": [],
  "duplicate": [],
};

export interface CreateWorkOrderInput {
  title: string;
  description: string;
  source: WorkOrderSource;
  severity: WorkOrderSeverity;
  category: WorkOrderCategory | string;
  repos?: string[];
  files?: string[];
  attachments?: string[];
  tags?: string[];
  scheduledFor?: string;
}

export interface ListFilter {
  status?: WorkOrderStatus | string | (WorkOrderStatus | string)[];
  severity?: WorkOrderSeverity | WorkOrderSeverity[];
  category?: string | string[];
  source?: WorkOrderSource | WorkOrderSource[];
  repo?: string;
  tag?: string;
}

export interface TransitionOptions {
  /** A note appended to the work order alongside the transition. */
  note?: string;
  /** Resolution detail — required when moving to `done`. */
  resolution?: WorkOrderResolution;
  /** Reason — recorded as wontfixReason when moving to `wontfix`. */
  reason?: string;
  /** The work order this duplicates — recorded when moving to `duplicate`. */
  duplicateOf?: string;
}

export class WorkOrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkOrderTransitionError";
  }
}

export class WorkOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkOrderValidationError";
  }
}

const DEFAULT_DIR = process.env.WORK_ORDERS_DIR ?? "/pehverse/state/work-orders";

const SEVERITY_ORDER: Record<WorkOrderSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

export interface WorkOrderStoreOptions {
  /** Directory holding the WO-NNNN.json files. Defaults to $WORK_ORDERS_DIR or the lab path. */
  readonly dir?: string;
  /** Injectable clock (ms→ISO). Tests pass a fixed clock for deterministic timestamps. */
  readonly clock?: () => number;
}

/** Validate that `from`→`to` is a legal lifecycle transition. Throws otherwise. */
export function assertTransition(from: WorkOrderStatus | string, to: WorkOrderStatus): void {
  if (!WORK_ORDER_STATUSES.includes(to)) {
    throw new WorkOrderTransitionError(
      `invalid target status "${to}"; must be one of ${WORK_ORDER_STATUSES.join(", ")}`,
    );
  }
  if (from === to) return; // idempotent no-op
  const allowed = TRANSITIONS[from as WorkOrderStatus];
  if (allowed === undefined) {
    // Legacy/unknown current status — allow the move but it is the caller's responsibility.
    return;
  }
  if (!allowed.includes(to)) {
    throw new WorkOrderTransitionError(
      `illegal transition ${from} → ${to}; allowed from ${from}: ${allowed.join(", ") || "(none)"}`,
    );
  }
}

export class WorkOrderStore {
  private readonly dir: string;
  private readonly clock: () => number;

  constructor(opts: WorkOrderStoreOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_DIR;
    this.clock = opts.clock ?? Date.now;
  }

  get directory(): string {
    return this.dir;
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async nextId(): Promise<string> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const ids = files
      .filter((f) => f.startsWith("WO-") && f.endsWith(".json"))
      .map((f) => parseInt(f.replace("WO-", "").replace(".json", ""), 10))
      .filter((n) => !Number.isNaN(n));
    const next = ids.length > 0 ? Math.max(...ids) + 1 : 1;
    return `WO-${String(next).padStart(4, "0")}`;
  }

  async get(id: string): Promise<WorkOrder | null> {
    try {
      const raw = await readFile(this.path(id), "utf-8");
      return JSON.parse(raw) as WorkOrder;
    } catch {
      return null;
    }
  }

  async list(filter?: ListFilter): Promise<WorkOrder[]> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const orders: WorkOrder[] = [];
    for (const f of files) {
      if (!f.startsWith("WO-") || !f.endsWith(".json")) continue;
      let wo: WorkOrder;
      try {
        wo = JSON.parse(await readFile(join(this.dir, f), "utf-8")) as WorkOrder;
      } catch {
        continue; // skip malformed
      }
      if (filter && !matchesFilter(wo, filter)) continue;
      orders.push(wo);
    }
    return orders.sort((a, b) => {
      const sevA = SEVERITY_ORDER[a.severity] ?? 5;
      const sevB = SEVERITY_ORDER[b.severity] ?? 5;
      if (sevA !== sevB) return sevA - sevB;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    });
  }

  async create(input: CreateWorkOrderInput): Promise<WorkOrder> {
    validateCreateInput(input);
    await this.ensureDir();
    const id = await this.nextId();
    const ts = this.now();
    const wo: WorkOrder = {
      id,
      title: input.title,
      description: input.description,
      source: input.source,
      status: "open",
      severity: input.severity,
      category: input.category,
      createdAt: ts,
      updatedAt: ts,
      ...(input.repos && { repos: input.repos }),
      ...(input.files && { files: input.files }),
      ...(input.attachments && { attachments: input.attachments }),
      ...(input.tags && { tags: input.tags }),
      ...(input.scheduledFor && { scheduledFor: input.scheduledFor }),
    };
    await writeFile(this.path(id), JSON.stringify(wo, null, 2));
    return wo;
  }

  private async save(wo: WorkOrder): Promise<WorkOrder> {
    const updated: WorkOrder = { ...wo, updatedAt: this.now() };
    await writeFile(this.path(wo.id), JSON.stringify(updated, null, 2));
    return updated;
  }

  async appendNote(id: string, note: string): Promise<WorkOrder | null> {
    const wo = await this.get(id);
    if (!wo) return null;
    const notes = [...(wo.notes ?? []), `[${this.now()}] ${note}`];
    return this.save({ ...wo, notes });
  }

  async appendResolution(id: string, resolution: WorkOrderResolution): Promise<WorkOrder | null> {
    const wo = await this.get(id);
    if (!wo) return null;
    return this.save({ ...wo, status: "done", resolution });
  }

  /** Record that this work order was routed to another agent (trio loop closure). */
  async appendRouting(id: string, target: string): Promise<WorkOrder | null> {
    const wo = await this.get(id);
    if (!wo) return null;
    const routedTo = [...(wo.routedTo ?? []), target];
    return this.save({ ...wo, routedTo });
  }

  /**
   * Transition a work order to a new status, validating the lifecycle. Throws
   * WorkOrderTransitionError on an illegal move; returns null if the id is unknown.
   */
  async transition(
    id: string,
    to: WorkOrderStatus,
    opts: TransitionOptions = {},
  ): Promise<WorkOrder | null> {
    const wo = await this.get(id);
    if (!wo) return null;
    assertTransition(wo.status, to);
    const notes = opts.note ? [...(wo.notes ?? []), `[${this.now()}] ${opts.note}`] : wo.notes;
    const next: WorkOrder = {
      ...wo,
      status: to,
      ...(notes ? { notes } : {}),
      ...(opts.resolution ? { resolution: opts.resolution } : {}),
      ...(to === "wontfix" && opts.reason ? { wontfixReason: opts.reason } : {}),
      ...(to === "duplicate" && opts.duplicateOf ? { duplicateOf: opts.duplicateOf } : {}),
    };
    return this.save(next);
  }

  async stats(): Promise<{
    total: number;
    open: number;
    inProgress: number;
    done: number;
    wontfix: number;
    blocked: number;
  }> {
    const all = await this.list();
    return {
      total: all.length,
      open: all.filter((w) => w.status === "open").length,
      inProgress: all.filter((w) => w.status === "in-progress" || w.status === "assigned").length,
      done: all.filter((w) => w.status === "done").length,
      wontfix: all.filter((w) => w.status === "wontfix" || w.status === "duplicate").length,
      blocked: all.filter((w) => w.status === "blocked").length,
    };
  }
}

const defaultStore = new WorkOrderStore();

export async function readWorkOrders(filter?: ListFilter): Promise<WorkOrder[]> {
  return defaultStore.list(filter);
}

export async function getWorkOrder(id: string): Promise<WorkOrder | null> {
  return defaultStore.get(id);
}

export async function createWorkOrder(input: CreateWorkOrderInput): Promise<WorkOrder> {
  return defaultStore.create(input);
}

export async function transitionWorkOrder(id: string, newStatus: WorkOrderStatus): Promise<WorkOrder | null> {
  return defaultStore.transition(id, newStatus);
}

export async function appendNote(id: string, note: string): Promise<WorkOrder | null> {
  return defaultStore.appendNote(id, note);
}

function matchesFilter(wo: WorkOrder, filter: ListFilter): boolean {
  const inList = <T>(val: T, want?: T | T[]): boolean => {
    if (want === undefined) return true;
    return Array.isArray(want) ? want.includes(val) : want === val;
  };
  if (!inList(wo.status, filter.status)) return false;
  if (!inList(wo.severity, filter.severity)) return false;
  if (!inList(wo.category, filter.category)) return false;
  if (!inList(wo.source, filter.source)) return false;
  if (filter.repo && !(wo.repos ?? []).includes(filter.repo)) return false;
  if (filter.tag && !(wo.tags ?? []).includes(filter.tag)) return false;
  return true;
}

function validateCreateInput(input: CreateWorkOrderInput): void {
  requireNonEmpty(input.title, "title");
  requireNonEmpty(input.description, "description");
  if (!["zen", "peh", "luna", "julian", "atoni", "ptah", "unknown"].includes(input.source)) {
    throw new WorkOrderValidationError(`invalid source "${input.source}"`);
  }
  if (!["critical", "high", "medium", "low", "info"].includes(input.severity)) {
    throw new WorkOrderValidationError(`invalid severity "${input.severity}"`);
  }
  requireNonEmpty(input.category, "category");
  validateStringArray(input.repos, "repos");
  validateStringArray(input.files, "files");
  validateStringArray(input.attachments, "attachments");
  validateStringArray(input.tags, "tags");
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkOrderValidationError(`${field} is required`);
  }
}

function validateStringArray(value: readonly string[] | undefined, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim().length === 0)) {
    throw new WorkOrderValidationError(`${field} must contain non-empty strings`);
  }
}
