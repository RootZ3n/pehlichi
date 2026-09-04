/**
 * THIS AGENT'S CONTAINMENT CONFIGURATION.
 *
 * Byte-identical across the Trio, like every other file in `src/core/`. The per-agent difference is
 * not written here — it is read at runtime from `capsule/agent.json`, which is already the governed
 * carrier for every other thing that distinguishes one agent from another. A second naming scheme
 * embedded in shared code could disagree with the capsule; reading the capsule cannot.
 *
 * The configuration this produces:
 *   - mode `auto` — risky work is DENIED when the boundary is unavailable
 *   - `writableWorkspaces` from the agent's declared profile, plus its own governed scratch
 *   - `trustedLocalOverride` false, and unreachable from here
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configFor } from './containment/agents.js';
import type { ContainmentConfig } from './containment/policy.js';
import { resolveGovernedTempRoot } from './temp-authority.js';

/** Raised when this agent cannot say who it is. There is no fallback identity. */
export class AgentIdentityUnresolved extends Error {
  constructor(reason: string) {
    super(`this agent's containment identity could not be resolved: ${reason}`);
    this.name = 'AgentIdentityUnresolved';
  }
}

/**
 * Walk up from this module until a `capsule/agent.json` appears.
 *
 * Derived from the module's own location rather than `process.cwd()`: the working directory belongs
 * to whoever launched the process and is not a statement about which agent this code is part of.
 */
export function repositoryRootFrom(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, 'capsule', 'agent.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new AgentIdentityUnresolved('no capsule/agent.json above ' + startDir);
    current = parent;
  }
}

/** The `identity.id` this repository's capsule declares. */
export function capsuleIdentityId(repositoryRoot: string): string {
  const text = readFileSync(join(repositoryRoot, 'capsule', 'agent.json'), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentIdentityUnresolved('capsule/agent.json is not valid JSON');
  }
  const identity = (parsed as { identity?: { id?: unknown } } | null)?.identity;
  const id = identity?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new AgentIdentityUnresolved('capsule/agent.json declares no identity.id');
  }
  return id;
}

let cached: ContainmentConfig | undefined;

/**
 * This agent's containment configuration.
 *
 * Cached: the capsule cannot change under a running process without the process being replaced, and
 * re-reading it on every tool call would put a file read in the path of every command.
 */
export function agentContainmentConfig(env: NodeJS.ProcessEnv = process.env): ContainmentConfig {
  if (cached !== undefined) return cached;
  const root = repositoryRootFrom(dirname(fileURLToPath(import.meta.url)));
  const id = capsuleIdentityId(root);
  cached = configFor(id, { governedTempRoot: resolveGovernedTempRoot(env) });
  return cached;
}

/** Drop the cached configuration. Tests only. */
export function resetAgentContainmentConfig(): void {
  cached = undefined;
}
