/**
 * MEMORY TOOL — Hermes-style persistent curated memory.
 *
 * Two stores:
 *   - MEMORY.md: agent's personal notes (environment facts, project conventions,
 *     tool quirks, things learned)
 *   - USER.md: what the agent knows about the user (preferences, communication style,
 *     expectations, workflow habits)
 *
 * Both are injected into the system prompt as a frozen snapshot at session start.
 * Mid-session writes update files on disk immediately (durable) but do NOT change
 * the system prompt — this preserves the prefix cache for the entire session.
 * The snapshot refreshes on the next session start.
 *
 * Entry delimiter: § (section sign). Entries can be multiline.
 * Character limits (not tokens) because char counts are model-independent.
 *
 * Single `memory` tool with action parameter: add, replace, remove, read
 * replace/remove use short unique substring matching (not full text or IDs)
 *
 * Key invariant: memory entries live in the FROZEN system prompt prefix.
 * They survive compaction, session resets, and context window pressure.
 * If an agent learns something important, it persists forever until explicitly removed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ToolSpec, ToolHandler, ToolResult } from '../tools.js';
import type { MemoryGovernance, MemoryChangeRequest } from './memory-governance.js';
import { sanitizeMemoryEvidence } from './memory-governance.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 2200;
const USER_CHAR_LIMIT = 1375;

// Prompt injection patterns
const INJECTION_PATTERNS = [
  'ignore previous instructions',
  'ignore all previous',
  'you are now',
  'disregard your',
  'forget your instructions',
  'new instructions:',
  'system prompt:',
  '<system>',
  ']]>',
];

export const memoryToolSpecs: ToolSpec[] = [
  {
    name: 'memory',
    description: `Persistent curated memory that survives across sessions and compaction.

Two stores:
- MEMORY: agent's notes (environment facts, project conventions, tool quirks, things learned). ${MEMORY_CHAR_LIMIT} char limit.
- USER: what the agent knows about the user (preferences, communication style, workflow habits). ${USER_CHAR_LIMIT} char limit.

Actions:
- add: Propose appending a new entry. Content should be a concise, factual statement.
- replace: Propose replacing an entry found by short unique substring.
- remove: Propose deleting an entry found by short unique substring.
- read: Read all current entries (returns live state from disk).

GOVERNANCE: durable add/replace/remove do NOT write memory directly. They create a
governance PROPOSAL (returns a proposal id) that a human must verify and approve
before it is installed. Reads are always direct.

EPHEMERAL SCRATCH: pass ephemeral=true with add/read to use session-only scratch
memory. Scratch is NON-DURABLE — it is never installed and is gone at session end.

Entries are § delimited. Be concise — each entry should be 1-3 sentences max.
Durable memory entries are injected into the system prompt and survive compaction.`,
    parameters: obj(
      {
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'read'], description: 'Action to perform' },
        target: { type: 'string', enum: ['memory', 'user'], description: 'Which store (memory=agent notes, user=user profile)' },
        content: { type: 'string', description: 'Entry content (for add/replace). Concise, factual statement.' },
        old_text: { type: 'string', description: 'Unique substring to find (for replace/remove)' },
        ephemeral: { type: 'boolean', description: 'If true, use session-only NON-DURABLE scratch memory (no proposal, no durable write).' },
        evidence: {
          type: 'array',
          description:
            'OPTIONAL reference-only evidence for add/replace (advisory provenance for a later reviewer — ' +
            'it NEVER marks memory verified and never changes approval). Each item references an artifact; ' +
            'pass NO file contents. Unsupported kinds (command_receipt/tool_receipt) are dropped.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['file', 'commit', 'existing_memory', 'user_message', 'agent_report', 'manual_note'],
                description: 'file/commit/existing_memory are verifiable; user_message/agent_report/manual_note are provenance only.',
              },
              path: { type: 'string', description: 'file: workspace-relative path' },
              sha256: { type: 'string', description: 'file: optional sha256 to pin the exact bytes' },
              lines: { type: 'string', description: 'file: optional line range, e.g. "10-42"' },
              commit: { type: 'string', description: 'commit: git commit sha' },
              repo: { type: 'string', description: 'commit: optional repo path hint' },
              ref: { type: 'string', description: 'existing_memory: id/fqid of a current memory entry' },
              description: { type: 'string', description: 'optional short provenance note (no blobs)' },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
      },
      ['action'],
    ),
  },
];

export interface MemoryStoreConfig {
  memoryDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
  /**
   * GOVERNANCE SINK. When set, durable add/replace/remove create a pending
   * proposal (returns a proposal id) instead of writing MEMORY.md/USER.md. The
   * agent-facing wiring (createFullToolRegistry) ALWAYS supplies one — that is the
   * trust boundary. When unset, the handler keeps the trusted direct-write mode
   * for trusted internal callers and unit tests. Reads are unaffected either way.
   */
  governance?: MemoryGovernance;
  /** Agent id recorded on each proposal (defaults to "pehlichi"). */
  agentId?: string;
}

/**
 * Create the memory tool handler.
 * Manages two files: MEMORY.md and USER.md in the memoryDir.
 */
export function createMemoryToolHandlers(config: MemoryStoreConfig): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const memoryDir = config.memoryDir;
  const memoryCharLimit = config.memoryCharLimit ?? MEMORY_CHAR_LIMIT;
  const userCharLimit = config.userCharLimit ?? USER_CHAR_LIMIT;
  const governance = config.governance;
  const agentId = config.agentId ?? 'pehlichi';

  // EPHEMERAL SCRATCH: session-only, non-durable. Lives in this closure and is
  // discarded when the process ends. Never written to disk, never installed.
  const scratch: { memory: string[]; user: string[] } = { memory: [], user: [] };

  // Ensure memory directory exists
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Load entries from disk
  function loadEntries(target: string): string[] {
    const filePath = join(memoryDir, target === 'user' ? 'USER.md' : 'MEMORY.md');
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content.split(ENTRY_DELIMITER).map(e => e.trim()).filter(Boolean);
  }

  // Save entries to disk
  function saveEntries(target: string, entries: string[]): void {
    const filePath = join(memoryDir, target === 'user' ? 'USER.md' : 'MEMORY.md');
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, entries.join(ENTRY_DELIMITER), 'utf8');
  }

  // Get char limit for target
  function charLimit(target: string): number {
    return target === 'user' ? userCharLimit : memoryCharLimit;
  }

  // Count total chars
  function totalChars(entries: string[]): number {
    return entries.join(ENTRY_DELIMITER).length;
  }

  // Scan for injection
  function scanForInjection(content: string): string | null {
    const lower = content.toLowerCase();
    for (const pattern of INJECTION_PATTERNS) {
      if (lower.includes(pattern)) {
        return `Potential prompt injection detected: "${pattern}"`;
      }
    }
    return null;
  }

  handlers.set('memory', async (args): Promise<ToolResult> => {
    const action = args.action as string;
    const target = (args.target as string) ?? 'memory';
    const ephemeral = args.ephemeral === true;

    if (!['memory', 'user'].includes(target)) {
      return { ok: false, output: '', error: `Invalid target: ${target}. Use "memory" or "user".` };
    }

    // EPHEMERAL SCRATCH path: session-only, never durable, never proposed.
    if (ephemeral) {
      const bucket = scratch[target as 'memory' | 'user'];
      switch (action) {
        case 'add': {
          const content = (args.content as string)?.trim();
          if (!content) return { ok: false, output: '', error: 'content is required for add' };
          const injection = scanForInjection(content);
          if (injection) return { ok: false, output: '', error: injection };
          bucket.push(content);
          return { ok: true, output: `[ephemeral/non-durable] noted in ${target} scratch (${bucket.length} entries). Lost at session end.` };
        }
        case 'read': {
          if (bucket.length === 0) return { ok: true, output: `[ephemeral/non-durable] No scratch entries in ${target}.` };
          return { ok: true, output: `[ephemeral/non-durable] ${target} scratch:\n\n${bucket.map((e, i) => `${i + 1}. ${e}`).join('\n')}` };
        }
        default:
          return { ok: false, output: '', error: `ephemeral scratch supports only add/read (got "${action}")` };
      }
    }

    switch (action) {
      case 'read': {
        const entries = loadEntries(target);
        if (entries.length === 0) {
          return { ok: true, output: `No entries in ${target}.` };
        }
        const charCount = totalChars(entries);
        const limit = charLimit(target);
        const output = entries.map((e, i) => `${i + 1}. ${e}`).join('\n');
        return {
          ok: true,
          output: `${target} entries (${charCount}/${limit} chars):\n\n${output}`,
        };
      }

      case 'add': {
        const content = (args.content as string)?.trim();
        if (!content) {
          return { ok: false, output: '', error: 'content is required for add' };
        }

        // Security scan
        const injection = scanForInjection(content);
        if (injection) {
          return { ok: false, output: '', error: injection };
        }

        // GOVERNANCE: a durable add becomes a proposal, not a direct write.
        if (governance) {
          const evidence = sanitizeMemoryEvidence(args.evidence);
          return proposeChange(governance, agentId, {
            action: 'add',
            target: target as 'memory' | 'user',
            content,
            ...(evidence.length > 0 ? { evidence } : {}),
          });
        }

        const entries = loadEntries(target);
        const limit = charLimit(target);

        // Check if adding would exceed limit
        const newTotal = totalChars(entries) + content.length + (entries.length > 0 ? ENTRY_DELIMITER.length : 0);
        if (newTotal > limit) {
          return {
            ok: false,
            output: '',
            error: `Adding this entry would exceed the ${target} char limit (${newTotal}/${limit}). Remove or replace an existing entry first.`,
          };
        }

        // Check for duplicate
        if (entries.some(e => e === content)) {
          return { ok: true, output: `Entry already exists in ${target}.` } as any;
        }

        entries.push(content);
        saveEntries(target, entries);

        return {
          ok: true,
          output: `Added to ${target} (${totalChars(entries)}/${limit} chars). Entry: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}"`,
        };
      }

      case 'replace': {
        const oldText = args.old_text as string;
        const newContent = (args.content as string)?.trim();

        if (!oldText) {
          return { ok: false, output: '', error: 'old_text is required for replace' };
        }
        if (!newContent) {
          return { ok: false, output: '', error: 'content is required for replace' };
        }

        // Security scan
        const injection = scanForInjection(newContent);
        if (injection) {
          return { ok: false, output: '', error: injection };
        }

        // GOVERNANCE: a durable replace becomes a proposal, not a direct write.
        if (governance) {
          const evidence = sanitizeMemoryEvidence(args.evidence);
          return proposeChange(governance, agentId, {
            action: 'replace',
            target: target as 'memory' | 'user',
            content: newContent,
            oldText,
            ...(evidence.length > 0 ? { evidence } : {}),
          });
        }

        const entries = loadEntries(target);
        const limit = charLimit(target);

        // Find matching entry
        const matchIdx = entries.findIndex(e => e.includes(oldText));
        if (matchIdx < 0) {
          return {
            ok: false,
            output: '',
            error: `No entry in ${target} contains "${oldText}". Use memory(action=read) to see current entries.`,
          };
        }

        // Check for ambiguous match
        const matchCount = entries.filter(e => e.includes(oldText)).length;
        if (matchCount > 1) {
          return {
            ok: false,
            output: '',
            error: `Found ${matchCount} entries matching "${oldText}". Provide a more unique substring.`,
          };
        }

        const oldEntry = entries[matchIdx]!; // matchIdx >= 0 (the not-found case returned above)
        entries[matchIdx] = newContent;

        // Check char limit
        if (totalChars(entries) > limit) {
          return {
            ok: false,
            output: '',
            error: `Replacement would exceed ${target} char limit. Make it shorter.`,
          };
        }

        saveEntries(target, entries);

        return {
          ok: true,
          output: `Replaced in ${target}: "${oldEntry.slice(0, 60)}..." → "${newContent.slice(0, 60)}..."`,
        };
      }

      case 'remove': {
        const oldText = args.old_text as string;
        if (!oldText) {
          return { ok: false, output: '', error: 'old_text is required for remove' };
        }

        // GOVERNANCE: a durable remove becomes a proposal, not a direct write.
        if (governance) {
          return proposeChange(governance, agentId, { action: 'remove', target: target as 'memory' | 'user', oldText });
        }

        const entries = loadEntries(target);

        // Find matching entry
        const matchIdx = entries.findIndex(e => e.includes(oldText));
        if (matchIdx < 0) {
          return {
            ok: false,
            output: '',
            error: `No entry in ${target} contains "${oldText}". Use memory(action=read) to see current entries.`,
          };
        }

        // Check for ambiguous match
        const matchCount = entries.filter(e => e.includes(oldText)).length;
        if (matchCount > 1) {
          return {
            ok: false,
            output: '',
            error: `Found ${matchCount} entries matching "${oldText}". Provide a more unique substring.`,
          };
        }

        const removed = entries.splice(matchIdx, 1)[0]!; // matchIdx >= 0 (the not-found case returned above)
        saveEntries(target, entries);

        return {
          ok: true,
          output: `Removed from ${target}: "${removed.slice(0, 80)}${removed.length > 80 ? '...' : ''}"`,
        };
      }

      default:
        return { ok: false, output: '', error: `Unknown action: ${action}. Use add, replace, remove, or read.` };
    }
  });

  return handlers;
}

/**
 * Build the frozen memory snapshot for system prompt injection.
 * This is called ONCE at session start and NEVER changes mid-session.
 * Scans for injection patterns and blocks compromised entries.
 */
export function buildMemorySnapshot(memoryDir: string): string {
  const parts: string[] = [];

  for (const [target, filename] of [['memory', 'MEMORY.md'], ['user', 'USER.md']] as const) {
    const filePath = join(memoryDir, filename);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) continue;

    const entries = content.split(ENTRY_DELIMITER).map(e => e.trim()).filter(Boolean);
    const sanitized: string[] = [];

    for (const entry of entries) {
      const injection = scanForInjection(entry);
      if (injection) {
        sanitized.push(`[BLOCKED: ${injection}]`);
      } else {
        sanitized.push(entry);
      }
    }

    if (sanitized.length > 0) {
      const label = target === 'memory' ? 'MEMORY (agent notes)' : 'USER (user profile)';
      parts.push(`## ${label}\n${sanitized.join('\n')}`);
    }
  }

  return parts.join('\n\n');
}

function scanForInjection(content: string): string | null {
  const lower = content.toLowerCase();
  for (const pattern of INJECTION_PATTERNS) {
    if (lower.includes(pattern)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Route a durable memory change through governance: record a pending proposal and
 * return a clear tool result that names the proposal, its target, risk, and that
 * NOTHING was installed. This is the only durable-write path the agent can reach
 * once a governance sink is wired.
 */
function proposeChange(
  governance: MemoryGovernance,
  agentId: string,
  change: MemoryChangeRequest,
): ToolResult {
  const p = governance.propose(change, agentId);
  const lines = [
    `Memory ${change.action} PROPOSAL created — NOT installed.`,
    `  proposal id:   ${p.id}`,
    `  target:        ${p.target} (${p.namespace})`,
    `  risk:          ${p.risk_level} (${p.improvement_type})`,
    `  status:        ${p.status} — pending verification + ${p.requiresHumanApproval ? 'human approval' : 'approval'}`,
    `  installed:     no (durable memory is unchanged)`,
    ...(p.evidence && p.evidence.length > 0
      ? [`  evidence:      ${p.evidence.length} reference(s) attached (advisory — does NOT mark memory verified)`]
      : []),
    ``,
    `Durable memory is governed: a human must verify and approve proposal ${p.id} before it is installed.`,
    `For session-only notes, call memory with ephemeral=true (non-durable scratch).`,
  ];
  return { ok: true, output: lines.join('\n') };
}
