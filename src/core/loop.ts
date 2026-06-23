/**
 * THE CORE LOOP — driver-agnostic.
 *
 * Depends only on the Driver interface, the tool registry, and the event
 * emitter. The scripted driver and the real MiMo driver are interchangeable.
 */
import { resolve } from "node:path";

import { createStore, type ModuleMeta, type Store } from "lab-store";
import { createMemoryStore, type MemoryStore } from "lab-memory";

import { READ_ONLY_TOOLS } from "./approval-policy.js";
import { loadLatestCheckpoint, saveCheckpoint } from "./checkpoint.js";
import { isUsageReportingDriver, type Driver, type Message } from "./driver.js";
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
import { RepetitionDetector, resolveToolBudget, type BudgetTier } from "./agent-tools/tool-governor.js";
import { ContextCompressor } from "./context-compressor.js";
import { ReceiptStore } from "./receipt-store.js";
import { TokenMonitor, IterationBudget } from "./agent-tools/infrastructure.js";
import {
  unattendedToolDenyReason,
  assertUnattendedStartup,
  type UnattendedToolContext,
} from "./agent-tools/unattended.js";

// Runaway guard default. Deliberately MODEST: a direct/library run never silently grinds through
// dozens of iterations. Eight is enough for real work; a trusted operator can raise it explicitly
// via opts.maxIterations (e.g. the server assigns a higher budget for an escalated mutation/delegation
// task), or re-submit if more is genuinely needed. Twenty iterations on a "hi" message is absurd —
// the model just grinds tools until its budget is exhausted.
const DEFAULT_MAX_ITERATIONS = 8;

/**
 * Default approval when NO approvalCallback is wired (direct/library use). It auto-approves only
 * the small, explicit read-only set and DENIES every mutating tool. Direct callers MUST pass an
 * explicit approvalCallback to run mutating tools — the library never default-approves mutation.
 * (Server flows always pass defaultApprovalPolicy, so this only governs direct library callers.)
 */
const defaultLibraryApproval: ApprovalCallback = ({ tool }) =>
  READ_ONLY_TOOLS.has(tool)
    ? { approved: true }
    : {
        approved: false,
        reason:
          `mutating tool "${tool}" denied by default: direct/library use requires an explicit ` +
          `approvalCallback to authorize mutating tools (read-only tools run without one)`,
      };

export interface RunAgentOptions {
  readonly profile: AgentProfile;
  readonly task: string;
  readonly workspaceRoot: string;
  /** Where the lab-store lives. Configurable so tests point at tmp fixtures. */
  readonly labStoreRoot: string;
  readonly driver: Driver;
  readonly sinks?: readonly EventSink[];
  /** Runaway guard. Default 50. */
  readonly maxIterations?: number;
  /**
   * Per-tier tool budget (Phase 7). When set and `maxIterations` is not explicitly
   * given, the loop derives its iteration cap from the tier:
   * converse=4, readonly=12, mutation=12, escalation up to 20 (with a reason). A
   * casual prompt thus cannot spin a long tool loop.
   */
  readonly budgetTier?: BudgetTier;
  /** Justification + requested ceiling for an escalation budget tier. */
  readonly budgetEscalation?: { readonly requested: number; readonly reason?: string };
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
  /**
   * CHECKPOINTING (opt-in): when set, the loop saves a JSON snapshot of the running
   * conversation (messages + iteration) to this directory every `checkpointEvery`
   * iterations, keeping only the most recent few (see checkpoint.ts). Callers conventionally
   * pass `<workspaceRoot>/.checkpoints`. Unset ⇒ no checkpointing (behavior unchanged).
   */
  readonly checkpointDir?: string;
  /** Save a checkpoint every N iterations (default 5). Only used when `checkpointDir` is set. */
  readonly checkpointEvery?: number;
  /** When true (and `checkpointDir` has a checkpoint), resume from the latest checkpoint. */
  readonly resumeFromCheckpoint?: boolean;
  /** Correlation id stored in checkpoints (defaults to the task string). */
  readonly taskId?: string;
  /**
   * UNATTENDED MODE: when true, enforces a strict deny-by-default tool policy.
   * Only tools in the unattended allowlist (plus any `unattendedGrantedTools`) are
   * permitted. Shell metacharacters are blocked; secret files cannot be read.
   * The unattended startup guard is also applied (AGENT_FS_UNRESTRICTED must not be true).
   */
  readonly unattended?: boolean;
  /** Additional tools granted in unattended mode beyond the default allowlist. */
  readonly unattendedGrantedTools?: ReadonlySet<string>;
  /**
   * CONTEXT COMPRESSION: the context window size in tokens. When the conversation
   * approaches this limit, the context compressor summarizes middle turns. Typical
   * values: 128000 (MiMo-v2.5), 32768 (smaller models). Unset ⇒ no compression.
   */
  readonly contextWindow?: number;
  /**
   * PARTIAL RESULTS (opt-in): when true, exhausting the iteration budget RETURNS a
   * partial result ({ ok:false, partial:true, accomplished, output }) instead of
   * throwing. Unset/false ⇒ exhaustion throws "exceeded max iterations" exactly as
   * before, so the proven runaway-guard contract is unchanged for callers that do
   * not opt in.
   */
  readonly partialOnExhaustion?: boolean;
  /**
   * PLANNING (default ON; pass `false` to disable): when enabled, the run is asked
   * up front to lay out a numbered plan. The first numbered list the model narrates
   * is captured as the plan, progress is advanced as tool calls succeed, and the
   * plan/progress are surfaced back into the transcript and in the returned result.
   * Enabling adds only transcript messages (no extra driver turns, no new event
   * kinds), so a run with a scripted/sequenced driver behaves identically.
   */
  readonly plan?: boolean;
  /**
   * APPROVAL GATE (opt-in): called BEFORE each tool handler runs. Returning
   * `{ approved:false }` refuses the call — the handler NEVER executes and the loop
   * feeds back `{ ok:false, error:"tool not approved: <reason>" }` exactly like any
   * other tool failure, so the model grounds its next turn on the rejection. Unset =>
   * every tool is approved (backward compatible). Production wires a callback that
   * auto-approves read-only tools and gates write/destructive ones. The check runs
   * AFTER the registry/lane lookup, so an unknown or out-of-lane tool is reported as
   * such (it never reaches the approval gate or a handler).
   */
  readonly approvalCallback?: ApprovalCallback;
  /**
   * CONVERSATION SEEDING (opt-in): prior turns inserted between the system prompt and
   * this run's task, so an HTTP chat server can preserve context across requests by
   * threading the accumulated transcript through successive `runAgent` calls. Unset =>
   * the transcript is exactly [system, task(, plan)] as before. Checkpoint resume still
   * takes precedence: a resumed run REPLACES the whole transcript with the saved one.
   */
  readonly priorMessages?: readonly Message[];
}

/** A request to approve (or refuse) a single tool call, handed to an ApprovalCallback. */
export interface ToolApprovalRequest {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly ctx: ToolContext;
}

/** The verdict an ApprovalCallback returns for one tool call. */
export interface ToolApprovalDecision {
  readonly approved: boolean;
  /** Human-readable reason surfaced in the refusal error when `approved` is false. */
  readonly reason?: string;
}

/**
 * The approval gate seam. Sync or async. The core knows "a run MAY gate tool calls,"
 * never WHICH policy — the concrete policy is supplied as run config, mirroring how
 * the tool allowlist and memory wiring are run config.
 */
export type ApprovalCallback = (req: ToolApprovalRequest) => ToolApprovalDecision | Promise<ToolApprovalDecision>;

/** What a finished (or budget-exhausted) run reports back to its caller. */
export interface RunAgentResult {
  /** True when the run reached `done`; false when the budget was exhausted (partial). */
  readonly ok: boolean;
  /** True iff the run ended by exhausting its iteration budget (only with `partialOnExhaustion`). */
  readonly partial?: boolean;
  /** One human-readable entry per successful tool call, in order. */
  readonly accomplished?: readonly string[];
  /** Closing message: the summary root cause on `done`, or the budget-exhausted notice. */
  readonly output?: string;
  /** The numbered plan captured at the start (when planning is enabled) and how many steps completed. */
  readonly plan?: { readonly steps: readonly string[]; readonly progress: number };
  /** Token usage accumulated during this run (from the driver's drainUsage). */
  readonly tokenUsage?: { readonly totalInput: number; readonly totalOutput: number; readonly totalCached: number; readonly callCount: number };
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

/**
 * Run one agent session to completion (`done`) or failure. Returns a result
 * describing how it ended. On a budget-exhausted run it either returns a partial
 * result (when `partialOnExhaustion` is set) or throws (the default, unchanged).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const clock = opts.clock ?? Date.now;
  const emitter = new EventEmitter(opts.sinks ?? [], clock);
  // Per-tier budget (Phase 7): an explicit maxIterations always wins; otherwise a
  // budgetTier derives the cap (converse=4 keeps casual prompts out of long loops).
  const maxIterations =
    opts.maxIterations ??
    (opts.budgetTier !== undefined
      ? resolveToolBudget({ tier: opts.budgetTier, ...(opts.budgetEscalation !== undefined ? { escalate: opts.budgetEscalation } : {}) }).max
      : DEFAULT_MAX_ITERATIONS);
  const workspaceRoot = resolve(opts.workspaceRoot);
  const store = opts.store ?? createStore({ root: opts.labStoreRoot });
  // Seam A: a memory store only when the run wires one (injected or by root).
  const memoryStore =
    opts.memoryStore ?? (opts.memoryStoreRoot !== undefined ? createMemoryStore({ root: opts.memoryStoreRoot }) : undefined);

  // Infrastructure: context compression, receipt tracking, token monitoring
  const compressor = new ContextCompressor();
  const receiptStore = new ReceiptStore();
  const tokenMonitor = new TokenMonitor({ model: "mimo-v2.5" });

  // Unattended mode: assert startup guards before proceeding
  if (opts.unattended === true) {
    assertUnattendedStartup();
  }

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
    receiptStore,
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
  const messages: Message[] = [{ role: "system", content: systemPrompt }];
  // CONVERSATION SEEDING: prior turns ride between the system prompt and the new
  // task so a chat server can preserve context across requests. Empty/unset => the
  // transcript is exactly [system, task] as before.
  if (opts.priorMessages !== undefined && opts.priorMessages.length > 0) {
    messages.push(...opts.priorMessages);
  }
  messages.push({ role: "user", content: opts.task });

  // PLANNING (item 4): ask for a numbered plan up front. Default ON; opts.plan===false
  // disables. Enabling only appends transcript messages, so a scripted-driver run's
  // action sequence and event stream are unchanged.
  const planningEnabled = opts.plan !== false;
  if (planningEnabled) {
    messages.push({ role: "user", content: PLAN_INSTRUCTION });
  }
  const planSteps: string[] = [];
  let planProgress = 0;

  // CHECKPOINTING (item 2): config + opt-in resume. Resuming REPLACES the fresh
  // transcript with the saved one and continues from the saved iteration.
  const checkpointEvery = opts.checkpointEvery ?? 5;
  const taskId = opts.taskId ?? opts.task;
  let startIteration = 0;
  if (opts.checkpointDir !== undefined && opts.resumeFromCheckpoint === true) {
    const cp = loadLatestCheckpoint(opts.checkpointDir);
    if (cp !== undefined) {
      messages.length = 0;
      messages.push(...cp.messages);
      startIteration = cp.iteration;
    }
  }

  // Iteration budget: formal budget tracker, initialized after checkpoint resume
  // so startIteration is known. Accounts for resumed iterations.
  const iterationBudget = new IterationBudget(maxIterations);
  for (let j = 0; j < startIteration; j++) iterationBudget.consume();

  // PARTIAL RESULTS (item 3): every successful tool call appends an accomplishment.
  const accomplished: string[] = [];
  const planResult = () => (planningEnabled && planSteps.length > 0 ? { plan: { steps: planSteps, progress: planProgress } } : {});
  const tokenResult = () => ({ tokenUsage: tokenMonitor.summary() });

  // BUDGET GOVERNOR: track consecutive tool failures to detect stuck loops.
  // After N failures of the same tool, inject a stop directive.
  // After M total consecutive failures, force-exit with partial.
  let consecutiveFailures = 0;
  let lastFailedTool = "";
  let sameToolFailures = 0;
  const SAME_TOOL_STOP_THRESHOLD = 2;   // same tool failing 2x → inject stop
  const TOTAL_FAIL_STOP_THRESHOLD = 3;  // any 3 consecutive failures → force exit
  // Phase 7: repeated same-args / no-progress / stuck-delegation detection. Tools whose
  // name contains "delegate" are treated as delegation calls — repeated failure is a HARD
  // stop (a human should review rather than letting Pehlichi hammer the delegate target).
  const repetition = new RepetitionDetector();
  let repetitionStopInjected = false;

  for (let i = startIteration; ; i++) {
    if (!iterationBudget.consume()) {
      const budgetStatus = iterationBudget.status();
      const message = `exceeded max iterations (${budgetStatus.max})`;
      // Opt-in: return a partial result describing what was accomplished instead of
      // throwing. Default (unset) preserves the proven fail-loud runaway guard.
      if (opts.partialOnExhaustion === true) {
        const output = `Budget exhausted after ${i} steps. Completed: ${accomplished.length > 0 ? accomplished.join("; ") : "nothing"}`;
        emitter.emit({ kind: "narrate", phase: "other", text: output });
        return { ok: false, partial: true, accomplished, output, ...planResult(), ...tokenResult() };
      }
      emitter.emit({ kind: "error", where: "loop", message });
      throw new Error(message);
    }

    // Context compression: compact messages when approaching context window limit
    if (opts.contextWindow !== undefined && compressor.shouldCompress(messages, opts.contextWindow)) {
      const compResult = await compressor.compress(messages);
      if (compResult.compressed) {
        messages.length = 0;
        messages.push(...(compResult.messages as Message[]));
        emitter.emit({ kind: "narrate", phase: "other", text: `[context] compacted ${compResult.originalCount} → ${compResult.compressedCount} messages (${compResult.strategyUsed})` });
      }
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

    // Token monitoring: record usage if the driver supports it
    if (isUsageReportingDriver(opts.driver)) {
      for (const usage of opts.driver.drainUsage()) {
        tokenMonitor.recordUsage(usage);
      }
    }

    switch (action.kind) {
      case "narrate": {
        emitter.emit({ kind: "narrate", phase: action.phase, text: action.text });
        messages.push({ role: "assistant", content: `[${action.phase}] ${action.text}` });
        // PLANNING: the first numbered list the model narrates becomes the plan.
        if (planningEnabled && planSteps.length === 0) {
          const parsed = parsePlan(action.text);
          if (parsed.length > 0) {
            planSteps.push(...parsed);
            messages.push({ role: "user", content: `[plan] recorded ${planSteps.length} steps; progress will be tracked.` });
          }
        }
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
          // APPROVAL GATE: a known, in-lane tool still passes the approval policy
          // (when one is wired) BEFORE its handler runs. A refusal short-circuits to
          // a failure result; the handler is never invoked. Unset callback => approve.
          // Unattended mode: strict deny-by-default gate runs BEFORE regular approval.
          const decision = await (async () => {
            if (opts.unattended === true) {
              const unattCtx: UnattendedToolContext = opts.unattendedGrantedTools !== undefined
                ? { grantedTools: opts.unattendedGrantedTools }
                : {};
              const denyReason = unattendedToolDenyReason(action.tool, unattCtx);
              if (denyReason !== null) return { approved: false as const, reason: denyReason };
            }
            return opts.approvalCallback
              ? opts.approvalCallback({ tool: action.tool, args: action.args, ctx })
              : defaultLibraryApproval({ tool: action.tool, args: action.args, ctx });
          })();
          if (!decision.approved) {
            result = {
              ok: false,
              output: "",
              error: `tool not approved: ${decision.reason ?? "rejected by approval policy"}`,
            };
          } else {
            try {
              result = await def.handler(action.args, ctx);
            } catch (err) {
              result = { ok: false, output: "", error: messageOf(err) };
            }
          }
        }

        emitter.emit({
          kind: "tool-result",
          tool: action.tool,
          ok: result.ok,
          output: result.output,
          ...(result.error !== undefined ? { error: result.error } : {}),
        });
        // Receipt store: record audit trail for every tool call
        receiptStore.record({
          agent: opts.profile.name,
          status: result.ok ? "success" : "failed",
          toolCallCount: 1,
          contentSummary: `${action.tool}: ${firstLine(result.output) || (result.ok ? "ok" : (result.error ?? "error"))}`,
          ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
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

        // REPETITION / NO-PROGRESS GOVERNOR (Phase 7): detect same-tool+same-args
        // loops, repeated no-evidence reads, and stuck delegations. A hard stop
        // (repeated delegation failure) forces a partial exit for human review; a
        // soft stop injects a single directive to finish without more tools.
        const isDelegation = /delegate/i.test(action.tool);
        const verdict = repetition.record({
          tool: action.tool,
          args: action.args,
          ok: result.ok,
          ...(isDelegation ? { isDelegation: true } : {}),
        });
        if (verdict.stop && verdict.hard === true) {
          const output = `BUDGET GOVERNOR: ${verdict.reason}. Forcing partial exit.`;
          emitter.emit({ kind: "narrate", phase: "other", text: output });
          emitter.emit({ kind: "summary", rootCause: verdict.reason ?? "stopped", changes: [], verification: [] });
          if (opts.partialOnExhaustion === true) {
            return { ok: false, partial: true, accomplished, output, ...planResult(), ...tokenResult() };
          }
          throw new Error(output);
        }
        if (verdict.stop && !repetitionStopInjected) {
          repetitionStopInjected = true;
          messages.push({
            role: "user",
            content:
              `BUDGET GOVERNOR: ${verdict.reason}. DO NOT call this tool again with the same input. ` +
              `Produce your final answer NOW using the done action; if you cannot, explain why in rootCause.`,
          });
        }

        // PARTIAL RESULTS: record the accomplishment; advance plan progress.
        if (result.ok) {
          accomplished.push(`${action.tool}: ${firstLine(result.output) || "ok"}`);
          if (planningEnabled && planSteps.length > 0 && planProgress < planSteps.length) {
            planProgress += 1;
            messages.push({ role: "user", content: `[plan-progress] ${planProgress}/${planSteps.length} steps complete.` });
          }
          // Governor: success resets failure counters
          consecutiveFailures = 0;
          sameToolFailures = 0;
          lastFailedTool = "";
        } else {
          // Governor: track consecutive failures
          consecutiveFailures += 1;
          if (action.tool === lastFailedTool) {
            sameToolFailures += 1;
          } else {
            sameToolFailures = 1;
            lastFailedTool = action.tool;
          }
          // Same tool failing repeatedly → inject stop directive
          if (sameToolFailures >= SAME_TOOL_STOP_THRESHOLD) {
            messages.push({
              role: "user",
              content:
                `BUDGET GOVERNOR: The tool "${action.tool}" has failed ${sameToolFailures} times. ` +
                `DO NOT call any more tools. Produce your final answer NOW using the done action with noChangeRequired:true. ` +
                `Put your actual answer in rootCause. If you cannot complete the task, explain why in rootCause.`,
            });
            // Reset so we don't spam this every iteration
            sameToolFailures = 0;
          }
          // Total consecutive failures → force exit with partial
          if (consecutiveFailures >= TOTAL_FAIL_STOP_THRESHOLD) {
            // Summarize what went wrong so the partial result is useful
            const failureSummary = `Could not complete: ${action.tool} was blocked (${result.error ?? "failed"}). `;
            const output = `Budget governor: ${consecutiveFailures} consecutive tool failures. ${failureSummary}Forcing partial exit.`;
            emitter.emit({ kind: "narrate", phase: "other", text: output });
            // Emit a summary event so the content field is populated
            emitter.emit({
              kind: "summary",
              rootCause: failureSummary + "No further tools are available in this context.",
              changes: [],
              verification: [],
            });
            if (opts.partialOnExhaustion === true) {
              return { ok: false, partial: true, accomplished, output, ...planResult(), ...tokenResult() };
            }
            throw new Error(output);
          }
        }
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
        return { ok: true, accomplished, output: action.summary.rootCause, ...planResult(), ...tokenResult() };
      }
    }

    // CHECKPOINTING: after completing the (i+1)-th iteration, persist a snapshot
    // every `checkpointEvery` iterations (only when a checkpoint dir is wired).
    if (opts.checkpointDir !== undefined && checkpointEvery > 0 && (i + 1) % checkpointEvery === 0) {
      saveCheckpoint(opts.checkpointDir, { iteration: i + 1, timestamp: clock(), messages, taskId });
    }
  }
}

/**
 * Structural enforcement of the closing-summary behavior: a `done` without a
 * real summary (rootCause set, changes[] + verification[] non-empty arrays) is
 * an error, not a quiet exit.
 *
 * READ-ONLY ESCAPE HATCH: when `noChangeRequired` is true, both the changes[]
 * and verification[] checks are relaxed — a purely conversational response
 * (answering a question, no tools invoked) legitimately has neither.
 * rootCause is STILL required: the agent must say what it concluded.
 */
function validateSummary(
  summary: { rootCause: string; changes: string[]; verification: string[]; noChangeRequired?: boolean },
  emitter: EventEmitter,
): void {
  const problems: string[] = [];
  if (typeof summary.rootCause !== "string" || summary.rootCause.trim() === "") {
    problems.push("rootCause is empty");
  }
  if (summary.noChangeRequired !== true && (!Array.isArray(summary.changes) || summary.changes.length === 0)) {
    problems.push("changes[] is empty");
  }
  if (summary.noChangeRequired !== true && (!Array.isArray(summary.verification) || summary.verification.length === 0)) {
    problems.push("verification[] is empty");
  }
  if (problems.length > 0) {
    const message = `done rejected — invalid summary: ${problems.join("; ")}`;
    emitter.emit({ kind: "error", where: "done", message });
    throw new Error(message);
  }
}

/** The up-front planning request appended to the transcript when planning is enabled. */
const PLAN_INSTRUCTION =
  "Before acting, lay out a brief numbered plan (1., 2., 3., ...) of the steps you will take to " +
  "accomplish the task. Then proceed, executing each step in order.";

/** Extract a numbered plan from narration: lines like "1. do x" / "2) do y". */
function parsePlan(text: string): string[] {
  const steps: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\d+[.)]\s+(.+?)\s*$/);
    if (m && m[1] !== undefined) steps.push(m[1]);
  }
  return steps;
}

/** First non-empty line of a string, trimmed (for compact accomplishment entries). */
function firstLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return "";
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
