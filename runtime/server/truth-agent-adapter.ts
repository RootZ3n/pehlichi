/**
 * Vendorable Truth enforcement adapter for TypeScript hosts.
 *
 * Copy this file, byte for byte, into any TypeScript agent that must speak
 * `truth-agent-enforcement/v1`. It deliberately imports nothing from the Truth Firewall
 * package — only Node built-ins — so a distribution can carry it without depending on a
 * sibling repository, and so several agents that must remain byte-identical can vendor
 * the identical file.
 *
 * It contains no verifier logic. Authority lives in exactly one implementation, reached
 * over a subprocess boundary; this file's whole job is to hand that implementation a
 * typed request and hand the host back a typed decision plus the exact bytes it may
 * deliver.
 *
 * The host contract is two functions and one rule:
 *
 *   containmentPlaceholder()   — all the host may emit BEFORE a decision exists
 *   decision.deliverable()     — all the host may emit AFTER
 *
 * A host that emits nothing else on a channel cannot leak unauthorized model text there.
 * That is what the conformance suite checks, and it checks it by looking at what escapes
 * rather than at what the source appears to do.
 *
 * Integration checklist for a new host:
 *
 *   1. Capture each repository's HEAD BEFORE the model receives mutation tools, and mint
 *      an attestation with `mintTrustedBase` if the binding must survive a restart.
 *   2. Record host events from the tool dispatcher — never from the model's narration.
 *   3. Buffer model output; emit only `containmentPlaceholder()` while generating.
 *   4. Call `finalizeTurn` exactly once per turn, on every path that can produce output,
 *      including errors, timeouts, cancellations and early returns.
 *   5. Deliver, persist and speak `decision.deliverable()` — the same string everywhere.
 *   6. Branch machine status on `decision.ok()` / `decision.blocked()`, never on text.
 *   7. Run `truth conformance --adapter <your harness>` and fix what it finds.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const ENFORCEMENT_PROTOCOL = 'truth-agent-enforcement/v1' as const;
export const ADAPTER_VERSION = '1.0.0' as const;
export const NARRATIVE_GUTTER = '│ ';

export type LifecycleSituation =
  | 'advisory-conversation' | 'partial-work' | 'blocked-work' | 'completion'
  | 'commit' | 'promotion' | 'release' | 'tool-mutation';

export type OutputChannel =
  | 'interactive-cli' | 'tui' | 'gateway-message' | 'api-response' | 'api-stream'
  | 'speech' | 'file-artifact' | 'delegation-result' | 'background-report'
  | 'plugin-surface' | 'desktop' | 'acp';

export type HostEventKind =
  | 'file-mutation' | 'repository-mutation' | 'commit' | 'tag' | 'branch' | 'promotion'
  | 'release' | 'deployment' | 'package-publication' | 'database-mutation'
  | 'remote-api-mutation' | 'cloud-resource-mutation' | 'service-mutation'
  | 'generated-artifact' | 'external-message' | 'delegated-mutation' | 'plugin-mutation'
  | 'background-mutation' | 'unknown-mutation';

export interface HostEvent {
  readonly kind: HostEventKind;
  /** Dispatcher-side identity of the tool, wrapper, plugin or subagent. */
  readonly source: string;
  readonly repository?: string;
  readonly paths?: readonly string[];
  readonly detail?: string;
  /** True when the host could not classify a mutating source. Elevates conservatively. */
  readonly unclassified?: boolean;
}

export interface TrustedRepositoryBinding {
  readonly repository: string;
  readonly commit: string;
  /** JSON attestation from `truth trusted-base mint`. Required after a process boundary. */
  readonly attestation?: string;
  readonly operatorReauthorized?: boolean;
}

export interface ProposedClaim {
  readonly class: 'OBSERVED' | 'DERIVED' | 'ASSUMED' | 'PROPOSED';
  readonly type: string;
  readonly statement: string;
  readonly scope?: Record<string, unknown>;
}

export interface EnforcementResponse {
  readonly protocol: string;
  readonly outcome: string;
  readonly authoritative: boolean;
  readonly completionBlocked: boolean;
  readonly failureReason: string;
  readonly finalRendering: string;
  readonly renderingSha256: string;
  readonly finalizationNonce: string;
  readonly diagnostics?: readonly string[];
  readonly [key: string]: unknown;
}

export interface Decision {
  readonly response: EnforcementResponse;
  /** The only bytes the host may present on this channel. */
  deliverable(): string;
  /** True when the host may report success to a machine consumer. */
  ok(): boolean;
  /** True when the host must clear its completion bit. */
  blocked(): boolean;
}

export interface AdapterConfig {
  /** Stable agent name: `pehlichi`, `loony-luna`, `mad-ptah`, ... */
  readonly agent: string;
  /** Host runtime family, e.g. `ts-trio-tui`. */
  readonly runtime: string;
  /** Explicit path to the Truth CLI. Falls back to `TRUTH_CLI_PATH`, then PATH. */
  readonly cliPath?: string;
  readonly nodePath?: string;
  readonly timeoutMs?: number;
}

export interface FinalizeInput {
  readonly taskId: string;
  readonly sessionId: string;
  readonly userOperation: string;
  readonly situation: LifecycleSituation;
  readonly outputChannel: OutputChannel;
  readonly workspace: string;
  readonly candidateNarrative: string;
  readonly hostEvents?: readonly HostEvent[];
  readonly trustedRepositories?: readonly TrustedRepositoryBinding[];
  readonly proposedClaims?: readonly ProposedClaim[];
  readonly toolIdentities?: readonly string[];
  readonly requiredReceipts?: readonly { id: string; description: string; satisfied: boolean }[];
}

// Anything a terminal or Markdown renderer would act on rather than show. Mirrors the
// verifier's own sanitiser so a locally-rendered refusal is exactly as inert as an
// authorized report.
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][\s\S]*?(?:\u0007|\u001B\\)|[@-Z\\-_])/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const FORMAT_CHARACTERS =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sanitize(text: string): string {
  return (text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_SEQUENCE, '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(FORMAT_CHARACTERS, '');
}

/** Transport-level liveness text. Carries no model-generated semantic content. */
export function containmentPlaceholder(): string {
  return '… working (response held until Truth Firewall authorization completes)';
}

export interface ResolvedRuntime {
  readonly node: string;
  readonly module: string;
  readonly packageRoot: string;
  readonly moduleSha256: string;
}

/**
 * Split one `exec` line the way a POSIX shell would, honouring single and double quotes.
 *
 * A naive whitespace split is wrong here: an installed wrapper may quote its module path
 * (`exec node '/path/to/cli.js' "$@"`), and a parser that keeps the quote characters
 * concludes the path is not absolute and silently resolves nothing. Silently resolving
 * nothing is the dangerous outcome — the host then behaves as if no verifier is installed.
 *
 * Returns null for an unterminated quote rather than guessing at the author's intent.
 */
function shellTokens(line: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Locate the installed Truth entrypoint and hash it locally.
 *
 * Never ask the CLI to describe itself: a compromised installation reports whatever it is
 * asked for, so an identity derived from its own output proves nothing.
 */
export function resolveTruthRuntime(config: AdapterConfig): ResolvedRuntime | null {
  let entry = config.cliPath ?? process.env.TRUTH_CLI_PATH ?? '';
  if (!entry) {
    const which = spawnSync('which', ['truth'], { encoding: 'utf8' });
    if (which.status !== 0) return null;
    entry = (which.stdout ?? '').trim().split('\n')[0];
  }
  if (!entry || !existsSync(entry)) return null;

  let modulePath = realpathSync(entry);
  if (!/\.(?:js|mjs|cjs)$/.test(modulePath)) {
    // Supported installed form: a one-line `exec node /abs/path/cli.js "$@"` shim.
    const exec = readFileSync(modulePath, 'utf8')
      .split('\n').map((line) => line.trim()).find((line) => line.startsWith('exec '));
    if (!exec) return null;
    const tokens = shellTokens(exec);
    if (!tokens || tokens.length < 3) return null;
    if (tokens[0] !== 'exec' || basename(tokens[1]) !== 'node') return null;
    if (!tokens[2].startsWith('/') || !existsSync(tokens[2])) return null;
    modulePath = realpathSync(tokens[2]);
  }

  let packageRoot: string | null = null;
  let dir = dirname(modulePath);
  for (let depth = 0; depth < 32; depth++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'truth-firewall') {
          packageRoot = dir;
          break;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!packageRoot) return null;

  return {
    node: config.nodePath ?? process.execPath,
    module: modulePath,
    packageRoot,
    moduleSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex')
  };
}

/** Package managers the verifier may need to run a repository's policy-owned scripts. */
const POLICY_EXECUTABLES = ['npm', 'pnpm', 'yarn', 'bun', 'node'];

/**
 * Directories holding the package managers resolvable right now.
 *
 * Scrubbing PATH down to the system directories alone is tempting and wrong: on a machine
 * where npm lives under `~/.local/bin`, it turns every policy check into "executable not
 * resolvable" — a fail-closed result, but for a reason that has nothing to do with the
 * candidate. The directories admitted here are the ones holding executables that resolve
 * from the host's own PATH before the scrub, and the verifier still refuses any evidence
 * executable whose bytes differ from what it measured.
 */
function policyPathDirectories(): string[] {
  const directories: string[] = [];
  for (const name of POLICY_EXECUTABLES) {
    const which = spawnSync('which', [name], { encoding: 'utf8' });
    if (which.status !== 0) continue;
    const found = (which.stdout ?? '').trim().split('\n')[0];
    if (!found) continue;
    // The directory the shim lives in, not the directory its symlink chain ends in. A
    // package manager finds its own internals relative to how it was invoked, so handing
    // the verifier npm's internal `lib/node_modules/npm/bin` would make `which npm`
    // resolve to a copy that cannot locate itself.
    const directory = dirname(resolve(found));
    if (!directories.includes(directory)) directories.push(directory);
  }
  return directories;
}

/**
 * The verifier's environment. NODE_OPTIONS, loader and preload flags execute arbitrary
 * code inside the process that is supposed to be the trust anchor, so they are not
 * inherited — and the verifier independently refuses if it finds them anyway.
 *
 * Governed temporary variables (TMPDIR, TMP, TEMP, PEHVERSE_TEMP_ROOT) are always
 * included so the Truth Firewall child receives the same validated private governed
 * temporary authority as the host. Without them the child falls back to /tmp and its
 * untrusted-executable guard misses the governed root.
 *
 * This function never throws. Every failure path produces a usable (if degraded)
 * environment rather than propagating an exception into the caller's error handling.
 * The child's own authority will fail closed if the variables are absent or unsafe.
 */
function verifierEnv(): NodeJS.ProcessEnv {
  const pathDirs = [
    ...policyPathDirectories(),
    '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'
  ];
  // Read governed temp variables from the environment. The governed-launch wrapper
  // (or deployment Environment) sets these before this process starts. We pass them
  // through without validation — the child's own authority fails closed on bad values.
  const tmpdir = process.env.TMPDIR ?? '';
  const tmp = process.env.TMP ?? '';
  const temp = process.env.TEMP ?? '';
  const tempRoot = process.env.PEHVERSE_TEMP_ROOT ?? '';
  return {
    PATH: [...new Set(pathDirs)].join(':'),
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    NO_COLOR: '1',
    CI: 'true',
    TMPDIR: tmpdir,
    TMP: tmp,
    TEMP: temp,
    PEHVERSE_TEMP_ROOT: tempRoot,
    ...(process.env.TRUTH_HOST_KEY_PATH ? { TRUTH_HOST_KEY_PATH: process.env.TRUTH_HOST_KEY_PATH } : {})
  };
}

function localRefusal(input: FinalizeInput, reason: string, nonce: string): EnforcementResponse {
  const sanitized = sanitize(input.candidateNarrative);
  const id = sha256(sanitized).slice(0, 16);
  const body = sanitized.length === 0
    ? [`${NARRATIVE_GUTTER}(the model produced no narrative)`]
    : sanitized.split('\n').map((line) => `${NARRATIVE_GUTTER}${line}`);
  const rendering = [
    'Outcome: BLOCKED',
    'Authoritative: no',
    `Protocol: ${ENFORCEMENT_PROTOCOL}`,
    'Failure Reason: truth-unavailable',
    '',
    'Authority Diagnostics:',
    `- ${reason}`,
    '',
    `--- BEGIN INERT MODEL NARRATIVE [${id}] --- not verified; asserts nothing`,
    ...body,
    `--- END INERT MODEL NARRATIVE [${id}] ---`,
    '',
    'End of report — Outcome: BLOCKED, Authoritative: no. ' +
    'Only lines above outside the inert narrative were produced by the host adapter.'
  ].join('\n') + '\n';
  return {
    protocol: ENFORCEMENT_PROTOCOL,
    outcome: 'BLOCKED',
    authoritative: false,
    completionBlocked: true,
    failureReason: 'truth-unavailable',
    finalRendering: rendering,
    renderingSha256: sha256(rendering),
    finalizationNonce: nonce,
    diagnostics: [reason]
  };
}

/**
 * Mint a host attestation for a base captured before the model received tools.
 *
 * Only needed when the binding must survive a process boundary. A live in-process binding
 * is already host-held; a persisted one is a file the model can write, and a file the
 * model can write is not an anchor.
 */
export function mintTrustedBase(
  config: AdapterConfig,
  context: {
    agent: string; taskId: string; sessionId: string;
    repositoryRoot: string; repositoryIdentity: string; commit: string;
  },
  runtime?: ResolvedRuntime | null
): string | null {
  const resolved = runtime === undefined ? resolveTruthRuntime(config) : runtime;
  if (!resolved) return null;
  const result = spawnSync(resolved.node, [resolved.module, 'trusted-base', 'mint', '--json'], {
    input: JSON.stringify({ context }),
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
    env: verifierEnv()
  });
  if (result.status !== 0 || !(result.stdout ?? '').trim()) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { protocol?: string };
    return parsed.protocol === 'truth-agent-enforcement/trusted-base/1' ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Cross the authority boundary. Never returns raw model text, and never returns null.
 *
 * Truth being unreachable is the moment a naive integration falls back to the model's own
 * words — the worst possible moment to trust them, because nothing checked them. Every
 * failure path here produces a trusted refusal instead.
 */
export function finalizeTurn(
  config: AdapterConfig,
  input: FinalizeInput,
  runtime?: ResolvedRuntime | null
): Decision {
  const nonce = `tae1-${randomUUID()}`;
  const resolved = runtime === undefined ? resolveTruthRuntime(config) : runtime;
  const wrap = (response: EnforcementResponse): Decision => ({
    response,
    deliverable: () => response.finalRendering,
    ok: () => response.authoritative === true || response.outcome === 'ADVISORY',
    blocked: () => response.completionBlocked !== false
  });

  if (!resolved) {
    return wrap(localRefusal(input, 'the installed Truth Firewall could not be resolved; unverified model output is withheld', nonce));
  }

  const request = {
    protocol: ENFORCEMENT_PROTOCOL,
    runtime: { agent: config.agent, runtime: config.runtime, adapterVersion: ADAPTER_VERSION },
    taskId: input.taskId,
    sessionId: input.sessionId,
    userOperation: input.userOperation,
    situation: input.situation,
    outputChannel: input.outputChannel,
    hostEvents: input.hostEvents ?? [],
    trustedRepositories: input.trustedRepositories ?? [],
    workspace: input.workspace,
    proposedClaims: input.proposedClaims ?? [],
    candidateNarrative: input.candidateNarrative,
    toolIdentities: input.toolIdentities ?? [],
    requiredReceipts: input.requiredReceipts ?? [],
    finalizationNonce: nonce,
    timeoutMs: config.timeoutMs ?? 360_000
  };

  const result = spawnSync(resolved.node, [resolved.module, 'finalize', '--json'], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: config.timeoutMs ?? 360_000,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    env: verifierEnv()
  });

  if (result.error || typeof result.stdout !== 'string' || result.stdout.trim().length === 0) {
    const detail = result.error?.message ?? (result.stderr ?? '').trim().slice(0, 300);
    return wrap(localRefusal(input, `the Truth Firewall finalization process produced no usable response: ${detail}`, nonce));
  }

  let response: EnforcementResponse;
  try {
    response = JSON.parse(result.stdout) as EnforcementResponse;
  } catch (error) {
    return wrap(localRefusal(input, `the Truth Firewall finalization response was not valid JSON: ${(error as Error).message}`, nonce));
  }

  // Bind the answer to this request. A response naming another protocol or another nonce,
  // or one whose rendering does not match its own digest, is not this finalization's
  // answer whatever it says about itself.
  if (response.protocol !== ENFORCEMENT_PROTOCOL) {
    return wrap(localRefusal(input, `the Truth Firewall answered with protocol ${String(response.protocol)}`, nonce));
  }
  if (response.finalizationNonce !== nonce) {
    return wrap(localRefusal(input, 'the Truth Firewall response does not answer this finalization', nonce));
  }
  if (typeof response.finalRendering !== 'string' || sha256(response.finalRendering) !== response.renderingSha256) {
    return wrap(localRefusal(input, 'the Truth Firewall rendering does not match its own digest', nonce));
  }
  return wrap(response);
}
