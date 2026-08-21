/**
 * BACKGROUND PROCESS REGISTRY — owner-scoped long-running terminal children.
 *
 * Every registry belongs to one runtime/session container. Callers never receive
 * the controller: they receive a capability bound to validated session, room,
 * task, and caller identity. Knowing a process id therefore grants no authority.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_OWNER_COMPONENT_BYTES = 512;

export type ProcessStatus = "running" | "exited" | "killed" | "error";

export interface ProcessOwner {
  readonly sessionId: string;
  readonly roomKey: string;
  readonly taskId: string;
  readonly callerId: string;
}

interface BackgroundProcess {
  readonly processId: string;
  readonly owner: ProcessOwner;
  readonly ownerKey: string;
  readonly command: string;
  readonly child: ChildProcess;
  readonly startedAt: number;
  stdout: string;
  stderr: string;
  stdoutCursor: number;
  stderrCursor: number;
  status: ProcessStatus;
  exitCode: number | null;
  error?: string;
}

export interface ProcessSnapshot {
  readonly processId: string;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly error?: string;
}

export interface SpawnBackgroundOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/** Owner-bound capability consumed only by the built-in terminal/process tools. */
export interface ProcessScope {
  spawn(command: string, opts: SpawnBackgroundOptions, now: number): string;
  get(processId: string): ProcessSnapshot | undefined;
  list(): ProcessSnapshot[];
  poll(processId: string): { newStdout: string; newStderr: string } | undefined;
  kill(processId: string, signal?: NodeJS.Signals): boolean;
  write(processId: string, data: string): boolean;
  wait(processId: string, timeoutMs: number): Promise<ProcessStatus | undefined>;
  /** Kill and forget only this exact owner's processes. */
  close(): number;
}

/** Internal lifecycle boundary. It is intentionally absent from the package index. */
export interface ProcessRegistryController {
  scope(owner: ProcessOwner): ProcessScope;
  /** Session reset/eviction cleanup; unrelated sessions are untouched. */
  clearSession(sessionId: string): number;
  /** Runtime shutdown cleanup. */
  destroy(): number;
}

function validOwnerComponent(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0
      || Buffer.byteLength(value, "utf8") > MAX_OWNER_COMPONENT_BYTES
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`background process ${label} is invalid`);
  }
  return value;
}

function freezeOwner(owner: ProcessOwner): ProcessOwner {
  return Object.freeze({
    sessionId: validOwnerComponent(owner.sessionId, "session owner"),
    roomKey: validOwnerComponent(owner.roomKey, "room owner"),
    taskId: validOwnerComponent(owner.taskId, "task owner"),
    callerId: validOwnerComponent(owner.callerId, "caller owner"),
  });
}

function keyFor(owner: ProcessOwner): string {
  return JSON.stringify([owner.sessionId, owner.roomKey, owner.taskId, owner.callerId]);
}

function snapshot(process: BackgroundProcess): ProcessSnapshot {
  return Object.freeze({
    processId: process.processId,
    command: process.command,
    status: process.status,
    exitCode: process.exitCode,
    ...(process.error !== undefined ? { error: process.error } : {}),
  });
}

function appendCapped(existing: string, chunk: string): string {
  const next = existing + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_BUFFER_BYTES) return next;
  const buf = Buffer.from(next, "utf8");
  return buf.subarray(buf.byteLength - MAX_BUFFER_BYTES).toString("utf8");
}

function terminate(process: BackgroundProcess, signal: NodeJS.Signals): void {
  if (process.status !== "running") return;
  process.status = "killed";
  process.child.kill(signal);
}

/** Create one runtime-owned registry. No module-level process map exists. */
export function createProcessRegistry(): ProcessRegistryController {
  const registry = new Map<string, BackgroundProcess>();

  const removeWhere = (predicate: (process: BackgroundProcess) => boolean): number => {
    let removed = 0;
    for (const [processId, process] of registry) {
      if (!predicate(process)) continue;
      terminate(process, "SIGKILL");
      registry.delete(processId);
      removed += 1;
    }
    return removed;
  };

  return Object.freeze({
    scope(ownerInput: ProcessOwner): ProcessScope {
      const owner = freezeOwner(ownerInput);
      const ownerKey = keyFor(owner);
      const owned = (processId: string): BackgroundProcess | undefined => {
        const process = registry.get(processId);
        return process?.ownerKey === ownerKey ? process : undefined;
      };

      return Object.freeze({
        spawn(command: string, opts: SpawnBackgroundOptions, now: number) {
          const child = spawn(command, {
            shell: true,
            cwd: opts.cwd,
            env: opts.env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          const processId = `bg-${randomUUID()}`;
          const process: BackgroundProcess = {
            processId,
            owner,
            ownerKey,
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
          child.stdout?.on("data", (data: string) => { process.stdout = appendCapped(process.stdout, data); });
          child.stderr?.on("data", (data: string) => { process.stderr = appendCapped(process.stderr, data); });
          child.on("error", (error) => {
            process.status = "error";
            process.error = error instanceof Error ? error.message : String(error);
          });
          child.on("exit", (code, signal) => {
            if (process.status !== "killed") process.status = signal !== null ? "killed" : "exited";
            process.exitCode = code;
          });
          registry.set(processId, process);
          return processId;
        },

        get(processId: string) {
          const process = owned(processId);
          return process === undefined ? undefined : snapshot(process);
        },

        list() {
          return [...registry.values()].filter((process) => process.ownerKey === ownerKey).map(snapshot);
        },

        poll(processId: string) {
          const process = owned(processId);
          if (process === undefined) return undefined;
          const newStdout = process.stdout.slice(process.stdoutCursor);
          const newStderr = process.stderr.slice(process.stderrCursor);
          process.stdoutCursor = process.stdout.length;
          process.stderrCursor = process.stderr.length;
          return { newStdout, newStderr };
        },

        kill(processId: string, signal: NodeJS.Signals = "SIGTERM") {
          const process = owned(processId);
          if (process === undefined) return false;
          terminate(process, signal);
          return true;
        },

        write(processId: string, data: string) {
          const process = owned(processId);
          if (process === undefined || process.child.stdin === null || process.child.stdin.writableEnded) return false;
          process.child.stdin.write(data);
          return true;
        },

        wait(processId: string, timeoutMs: number): Promise<ProcessStatus | undefined> {
          const process = owned(processId);
          if (process === undefined) return Promise.resolve(undefined);
          if (process.status !== "running") return Promise.resolve(process.status);
          return new Promise<ProcessStatus>((resolveWait) => {
            let settled = false;
            const finish = (status: ProcessStatus) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolveWait(status);
            };
            const timer = setTimeout(() => finish(process.status), timeoutMs);
            process.child.on("exit", () => finish(process.status));
            process.child.on("error", () => finish(process.status));
          });
        },

        close() { return removeWhere((process) => process.ownerKey === ownerKey); },
      });
    },

    clearSession(sessionIdInput: string) {
      const sessionId = validOwnerComponent(sessionIdInput, "session owner");
      return removeWhere((process) => process.owner.sessionId === sessionId);
    },

    destroy() { return removeWhere(() => true); },
  });
}

/** Default direct-use capability: private state, never a shared singleton. */
export function createIsolatedProcessScope(label = "direct"): ProcessScope {
  const registry = createProcessRegistry();
  return registry.scope({
    sessionId: `${label}-${randomUUID()}`,
    roomKey: "direct",
    taskId: "direct",
    callerId: "direct",
  });
}
