#!/usr/bin/env node
/**
 * GOVERNED LAUNCH — argument parser and caller for governed-run.mjs.
 *
 * Validates the component name, parses the -- separator, and delegates to
 * runGoverned() for all lifecycle management.
 *
 * Usage: node scripts/trio/governed-launch.mjs <component> -- <command> [args...]
 *
 * Components: trio-agent, trio-test
 *
 * Part of the byte-identical Trio shared core.
 */
import { ALLOWED_COMPONENTS, GovernedTempError, isUnder, resolveGovernedTempRoot } from './governed-temp-authority.mjs';
import { runGoverned } from './governed-run.mjs';

/**
 * Refuse a process reached through an UNGOVERNED package manager.
 *
 * `npm run` cannot be governed from inside package.json: npm has already initialised — and
 * already called module.enableCompileCache() against os.tmpdir() — before it reads the
 * manifest. The only cure is a wrapper outside npm, so raw `npm test` must fail closed
 * rather than silently succeed after npm has written to /tmp.
 *
 * The signal is a package-manager lifecycle (`npm_lifecycle_event` / `npm_execpath`, set by
 * npm and pnpm alike) WITHOUT a governed NODE_COMPILE_CACHE. A direct invocation — the
 * service unit, or a developer running this wrapper straight — has no lifecycle marker and
 * is left alone, because no package manager ran ahead of it to cache anything.
 */
function refuseUngovernedPackageManager(env) {
  const viaPackageManager =
    (env.npm_lifecycle_event ?? '').length > 0 || (env.npm_execpath ?? '').length > 0;
  if (!viaPackageManager) return;
  const cache = (env.NODE_COMPILE_CACHE ?? '').trim();
  const root = resolveGovernedTempRoot(env);
  if (cache.length === 0 || !isUnder(cache, root)) {
    throw new GovernedTempError(
      'ungoverned_package_manager',
      'this process was reached through an ungoverned package manager, which has already ' +
      'cached to unmanaged storage. Use `node scripts/trio/governed-npm.mjs <args>` ' +
      '(operator and test entry) or set the governed environment in the service unit'
    );
  }
}

const args = process.argv.slice(2);
const separatorIndex = args.indexOf('--');
if (separatorIndex < 1 || separatorIndex >= args.length - 1) {
  process.stderr.write('Usage: node governed-launch.mjs <component> -- <command> [args...]\n');
  process.exit(1);
}

const component = args[0];
if (!ALLOWED_COMPONENTS.includes(component)) {
  process.stderr.write(`Component ${JSON.stringify(component)} is not allowed. Must be one of: ${ALLOWED_COMPONENTS.join(', ')}\n`);
  process.exit(1);
}

const command = args[separatorIndex + 1];
const commandArgs = args.slice(separatorIndex + 2);

refuseUngovernedPackageManager(process.env);

await runGoverned({ component, command, args: commandArgs });
