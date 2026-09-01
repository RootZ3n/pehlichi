#!/usr/bin/env node
/**
 * GOVERNED NPM — pre-package-manager entry point.
 *
 * npm's lib/cli.js calls module.enableCompileCache() which defaults to
 * os.tmpdir()/node-compile-cache. This wrapper validates PEHVERSE_TEMP_ROOT
 * and exports TMPDIR/TMP/TEMP/NODE_COMPILE_CACHE BEFORE npm starts, so the
 * cache lands under governed storage.
 *
 * Usage: node scripts/trio/governed-npm.mjs <npm-command> [args...]
 *        node scripts/trio/governed-npm.mjs test
 *        node scripts/trio/governed-npm.mjs run test:runtime
 *
 * Part of the byte-identical Trio shared core.
 */
import { runGoverned } from './governed-run.mjs';

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('Usage: node governed-npm.mjs <npm-command> [args...]\n');
  process.exit(1);
}

await runGoverned({
  component: 'trio-agent',
  command: 'npm',
  args
});
