/**
 * DELEGATE TASK TOOL — spawn sub-agents.
 *
 * Tool name matches Hermes: delegate_task.
 * Spawns a child agent process to handle a task independently.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ToolSpec, ToolHandler, ToolResult } from '../core/tools.js';

const obj = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });

export const delegateToolSpecs: ToolSpec[] = [
  {
    name: 'delegate_task',
    description: 'Spawn a sub-agent to handle a task. Returns the agent\'s final summary.',
    parameters: obj(
      {
        goal: { type: 'string', description: 'What the sub-agent should accomplish' },
        context: { type: 'string', description: 'Background info the sub-agent needs' },
        toolsets: { type: 'array', items: { type: 'string' }, description: 'Toolsets to enable (terminal, file, web, browser)' },
      },
      ['goal'],
    ),
  },
];

const DELEGATE_TIMEOUT = 300_000; // 5 minutes

export function createDelegateToolHandlers(agentServerUrl: string): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  handlers.set('delegate_task', async (args): Promise<ToolResult> => {
    const goal = args.goal as string;
    const context = (args.context as string) ?? '';
    const toolsets = (args.toolsets as string[]) ?? ['terminal', 'file', 'web'];

    try {
      // Build the delegation prompt
      const prompt = [
        `TASK: ${goal}`,
        context ? `\nCONTEXT:\n${context}` : '',
        `\nTOOLSETS: ${toolsets.join(', ')}`,
        '\nComplete the task and provide a clear summary of what you did and the results.',
      ].join('\n');

      // Send to the agent's own server as a chat message
      const response = await fetch(`${agentServerUrl}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `[DELEGATED TASK]\n${prompt}` }),
        signal: AbortSignal.timeout(DELEGATE_TIMEOUT),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        return { ok: false, output: '', error: `Delegation failed: ${response.status} ${errorText.slice(0, 200)}` };
      }

      const data = await response.json() as any;
      return {
        ok: true,
        output: data.content || data.error || 'No response from sub-agent',
      };
    } catch (err) {
      return { ok: false, output: '', error: `Delegation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  return handlers;
}
