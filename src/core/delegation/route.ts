/**
 * ROUTE SELECTION — structural, never textual.
 *
 * The question "should this be delegated?" is answered from the SHAPE of the request, not from
 * words in the goal. A router that greps the prose for "fix" or "refactor" is a benchmark
 * detector: it scores well on phrasings someone anticipated and fails on the ones they did not,
 * and it can be steered by whoever writes the sentence. So nothing here reads `goal` at all —
 * it is carried through to ikbi and is otherwise inert.
 *
 * What the router reads instead is what the work REQUIRES: does it change a repository, is the
 * repository named, is the mutation scoped, is there something deterministic to check it against.
 * Those are facts about authority, and they are exactly the facts ikbi will refuse without.
 */

/** One deterministic check ikbi runs to decide whether a candidate is acceptable. */
export interface AcceptanceCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Repository-relative working directory. Absent means the repository root. */
  readonly cwd?: string;
}

/**
 * A governed work request, as a Trio agent states it.
 *
 * `mutates` is the agent's declaration that the work changes a repository. It is a claim about the
 * WORK, not about the wording, and every authority requirement below hangs off it.
 */
export interface WorkRequest {
  /** Free text for the implementer. Never read by the router. */
  readonly goal: string;
  /** Does completing this require changing a repository? */
  readonly mutates: boolean;
  /** Absolute path of the target repository. */
  readonly repository?: string;
  /** Exact repository-relative files/trees this work may change. */
  readonly allowedPaths?: readonly string[];
  /** Deterministic acceptance. Without it "done" is only an opinion. */
  readonly checks?: readonly AcceptanceCheck[];
  /**
   * Whether bounded local reconnaissance/second-opinion is plausibly useful here. It selects
   * ikbi's local-mode; it never grants the local specialist any authority.
   */
  readonly localAnalysisUseful?: boolean;
}

export type Route = 'DIRECT' | 'IKBI' | 'IKBI_WITH_LOCAL_ASSIST' | 'REFUSE_OR_CLARIFY';

/** Why the router chose what it chose. Stable identifiers, safe to assert on. */
export type RouteReason =
  | 'no_mutation_required'
  | 'repository_missing'
  | 'repository_outside_authorized_scope'
  | 'mutation_scope_missing'
  | 'acceptance_criteria_missing'
  | 'governed_implementation'
  | 'governed_implementation_with_local_analysis';

export interface RouteDecision {
  readonly route: Route;
  readonly reason: RouteReason;
  /** One sentence an operator can read. Derived from the reason, never from the goal. */
  readonly explanation: string;
}

const EXPLANATION: Readonly<Record<RouteReason, string>> = Object.freeze({
  no_mutation_required:
    'the work changes no repository, so the agent does it directly; a governed build would add ceremony and no safety',
  repository_missing:
    'the work changes a repository but names none — there is nothing to authorize',
  repository_outside_authorized_scope:
    'the named repository is outside the paths this deployment may act on',
  mutation_scope_missing:
    'the work changes a repository but declares no allowed paths — an unscoped change cannot be authorized',
  acceptance_criteria_missing:
    'the work changes a repository but declares no deterministic check — completion could not be verified, only asserted',
  governed_implementation:
    'repository mutation with a declared scope and deterministic acceptance: this is governed build work',
  governed_implementation_with_local_analysis:
    'governed build work where bounded local analysis is plausibly useful; the specialist advises and decides nothing',
});

const decide = (route: Route, reason: RouteReason): RouteDecision =>
  ({ route, reason, explanation: EXPLANATION[reason] });

/** Is `repo` inside one of the authorized roots? Compared on path segments, never by prefix. */
export function withinAuthorizedScope(repo: string, roots: readonly string[]): boolean {
  const norm = (p: string): string[] => p.split('/').filter((s) => s.length > 0);
  const target = norm(repo);
  if (repo.includes('\0') || target.includes('..')) return false;
  return roots.some((root) => {
    const r = norm(root);
    return r.length > 0 && r.length <= target.length && r.every((seg, i) => seg === target[i]);
  });
}

/**
 * Choose the route. Pure: same request, same decision, no clock, no filesystem, no model.
 *
 * The order matters and is the point. Authority is checked BEFORE capability: a request that
 * cannot be authorized is refused whether or not a specialist could have helped with it.
 */
export function selectRoute(request: WorkRequest, authorizedRoots: readonly string[]): RouteDecision {
  if (!request.mutates) return decide('DIRECT', 'no_mutation_required');

  const repo = request.repository?.trim() ?? '';
  if (repo.length === 0) return decide('REFUSE_OR_CLARIFY', 'repository_missing');
  if (!withinAuthorizedScope(repo, authorizedRoots)) {
    return decide('REFUSE_OR_CLARIFY', 'repository_outside_authorized_scope');
  }
  const paths = (request.allowedPaths ?? []).filter((p) => p.trim().length > 0);
  if (paths.length === 0) return decide('REFUSE_OR_CLARIFY', 'mutation_scope_missing');
  const checks = request.checks ?? [];
  if (checks.length === 0) return decide('REFUSE_OR_CLARIFY', 'acceptance_criteria_missing');

  return request.localAnalysisUseful === true
    ? decide('IKBI_WITH_LOCAL_ASSIST', 'governed_implementation_with_local_analysis')
    : decide('IKBI', 'governed_implementation');
}
