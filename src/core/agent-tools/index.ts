/**
 * AGENT TOOLS — full tool suite for lab agents.
 *
 * Provides the same tool registry as Hermes:
 * - Browser tools (Playwright-based)
 * - Web tools (search, extract)
 * - Enhanced file tools (read, write, search, patch)
 * - Vision tools (image analysis)
 * - Execute code (sandboxed Python/Node)
 * - Delegate task (sub-agent spawning)
 * - Todo (task management)
 *
 * Usage:
 *   import { createFullToolRegistry } from './agent-tools/index.js';
 *   const extraTools = createFullToolRegistry({ workspaceRoot, agentServerUrl, apiKey });
 *   const registry = createToolRegistry(extraTools);
 */
import type { ToolDef } from '../tools.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserToolSpecs, createBrowserToolHandlers } from './browser-tools.js';
import { webToolSpecs, createWebToolHandlers } from './web-tools.js';
import { enhancedFileToolSpecs, createEnhancedFileToolHandlers } from './enhanced-file-tools.js';
import { visionToolSpecs, createVisionToolHandlers } from './vision-tools.js';
import { executeCodeToolSpecs, createExecuteCodeToolHandlers } from './execute-code-tools.js';
import { delegateToolSpecs, createDelegateToolHandlers } from './delegate-tools.js';
import { todoToolSpecs, createTodoToolHandlers } from './todo-tools.js';
import { skillToolSpecs, createSkillToolHandlers } from './skill-tools.js';
import { memoryToolSpecs, createMemoryToolHandlers } from './memory-tools.js';
import { cronToolSpecs, createCronToolHandlers } from './cron-tools.js';
import { clarifyToolSpecs, createClarifyToolHandlers } from './clarify-tools.js';

export interface AgentToolConfig {
  /** Workspace root for file operations */
  workspaceRoot: string;
  /** Agent's own HTTP server URL (retained for compatibility; delegation no longer uses it) */
  agentServerUrl: string;
  /** API key for vision/LLM calls */
  apiKey?: string;
  /** Skills directory root */
  skillsRoot?: string;
  /** Memory directory root */
  memoryDir?: string;
  /**
   * Path to the sub-agent runner script `delegate_task` spawns. Defaults to the
   * compiled subagent-entry.js next to this module. Override in tests to point at
   * a fixture runner.
   */
  subagentRunnerPath?: string;
  /** Hard timeout (ms) for a delegated sub-agent (default 5 minutes). */
  delegateTimeoutMs?: number;
}

/** The compiled sub-agent runner, resolved relative to this module (dist/core/agent-tools → ../subagent-entry.js). */
const DEFAULT_SUBAGENT_RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'subagent-entry.js');

/**
 * Create the full set of extra tools matching Hermes' tool registry.
 * Returns a ToolDef[] that can be passed to createToolRegistry(extraTools).
 */
export function createFullToolRegistry(config: AgentToolConfig): ToolDef[] {
  const browserHandlers = createBrowserToolHandlers();
  const webHandlers = createWebToolHandlers();
  const fileHandlers = createEnhancedFileToolHandlers(config.workspaceRoot);
  const visionHandlers = createVisionToolHandlers(config.apiKey);
  const executeCodeHandlers = createExecuteCodeToolHandlers();
  const delegateHandlers = createDelegateToolHandlers({
    runnerPath: config.subagentRunnerPath ?? DEFAULT_SUBAGENT_RUNNER,
    ...(config.delegateTimeoutMs !== undefined ? { timeoutMs: config.delegateTimeoutMs } : {}),
  });
  const todoHandlers = createTodoToolHandlers();
  const skillsRoot = config.skillsRoot ?? join(config.workspaceRoot, 'skills');
  const skillHandlers = createSkillToolHandlers(skillsRoot);
  const memoryDir = config.memoryDir ?? join(config.workspaceRoot, 'memories');
  const memoryHandlers = createMemoryToolHandlers({ memoryDir });
  const cronHandlers = createCronToolHandlers(async (prompt: string) => {
    console.log(`[cron] Executing scheduled task: ${prompt.slice(0, 100)}`);
    return `Task "${prompt.slice(0, 50)}" executed at ${new Date().toISOString()}`;
  });
  const clarifyHandlers = createClarifyToolHandlers();

  const tools: ToolDef[] = [];

  // Browser tools
  for (const spec of browserToolSpecs) {
    const handler = browserHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Web tools
  for (const spec of webToolSpecs) {
    const handler = webHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Enhanced file tools
  for (const spec of enhancedFileToolSpecs) {
    const handler = fileHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Vision tools
  for (const spec of visionToolSpecs) {
    const handler = visionHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Execute code tools
  for (const spec of executeCodeToolSpecs) {
    const handler = executeCodeHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Delegate tools
  for (const spec of delegateToolSpecs) {
    const handler = delegateHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Todo tools
  for (const spec of todoToolSpecs) {
    const handler = todoHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Skill tools
  for (const spec of skillToolSpecs) {
    const handler = skillHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Memory tools
  for (const spec of memoryToolSpecs) {
    const handler = memoryHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Cron tools
  for (const spec of cronToolSpecs) {
    const handler = cronHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  // Clarify tools
  for (const spec of clarifyToolSpecs) {
    const handler = clarifyHandlers.get(spec.name);
    if (handler) tools.push({ spec, handler });
  }

  return tools;
}

// Re-export types for consumers
export type { ToolSpec, ToolHandler, ToolResult, ToolDef } from '../tools.js';
export { buildMemorySnapshot } from './memory-tools.js';
