/**
 * APPROVAL POLICY (Blocker 6 / N5) — the default tool-approval gate.
 *
 * Shared by BOTH the production chat session (KernelChatSession) AND delegated
 * sub-agents (subagent-entry), so a sub-agent can never hold MORE authority than the
 * policy that spawned it. Previously a delegated sub-agent ran with no approval
 * callback at all, which the loop treats as approve-everything — full write access
 * regardless of the parent's policy. Routing both through this one policy closes that
 * escalation: a sub-agent denies writes by default, exactly like a fresh session.
 */
import type { ApprovalCallback } from "./loop.js";

/**
 * Read-only / side-effect-free tools that are auto-approved without gating. Kept
 * deliberately small and explicit — anything NOT here is treated as write/destructive.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "search_files",
  "list_files",
  "web_search",
  "web_extract",
  "memory_read",
  "memory_search",
  "lab_context_read",
  "agent_sync",
  "todo",
  "clarify",
  // gbrain bridge — read-only recall. brain_put/brain_sync are writes and stay gated.
  "brain_search",
  "brain_think",
]);

/**
 * Auto-approve read-only tools; gate write/destructive ones unless `allowWrites` is
 * set. A refused tool short-circuits to a failure result and never reaches its handler.
 */
export function defaultApprovalPolicy(opts?: { allowWrites?: boolean }): ApprovalCallback {
  const allowWrites = opts?.allowWrites === true;
  return ({ tool }) => {
    if (READ_ONLY_TOOLS.has(tool)) return { approved: true };
    if (allowWrites) return { approved: true };
    return { approved: false, reason: `write/destructive tool "${tool}" requires approval` };
  };
}
