/**
 * Advisory truth-firewall bridge over an explicitly declared, digest-verified
 * optional executable dependency. Environment variables may select memory DATA,
 * never executable module roots.
 */
import { join } from 'node:path';
import { importVerifiedExternal, verifiedExternalDependencyRoot } from './external-runtime-integrity.js';

let cached: Record<string, unknown> | null | undefined;
async function facade(): Promise<Record<string, unknown> | null> {
  if (cached !== undefined) return cached;
  try {
    cached = await importVerifiedExternal('truth-firewall', 'dist/src/lab-cognition.js');
  } catch {
    cached = null;
  }
  return cached;
}

function labmemDataRoot(): string {
  return process.env.LABMEM_ROOT ?? verifiedExternalDependencyRoot('labmem');
}

export interface TruthCognitionInput {
  readonly task?: string;
  readonly recentRefs?: readonly string[];
  readonly labmemRoot?: string;
}

export interface TruthFacade {
  readonly cognitionForAgent?: (value: unknown) => unknown;
  readonly renderCognitionForPrompt?: (value: unknown) => string;
  readonly reviewLabMemoryProposals?: (
    directories: readonly string[], options?: unknown,
  ) => { processed: number; hallucinations: number; skippedDuplicates: number; inboxes: number };
}

/** Pure adapter seam for deterministic tests; production loading remains digest-bound above. */
export function renderTruthCognition(loaded: TruthFacade, input: TruthCognitionInput): string {
  if (typeof loaded.cognitionForAgent !== 'function') return '';
  const summary = loaded.cognitionForAgent({
    labmemRoot: input.labmemRoot ?? labmemDataRoot(),
    task: input.task ?? '',
    recentRefs: input.recentRefs ?? [],
  });
  return typeof loaded.renderCognitionForPrompt === 'function'
    ? (loaded.renderCognitionForPrompt(summary) || '') : '';
}

export function renderProposalReview(loaded: TruthFacade, directories: readonly string[]): string {
  if (typeof loaded.reviewLabMemoryProposals !== 'function') return '';
  const result = loaded.reviewLabMemoryProposals(directories);
  if (!result || (result.processed === 0 && result.hallucinations === 0)) return '';
  return `truth-review: ${result.processed} new proposal-claim(s), ${result.hallucinations} advisory hallucination(s) across ${result.inboxes} inbox(es)`;
}

export async function truthCognition(input: TruthCognitionInput = {}): Promise<string> {
  try {
    const loaded = await facade();
    if (!loaded) return '';
    return renderTruthCognition(loaded as TruthFacade, input);
  } catch {
    return '';
  }
}

export async function reviewProposals(inboxDirs?: readonly string[]): Promise<string> {
  try {
    const loaded = await facade();
    if (!loaded) return '';
    const dirs = inboxDirs?.length ? inboxDirs : [join(labmemDataRoot(), 'proposals')];
    return renderProposalReview(loaded as TruthFacade, dirs);
  } catch {
    return '';
  }
}
