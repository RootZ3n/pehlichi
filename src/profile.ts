/**
 * Active-agent compatibility seam. Persona lives in the per-agent profile;
 * tool authority lives only in the closed capsule/deployment configuration.
 * This stable import path is byte-identical across the trio.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentCapsules } from './core/runtime-config.js';

export { agentProfile } from "./profiles/agent.js";

/** Deprecated read-only view. The live runtime still intersects this request with its trusted ceiling. */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { capsule } = readAgentCapsules(repositoryRoot);
export const agentToolNames: readonly string[] = Object.freeze([...capsule.baseToolNames]);
