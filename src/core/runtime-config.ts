import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

import type { AgentProfile } from './profile.js';

export const CAPABILITY_PACK_TOOLS = {
  'work-orders': ['wo_list', 'wo_get', 'wo_transition'],
  occasio: ['wo_file_finding'],
} as const;

export type CapabilityPack = keyof typeof CAPABILITY_PACK_TOOLS;

export interface AgentCapsule {
  readonly schemaVersion: 1;
  readonly identity: {
    readonly id: string;
    readonly displayName: string;
    readonly role: string;
    readonly icon: string;
  };
  readonly providerDefaults: { readonly model: string; readonly baseUrl: string };
  readonly baseToolNames: readonly string[];
  readonly requestedCapabilityPacks: readonly CapabilityPack[];
  readonly personalityPath: string;
  readonly skinPath: string;
  readonly skillTags: readonly string[];
}

export interface DeploymentCapsule {
  readonly schemaVersion: 1;
  readonly environment: {
    readonly port: string;
    readonly host: string;
    readonly workspace: string;
    readonly workspaceRoots: string;
    readonly releaseManifest: string;
  };
  readonly defaults: { readonly port: number; readonly host: string; readonly workspace: string };
  readonly namespaces: {
    readonly checkpoint: string;
    readonly task: string;
    readonly correlation: string;
    readonly memory: string;
  };
  readonly memoryAmbient: {
    readonly includeNamespaces: readonly string[];
    readonly maxTurns: number;
    readonly maxCharsPerTurn: number;
  };
  readonly routingTargets: {
    readonly creative: string;
    readonly coordinator: string;
    readonly workOrderSource: 'zen' | 'peh' | 'luna' | 'julian' | 'atoni' | 'ptah' | 'unknown';
  };
  readonly baseToolCeiling: readonly string[];
  readonly capabilityPackCeiling: readonly CapabilityPack[];
  readonly secretEnvironmentReferences: readonly string[];
}

declare const validatedConfiguration: unique symbol;
export interface AgentRuntimeConfiguration {
  readonly [validatedConfiguration]: true;
  readonly repositoryRoot: string;
  readonly profile: AgentProfile;
  readonly capsule: AgentCapsule;
  readonly deployment: DeploymentCapsule;
}

const validatedConfigurations = new WeakSet<object>();
const TOOL_NAME = /^[a-z][a-z0-9_.-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const SAFE_ID = /^[a-z][a-z0-9_.-]{0,127}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: unknown, expected: readonly string[], field: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${field} contains missing or unknown fields`);
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function safeRelativePath(value: unknown): value is string {
  if (!isString(value) || isAbsolute(value) || value.includes('\\')) return false;
  return value === normalize(value).split(sep).join('/')
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function assertUniqueStrings(value: unknown, field: string, predicate: (value: string) => boolean = isString): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => !isString(item) || !predicate(item))) {
    throw new Error(`${field} must contain only recognized non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${field} must not contain duplicates`);
}

function assertPacks(value: unknown, field: string): asserts value is CapabilityPack[] {
  assertUniqueStrings(value, field, (item) => Object.prototype.hasOwnProperty.call(CAPABILITY_PACK_TOOLS, item));
}

function skipWhitespace(text: string, state: { index: number }): void {
  while (/\s/.test(text[state.index] ?? '')) state.index += 1;
}

function parseJsonStringToken(text: string, state: { index: number }): string {
  const start = state.index;
  if (text[state.index] !== '"') throw new Error('expected JSON string');
  state.index += 1;
  while (state.index < text.length) {
    const char = text[state.index++]!;
    if (char === '"') return JSON.parse(text.slice(start, state.index)) as string;
    if (char === '\\') {
      const escaped = text[state.index++]!;
      if (escaped === 'u') state.index += 4;
    }
  }
  throw new Error('unterminated JSON string');
}

function scanJsonValue(text: string, state: { index: number }, label: string): void {
  skipWhitespace(text, state);
  const char = text[state.index];
  if (char === '{') {
    state.index += 1;
    const keys = new Set<string>();
    skipWhitespace(text, state);
    if (text[state.index] === '}') { state.index += 1; return; }
    for (;;) {
      skipWhitespace(text, state);
      const key = parseJsonStringToken(text, state);
      if (keys.has(key)) throw new Error(`${label} contains duplicate JSON key: ${key}`);
      keys.add(key);
      skipWhitespace(text, state);
      if (text[state.index++] !== ':') throw new Error('expected JSON colon');
      scanJsonValue(text, state, label);
      skipWhitespace(text, state);
      const separator = text[state.index++];
      if (separator === '}') return;
      if (separator !== ',') throw new Error('expected JSON object separator');
    }
  }
  if (char === '[') {
    state.index += 1;
    skipWhitespace(text, state);
    if (text[state.index] === ']') { state.index += 1; return; }
    for (;;) {
      scanJsonValue(text, state, label);
      skipWhitespace(text, state);
      const separator = text[state.index++];
      if (separator === ']') return;
      if (separator !== ',') throw new Error('expected JSON array separator');
    }
  }
  if (char === '"') { parseJsonStringToken(text, state); return; }
  const match = text.slice(state.index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
  if (!match) throw new Error('invalid JSON value');
  state.index += match[0].length;
}

export function parseAuthorityJson(text: string, label: string): unknown {
  const state = { index: 0 };
  scanJsonValue(text, state, label);
  skipWhitespace(text, state);
  if (state.index !== text.length) throw new Error(`${label} contains trailing JSON data`);
  return JSON.parse(text) as unknown;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function validateCapsules(capsuleValue: unknown, deploymentValue: unknown): {
  capsule: AgentCapsule;
  deployment: DeploymentCapsule;
} {
  assertExactKeys(capsuleValue, [
    'schemaVersion', 'identity', 'providerDefaults', 'baseToolNames', 'requestedCapabilityPacks',
    'personalityPath', 'skinPath', 'skillTags',
  ], 'capsule');
  assertExactKeys(capsuleValue.identity, ['id', 'displayName', 'role', 'icon'], 'capsule.identity');
  assertExactKeys(capsuleValue.providerDefaults, ['model', 'baseUrl'], 'capsule.providerDefaults');
  const capsule = capsuleValue as unknown as AgentCapsule;
  assertExactKeys(deploymentValue, [
    'schemaVersion', 'environment', 'defaults', 'namespaces', 'memoryAmbient', 'routingTargets',
    'baseToolCeiling', 'capabilityPackCeiling', 'secretEnvironmentReferences',
  ], 'deployment');
  assertExactKeys(deploymentValue.environment, ['port', 'host', 'workspace', 'workspaceRoots', 'releaseManifest'], 'deployment.environment');
  assertExactKeys(deploymentValue.defaults, ['port', 'host', 'workspace'], 'deployment.defaults');
  assertExactKeys(deploymentValue.namespaces, ['checkpoint', 'task', 'correlation', 'memory'], 'deployment.namespaces');
  assertExactKeys(deploymentValue.memoryAmbient, ['includeNamespaces', 'maxTurns', 'maxCharsPerTurn'], 'deployment.memoryAmbient');
  assertExactKeys(deploymentValue.routingTargets, ['creative', 'coordinator', 'workOrderSource'], 'deployment.routingTargets');
  const deployment = deploymentValue as unknown as DeploymentCapsule;
  if (capsule.schemaVersion !== 1 || !isString(capsule.identity?.id) || !SAFE_ID.test(capsule.identity.id)
      || !isString(capsule.identity?.displayName) || !isString(capsule.identity?.role)
      || !isString(capsule.identity?.icon) || !isString(capsule.providerDefaults?.model)
      || !isString(capsule.providerDefaults?.baseUrl) || !safeRelativePath(capsule.personalityPath)
      || !safeRelativePath(capsule.skinPath)) {
    throw new Error('invalid capsule/agent.json');
  }
  assertUniqueStrings(capsule.skillTags, 'skillTags', (item) => SAFE_ID.test(item));
  assertUniqueStrings(capsule.baseToolNames, 'baseToolNames', (item) => TOOL_NAME.test(item));
  assertPacks(capsule.requestedCapabilityPacks, 'requestedCapabilityPacks');
  if (deployment.schemaVersion !== 1 || !Number.isInteger(deployment.defaults?.port)
      || deployment.defaults.port < 1 || deployment.defaults.port > 65535
      || !isString(deployment.defaults?.host) || !isString(deployment.defaults?.workspace)
      || !isString(deployment.environment?.port) || !ENVIRONMENT_NAME.test(deployment.environment.port)
      || !isString(deployment.environment?.host) || !ENVIRONMENT_NAME.test(deployment.environment.host)
      || !isString(deployment.environment?.workspace) || !ENVIRONMENT_NAME.test(deployment.environment.workspace)
      || !isString(deployment.environment?.workspaceRoots) || !ENVIRONMENT_NAME.test(deployment.environment.workspaceRoots)
      || !isString(deployment.environment?.releaseManifest) || !ENVIRONMENT_NAME.test(deployment.environment.releaseManifest)
      || !isString(deployment.namespaces?.checkpoint) || !isString(deployment.namespaces?.task)
      || !isString(deployment.namespaces?.correlation) || !isString(deployment.namespaces?.memory)
      || !Number.isInteger(deployment.memoryAmbient?.maxTurns) || deployment.memoryAmbient.maxTurns < 0
      || !Number.isInteger(deployment.memoryAmbient?.maxCharsPerTurn) || deployment.memoryAmbient.maxCharsPerTurn < 1
      || !isString(deployment.routingTargets?.creative) || !SAFE_ID.test(deployment.routingTargets.creative)
      || !isString(deployment.routingTargets?.coordinator) || !SAFE_ID.test(deployment.routingTargets.coordinator)
      || !['zen', 'peh', 'luna', 'julian', 'atoni', 'ptah', 'unknown'].includes(String(deployment.routingTargets?.workOrderSource))
      || !Array.isArray(deployment.secretEnvironmentReferences)) {
    throw new Error('invalid deployment/agent.env.json');
  }
  assertUniqueStrings(deployment.memoryAmbient.includeNamespaces, 'memoryAmbient.includeNamespaces');
  assertUniqueStrings(deployment.baseToolCeiling, 'baseToolCeiling', (item) => TOOL_NAME.test(item));
  assertUniqueStrings(deployment.secretEnvironmentReferences, 'secretEnvironmentReferences', (item) => ENVIRONMENT_NAME.test(item));
  assertPacks(deployment.capabilityPackCeiling, 'capabilityPackCeiling');
  return { capsule: deepFreeze(capsule), deployment: deepFreeze(deployment) };
}

export function readAgentCapsules(repositoryRoot: string): {
  capsule: AgentCapsule;
  deployment: DeploymentCapsule;
} {
  const capsuleText = readFileSync(join(repositoryRoot, 'capsule', 'agent.json'), 'utf8');
  const deploymentText = readFileSync(join(repositoryRoot, 'deployment', 'agent.env.json'), 'utf8');
  return validateCapsules(
    parseAuthorityJson(capsuleText, 'capsule/agent.json'),
    parseAuthorityJson(deploymentText, 'deployment/agent.env.json'),
  );
}

export function loadAgentRuntimeConfiguration(repositoryRoot: string, profile: AgentProfile): AgentRuntimeConfiguration {
  const { capsule, deployment } = readAgentCapsules(repositoryRoot);
  if (profile.name !== capsule.identity.displayName || profile.role !== capsule.identity.role
      || profile.icon !== capsule.identity.icon) {
    throw new Error('agent profile identity does not match validated capsule identity');
  }
  const config = deepFreeze({
    repositoryRoot,
    profile,
    capsule,
    deployment,
  }) as AgentRuntimeConfiguration;
  validatedConfigurations.add(config);
  return config;
}

export function assertValidatedRuntimeConfiguration(value: unknown): asserts value is AgentRuntimeConfiguration {
  if (typeof value !== 'object' || value === null || !validatedConfigurations.has(value)) {
    throw new Error('agent runtime requires an opaque configuration loaded from validated declarative files');
  }
}

export function authorizedCapabilityPacks(config: AgentRuntimeConfiguration): CapabilityPack[] {
  assertValidatedRuntimeConfiguration(config);
  const ceiling = new Set(config.deployment.capabilityPackCeiling);
  const denied = config.capsule.requestedCapabilityPacks.filter((pack) => !ceiling.has(pack));
  if (denied.length > 0) throw new Error(`capability packs exceed deployment ceiling: ${denied.join(', ')}`);
  return [...config.capsule.requestedCapabilityPacks];
}

export function authorizedToolNames(config: AgentRuntimeConfiguration): string[] {
  assertValidatedRuntimeConfiguration(config);
  const ceiling = new Set(config.deployment.baseToolCeiling);
  const denied = config.capsule.baseToolNames.filter((name) => !ceiling.has(name));
  if (denied.length > 0) throw new Error(`base tools exceed deployment ceiling: ${denied.join(', ')}`);
  const result = [...config.capsule.baseToolNames];
  for (const pack of authorizedCapabilityPacks(config)) result.push(...CAPABILITY_PACK_TOOLS[pack]);
  const duplicate = result.find((name, index) => result.indexOf(name) !== index);
  if (duplicate) throw new Error(`duplicate configured tool authority: ${duplicate}`);
  return result;
}

export function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

export function configuredPort(config: AgentRuntimeConfiguration): number {
  assertValidatedRuntimeConfiguration(config);
  const raw = envValue(config.deployment.environment.port);
  const value = raw === undefined ? config.deployment.defaults.port : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('configured port is invalid');
  return value;
}

export function configuredHost(config: AgentRuntimeConfiguration): string {
  assertValidatedRuntimeConfiguration(config);
  return envValue(config.deployment.environment.host) ?? config.deployment.defaults.host;
}

export function configuredWorkspace(config: AgentRuntimeConfiguration): string {
  assertValidatedRuntimeConfiguration(config);
  return envValue(config.deployment.environment.workspace) ?? config.deployment.defaults.workspace;
}
