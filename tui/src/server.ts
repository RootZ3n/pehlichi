/** Byte-identical Trio compatibility launcher. All differing inputs are validated data. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentProfile } from '../../src/profile.js';
import {
  createAgentServer,
  startAgentServer,
  parseWorkspaceOverride as parseConfiguredWorkspaceOverride,
  type AgentServerOptions,
} from '../../runtime/server/server.js';
import {
  loadAgentRuntimeConfiguration,
  type AgentRuntimeConfiguration,
} from '../../runtime/server/config.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const configuredRuntime: AgentRuntimeConfiguration =
  loadAgentRuntimeConfiguration(repositoryRoot, agentProfile);

export type ConfiguredServerOptions = AgentServerOptions;
export type PehServerOptions = AgentServerOptions;
export type LunaServerOptions = AgentServerOptions;
export type PtahServerOptions = AgentServerOptions;

export const createConfiguredServer = (opts: ConfiguredServerOptions = {}) =>
  createAgentServer(configuredRuntime, opts);
export const createPehServer = createConfiguredServer;
export const createLunaServer = createConfiguredServer;
export const createPtahServer = createConfiguredServer;
export const parseWorkspaceOverride = (body: Record<string, unknown>) =>
  parseConfiguredWorkspaceOverride(configuredRuntime, body);

export {
  hasTaskKeyword,
  hasWebIntent,
  hasInspectIntent,
  mentionsTool,
  parseChatMode,
  truthLayerEnabled,
  type ConverseLike,
  type RequestedChatMode,
  type SelectedChatMode,
  ScriptedDriver,
  type DriverAction,
} from '../../runtime/server/server.js';

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) startAgentServer(configuredRuntime);
