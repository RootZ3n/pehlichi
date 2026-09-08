/**
 * `delegate_implementation` — the ONE live surface onto the governed engineering pipeline.
 *
 * Everything it does already exists and is tested: `runDelegation` routes, authorizes, invokes
 * ikbi's canonical v2 build, supervises the v2 evidence and writes a durable record. This file
 * adds a tool schema, the two effects `runDelegation` deliberately does not hold, and a result
 * shaped for an operator rather than a debugger. It duplicates none of that logic.
 *
 * ONE TOOL, NOT FIVE. There is no separate `ikbi_direct`, `bokahli_direct`, `fix` or `analyse`
 * tool. A second entry point is a second policy: the moment two tools can start work, one of them
 * is the one nobody remembered to put a scope check in front of. Local analysis is reached through
 * ikbi's own `--local-mode`, never by the Trio calling Bokahli itself, which keeps the hierarchy
 * Trio → ikbi → optional advice.
 *
 * AUTHORITY IS NOT WIDENED HERE. The tool appears only in a lane whose principal already carries
 * it; a conversation-only principal intersects to nothing and never sees it. It cannot push, cannot
 * promote, cannot reach a credential, and cannot mutate anything outside the allowed paths a caller
 * declared — because it never mutates anything itself. ikbi does, under the scope this passes it.
 */
import { spawnSync } from 'node:child_process';

import type { ToolSpec, ToolResult, ToolHandler } from '../tools.js';
import type { AcceptanceCheck, WorkRequest } from './route.js';
import { DelegationJournal } from './journal.js';
import { runDelegation } from './runner.js';
import { bokahliParticipation } from './supervisor.js';

/** What the deployment lets a delegated build reach. Configured, never taken from a model. */
export interface DelegationToolConfig {
  readonly agent: string;
  readonly principalId: string;
  readonly authorizedRoots: readonly string[];
  readonly ikbiCliPath: string;
  readonly profile: string;
  readonly bokahliBaseUrl?: string;
  readonly journalPath?: string;
  readonly maxInvocations?: number;
  readonly maxBuilderTurns?: number;
  readonly timeoutMs?: number;
}

export const delegateImplementationSpec: ToolSpec = {
  name: 'delegate_implementation',
  description:
    'Hand a governed repository implementation to ikbi and supervise it. Requires a repository, an '
    + 'explicit mutation scope (allowedPaths) and deterministic acceptance checks; without all three '
    + 'it refuses rather than starting work. Returns the supervised outcome and durable evidence '
    + 'references — never a claim of completion that the evidence does not support. Use it for work '
    + 'that changes a repository; do ordinary read-only work yourself.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What must be true when the work is done.' },
      repository: { type: 'string', description: 'Absolute path of the target repository.' },
      allowedPaths: {
        type: 'array', items: { type: 'string' },
        description: 'Repository-relative files or directories this work may change. Required for implementation.',
      },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string' },
          },
          required: ['name', 'command'],
          additionalProperties: false,
        },
        description: 'Deterministic acceptance checks. Without one, completion could only be asserted, not verified.',
      },
      localAnalysisUseful: {
        type: 'boolean',
        description: 'Whether bounded local reconnaissance may help. It selects ikbi local-mode; the specialist advises and decides nothing.',
      },
      parentRequestId: { type: 'string', description: 'The conversation or work order this belongs to.' },
      mutates: { type: 'boolean', description: 'Does this change a repository? Read-only work should not be delegated.' },
    },
    required: ['goal'],
    additionalProperties: false,
  },
};

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

function asChecks(v: unknown): AcceptanceCheck[] {
  if (!Array.isArray(v)) return [];
  const out: AcceptanceCheck[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const name = asString(e['name']); const command = asString(e['command']);
    if (name === undefined || command === undefined) continue;
    const cwd = asString(e['cwd']);
    out.push({ name, command, args: asStringArray(e['args']), ...(cwd !== undefined ? { cwd } : {}) });
  }
  return out;
}

export function createDelegationToolHandlers(cfg: DelegationToolConfig): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const journal = new DelegationJournal(cfg.journalPath);

  handlers.set('delegate_implementation', async (args): Promise<ToolResult> => {
    const goal = asString(args['goal']);
    if (goal === undefined) return { ok: false, output: '', error: 'goal is required' };

    const allowedPaths = asStringArray(args['allowedPaths']);
    const checks = asChecks(args['checks']);
    const request: WorkRequest = {
      goal,
      // A caller that declares a scope is asking for a mutation whether or not it said so.
      mutates: args['mutates'] === true || allowedPaths.length > 0,
      ...(asString(args['repository']) !== undefined ? { repository: asString(args['repository']) as string } : {}),
      allowedPaths, checks,
      ...(args['localAnalysisUseful'] === true ? { localAnalysisUseful: true } : {}),
    };

    const out = runDelegation(request, {
      parentRequestId: asString(args['parentRequestId']) ?? 'unattributed',
      principalId: cfg.principalId, agent: cfg.agent,
      authorizedRoots: cfg.authorizedRoots, ikbiCliPath: cfg.ikbiCliPath, profile: cfg.profile,
      ...(cfg.bokahliBaseUrl !== undefined ? { bokahliBaseUrl: cfg.bokahliBaseUrl } : {}),
      ...(cfg.maxInvocations !== undefined ? { maxInvocations: cfg.maxInvocations } : {}),
      ...(cfg.maxBuilderTurns !== undefined ? { maxBuilderTurns: cfg.maxBuilderTurns } : {}),
      ...(cfg.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
      journal,
      // THE TWO EFFECTS THE RUNNER REFUSES TO HOLD. Kept here so the decision logic stays pure and
      // the execution analysis can see exactly one spawn, in a file that declares it.
      spawn: (argv, env, timeoutMs) => {
        const r = spawnSync(process.execPath, [...argv], {
          encoding: 'utf8', timeout: timeoutMs, cwd: request.repository,
          env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
        });
        return { stdout: r.stdout ?? '', status: r.status };
      },
      readHeadCommit: (repository) => {
        const r = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        return r.status === 0 ? r.stdout.trim() : undefined;
      },
    });

    const j = out.judgment;
    const rec = out.record;
    const bokahli = bokahliParticipation(j?.localAdvisories ?? []);
    const result = {
      delegationId: rec.delegationId,
      route: out.decision.route,
      routeReason: out.decision.reason,
      routeExplanation: out.decision.explanation,
      repository: rec.repository ?? null,
      startingCommit: rec.startingCommit ?? null,
      resultingCommit: rec.resultingCommit ?? null,
      runId: j?.runId ?? null,
      goalSha256: j?.goalSha256 ?? null,
      terminalState: j?.verdict ?? 'NOT_DELEGATED',
      evidenceRejection: j?.rejection ?? null,
      verification: j?.checks ?? null,
      changedPaths: j?.changedPaths ?? null,
      promotionState:
        j?.verdict === 'COMPLETED_VERIFIED_PROMOTED' ? 'PROMOTED'
        : j?.verdict === 'PROMOTION_REFUSED_AWAITING_OPERATOR' ? 'AWAITING_OPERATOR_APPROVAL'
        : 'NOT_PROMOTED',
      bokahli,
      humanReviewRequired: j?.humanReviewRequired ?? false,
      operatorState: rec.operatorState,
      evidence: { delegationJournal: cfg.journalPath ?? null, durable: journal.durable },
    };
    // A refusal is a RESULT, not a tool error: the caller asked a legitimate question and got a
    // legitimate answer about authority. Only a run whose evidence proves nothing is `ok: false`.
    const ok = out.decision.route !== 'REFUSE_OR_CLARIFY' && j?.verdict !== 'EVIDENCE_REJECTED';
    return { ok, output: JSON.stringify(result, null, 1), ...(ok ? {} : { error: rec.operatorState }) };
  });

  return handlers;
}
