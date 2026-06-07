/**
 * THE CORE LOOP — driver-agnostic.
 *
 * Depends only on the Driver interface, the tool registry, and the event
 * emitter. The scripted driver and the real MiMo driver are interchangeable.
 */
import { resolve } from "node:path";

import { createStore, type ModuleMeta, type Store } from "lab-store";
import { createMemoryStore, type MemoryStore } from "lab-memory";

import type { Driver, Message } from "./driver.js";
import { EventEmitter, type EventSink } from "./events.js";
import type { AgentProfile } from "./profile.js";
import { ShadowWorkspace } from "./shadow.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  createToolRegistry,
  toolSpecs,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "./tools.js";

const DEFAULT_MAX_ITERATIONS = 25;

export interface RunAgentOptions {
  readonly profile: AgentProfile;
  readonly task: string;
  readonly workspaceRoot: string;
  /** Where the lab-store lives. Configurable so tests point at tmp fixtures. */
  readonly labStoreRoot: string;
  readonly driver: Driver;
  readonly sinks?: readonly EventSink[];
  /** Runaway guard. Default 25. */
  readonly maxIterations?: number;
  /** Inject a store (tests); otherwise one is bound to labStoreRoot. */
  readonly store?: Store;
  /**
   * Seam A: where lab-memory lives. Optional. When set (or `memoryStore` is
   * injected), the memory tools are advertised AND executable. When unset (the
   * default when no memory is wired), memory tools are NOT advertised — the
   * prompt and the provider tool list are unchanged, so proven behavior is identical.
   */
  readonly memoryStoreRoot?: string;
  /** Inject a memory store (tests); otherwise one is bound to memoryStoreRoot when set. */
  readonly memoryStore?: MemoryStore;
  /**
   * Optional tool allowlist for this run. When UNSET, every registered tool is
   * available (the full set). When SET, ONLY these tools are advertised to the
   * driver AND executable; a call to any other tool is refused exactly like an
   * unknown tool (it never reaches a handler). This is the seam that keeps a run
   * within its lane STRUCTURALLY — by not handing it tools outside its scope —
   * WITHOUT the core hardcoding any agent's tool set. The concrete list is
   * passed in via run config, mirroring how memory wiring (memoryStoreRoot) is
   * already run config. The memory-wiring filter still applies on top: memory_*
   * require a memory store regardless of this list.
   */
  readonly toolNames?: readonly string[];
  /**
   * The ACTIVE SKILLPACK for this run: the name of a module in the store whose
   * structured frontmatter (contractAdditions / doneCriteria / evidence /
   * reportFormat / routingRoster) is injected into the system prompt. This is
   * how task/role specialization is supplied as DATA — the kernel stays generic.
   * `skillTags` still selects the candidate skills LISTED for list-then-pull;
   * `primarySkill` selects the single one that supplies the contract. Unset =>
   * generic kernel only (identical to a run with a plain, fieldless skill).
   * Fails loud if set but absent from the store (a misconfigured run).
   */
  readonly primarySkill?: string;
  /**
   * TOOL-REGISTRATION SEAM: agent-supplied tools merged into the registry
   * alongside the built-in set. The seam is GENERIC — the core knows "an agent
   * may contribute tools," never WHICH tools. Extra tools are subject to the
   * same toolNames gate (advertisement + execution allowlist) as built-in tools.
   */
  readonly extraTools?: readonly ToolDef[];
  /** Injectable clock for deterministic event timestamps. */
  readonly clock?: () => number;
}

export interface RunAgentInShadowOptions extends Omit<RunAgentOptions, "workspaceRoot"> {
  /** Optional existing content to copy INTO the fresh shadow before the run. */
  readonly seedFrom?: string;
  /** Called with the shadow root right after creation (e.g. to print a banner). */
  readonly onShadowCreated?: (root: string) => void;
}

export interface ShadowRunResult {
  /** The (now-discarded) shadow workspace path — for logging/audit only. */
  readonly shadowRoot: string;
  /** Always true: discard runs at the end of every shadow run. */
  readonly discarded: boolean;
}

/**
 * Run an agent inside a fresh disposable shadow workspace, discarding it at the
 * end ALWAYS. This is the entrypoint a real-model run must use: the REAL repo
 * path is never passed as workspaceRoot. Promotion (copying results back) is a
 * separate operator-gated step and is deliberately NOT performed here.
 */
export async function runAgentInShadow(opts: RunAgentInShadowOptions): Promise<ShadowRunResult> {
  const { seedFrom, onShadowCreated, ...rest } = opts;
  const shadow = ShadowWorkspace.create();
  onShadowCreated?.(shadow.root);
  if (seedFrom !== undefined) shadow.seed(seedFrom);
  try {
    await runAgent({ ...rest, workspaceRoot: shadow.root });
    return { shadowRoot: shadow.root, discarded: true };
  } finally {
    // ALWAYS discard — there is no promote path in the loop or the agent.
    shadow.discard();
  }
}

/** Run one agent session to completion (done) or failure (throw). */
export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const emitter = new EventEmitter(opts.sinks ?? [], opts.clock ?? Date.now);
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const workspaceRoot = resolve(opts.workspaceRoot);
  const store = opts.store ?? createStore({ root: opts.labStoreRoot });
  // Seam A: a memory store only when the run wires one (injected or by root).
  const memoryStore =
    opts.memoryStore ?? (opts.memoryStoreRoot !== undefined ? createMemoryStore({ root: opts.memoryStoreRoot }) : undefined);

  emitter.emit({
    kind: "session-start",
    profile: { name: opts.profile.name, role: opts.profile.role },
    task: opts.task,
    workspaceRoot,
  });

  const registry = createToolRegistry(opts.extraTools);
  const ctx: ToolContext = {
    workspaceRoot,
    labStoreRoot: opts.labStoreRoot,
    store,
    ...(memoryStore !== undefined ? { memoryStore } : {}),
  };

  // Advertise the memory tools ONLY when memory is wired. With no memory store
  // the advertised set — and thus the prompt and provider tool list — is exactly
  // the original tools, so a memory-unaware profile's proven behavior is
  // unchanged. The full registry still holds every tool for execution.
  //
  // Then, if this run carries a tool allowlist, narrow to it. UNSET allowlist =>
  // no narrowing => identical to before. The SAME allowlist gates EXECUTION
  // below, so a tool outside the run's lane can never run even if the model names
  // it directly. (The memory-wiring filter only affects ADVERTISEMENT — an
  // unwired memory tool still reaches its handler so it returns the precise
  // "require a memory store" error, unchanged.)
  const allow = opts.toolNames !== undefined ? new Set(opts.toolNames) : undefined;
  const specs = toolSpecs(registry)
    .filter((s) => !s.name.startsWith("memory_") || memoryStore !== undefined)
    .filter((s) => allow === undefined || allow.has(s.name));

  const modules = store.listModules();
  // The active skillpack supplies this run's contract via its structured fields.
  // Fail loud if named but missing — a misconfigured run, not a silent kernel run.
  let activeSkill: ModuleMeta | undefined;
  if (opts.primarySkill !== undefined) {
    activeSkill = modules.find((m) => m.name === opts.primarySkill);
    if (activeSkill === undefined) {
      const message = `primarySkill "${opts.primarySkill}" not found in the store`;
      emitter.emit({ kind: "error", where: "loop", message });
      throw new Error(message);
    }
  }
  const systemPrompt = buildSystemPrompt(opts.profile, modules, specs, activeSkill);
  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.task },
  ];

  for (let i = 0; ; i++) {
    if (i >= maxIterations) {
      const message = `exceeded max iterations (${maxIterations})`;
      emitter.emit({ kind: "error", where: "loop", message });
      throw new Error(message);
    }

    let action;
    try {
      action = await opts.driver.next({ messages, tools: specs });
    } catch (err) {
      // Driver failures (network / non-200 / malformed / token-cap) fail LOUD:
      // surface as an error event, then rethrow. No silent retries.
      const message = messageOf(err);
      emitter.emit({ kind: "error", where: "driver", message });
      throw err instanceof Error ? err : new Error(message);
    }

    switch (action.kind) {
      case "narrate": {
        emitter.emit({ kind: "narrate", phase: action.phase, text: action.text });
        messages.push({ role: "assistant", content: `[${action.phase}] ${action.text}` });
        break;
      }
      case "root-cause": {
        emitter.emit({ kind: "root-cause", text: action.text });
        messages.push({ role: "assistant", content: `root cause: ${action.text}` });
        break;
      }
      case "tool": {
        emitter.emit({ kind: "tool-call", tool: action.tool, args: action.args });
        messages.push({ role: "assistant", content: `call ${action.tool}(${JSON.stringify(action.args)})` });

        // A tool outside this run's allowlist is refused HERE and never reaches a
        // handler — the in-lane guarantee is structural, not prompt-dependent.
        // With no allowlist, behavior is exactly as before (registry lookup only).
        const blockedByLane = allow !== undefined && !allow.has(action.tool);
        const def = blockedByLane ? undefined : registry.get(action.tool);
        let result: ToolResult;
        if (def === undefined) {
          const reason = blockedByLane
            ? `tool not available to this run (out of lane): ${action.tool}`
            : `unknown tool: ${action.tool}`;
          result = { ok: false, output: "", error: reason };
        } else {
          try {
            result = await def.handler(action.args, ctx);
          } catch (err) {
            result = { ok: false, output: "", error: messageOf(err) };
          }
        }

        emitter.emit({
          kind: "tool-result",
          tool: action.tool,
          ok: result.ok,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        if (result.receipt) {
          emitter.emit({ kind: "terminal-receipt", ...result.receipt });
        }
        if (result.diff) {
          emitter.emit({ kind: "diff", ...result.diff });
        }
        if (result.skillCreated) {
          emitter.emit({ kind: "skill-created", ...result.skillCreated });
        }
        // Feed the ACTUAL result back into history (output/error, success, and
        // the terminal receipt summary) so the model grounds its next turn on
        // results it RECEIVED, not ones it imagines. A failure puts its failure
        // here. A call that never executed (e.g. textual-call-detected) produces
        // NO such message — the model has nothing to cite for it.
        messages.push({ role: "tool", content: toolResultForHistory(action.tool, result) });
        break;
      }
      case "textual-call-detected": {
        // The model wrote a tool call as prose. It did NOT execute (note: this
        // case NEVER touches `registry`/`def.handler` — only `case "tool"` does,
        // so there is structurally no path from prose to execution). Emit the
        // audit event and append an ACTIONABLE correction as role:"user"
        // (loop-authored feedback is actionable per the lab trust model), then
        // continue so the model retries through the real channel. This consumes
        // an iteration, so a model that NEVER uses the real channel still trips
        // the max-iter guard and fails loud rather than looping forever.
        emitter.emit({ kind: "textual-call-detected", offendingText: action.offendingText });
        messages.push({
          role: "user",
          content:
            "Your previous turn wrote a tool call as text. It did NOT execute. To run a tool you " +
            "MUST use the function/tool-call API channel, not message content. Retry the action " +
            "through the proper tool call.",
        });
        break;
      }
      case "done": {
        validateSummary(action.summary, emitter);
        emitter.emit({
          kind: "summary",
          rootCause: action.summary.rootCause,
          changes: action.summary.changes,
          verification: action.summary.verification,
        });
        emitter.emit({ kind: "done" });
        return;
      }
    }
  }
}

/**
 * Structural enforcement of the closing-summary behavior: a `done` without a
 * real summary (rootCause set, changes[] + verification[] non-empty arrays) is
 * an error, not a quiet exit.
 */
function validateSummary(
  summary: { rootCause: string; changes: string[]; verification: string[] },
  emitter: EventEmitter,
): void {
  const problems: string[] = [];
  if (typeof summary.rootCause !== "string" || summary.rootCause.trim() === "") {
    problems.push("rootCause is empty");
  }
  if (!Array.isArray(summary.changes) || summary.changes.length === 0) {
    problems.push("changes[] is empty");
  }
  if (!Array.isArray(summary.verification) || summary.verification.length === 0) {
    problems.push("verification[] is empty");
  }
  if (problems.length > 0) {
    const message = `done rejected — invalid summary: ${problems.join("; ")}`;
    emitter.emit({ kind: "error", where: "done", message });
    throw new Error(message);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Render a real tool result for the model's history — actual content, incl. failures. */
function toolResultForHistory(tool: string, result: ToolResult): string {
  const parts = [`[tool:${tool}] ${result.ok ? "ok" : `FAILED: ${result.error ?? "error"}`}`];
  if (result.receipt) {
    const r = result.receipt;
    parts.push(
      `receipt: exit=${r.exitCode} stdoutBytes=${r.stdoutBytes} stderrBytes=${r.stderrBytes} truncated=${r.truncated}`,
    );
  }
  if (result.output.length > 0) parts.push(result.output);
  return parts.join("\n");
}
