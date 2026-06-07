/**
 * TOOLS — real implementations. The registry maps a tool name to its handler
 * and its advertised ToolSpec.
 *
 * All file/exec tools are CONFINED to workspaceRoot via resolveInWorkspace.
 * Handlers do IO and return a structured ToolResult; the core loop owns ALL
 * event emission (tool-result, diff, skill-created) so ordering stays
 * deterministic and centralized.
 *
 * TOOL-REGISTRATION SEAM: createToolRegistry accepts optional extraTools so
 * agent repos can register their own tools (e.g. image-generation tools in a specialized agent)
 * without the core knowing them. The seam is GENERIC — the core knows "an
 * agent may contribute tools," never WHICH tools.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Store } from "lab-store";
import type { MemoryStore } from "lab-memory";

import type { ToolSpec } from "./driver.js";
import { resolveInWorkspace, ToolError } from "./workspace.js";

const DEFAULT_TERMINAL_TIMEOUT_MS = 60_000;
const MAX_SEARCH_MATCHES = 200;
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
  readonly store: Store;
  /**
   * Seam A: the lab-memory store. Optional — present only when a run wires
   * memory (memoryStoreRoot/memoryStore). The memory tools fail with a clear
   * error if it is absent; reads/skills never depend on it.
   */
  readonly memoryStore?: MemoryStore;
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
        name: "read",
        description: "Read a file in the workspace and return its contents.",
        parameters: obj({ path: { type: "string", description: "Workspace-relative file path." } }, ["path"]),
      },
      handler: readTool,
    },
    {
      spec: {
        name: "search",
        description: "Grep-style search across the workspace; returns file:line:text matches.",
        parameters: obj({ query: { type: "string", description: "Substring to search for." } }, ["query"]),
      },
      handler: searchTool,
    },
    {
      spec: {
        name: "write",
        description: "Write a file in the workspace. Emits a diff (before/after) on every write.",
        parameters: obj(
          {
            path: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Full new file contents." },
          },
          ["path", "content"],
        ),
      },
      handler: writeTool,
    },
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
          },
          ["command"],
        ),
      },
      handler: terminalTool,
    },
    {
      spec: {
        name: "skill_view",
        description: "Pull a module body from lab-store by name.",
        parameters: obj({ name: { type: "string", description: "Module name (slug)." } }, ["name"]),
      },
      handler: skillViewTool,
    },
    {
      spec: {
        name: "skill_manage_create",
        description: "Create a skill module in lab-store (self-improvement).",
        parameters: obj(
          {
            name: { type: "string", description: "New module slug (lowercase, digits, hyphens)." },
            description: { type: "string", description: "One-line description." },
            type: { type: "string", description: "Module type, e.g. 'skills'." },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
            body: { type: "string", description: "Markdown body (When to use / Steps / Pitfalls)." },
          },
          ["name", "description", "type", "body"],
        ),
      },
      handler: skillCreateTool,
    },
    // ── Seam A: lab-memory tools (role-agnostic; advertised only when memory is wired) ──
    {
      spec: {
        name: "memory_view",
        description: "Pull a memory entry's full body from lab-memory by id.",
        parameters: obj({ id: { type: "string", description: "Memory entry id (slug)." } }, ["id"]),
      },
      handler: memoryViewTool,
    },
    {
      spec: {
        name: "memory_query_current",
        description: "List the CURRENT memory entries for a project (what's true now).",
        parameters: obj({ project: { type: "string", description: "Lab project name." } }, ["project"]),
      },
      handler: memoryQueryCurrentTool,
    },
    {
      spec: {
        name: "memory_create",
        description: "Record a new current memory entry in lab-memory.",
        parameters: obj(
          {
            id: { type: "string", description: "New entry id (slug)." },
            title: { type: "string", description: "Short title." },
            description: { type: "string", description: "One-line description." },
            project: { type: "string", description: "Lab project name." },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
            body: { type: "string", description: "Markdown body (what happened / what's current)." },
          },
          ["id", "title", "description", "project", "body"],
        ),
      },
      handler: memoryCreateTool,
    },
    {
      spec: {
        name: "memory_supersede",
        description: "Replace a current memory entry with a new one (keeps exactly one current).",
        parameters: obj(
          {
            oldId: { type: "string", description: "The current entry being replaced." },
            newId: { type: "string", description: "New entry id (slug)." },
            title: { type: "string", description: "Short title." },
            description: { type: "string", description: "One-line description." },
            project: { type: "string", description: "Lab project name." },
            tags: { type: "array", items: { type: "string" }, description: "Optional tags." },
            body: { type: "string", description: "Markdown body for the new current entry." },
          },
          ["oldId", "newId", "title", "description", "project", "body"],
        ),
      },
      handler: memorySupersedeTool,
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

// ── handlers ──────────────────────────────────────────────────────────────

const readTool: ToolHandler = async (args, ctx) => {
  const abs = resolveInWorkspace(ctx.workspaceRoot, str(args, "path"));
  const contents = readFileSync(abs, "utf8");
  return { ok: true, output: contents };
};

const searchTool: ToolHandler = async (args, ctx) => {
  const query = str(args, "query");
  const root = resolve(ctx.workspaceRoot);
  const matches: string[] = [];
  for (const file of walkFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable / binary — skip
    }
    const rel = relative(root, file);
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes(query)) {
        matches.push(`${rel}:${i + 1}:${line}`);
        if (matches.length >= MAX_SEARCH_MATCHES) break;
      }
    }
    if (matches.length >= MAX_SEARCH_MATCHES) break;
  }
  return {
    ok: true,
    output: matches.length > 0 ? matches.join("\n") : `no matches for "${query}"`,
  };
};

const writeTool: ToolHandler = async (args, ctx) => {
  const rawPath = str(args, "path");
  const content = str(args, "content");
  const abs = resolveInWorkspace(ctx.workspaceRoot, rawPath);
  const rel = relative(resolve(ctx.workspaceRoot), abs);
  const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return {
    ok: true,
    output: `wrote ${rel} (${Buffer.byteLength(content, "utf8")} bytes)`,
    diff: { path: rel, before, after: content },
  };
};

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

const skillViewTool: ToolHandler = async (args, ctx) => {
  const mod = ctx.store.viewModule(str(args, "name"));
  return { ok: true, output: mod.body };
};

const skillCreateTool: ToolHandler = async (args, ctx) => {
  const tags = optStrArray(args, "tags");
  const meta = ctx.store.createModule({
    name: str(args, "name"),
    description: str(args, "description"),
    type: str(args, "type"),
    body: str(args, "body"),
    ...(tags !== undefined ? { tags } : {}),
  });
  return {
    ok: true,
    output: `created ${meta.path}`,
    skillCreated: { name: meta.name, type: meta.type },
  };
};

// ── Seam A: lab-memory handlers (wrap the lab-memory lib) ─────────────────────

const memoryViewTool: ToolHandler = async (args, ctx) => {
  const entry = requireMemory(ctx).viewMemory(str(args, "id"));
  const header = `${entry.id} — ${entry.title} (status=${entry.status} v${entry.version}, project=${entry.project})`;
  return { ok: true, output: `${header}\n\n${entry.body}` };
};

const memoryQueryCurrentTool: ToolHandler = async (args, ctx) => {
  const project = str(args, "project");
  const current = requireMemory(ctx).queryCurrent(project);
  const output =
    current.length === 0
      ? `no current memory entries for "${project}"`
      : current.map((m) => `- ${m.id} (v${m.version}): ${m.description} [${m.tags.join(", ")}]`).join("\n");
  return { ok: true, output };
};

const memoryCreateTool: ToolHandler = async (args, ctx) => {
  const tags = optStrArray(args, "tags");
  const meta = requireMemory(ctx).createMemory({
    id: str(args, "id"),
    title: str(args, "title"),
    description: str(args, "description"),
    project: str(args, "project"),
    body: str(args, "body"),
    ...(tags !== undefined ? { tags } : {}),
  });
  return { ok: true, output: `created ${meta.path} (current, v${meta.version})` };
};

const memorySupersedeTool: ToolHandler = async (args, ctx) => {
  const tags = optStrArray(args, "tags");
  const { superseded, current } = requireMemory(ctx).supersedeMemory({
    oldId: str(args, "oldId"),
    newId: str(args, "newId"),
    title: str(args, "title"),
    description: str(args, "description"),
    project: str(args, "project"),
    body: str(args, "body"),
    ...(tags !== undefined ? { tags } : {}),
  });
  return {
    ok: true,
    output: `superseded ${superseded.id} -> ${current.id} (now current: ${current.id} v${current.version})`,
  };
};

function requireMemory(ctx: ToolContext): MemoryStore {
  if (ctx.memoryStore === undefined) {
    throw new ToolError("memory tools require a memory store; this run has no memoryStoreRoot/memoryStore configured");
  }
  return ctx.memoryStore;
}

// ── terminal hardening helpers ───────────────────────────────────────────────

/**
 * Build the terminal environment FROM EMPTY. process.env is never referenced
 * here, so no inherited secret/token/API key can reach the command — the
 * absence is structural, not a deny-list. HOME and TMPDIR point at the
 * (shadow) workspace so anything the command writes to $HOME stays contained.
 */
function buildTerminalEnv(workspaceRoot: string): Record<string, string> {
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
  const outsideTokens = (command.match(/(~\/?[^\s'"|;&<>]*|\/[^\s'"|;&<>]+)/g) ?? []).filter(
    (t) => !isInside(t, workspaceRoot),
  );

  if (DESTRUCTIVE.test(command) && outsideTokens.length > 0) {
    throw new ToolError(
      `command denied (secondary guard): destructive op references a path outside the workspace: ${outsideTokens[0]}`,
    );
  }
  const redirect = command.match(/>>?\s*('|")?(~\/?[^\s'"|;&]*|\/[^\s'"|;&]+)/);
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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(join(dir, entry.name));
    } else if (entry.isFile()) {
      yield join(dir, entry.name);
    }
  }
}

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

function optStrArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ToolError(`argument '${key}' must be a string[]`);
  }
  return v;
}
