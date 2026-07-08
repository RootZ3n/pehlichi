/**
 * RUNTIME CAPABILITIES (P0.4) — a truthful, single source of truth for what the agent can
 * ACTUALLY do this run. The audit found the /capabilities endpoint advertised a hardcoded
 * feature list that could name capabilities that are not wired at runtime ("it's in the repo"
 * ≠ "it's on"). This module derives the capability set from the ACTUAL run wiring, so the
 * agent never claims a capability that is not active. As P1 wires more subsystems
 * (context compaction, schema repair, …) their inputs flip and the report follows — no
 * hand-maintained list to drift.
 */

/** The wiring facts the capability report is derived from. All supplied by the live server. */
export interface RuntimeCapabilityInput {
  /** Write/destructive tools are permitted this run (the approval posture allows writes). */
  readonly allowWrites: boolean;
  /** The evidence gate is active: a `done` claiming work must be backed by a real tool run. */
  readonly requireEvidence: boolean;
  /** Context-window size wired for compaction; compaction is active iff this is set. */
  readonly contextWindow?: number;
  /** Malformed tool-call arguments are repaired before failing (wired on the live driver). */
  readonly schemaRepair: boolean;
  /** The model/provider can be switched at runtime without a restart. */
  readonly providerSwitch: boolean;
  /** A memory tool is advertised and executable this run. */
  readonly memoryWired: boolean;
  /** How many tools are actually advertised/executable this run. */
  readonly toolCount: number;
}

/** The truthful capability report. Every field reflects the ACTUAL run, never an aspiration. */
export interface RuntimeCapabilities {
  /** ── always-on kernel guarantees ───────────────────────────────── */
  readonly kernelLoop: true;
  readonly toolCalling: true;
  readonly streaming: true;
  readonly approvalGate: true;
  readonly receipts: true;
  readonly checkpoints: true;
  readonly conversationMemory: true;
  readonly partialOnExhaustion: true;
  /** Reversible writes + undo landed in P0.3 and are always available. */
  readonly reversibleWrites: true;
  readonly undo: true;
  /** ── wiring-dependent (the honest bits) ────────────────────────── */
  readonly writesEnabled: boolean;
  readonly evidenceGate: boolean;
  readonly contextCompaction: boolean;
  readonly schemaRepair: boolean;
  readonly providerSwitch: boolean;
  readonly memory: boolean;
  readonly toolCount: number;
}

/** Derive the truthful capability report from the live run wiring. Pure. */
export function runtimeCapabilities(input: RuntimeCapabilityInput): RuntimeCapabilities {
  return {
    kernelLoop: true,
    toolCalling: true,
    streaming: true,
    approvalGate: true,
    receipts: true,
    checkpoints: true,
    conversationMemory: true,
    partialOnExhaustion: true,
    reversibleWrites: true,
    undo: true,
    writesEnabled: input.allowWrites,
    evidenceGate: input.requireEvidence,
    contextCompaction: input.contextWindow !== undefined,
    schemaRepair: input.schemaRepair,
    providerSwitch: input.providerSwitch,
    memory: input.memoryWired,
    toolCount: input.toolCount,
  };
}

/**
 * The subset of capability KEYS that are currently ACTIVE — the honest list to show a user
 * or fold into the model's self-description, so it only ever claims what is truly on.
 */
export function activeCapabilityList(caps: RuntimeCapabilities): string[] {
  const active: string[] = [];
  for (const [key, value] of Object.entries(caps)) {
    if (value === true) active.push(key);
  }
  return active;
}
