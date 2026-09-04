/**
 * THIS DEPLOYMENT'S CONTAINMENT CONFIGURATION.
 *
 * Byte-identical across the Trio, like everything else in `src/core/`, and deliberately
 * IDENTITY-NEUTRAL: nothing here names Pehlichi, Luna, Ptah or Johnny Five, and nothing branches on
 * which of them is running. Shared enforcement code that asks who it belongs to is not one boundary
 * — it is three that happen to share a file name, and only one of them ever gets reviewed.
 *
 * The writable allocation arrives as closed declarative deployment data, through the same governed
 * capsule loader every other per-deployment difference already flows through. There is no second
 * authority path, no environment variable that can widen it, and no default: a deployment that does
 * not declare an allocation does not get one.
 */
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { containmentConfig } from './containment/policy.js';
import type { ContainmentConfig } from './containment/policy.js';
import { readAgentCapsules } from './runtime-config.js';
import { resolveGovernedTempRoot } from './temp-authority.js';

/** Raised when this deployment cannot be located or does not declare an allocation. */
export class ContainmentConfigurationUnavailable extends Error {
  constructor(reason: string) {
    super(`containment configuration unavailable: ${reason}`);
    this.name = 'ContainmentConfigurationUnavailable';
  }
}

/**
 * Walk up from this module until the governed deployment capsule appears.
 *
 * Derived from the module's own location rather than `process.cwd()`: the working directory belongs
 * to whoever launched the process and says nothing about which deployment this code is part of.
 */
export function repositoryRootFrom(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, 'deployment', 'agent.env.json'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new ContainmentConfigurationUnavailable(`no deployment/agent.env.json above ${startDir}`);
    }
    current = parent;
  }
}

let cached: ContainmentConfig | undefined;

/**
 * This deployment's containment configuration.
 *
 * `readAgentCapsules` applies the closed schema — required fields, unknown fields rejected, and the
 * structural checks that stop a writable path being widened after review — and throws rather than
 * returning a partial answer. Nothing is caught here: a malformed capsule must stop the caller, not
 * quietly hand it a weaker boundary.
 *
 * Cached, because the capsule cannot change under a running process without that process being
 * replaced, and re-reading it would put a file read in front of every spawn.
 */
export function agentContainmentConfig(env: NodeJS.ProcessEnv = process.env): ContainmentConfig {
  if (cached !== undefined) return cached;
  const root = repositoryRootFrom(dirname(fileURLToPath(import.meta.url)));
  const { deployment } = readAgentCapsules(root);
  const built = containmentConfig({
    writableWorkspaces: deployment.containment.writableWorkspaces,
    governedTempRoot: resolveGovernedTempRoot(env),
  });
  cached = built;
  return built;
}

/** Drop the cached configuration. Tests only. */
export function resetAgentContainmentConfig(): void {
  cached = undefined;
}
