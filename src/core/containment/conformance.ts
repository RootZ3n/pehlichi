import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ContainmentAvailability, detectContainment } from "./availability.js";
import { buildNarrowArgs, buildWorktreeArgs } from "./argv.js";
import { type ContainmentConfig, type ContainmentPolicy, planFor, sshBrokerPolicy } from "./policy.js";
import { classifyCommandRisk } from "./risk.js";
import { CONTAINMENT_VERSION } from "./version.js";
import { ContainmentRefused, wrap } from "./wrap.js";

export interface Control {
  readonly id: string;
  readonly description: string;
  readonly pass: boolean;
  /** Present when the control did not pass, or when it was skipped. */
  readonly detail?: string;
  /** True when the host could not support the control (no bwrap), so it proves nothing either way. */
  readonly skipped?: boolean;
}

export interface ConformanceResult {
  readonly version: string;
  readonly availability: ContainmentAvailability;
  readonly controls: readonly Control[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /**
   * True when nothing FAILED. Skipped controls do not make a run green in the sense parity needs —
   * `behaviouralProof` reports that separately, so a host without bwrap cannot present a
   * static-only pass as if the boundary had been exercised.
   */
  readonly ok: boolean;
  /** True when the live controls actually ran, i.e. the boundary was exercised on this host. */
  readonly behaviouralProof: boolean;
}

const UNAVAILABLE: ContainmentAvailability = Object.freeze({
  available: false,
  reason: "probe stubbed by the conformance suite",
});

const AVAILABLE: ContainmentAvailability = Object.freeze({ available: true, tool: "bwrap", version: "stub" });

function control(id: string, description: string, pass: boolean, detail?: string): Control {
  return detail === undefined ? { id, description, pass } : { id, description, pass, detail };
}

function has(argv: readonly string[], ...seq: string[]): boolean {
  for (let i = 0; i + seq.length <= argv.length; i++) {
    if (seq.every((token, k) => argv[i + k] === token)) return true;
  }
  return false;
}

function policyFor(over: Partial<ContainmentPolicy> = {}): ContainmentPolicy {
  return {
    backend: "bwrap",
    view: "worktree",
    networkAllowed: false,
    denyUnixSockets: true,
    risk: classifyCommandRisk("node", []),
    ...over,
  };
}

/**
 * Run every control and report.
 *
 * Callable at runtime, not only under a test runner, because the parity verifier has to execute it
 * inside all three agents and compare the results. A conformance suite that only exists as a test
 * file cannot answer "are these three agents running the same boundary right now".
 *
 * `scratch` is a writable directory used by the live controls. Supply one from the governed
 * temporary authority; when it is absent the live controls are skipped rather than inventing a path.
 */
export function conformance(options: { readonly scratch?: string } = {}): ConformanceResult {
  const controls: Control[] = [];
  const availability = detectContainment();

  // ---- identity ----------------------------------------------------------------------------
  controls.push(control("C01", "the authority reports a version stamp",
    typeof CONTAINMENT_VERSION === "string" && CONTAINMENT_VERSION.length > 0, CONTAINMENT_VERSION));

  // ---- risk classification -----------------------------------------------------------------
  const interpreterBare = classifyCommandRisk("python3", []);
  const interpreterScript = classifyCommandRisk("/usr/bin/python3", ["script.py"]);
  controls.push(control("C02", "an interpreter is risky regardless of its arguments",
    interpreterBare.risky && interpreterScript.risky && interpreterScript.kind === "interpreter"));

  const install = classifyCommandRisk("pnpm", ["install"]);
  const runScript = classifyCommandRisk("pnpm", ["run", "build"]);
  controls.push(control("C03", "a package install needs the network and a package script does not",
    install.risky && install.needsNetwork && runScript.risky && !runScript.needsNetwork));

  const writeTool = classifyCommandRisk("rm", ["-rf", "/"]);
  controls.push(control("C04", "a file-writing coreutil is risky even though it runs no project code",
    writeTool.risky && writeTool.kind === "write-tool"));

  const unknown = classifyCommandRisk("hostname", []);
  controls.push(control("C05", "an unrecognised command classifies as safe rather than risky",
    !unknown.risky && unknown.kind === "safe"));

  // ---- fail-closed policy ------------------------------------------------------------------
  const base: ContainmentConfig = { mode: "auto", writableWorkspaces: ["/"], trustedLocalOverride: false };

  const deniedUnavailable = planFor({ command: "node", args: ["x.js"], writableRoot: "/" }, base, UNAVAILABLE);
  controls.push(control("C06", "a risky command is DENIED when containment is unavailable",
    !deniedUnavailable.allowed && deniedUnavailable.denial.code === "CONTAINMENT_UNAVAILABLE"));

  const safeUnavailable = planFor({ command: "hostname", args: [] }, base, UNAVAILABLE);
  controls.push(control("C07", "a safe command still runs when containment is unavailable in auto mode",
    safeUnavailable.allowed && safeUnavailable.policy.backend === "none"));

  const requiredMode: ContainmentConfig = { ...base, mode: "required" };
  const deniedRequired = planFor({ command: "hostname", args: [] }, requiredMode, UNAVAILABLE);
  controls.push(control("C08", "required mode denies even a safe command when containment is unavailable",
    !deniedRequired.allowed && deniedRequired.denial.code === "CONTAINMENT_UNAVAILABLE"));

  const overrideOn: ContainmentConfig = { ...base, trustedLocalOverride: true };
  const overridden = planFor({ command: "node", args: [], writableRoot: "/" }, overrideOn, UNAVAILABLE);
  controls.push(control("C09", "the operator override runs uncontained and is flagged as such",
    overridden.allowed && overridden.policy.backend === "none" && overridden.policy.uncontainedByOverride === true));

  // ---- workspace confinement ---------------------------------------------------------------
  const confined: ContainmentConfig = { mode: "auto", writableWorkspaces: ["/lab/workspace"], trustedLocalOverride: false };

  const outside = planFor({ command: "node", args: [], writableRoot: "/lab/elsewhere" }, confined, AVAILABLE);
  controls.push(control("C10", "a write target outside every declared workspace is refused",
    !outside.allowed && outside.denial.code === "WORKSPACE_NOT_DECLARED"));

  const sibling = planFor({ command: "node", args: [], writableRoot: "/lab/workspace-evil" }, confined, AVAILABLE);
  controls.push(control("C11", "a sibling whose name merely starts with the workspace is refused",
    !sibling.allowed && sibling.denial.code === "WORKSPACE_NOT_DECLARED"));

  const noWorkspaces: ContainmentConfig = { mode: "auto", writableWorkspaces: [], trustedLocalOverride: false };
  const nothingDeclared = planFor({ command: "node", args: [], writableRoot: "/anywhere" }, noWorkspaces, AVAILABLE);
  controls.push(control("C12", "an agent that declares no workspace can authorise no write target",
    !nothingDeclared.allowed && nothingDeclared.denial.code === "NO_WORKSPACES_CONFIGURED"));

  const offMode: ContainmentConfig = { ...confined, mode: "off" };
  const offOutside = planFor({ command: "node", args: [], writableRoot: "/lab/elsewhere" }, offMode, AVAILABLE);
  controls.push(control("C13", "even mode:off honours workspace confinement",
    !offOutside.allowed && offOutside.denial.code === "WORKSPACE_NOT_DECLARED"));

  // ---- argv construction -------------------------------------------------------------------
  const worktreeArgs = buildWorktreeArgs(policyFor({ writableRoot: "/" }), "node", ["x.js"], {});
  controls.push(control("C14", "the worktree view binds the host read-only and masks /tmp",
    has(worktreeArgs, "--ro-bind", "/", "/") && has(worktreeArgs, "--tmpfs", "/tmp")));

  controls.push(control("C15", "every containment unshares all namespaces and dies with its parent",
    has(worktreeArgs, "--unshare-all") && has(worktreeArgs, "--die-with-parent") && has(worktreeArgs, "--new-session")));

  controls.push(control("C16", "the network is not shared unless the policy allows it",
    !has(worktreeArgs, "--share-net")));

  const netArgs = buildWorktreeArgs(policyFor({ writableRoot: "/", networkAllowed: true }), "pnpm", ["install"], {});
  controls.push(control("C17", "a policy that allows the network shares it",
    has(netArgs, "--share-net")));

  const narrowArgs = buildNarrowArgs(
    policyFor({ view: "narrow", networkAllowed: true, readonlyRoots: ["/usr"] }), "cat", ["/etc/hostname"], {});
  controls.push(control("C18", "the narrow view never binds the host root",
    !has(narrowArgs, "--ro-bind", "/", "/")));
  controls.push(control("C19", "the narrow view never shares the network, whatever the policy says",
    !has(narrowArgs, "--share-net")));

  controls.push(control("C21", "the worktree view masks the host runtime directory, so host sockets are unreachable",
    has(worktreeArgs, "--tmpfs", "/run")));
  controls.push(control("C22", "the narrow view never binds the host runtime directory at all",
    !has(narrowArgs, "--ro-bind", "/run", "/run")));

  // The mask is not the boundary; the syscall filter is. A network-denied policy must carry it.
  controls.push(control("C23", "a network-denied policy loads the AF_UNIX syscall filter",
    has(worktreeArgs, "--seccomp")));
  // Even the one networked operation carries the filter. There is no unfiltered class left, which
  // is the point: the previous exception was reached by putting a private `ssh` earlier in PATH.
  const brokered = sshBrokerPolicy({ writableRoot: "/" }, AVAILABLE);
  controls.push(control("C24", "the networked broker operation still loads the syscall filter",
    brokered.allowed === true && brokered.policy.networkAllowed && brokered.policy.denyUnixSockets));
  const namedSsh = planFor({ command: "ssh", args: ["host"], writableRoot: "/" }, base, AVAILABLE);
  controls.push(control("C25", "naming a network tool grants no network",
    namedSsh.allowed === true && !namedSsh.policy.networkAllowed));

  // ---- the refusal cannot be spawned -------------------------------------------------------
  let threw = false;
  try {
    wrap(outside, "node", []);
  } catch (error) {
    threw = error instanceof ContainmentRefused;
  }
  controls.push(control("C20", "a refused decision cannot be turned into a command", threw));

  // ---- live behavioural proof --------------------------------------------------------------
  const scratch = options.scratch;
  if (!availability.available || scratch === undefined) {
    const why = !availability.available
      ? `containment unavailable: ${availability.reason ?? "unknown"}`
      : "no scratch directory supplied";
    for (const [id, description] of [
      ["L01", "a contained command can write inside its workspace"],
      ["L02", "a contained command cannot write outside its workspace"],
      ["L03", "a contained command cannot reach the network"],
      ["L04", "a contained command cannot create a unix socket"],
    ] as const) {
      controls.push({ id, description, pass: false, skipped: true, detail: why });
    }
  } else {
    controls.push(...liveControls(scratch));
  }

  const failed = controls.filter((c) => !c.pass && c.skipped !== true).length;
  const skipped = controls.filter((c) => c.skipped === true).length;
  return {
    version: CONTAINMENT_VERSION,
    availability,
    controls,
    passed: controls.filter((c) => c.pass).length,
    failed,
    skipped,
    ok: failed === 0,
    behaviouralProof: skipped === 0,
  };
}

/**
 * The controls that actually run something under the boundary.
 *
 * Static argv assertions prove the policy was CONSTRUCTED correctly. Only these prove the kernel
 * ENFORCED it, which is the claim parity is being asked to certify.
 */
function liveControls(scratch: string): Control[] {
  const out: Control[] = [];
  const workspace = join(scratch, "workspace");
  const outside = join(scratch, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });

  const config: ContainmentConfig = { mode: "auto", writableWorkspaces: [scratch], trustedLocalOverride: false };
  const decision = planFor({ command: "/bin/sh", args: [], writableRoot: workspace, cwd: workspace }, config);

  if (!decision.allowed) {
    const why = `planFor refused its own live fixture: ${decision.denial.reason}`;
    return [
      { id: "L01", description: "a contained command can write inside its workspace", pass: false, detail: why },
      { id: "L02", description: "a contained command cannot write outside its workspace", pass: false, detail: why },
      { id: "L03", description: "a contained command cannot reach the network", pass: false, detail: why },
    ];
  }

  const run = (script: string): { status: number | null; stdout: string; stderr: string } => {
    const wrapped = wrap(decision, "/bin/sh", ["-c", script]);
    try {
      const r = spawnSync(wrapped.binary, [...wrapped.args], {
        encoding: "utf8", timeout: 20_000, stdio: [...wrapped.stdio] as never,
      });
      return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
    } finally {
      wrapped.dispose();
    }
  };

  const marker = join(workspace, "written-inside");
  const inside = run(`printf contained > ${marker}`);
  let insidePass = false;
  try {
    insidePass = inside.status === 0 && readFileSync(marker, "utf8") === "contained";
  } catch { /* insidePass stays false */ }
  out.push(control("L01", "a contained command can write inside its workspace", insidePass,
    insidePass ? undefined : `status=${inside.status} ${inside.stderr.slice(0, 120)}`));

  /*
    The control that matters.

    First prove the target directory really is writable by this uid from OUTSIDE the sandbox. Without
    that precondition, a directory that happened to be read-only would make this control pass while
    proving nothing about containment — the most dangerous kind of green.
  */
  const escape = join(outside, "written-outside");
  let hostCanWrite = false;
  try {
    writeFileSync(join(outside, "sentinel"), "host-writable");
    hostCanWrite = readFileSync(join(outside, "sentinel"), "utf8") === "host-writable";
  } catch { /* hostCanWrite stays false */ }

  const escaped = run(`printf escaped > ${escape} 2>/dev/null; printf done`);
  let containedTheWrite = false;
  try {
    readFileSync(escape, "utf8");
  } catch {
    containedTheWrite = true; // the file never appeared on the host — the write was contained
  }
  out.push(control("L02", "a contained command cannot write outside its workspace",
    hostCanWrite && containedTheWrite,
    !hostCanWrite
      ? `precondition failed: ${outside} is not writable from the host, so this control proves nothing`
      : (containedTheWrite ? undefined : `a write to ${escape} reached the host (status=${escaped.status})`)));

  /*
    Network denial. The policy carries no `--share-net`, so the sandbox holds an unshared network
    namespace -- and it masks /run, without which a unix socket to the host resolver answers anyway.

    The probe asks for BOTH address families deliberately. An earlier version asked `getent ahostsv4`
    and reported BLOCKED while the host resolver was in fact reachable over /run and answering with
    an IPv6 address. A probe narrower than the hole is worse than no probe: it certifies.

    The probe reports BLOCKED or REACHED on stdout and always exits 0, so "the probe did not run"
    is distinguishable from "the probe ran and the network was reachable". Treating a crashed probe
    as a pass is exactly how a containment suite comes to certify nothing.
  */
  const net = run(`if getent ahosts example.com >/dev/null 2>&1; then echo REACHED; else echo BLOCKED; fi`);
  const netRan = net.status === 0 && (net.stdout === "REACHED" || net.stdout === "BLOCKED");
  out.push(control("L03", "a contained command cannot reach the network",
    netRan && net.stdout === "BLOCKED",
    netRan
      ? (net.stdout === "BLOCKED" ? undefined : "name resolution succeeded inside the sandbox")
      : `the probe did not run: status=${net.status} stdout=${JSON.stringify(net.stdout)} ${net.stderr.slice(0, 100)}`));

  /*
    L04 -- the finding this filter closes.

    A unix socket is a filesystem object, so no amount of mount masking can guarantee the absence of
    one; the syscall filter refuses the address family instead. The probe asks for a socket rather
    than for a particular path, because creating one is the capability, and every reachable host
    socket needs it first.
  */
  const socketProbe = `
    import net from 'node:net';
    try { const s = new net.Socket(); s.connect('/nonexistent.sock');
      s.on('error', (e) => { console.log(e.code === 'EACCES' || e.code === 'EAFNOSUPPORT' ? 'DENIED' : 'CREATED:' + e.code); process.exit(0); });
    } catch (e) { console.log('DENIED'); process.exit(0); }
  `;
  const socketScript = join(workspace, "af-unix-probe.mjs");
  writeFileSync(socketScript, socketProbe);
  const socketDecision = planFor(
    { command: process.execPath, args: [socketScript], writableRoot: workspace, cwd: workspace, tempRoot: workspace },
    config);
  if (!socketDecision.allowed) {
    out.push(control("L04", "a contained command cannot create a unix socket", false,
      `planFor refused its own probe: ${socketDecision.denial.reason}`));
    return out;
  }
  const socketWrapped = wrap(socketDecision, process.execPath, [socketScript]);
  let socketOut = "";
  let socketStatus: number | null = null;
  try {
    const r = spawnSync(socketWrapped.binary, [...socketWrapped.args], {
      encoding: "utf8", timeout: 25_000, stdio: [...socketWrapped.stdio] as never,
    });
    socketOut = (r.stdout ?? "").trim();
    socketStatus = r.status;
  } finally {
    socketWrapped.dispose();
  }
  out.push(control("L04", "a contained command cannot create a unix socket", socketOut === "DENIED",
    socketOut === "DENIED" ? undefined : `status=${socketStatus} stdout=${JSON.stringify(socketOut)}`));

  return out;
}
