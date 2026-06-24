/**
 * MEMORY GOVERNANCE — the proposal boundary for durable agent memory.
 *
 * WHY: the memory tool used to write MEMORY.md / USER.md directly. Even gated by
 * an approval policy, an approved (or accidentally approved) tool call installed
 * durable memory with no proposal → evidence → skeptic → approval → install →
 * rollback. That is exactly the path the lab-trust sprint closes.
 *
 * WHAT: when a `MemoryGovernance` sink is wired into the memory tool, a durable
 * add/replace/remove no longer writes the memory file. Instead it records a
 * pending PROPOSAL (improvement-governance shaped) to a proposals inbox and
 * returns the proposal id. Durable install happens out-of-band only after the
 * proposal is verified and a human approves it — never as a side effect of the
 * agent's tool call.
 *
 * The risk level and improvement_type are CLASSIFIED HERE from the change itself,
 * not taken from the agent — an agent cannot smuggle a high-risk change in as
 * low-risk. Reads stay direct (no proposal).
 *
 * pehlichi stays standalone: this writes a portable proposal record (JSON) to an
 * inbox dir. The improvement-governance pipeline (or a human) is what installs.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryRisk = "low" | "medium" | "high" | "critical";

export type MemoryImprovementType =
  | "factual_memory"
  | "preference_memory"
  | "behavior_rule"
  | "tool_policy"
  | "model_routing"
  | "identity_persona"
  | "security_sensitive";

/**
 * Reference-only evidence an agent may OPTIONALLY attach to a memory proposal. This is
 * provenance/binding for a later reviewer (Truth Firewall) — it never marks memory as verified and
 * never changes approval/install. Stores REFERENCES (paths/hashes/ids), never blob content.
 * Deferred kinds (command_receipt/tool_receipt) are intentionally absent: current agent receipts
 * are in-memory/TTL and not durable/referenceable at proposal time.
 */
export type MemoryEvidenceKind =
  | "file"
  | "commit"
  | "existing_memory"
  | "user_message"
  | "agent_report"
  | "manual_note";

export interface EvidenceRef {
  readonly kind: MemoryEvidenceKind;
  readonly path?: string;
  readonly sha256?: string;
  readonly lines?: string;
  readonly commit?: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly description?: string;
}

const MEMORY_EVIDENCE_KINDS: ReadonlySet<string> = new Set<MemoryEvidenceKind>([
  "file",
  "commit",
  "existing_memory",
  "user_message",
  "agent_report",
  "manual_note",
]);
const EVIDENCE_DESCRIPTION_MAX = 500;

/**
 * Sanitize agent-supplied evidence into well-formed, REFERENCE-ONLY EvidenceRefs. Authoritative at
 * the governance boundary (also called by the tool for early feedback). Drops anything that could
 * never be verified later: unknown/deferred kinds (incl. command_receipt/tool_receipt), `file`
 * without a `path`, `commit` without a `commit`, `existing_memory` without a `ref`. Carries
 * `sha256` when provided (never required). Provenance kinds may carry only a description. Never
 * embeds blob content; a description is trimmed to a bounded length.
 */
export function sanitizeMemoryEvidence(input: unknown): EvidenceRef[] {
  if (!Array.isArray(input)) return [];
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const out: EvidenceRef[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.kind !== "string" || !MEMORY_EVIDENCE_KINDS.has(e.kind)) continue;
    const kind = e.kind as MemoryEvidenceKind;
    const path = str(e.path);
    const commit = str(e.commit);
    const ref = str(e.ref);
    // Required-field gates per kind — reject garbage that a reviewer could never resolve.
    if (kind === "file" && !path) continue;
    if (kind === "commit" && !commit) continue;
    if (kind === "existing_memory" && !ref) continue;
    const sha256 = str(e.sha256);
    const lines = str(e.lines);
    const repo = str(e.repo);
    const desc = str(e.description);
    out.push({
      kind,
      ...(path ? { path } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(lines ? { lines } : {}),
      ...(commit ? { commit } : {}),
      ...(repo ? { repo } : {}),
      ...(ref ? { ref } : {}),
      ...(desc ? { description: desc.length > EVIDENCE_DESCRIPTION_MAX ? desc.slice(0, EVIDENCE_DESCRIPTION_MAX) : desc } : {}),
    });
  }
  return out;
}

/** The change an agent is proposing to durable memory. */
export interface MemoryChangeRequest {
  readonly action: "add" | "replace" | "remove";
  /** "memory" = agent notes (MEMORY.md), "user" = user profile (USER.md). */
  readonly target: "memory" | "user";
  readonly content?: string;
  readonly oldText?: string;
  /** OPTIONAL reference-only evidence (sanitized at the boundary). Empty/absent ⇒ no evidence. */
  readonly evidence?: ReadonlyArray<EvidenceRef>;
}

/** A persisted, NON-INSTALLED proposal. Creating one never writes durable memory. */
export interface MemoryChangeProposal {
  readonly id: string;
  readonly status: "pending_verification";
  readonly createdAt: string;
  readonly agent: string;
  readonly improvement_type: MemoryImprovementType;
  readonly action: "add" | "replace" | "remove";
  readonly target: "memory" | "user";
  /** Durable file the change would land in (MEMORY.md / USER.md). */
  readonly namespace: string;
  readonly content?: string;
  readonly oldText?: string;
  /** OPTIONAL reference-only evidence (omitted when empty). Advisory — never marks memory verified. */
  readonly evidence?: ReadonlyArray<EvidenceRef>;
  readonly risk_level: MemoryRisk;
  readonly requiresHumanApproval: boolean;
  /** Hard invariant: proposing never installs. */
  readonly installed: false;
  readonly approval: { readonly status: "pending" };
}

/** Sink that records a memory-change proposal and returns it (without installing). */
export interface MemoryGovernance {
  propose(change: MemoryChangeRequest, agent: string): MemoryChangeProposal;
}

/** A persisted, NON-INSTALLED proposal to write a durable brain page. */
export interface BrainPutProposal {
  readonly id: string;
  readonly status: "pending_verification";
  readonly createdAt: string;
  readonly agent: string;
  readonly kind: "brain_put";
  readonly slug: string;
  readonly content: string;
  readonly improvement_type: MemoryImprovementType;
  readonly risk_level: MemoryRisk;
  readonly requiresHumanApproval: boolean;
  readonly installed: false;
  readonly approval: { readonly status: "pending" };
}

/** Sink that records a durable brain-page proposal and returns it (without installing). */
export interface BrainGovernance {
  proposePut(slug: string, content: string, agent: string): BrainPutProposal;
}

// Keywords that escalate risk and force human approval (Phase 1 high-risk set).
const HIGH_RISK_KEYWORDS = [
  "behavior_rule",
  "tool_policy",
  "tool policy",
  "model_routing",
  "model routing",
  "permission",
  "persona",
  "identity",
  "network",
  "security",
  "auth",
];
const CRITICAL_KEYWORDS = ["secret", "password", "credential", "private key", "api key", "token", "rm -rf", "sudo"];

/**
 * Classify improvement_type + risk from the change content/target. Computed here,
 * never trusted from the agent — so a caller cannot understate risk.
 */
export function classifyMemoryChange(change: MemoryChangeRequest): {
  improvement_type: MemoryImprovementType;
  risk_level: MemoryRisk;
} {
  const haystack = `${change.content ?? ""}\n${change.oldText ?? ""}`.toLowerCase();

  let improvement_type: MemoryImprovementType = change.target === "user" ? "preference_memory" : "factual_memory";
  // Base risk: user-profile writes are at least medium (they shape how the agent treats the human);
  // a remove of durable memory is also at least medium (destructive). Plain factual add is low.
  let risk: MemoryRisk = change.target === "user" || change.action === "remove" ? "medium" : "low";

  if (haystack.includes("behavior_rule") || haystack.includes("behaviour")) improvement_type = "behavior_rule";
  if (haystack.includes("tool_policy") || haystack.includes("tool policy")) improvement_type = "tool_policy";
  if (haystack.includes("model_routing") || haystack.includes("model routing")) improvement_type = "model_routing";
  if (haystack.includes("persona") || haystack.includes("identity")) improvement_type = "identity_persona";

  if (HIGH_RISK_KEYWORDS.some((k) => haystack.includes(k))) {
    risk = risk === "low" || risk === "medium" ? "high" : risk;
  }
  if (CRITICAL_KEYWORDS.some((k) => haystack.includes(k))) {
    risk = "critical";
    improvement_type = "security_sensitive";
  }
  return { improvement_type, risk_level: risk };
}

/** High-risk improvement types always require a human at the install boundary. */
function requiresHumanApproval(type: MemoryImprovementType, risk: MemoryRisk): boolean {
  if (risk === "high" || risk === "critical") return true;
  const highRiskTypes: MemoryImprovementType[] = [
    "behavior_rule",
    "tool_policy",
    "model_routing",
    "identity_persona",
    "security_sensitive",
  ];
  return highRiskTypes.includes(type);
}

function defaultIdGen(): string {
  // Plain runtime code (not a workflow script) — Date.now()/random are fine here.
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `mem-${ts}-${rand}`;
}

export interface FileMemoryGovernanceOptions {
  /** Directory the pending proposals are written to (one JSON file each). */
  readonly proposalsDir: string;
  /** Injectable id generator (tests use a deterministic one). */
  readonly idGen?: () => string;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

/**
 * A file-backed governance sink: every proposal is written to `proposalsDir` as a
 * JSON file (the inbox the governance pipeline / a human reviews). It does NOT
 * install — it only records the pending proposal.
 */
export function createFileMemoryGovernance(opts: FileMemoryGovernanceOptions): MemoryGovernance {
  const idGen = opts.idGen ?? defaultIdGen;
  const now = opts.now ?? (() => new Date());
  return {
    propose(change: MemoryChangeRequest, agent: string): MemoryChangeProposal {
      const { improvement_type, risk_level } = classifyMemoryChange(change);
      // Evidence is REFERENCE-ONLY provenance for a later reviewer; it does NOT influence risk
      // classification, approval, or install. Sanitized here (authoritative) and omitted when empty.
      const evidence = sanitizeMemoryEvidence(change.evidence);
      const proposal: MemoryChangeProposal = {
        id: idGen(),
        status: "pending_verification",
        createdAt: now().toISOString(),
        agent,
        improvement_type,
        action: change.action,
        target: change.target,
        namespace: change.target === "user" ? "USER.md" : "MEMORY.md",
        ...(change.content !== undefined ? { content: change.content } : {}),
        ...(change.oldText !== undefined ? { oldText: change.oldText } : {}),
        ...(evidence.length > 0 ? { evidence } : {}),
        risk_level,
        requiresHumanApproval: requiresHumanApproval(improvement_type, risk_level),
        installed: false,
        approval: { status: "pending" },
      };
      mkdirSync(opts.proposalsDir, { recursive: true });
      writeFileSync(join(opts.proposalsDir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2), "utf8");
      return proposal;
    },
  };
}

/**
 * A file-backed brain governance sink. A durable brain page write becomes a
 * pending proposal in `proposalsDir`; it is never installed by proposing. Risk
 * is classified from the page content (not trusted from the agent).
 */
export function createFileBrainGovernance(opts: FileMemoryGovernanceOptions): BrainGovernance {
  const idGen = opts.idGen ?? defaultIdGen;
  const now = opts.now ?? (() => new Date());
  return {
    proposePut(slug: string, content: string, agent: string): BrainPutProposal {
      const { improvement_type, risk_level } = classifyMemoryChange({ action: "add", target: "memory", content });
      const proposal: BrainPutProposal = {
        id: idGen(),
        status: "pending_verification",
        createdAt: now().toISOString(),
        agent,
        kind: "brain_put",
        slug,
        content,
        improvement_type,
        risk_level,
        requiresHumanApproval: requiresHumanApproval(improvement_type, risk_level),
        installed: false,
        approval: { status: "pending" },
      };
      mkdirSync(opts.proposalsDir, { recursive: true });
      writeFileSync(join(opts.proposalsDir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2), "utf8");
      return proposal;
    },
  };
}
