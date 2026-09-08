/**
 * THE IKBI ADAPTER — a translation, not a second platform.
 *
 * ikbi already owns the work-order contract, the mutation-scope refusal, the frozen goal digest,
 * the candidate/verification/promotion state machine and the receipt ledger. This file adds none
 * of that. It turns a governed Trio request into the exact argument vector ikbi's canonical v2
 * engine expects, and stops.
 *
 * NO SHELL, EVER. Every value below is untrusted: the goal is model-authored, the paths and checks
 * arrive from a request, and a task id can be anything. They are placed into an ARGV — never
 * concatenated into a command line — so quoting cannot be escaped and a `;` is a semicolon rather
 * than a second command. Values that could be read as OPTIONS are refused rather than passed,
 * because `--allow-repo-wide` smuggled through an allow-path is a scope widening that no amount of
 * downstream verification would notice.
 *
 * LEGACY IS NOT USED. `ikbi run --spec` is the v1 engine and `ikbi inspect` does not know v2 run
 * ids; neither appears here.
 */
import type { AcceptanceCheck } from './route.js';

export type LocalMode = 'off' | 'assist' | 'auto';

export interface IkbiInvocation {
  /** The ikbi CLI entry (an absolute path to its `dist/cli/index.js`). */
  readonly cliPath: string;
  readonly repository: string;
  readonly goal: string;
  readonly allowedPaths: readonly string[];
  readonly checks: readonly AcceptanceCheck[];
  readonly localMode: LocalMode;
  /** Model profile. The working route today is `deepseek`. */
  readonly profile: string;
  /** Whole-session model-call ceiling. Used because DeepSeek carries no catalog price. */
  readonly maxInvocations: number;
  readonly maxBuilderTurns: number;
  readonly timeoutMs: number;
  /** Loopback base for the local specialist, when local mode is not `off`. */
  readonly bokahliBaseUrl?: string;
}

export class IkbiAdapterRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'IkbiAdapterRefusal';
  }
}

/**
 * A value that is safe to CARRY. Rejects the two things that are never legitimate content —
 * a NUL byte and an embedded newline — and nothing else.
 */
function assertDataValue(kind: string, value: string): void {
  if (value.length === 0) throw new IkbiAdapterRefusal(`${kind}_empty`, `${kind} is empty`);
  if (value.includes('\0')) throw new IkbiAdapterRefusal(`${kind}_nul`, `${kind} contains a NUL byte`);
  if (/[\r\n]/.test(value)) throw new IkbiAdapterRefusal(`${kind}_newline`, `${kind} contains a newline`);
}

/**
 * A value that is safe to place in the ARGV.
 *
 * The leading-dash rule belongs HERE and only here. A value that lands in ikbi's command line and
 * begins with `-` is read by its parser as a flag, so `--allow-repo-wide` arriving as an allow-path
 * would widen the very scope this adapter exists to pin. A check's ARGUMENTS are a different
 * animal: they travel inside `IKBI_CHECKS` as JSON and are handed to the check process, where
 * `--test` is ordinary and forbidding it would ban most real test commands.
 */
function assertPlainValue(kind: string, value: string): void {
  assertDataValue(kind, value);
  if (value.startsWith('-')) {
    throw new IkbiAdapterRefusal(`${kind}_option_like`, `${kind} ${JSON.stringify(value)} would be read as an option`);
  }
}

/** A repository-relative path that cannot climb out or turn into a flag. */
export function assertRelativePath(kind: string, value: string): void {
  assertPlainValue(kind, value);
  if (value.startsWith('/')) throw new IkbiAdapterRefusal(`${kind}_absolute`, `${kind} must be repository-relative`);
  const segs = value.split('/');
  if (segs.includes('..')) throw new IkbiAdapterRefusal(`${kind}_traversal`, `${kind} escapes the repository`);
}

/**
 * Build the argv for ikbi's canonical v2 build, plus the environment it reads its bounds from.
 *
 * Scope is ALWAYS explicit: this adapter has no path that produces `--allow-repo-wide`, so a Trio
 * request cannot widen itself into a repository-wide mutation even by accident.
 */
export function buildIkbiArgv(inv: IkbiInvocation): { argv: string[]; env: Record<string, string> } {
  assertPlainValue('goal', inv.goal);
  assertPlainValue('repository', inv.repository);
  assertPlainValue('profile', inv.profile);
  if (!inv.repository.startsWith('/')) {
    throw new IkbiAdapterRefusal('repository_not_absolute', 'repository must be an absolute path');
  }
  if (inv.allowedPaths.length === 0) {
    throw new IkbiAdapterRefusal('mutation_scope_missing', 'refusing to invoke an implementation with no declared mutation scope');
  }
  for (const p of inv.allowedPaths) assertRelativePath('allow_path', p);
  if (inv.checks.length === 0) {
    throw new IkbiAdapterRefusal('acceptance_criteria_missing', 'refusing to invoke an implementation with no deterministic check');
  }
  for (const c of inv.checks) {
    assertPlainValue('check_name', c.name);
    assertPlainValue('check_command', c.command);
    for (const a of c.args) assertDataValue('check_arg', a);
    if (c.cwd !== undefined) assertRelativePath('check_cwd', c.cwd);
  }
  if (!Number.isSafeInteger(inv.maxInvocations) || inv.maxInvocations < 1) {
    throw new IkbiAdapterRefusal('bounds_invalid', 'maxInvocations must be a positive integer');
  }
  if (!Number.isSafeInteger(inv.maxBuilderTurns) || inv.maxBuilderTurns < 1) {
    throw new IkbiAdapterRefusal('bounds_invalid', 'maxBuilderTurns must be a positive integer');
  }

  const argv = [
    inv.cliPath, 'build', inv.goal,
    '--repo', inv.repository,
    '--profile', inv.profile,
    '--local-mode', inv.localMode,
    '--json',
  ];
  for (const p of inv.allowedPaths) argv.push('--allow-path', p);

  const env: Record<string, string> = {
    IKBI_CHECKS: JSON.stringify(inv.checks.map((c) => ({
      name: c.name, command: c.command, args: [...c.args], ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
    }))),
    // A dollar ceiling refuses outright when the model has no catalog price, so the session is
    // bounded by CALLS instead. Both are ceilings; only one of them can be evaluated here.
    IKBI_V2_MAX_INVOCATIONS: String(inv.maxInvocations),
    IKBI_V2_MAX_BUILDER_TURNS: String(inv.maxBuilderTurns),
  };
  if (inv.localMode !== 'off' && inv.bokahliBaseUrl !== undefined) {
    assertPlainValue('bokahli_base_url', inv.bokahliBaseUrl);
    env['IKBI_BOKAHLI_BASE_URL'] = inv.bokahliBaseUrl;
  }
  return { argv, env };
}
