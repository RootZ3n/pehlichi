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
import { resolve } from "node:path";

import type { ToolSpec } from "./driver.js";
import type { ReceiptStore } from "./receipt-store.js";
import {
  getProcess,
  killProcess,
  listProcesses,
  pollProcess,
  spawnBackground,
  waitProcess,
  writeProcess,
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
export function createToolRegistry(extraTools?: readonly ToolDef[]): ToolRegistry {
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
      handler: terminalTool,
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
      handler: processTool,
    },
    // ── Agent-supplied tools (tool-registration seam) ──────────────────────────
    ...(extraTools ?? []),
  ];
  return new Map(defs.map((d) => [d.spec.name, d]));
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
const terminalTool: ToolHandler = async (args, ctx) => {
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

  // BACKGROUND mode (item 5): spawn async and return a session id immediately.
  // The same locked cwd + from-empty env confine it exactly like a foreground run.
  if (args.background === true) {
    const sessionId = spawnBackground(command, { cwd, env }, Date.now());
    return {
      ok: true,
      output: `started background process: session_id=${sessionId}\nUse the \`process\` tool (poll/wait/kill/write) to drive it.`,
    };
  }

  const start = Date.now();
  const res = spawnSync(command, {
    shell: true,
    cwd, // locked — non-overridable by command/args
    env, // complete environment: spawnSync does NOT merge with process.env
    timeout,
    encoding: "utf8",
    maxBuffer: MAX_SPAWN_BUFFER_BYTES,
  });
  const durationMs = Date.now() - start;

  const out = capBytes(res.stdout ?? "", MAX_OUTPUT_BYTES);
  const err = capBytes(res.stderr ?? "", MAX_OUTPUT_BYTES);
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
 * Drive background processes started by `terminal` (background:true). Stateless
 * itself — all state lives in the process registry, so any handler invocation in
 * the same run can reach a previously started process by session id.
 */
const processTool: ToolHandler = async (args) => {
  const action = str(args, "action");

  if (action === "list") {
    const procs = listProcesses();
    const lines = procs.map((p) => `${p.sessionId} [${p.status}${p.exitCode !== null ? ` exit=${p.exitCode}` : ""}] ${p.command}`);
    return { ok: true, output: procs.length === 0 ? "(no background processes)" : lines.join("\n") };
  }

  const sessionId = str(args, "session_id");

  switch (action) {
    case "poll": {
      const proc = getProcess(sessionId);
      const out = pollProcess(sessionId);
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
      const status = await waitProcess(sessionId, timeout);
      if (status === undefined) return { ok: false, output: "", error: `unknown session: ${sessionId}` };
      const proc = getProcess(sessionId);
      const exited = status !== "running";
      return {
        ok: exited,
        output: `status: ${status}${proc && proc.exitCode !== null ? ` exit=${proc.exitCode}` : ""}`,
        ...(exited ? {} : { error: `wait timed out after ${timeout}ms (still running)` }),
      };
    }
    case "kill": {
      const ok = killProcess(sessionId);
      return ok
        ? { ok: true, output: `killed ${sessionId}` }
        : { ok: false, output: "", error: `unknown session: ${sessionId}` };
    }
    case "write": {
      const data = str(args, "data");
      const ok = writeProcess(sessionId, data);
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
 * absence is structural, not a deny-list. HOME and TMPDIR point at the
 * (shadow) workspace so anything the command writes to $HOME stays contained.
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
    delete real.TMPDIR; // use the system default (/tmp), not the workspace
    return real;
  }
  return {
    PATH: "/usr/bin:/bin",
    HOME: workspaceRoot,
    TMPDIR: workspaceRoot,
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
