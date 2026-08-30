/**
 * Every production path to an effect passes through the admission decision.
 *
 * The previous guard checked spellings. It knew the names `executeAgentRun` and
 * `executeAgentInShadow` and looked for them, and an independent audit walked past it with
 *
 *     import * as loopMechanics from "./loop.js";
 *     const componentName = "execute" + "AgentRun";
 *     return loopMechanics[componentName](options);
 *
 * because a computed property has no spelling to find. Adding `"execute" + "AgentRun"` to a
 * denylist would have fixed that expression and nothing else -- the next one would be
 * `["ex","ecute"].join("") + "AgentRun"`, or a re-export, or an object, or a factory.
 *
 * So this suite asks a structural question instead: can any production module obtain something
 * that executes, without the admission decision on the way? It works over the module graph
 * rather than over identifiers, and where it cannot resolve a construct it refuses rather than
 * assuming the construct is harmless. Failing closed on what it cannot see is the difference
 * between a guard and a reassurance.
 *
 * What it does NOT claim: this is not a sound inter-procedural analysis, and a sufficiently
 * indirect chain inside one module could still hide something from it. It is defence in depth
 * behind the property that actually closes the escape -- the executors are not exported, so
 * there is no namespace property to reach at all. This suite exists so that property cannot be
 * quietly undone, and so a new effect cannot appear on an ungated surface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_DECISION, EFFECT_SINKS, GATED_ENTRY_POINTS, GOVERNED_DYNAMIC_IMPORT,
  NON_WORK_PERMITTED_EFFECTS, NON_WORK_SURFACES, PRIVATE_EXECUTORS, WORK_SURFACES,
  computedNamespaceAccess, nonLiteralDynamicImports, observedEffectClasses, starReExports,
  strippedSource
} from './effect-sinks.js';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, '..', '..');

interface Source { path: string; text: string; code: string }


/** Every committed production source: the runtime closure, tests and build tooling excluded. */
function productionSources(): Source[] {
  const out: Source[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (['node_modules', 'dist', '.git', 'fixtures'].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { visit(full); continue; }
      if (!/\.(ts|mts|mjs)$/.test(entry)) continue;
      if (/\.test\.(ts|mjs)$/.test(entry) || /\.d\.ts$/.test(entry)) continue;
      const text = readFileSync(full, 'utf8');
      out.push({ path: relative(repositoryRoot, full).split(sep).join('/'), text, code: strippedSource(text) });
    }
  };
  for (const root of ['src', 'runtime', 'tui/src']) visit(join(repositoryRoot, root));
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const SOURCES = productionSources();
const byPath = new Map(SOURCES.map((s) => [s.path, s]));



// --- the inventory is true ---------------------------------------------------------------

test('the effect-sink inventory matches the code, in both directions', () => {
  const undeclared: string[] = [];
  const stale: string[] = [];
  for (const source of SOURCES) {
    const observed = observedEffectClasses(source.code);
    const declared = [...(EFFECT_SINKS[source.path] ?? [])].sort();
    if (observed.length && !EFFECT_SINKS[source.path]) { undeclared.push(`${source.path} holds ${observed.join(', ')}`); continue; }
    if (!observed.length && EFFECT_SINKS[source.path]) { stale.push(`${source.path} declares ${declared.join(', ')} and has none`); continue; }
    if (observed.join('|') !== declared.join('|'))
      undeclared.push(`${source.path}: declared [${declared.join(', ')}] but holds [${observed.join(', ')}]`);
  }
  // A new sink appearing without classification is the thing this catches. The reverse matters
  // too: an inventory that lists effects nobody has any more reads as though somebody checked.
  assert.deepEqual(undeclared, [], `undeclared or misclassified effect sinks:\n  ${undeclared.join('\n  ')}`);
  assert.deepEqual(stale, [], `stale inventory entries:\n  ${stale.join('\n  ')}`);
});

test('every inventoried module still exists', () => {
  const missing = Object.keys(EFFECT_SINKS).filter((p) => !byPath.has(p));
  assert.deepEqual(missing, [], `the inventory names modules that are gone:\n  ${missing.join('\n  ')}`);
});

// --- authority is not exported --------------------------------------------------------------

test('no production module exports an operationally capable below-admission executor', () => {
  const offenders: string[] = [];
  for (const source of SOURCES) {
    for (const name of PRIVATE_EXECUTORS) {
      if (new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${name}\\b`).test(source.code))
        offenders.push(`${source.path} exports ${name}`);
      if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source.code))
        offenders.push(`${source.path} re-exports ${name}`);
      // Renaming on the way out is the same escape wearing a different label.
      if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\s+as\\s+\\w+`).test(source.code))
        offenders.push(`${source.path} exports ${name} under an alias`);
    }
  }
  assert.deepEqual(offenders, [], `an effectful executor is exported:\n  ${offenders.join('\n  ')}`);
});

test('the executors are reachable only from inside the module that defines them', () => {
  const definer = 'src/core/loop.ts';
  const offenders = SOURCES
    .filter((s) => s.path !== definer)
    .filter((s) => PRIVATE_EXECUTORS.some((n) => new RegExp(`\\b${n}\\b`).test(s.code)))
    .map((s) => s.path);
  assert.deepEqual(offenders, [], `a module outside ${definer} names an executor:\n  ${offenders.join('\n  ')}`);
});

test('a runtime namespace probe finds no importable operational executor', async () => {
  // The structural checks above read source. This one asks the module system, which is what the
  // audit actually did -- and reproduces its exact expression.
  for (const specifier of ['./loop.js', './index.js', '../index.js', '../../runtime/core/loop.js']) {
    const resolved = join(here, specifier);
    if (!existsSync(resolved.replace(/\.js$/, '.ts')) && !existsSync(resolved)) continue;
    const namespace = await import(specifier) as Record<string, unknown>;
    const keys = [...Object.keys(namespace), ...Object.getOwnPropertyNames(namespace)];
    for (const name of PRIVATE_EXECUTORS)
      assert.equal(keys.includes(name), false, `${specifier} exposes ${name}`);
    assert.equal(namespace['execute' + 'AgentRun'], undefined, `${specifier}: the computed bypass resolves`);
    assert.equal(namespace['execute' + 'AgentInShadow'], undefined);
    // Nor under a symbol, which a property-name check alone would miss.
    for (const symbol of Object.getOwnPropertySymbols(namespace))
      assert.notEqual(typeof (namespace as Record<symbol, unknown>)[symbol], 'function',
        `${specifier} carries a callable under a symbol key`);
  }
});

// --- constructs the guard refuses to reason about ------------------------------------------

test('no production module star-re-exports another: it exports whatever that one exports next', () => {
  const offenders = SOURCES.filter((s) => starReExports(s.code)).map((s) => s.path);
  assert.deepEqual(offenders, [], `a star re-export hides its own surface:\n  ${offenders.join('\n  ')}`);
});

test('a dynamic import with a non-literal target fails closed everywhere but the governed one', () => {
  const offenders: string[] = [];
  for (const source of SOURCES) {
    if (source.path === GOVERNED_DYNAMIC_IMPORT) continue;
    for (const target of nonLiteralDynamicImports(source.code))
      offenders.push(`${source.path}: import(${target})`);
  }
  assert.deepEqual(offenders, [], `an unresolvable dynamic import in the production closure:\n  ${offenders.join('\n  ')}`);
});

test('the one governed dynamic import still bounds its own target', () => {
  // It is permitted because the target is not free: the entrypoint must be in a committed
  // declaration, the dependency root is digest-verified, and an escape or symlink is refused
  // before the import happens. Those three are the reason for the exemption, so they are
  // checked rather than assumed -- an exemption that outlives its justification is a hole.
  const source = byPath.get(GOVERNED_DYNAMIC_IMPORT);
  assert.ok(source, `${GOVERNED_DYNAMIC_IMPORT} is gone; the exemption must go with it`);
  assert.match(source.code, /dynamicEntrypoints\?\.includes\(/, 'the entrypoint is no longer checked against a committed declaration');
  assert.match(source.code, /verifiedExternalDependencyRoot\(/, 'the dependency root is no longer verified');
  assert.match(source.code, /isSymbolicLink\(\)/, 'a symlinked entrypoint is no longer refused');
  assert.match(source.code, /startsWith\(`\.\.\$\{sep\}`\)|startsWith\('\.\.'\)|relative\(/, 'a path escape is no longer refused');
});

test('no production module reads a namespace with a computed property', () => {
  // The audit's construct, as a class rather than as a spelling. A computed member access on a
  // module namespace cannot be resolved by reading it, so it is refused wherever it appears in
  // the production closure -- whatever the expression inside the brackets happens to be.
  const offenders: string[] = [];
  for (const source of SOURCES)
    for (const namespace of computedNamespaceAccess(source.code))
      offenders.push(`${source.path}: computed access on namespace "${namespace}"`);
  assert.deepEqual(offenders, [], `unresolved computed namespace access:\n  ${offenders.join('\n  ')}`);
});

// --- dominance ---------------------------------------------------------------------------------

/** Resolve a relative import specifier to a repository-relative production module path. */
function resolveImport(fromPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(repositoryRoot, dirname(fromPath), specifier).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}.mts`, `${base}.mjs`, join(base, 'index.ts')]) {
    const rel = relative(repositoryRoot, candidate).split(sep).join('/');
    if (byPath.has(rel)) return rel;
  }
  return null;
}

/** The production import graph, as adjacency over repository-relative paths. */
function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const source of SOURCES) {
    const targets = new Set<string>();
    for (const match of source.code.matchAll(/(?:from|import)\s*\(?\s*(?:'|"|``)/g)) void match;
    for (const match of source.text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveImport(source.path, match[1] ?? '');
      if (resolved) targets.add(resolved);
    }
    graph.set(source.path, [...targets]);
  }
  return graph;
}

const GRAPH = importGraph();

/** Every module reachable from a starting set, following production imports. */
function reachable(from: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...from];
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current) || !byPath.has(current)) continue;
    seen.add(current);
    for (const next of GRAPH.get(current) ?? []) queue.push(next);
  }
  return seen;
}

test('every work surface reaches the admission decision', () => {
  // The dominance property has two halves. This is the first: a surface that can start work
  // must be able to see the gate at all. A surface that cannot reach the decision module has
  // no way to be dominated by it.
  const surfaces = WORK_SURFACES.filter((s) => byPath.has(s));
  assert.ok(surfaces.length >= 3, `only ${surfaces.length} work surfaces resolved; the inventory is stale`);
  const unreachable = surfaces.filter((surface) => !reachable([surface]).has(ADMISSION_DECISION));
  assert.deepEqual(unreachable, [],
    `a work surface cannot reach the admission decision:\n  ${unreachable.join('\n  ')}`);
});

test('the loop reaches the executor only after deciding, and the decision reads nothing from the caller', () => {
  const loop = byPath.get('src/core/loop.ts');
  assert.ok(loop, 'src/core/loop.ts is gone');
  for (const entry of GATED_ENTRY_POINTS) {
    // Read from the raw text: stripping blanks string literals, and the literal category is
    // exactly what must be asserted -- `admitRunWork('agent-run')`, never a caller's value.
    const start = loop.text.indexOf(`export async function ${entry}`);
    assert.notEqual(start, -1, `${entry} is no longer the exported gated entry point`);
    const body = loop.text.slice(start, loop.text.indexOf('\n}', start));
    assert.match(body, /admitRunWork\(\s*'[a-z-]+'\s*\)/, `${entry} does not decide from a literal category`);
    assert.match(body, /if\s*\(\s*!\s*\w+\.admitted\s*\)\s*throw/, `${entry} does not refuse on a non-admission`);
    // The decision comes before the executor, textually and therefore in execution order.
    const decisionAt = body.indexOf('admitRunWork');
    const executorAt = Math.min(...PRIVATE_EXECUTORS.map((n) => {
      const at = body.indexOf(n); return at === -1 ? Number.MAX_SAFE_INTEGER : at;
    }));
    assert.ok(decisionAt < executorAt, `${entry} reaches an executor before deciding`);
  }
});

test('no production surface other than the gated entry points enters an executor', () => {
  // Any module that both reaches a sink and is reachable from a request surface must go through
  // the gate. The executors being private makes that structural; this checks the property that
  // makes it structural has not been quietly relaxed by a new caller inside loop.ts itself.
  const loop = byPath.get('src/core/loop.ts')!;
  // A definition is not a call. `async function executeAgentRun(` matched the old pattern and
  // made the executor look like its own caller.
  const callSites = [...loop.code.matchAll(/(?<!function\s)\b(executeAgentRun|executeAgentInShadow)\s*\(/g)]
    .map((m) => loop.code.slice(0, m.index).split('\n').length);
  const callerOf = (line: number): string => {
    const before = loop.code.split('\n').slice(0, line).reverse();
    for (const text of before) {
      const match = text.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (match) return match[1] ?? '?';
    }
    return '?';
  };
  const callers = [...new Set(callSites.map(callerOf))].sort();
  // `runAgent` gates and calls the executor; `runAgentInShadow` gates and calls the shadow one,
  // which calls the executor beneath it. Nothing else may.
  assert.deepEqual(callers, ['executeAgentInShadow', 'runAgent', 'runAgentInShadow'].sort(),
    `unexpected callers of an executor inside loop.ts: ${callers.join(', ')}`);
});

test('the admission decision itself takes nothing from a caller that could change its answer', () => {
  const admission = byPath.get(ADMISSION_DECISION);
  assert.ok(admission, `${ADMISSION_DECISION} is gone`);
  assert.equal(admission.code.includes('process.env'), false, 'the decision reads the environment');
  assert.equal(/\bauthority\b|\bpurpose\b/.test(admission.code), false,
    'the decision has grown a caller-supplied authority or purpose again');
});

// --- surfaces that must stay open ------------------------------------------------------------

test('a surface declared to start no work holds nothing that could', () => {
  for (const surface of NON_WORK_SURFACES) {
    const source = byPath.get(surface);
    assert.ok(source, `${surface} is gone; the declaration must go with it`);
    // It may reach the gate over the network; it may not do work on this side of the socket.
    const held = EFFECT_SINKS[surface] ?? [];
    const inProcess = held.filter((cls) => !NON_WORK_PERMITTED_EFFECTS.includes(cls));
    assert.deepEqual(inProcess, [],
      `${surface} is declared to start no work but holds ${inProcess.join(', ')} in process`);
    for (const name of [...PRIVATE_EXECUTORS, ...GATED_ENTRY_POINTS])
      assert.equal(new RegExp(`\\b${name}\\b`).test(source.code), false,
        `${surface} is declared to start no work but names ${name}`);
  }
});

test('status and health surfaces do not depend on the executor', () => {
  // Dominance must not be achieved by refusing everything. A status or health route reads state
  // and performs no work, so it must remain reachable without touching an executor at all.
  for (const surface of ['runtime/server/chat.ts', 'tui/src/server.ts']) {
    const source = byPath.get(surface);
    if (!source) continue;
    for (const name of PRIVATE_EXECUTORS)
      assert.equal(new RegExp(`\\b${name}\\b`).test(source.code), false, `${surface} names ${name}`);
  }
});
