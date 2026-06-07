/**
 * The one shipped sink: a plain stdout debug sink. Human-readable lines, NO
 * emoji or box art — presentation is the renderer's job (TUI), not the agent's.
 * This exists so the loop is watchable end-to-end during development.
 */
import type { AgentEvent, EventSink } from "../events.js";

/** Build a sink that writes one line per event via `out` (default: stdout). */
export function createStdoutSink(out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): EventSink {
  return (e) => out(formatEvent(e));
}

/** Format a single event as one plain line. */
export function formatEvent(e: AgentEvent): string {
  const head = `#${String(e.seq).padStart(3, "0")} ${e.kind}`;
  switch (e.kind) {
    case "session-start":
      return `${head}: ${e.profile.name}/${e.profile.role} task=${JSON.stringify(e.task)} ws=${e.workspaceRoot}`;
    case "narrate":
      return `${head} (${e.phase}): ${e.text}`;
    case "root-cause":
      return `${head}: ${e.text}`;
    case "tool-call":
      return `${head}: ${e.tool} ${JSON.stringify(e.args)}`;
    case "tool-result":
      return `${head}: ${e.tool} ok=${e.ok}${e.error ? ` error=${e.error}` : ""} | ${oneLine(e.output)}`;
    case "terminal-receipt":
      return `${head}: ${JSON.stringify(e.command)} cwd=${e.cwd} env=[${e.envKeys.join(",")}] exit=${e.exitCode} ${e.durationMs}ms out=${e.stdoutBytes}b err=${e.stderrBytes}b${e.truncated ? " [truncated]" : ""}`;
    case "diff":
      return `${head}: ${e.path} (${e.before === null ? "new" : `${e.before.length}b`} -> ${e.after.length}b)`;
    case "skill-created":
      return `${head}: ${e.name} (${e.type})`;
    case "textual-call-detected":
      return `${head}: NOT executed (prose tool-call) | ${oneLine(e.offendingText)}`;
    case "bridge-receipt":
      return `${head}: ${e.bridge}/${e.op} ${oneLine(JSON.stringify(e.detail))}`;
    case "summary":
      return `${head}: rootCause=${JSON.stringify(e.rootCause)} changes=${e.changes.length} verification=${e.verification.length}`;
    case "done":
      return head;
    case "error":
      return `${head}: [${e.where}] ${e.message}`;
  }
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}
