/**
 * TOOL GOVERNOR — per-tier tool budgets + repeated/no-progress loop detection.
 *
 * The iteration budget caps how many driver turns a session takes. This adds the
 * two things the lab-trust sprint (Phase 7) asks for on top of it:
 *
 *  1. Per-tier budgets: a casual conversation should not be allowed to spin up a
 *     long tool loop; read-only and mutation/delegation work get a sane default;
 *     explicit escalation goes up to a hard ceiling and only a trusted operator
 *     can go beyond it.
 *
 *  2. Repetition / no-progress detection: stop early when the agent calls the SAME
 *     tool with the SAME args, repeats a failing tool, repeats a read/search that
 *     yields no new evidence, or re-issues the same bridge/delegation payload —
 *     and treat repeated delegation FAILURE as a hard stop (a human should look,
 *     not let Pehlichi hammer Ikbi).
 *
 * Pure, dependency-free, and unit-tested so the policy is verifiable on its own.
 */

export type BudgetTier = "converse" | "readonly" | "mutation" | "escalation";

/** Tier limits. converse is intentionally tiny; escalation is capped at the hard ceiling. */
export const TIER_LIMITS = {
  /** Casual / converse: 0–4 tools. */
  converse: 4,
  /** Read-only / status / audit: 12 tools. */
  readonly: 12,
  /** Mutation / delegation: 12 tools by default. */
  mutation: 12,
  /** Explicit escalation ceiling (with a reason): 20. */
  escalationMax: 20,
  /** Absolute hard cap; above this requires trusted operator config. */
  hardCap: 20,
} as const;

export interface BudgetResolution {
  readonly tier: BudgetTier;
  readonly max: number;
  /** Set when an escalation was requested. */
  readonly escalated: boolean;
  readonly reason?: string;
  /** Set when the request was clamped (e.g. >20 without trusted operator). */
  readonly clamped?: boolean;
}

export interface ResolveBudgetInput {
  readonly tier: BudgetTier;
  /** Explicit escalation: a requested ceiling with a justifying reason. */
  readonly escalate?: { readonly requested: number; readonly reason?: string } | undefined;
  /** Trusted operator config may raise the ceiling above the hard cap. */
  readonly trustedOperator?: boolean;
}

/**
 * Resolve the tool budget for a tier.
 *  - converse → 4, readonly → 12, mutation/delegation → 12.
 *  - escalation requires a non-empty reason and goes up to 20.
 *  - >20 requires trustedOperator; otherwise it is clamped to 20.
 */
export function resolveToolBudget(input: ResolveBudgetInput): BudgetResolution {
  const base =
    input.tier === "converse" ? TIER_LIMITS.converse
    : input.tier === "readonly" ? TIER_LIMITS.readonly
    : TIER_LIMITS.mutation; // mutation + (escalation falls through to escalate handling)

  if (input.tier !== "escalation" && input.escalate === undefined) {
    return { tier: input.tier, max: base, escalated: false };
  }

  // Escalation path (either tier === "escalation" or an escalate request on another tier).
  const requested = input.escalate?.requested ?? TIER_LIMITS.escalationMax;
  const reason = input.escalate?.reason?.trim();
  if (reason === undefined || reason.length === 0) {
    // No justification → refuse to escalate; fall back to the safe base (mutation default).
    return { tier: input.tier, max: TIER_LIMITS.mutation, escalated: false, reason: "escalation denied: a reason is required" };
  }
  if (requested > TIER_LIMITS.hardCap && input.trustedOperator !== true) {
    return { tier: input.tier, max: TIER_LIMITS.hardCap, escalated: true, reason, clamped: true };
  }
  const max = input.trustedOperator === true ? Math.max(1, Math.floor(requested)) : Math.min(TIER_LIMITS.hardCap, Math.max(1, Math.floor(requested)));
  return { tier: input.tier, max, escalated: true, reason };
}

// ── Repetition / no-progress detection ───────────────────────────────────────

export interface ToolCallRecord {
  readonly tool: string;
  readonly args: unknown;
  readonly ok: boolean;
  /**
   * Optional evidence fingerprint for read/search tools: when two reads return the
   * same evidence key, the second made no progress. Omit for tools without a
   * meaningful evidence signal.
   */
  readonly evidenceKey?: string;
  /** Mark delegation/bridge calls so repeated failures become a HARD stop. */
  readonly isDelegation?: boolean;
}

export interface RepetitionVerdict {
  readonly stop: boolean;
  readonly reason?: string;
  /** Hard stops require human review (e.g. repeated delegation failure). */
  readonly hard?: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export interface RepetitionDetectorOptions {
  /** Identical tool+args this many times → stop (default 3: the 3rd identical call). */
  readonly sameArgsThreshold?: number;
  /** Same tool failing this many times → stop (default 2). */
  readonly sameFailThreshold?: number;
  /** Same evidence (no-progress read/search) this many times → stop (default 2). */
  readonly noProgressThreshold?: number;
  /** Repeated delegation FAILURE this many times → HARD stop (default 2). */
  readonly delegationFailThreshold?: number;
}

/** Detects repeated same-args calls, repeated failures, no-progress reads, and stuck delegations. */
export class RepetitionDetector {
  private readonly sameArgs = new Map<string, number>();
  private readonly toolFails = new Map<string, number>();
  private readonly evidence = new Map<string, number>();
  private delegationFails = 0;

  private readonly sameArgsThreshold: number;
  private readonly sameFailThreshold: number;
  private readonly noProgressThreshold: number;
  private readonly delegationFailThreshold: number;

  constructor(opts: RepetitionDetectorOptions = {}) {
    this.sameArgsThreshold = opts.sameArgsThreshold ?? 3;
    this.sameFailThreshold = opts.sameFailThreshold ?? 2;
    this.noProgressThreshold = opts.noProgressThreshold ?? 2;
    this.delegationFailThreshold = opts.delegationFailThreshold ?? 2;
  }

  /** Record a tool call and return whether the session should stop. */
  record(call: ToolCallRecord): RepetitionVerdict {
    // Repeated delegation failure → HARD stop (a human should review before retrying).
    if (call.isDelegation === true && !call.ok) {
      this.delegationFails += 1;
      if (this.delegationFails >= this.delegationFailThreshold) {
        return {
          stop: true,
          hard: true,
          reason: `repeated delegation failure (${this.delegationFails}x) — stopping for human review instead of retrying`,
        };
      }
    } else if (call.isDelegation === true && call.ok) {
      this.delegationFails = 0;
    }

    // Same tool + same args.
    const sig = `${call.tool}|${stableStringify(call.args)}`;
    const sameArgsCount = (this.sameArgs.get(sig) ?? 0) + 1;
    this.sameArgs.set(sig, sameArgsCount);
    if (sameArgsCount >= this.sameArgsThreshold) {
      return { stop: true, reason: `repeated identical call to "${call.tool}" with the same args (${sameArgsCount}x) — no progress` };
    }

    // Same tool failing repeatedly.
    if (!call.ok) {
      const fails = (this.toolFails.get(call.tool) ?? 0) + 1;
      this.toolFails.set(call.tool, fails);
      if (fails >= this.sameFailThreshold) {
        return { stop: true, reason: `tool "${call.tool}" failed ${fails}x — stopping the loop` };
      }
    } else {
      this.toolFails.set(call.tool, 0);
    }

    // Repeated read/search with no new evidence.
    if (call.evidenceKey !== undefined) {
      const key = `${call.tool}|${call.evidenceKey}`;
      const seen = (this.evidence.get(key) ?? 0) + 1;
      this.evidence.set(key, seen);
      if (seen >= this.noProgressThreshold) {
        return { stop: true, reason: `repeated "${call.tool}" returned the same evidence (${seen}x) — no new information` };
      }
    }

    return { stop: false };
  }
}

// ── Partial result ────────────────────────────────────────────────────────────

export interface PartialStatus {
  readonly ok: false;
  readonly partial: true;
  readonly status: "partial";
  readonly toolCallsUsed: number;
  readonly budgetLimit: number;
  readonly reasonStopped: string;
  readonly safeNextStep: string;
  readonly accomplished: readonly string[];
}

/**
 * Build a partial result. It is NEVER a success: ok is false and status is
 * "partial". The caller must surface reasonStopped + safeNextStep to the operator.
 */
export function buildPartialStatus(input: {
  toolCallsUsed: number;
  budgetLimit: number;
  reasonStopped: string;
  safeNextStep?: string;
  accomplished?: readonly string[];
}): PartialStatus {
  return {
    ok: false,
    partial: true,
    status: "partial",
    toolCallsUsed: input.toolCallsUsed,
    budgetLimit: input.budgetLimit,
    reasonStopped: input.reasonStopped,
    safeNextStep: input.safeNextStep ?? "Review the partial progress and decide whether to continue with a fresh, narrower request.",
    accomplished: input.accomplished ?? [],
  };
}

/** A partial result must never be reported as success. */
export function isSuccess(result: { ok: boolean; partial?: boolean }): boolean {
  return result.ok === true && result.partial !== true;
}
