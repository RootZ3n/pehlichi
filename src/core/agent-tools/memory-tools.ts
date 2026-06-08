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
import type { ToolSpec, ToolHandler, ToolResult } from '../core/tools.js';

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
- add: Append a new entry. Content should be a concise, factual statement.
- replace: Find an entry by short unique substring, replace it with new content.
- remove: Find an entry by short unique substring, delete it.
- read: Read all current entries (returns live state from disk).

Entries are § delimited. Be concise — each entry should be 1-3 sentences max.
Memory entries are injected into the system prompt and survive context compaction.
Write important things down — don't make the user repeat themselves.`,
    parameters: obj(
      {
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'read'], description: 'Action to perform' },
        target: { type: 'string', enum: ['memory', 'user'], description: 'Which store (memory=agent notes, user=user profile)' },
        content: { type: 'string', description: 'Entry content (for add/replace). Concise, factual statement.' },
        old_text: { type: 'string', description: 'Unique substring to find (for replace/remove)' },
      },
      ['action'],
    ),
  },
];

export interface MemoryStoreConfig {
  memoryDir: string;
  memoryCharLimit?: number;
  userCharLimit?: number;
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

    if (!['memory', 'user'].includes(target)) {
      return { ok: false, output: '', error: `Invalid target: ${target}. Use "memory" or "user".` };
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

        const oldEntry = entries[matchIdx];
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

        const removed = entries.splice(matchIdx, 1)[0];
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
