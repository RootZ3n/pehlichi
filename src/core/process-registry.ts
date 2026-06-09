/**
 * BACKGROUND PROCESS REGISTRY — long-running children for the terminal tool.
 *
 * `spawnSync` (the foreground terminal path) blocks until the command exits, so a
 * server, watcher, or build-in-watch-mode can never be driven by the agent. This
 * registry adds the missing capability: a command launched in BACKGROUND mode is
 * spawned with async `spawn()`, tracked by a session id, and then list/poll/wait/
 * kill/write-able. Output is buffered (capped) and `poll` returns only what is NEW
 * since the last poll, so a chatty process cannot flood the model's context.
 *
 * Containment is inherited from the caller: the terminal tool passes the SAME locked
 * cwd and FROM-EMPTY env it uses for foreground commands, so a background command is
 * confined exactly like a foreground one.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Per-stream buffer cap. A runaway background process cannot exhaust memory. */
const MAX_BUFFER_BYTES = 256 * 1024;

export type ProcessStatus = "running" | "exited" | "killed" | "error";

/** One tracked background process. */
export interface BackgroundProcess {
  readonly sessionId: string;
  readonly command: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  stdout: string;
  stderr: string;
  /** How many bytes of each stream have already been returned by `poll`. */
  stdoutCursor: number;
  stderrCursor: number;
  status: ProcessStatus;
  exitCode: number | null;
  error?: string;
}

/** A point-in-time view of a process (no live child handle). */
export interface ProcessSnapshot {
  readonly sessionId: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly error?: string;
}

export interface SpawnBackgroundOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/**
 * The registry. Module-level so the `process` tool (a separate handler) can reach
 * processes started by the `terminal` tool within the same run.
 */
const registry = new Map<string, BackgroundProcess>();
let counter = 0;

/** Append to a stream buffer, capped — drops the OLDEST bytes past the cap. */
function appendCapped(existing: string, chunk: string): string {
  const next = existing + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_BUFFER_BYTES) return next;
  // Keep the tail (most recent output) — that is what poll/wait care about.
  const buf = Buffer.from(next, "utf8");
  return buf.subarray(buf.byteLength - MAX_BUFFER_BYTES).toString("utf8");
}

/** Spawn a command in the background and register it. Returns the new session id. */
export function spawnBackground(command: string, opts: SpawnBackgroundOptions, now: number): string {
  const child = spawn(command, {
    shell: true,
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sessionId = `bg-${++counter}-${child.pid ?? "nopid"}`;
  const proc: BackgroundProcess = {
    sessionId,
    command,
    child,
    startedAt: now,
    stdout: "",
    stderr: "",
    stdoutCursor: 0,
    stderrCursor: 0,
    status: "running",
    exitCode: null,
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    proc.stdout = appendCapped(proc.stdout, d);
  });
  child.stderr?.on("data", (d: string) => {
    proc.stderr = appendCapped(proc.stderr, d);
  });
  child.on("error", (err) => {
    proc.status = "error";
    proc.error = err instanceof Error ? err.message : String(err);
  });
  child.on("exit", (code, signal) => {
    // A SIGTERM/SIGKILL we issued is reported as "killed"; a natural exit as "exited".
    if (proc.status !== "killed") proc.status = signal !== null ? "killed" : "exited";
    proc.exitCode = code;
  });

  registry.set(sessionId, proc);
  return sessionId;
}

export function getProcess(sessionId: string): BackgroundProcess | undefined {
  return registry.get(sessionId);
}

/** Snapshot every tracked process (for `list`). */
export function listProcesses(): ProcessSnapshot[] {
  return [...registry.values()].map((p) => ({
    sessionId: p.sessionId,
    command: p.command,
    status: p.status,
    exitCode: p.exitCode,
    ...(p.error !== undefined ? { error: p.error } : {}),
  }));
}

/** Read NEW stdout/stderr since the last poll, advancing the cursors. */
export function pollProcess(sessionId: string): { newStdout: string; newStderr: string } | undefined {
  const p = registry.get(sessionId);
  if (p === undefined) return undefined;
  const newStdout = p.stdout.slice(p.stdoutCursor);
  const newStderr = p.stderr.slice(p.stderrCursor);
  p.stdoutCursor = p.stdout.length;
  p.stderrCursor = p.stderr.length;
  return { newStdout, newStderr };
}

/** Terminate a process. Returns false if the session is unknown. */
export function killProcess(sessionId: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const p = registry.get(sessionId);
  if (p === undefined) return false;
  if (p.status === "running") {
    p.status = "killed";
    p.child.kill(signal);
  }
  return true;
}

/** Send data to a process's stdin. Returns false if unknown or stdin is closed. */
export function writeProcess(sessionId: string, data: string): boolean {
  const p = registry.get(sessionId);
  if (p === undefined || p.child.stdin === null || p.child.stdin.writableEnded) return false;
  p.child.stdin.write(data);
  return true;
}

/** Block until the process exits or `timeoutMs` elapses. Resolves to the final status. */
export function waitProcess(sessionId: string, timeoutMs: number): Promise<ProcessStatus | undefined> {
  const p = registry.get(sessionId);
  if (p === undefined) return Promise.resolve(undefined);
  if (p.status !== "running") return Promise.resolve(p.status);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (s: ProcessStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWait(s);
    };
    const timer = setTimeout(() => finish(p.status), timeoutMs);
    p.child.on("exit", () => finish(p.status));
    p.child.on("error", () => finish(p.status));
  });
}

/** Test/lifecycle helper: kill and forget every tracked process. */
export function clearProcessRegistry(): void {
  for (const p of registry.values()) {
    if (p.status === "running") p.child.kill("SIGKILL");
  }
  registry.clear();
}
