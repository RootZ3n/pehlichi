/**
 * THE EVENT STREAM — the foundational piece.
 *
 * This is what a future TUI renders AND what future lab-context (ikbi, step 4)
 * consumes. It is therefore the contract everything else serves. Events carry
 * structured data only; presentation (emoji, layout, colour) is the renderer's
 * job, never the agent's.
 */

/** Narration phase — the shape of a reasoning beat. */
export type Phase = "investigate" | "act" | "verify" | "other";

/** Every event carries a monotonic sequence number and a timestamp. */
export interface EventMeta {
  readonly ts: number;
  readonly seq: number;
}

/** An event before the emitter stamps it with {ts, seq}. */
export type AgentEventInput =
  | {
      kind: "session-start";
      profile: { name: string; role: string };
      task: string;
      workspaceRoot: string;
    }
  | { kind: "narrate"; phase: Phase; text: string }
  | { kind: "root-cause"; text: string }
  | { kind: "tool-call"; tool: string; args: unknown }
  | { kind: "tool-result"; tool: string; ok: boolean; output: string; error?: string }
  | {
      // The audit surface for every executed terminal command. Carries env
      // allowlist KEYS only — never values — so secrets can never leak here.
      kind: "terminal-receipt";
      command: string;
      cwd: string;
      envKeys: string[];
      exitCode: number;
      durationMs: number;
      stdoutBytes: number;
      stderrBytes: number;
      truncated: boolean;
    }
  | { kind: "diff"; path: string; before: string | null; after: string }
  | { kind: "skill-created"; name: string; type: string }
  // The model emitted a tool call as prose; it did NOT execute. The loop fed
  // back a correction telling it to use the function-call API. Audit surface
  // proving the call neither vanished silently nor ran.
  | { kind: "textual-call-detected"; offendingText: string }
  | {
      // Generic bridge receipt — any bridge's operation audit. The bridge field
      // names WHICH bridge (e.g. "comfyui") as data, not as a hardcoded kind.
      // Core stays bridge-agnostic; the consumer wires the bridge's onReceipt
      // through an adapter that emits this event.
      kind: "bridge-receipt";
      bridge: string;
      op: string;
      detail: Record<string, unknown>;
    }
  | { kind: "summary"; rootCause: string; changes: string[]; verification: string[] }
  | { kind: "done" }
  | { kind: "error"; where: string; message: string };

/** A stamped event — what sinks receive. */
export type AgentEvent = AgentEventInput & EventMeta;

/** A consumer of the stream. Two named future consumers justify pub/sub: TUI + lab-context. */
export type EventSink = (e: AgentEvent) => void;

/**
 * Minimal pub/sub emitter. Holds a list of sinks, stamps each event with a
 * monotonic seq + a timestamp, and fans out. Deliberately not a fancy bus.
 */
export class EventEmitter {
  private seq = 0;
  private readonly sinks: EventSink[];
  private readonly clock: () => number;

  constructor(sinks: readonly EventSink[] = [], clock: () => number = Date.now) {
    this.sinks = [...sinks];
    this.clock = clock;
  }

  /** Register an additional sink (e.g. the TUI attaching at runtime). */
  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  /** Stamp and fan out an event; returns the stamped event. */
  emit(input: AgentEventInput): AgentEvent {
    const e = { ...input, ts: this.clock(), seq: this.seq++ } as AgentEvent;
    for (const sink of this.sinks) sink(e);
    return e;
  }
}
