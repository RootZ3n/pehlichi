/**
 * Bokahli — local inference on Mushin, as a Trio model target.
 *
 * `model-switch.ts` opens by saying every target is an OpenAI-compatible CLOUD
 * endpoint and that there are "no on-device/local models by design". This module
 * is the considered change to that, and the design note is worth keeping rather
 * than deleting: the reason there were no local models is that a local box is
 * usually a worse cloud endpoint — same interface, less capacity, more ways to
 * be down. Bokahli is not that. It is an endpoint that *refuses*, and the
 * refusals are the reason to route to it.
 *
 * Three things follow, and they are the whole of this file.
 *
 * ## A refusal is not a failure
 *
 * Bokahli serves one attested artifact at a time and will not substitute. When
 * it cannot serve a request it answers HTTP 200 with a typed `ESCALATE` or
 * `REFUSED` — the API worked, the answer is "no". Every generic OpenAI client,
 * including the `MimoDriver` this wraps, reads that as an ordinary response and
 * would hand the caller an empty completion; a resilient driver reads a failure
 * and trips a circuit breaker over a deployment that is perfectly healthy.
 *
 * Neither is right. `BokahliEscalation` makes the refusal a typed error the
 * session can act on, and `terminatesChain` marks the ones that must not become
 * a paid cloud call. `RUNTIME_UNHEALTHY` is deliberately exempt — that one
 * means "temporarily down", not "unwilling", and refusing to fall back on it
 * would turn every restart into an outage.
 *
 * ## Local-only means local-only
 *
 * `localOnly` is not a preference or a routing hint. When it is set, a refusal
 * ends the turn and says why. The failure it exists to prevent is the quiet one:
 * a user picks the local model precisely because the content should not leave
 * the machine, Bokahli declines, the runtime helpfully falls through to MiniMax,
 * and the answer comes back excellent. Nothing looks wrong. The data is gone.
 *
 * Falling back is still allowed, through `governedFallback`, which has to be
 * turned on deliberately and is reported in the outcome when it fires.
 *
 * ## The token is a file, and the tools stay home
 *
 * Every cloud target here takes its key from the environment, which is right for
 * a vendor API key and wrong for this one — it would put the value in
 * `/proc/<pid>/environ` of a long-lived server. `readBokahliToken` reads a
 * mode-0600 file and refuses anything looser, before reading it, because a
 * warning about a leaked credential arrives after the leak.
 *
 * And no tool definitions are ever forwarded. Bokahli is an inference endpoint,
 * not an agent: it has no business being handed the Trio's tool authority, and
 * `assertNoToolAuthority` makes that a checked property rather than a habit.
 *
 * This file is governed common. It must stay byte-identical across Pehlichi,
 * Loony-Luna and Mad-Ptah; anything that genuinely differs between them belongs
 * in validated configuration, not here.
 */

import { readFileSync, statSync } from 'node:fs';

/** Contract this adapter is written against. Bokahli pins it by digest on its side. */
export const BOKAHLI_CLIENT_CONTRACT = 'bokahli.client/1' as const;

/** Default loopback endpoint; a tailnet address reaches a Mushin that is not this host. */
export const BOKAHLI_DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';

/**
 * Escalation reasons, from `bokahli.client/1`.
 *
 * A duplicate of a list that lives in another repository, kept as data because
 * the Trio must not take a build dependency on the Bokahli monorepo to speak
 * HTTP to it. What keeps the copy honest is the live integration test, not this
 * declaration.
 */
export const BOKAHLI_ESCALATE_REASONS = [
  'NO_LOCAL_CANDIDATES',
  'NO_QUALIFIED_LOCAL_ROUTE',
  'REQUIREMENTS_UNMET',
  'CONTEXT_EXCEEDS_LOCAL_CAPABILITY',
  'CAPABILITY_UNSUPPORTED',
  'MODEL_NOT_QUALIFIED_FOR_TASK',
  'LOCAL_MODEL_SWAP_REQUIRED',
  'RUNTIME_UNHEALTHY',
] as const;

export type BokahliEscalateReason = (typeof BOKAHLI_ESCALATE_REASONS)[number];

/** Refusals. An EXACT request that named a digest cannot be honoured by anything else. */
export const BOKAHLI_REFUSE_REASONS = [
  'EXACT_IDENTITY_UNKNOWN',
  'EXACT_IDENTITY_NOT_PUBLIC',
  'EXACT_DIGEST_MISMATCH',
] as const;

export type BokahliRouteMode = 'AUTO' | 'PROFILE' | 'EXACT';

/** Requirements a PROFILE request states. Bokahli never weakens one to find a match. */
export interface BokahliProfileRequirements {
  readonly minContextTokens?: number;
  readonly requiredCapabilities?: readonly string[];
  readonly quantizationDenyList?: readonly string[];
  readonly requireQualified?: boolean;
}

/**
 * A Bokahli routing target.
 *
 * The three modes are genuinely different questions, not three ways to ask one:
 * `AUTO` asks Bokahli to choose, `PROFILE` states requirements and accepts
 * whatever satisfies them, and `EXACT` names an artifact and its digest and
 * accepts nothing else. `EXACT` is the mode for reproducibility — it will
 * refuse rather than serve a substitute, which is the entire point of it.
 */
export interface BokahliTarget {
  readonly baseUrl: string;
  /** Path to a mode-0600 file. Never the token itself. */
  readonly tokenFile: string;
  readonly mode: BokahliRouteMode;
  /** EXACT only; both required together. */
  readonly modelId?: string;
  readonly artifactDigest?: string;
  /** PROFILE only. */
  readonly requirements?: BokahliProfileRequirements;
  /**
   * Demand qualification. On the current deployment nothing is qualified, so
   * this escalates — which is the honest answer, and the one a caller that
   * needs a vouched-for model should be asking for.
   */
  readonly requireQualified?: boolean;
  /** Named task class. Qualification is always for a specific task class. */
  readonly taskClass?: string;
  /** A refusal ends the turn instead of reaching any other provider. */
  readonly localOnly?: boolean;
  /** Opt in to falling back on refusal. Reported in the outcome when it fires. */
  readonly governedFallback?: boolean;
}

/** What Bokahli attested about the artifact that served a request. */
export interface BokahliBinding {
  readonly outcome: string;
  readonly modelId: string;
  readonly artifactDigest: string;
  readonly servedContextTokens?: number;
  readonly runtimeBuild?: string;
  readonly attested: boolean;
  readonly attestationMethod?: string;
  readonly qualificationStatus: string;
  readonly qualificationAuthority: string;
  readonly requestId?: string;
}

/**
 * A local deployment declining to serve.
 *
 * `terminatesChain` is what callers read. True for every reason except
 * `RUNTIME_UNHEALTHY`, because the rest describe a decision about what this
 * deployment is willing to serve, and reaching past that decision to another
 * provider does not address it — it bypasses it.
 */
export class BokahliEscalation extends Error {
  readonly reason: BokahliEscalateReason | 'UNKNOWN';
  readonly detail: string;
  readonly terminatesChain: boolean;
  readonly retriable: boolean;
  readonly swapCandidates: readonly { modelId: string; coldLoadSeconds: number | null }[];

  constructor(opts: {
    reason: BokahliEscalateReason | 'UNKNOWN';
    detail: string;
    swapCandidates?: readonly { modelId: string; coldLoadSeconds: number | null }[];
  }) {
    super(`bokahli declined: ${opts.reason} — ${opts.detail}`);
    this.name = 'BokahliEscalation';
    this.reason = opts.reason;
    this.detail = opts.detail;
    this.retriable = opts.reason === 'RUNTIME_UNHEALTHY';
    this.terminatesChain = !this.retriable;
    this.swapCandidates = opts.swapCandidates ?? [];
  }
}

/**
 * Read the API token, refusing a file readable by anyone but its owner.
 *
 * Checked before the read. Warning afterwards would mean the secret is already
 * loaded into a process that is about to use it, and the deployment stays broken
 * until someone notices a log line.
 */
export function readBokahliToken(path: string): string {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    throw new Error(
      `bokahli token file is not readable at ${path}; create it with mode 0600`,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `bokahli token file ${path} has mode ${mode.toString(8).padStart(4, '0')}; ` +
        `it must not be readable by group or others (chmod 600 ${path})`,
    );
  }
  const token = readFileSync(path, 'utf8').trim();
  if (token === '') throw new Error(`bokahli token file ${path} is empty`);
  return token;
}

/**
 * Build the route spec for a target.
 *
 * `EXACT` requires both an id and a digest, and throws without them rather than
 * silently degrading to `AUTO`. A caller who asked for a specific artifact and
 * quietly got whatever was loaded has been given the one answer `EXACT` exists
 * to make impossible.
 */
export function buildRouteSpec(t: BokahliTarget): Record<string, unknown> {
  if (t.mode === 'EXACT') {
    if (t.modelId === undefined || t.artifactDigest === undefined) {
      throw new Error(
        'EXACT routing requires both modelId and artifactDigest; refusing to fall back to AUTO',
      );
    }
    return { mode: 'EXACT', modelId: t.modelId, artifactDigest: t.artifactDigest };
  }
  if (t.mode === 'PROFILE') {
    return {
      mode: 'PROFILE',
      requirements: {
        ...(t.requirements ?? {}),
        ...(t.requireQualified === true ? { requireQualified: true } : {}),
      },
      ...(t.taskClass !== undefined ? { taskClass: t.taskClass } : {}),
    };
  }
  return {
    mode: 'AUTO',
    ...(t.requireQualified === true ? { requireQualified: true } : {}),
    ...(t.taskClass !== undefined ? { taskClass: t.taskClass } : {}),
  };
}

/**
 * Classify a response body: an escalation, or null for an ordinary completion.
 *
 * An unrecognised reason still yields an escalation, tagged `UNKNOWN`. A reason
 * this build has not heard of still means Bokahli declined, and treating it as a
 * normal answer would let a future reason slip past every guard here.
 */
export function readEscalation(body: unknown): BokahliEscalation | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;

  const route =
    typeof b['route'] === 'object' && b['route'] !== null
      ? (b['route'] as Record<string, unknown>)
      : null;
  const outcome = typeof b['outcome'] === 'string' ? b['outcome'] : null;

  if (outcome === 'ESCALATE' || outcome === 'REFUSED') {
    const reason = typeof route?.['reason'] === 'string' ? (route['reason'] as string) : 'UNKNOWN';
    const detail = typeof route?.['detail'] === 'string' ? (route['detail'] as string) : outcome;
    const swap =
      typeof route?.['swap'] === 'object' && route['swap'] !== null
        ? (route['swap'] as Record<string, unknown>)
        : null;
    const candidates = Array.isArray(swap?.['candidates'])
      ? (swap['candidates'] as Record<string, unknown>[]).map((c) => ({
          modelId: String(c['modelId'] ?? ''),
          coldLoadSeconds: typeof c['coldLoadSeconds'] === 'number' ? c['coldLoadSeconds'] : null,
        }))
      : [];
    return new BokahliEscalation({
      reason: (BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(reason)
        ? (reason as BokahliEscalateReason)
        : 'UNKNOWN',
      detail,
      swapCandidates: candidates,
    });
  }

  const err =
    typeof b['error'] === 'object' && b['error'] !== null
      ? (b['error'] as Record<string, unknown>)
      : null;
  if (err !== null && typeof err['code'] === 'string') {
    const code = err['code'] as string;
    const known =
      (BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(code) ||
      (BOKAHLI_REFUSE_REASONS as readonly string[]).includes(code);
    if (known) {
      return new BokahliEscalation({
        reason: (BOKAHLI_ESCALATE_REASONS as readonly string[]).includes(code)
          ? (code as BokahliEscalateReason)
          : 'UNKNOWN',
        detail: typeof err['message'] === 'string' ? (err['message'] as string) : code,
      });
    }
  }

  return null;
}

/**
 * Read the served identity Bokahli attaches to an OpenAI-dialect response.
 *
 * Nothing is defaulted upward. An absent `attested` reads false and an absent
 * qualification reads `UNKNOWN`, never `INSTALLED_UNQUALIFIED` — the first is a
 * fact about what we were told, the second would be a claim we invented. On the
 * current deployment the real value is always `INSTALLED_UNQUALIFIED`, and a
 * receipt that softened it would read later as though something had been
 * vouched for.
 */
export function readBinding(body: unknown): BokahliBinding | null {
  if (typeof body !== 'object' || body === null) return null;
  const bok = (body as Record<string, unknown>)['bokahli'];
  if (typeof bok !== 'object' || bok === null) return null;
  const served = (bok as Record<string, unknown>)['servedIdentity'];
  if (typeof served !== 'object' || served === null) return null;
  const s = served as Record<string, unknown>;

  const modelId = typeof s['modelId'] === 'string' ? s['modelId'] : null;
  const digest =
    typeof s['artifactDigest'] === 'string'
      ? (s['artifactDigest'] as string)
      : typeof s['digest'] === 'string'
        ? (s['digest'] as string)
        : null;
  if (modelId === null || digest === null) return null;

  const qual =
    typeof s['qualification'] === 'object' && s['qualification'] !== null
      ? (s['qualification'] as Record<string, unknown>)
      : {};
  const runtime =
    typeof s['runtime'] === 'object' && s['runtime'] !== null
      ? (s['runtime'] as Record<string, unknown>)
      : {};

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const put = <T>(k: string, v: T | undefined): Record<string, T> =>
    v === undefined ? {} : ({ [k]: v } as Record<string, T>);

  return {
    outcome: str(s['outcome']) ?? 'ROUTED',
    modelId,
    artifactDigest: digest,
    ...put('servedContextTokens', num(s['servedContextTokens'])),
    ...put('runtimeBuild', str(runtime['build'])),
    attested: s['attested'] === true,
    ...put('attestationMethod', str(s['attestationMethod'])),
    qualificationStatus: str(qual['status']) ?? 'UNKNOWN',
    qualificationAuthority: str(qual['authority']) ?? 'unknown',
    ...put('requestId', str((body as Record<string, unknown>)['id'])),
  } as BokahliBinding;
}

/**
 * Refuse to forward tool authority.
 *
 * Bokahli is an inference endpoint. The Trio's tools — file writes, shell,
 * delegation — are authority the runtime holds on the user's behalf, and
 * handing their definitions to a model served by a different trust domain is
 * how that authority starts leaking. A checked property rather than a habit,
 * because habits are not auditable and this one would be easy to break by
 * copying a request shape from a cloud target.
 */
export function assertNoToolAuthority(request: Record<string, unknown>): void {
  for (const key of ['tools', 'tool_choice', 'functions', 'function_call']) {
    if (request[key] !== undefined) {
      throw new Error(
        `refusing to send "${key}" to bokahli: it is an inference endpoint and ` +
          'receives no Trio tool authority',
      );
    }
  }
}

/** What a caller learns after a Bokahli turn, refusal or not. */
export interface BokahliOutcome {
  readonly served: boolean;
  readonly binding: BokahliBinding | null;
  readonly escalation: BokahliEscalation | null;
  /** True only when governedFallback was enabled AND a refusal actually triggered it. */
  readonly fellBackToCloud: boolean;
  /** Why the turn ended as it did, for the transcript and the receipt. */
  readonly summary: string;
}

/**
 * Decide what happens after Bokahli answers.
 *
 * Pure, and separate from the transport, because this is the part with the
 * safety property in it and it should be testable without a socket. The rule it
 * encodes: `localOnly` beats `governedFallback`. If both are set the request
 * does not leave the machine, because a user who asked for local-only asked for
 * a guarantee, and a guarantee that yields to another flag is not one.
 */
export function decideAfterBokahli(
  t: BokahliTarget,
  escalation: BokahliEscalation | null,
  binding: BokahliBinding | null,
): BokahliOutcome {
  if (escalation === null) {
    return {
      served: true,
      binding,
      escalation: null,
      fellBackToCloud: false,
      summary:
        binding === null
          ? 'served locally by bokahli (no binding reported)'
          : `served locally by ${binding.modelId} (${binding.artifactDigest.slice(0, 19)}…), ` +
            `attested=${binding.attested}, qualification=${binding.qualificationStatus}`,
    };
  }

  if (t.localOnly === true) {
    return {
      served: false,
      binding: null,
      escalation,
      fellBackToCloud: false,
      summary:
        `bokahli declined (${escalation.reason}) and this target is local-only, ` +
        'so the turn ends here rather than sending the request off the machine',
    };
  }

  if (escalation.retriable) {
    return {
      served: false,
      binding: null,
      escalation,
      fellBackToCloud: t.governedFallback === true,
      summary:
        `the bokahli runtime is not answering (${escalation.reason}); this is an outage, ` +
        `not a refusal${t.governedFallback === true ? ', falling back as configured' : ''}`,
    };
  }

  return {
    served: false,
    binding: null,
    escalation,
    fellBackToCloud: t.governedFallback === true,
    summary:
      `bokahli declined: ${escalation.reason}. ` +
      (t.governedFallback === true
        ? 'governed fallback is enabled, so this turn goes to the configured cloud target'
        : 'no fallback is configured, so the turn ends here'),
  };
}
