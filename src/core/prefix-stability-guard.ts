/**
 * THE STABLE HEAD IS NOT A PLACE FOR PER-TURN CONTEXT.
 *
 * A measured fact, not a theory: the assembled request's system head is byte-stable across
 * ordinary turns, tool calls, tool results, and elapsed time, and each request is a strict
 * append-extension of the one before it. That is what lets a provider reuse its prompt cache.
 *
 * Two optional layers can break it. Ambient shared-memory recall and truth-cognition are both
 * computed PER TURN and were folded into `personaPreamble` — the first line of the system
 * prompt. Instrumented, they moved the first differing byte to offset ~100-113 of the request:
 * not a tail edit but a rewrite of the head, discarding the whole cached prefix on every turn.
 * Truth-cognition is a function of the current task, so it changes by construction.
 *
 * Neither layer is enabled in production, and this guard is what keeps "not enabled" from
 * quietly becoming "enabled and silently expensive". It does not redesign either layer: the
 * correct home for per-turn context is the append-only history channel that already carries
 * tool results and governor directives, and until a contributor uses that channel, turning
 * these on FAILS CLOSED with the reason stated.
 *
 * @module core/prefix-stability-guard
 */

/** Environment variables that enable a per-turn context contributor. */
export const PREFIX_RISK_FLAGS = Object.freeze({
  /** Enables ambient shared-memory recall (`LAB_MEMORY_ON` is derived from its presence). */
  LAB_TRANSCRIPT_DIR: 'ambient shared-memory recall',
  /** Enables truth-cognition, whose text is a function of the current task. */
  LAB_TRUTH: 'truth-cognition',
} as const);

export class PrefixStabilityError extends Error {
  override readonly name = 'PrefixStabilityError';
  constructor(message: string) {
    super(message);
  }
}

/** Which risk flags are currently on, by the same rule the server uses to read them. */
export function enabledPrefixRiskFlags(env: NodeJS.ProcessEnv): string[] {
  const on: string[] = [];
  // `LAB_MEMORY_ON` is `!!process.env.LAB_TRANSCRIPT_DIR` — presence, not a value.
  if (typeof env['LAB_TRANSCRIPT_DIR'] === 'string' && env['LAB_TRANSCRIPT_DIR'].length > 0) {
    on.push('LAB_TRANSCRIPT_DIR');
  }
  // `LAB_TRUTH_ON` is the exact string '1'.
  if (env['LAB_TRUTH'] === '1') on.push('LAB_TRUTH');
  return on;
}

/**
 * Refuse to fold per-turn context into the stable head.
 *
 * Called at the one place that would do it. A deployment with neither flag set never reaches
 * the throw, so production behaviour is unchanged; a deployment that turns one on is told
 * exactly what it would cost and what the alternative is, instead of paying it invisibly.
 *
 * @param env the process environment to read the flags from.
 * @param hasPerTurnContext whether this turn actually produced dynamic context to fold.
 * @throws {PrefixStabilityError} when per-turn context would enter the persona/system head.
 */
export function assertDynamicContextIsPrefixSafe(
  env: NodeJS.ProcessEnv,
  hasPerTurnContext: boolean,
): void {
  if (!hasPerTurnContext) return;
  const enabled = enabledPrefixRiskFlags(env);
  if (enabled.length === 0) return;
  const named = enabled
    .map((f) => `${f} (${PREFIX_RISK_FLAGS[f as keyof typeof PREFIX_RISK_FLAGS]})`)
    .join(' and ');
  throw new PrefixStabilityError(
    `refusing to fold per-turn context into the system head: ${named} is enabled. ` +
      'That content is recomputed every turn, so folding it into personaPreamble rewrites the ' +
      'first bytes of the request and discards the provider prompt cache on every turn ' +
      '(measured: first divergence at byte ~100 of the system prompt). Per-turn context ' +
      'belongs on the append-only history channel, appended after the retained transcript, ' +
      'where it is paid once and prefix-cached thereafter. Until a contributor uses that ' +
      'channel, unset the flag.',
  );
}
