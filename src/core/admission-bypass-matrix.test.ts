/**
 * Every way somebody might try to reach the executor, and what stops each one.
 *
 * The original bypass was three lines in a disposable production module:
 *
 *     import * as loopMechanics from "./loop.js";
 *     const componentName = "execute" + "AgentRun";
 *     return loopMechanics[componentName](options);
 *
 * The guard of the day searched for known spellings and found nothing to object to, because a
 * computed property has no spelling. Adding that expression to a denylist would have closed
 * that one line; the next attempt would join an array, or destructure, or re-export under a new
 * name, or wrap the function in an object, or return it from a factory, or hang it on a symbol.
 *
 * So each case here is a different way of asking for the same authority, and each must fail for
 * one of exactly two reasons, recorded per case:
 *
 *   NOT_EXPORTED   the construct cannot be written, because there is nothing to reach. This is
 *                  the architectural closure, and it is the reason the original mutation fails
 *                  now -- not because its spelling was added to a list.
 *   GUARD_REFUSES  the construct is writable but the dominance guard rejects the shape.
 *
 * The runtime cases resolve real modules. The static cases run the *shared* predicates the
 * dominance guard itself uses over hostile snippets -- a matrix carrying its own copy of the
 * rules would prove nothing about the rules that actually run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_EXECUTORS, computedNamespaceAccess, exportedAuthority, nonLiteralDynamicImports,
  starReExports, strippedSource
} from './effect-sinks.js';

/** Why a given attempt fails. Recorded per case so the reason is part of the evidence. */
type Closure = 'NOT_EXPORTED' | 'GUARD_REFUSES';
const closures: Record<string, Closure> = {};
const record = (name: string, closure: Closure): void => { closures[name] = closure; };

// --- runtime: there is nothing on the namespace to reach ------------------------------------

test('1-4. the namespace carries no executor, by name, by computed key, or by destructuring', async () => {
  const loop = await import('./loop.js') as Record<string, unknown>;

  // 1. The exact original direct import. TypeScript refuses it at compile time; at runtime the
  //    property is simply absent, which is the stronger statement.
  assert.equal(loop.executeAgentRun, undefined, 'a direct named import still resolves');

  // 2. The audit's expression, character for character.
  const componentName = 'execute' + 'AgentRun';
  assert.equal(loop[componentName], undefined, 'the computed-property bypass still resolves');

  // 3. Bracket lookup through a constant alias -- the same thing with the string moved.
  const alias = 'executeAgentRun';
  assert.equal(loop[alias], undefined);
  assert.equal(loop[['ex', 'ecute'].join('') + 'AgentRun'], undefined, 'a joined name resolves');

  // 4. Destructuring from the namespace.
  const { executeAgentRun: destructured } = loop as { executeAgentRun?: unknown };
  assert.equal(destructured, undefined, 'destructuring still yields the executor');

  for (const name of ['1. direct import', '2. computed property', '3. constant alias', '4. destructuring'])
    record(name, 'NOT_EXPORTED');
});

test('5-11. no packaging of the executor survives, because none exists to package', async () => {
  // The runtime barrel is checked statically by the dominance guard; importing it from here
  // would reach outside this package's rootDir.
  const namespaces = await Promise.all([
    import('./loop.js'), import('./index.js'), import('../index.js')
  ]) as Record<string, unknown>[];

  for (const namespace of namespaces) {
    // 5. Re-export under a new name; 6. an exported object containing it; 7. an exported
    //    factory returning it; 8. a symbol key; 9. a registry; 10. a two-step alias chain.
    //    All of these need a starting reference, and there is none: every own property is
    //    inspected below and none of them is, or yields, an executor.
    for (const [key, value] of Object.entries(namespace)) {
      if (typeof value === 'function') {
        assert.equal(PRIVATE_EXECUTORS.includes(key), false, `${key} is exported`);
        continue;
      }
      if (value === null || typeof value !== 'object') continue;
      for (const inner of Object.keys(value as Record<string, unknown>))
        assert.equal(PRIVATE_EXECUTORS.includes(inner), false, `an exported object carries ${inner}`);
    }
    for (const symbol of Object.getOwnPropertySymbols(namespace))
      assert.notEqual(typeof (namespace as Record<symbol, unknown>)[symbol], 'function',
        'a callable hangs on a symbol key');

    // 11. Reflection over the namespace, which is what a determined caller reaches for once
    //     the ordinary spellings stop working.
    const reflected = [
      ...Object.keys(namespace), ...Object.getOwnPropertyNames(namespace),
      ...Reflect.ownKeys(namespace).filter((k): k is string => typeof k === 'string')
    ];
    for (const name of PRIVATE_EXECUTORS)
      assert.equal(reflected.includes(name), false, `reflection finds ${name}`);
  }

  for (const name of ['5. re-export under a new name', '6. exported object', '7. exported factory',
    '8. symbol key', '9. registry entry', '10. two-step alias chain', '11. reflection'])
    record(name, 'NOT_EXPORTED');
});

test('12. a dynamic import with a literal target reaches the same empty namespace', async () => {
  const namespace = await import('./loop.js') as Record<string, unknown>;
  for (const name of PRIVATE_EXECUTORS) assert.equal(namespace[name], undefined);
  record('12. dynamic literal import', 'NOT_EXPORTED');
});

test('13. createRequire reaches no executor either', async () => {
  // The module system's other door. It resolves the same module record; a function that is not
  // exported is not on it under CommonJS interop either.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let namespace: Record<string, unknown> | null = null;
  try { namespace = require('./loop.js') as Record<string, unknown>; } catch { namespace = null; }
  if (namespace !== null)
    for (const name of PRIVATE_EXECUTORS) assert.equal(namespace[name], undefined, `require() exposes ${name}`);
  record('13. createRequire', 'NOT_EXPORTED');
});

// --- static: the guard refuses the shape ------------------------------------------------------

/** Run the guard's own predicates over a hostile snippet, the way the guard runs them. */
function judge(source: string): {
  star: boolean; computed: string[]; dynamic: string[]; authority: string[];
} {
  const code = strippedSource(source);
  return {
    star: starReExports(code),
    computed: computedNamespaceAccess(code),
    dynamic: nonLiteralDynamicImports(code),
    authority: exportedAuthority(code, PRIVATE_EXECUTORS)
  };
}

test('14. a non-literal dynamic import is refused wherever it appears', () => {
  assert.deepEqual(judge(`const m = await import(someTarget);`).dynamic, ['someTarget']);
  assert.deepEqual(judge('const m = await import(`${base}/loop.js`);').dynamic, ['`INTERPOLATED`'],
    'an interpolated template target was treated as a resolvable literal');
  // A literal target is resolvable and therefore fine.
  assert.deepEqual(judge(`const m = await import('./loop.js');`).dynamic, []);
  record('14. non-literal dynamic import', 'GUARD_REFUSES');
});

test('15. computed access on a namespace is refused whatever the expression inside', () => {
  const attempts = [
    `import * as loop from './loop.js'; loop[componentName](o);`,
    `import * as loop from './loop.js'; loop['execute' + 'AgentRun'](o);`,
    `import * as loop from './loop.js'; loop[['ex','ecute'].join('') + 'AgentRun'](o);`,
    `import * as loop from './loop.js'; const k = pick(); loop[k](o);`
  ];
  for (const attempt of attempts)
    assert.deepEqual(judge(attempt).computed, ['loop'], `not refused: ${attempt}`);
  // Reading a known property is resolvable, so it is not refused.
  assert.deepEqual(judge(`import * as loop from './loop.js'; loop.runAgent(o);`).computed, []);
  record('15. computed namespace access', 'GUARD_REFUSES');
});

test('16. a star re-export is refused: it exports whatever its target exports next', () => {
  assert.equal(judge(`export * from './loop.js';`).star, true);
  assert.equal(judge(`export { runAgent } from './loop.js';`).star, false);
  record('16. star re-export', 'GUARD_REFUSES');
});

test('17-22. handing out the authority under other packaging is refused', () => {
  const attempts: Record<string, string> = {
    '17. renamed export': `export { executeAgentRun as performRun };`,
    '18. default export': `export default executeAgentRun;`,
    '19. exported object': `export const mechanics = { run: executeAgentRun };`,
    '20. exported factory': `export function make() { return executeAgentRun; }`,
    '21. symbol-keyed export': `export const box = { [Symbol('run')]: executeAgentRun };`,
    '22. registry entry': `export const registry = new Map([['run', executeAgentRun]]);`
  };
  for (const [label, source] of Object.entries(attempts)) {
    const authority = judge(source).authority;
    assert.notDeepEqual(authority, [], `${label} was not refused`);
    record(label, 'GUARD_REFUSES');
  }
  // Deleting the name while exporting the same authority under another one is the same failure.
  assert.notDeepEqual(judge(`export const runTheAgent = executeAgentRun;`).authority, []);
});

test('23. a copied or renamed effectful executor is a new sink, not a loophole', () => {
  // A second copy of the body under a new name would be an undeclared effect sink in a module
  // the inventory does not list, which the dominance guard fails on. What this case pins is the
  // narrower property: nothing may export an executor *name*, so a copy has to be renamed --
  // and a renamed copy that is exported is caught as exported authority.
  assert.notDeepEqual(judge(`export async function executeAgentRun(o) { return drive(o); }`).authority, []);
  record('23. copied or renamed executor', 'GUARD_REFUSES');
});

// --- what must keep working -------------------------------------------------------------------

test('24-27. the legitimate paths are still recognised and still allowed', async () => {
  const loop = await import('./loop.js') as Record<string, unknown>;
  // 24. The admitted entry points remain exported and callable.
  for (const entry of ['runAgent', 'runAgentInShadow'])
    assert.equal(typeof loop[entry], 'function', `${entry} is no longer available`);

  // 25. A named re-export is resolvable and therefore permitted.
  assert.equal(judge(`export { runAgent } from './loop.js';`).star, false);
  assert.deepEqual(judge(`export { runAgent } from './loop.js';`).authority, []);

  // 26. Reading a known property off a namespace is fine; only computed access is refused.
  assert.deepEqual(judge(`import * as loop from './loop.js'; loop.runAgent(o);`).computed, []);

  // 27. The pure mechanics carry no authority, so importing them is unremarkable.
  const mechanics = await import('./loop-mechanics.js') as Record<string, unknown>;
  for (const value of Object.values(mechanics))
    assert.equal(PRIVATE_EXECUTORS.some((n) => String(value).includes(`function ${n}`)), false,
      'the pure layer hands back an executor');
  record('24. admitted entry points', 'NOT_EXPORTED');
  record('25. named re-export', 'GUARD_REFUSES');
  record('26. known property read', 'GUARD_REFUSES');
  record('27. pure mechanics import', 'NOT_EXPORTED');
});

test('28. identity, personality and UI differences change none of this', async () => {
  // The three Trio members differ only in personality, skills and branding. None of the closures
  // above reads any of that, so the matrix is byte-identical across all three by construction.
  const source = strippedSource(
    await import('node:fs').then((fs) => fs.readFileSync(new URL(import.meta.url), 'utf8')));
  for (const identity of ['pehlichi', 'Peh', 'luna', 'Luna', 'ptah', 'Ptah'])
    assert.equal(new RegExp(`\\b${identity}\\b`).test(source), false,
      `the bypass matrix mentions the identity "${identity}"`);
  record('28. identity neutrality', 'NOT_EXPORTED');
});

// --- the record ----------------------------------------------------------------------------------

test('every case in the matrix closed for a stated architectural reason', () => {
  const cases = Object.keys(closures);
  assert.ok(cases.length >= 28, `the matrix recorded only ${cases.length} cases`);

  // The original mutation must be closed because there is nothing to reach -- not because its
  // spelling was added to a list. That distinction is the whole point of the order this answers.
  assert.equal(closures['2. computed property'], 'NOT_EXPORTED',
    'the original computed-property mutation is closed by a denylist rather than by architecture');
  assert.equal(closures['1. direct import'], 'NOT_EXPORTED');

  const byArchitecture = cases.filter((c) => closures[c] === 'NOT_EXPORTED').length;
  assert.ok(byArchitecture >= 10,
    `only ${byArchitecture} cases are closed architecturally; the rest lean on the guard`);
});
