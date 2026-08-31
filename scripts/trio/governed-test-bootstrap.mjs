/**
 * GOVERNED TEST BOOTSTRAP — loaded before any test file runs, in the runner process and in
 * every per-file test child (node:test propagates execArgv):
 *
 *     node --import tsx --import ./scripts/trio/governed-test-bootstrap.mjs --test …
 *
 * It binds this process to governed temporary storage (PEHVERSE_TEMP_ROOT) under the
 * `trio-test` component and exports TMPDIR/TMP/TEMP into the governed run directory, so even
 * a subprocess that inherits the environment can never land scratch in /tmp. Fail-closed: a
 * test process with no governed root refuses to run rather than falling back to /tmp.
 *
 * Part of the byte-identical Trio shared core.
 */
if (process.env.PEHVERSE_TEMP_COMPONENT === undefined || process.env.PEHVERSE_TEMP_COMPONENT === '') {
  process.env.PEHVERSE_TEMP_COMPONENT = 'trio-test';
}
const { processScratchDir } = await import('../../src/core/temp-authority.ts');
processScratchDir();
