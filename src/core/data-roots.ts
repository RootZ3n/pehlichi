/**
 * PERSISTENT DATA ROOTS — named by the environment, or refused.
 *
 * WHY THERE IS NO DEFAULT. Every resolver in this tree used to end in a fallback: a hardcoded
 * `/pehverse/repos/lab-utilities/...`, a workspace-relative `join(workspaceRoot, '..', 'lab-store')`,
 * or the package's own directory. All three are wrong in the same way once the agent runs from an
 * immutable, root-owned release:
 *
 *   - a repository path is writable by the account the agent runs as, so "persistent state" lives
 *     somewhere the agent could rewrite wholesale;
 *   - a package-relative path lands INSIDE the release, where the write either fails against a
 *     root-owned tree or succeeds and silently invalidates the closure the release is verified
 *     against.
 *
 * A default that is wrong in deployment is worse than no default, because it starts. So this throws.
 * The variable names are the ones the code actually reads -- verified against the resolvers in
 * lab-store and lab-memory, not assumed from a deployment plan.
 */

/** The variables that name persistent state. `LAB_MEMORY_ROOT` outranks `MEMORY_STORE_ROOT`. */
export const DATA_ROOT_VARIABLES = Object.freeze({
  store: Object.freeze(['LAB_STORE_ROOT'] as const),
  memory: Object.freeze(['LAB_MEMORY_ROOT', 'MEMORY_STORE_ROOT'] as const),
  vault: Object.freeze(['LABMEM_ROOT'] as const),
});

/**
 * The first of `names` that is set to a non-empty value, or a thrown error naming all of them.
 *
 * Empty and unset are the same defect and are reported the same way: the two resolvers downstream
 * disagree about which is which (`??` treats `''` as set, `||` does not), and a caller should not
 * have to know which one it is about to hit.
 */
export function requiredDataRoot(...names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim().length > 0) return value;
  }
  throw new Error(
    `${names.join(' or ')} must be set: this deployment has no default persistent data root, `
    + 'because every available default would point at a repository or inside the release.',
  );
}
