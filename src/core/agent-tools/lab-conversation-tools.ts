/**
 * LAB CONVERSATION TOOLS — the on-demand half of the "hybrid" shared-memory design.
 *
 * The agent always sees a short AMBIENT header of its teammates' recent turns (injected by
 * the server via recentCrossAgentContext). This tool is the DEEPER lookback: the agent calls
 * it when it needs more than the header — "what did Luna and I decide about the trailer?".
 *
 * Reads the shared lab transcript (see ../lab-transcript.ts). Read-only, always safe, and
 * release-safe: on a standalone build the shared log is empty → a clear "nothing recorded".
 */

import type { ToolSpec, ToolHandler } from '../tools.js';
import { recallConversation } from '../lab-transcript.js';

export const labConversationToolSpecs: ToolSpec[] = [
  {
    name: 'lab_recall_conversation',
    description:
      "Recall recent conversation from the SHARED lab log across the trio (Peh/Ptah/Luna). " +
      "You and your teammates share one lab; use this to see what was recently said in the " +
      "others' rooms beyond the short header you already have. Read-only.\n" +
      "- No args: recent turns across all three agents.\n" +
      "- 'agent' (peh|ptah|luna): limit to one teammate.\n" +
      "- 'limit': max turns (default 30).",
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: "Filter to one agent: 'peh', 'ptah', or 'luna'. Omit for all." },
        limit: { type: 'number', description: 'Max turns to return (default 30).' },
      },
      additionalProperties: false,
    },
  },
];

const recallHandler: ToolHandler = async (args) => {
  const agent = typeof args.agent === 'string' ? args.agent : undefined;
  const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(1, Math.min(200, Math.floor(args.limit)))
    : undefined;
  const output = recallConversation({ ...(agent ? { agent } : {}), ...(limit ? { limit } : {}) });
  return { ok: true, output };
};

export function createLabConversationToolHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  handlers.set('lab_recall_conversation', recallHandler);
  return handlers;
}
