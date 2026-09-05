import { type ContainmentAvailability, detectContainment } from "./availability.js";
import { canonical, isWithinAny } from "./paths.js";
import { checkGrantableWorkspace } from "./grantable.js";
import { type CommandRisk, classifyCommandRisk } from "./risk.js";

/**
 * `auto`      — contain risky commands; DENY when containment is unavailable.
 * `required`  — deny every request when containment is unavailable, risky or not. Strictest.
 * `off`       — do not contain. For unit tests and non-Linux development. Never for an agent.
 */
export type ContainmentMode = "auto" | "required" | "off";

export const DEFAULT_CONTAINMENT_MODE: ContainmentMode = "auto";

/**
 * The per-agent configuration.
 *
 * `writableWorkspaces` is THE ONLY field that legitimately differs between deployments. Everything
 * else — the risk table, the views, the argv construction — is shared bytes, and runtime parity
 * asserts as much. If a second field ever needs to vary per deployment, that is a doctrine change
 * and belongs in an ADR, not in a config file.
 */
export interface ContainmentConfig {
  readonly mode: ContainmentMode;
  /** Absolute host paths this agent may ever write to. A request outside them is refused. */
  readonly writableWorkspaces: readonly string[];
  /** The governed temporary root, injected rather than imported so this module owns no authority. */
  readonly governedTempRoot?: string | undefined;
  /**
   * Run risky commands UNCONTAINED when containment is unavailable, instead of denying.
   *
   * Explicit, default-off, and every use is a receipt an operator has to look at. There is no
   * unsafe default and no way to reach this by omission.
   */
  readonly trustedLocalOverride: boolean;
}

/**
 * `worktree` — the whole host is bound READ-ONLY and the workspace is writable.
 * `narrow`   — the host is NOT mounted. Only essential system directories, the explicit read-only
 *              roots, and a private tmpfs are visible. Read-only access still discloses, so a
 *              read-only terminal must not be able to see the whole host.
 */
export type ContainmentView = "worktree" | "narrow";

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly view?: ContainmentView | undefined;
  /** The one writable host path. Must lie within a declared workspace. */
  readonly writableRoot?: string | undefined;
  /** narrow view: host paths bound read-only. */
  readonly readonlyRoots?: readonly string[] | undefined;
  /** Extra writable paths — package-manager stores for a dependency install, and nothing else. */
  readonly extraWritable?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** This run's governed temporary child, bound writable and exported as TMPDIR/TMP/TEMP. */
  readonly tempRoot?: string | undefined;
}

/** A concrete, resolved policy. The argv builder consumes exactly this and nothing else. */
export interface ContainmentPolicy {
  readonly backend: "bwrap" | "none";
  readonly view: ContainmentView;
  readonly writableRoot?: string | undefined;
  readonly readonlyRoots?: readonly string[] | undefined;
  readonly extraWritable?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly tempRoot?: string | undefined;
  readonly networkAllowed: boolean;
  /**
   * Deny the AF_UNIX address family at the syscall boundary.
   *
   * Set for every policy that denies the network. A policy that refuses IP but leaves unix sockets
   * reachable does not isolate anything: an audit demonstrated contained code connecting to a host
   * listener created outside every declared workspace, and mount masking cannot close a class of
   * object that can appear anywhere on the filesystem.
   *
   * Deliberately NOT set for a network client. `ssh` reaches its agent over a unix socket, so the
   * filter would break the one command whose entire purpose is to reach something. Its containment
   * is filesystem confinement, and that is stated rather than overclaimed.
   */
  readonly denyUnixSockets: boolean;
  readonly risk: CommandRisk;
  /** Set when the policy is uncontained BECAUSE the operator override fired. Always receipted. */
  readonly uncontainedByOverride?: boolean | undefined;
}

export type DenialCode =
  | "CONTAINMENT_UNAVAILABLE"
  | "WORKSPACE_NOT_DECLARED"
  | "WORKSPACE_REQUIRED"
  | "NO_WORKSPACES_CONFIGURED";

export interface Denial {
  readonly code: DenialCode;
  readonly reason: string;
  readonly risk: CommandRisk;
  readonly availability: ContainmentAvailability;
}

/**
 * A decision is a VALUE, never a thrown error.
 *
 * A throw invites a caller to wrap the call in a try/catch and carry on, which turns a refusal into
 * an uncontained execution. Making the denial a value means the only way to spawn is to hold an
 * allowed decision, and there is nothing to accidentally swallow.
 */
export type ContainmentDecision =
  | { readonly allowed: true; readonly policy: ContainmentPolicy }
  | { readonly allowed: false; readonly denial: Denial };

/** Raised when a configuration names a workspace outside the reviewed vocabulary. */
export class UngrantableWorkspace extends Error {
  constructor(reason: string) {
    super(`ungrantable workspace: ${reason}`);
    this.name = "UngrantableWorkspace";
  }
}

function deny(code: DenialCode, reason: string, risk: CommandRisk, availability: ContainmentAvailability): ContainmentDecision {
  return { allowed: false, denial: { code, reason, risk, availability } };
}

/**
 * Decide how — or whether — a command may run.
 *
 * The order of checks is the whole safety argument, so it is fixed:
 *
 *   1. Classify the command.
 *   2. Confine the workspace. A write target outside the agent's declared workspaces is refused
 *      BEFORE availability is considered, because an unavailable sandbox is a host problem the
 *      operator can fix, whereas writing outside the declared area is a policy violation that no
 *      host repair should ever allow.
 *   3. Consult availability and fail closed.
 *
 * `mode: "off"` short-circuits after step 2. It still honours the workspace confinement, so even
 * the development mode cannot be used to write somewhere the agent never declared.
 */
export function planFor(
  request: ExecRequest,
  config: ContainmentConfig,
  availability: ContainmentAvailability = detectContainment(),
): ContainmentDecision {
  const risk = classifyCommandRisk(request.command, request.args);
  const view: ContainmentView = request.view ?? "worktree";

  const workspaces = config.writableWorkspaces.map(canonical);
  const writableRoot = request.writableRoot !== undefined ? canonical(request.writableRoot) : undefined;

  if (writableRoot !== undefined) {
    if (workspaces.length === 0) {
      return deny("NO_WORKSPACES_CONFIGURED",
        "this agent declares no writable workspace, so no write target can be authorised",
        risk, availability);
    }
    if (!isWithinAny(writableRoot, workspaces)) {
      return deny("WORKSPACE_NOT_DECLARED",
        `${writableRoot} is not within any declared writable workspace`,
        risk, availability);
    }
  } else if (risk.risky && view === "worktree" && config.mode !== "off") {
    // A risky command with no writable root under the worktree view would run against a wholly
    // read-only host. That is safe but almost always a caller mistake, and a silent failure deep
    // inside a build is worse than a refusal here.
    return deny("WORKSPACE_REQUIRED",
      `${request.command} is ${risk.kind} and needs a declared writable workspace`,
      risk, availability);
  }

  if (config.mode === "off") {
    return { allowed: true, policy: uncontained(request, view, writableRoot, risk, false) };
  }

  if (!availability.available) {
    if (config.mode === "required") {
      return deny("CONTAINMENT_UNAVAILABLE",
        `containment is required and unavailable: ${availability.reason ?? "unknown"}`,
        risk, availability);
    }
    if (risk.risky && !config.trustedLocalOverride) {
      return deny("CONTAINMENT_UNAVAILABLE",
        `${request.command} is ${risk.kind} and containment is unavailable: ${availability.reason ?? "unknown"}`,
        risk, availability);
    }
    // Either the command is not risky, or the operator override fired. Both run uncontained; the
    // override case is flagged so the receipt says so.
    return { allowed: true, policy: uncontained(request, view, writableRoot, risk, risk.risky) };
  }

  return {
    allowed: true,
    policy: {
      backend: "bwrap",
      view,
      writableRoot,
      readonlyRoots: request.readonlyRoots,
      extraWritable: request.extraWritable,
      cwd: request.cwd,
      tempRoot: request.tempRoot ?? config.governedTempRoot,
      // The narrow view never shares the network, whatever the command would like.
      networkAllowed: view === "narrow" ? false : risk.needsNetwork,
      // ALWAYS. Not "when the network is denied" -- a dependency install needs TCP and still has
      // no business reaching a host service over a unix socket, and every toolchain the lab runs
      // was verified to work under the filter. An unfiltered class is a class somebody aims for.
      denyUnixSockets: true,
      risk,
    },
  };
}

function uncontained(
  request: ExecRequest,
  view: ContainmentView,
  writableRoot: string | undefined,
  risk: CommandRisk,
  byOverride: boolean,
): ContainmentPolicy {
  return {
    backend: "none",
    view,
    writableRoot,
    readonlyRoots: request.readonlyRoots,
    extraWritable: request.extraWritable,
    cwd: request.cwd,
    tempRoot: request.tempRoot,
    networkAllowed: true,
    denyUnixSockets: false,
    risk,
    ...(byOverride ? { uncontainedByOverride: true } : {}),
  };
}

/**
 * Build a containment configuration from ALREADY-VALIDATED deployment data.
 *
 * This is the factory the agents use, and it names no agent. The writable set arrives as data that
 * the caller's own closed-schema validation has already accepted; nothing here decides policy from
 * an identity, because shared enforcement code that branches on who is running it is no longer one
 * boundary — it is three, wearing the same file name.
 *
 * `mode` is fixed at `auto`: risky work is denied when the boundary is unavailable. There is no
 * parameter for `off`, and `trustedLocalOverride` is hard-false, so neither can be reached from a
 * configuration file or an environment variable.
 *
 * The governed scratch is added to the writable set because every run writes the file it is about
 * to execute there. It is the same addition for every deployment, so it distinguishes none of them.
 * It is the ONE path exempt from the grantable vocabulary, because it is not a fixed name: it is
 * whatever the governed temporary authority resolved, and that authority validates it far more
 * strictly than a list could.
 *
 * Every OTHER declared path must be in the reviewed vocabulary. The deployment schema checks this
 * too; it is checked again here because a boundary that is only enforced at one edge is enforced by
 * whoever remembers to call that edge.
 */
export function containmentConfig(declared: {
  readonly writableWorkspaces: readonly string[];
  readonly governedTempRoot?: string | undefined;
}): ContainmentConfig {
  for (const workspace of declared.writableWorkspaces) {
    const check = checkGrantableWorkspace(workspace);
    if (!check.ok) throw new UngrantableWorkspace(check.reason);
  }
  const temp = declared.governedTempRoot;
  return {
    mode: "auto",
    writableWorkspaces: temp === undefined || temp.length === 0
      ? [...declared.writableWorkspaces]
      : [...declared.writableWorkspaces, temp],
    trustedLocalOverride: false,
    ...(temp === undefined ? {} : { governedTempRoot: temp }),
  };
}

/**
 * THE policy for the one operation that is allowed to reach the network.
 *
 * Not reachable through `planFor`: no command name, argument, or classification produces it. The
 * broker calls it directly, which is what makes "is this the SSH operation?" a question about which
 * code is running rather than about what a string says.
 *
 * It keeps the network and it KEEPS THE SYSCALL FILTER. The previous exception dropped both, on the
 * theory that ssh needs a unix socket for its agent; with `IdentityAgent=none` it does not, and that
 * was verified by running the real client under the real filter.
 */
export function sshBrokerPolicy(
  workspace: { readonly writableRoot: string; readonly tempRoot?: string | undefined },
  availability: ContainmentAvailability = detectContainment(),
): ContainmentDecision {
  const risk: CommandRisk = {
    risky: true,
    kind: "safe",
    needsNetwork: true,
    reason: "the governed SSH read operation",
  };
  if (!availability.available) {
    return deny("CONTAINMENT_UNAVAILABLE",
      `the SSH operation requires containment, which is unavailable: ${availability.reason ?? "unknown"}`,
      risk, availability);
  }
  return {
    allowed: true,
    policy: {
      backend: "bwrap",
      view: "worktree",
      writableRoot: workspace.writableRoot,
      cwd: workspace.writableRoot,
      tempRoot: workspace.tempRoot,
      networkAllowed: true,
      denyUnixSockets: true,
      risk,
    },
  };
}
