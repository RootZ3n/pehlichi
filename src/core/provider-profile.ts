/**
 * THE PROVIDER PROFILE — which model this deployment talks to, decided outside the repository.
 *
 * The agent's capsule declares a provider default, and that default is a *description*: it says
 * what this agent was built expecting. It cannot be the decision, for the same reason the committed
 * operational status cannot be the decision — a tree that chooses its own provider is a tree that
 * can point itself at anything, and a credential that lives beside the code is an authority the
 * repository grants itself.
 *
 * So the live provider comes from a root-owned record on the systemd credential channel, read once
 * at startup, opened and closed. Selecting a different provider is a file change under `/etc` and a
 * restart. It is never a commit, never an environment variable a caller can set, and never a
 * prompt.
 *
 * WHAT THIS MODULE WILL NOT DO:
 *
 *   - it will not read an API key from the process environment when a credential channel exists.
 *     An environment variable holding a provider key is inherited by every tool subprocess the
 *     agent spawns, appears in `/proc/<pid>/environ`, and is one `env` away from a model prompt;
 *   - it will not return the key from any function that describes the profile. `describe()` exists
 *     precisely so that evidence can name the provider, the endpoint and the model without ever
 *     being able to name the secret;
 *   - it will not carry a key into a receipt, a log line or an error message.
 */
import { closeSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** The only schema this reader understands. Distinct from every authority document. */
const SCHEMA = 'pehverse-provider-profile/1';
const CREDENTIAL = 'provider-profile';

/** How a provider expects the key to be presented. Named, never guessed from the URL. */
export type AuthStyle = 'bearer' | 'api-key';

export interface ProviderProfile {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly authStyle: AuthStyle;
  /** Whether to ask this provider for a streamed response. Negotiated, never assumed. */
  readonly streaming: boolean;
  /** Provider-specific request fields, sent ONLY to the provider that declared them. */
  readonly requestExtras: Readonly<Record<string, unknown>>;
  readonly maxCompletionTokens?: number;
  /** The secret. Held here, never described, never logged. */
  readonly apiKey?: string;
}

/** Everything about a profile that MAY appear in evidence. Deliberately not the key. */
export interface ProviderDescriptor {
  readonly provider: string;
  readonly endpoint: string;
  readonly configuredModel: string;
  readonly authStyle: AuthStyle;
  readonly streamingRequested: boolean;
  readonly keyed: boolean;
  /**
   * A digest of the key, truncated. Enough to tell two credentials apart in an audit and to notice
   * a rotation; not enough to reconstruct one.
   */
  readonly keyFingerprint: string;
}

function readCredential(name: string): string | undefined {
  const directory = process.env['CREDENTIALS_DIRECTORY'];
  if (typeof directory !== 'string' || directory.length === 0) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, name), 'r');
    const value = readFileSync(fd, 'utf8').trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function asStringRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

let cached: ProviderProfile | null | undefined;

/**
 * The live provider profile, or undefined when this deployment has none.
 *
 * Undefined is a real answer and a safe one: the driver then runs on its compiled-in default with
 * no key, and the first model call fails loudly at the provider rather than quietly somewhere
 * else. A deployment that cannot read its provider record has not been given a provider.
 */
export function providerProfile(): ProviderProfile | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const raw = readCredential(CREDENTIAL);
  if (raw === undefined) { cached = null; return undefined; }
  let record: Record<string, unknown>;
  try {
    record = asStringRecord(JSON.parse(raw));
  } catch {
    cached = null;
    return undefined;
  }
  if (record['schema'] !== SCHEMA) { cached = null; return undefined; }

  const provider = typeof record['provider'] === 'string' ? record['provider'] : '';
  const baseUrl = typeof record['baseUrl'] === 'string' ? record['baseUrl'] : '';
  const model = typeof record['model'] === 'string' ? record['model'] : '';
  if (provider.length === 0 || baseUrl.length === 0 || model.length === 0) { cached = null; return undefined; }
  const authStyle: AuthStyle = record['authStyle'] === 'api-key' ? 'api-key' : 'bearer';
  const apiKey = typeof record['apiKey'] === 'string' && record['apiKey'].length > 0
    ? record['apiKey'] : undefined;

  cached = {
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    authStyle,
    streaming: record['streaming'] === true,
    requestExtras: Object.freeze(asStringRecord(record['requestExtras'])),
    ...(typeof record['maxCompletionTokens'] === 'number'
      ? { maxCompletionTokens: record['maxCompletionTokens'] } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
  return cached;
}

/** The publishable description of a profile. Never the key. */
export function describe(profile: ProviderProfile | undefined): ProviderDescriptor | undefined {
  if (profile === undefined) return undefined;
  return {
    provider: profile.provider,
    endpoint: profile.baseUrl,
    configuredModel: profile.model,
    authStyle: profile.authStyle,
    streamingRequested: profile.streaming,
    keyed: profile.apiKey !== undefined,
    keyFingerprint: profile.apiKey === undefined
      ? 'none'
      : createHash('sha256').update(profile.apiKey).digest('hex').slice(0, 16),
  };
}

/** Test seam: forget the cached read. Never used by production code. */
export function resetProviderProfileCache(): void {
  cached = undefined;
}
