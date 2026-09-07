/**
 * TOOLS — core terminal + tool-registration seam.
 *
 * The core provides ONE built-in tool: terminal (sandboxed shell execution).
 * All other tools (file, web, browser, memory, skills, etc.) are supplied by
 * the agent-tools package via the tool-registration seam.
 *
 * TOOL-REGISTRATION SEAM: createToolRegistry accepts optional extraTools so
 * agent repos can register their own tools (e.g. image-generation tools in a
 * specialized agent) without the core knowing them. The seam is GENERIC — the
 * The core knows "an agent may contribute tools," never WHICH tools.
 * Extra tools are subject to the same toolNames gate (advertisement + execution
 * allowlist) as built-in tools, so a tool outside the run's lane can never run
 * even if the model names it directly.
 */
import { spawnSync } from "node:child_process";

import { agentContainmentConfig } from "./containment-config.js";
import { planFor } from "./containment/policy.js";
import type { ContainmentDecision } from "./containment/policy.js";
import { wrap } from "./containment/wrap.js";
import { canonical, isWithin } from "./containment/paths.js";
import { resolve } from "node:path";

import type { ToolSpec } from "./driver.js";
import { processScratchDir } from "./temp-authority.js";
import type { ReceiptStore } from "./receipt-store.js";
import {
  createIsolatedProcessScope,
  type ProcessScope,
} from "./process-registry.js";
import { ToolError } from "./workspace.js";

// Re-export ToolSpec so the agent-tools (which import ToolSpec/ToolHandler/ToolResult/ToolDef
// from this module as their single tools entrypoint) resolve it here alongside the others.
export type { ToolSpec } from "./driver.js";

const DEFAULT_TERMINAL_TIMEOUT_MS = 60_000;
/** Per-stream output cap. A runaway-output command cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Hard ceiling spawnSync will buffer before erroring — memory backstop. */
const MAX_SPAWN_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * The structured audit record for one executed terminal command. Carries env
 * allowlist KEYS only — never values — so the receipt can never leak a secret.
 */
export interface TerminalReceipt {
  readonly command: string;
  readonly cwd: string;
  readonly envKeys: string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
}

/** What a handler returns. The loop turns this into events. */
export interface ToolResult {
  readonly ok: boolean;
  readonly output: string;
  readonly error?: string;
  /** Present iff the tool wrote a file — the loop emits a diff event. */
  readonly diff?: { path: string; before: string | null; after: string };
  /** Present iff the tool created a skill — the loop emits a skill-created event. */
  readonly skillCreated?: { name: string; type: string };
  /** Present iff a terminal command executed — the loop emits a terminal-receipt event. */
  readonly receipt?: TerminalReceipt;
}

/** Everything a handler needs. */
export interface ToolContext {
  readonly workspaceRoot: string;
  readonly labStoreRoot: string;
  readonly store: any;
  readonly memoryStore?: any;
  /** Receipt store for audit trail logging (reasonix infrastructure). */
  readonly receiptStore?: ReceiptStore;
  /**
   * The delegation this run may hand to a CHILD run, already narrowed to what survived this
   * run's own authorization.
   *
   * A handler that spawns or starts a sub-agent presents this and nothing else; it is not the
   * document this run was admitted on, and there is no function reachable from a handler that
   * could mint, renew or widen one. Absent means this run may delegate nothing, and a handler
   * that tries is refused before it starts anything.
   */
  readonly delegation?: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface ToolDef {
  readonly spec: ToolSpec;
  readonly handler: ToolHandler;
}

export type ToolRegistry = ReadonlyMap<string, ToolDef>;

/**
 * Build the tool registry. Pure — no IO until a handler runs.
 *
 * TOOL-REGISTRATION SEAM: pass `extraTools` to register agent-supplied tools
 * alongside the core set. Extra tools are subject to the same toolNames gate
 * (advertisement filter) and execution allowlist as built-in tools, so an
 * agent repo can add its own tools without touching the core.
 */
export function createToolRegistry(extraTools?: readonly ToolDef[], processScope?: ProcessScope): ToolRegistry {
  // A registry without an injected session capability receives its own isolated
  // scope. Two independently constructed registries can never see one another.
  const processes = processScope ?? createIsolatedProcessScope("tool-registry");
  const obj = (
    properties: Record<string, unknown>,
    required: string[],
  ): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

  const defs: ToolDef[] = [
    {
      spec: {
        name: "terminal",
        description:
          "Run a shell command, locked to cwd=workspace, with a stripped env (allowlist only), " +
          "capped output, and a timeout. Captures stdout/stderr/exitCode and emits an audit receipt.",
        parameters: obj(
          {
            command: { type: "string", description: "Shell command to run (cwd is the workspace)." },
            timeoutMs: { type: "number", description: "Optional timeout in ms (default 60000)." },
            background: {
              type: "boolean",
              description:
                "Run the command in the background (non-blocking). Returns a session_id; drive it with the `process` tool.",
            },
          },
          ["command"],
        ),
      },
      handler: (args, ctx) => terminalTool(args, ctx, processes),
    },
    {
      spec: {
        name: "process",
        description:
          "Manage background processes started by `terminal` (background:true). Actions: " +
          "list (all sessions), poll (new output + status), wait (block until done/timeout), " +
          "kill (terminate), write (send to stdin).",
        parameters: obj(
          {
            action: { type: "string", enum: ["list", "poll", "wait", "kill", "write"], description: "What to do." },
            session_id: { type: "string", description: "Target process session id (not needed for list)." },
            data: { type: "string", description: "For write: bytes to send to the process stdin." },
            timeoutMs: { type: "number", description: "For wait: max ms to block (default 30000)." },
          },
          ["action"],
        ),
      },
      handler: (args, ctx) => processTool(args, ctx, processes),
    },
    // ── Agent-supplied tools (tool-registration seam) ──────────────────────────
    ...(extraTools ?? []),
  ];
  const registry = new Map<string, ToolDef>();
  for (const definition of defs) {
    const name = definition.spec.name;
    if (registry.has(name)) throw new Error(`duplicate registered tool name: ${name}`);
    registry.set(name, definition);
  }
  return registry;
}

/** The ToolSpec list advertised to the driver. */
export function toolSpecs(registry: ToolRegistry): ToolSpec[] {
  return [...registry.values()].map((d) => d.spec);
}

// ── terminal handler ─────────────────────────────────────────────────────────

/**
 * CONFINED terminal execution. The shell stays (real build/verify need it);
 * containment is STRUCTURAL:
 *   - cwd is LOCKED to the workspace root, read from ctx, never from args.
 *   - env is BUILT FROM EMPTY — only an explicit allowlist; process.env is
 *     never copied in, so no secret/token/API key can be present by construction.
 *   - output is CAPPED per stream so a runaway command cannot exhaust memory.
 *   - a hard TIMEOUT kills overruns and surfaces a clean error.
 *   - every executed command emits an audit receipt (loop-emitted).
 */
const terminalTool = async (args: Record<string, unknown>, ctx: ToolContext, processes: ProcessScope): Promise<ToolResult> => {
  const command = str(args, "command");
  const timeout = optInt(args, "timeoutMs") ?? DEFAULT_TERMINAL_TIMEOUT_MS;
  const cwd = resolve(ctx.workspaceRoot);

  // SECONDARY, belt-and-suspenders only — NOT the boundary. The PRIMARY
  // containment is the disposable workspace + stripped env + locked cwd. This
  // pre-exec check just rejects obvious footguns (destructive ops / output
  // redirects aimed at absolute paths outside the workspace). A rejected
  // command never executes, so it produces no receipt.
  denyOutsideWorkspace(command, cwd);

  const env = buildTerminalEnv(cwd);
  const envKeys = Object.keys(env).sort();

  // Decide BEFORE spawning, foreground or background alike. A refusal is a value carrying no
  // policy, and `wrap` throws if handed one, so there is no shape of code below this point that
  // could run the command anyway.
  const decision = containedShellPlan(cwd);
  if (!decision.allowed) {
    throw new ToolError(
      `terminal refused by containment [${decision.denial.code}]: ${decision.denial.reason}`,
    );
  }
  const contained = wrap(decision, SHELL_BINARY, ["-c", command]);

  // BACKGROUND mode (item 5): spawn async and return a session id immediately. It runs under the
  // SAME contained argv as a foreground run — a background command that escaped the boundary a
  // foreground one could not would make the boundary a matter of which flag was passed.
  if (args.background === true) {
    try {
      const sessionId = processes.spawn(
        [contained.binary, ...contained.args].join(" "), { cwd, env }, Date.now());
      return {
        ok: true,
        output: `started background process: session_id=${sessionId}\nUse the \`process\` tool (poll/wait/kill/write) to drive it.`,
      };
    } finally {
      contained.dispose();
    }
  }

  const start = Date.now();
  let res;
  try {
    res = spawnSync(contained.binary, [...contained.args], {
      cwd, // locked — non-overridable by command/args
      env: env as unknown as NodeJS.ProcessEnv, // complete env; Next requires NODE_ENV on ProcessEnv, assert through unknown (no behavior change)
      timeout,
      encoding: "utf8",
      maxBuffer: MAX_SPAWN_BUFFER_BYTES,
      // `contained.stdio` carries the AF_UNIX syscall filter on the descriptor bwrap reads it from.
      // Spawning with anything else makes bwrap refuse to start, so a mistake is loud.
      stdio: [...contained.stdio] as never,
    });
  } finally {
    contained.dispose();
  }
  const durationMs = Date.now() - start;

  const out = capBytes(res.stdout ?? "", MAX_OUTPUT_BYTES);
  /*
    A SHELL WRITE INTO A NON-ALLOCATED WORKSPACE FAILS AS `Read-only file system`, WHICH TELLS THE
    MODEL NOTHING IT CAN ACT ON.

    A deployment declares the workspace an agent works in AND, separately, the roots it may write to;
    an agent's own repository is deliberately in the first and not the second. That asymmetry is
    correct — writes there go through the governed write tools, which have their own reviewed
    boundary — but it was invisible, and a model that cannot see it retries the same redirection
    until its budget is gone. Measured in the Phase-3C campaign: one turn lost exactly that way.

    So the refusal explains itself. This adds a sentence to a failed command's output; it changes no
    policy and grants nothing.
  */
  const readOnlyWorkspace = !workspaceIsWritable(cwd);
  const wroteNothing = (res.status ?? -1) !== 0 && /Read-only file system|Permission denied/i.test(res.stderr ?? "");
  const err = capBytes(
    readOnlyWorkspace && wroteNothing
      ? `${res.stderr ?? ""}\n[this workspace is not one of the deployment's declared writable roots, ` +
        `so shell redirection cannot create files here; use the write_file or patch tool instead]`
      : (res.stderr ?? ""),
    MAX_OUTPUT_BYTES);
  const truncated = out.truncated || err.truncated;

  const timedOut = (res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  // A spawn that never started (e.g. buffer blown) has no meaningful receipt.
  if (res.error && !timedOut) {
    throw new ToolError(`command failed to start: ${res.error.message}`);
  }
  const exitCode = timedOut ? -1 : res.status ?? -1;

  const receipt: TerminalReceipt = {
    command,
    cwd,
    envKeys,
    exitCode,
    durationMs,
    stdoutBytes: out.originalBytes,
    stderrBytes: err.originalBytes,
    truncated,
  };
  const output = [`exitCode: ${exitCode}`, `stdout:\n${out.text}`, `stderr:\n${err.text}`].join("\n");

  if (timedOut) {
    return { ok: false, output, error: `command timed out after ${timeout}ms`, receipt };
  }
  return exitCode === 0
    ? { ok: true, output, receipt }
    : { ok: false, output, error: `command exited with code ${exitCode}`, receipt };
};

// ── process handler (background process management) ──────────────────────────

/**
 * Drive background processes started by `terminal` (background:true). The bound
 * capability carries authority; the process id by itself does not.
 */
const processTool = async (args: Record<string, unknown>, _ctx: ToolContext, processes: ProcessScope): Promise<ToolResult> => {
  const action = str(args, "action");

  if (action === "list") {
    const procs = processes.list();
    const lines = procs.map((p) => `${p.processId} [${p.status}${p.exitCode !== null ? ` exit=${p.exitCode}` : ""}] ${p.command}`);
    return { ok: true, output: procs.length === 0 ? "(no background processes)" : lines.join("\n") };
  }

  const sessionId = str(args, "session_id");

  switch (action) {
    case "poll": {
      const proc = processes.get(sessionId);
      const out = processes.poll(sessionId);
      if (proc === undefined || out === undefined) {
        return { ok: false, output: "", error: `unknown session: ${sessionId}` };
      }
      const parts = [`status: ${proc.status}${proc.exitCode !== null ? ` exit=${proc.exitCode}` : ""}`];
      if (out.newStdout.length > 0) parts.push(`stdout:\n${out.newStdout}`);
      if (out.newStderr.length > 0) parts.push(`stderr:\n${out.newStderr}`);
      return { ok: true, output: parts.join("\n") };
    }
    case "wait": {
      const timeout = optInt(args, "timeoutMs") ?? 30_000;
      const status = await processes.wait(sessionId, timeout);
      if (status === undefined) return { ok: false, output: "", error: `unknown session: ${sessionId}` };
      const proc = processes.get(sessionId);
      const exited = status !== "running";
      return {
        ok: exited,
        output: `status: ${status}${proc && proc.exitCode !== null ? ` exit=${proc.exitCode}` : ""}`,
        ...(exited ? {} : { error: `wait timed out after ${timeout}ms (still running)` }),
      };
    }
    case "kill": {
      const ok = processes.kill(sessionId);
      return ok
        ? { ok: true, output: `killed ${sessionId}` }
        : { ok: false, output: "", error: `unknown session: ${sessionId}` };
    }
    case "write": {
      const data = str(args, "data");
      const ok = processes.write(sessionId, data);
      return ok
        ? { ok: true, output: `wrote ${data.length} chars to ${sessionId}` }
        : { ok: false, output: "", error: `cannot write to session: ${sessionId} (unknown or stdin closed)` };
    }
    default:
      return { ok: false, output: "", error: `unknown process action: ${action}` };
  }
};

// ── terminal hardening helpers ───────────────────────────────────────────────

/**
 * Build the terminal environment FROM EMPTY. process.env is never referenced
 * here, so no inherited secret/token/API key can reach the command — the
 * absence is structural, not a deny-list. HOME and TMPDIR/TMP/TEMP point at
 * the (shadow) workspace so anything the command writes stays contained.
 */
function buildTerminalEnv(workspaceRoot: string): Record<string, string> {
  // FULL-ACCESS MODE (operator opt-in): inherit the real service environment so the
  // command sees the full PATH, the real $HOME, sudo, and any credentials — i.e. the
  // shell behaves exactly as the service user (zen, with passwordless sudo). This
  // intentionally removes the from-empty containment; the operator accepts that every
  // command can reach the whole host AND the agent's own env (API keys, tokens).
  if (process.env.AGENT_FS_UNRESTRICTED === "true") {
    const real: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") real[k] = v;
    }
    const basePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    real.PATH = real.PATH && real.PATH.length > 0 ? `${real.PATH}:${basePath}` : basePath;
    real.HOME = real.HOME && real.HOME.length > 0 ? real.HOME : "/home/zen";
    // Even full-access mode never hands a command /tmp: temp stays governed lab storage.
    const scratch = processScratchDir();
    real.TMPDIR = scratch;
    real.TMP = scratch;
    real.TEMP = scratch;
    return real;
  }
  return {
    PATH: "/usr/bin:/bin",
    HOME: workspaceRoot,
    TMPDIR: workspaceRoot,
    TMP: workspaceRoot,
    TEMP: workspaceRoot,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    SHELL: "/bin/sh",
  };
}

/** Cap a stream to `cap` bytes, appending a clear marker when truncated. */
function capBytes(s: string, cap: number): { text: string; originalBytes: number; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= cap) {
    return { text: s, originalBytes: buf.byteLength, truncated: false };
  }
  const head = buf.subarray(0, cap).toString("utf8");
  return {
    text: `${head}\n[truncated: ${buf.byteLength} bytes -> ${cap}]`,
    originalBytes: buf.byteLength,
    truncated: true,
  };
}


/*
  MODEL-CONTROLLED SHELL RUNS UNDER CONTAINMENT.

  The `terminal` tool hands a provider's chosen string to a shell. Until now the only thing between
  that string and the host was a stripped environment, a locked cwd, and a regex over destructive
  verbs — documented in this file as "SECONDARY, belt-and-suspenders only". Phase 3C measured what
  that actually permits: with an auditor-controlled local sink and a synthetic canary in a file
  outside the workspace, SIX of seven exfiltration routes succeeded — curl, cat-into-curl, relative
  traversal, read-then-post, wget, python. The positive control proved the sink reachable, so those
  were real deliveries and not a broken test.

  `lab-containment` was already vendored, pinned and parity-tested in this repository; it was simply
  never called from here. Only `execute_code` and `lab_shell` used it.

  The NARROW view is used deliberately:

    • `networkAllowed` is false unconditionally — the view forces it, whatever the command wants.
    • `denyUnixSockets` is always true, so a host service cannot be reached around the namespace.
    • only the roots named here are visible, so a read outside the workspace fails before any
      question of transmitting it arises.

  This does NOT touch the service's own provider connection. That call is made by this Node process
  with `fetch`, not by a spawned child, so denying the network to every child separates trusted
  transport from model-selected outbound access exactly as intended.

  WRITES. A write target must lie inside a workspace the deployment declared, and an agent's own
  repository deliberately is not one. So the workspace is bound writable when it is declared, and
  read-only when it is not, rather than widening the reviewed allocation to make `terminal` more
  convenient. Governed temporary space is writable either way.
*/
function workspaceIsWritable(cwd: string): boolean {
  const config = agentContainmentConfig();
  return config.writableWorkspaces.some((root) => isWithin(canonical(cwd), canonical(root)));
}

function containedShellPlan(cwd: string): ContainmentDecision {
  const config = agentContainmentConfig();
  const declared = workspaceIsWritable(cwd);
  return planFor(
    {
      command: SHELL_BINARY,
      args: [],
      view: "narrow",
      readonlyRoots: [cwd],
      ...(declared ? { writableRoot: cwd } : {}),
      cwd,
      tempRoot: processScratchDir(),
    },
    config,
  );
}

/** The one shell a contained terminal command runs under. Never taken from the environment. */
const SHELL_BINARY = "/bin/sh";

const DESTRUCTIVE = /\b(rm|rmdir|unlink|mv|dd|shred|chmod|chown|chgrp|truncate|mkfs)\b/;

/**
 * SECONDARY defense-in-depth — NOT the containment boundary (that is the
 * disposable workspace + stripped env + locked cwd). Reject a command only when
 * it (a) runs a destructive verb against an absolute/`~` path outside the
 * workspace, or (b) redirects output (> / >>) to such a path. Read-style
 * absolute paths (e.g. `< /dev/zero`) are left alone.
 */
function denyOutsideWorkspace(command: string, workspaceRoot: string): void {
  // FULL-ACCESS MODE (operator opt-in): the secondary out-of-workspace guard is off.
  // Destructive-command confirmation is handled upstream at the Matrix bridge instead.
  if (process.env.AGENT_FS_UNRESTRICTED === "true") return;
  const outsideTokens = (command.match(/(~\/?[^\s'"|;&<>]*|\/[^\s'"|;&<>]+)/g) ?? []).filter(
    (t) => !isInside(t, workspaceRoot),
  );

  if (DESTRUCTIVE.test(command) && outsideTokens.length > 0) {
    throw new ToolError(
      `command denied (secondary guard): destructive op references a path outside the workspace: ${outsideTokens[0]}`,
    );
  }
  const redirect = command.match(/>>?\s*('|\")?(~\/?[^\s'"|;&]*|\/[^\s'"|;&]+)/);
  const target = redirect?.[2];
  if (target !== undefined && !isInside(target, workspaceRoot)) {
    throw new ToolError(
      `command denied (secondary guard): output redirected to a path outside the workspace: ${target}`,
    );
  }
}

function isInside(token: string, workspaceRoot: string): boolean {
  if (token === "/dev/null") return true; // common, harmless sink
  if (token.startsWith("~")) return false; // ~ resolves to HOME=shadow, but be conservative
  return token === workspaceRoot || token.startsWith(`${workspaceRoot}/`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new ToolError(`argument '${key}' must be a string`);
  return v;
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ToolError(`argument '${key}' must be a number`);
  }
  return v;
}
