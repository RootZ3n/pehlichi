#!/usr/bin/env node
/**
 * GOVERNED PNPM — THE canonical pnpm entry.
 *
 * pnpm is the Trio's package manager: the repositories ship pnpm-lock.yaml, and the Truth
 * Firewall runs the repository's policy scripts as `pnpm <script>`. pnpm allocates a compile
 * cache in os.tmpdir() before it runs anything, and `pnpm exec` publishes NO lifecycle
 * variables at all — which is why the supported pnpm interface has to be an entry point ahead
 * of pnpm rather than a guard behind it.
 *
 * Usage: node scripts/trio/governed-pnpm.mjs <pnpm-command> [args...]
 *        node scripts/trio/governed-pnpm.mjs run test
 *
 * Part of the byte-identical Trio shared core.
 */
import { runPackageManager } from './governed-run.mjs';

await runPackageManager('pnpm', process.argv.slice(2));
