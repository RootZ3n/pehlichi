#!/usr/bin/env node
/**
 * GOVERNED NPM — THE canonical npm entry.
 *
 * npm's lib/cli.js calls module.enableCompileCache() against os.tmpdir() before it reads any
 * manifest, so npm can never be governed from inside package.json. This wrapper is a plain,
 * builtin-only node process that runs FIRST: it validates PEHVERSE_TEMP_ROOT through the single
 * canonical authority, creates a private run directory, and exports TMPDIR, TMP, TEMP,
 * PEHVERSE_TEMP_ROOT and NODE_COMPILE_CACHE before npm starts.
 *
 * Usage: node scripts/trio/governed-npm.mjs <npm-command> [args...]
 *        node scripts/trio/governed-npm.mjs run test
 *
 * Part of the byte-identical Trio shared core.
 */
import { runPackageManager } from './governed-run.mjs';

await runPackageManager('npm', process.argv.slice(2));
