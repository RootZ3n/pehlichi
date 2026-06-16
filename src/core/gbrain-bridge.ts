/**
 * GBRAIN BRIDGE — Pehlichi's intelligence layer over the personal knowledge brain.
 *
 * gbrain (https://… / ~/Code/gbrain) is a local-first PGLite knowledge brain with
 * keyword + hybrid + multi-hop synthesis search and an ollama:nomic-embed-text
 * embedder ($0). Pehlichi already curates memory as frontmatter+markdown (lab-memory,
 * MEMORY.md/USER.md). This bridge gives the agent READ intelligence over the brain
 * (search / think) and WRITE-back (put / sync) WITHOUT duplicating or replacing the
 * existing memory stores — it shells out to the `gbrain` CLI, which owns the brain.
 *
 * Why shell out instead of linking a library: the brain is a separate tool with its
 * own runtime (bun) and lock discipline. The CLI is the stable, supported seam. Every
 * call is bounded by a 30s timeout and runs with ~/.bun/bin on PATH so `gbrain`
 * resolves regardless of the parent process's PATH.
 *
 * Failures surface as a typed `GbrainError` carrying the exit code + captured stderr,
 * so callers (the brain_* tools) can turn a brain hiccup into a clean tool failure
 * rather than an unhandled throw.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Hard wall-clock cap on every gbrain invocation. */
export const GBRAIN_TIMEOUT_MS = 30_000;

/** Output buffer ceiling — a runaway brain response can't exhaust memory. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** A failed gbrain CLI call. Carries the exit code and captured stderr for diagnosis. */
export class GbrainError extends Error {
  readonly args: readonly string[];
  /** Process exit status, or null when the process was killed by a signal/timeout. */
  readonly exitCode: number | null;
  /** Captured stderr (trimmed), empty when none was produced. */
  readonly stderr: string;
  /** True when the failure was the 30s timeout killing the process. */
  readonly timedOut: boolean;

  constructor(
    message: string,
    info: { args: readonly string[]; exitCode: number | null; stderr: string; timedOut: boolean },
  ) {
    super(message);
    this.name = "GbrainError";
    this.args = info.args;
    this.exitCode = info.exitCode;
    this.stderr = info.stderr;
    this.timedOut = info.timedOut;
  }
}

/**
 * Runs `gbrain <args>` and returns stdout. Optional `input` is piped to stdin (used by
 * put). Injectable so tests can drive the bridge without a real brain. Production code
 * never passes a runner — the default uses execFileSync with the 30s timeout + PATH.
 */
export type GbrainRunner = (args: readonly string[], opts?: { input?: string }) => string;

function defaultRunner(args: readonly string[], opts?: { input?: string }): string {
  const bunBin = join(homedir(), ".bun", "bin");
  const pathParts = [bunBin, process.env.PATH ?? ""].filter(Boolean);
  try {
    return execFileSync("gbrain", args as string[], {
      encoding: "utf8",
      timeout: GBRAIN_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, PATH: pathParts.join(":") },
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    });
  } catch (err) {
    // execFileSync throws an Error decorated with status/signal/stderr on non-zero exit
    // or timeout. Normalize it into a typed GbrainError so callers never see the raw
    // child_process shape.
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      signal?: string | null;
      stderr?: Buffer | string;
    };
    const stderr = (e.stderr ? e.stderr.toString() : "").trim();
    const timedOut = e.signal === "SIGTERM" && e.code === "ETIMEDOUT";
    const exitCode = typeof e.status === "number" ? e.status : null;
    const reason = timedOut
      ? `gbrain timed out after ${GBRAIN_TIMEOUT_MS}ms`
      : stderr || e.message || "gbrain invocation failed";
    throw new GbrainError(`gbrain ${args[0] ?? ""}: ${reason}`, {
      args,
      exitCode,
      stderr,
      timedOut,
    });
  }
}

/** The active runner. Swapped only in tests via `__setGbrainRunner`. */
let activeRunner: GbrainRunner = defaultRunner;

/** TEST SEAM: override the runner. Returns a restore fn. Never call in production. */
export function __setGbrainRunner(runner: GbrainRunner): () => void {
  const prev = activeRunner;
  activeRunner = runner;
  return () => {
    activeRunner = prev;
  };
}

/**
 * Parse gbrain stdout as JSON. gbrain emits JSON for its structured commands; if a
 * command returns plain text (or empty), we don't throw — we hand back a `{ raw }`
 * envelope so a non-JSON response degrades gracefully instead of crashing the tool.
 */
function parseOutput(out: string): unknown {
  const trimmed = out.trim();
  if (!trimmed) return { raw: "" };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

/**
 * Keyword/full-text search over the brain. Returns the parsed JSON result set.
 * @throws GbrainError on a non-zero exit or timeout.
 */
export function searchBrain(query: string, opts?: { limit?: number }): unknown {
  const args = ["search", query];
  if (opts?.limit !== undefined) args.push("--limit", String(opts.limit));
  return parseOutput(activeRunner(args));
}

/**
 * Multi-hop synthesis: pulls evidence across pages + takes + graph and returns a cited
 * answer with conflict/gap analysis. Returns the parsed JSON answer.
 * @throws GbrainError on a non-zero exit or timeout.
 */
export function thinkBrain(question: string): unknown {
  return parseOutput(activeRunner(["think", question]));
}

/**
 * Write/update a brain page. Content (markdown with YAML frontmatter) is piped to the
 * CLI over stdin so it isn't constrained by argv length. Returns the trimmed stdout.
 * @throws GbrainError on a non-zero exit or timeout.
 */
export function putPage(slug: string, content: string): string {
  return activeRunner(["put", slug], { input: content }).trim();
}

/**
 * Sync a memory directory INTO the brain: import the markdown tree, then (re)generate
 * embeddings so the imported pages are searchable. Two CLI calls, each bounded by the
 * 30s timeout. Returns both transcripts.
 * @throws GbrainError if either step exits non-zero or times out.
 */
export function syncMemory(memoryRoot: string): { import: string; embed: string } {
  const importOut = activeRunner(["import", memoryRoot]);
  const embedOut = activeRunner(["embed", "--all"]);
  return { import: importOut.trim(), embed: embedOut.trim() };
}
