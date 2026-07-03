/**
 * TRUTH BRIDGE (lab overlay) — folds an advisory memory-truth read into an agent's turn.
 *
 * Dynamic-imports truth-firewall's lab-cognition facade (`dist/src/lab-cognition.js`) at
 * RUNTIME — never a static import — so a released standalone build (which ships no
 * truth-firewall) simply gets ''. Lab-only, gated by the caller. Never throws.
 *
 * Resolution: TRUTH_FIREWALL_ROOT wins; else walk up to `ecosystem/` and look at the sibling
 * `lab-utilities/truth-firewall`. labmem root mirrors labmem-tools (LABMEM_ROOT ?? vendored).
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveTruthRoot(): string | undefined {
  if (process.env['TRUTH_FIREWALL_ROOT']) return process.env['TRUTH_FIREWALL_ROOT'];
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (basename(d) === 'ecosystem') return join(dirname(d), 'lab-utilities', 'truth-firewall');
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return undefined;
}

function resolveLabmemRoot(): string {
  if (process.env['LABMEM_ROOT']) return process.env['LABMEM_ROOT'];
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (basename(d) === 'ecosystem') return join(d, 'lab-memory', 'labmem');
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return join(process.cwd(), 'lab-memory', 'labmem');
}

/** Cache the imported facade per resolved root (null = tried and unavailable). */
const _cache = new Map<string, unknown>();

async function facade(): Promise<Record<string, unknown> | null> {
  const root = resolveTruthRoot();
  if (!root) return null;
  if (_cache.has(root)) return _cache.get(root) as Record<string, unknown> | null;
  let mod: Record<string, unknown> | null = null;
  try {
    mod = (await import(join(root, 'dist', 'src', 'lab-cognition.js'))) as Record<string, unknown>;
  } catch {
    mod = null;
  }
  _cache.set(root, mod);
  return mod;
}

export interface TruthCognitionInput {
  /** Current task/message text (context for the consistency audit). */
  readonly task?: string;
  /** Memory ids the agent recently relied on. */
  readonly recentRefs?: readonly string[];
  /** Override the labmem store root (defaults to the vendored/LABMEM_ROOT store). */
  readonly labmemRoot?: string;
}

/**
 * A compact advisory memory-truth block for a turn, or '' when truth-firewall is unavailable
 * (release / not built), memory is empty, or memory is healthy. Never throws.
 */
export async function truthCognition(input: TruthCognitionInput = {}): Promise<string> {
  try {
    const f = await facade();
    if (!f || typeof f['cognitionForAgent'] !== 'function') return '';
    const cognitionForAgent = f['cognitionForAgent'] as (a: unknown) => unknown;
    const render = f['renderCognitionForPrompt'] as ((s: unknown) => string) | undefined;
    const summary = cognitionForAgent({
      labmemRoot: input.labmemRoot ?? resolveLabmemRoot(),
      task: input.task ?? '',
      recentRefs: input.recentRefs ?? [],
    });
    return typeof render === 'function' ? (render(summary) || '') : '';
  } catch {
    return '';
  }
}

/**
 * Trigger truth-firewall's ADVISORY review of durable/global memory proposals. Defaults to the
 * labmem shared-proposals inbox (`<LABMEM_ROOT>/proposals`). Verdicts persist to the firewall
 * store (surfaced later in ittunaha); returns a compact summary or '' (absent/nothing new).
 * Never throws — safe to fire-and-forget.
 */
export async function reviewProposals(inboxDirs?: readonly string[]): Promise<string> {
  try {
    const f = await facade();
    if (!f || typeof f['reviewLabMemoryProposals'] !== 'function') return '';
    const review = f['reviewLabMemoryProposals'] as (
      dirs: readonly string[],
      opts?: unknown,
    ) => { processed: number; hallucinations: number; skippedDuplicates: number; inboxes: number };
    const dirs = inboxDirs && inboxDirs.length ? inboxDirs : [join(resolveLabmemRoot(), 'proposals')];
    const r = review(dirs);
    if (!r || (r.processed === 0 && r.hallucinations === 0)) return '';
    return `truth-review: ${r.processed} new proposal-claim(s), ${r.hallucinations} advisory hallucination(s) across ${r.inboxes} inbox(es)`;
  } catch {
    return '';
  }
}
