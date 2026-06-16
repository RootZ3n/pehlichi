/**
 * UNATTENDED PROFILE — the strict, fail-closed policy for running Pehlichi without
 * a human in the loop (L6 limited-unattended-autonomy, req #3).
 *
 * This is deliberately a standalone POLICY module of pure guards. The unattended
 * launcher calls these gates; supervised mode is unaffected. Everything here is
 * DENY BY DEFAULT.
 *
 * What unattended mode forbids:
 *   - terminal/shell, unless routed through governed exec with an explicit argv allowlist
 *   - shell metacharacters (always)
 *   - raw web fetch, unless an egress allowlist grants the host
 *   - browser tools (always)
 *   - cron/scheduled mutation (always)
 *   - brain sync / durable memory install (always — proposals only)
 *   - reading .env / private keys / token / credential-store / secret-bearing files
 *   - network by default
 *   - delegation beyond the granted depth
 *   - AGENT_FS_UNRESTRICTED=true (hard-fails startup)
 *   - treating noChangeRequired as success without independent evidence
 *   - nested delegation that overruns the shared global budget
 */

/** Read-only + propose-only tools allowed in unattended mode. DENY BY DEFAULT for anything else. */
export const UNATTENDED_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "list_dir",
  "search_files",
  "memory_read",
  "memory_search",
  "memory_write", // routes through governance → proposal only (never a durable install)
  "lab_context_read",
  "todo",
]);

/** Tools that are explicitly, permanently forbidden in unattended mode (for clearer errors). */
const HARD_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "terminal",
  "process",
  "execute_code",
  "web_search",
  "web_extract",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_snapshot",
  "browser_vision",
  "browser_console",
  "browser_back",
  "browser_get_images",
  "cronjob",
  "brain_sync",
]);

export interface UnattendedToolContext {
  /** Tools explicitly granted by an operator capability for this run (e.g. delegate_task). */
  readonly grantedTools?: ReadonlySet<string>;
  /** True if write tools may be delegated (default false). */
  readonly allowDelegationWrites?: boolean;
}

/**
 * DENY BY DEFAULT tool gate. Returns a deny reason, or null if the tool is allowed.
 */
export function unattendedToolDenyReason(tool: string, ctx: UnattendedToolContext = {}): string | null {
  if (HARD_DENIED_TOOLS.has(tool)) {
    return `tool "${tool}" is disabled in unattended mode`;
  }
  if (UNATTENDED_ALLOWED_TOOLS.has(tool)) return null;
  if (ctx.grantedTools && ctx.grantedTools.has(tool)) return null;
  return `tool "${tool}" is not allowed in unattended mode (deny by default)`;
}

export function isToolAllowedUnattended(tool: string, ctx?: UnattendedToolContext): boolean {
  return unattendedToolDenyReason(tool, ctx) === null;
}

/** Shell metacharacters — never allowed in an unattended command/argument. */
export const SHELL_META = /[&;|<>`$()\\!*?{}\[\]~\n\r]|\$\(/;

export function shellMetaDenyReason(s: string): string | null {
  const m = SHELL_META.exec(s);
  return m ? `shell metacharacter "${m[0]}" not allowed in unattended mode` : null;
}

export interface GovernedExecRequest {
  /** The binary to execute. */
  readonly bin: string;
  /** Literal arguments (already tokenized — never a shell string). */
  readonly args: readonly string[];
}

/**
 * Terminal is denied in unattended mode UNLESS the operator supplied an explicit
 * argv allowlist (governed exec) and the requested binary is on it. Even then,
 * every token is checked for shell metacharacters.
 */
export function terminalUnattendedDenyReason(
  req: GovernedExecRequest,
  argvAllowlist?: ReadonlySet<string>,
): string | null {
  if (!argvAllowlist || argvAllowlist.size === 0) {
    return "terminal is disabled in unattended mode (no governed argv allowlist configured)";
  }
  if (!argvAllowlist.has(req.bin)) {
    return `binary "${req.bin}" is not in the governed argv allowlist`;
  }
  for (const token of [req.bin, ...req.args]) {
    const meta = shellMetaDenyReason(token);
    if (meta) return meta;
  }
  return null;
}

/** Raw fetch is denied unless the host is on the egress allowlist (default-deny network). */
export function fetchUnattendedDenyReason(host: string | undefined, egressAllowlist?: ReadonlySet<string>): string | null {
  if (!host || !host.trim()) return "fetch denied: no host";
  if (!egressAllowlist || egressAllowlist.size === 0) {
    return "network is disabled in unattended mode (no egress allowlist configured)";
  }
  if (!egressAllowlist.has(host)) {
    return `host "${host}" is not on the egress allowlist`;
  }
  return null;
}

/** Browser automation is always denied in unattended mode. */
export function browserUnattendedDenyReason(): string {
  return "browser automation is disabled in unattended mode";
}

/**
 * Secret-bearing files must never be read into model context. Matches .env files,
 * private keys, credential stores, and obvious token/secret files.
 */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.env\.[\w.-]+$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)credentials(\.json|\.yaml|\.yml)?$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
  /(secret|secrets|token|password|apikey|api_key|private[-_]?key)s?\.(json|yaml|yml|txt|env)$/i,
];

export function secretFileReadDenyReason(path: string): string | null {
  for (const re of SECRET_FILE_PATTERNS) {
    if (re.test(path)) return `reading secret-bearing file "${path}" is denied in unattended mode`;
  }
  return null;
}

/**
 * STARTUP GUARD. Unattended mode must never run with an unrestricted filesystem/env.
 * Throws (the launcher must refuse to start) if AGENT_FS_UNRESTRICTED=true.
 */
export function assertUnattendedStartup(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AGENT_FS_UNRESTRICTED === "true") {
    throw new Error(
      "unattended mode refuses to start: AGENT_FS_UNRESTRICTED=true is forbidden " +
        "(it would inherit the full environment + bypass workspace confinement).",
    );
  }
}

/** Delegation depth gate. Returns a deny reason if the requested depth exceeds the grant. */
export function delegationDepthDenyReason(currentDepth: number, allowedDepth: number): string | null {
  if (currentDepth > allowedDepth) {
    return `delegation depth ${currentDepth} exceeds allowed depth ${allowedDepth}`;
  }
  return null;
}

/**
 * SHARED GLOBAL BUDGET across nested delegation. A parent creates one and passes
 * the SAME instance down; every nested agent consumes from it. Exhaustion is never
 * a success — it is a hard stop.
 */
export class SharedBudget {
  private _spent = 0;
  constructor(private readonly _total: number) {
    if (_total < 1) throw new Error("budget total must be >= 1");
  }
  get total(): number {
    return this._total;
  }
  get spent(): number {
    return this._spent;
  }
  get remaining(): number {
    return Math.max(0, this._total - this._spent);
  }
  get exhausted(): boolean {
    return this._spent >= this._total;
  }
  /** Try to consume n units. Returns true if consumed, false if it would overrun (fail closed). */
  consume(n = 1): boolean {
    if (this._spent + n > this._total) {
      this._spent = this._total; // clamp to exhausted; never overspend
      return false;
    }
    this._spent += n;
    return true;
  }
}

export interface UnattendedResult {
  readonly noChangeRequired?: boolean;
  /** Independent evidence (e.g. tool-call results) that the claimed outcome is real. */
  readonly evidence?: readonly unknown[];
}

/**
 * A "noChangeRequired" or otherwise budget-exhausted run is NOT a verified success
 * unless backed by independent evidence. Returns a verdict the caller must honor.
 */
export function verifyUnattendedSuccess(
  result: UnattendedResult,
  budget?: SharedBudget,
): { verified: boolean; reason: string } {
  if (budget && budget.exhausted) {
    return { verified: false, reason: "budget exhausted — not a verified success" };
  }
  const hasEvidence = Array.isArray(result.evidence) && result.evidence.length > 0;
  if (result.noChangeRequired && !hasEvidence) {
    return {
      verified: false,
      reason: "noChangeRequired claimed without independent evidence — not verified",
    };
  }
  return { verified: true, reason: "verified" };
}
