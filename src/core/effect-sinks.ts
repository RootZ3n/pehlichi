/**
 * Every production module that can cause an effect, and which kinds.
 *
 * An independent audit reached the agent-run executor from a disposable production module using
 * a namespace import and a computed property name. Making that one function private closes that
 * one door; this inventory is what makes the *class* of defect visible, by writing down where
 * the effects actually are so a new one cannot appear unnoticed.
 *
 * The guard in `admission-dominance.test.ts` re-derives this from the sources and refuses any
 * difference in either direction: a module that grows an effect and is not listed here fails,
 * and a module listed here that no longer has one fails too. A stale inventory is worse than
 * none, because it reads as though somebody checked.
 *
 * This is data. It imports nothing and executes nothing, so listing a module here grants it no
 * capability -- it only records that the module already had one.
 */

/** The kinds of effect this codebase can have. Adding a kind is a deliberate, reviewed edit. */
export type EffectClass =
  | 'child-process'
  | 'dynamic-code'
  | 'filesystem-mutation'
  | 'model-provider-request'
  | 'network'
  | 'tool-invocation';

/**
 * The syntax each effect class is recognised by.
 *
 * Kept here beside the inventory rather than in the guard, because the guard re-derives the
 * inventory from these and a generator regenerates it from these -- two copies of a regex is
 * how an inventory and its checker come to disagree about what an effect is.
 */
export const SINK_PATTERNS: Readonly<Record<EffectClass, readonly RegExp[]>> = Object.freeze({
  'child-process': [/from ['"]node:child_process['"]/, /\bspawnSync?\s*\(/, /\bexecFileSync?\s*\(/, /\bexecSync\s*\(/, /\bfork\s*\(/],
  'filesystem-mutation': [/\bwriteFileSync?\s*\(/, /\bmkdirSync?\s*\(/, /\brmSync\s*\(/, /\bunlinkSync\s*\(/, /\brenameSync\s*\(/, /\bappendFileSync\s*\(/, /\bcpSync\s*\(/, /\bchmodSync\s*\(/, /\bsymlinkSync\s*\(/, /\brmdirSync\s*\(/],
  network: [/\bfetch\s*\(/, /from ['"]node:(http|https|net|dgram|tls)['"]/, /new WebSocket/, /\.request\s*\(/],
  'model-provider-request': [/class \w*Driver\b/, /implements Driver\b/, /\brunTurn\s*\(/],
  'tool-invocation': [/createToolRegistry\s*\(/, /\bhandler\s*\(\s*args/, /toolSpecs\s*\(/],
  'dynamic-code': [/(?<![.\w])import\s*\(/, /createRequire/, /new Function\s*\(/, /\beval\s*\(/, /new Worker\b/]
});

/**
 * Source with comments and string literals removed.
 *
 * Both the inventory generator and the guard read code through this, so a word appearing in
 * prose or in a message string is never mistaken for a call. An earlier version of the guard
 * matched "exec" inside the word "execute_code", and "require" inside the phrase "is required".
 */
export function strippedSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)\/\/[^\n]*/g, ' ')
    // An interpolated template is not a literal target: `import(`${base}/loop.js`)` cannot be
    // followed. Collapsing it to the same `` as a plain template would have hidden that.
    .replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.includes('${') ? '`INTERPOLATED`' : '``'))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    // A type position is not dynamic code: `import('playwright').Page` executes nothing.
    .replace(/:\s*import\s*\(/g, ': TYPE(');
}

/** The effect classes a module's source actually holds. */
export function observedEffectClasses(code: string): EffectClass[] {
  const found: EffectClass[] = [];
  for (const [cls, patterns] of Object.entries(SINK_PATTERNS) as [EffectClass, readonly RegExp[]][])
    if (patterns.some((pattern) => pattern.test(code))) found.push(cls);
  return found.sort();
}

/** Production module path (repository-relative) to the effect classes it holds. */
export const EFFECT_SINKS: Readonly<Record<string, readonly EffectClass[]>> = Object.freeze({
  'runtime/server/chat.ts': ['network'],
  'runtime/server/kernel-session.ts': ['filesystem-mutation', 'model-provider-request'],
  'runtime/server/model-switch.ts': ['model-provider-request'],
  'runtime/server/provenance.ts': ['child-process'],
  'runtime/server/server.ts': ['filesystem-mutation', 'tool-invocation'],
  'runtime/server/truth-agent-adapter.ts': ['child-process'],
  'runtime/server/truth-gate.ts': ['child-process'],
  'src/cli/repl.ts': ['network'],
  'src/core/agent-tools/browser-manager.ts': ['dynamic-code'],
  'src/core/agent-tools/browser-tools.ts': ['filesystem-mutation'],
  'src/core/agent-tools/coordination-tools.ts': ['filesystem-mutation'],
  'src/core/agent-tools/cron-tools.ts': ['filesystem-mutation'],
  'src/core/agent-tools/enhanced-file-tools.ts': ['child-process', 'filesystem-mutation'],
  'src/core/agent-tools/execute-code-tools.ts': ['child-process', 'filesystem-mutation'],
  'src/core/agent-tools/git-ops-tools.ts': ['child-process'],
  'src/core/agent-tools/ikbi-tools.ts': ['network'],
  'src/core/agent-tools/luak-tools.ts': ['network'],
  'src/core/agent-tools/memory-governance.ts': ['filesystem-mutation'],
  'src/core/agent-tools/memory-tools.ts': ['filesystem-mutation'],
  'src/core/agent-tools/music-tools.ts': ['dynamic-code', 'network'],
  'src/core/agent-tools/openrouter-driver.ts': ['model-provider-request'],
  'src/core/agent-tools/phone-tools.ts': ['child-process', 'filesystem-mutation'],
  'src/core/agent-tools/provider-chain.ts': ['model-provider-request'],
  'src/core/agent-tools/skill-tools.ts': ['filesystem-mutation'],
  'src/core/agent-tools/vision-tools.ts': ['network'],
  'src/core/agent-tools/web-tools.ts': ['network'],
  'src/core/bridges/bridge-tools.ts': ['network'],
  'src/core/bridges/http-bridge.ts': ['network'],
  'src/core/bridges/registry.ts': ['network'],
  'src/core/checkpoint.ts': ['filesystem-mutation'],
  'src/core/context-compressor.ts': ['network'],
  // The vendored containment authority. `availability` probes by RUNNING a no-op policy --
  // a version string is not evidence that the boundary works on this host. `conformance`
  // exercises the boundary for real, which is the only way its result means anything.
  'src/core/containment/availability.ts': ['child-process'],
  'src/core/containment/conformance.ts': ['child-process', 'filesystem-mutation'],
  // `wrap` materialises the reviewed AF_UNIX syscall filter where the run already owns writable
  // space, then hands the caller a read-only descriptor on it. Without a filter to load, bwrap
  // would start without one -- so preparing it is part of the boundary, not incidental IO.
  'src/core/containment/wrap.ts': ['filesystem-mutation'],

  'src/core/driver.ts': ['model-provider-request'],
  'src/core/drivers/llamacpp.ts': ['model-provider-request'],
  'src/core/drivers/mimo.ts': ['model-provider-request'],
  'src/core/drivers/ollama.ts': ['model-provider-request'],
  'src/core/effect-sinks.ts': ['dynamic-code', 'model-provider-request', 'network'],
  'src/core/external-runtime-integrity.ts': ['dynamic-code'],
  'src/core/gbrain-bridge.ts': ['child-process'],
  'src/core/lab-transcript.ts': ['filesystem-mutation'],
  'src/core/loop.ts': ['tool-invocation'],
  // Pre-model qualification checking. `child-process` because the subject's own commit and
  // tree are read from git rather than taken from the caller; `filesystem-mutation` because
  // consuming a nonce and writing a refusal receipt are both durable writes, and both must
  // happen before anything reaches a model or a tool.
  'src/core/qualification-admission.ts': ['child-process', 'filesystem-mutation'],
  'src/core/scenario.ts': ['child-process', 'filesystem-mutation'],
  'src/core/shadow.ts': ['filesystem-mutation'],
  'src/core/subagent-entry.ts': ['filesystem-mutation'],
  'src/core/temp-authority.ts': ['filesystem-mutation'],
  'src/core/tools.ts': ['child-process', 'tool-invocation'],
  'tui/src/harness.ts': ['dynamic-code'],
  'tui/src/truth-conformance-harness.ts': ['child-process', 'filesystem-mutation'],
});

/**
 * The one module permitted a dynamic import whose target is not a literal.
 *
 * Everywhere else a non-literal `import()` is refused outright: it is a hole a call-graph
 * cannot see through, and the order this inventory answers to requires unresolved production
 * reachability to fail closed. `external-runtime-integrity.ts` is the exception because its
 * target is not free -- the entrypoint must appear in a committed declaration, the dependency
 * root is digest-verified, and a path escape or a symlink is refused before the import happens.
 * The guard checks those three containments are still present rather than taking this on trust.
 */
export const GOVERNED_DYNAMIC_IMPORT = 'src/core/external-runtime-integrity.ts';

/**
 * Where an agent turn can begin.
 *
 * These are the request-reachable surfaces: the public API, the HTTP chat lane, the Matrix
 * bridge, the CLI and the task runner. Each one must reach an admission decision before it
 * reaches any of the sinks above; that is the invariant the dominance guard enforces.
 */
export const WORK_SURFACES: readonly string[] = Object.freeze([
  'src/index.ts',
  'src/core/index.ts',
  'runtime/server/chat.ts',
  'tui/src/server.ts'
]);

/**
 * Surfaces a request can reach that start no work at all.
 *
 * The REPL is an HTTP client: it `fetch`es the server's routes and prints what comes back. It
 * holds no driver, no tool registry, no subprocess and no executor, so it has no in-process path
 * to an effect at all -- what admits or refuses its request is the server's own gate, on the
 * other side of the socket. A client that has to ask is not a bypass.
 *
 * `network` is therefore the only effect class permitted here, and the guard enforces exactly
 * that: if this surface ever grows a driver, a registry, a subprocess or a dynamic import, it
 * has become able to start work in process and must move to `WORK_SURFACES` and be dominated
 * like the rest.
 */
export const NON_WORK_SURFACES: readonly string[] = Object.freeze([
  'src/cli/repl.ts'
]);

/** The only effect a non-work surface may hold: a request to a gate that lives elsewhere. */
export const NON_WORK_PERMITTED_EFFECTS: readonly EffectClass[] = Object.freeze(['network']);

/**
 * The admission decision itself, and the only two functions permitted to enter the executor.
 *
 * `admitRunWork` decides; `runAgent` and `runAgentInShadow` are the gated entry points that
 * call it and then, only on an admission, reach the private executor. Nothing else may.
 */
export const ADMISSION_DECISION = 'src/core/operational-admission.ts';
export const GATED_ENTRY_POINTS: readonly string[] = Object.freeze(['runAgent', 'runAgentInShadow']);

/** The executors that must never be exported, under any name or spelling. */
export const PRIVATE_EXECUTORS: readonly string[] = Object.freeze(['executeAgentRun', 'executeAgentInShadow']);

// --- the constructs a dominance guard cannot reason about ---------------------------------
//
// Each of these answers one question about a module's source, and each is used twice: by the
// dominance guard over the real production closure, and by the hostile bypass matrix over
// disposable snippets. Sharing them is the point -- a matrix that proves a bypass is caught by
// its own copy of the rule has proved nothing about the rule that actually runs.

/** Does this source star-re-export? Such a module exports whatever its target exports next. */
export function starReExports(code: string): boolean {
  return /export\s*\*\s*from/.test(code);
}

/**
 * Namespace objects read with a computed property.
 *
 * `ns[expr]` cannot be resolved by reading it, so it is refused wherever it appears in the
 * production closure. This is the audit's construct as a class rather than as a spelling: it
 * catches `"execute" + "AgentRun"` and equally `["ex","ecute"].join("") + "AgentRun"`, because
 * it never looks at what is inside the brackets.
 */
export function computedNamespaceAccess(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/import\s*\*\s*as\s+(\w+)\s+from/g)) {
    const namespace = match[1];
    if (namespace === undefined) continue;
    if (new RegExp(`\\b${namespace}\\s*\\[(?!\\s*\\d+\\s*\\])`).test(code)) found.push(namespace);
  }
  return found;
}

/** Dynamic imports whose target is not a literal, and so cannot be followed. */
export function nonLiteralDynamicImports(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/(?<![.\w])import\s*\(([^)]*)\)/g)) {
    const target = (match[1] ?? '').trim();
    if (!/^(''|""|``)$/.test(target)) found.push(target || '…');
  }
  return found;
}

/**
 * Ways a source hands out one of the named executors.
 *
 * Not only `export function x` -- an alias, an object property, a factory return, a symbol key
 * or a registry entry is the same authority leaving the module under different packaging, which
 * is what "deleting the name while exporting equivalent authority" would look like.
 */
export function exportedAuthority(code: string, names: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of names) {
    if (new RegExp(`export\\s+(async\\s+)?(function|const|let|var|class)\\s+${name}\\b`).test(code))
      found.push(`${name}: direct export`);
    if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(code))
      found.push(`${name}: export clause`);
    if (new RegExp(`export\\s+default\\s+[^;]*\\b${name}\\b`).test(code))
      found.push(`${name}: default export`);
    // Packaged inside something exported: an object literal, a returned value, a registry.
    const packaged = new RegExp(
      `export\\s+(async\\s+)?(function|const|let|var|class)[\\s\\S]{0,4000}?\\b${name}\\b`);
    if (!found.some((f) => f.startsWith(`${name}:`)) && packaged.test(code))
      found.push(`${name}: reachable from an exported binding`);
  }
  return found;
}
