/**
 * ONE DELEGATION, END TO END.
 *
 * route → authority → ikbi build (argv, no shell) → v2 evidence → supervisor verdict → durable
 * record. Every step above is a separate, tested module; this is the wiring and nothing else.
 *
 * WHAT IT REFUSES TO DO. It does not call the local specialist itself: the hierarchy is
 * Trio → ikbi → optional Bokahli advice, and a second path from here to Bokahli would be a second
 * implementation pipeline with no governance in front of it. It does not read `ikbi inspect`. It
 * does not treat the child's exit code as an outcome.
 *
 * IT HOLDS NO EFFECT OF ITS OWN. `spawn` and `readHeadCommit` are REQUIRED injections, not
 * defaults. A module that decides what to run and also runs it puts an unresolvable argv in front
 * of the execution analysis — the scanner cannot see what a computed vector will execute, and
 * fails closed, correctly. Keeping the effect at the caller leaves this file pure: same request,
 * same decision, and the spawn declared where the other effect surfaces already are.
 */
import { randomUUID, createHash } from 'node:crypto';

import { selectRoute, type WorkRequest, type RouteDecision } from './route.js';
import { buildIkbiArgv, IkbiAdapterRefusal, type LocalMode } from './ikbi-adapter.js';
import { superviseSession, type SupervisorJudgment } from './supervisor.js';
import { DelegationJournal, type DelegationRecord } from './journal.js';

export interface DelegationContext {
  readonly parentRequestId: string;
  readonly principalId: string;
  readonly agent: string;
  readonly authorizedRoots: readonly string[];
  readonly ikbiCliPath: string;
  readonly profile: string;
  readonly bokahliBaseUrl?: string;
  readonly maxInvocations?: number;
  readonly maxBuilderTurns?: number;
  readonly timeoutMs?: number;
  readonly journal: DelegationJournal;
  /**
   * Runs the argument vector and returns what the child wrote. REQUIRED: this module never spawns.
   * The vector is passed whole and is never joined into a command line.
   */
  readonly spawn: (argv: readonly string[], env: Record<string, string>, timeoutMs: number)
    => { stdout: string; status: number | null };
  /** Reads a repository's current HEAD. REQUIRED for the same reason. */
  readonly readHeadCommit: (repository: string) => string | undefined;
  readonly clock?: () => number;
}

export interface DelegationOutcome {
  readonly decision: RouteDecision;
  readonly record: DelegationRecord;
  readonly judgment?: SupervisorJudgment;
}

/** The operator-facing sentence. Derived from the verdict; never from the model's prose. */
function operatorState(j: SupervisorJudgment | undefined, decision: RouteDecision): string {
  if (j === undefined) {
    return decision.route === 'DIRECT'
      ? 'handled directly by the agent; no governed build was needed'
      : `not delegated: ${decision.explanation}`;
  }
  switch (j.verdict) {
    case 'COMPLETED_VERIFIED_PROMOTED': return `implemented, verified and promoted (${j.explanation})`;
    case 'PROMOTION_REFUSED_AWAITING_OPERATOR': return 'a verified candidate is waiting for operator authority; it is NOT yet a change in the repository';
    case 'VERIFICATION_RED': return 'the implementation was rejected by its own checks; nothing was promoted';
    case 'PROVIDER_FAILURE': return 'the implementation could not run: the provider route failed';
    case 'TIMEOUT_OR_INTERRUPTED': return 'the run did not finish; what completed is uncertain and nothing was promoted';
    case 'REFUSED_BEFORE_EXECUTION': return 'refused by policy before any model was called';
    case 'EVIDENCE_REJECTED': return `the returned evidence does not belong to this request (${j.rejection}); it proves nothing here`;
    default: return 'the outcome is indeterminate on the evidence available';
  }
}

export function runDelegation(request: WorkRequest, ctx: DelegationContext): DelegationOutcome {
  const now = ctx.clock ?? Date.now;
  const decision = selectRoute(request, ctx.authorizedRoots);
  const delegationId = `dlg-${randomUUID()}`;
  const base = {
    schema: 'pehverse-trio-delegation/1' as const,
    delegationId, timestamp: now(),
    parentRequestId: ctx.parentRequestId, principalId: ctx.principalId, agent: ctx.agent,
    goal: request.goal, route: decision.route, routeReason: decision.reason,
    routeExplanation: decision.explanation,
  };

  if (decision.route === 'DIRECT' || decision.route === 'REFUSE_OR_CLARIFY') {
    return { decision, record: ctx.journal.record({ ...base, operatorState: operatorState(undefined, decision) }) };
  }

  const localMode: LocalMode = decision.route === 'IKBI_WITH_LOCAL_ASSIST' ? 'assist' : 'off';
  const repository = request.repository as string;
  const attemptId = `att-${randomUUID()}`;
  const timeoutMs = ctx.timeoutMs ?? 1_800_000;

  let argv: string[];
  let env: Record<string, string>;
  try {
    ({ argv, env } = buildIkbiArgv({
      cliPath: ctx.ikbiCliPath, repository, goal: request.goal,
      allowedPaths: request.allowedPaths ?? [], checks: request.checks ?? [],
      localMode, profile: ctx.profile,
      maxInvocations: ctx.maxInvocations ?? 14, maxBuilderTurns: ctx.maxBuilderTurns ?? 10,
      timeoutMs, ...(ctx.bokahliBaseUrl !== undefined ? { bokahliBaseUrl: ctx.bokahliBaseUrl } : {}),
    }));
  } catch (e) {
    const refusal = e instanceof IkbiAdapterRefusal ? e.code : 'adapter_refused';
    return { decision, record: ctx.journal.record({
      ...base, route: 'REFUSE_OR_CLARIFY', repository, attemptId,
      operatorState: `refused before any model call: ${(e as Error).message} (${refusal})`,
    }) };
  }

  const startingCommit = ctx.readHeadCommit(repository);
  const { stdout, status } = ctx.spawn(argv, env, timeoutMs);
  const judgment = superviseSession(stdout, { repository }, status);
  const resultingCommit = ctx.readHeadCommit(repository);

  const record = ctx.journal.record({
    ...base, repository, attemptId, localMode, profile: ctx.profile,
    ...(startingCommit !== undefined ? { startingCommit } : {}),
    allowedPaths: request.allowedPaths ?? [],
    checks: (request.checks ?? []).map((c) => `${c.name}:${c.command} ${c.args.join(' ')}`),
    ...(judgment.runId !== undefined ? { runId: judgment.runId } : {}),
    ...(judgment.goalSha256 !== undefined ? { goalSha256: judgment.goalSha256 } : {}),
    verdict: judgment.verdict,
    ...(judgment.rejection !== undefined ? { rejection: judgment.rejection } : {}),
    verdictExplanation: judgment.explanation,
    ...(resultingCommit !== undefined ? { resultingCommit } : {}),
    ...(judgment.changedPaths !== undefined ? { changedPaths: judgment.changedPaths } : {}),
    localAdvisories: judgment.localAdvisories,
    bokahliInvoked: judgment.bokahliInvoked,
    humanReviewRequired: judgment.humanReviewRequired,
    operatorState: operatorState(judgment, decision),
  });
  return { decision, record, judgment };
}

/** Digest of the exact goal, so a later reader can bind evidence to the request that asked. */
export const goalDigest = (goal: string): string => `sha256:${createHash('sha256').update(goal).digest('hex')}`;
