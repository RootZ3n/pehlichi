/**
 * THE DRIVER SEAM.
 *
 * The core loop depends ONLY on this interface. A ScriptedDriver returns a
 * canned sequence (so the whole loop is tested with no LLM). The real MiMo
 * driver implements the same interface and drops in unchanged.
 */
import type { Phase } from "./events.js";

/** A turn in the conversation handed to the driver. */
export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

/** What a tool is, as advertised to the driver. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /**
   * JSON-Schema for the tool's arguments, advertised to a real model so it can
   * call the tool with correctly-shaped args. Optional: the scripted driver
   * ignores it; the MiMo driver maps it into the provider's function format.
   */
  readonly parameters?: Record<string, unknown>;
}

/** The decision a driver returns each step. */
export type DriverAction =
  | { kind: "narrate"; phase: Phase; text: string }
  | { kind: "root-cause"; text: string }
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "done"; summary: { rootCause: string; changes: string[]; verification: string[]; noChangeRequired?: boolean } }
  // The model wrote a tool call as prose instead of using the function-call API.
  // This NEVER executes — the loop feeds back a correction. There is no edge
  // from this action kind to tool execution (only `kind:"tool"` reaches it).
  | { kind: "textual-call-detected"; offendingText: string };

export interface DriverContext {
  readonly messages: Message[];
  readonly tools: ToolSpec[];
}

export interface Driver {
  next(ctx: DriverContext): Promise<DriverAction>;
}

/** Token usage from a single model call, in the shape TokenMonitor records. */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cached?: number;
}

/**
 * H4: an OPTIONAL capability a driver may implement to surface real token usage from
 * the model response. The core loop does not require it; consumers that want token
 * accounting (the chat session's TokenMonitor) drain accumulated usage after a run.
 * `drainUsage` returns everything recorded since the last drain and clears it.
 */
export interface UsageReportingDriver extends Driver {
  drainUsage(): TokenUsage[];
}

/** Narrow a Driver to the usage-reporting capability (duck-typed on `drainUsage`). */
export function isUsageReportingDriver(d: Driver): d is UsageReportingDriver {
  return typeof (d as Partial<UsageReportingDriver>).drainUsage === "function";
}

/**
 * Deterministic test driver: replays a canned list of actions in order.
 * Throws if asked for more actions than it was given — a runaway loop or a
 * mis-scripted scenario surfaces immediately rather than hanging.
 */
export class ScriptedDriver implements Driver {
  private i = 0;
  constructor(private readonly actions: readonly DriverAction[]) {}

  async next(): Promise<DriverAction> {
    const action = this.actions[this.i];
    if (action === undefined) {
      throw new Error(`ScriptedDriver: exhausted after ${this.actions.length} action(s)`);
    }
    this.i += 1;
    return action;
  }
}
