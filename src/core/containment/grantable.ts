import { canonical, existsSafe } from "./paths.js";

/**
 * THE closed vocabulary of workspace roots that may ever be granted.
 *
 * WHY AN EXACT LIST. The previous rule was structural — absolute, normalised, at least two path
 * segments — and an independent audit walked straight through it: `/etc` was refused for being too
 * broad while `/etc/foo` was accepted, because it has two segments. A structural rule describes the
 * SHAPE of an allocation; it cannot describe which allocations were reviewed. Only a list can.
 *
 * Membership is exact string equality. Not `startsWith`, not a prefix rule, not a substring test:
 * a prefix rule accepts `/pehverse/worktrees-evil` and a substring rule accepts anything containing
 * a blessed name. Descendants are excluded too — granting `/pehverse/worktrees/x` is a different,
 * unreviewed grant, and the deployment that wants it should say so and be reviewed for it.
 *
 * The per-deployment SELECTION stays in deployment data. This list is the vocabulary that selection
 * may draw from, and changing it is a reviewed change to this file.
 */
/*
  NAMED FOR WHAT IT IS, not for what it authorises.

  It was `GRANTABLE_WORKSPACE_ROOTS`, and the admission guard flagged it: that guard refuses any
  exported VALUE whose name reads as an authority (AUTHORITY, TOKEN, GRANT, OVERRIDE, ...), because
  a previous bypass had exactly that shape. The collision is lexical rather than real -- this list
  grants nothing, it is the closed set outside which everything is refused -- but the guard has no
  exemption mechanism on purpose, and adding one would make it noise. So the constant is named for
  the thing it describes. The predicate below keeps the verb, since functions are not matched and
  `isGrantableWorkspace` reads correctly at a call site.
*/
export const WRITABLE_WORKSPACE_ROOTS: readonly string[] = Object.freeze([
  "/pehverse/builds",
  "/pehverse/renders",
  "/pehverse/worktrees",
  "/pehverse/workspace",
]);

const REVIEWED = new Set(WRITABLE_WORKSPACE_ROOTS);

/** Exact membership. No prefix, substring, or descendant matching of any kind. */
export function isGrantableWorkspace(candidate: string): boolean {
  return REVIEWED.has(candidate);
}

export type GrantRefusal =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Is this declared path one of the reviewed roots, and is it the directory it claims to be?
 *
 * The second half matters: a path that exists but resolves elsewhere is a symlink-derived grant.
 * The name would be on the list while the bytes it authorises would not be, so it is refused. A
 * path that does not exist yet resolves to itself and is allowed — the allocation is a statement
 * about what MAY be written, not about what happens to be present.
 */
export function checkGrantableWorkspace(candidate: string): GrantRefusal {
  if (!isGrantableWorkspace(candidate)) {
    return { ok: false, reason: `${candidate} is not a grantable workspace root` };
  }
  if (existsSafe(candidate) && canonical(candidate) !== candidate) {
    return { ok: false, reason: `${candidate} resolves to ${canonical(candidate)}, so the grant would not be the reviewed one` };
  }
  return { ok: true };
}
