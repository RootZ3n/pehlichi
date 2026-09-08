/**
 * THE SUPERVISOR — what a delegated result actually proved.
 *
 * THE RULE THIS FILE EXISTS FOR: a process that exited 0, a session that says
 * `believesComplete: true`, and a model that wrote "done" have each told you something about
 * INTENT. None of them is evidence of a verified change. ikbi already knows this — its own
 * documentation says exit 0 is not merely process health — and this reads the evidence ikbi
 * actually produces rather than the summary anybody wrote about it.
 *
 * AUTHORITATIVE SOURCES. The v2 terminal session JSON, and the v2 receipt ledger
 * (`receipts.ndjson`). NOT `ikbi inspect`, which is the v1 interface and answers `not_found` for a
 * v2 run id — a supervisor built on it would read every real run as "no such run" and, worse,
 * would read a v1 run's success as though it belonged to this one.
 *
 * BINDING BEFORE BELIEF. Evidence is matched to the request that asked for it — repository, goal
 * digest, run id, attempt — before any status is read. A perfectly successful build of a different
 * task is not a success for this one, and that is the shape a replayed or stale result takes.
 */

export type SupervisorVerdict =
  | 'COMPLETED_VERIFIED_PROMOTED'
  | 'VERIFICATION_RED'
  | 'PROMOTION_REFUSED_AWAITING_OPERATOR'
  | 'PROVIDER_FAILURE'
  | 'TIMEOUT_OR_INTERRUPTED'
  | 'REFUSED_BEFORE_EXECUTION'
  | 'EVIDENCE_REJECTED'
  | 'INDETERMINATE';

export type EvidenceRejection =
  | 'session_json_malformed'
  | 'repository_mismatch'
  | 'goal_digest_mismatch'
  | 'run_id_mismatch'
  | 'attempt_missing'
  | 'no_terminal_outcome';

export interface ExpectedBinding {
  /** Absolute path of the repository this request authorized. */
  readonly repository: string;
  /** sha256 of the exact goal that was frozen, as `sha256:…`, when the caller knows it. */
  readonly goalSha256?: string;
  /** The run id this delegation produced, when the caller is re-reading a known run. */
  readonly runId?: string;
}

export interface LocalAdvisoryFact {
  readonly hook: string;
  readonly taskClass: string;
  readonly mode: string;
  readonly outcome: string;
  readonly disposition: string;
  readonly suppliedToPrimaryProvider: boolean;
}

export interface SupervisorJudgment {
  readonly verdict: SupervisorVerdict;
  readonly rejection?: EvidenceRejection;
  /** One sentence naming what the evidence established. Never optimistic. */
  readonly explanation: string;
  readonly runId?: string;
  readonly goalSha256?: string;
  readonly candidateId?: string;
  readonly verificationId?: string;
  readonly promotionId?: string;
  readonly changedPaths?: readonly string[];
  readonly checks?: readonly { readonly name: string; readonly status: string; readonly exitCode?: number }[];
  readonly localAdvisories: readonly LocalAdvisoryFact[];
  /** True when a local specialist actually served a request in this session. */
  readonly bokahliInvoked: boolean;
  /** True when any served local advice was stamped as requiring human review. */
  readonly humanReviewRequired: boolean;
}

/**
 * WHAT THE LOCAL SPECIALIST ACTUALLY DID.
 *
 * `bokahliInvoked` on the judgment means only "the local lane was attempted", which reads as
 * participation to an operator even when the service was unreachable and every hook was refused.
 * Historical journals keep that field unchanged — evidence already written is not rewritten — and
 * live results carry this instead, which separates the four facts that were being collapsed:
 * whether ikbi tried, whether the deployment answered, and whether its answer survived ikbi's
 * deterministic validator.
 */
export interface BokahliParticipation {
  /** ikbi ran the local lane at all (local-mode was not `off`). */
  readonly attempted: boolean;
  /** The deployment answered with a completion (`ROUTED`) at least once. */
  readonly reached: boolean;
  /** Advisories whose content survived ikbi's validator. */
  readonly adviceAccepted: number;
  /** Advisories ikbi produced but then rejected. */
  readonly adviceDiscarded: number;
  /** Advisories the deployment declined or could not serve. */
  readonly refused: number;
  /** Advisories whose content actually reached the primary provider's context. */
  readonly suppliedToPrimaryProvider: number;
  /** One sentence, safe to show an operator without implying authority. */
  readonly summary: string;
}

export function bokahliParticipation(advisories: readonly LocalAdvisoryFact[]): BokahliParticipation {
  const attempted = advisories.length > 0;
  const reached = advisories.some((a) => a.outcome === 'ROUTED');
  const adviceAccepted = advisories.filter((a) => a.disposition === 'accepted').length;
  const adviceDiscarded = advisories.filter((a) => a.disposition === 'discarded').length;
  const refused = advisories.filter((a) => a.outcome !== 'ROUTED' && a.outcome !== 'unknown').length;
  const supplied = advisories.filter((a) => a.suppliedToPrimaryProvider).length;
  const summary = !attempted
    ? 'the local specialist was not consulted'
    : !reached
      ? `the local specialist was consulted ${advisories.length} time(s) and did not serve any of them; the build proceeded on the primary provider alone`
      : `the local specialist answered ${adviceAccepted + adviceDiscarded} of ${advisories.length} consultation(s): `
        + `${adviceAccepted} accepted, ${adviceDiscarded} discarded by ikbi's validator, `
        + `${supplied} supplied to the primary provider as advisory data`;
  return { attempted, reached, adviceAccepted, adviceDiscarded, refused, suppliedToPrimaryProvider: supplied, summary };
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function reject(rejection: EvidenceRejection, explanation: string): SupervisorJudgment {
  return { verdict: 'EVIDENCE_REJECTED', rejection, explanation, localAdvisories: [], bokahliInvoked: false, humanReviewRequired: false };
}

function readAdvisories(session: Record<string, unknown>): LocalAdvisoryFact[] {
  const raw = Array.isArray(session['localAdvisories']) ? (session['localAdvisories'] as unknown[]) : [];
  return raw.map((a) => {
    const e = obj(a) ?? {};
    return {
      hook: str(e['hook']) ?? 'unknown',
      taskClass: str(e['taskClass']) ?? 'unknown',
      mode: str(e['mode']) ?? 'unknown',
      outcome: str(e['outcome']) ?? 'unknown',
      disposition: str(e['disposition']) ?? 'unknown',
      suppliedToPrimaryProvider: e['suppliedToPrimaryProvider'] === true,
    };
  });
}

/**
 * Judge one delegated run from its terminal session document.
 *
 * `exitCode` is accepted only to be REPORTED. It never decides anything: a 0 beside a red
 * verification is a contradiction the evidence resolves, not a tie the exit code wins.
 */
export function superviseSession(
  sessionJson: string,
  expected: ExpectedBinding,
  exitCode: number | null,
): SupervisorJudgment {
  let parsed: unknown;
  try { parsed = JSON.parse(sessionJson); }
  catch { return reject('session_json_malformed', 'the delegated run produced no parseable terminal document'); }
  const session = obj(parsed);
  if (session === undefined) return reject('session_json_malformed', 'the terminal document is not a JSON object');

  // ── BINDING FIRST ────────────────────────────────────────────────────────────────────────────
  const repoPath = str(session['repoPath']);
  if (repoPath === undefined) return reject('session_json_malformed', 'the terminal document names no repository');
  if (repoPath !== expected.repository) {
    return reject('repository_mismatch',
      `evidence describes ${repoPath}, but this request authorized ${expected.repository}`);
  }
  const goalSha = str(session['canonicalGoalSha256']);
  if (expected.goalSha256 !== undefined && goalSha !== expected.goalSha256) {
    return reject('goal_digest_mismatch',
      'evidence carries a different frozen goal digest than the one this request produced');
  }
  const attempts = Array.isArray(session['attempts']) ? (session['attempts'] as unknown[]) : [];
  const last = obj(attempts[attempts.length - 1]);
  if (last === undefined) return reject('attempt_missing', 'the terminal document records no attempt');
  const runId = str(last['runId']);
  if (expected.runId !== undefined && runId !== expected.runId) {
    return reject('run_id_mismatch', `evidence is for run ${runId ?? 'unknown'}, not ${expected.runId}`);
  }

  const advisories = readAdvisories(session);
  const bokahliInvoked = advisories.some((a) => a.outcome !== 'unknown');
  const humanReviewRequired = advisories.some((a) => a.disposition === 'accepted' || a.disposition === 'discarded');

  const verification = obj(last['verification']);
  const checks = (Array.isArray(verification?.['checks']) ? (verification['checks'] as unknown[]) : []).map((c) => {
    const e = obj(c) ?? {};
    return { name: str(e['name']) ?? 'unnamed', status: str(e['status']) ?? 'unknown',
             ...(typeof e['exitCode'] === 'number' ? { exitCode: e['exitCode'] as number } : {}) };
  });
  const candidate = obj(last['candidate']);
  const changedPaths = Array.isArray(candidate?.['changedPaths'])
    ? (candidate['changedPaths'] as unknown[]).filter((p): p is string => typeof p === 'string') : undefined;

  const base = {
    localAdvisories: advisories, bokahliInvoked, humanReviewRequired,
    ...(runId !== undefined ? { runId } : {}),
    ...(goalSha !== undefined ? { goalSha256: goalSha } : {}),
    ...(changedPaths !== undefined ? { changedPaths } : {}),
    ...(checks.length > 0 ? { checks } : {}),
  };

  // ── THEN THE OUTCOME ─────────────────────────────────────────────────────────────────────────
  const outcome = obj(session['outcome']);
  if (outcome === undefined) return reject('no_terminal_outcome', 'the terminal document states no outcome');
  const kind = str(outcome['kind']);

  if (kind === 'accepted') {
    const promotionId = str(outcome['promotionId']);
    const j = {
      ...base,
      ...(str(outcome['candidateId']) !== undefined ? { candidateId: str(outcome['candidateId']) as string } : {}),
      ...(str(outcome['verificationId']) !== undefined ? { verificationId: str(outcome['verificationId']) as string } : {}),
      ...(promotionId !== undefined ? { promotionId } : {}),
    };
    // ACCEPTED WITHOUT A PROMOTION IS A VERIFIED CANDIDATE, NOT A FINISHED CHANGE.
    if (promotionId === undefined) {
      return { ...j, verdict: 'PROMOTION_REFUSED_AWAITING_OPERATOR',
        explanation: 'the candidate verified but was not promoted; it awaits operator authority and is not a completed change' };
    }
    if (verification !== undefined && str(verification['verdict']) !== 'pass') {
      return { ...j, verdict: 'EVIDENCE_REJECTED', rejection: 'no_terminal_outcome',
        explanation: 'the outcome claims acceptance while the verification record does not say pass — the document contradicts itself' };
    }
    return { ...j, verdict: 'COMPLETED_VERIFIED_PROMOTED',
      explanation: `verified against ${checks.length} deterministic check(s) and promoted` };
  }

  /*
    WITHHELD: ikbi built a candidate, ran the checks, and did not publish it.

    This is the same situation as `accepted` without a promotion id, and it is the
    outcome a governed engine reaches most often on real work -- it was missed here,
    so a verified candidate came back as `unrecognised terminal outcome "withheld"`
    and an operator was told the result was indeterminate when it was nothing of the
    kind. The verdict must follow the VERIFICATION, not the publication: green checks
    and no promotion is finished work parked at an authority boundary; red checks are
    a rejection whichever way the publication went.

    The reason ikbi gives (`operator`, `policy`, `governance`, `target_moved`,
    `unsupported_publication`, ...) is carried through verbatim, because "a human must
    look at this" and "the branch moved under us" call for very different next steps.
  */
  if (kind === 'withheld') {
    const reason = str(outcome['reason']) ?? 'unstated reason';
    const j = {
      ...base,
      ...(str(outcome['candidateId']) !== undefined ? { candidateId: str(outcome['candidateId']) as string } : {}),
      ...(str(outcome['verificationId']) !== undefined ? { verificationId: str(outcome['verificationId']) as string } : {}),
    };
    const verdict = verification === undefined ? undefined : str(verification['verdict']);
    if (verdict === 'pass') {
      return { ...j, verdict: 'PROMOTION_REFUSED_AWAITING_OPERATOR',
        explanation: `the candidate verified against ${checks.length} deterministic check(s) and publication was withheld (${reason}); `
          + 'it awaits operator authority and is not a completed change' };
    }
    if (verdict !== undefined) {
      return { ...j, verdict: 'VERIFICATION_RED',
        explanation: `publication was withheld (${reason}) and the verification record says ${verdict}, not pass; nothing was promoted` };
    }
    return { ...j, verdict: 'INDETERMINATE',
      explanation: `publication was withheld (${reason}) and the evidence carries no verification record, `
        + 'so whether the candidate is good is not established' };
  }

  if (kind === 'rejected') {
    return { ...base, verdict: 'VERIFICATION_RED',
      explanation: `the candidate was rejected (${str(outcome['reason']) ?? 'unstated reason'}); nothing was promoted` };
  }

  if (kind === 'failed') {
    const failure = obj(outcome['failure']) ?? {};
    const category = str(failure['category']);
    const code = str(failure['code']) ?? 'unknown';
    if (category === 'provider') {
      return { ...base, verdict: 'PROVIDER_FAILURE', explanation: `the provider route failed (${code}); no work was verified` };
    }
    if (category === 'policy') {
      return { ...base, verdict: 'REFUSED_BEFORE_EXECUTION', explanation: `refused by policy before execution (${code})` };
    }
    if (code.includes('timeout') || code.includes('cancel')) {
      return { ...base, verdict: 'TIMEOUT_OR_INTERRUPTED', explanation: `the run did not finish (${code})` };
    }
    return { ...base, verdict: 'INDETERMINATE', explanation: `the run failed (${code}); the evidence does not establish what completed` };
  }

  return { ...base, verdict: 'INDETERMINATE',
    explanation: `unrecognised terminal outcome ${JSON.stringify(kind)}; exit code ${exitCode ?? 'unknown'} is not evidence of completion` };
}
