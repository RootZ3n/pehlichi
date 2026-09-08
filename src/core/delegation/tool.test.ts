import assert from 'node:assert/strict';
import test from 'node:test';

import { governedMkdtemp } from '../temp-authority.js';
import { join } from 'node:path';
import { delegateImplementationSpec, createDelegationToolHandlers } from './tool.js';
import { ikbiToolSpecs, RETIRED_IKBI_TOOLS, createIkbiToolHandlers } from '../agent-tools/ikbi-tools.js';
import { bokahliParticipation } from './supervisor.js';
import { DelegationJournal } from './journal.js';

// ── THE RETIRED PATH CANNOT MISLEAD ───────────────────────────────────────────────────────────

test('RETIRED: ikbi_build and ikbi_fix are not in the assembled tool schema', () => {
  const names = ikbiToolSpecs.map((s) => s.name);
  assert.equal(names.includes('ikbi_build'), false, 'a model cannot call the retired build endpoint');
  assert.equal(names.includes('ikbi_fix'), false);
  assert.equal(names.includes('ikbi_status'), true, 'POSITIVE CONTROL: the surface that still exists is still offered');
});

test('RETIRED: calling a retired name by hand yields a typed refusal, never a taskId', async () => {
  const handlers = createIkbiToolHandlers();
  for (const name of Object.keys(RETIRED_IKBI_TOOLS)) {
    const h = handlers.get(name);
    assert.ok(h !== undefined, `${name} still answers`);
    const r = await h({ goal: 'x', repo: '/tmp' }, {} as never);
    assert.equal(r.ok, false, `${name} must not report success`);
    assert.match(r.error ?? '', /retired|delegate_implementation/i);
    assert.equal(r.output, '', 'a refusal carries no result a model could mistake for a build');
    assert.doesNotMatch(JSON.stringify(r), /taskId/, 'nothing that looks like an accepted build');
  }
});

test('RETIRED: the replacement is named in the refusal, so the model is not left guessing', () => {
  for (const why of Object.values(RETIRED_IKBI_TOOLS)) assert.match(why, /delegate_implementation/);
});

// ── THE TOOL ──────────────────────────────────────────────────────────────────────────────────

const cfg = (over: Record<string, unknown> = {}) => ({
  agent: 'Ptah', principalId: 'operator-cli@ptah',
  authorizedRoots: ['/pehverse/repos', '/home/zen/.pehverse/phase4-fixtures'],
  ikbiCliPath: '/pehverse/repos/ecosystem/ikbi/dist/cli/index.js',
  profile: 'deepseek', journalPath: join(governedMkdtemp('tool-'), 'd.jsonl'), ...over,
});
const call = async (args: Record<string, unknown>, over: Record<string, unknown> = {}) => {
  const h = createDelegationToolHandlers(cfg(over) as never).get('delegate_implementation');
  assert.ok(h !== undefined);
  return h(args, {} as never);
};

test('the tool declares exactly one implementation surface, and requires the authority it needs', () => {
  assert.equal(delegateImplementationSpec.name, 'delegate_implementation');
  const p = delegateImplementationSpec.parameters as Record<string, unknown>;
  const props = p['properties'] as Record<string, unknown>;
  for (const k of ['goal', 'repository', 'allowedPaths', 'checks', 'localAnalysisUseful']) {
    assert.ok(props[k] !== undefined, `${k} is expressible`);
  }
  assert.equal((p['additionalProperties'] as boolean), false, 'no unmodelled field rides along');
  assert.match(delegateImplementationSpec.description, /mutation scope/);
});

test('FAIL CLOSED: "fix the project" with no repository does not start work', async () => {
  const r = await call({ goal: 'fix the project', mutates: true });
  const out = JSON.parse(r.output) as Record<string, unknown>;
  assert.equal(r.ok, false);
  assert.equal(out['route'], 'REFUSE_OR_CLARIFY');
  assert.equal(out['routeReason'], 'repository_missing');
  assert.equal(out['runId'], null, 'nothing was run');
});

test('FAIL CLOSED: a repository with no mutation scope does not start work', async () => {
  const r = await call({ goal: 'fix it', mutates: true, repository: '/pehverse/repos/demo' });
  const out = JSON.parse(r.output) as Record<string, unknown>;
  assert.equal(out['routeReason'], 'mutation_scope_missing');
  assert.equal(out['terminalState'], 'NOT_DELEGATED');
});

test('FAIL CLOSED: a scope with no acceptance check does not start work', async () => {
  const r = await call({ goal: 'fix it', repository: '/pehverse/repos/demo', allowedPaths: ['src/a.js'] });
  const out = JSON.parse(r.output) as Record<string, unknown>;
  assert.equal(out['routeReason'], 'acceptance_criteria_missing');
});

test('a repository outside the authorized roots is refused', async () => {
  const r = await call({ goal: 'x', repository: '/etc', allowedPaths: ['a'], checks: [{ name: 'c', command: 'true' }] });
  assert.equal((JSON.parse(r.output) as Record<string, unknown>)['routeReason'], 'repository_outside_authorized_scope');
});

test('POSITIVE: read-only work is answered directly and never delegated', async () => {
  const r = await call({ goal: 'explain what this module does', mutates: false });
  const out = JSON.parse(r.output) as Record<string, unknown>;
  assert.equal(r.ok, true);
  assert.equal(out['route'], 'DIRECT');
  assert.equal(out['runId'], null);
});

test('the refusal is a RESULT with an explanation, not an opaque error', async () => {
  const r = await call({ goal: 'fix the project', mutates: true });
  const out = JSON.parse(r.output) as Record<string, unknown>;
  assert.match(String(out['routeExplanation']), /names none|nothing to authorize/);
  assert.equal(typeof out['operatorState'], 'string');
});

test('every refusal is journalled durably, so a refused request is still history', async () => {
  const path = join(governedMkdtemp('tool-j-'), 'd.jsonl');
  await call({ goal: 'fix the project', mutates: true }, { journalPath: path });
  const all = new DelegationJournal(path).all();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.route, 'REFUSE_OR_CLARIFY');
});

// ── BOKAHLI PARTICIPATION IS REPORTED HONESTLY ────────────────────────────────────────────────

const adv = (outcome: string, disposition: string, supplied = false) =>
  ({ hook: 'H', taskClass: 'repo_recon_bounded', mode: 'assist', outcome, disposition, suppliedToPrimaryProvider: supplied });

test('not consulted is stated as not consulted', () => {
  const p = bokahliParticipation([]);
  assert.equal(p.attempted, false);
  assert.equal(p.reached, false);
  assert.match(p.summary, /was not consulted/);
});

test('ATTEMPTED BUT UNREACHABLE is not reported as participation', () => {
  const p = bokahliParticipation([adv('REFUSED', 'rejected'), adv('REFUSED', 'rejected')]);
  assert.equal(p.attempted, true);
  assert.equal(p.reached, false, 'the deployment never served anything');
  assert.equal(p.adviceAccepted, 0);
  assert.equal(p.suppliedToPrimaryProvider, 0);
  assert.match(p.summary, /did not serve any of them/);
  assert.doesNotMatch(p.summary, /accepted/);
});

test('accepted and discarded advice are distinct, and supply is counted separately', () => {
  const p = bokahliParticipation([adv('ROUTED', 'accepted', true), adv('ROUTED', 'discarded')]);
  assert.equal(p.reached, true);
  assert.equal(p.adviceAccepted, 1);
  assert.equal(p.adviceDiscarded, 1);
  assert.equal(p.suppliedToPrimaryProvider, 1);
  assert.match(p.summary, /1 accepted, 1 discarded/);
});

test('served but wholly discarded is never described as advice that helped', () => {
  const p = bokahliParticipation([adv('ROUTED', 'discarded'), adv('ROUTED', 'discarded')]);
  assert.equal(p.reached, true);
  assert.equal(p.adviceAccepted, 0);
  assert.equal(p.suppliedToPrimaryProvider, 0);
  assert.match(p.summary, /0 accepted, 2 discarded/);
});
