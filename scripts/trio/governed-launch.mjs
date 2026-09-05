#!/usr/bin/env node
/**
 * GOVERNED LAUNCH — argument parser, entry-contract guard, and caller for governed-run.mjs.
 *
 * Usage:
 *   node scripts/trio/governed-launch.mjs <component> -- <command> [args...]
 *   node scripts/trio/governed-launch.mjs --entry=service  <component> -- <command> [args...]
 *   node scripts/trio/governed-launch.mjs --entry=operator <component> -- <command> [args...]
 *
 * Components: trio-agent, trio-test
 *
 * THE ENTRY CONTRACT
 *
 * This wrapper refuses to run unless it can establish, positively, which governed entry class
 * it belongs to. There are exactly two, and neither is inferred:
 *
 *   --entry=service | --entry=operator   The caller DECLARES that this process is the top of a
 *       governed chain — a systemd unit, or a human/CI at a terminal. The declaration is
 *       explicit and visible in `systemctl show -p ExecStart` or in the shell history. Nothing
 *       about a service is deduced from a missing package-manager variable.
 *
 *   (no flag)   The process must PROVE it is a governed child: a complete, canonically
 *       consistent governed environment whose ownership record exists beneath the validated
 *       root and is bound to this boot. This is how the package.json scripts reach the wrapper —
 *       through `governed-npm.mjs` / `governed-pnpm.mjs`, which establish that environment
 *       before the package manager starts.
 *
 * Everything else is refused, including `pnpm exec node scripts/trio/governed-launch.mjs …`,
 * which publishes no lifecycle variables and therefore used to slip past the old guard entirely.
 *
 * WHAT THIS BOUNDARY DOES AND DOES NOT DO. A child cannot retroactively prevent the parent that
 * launched it: if somebody runs /usr/bin/pnpm by hand, pnpm has already allocated its cache in
 * os.tmpdir() before this file exists as a process. What the contract does guarantee is that no
 * project-owned call path can do that — every committed script, test, service definition and
 * deployment file is mechanically scanned for a raw package-manager invocation — and that when
 * it happens anyway, this wrapper detects it and fails closed instead of proceeding quietly.
 *
 * Part of the byte-identical Trio shared core.
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_COMPONENTS,
  ENTRY_CLASSES,
  assertCanonicalEntryEnvironment,
  assertGovernedChildEnvironment,
} from './governed-temp-authority.mjs';
import { runGoverned } from './governed-run.mjs';
import { assertExternalBinding } from './external-identity.mjs';

const ENTRY_PREFIX = '--entry=';

const argv = process.argv.slice(2);
let declaredEntry;
if (argv[0] !== undefined && argv[0].startsWith(ENTRY_PREFIX)) {
  declaredEntry = argv[0].slice(ENTRY_PREFIX.length);
  if (!ENTRY_CLASSES.includes(declaredEntry)) {
    process.stderr.write(`Entry class ${JSON.stringify(declaredEntry)} is not allowed. Must be one of: ${ENTRY_CLASSES.join(', ')}\n`);
    process.exit(1);
  }
  argv.shift();
}

const separatorIndex = argv.indexOf('--');
if (separatorIndex < 1 || separatorIndex >= argv.length - 1) {
  process.stderr.write('Usage: node governed-launch.mjs [--entry=service|--entry=operator] <component> -- <command> [args...]\n');
  process.exit(1);
}

const component = argv[0];
if (!ALLOWED_COMPONENTS.includes(component)) {
  process.stderr.write(`Component ${JSON.stringify(component)} is not allowed. Must be one of: ${ALLOWED_COMPONENTS.join(', ')}\n`);
  process.exit(1);
}

const command = argv[separatorIndex + 1];
const commandArgs = argv.slice(separatorIndex + 2);

// The guard. Independently canonicalizing, never marker-driven, fail-closed by default.
if (declaredEntry === undefined) {
  assertGovernedChildEnvironment(process.env);
} else {
  assertCanonicalEntryEnvironment(process.env);
}

/*
  THE EXTERNAL IDENTITY GATE, before anything is launched.

  A service declares itself the top of a governed run, so it is the point where "which deployment is
  this?" has to be answered by something outside the deployment. The record comes from systemd's
  credential channel, sourced from a root-owned file no repository can edit, and it names the exact
  digests this tree must have.

  Only the service entry is gated. An operator entry is a human running a test in a checkout they
  are already standing in; requiring a root-provisioned credential there would not add a trust root,
  it would only stop the suites from running.
*/
if (declaredEntry === 'service') {
  const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  try {
    const bound = assertExternalBinding(repositoryRoot, process.env);
    process.stderr.write(`governed-launch: external identity ${bound.agent} (schema ${bound.schemaVersion}) bound, digests matched\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

await runGoverned({ component, command, args: commandArgs });
