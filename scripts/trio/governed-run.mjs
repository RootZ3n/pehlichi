/**
 * GOVERNED RUN — the single lifecycle implementation.
 *
 * Creates a governed run directory, spawns the child process with proper signal
 * forwarding, and ensures cleanup on exit, failure, and signals. Exit status
 * and signals propagate faithfully (128+N for signals, not collapsed to 1).
 *
 * Part of the byte-identical Trio shared core.
 */
import { spawn } from 'node:child_process';
import { resolveGovernedTempRoot, createRunDirectory, cleanupRun, buildChildEnv } from './governed-temp-authority.mjs';

/**
 * Run a command under governed temporary storage. Never returns — terminates this
 * process with the child's exit status or signal.
 *
 * @param {object} opts
 * @param {string} opts.component - 'trio-agent' or 'trio-test'
 * @param {string} opts.command - the command to spawn
 * @param {string[]} opts.args - arguments to the command
 * @param {Record<string,string>} [opts.extraEnv] - additional environment variables
 * @param {NodeJS.ProcessEnv} [opts.env] - base environment (default: process.env)
 */
export async function runGoverned({ component, command, args, extraEnv = {}, env = process.env }) {
  // 1. Validate root
  const root = resolveGovernedTempRoot(env);

  // 2-4. Create run directory with sidecar
  const run = createRunDirectory(component, env);

  // 5. Build child environment
  const childEnv = buildChildEnv(run, component, env);
  for (const [k, v] of Object.entries(extraEnv)) {
    if (typeof v === 'string') childEnv[k] = v;
  }

  // Register cleanup as last-resort on process exit
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanupRun(run);
  };
  process.on('exit', cleanup);

  // Also handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    cleanup();
    throw err; // re-throw after cleanup
  });

  // 6. Spawn the child (async, never exec, never spawnSync)
  let child;
  try {
    child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      env: childEnv
    });
  } catch (err) {
    // 10. Spawn error (ENOENT etc.)
    process.stderr.write(`governed-run: failed to spawn ${command}: ${err.message}\n`);
    cleanup();
    process.exit(127);
  }

  // 7. Forward signals to the child
  const forwardSignal = (sig) => {
    try { child.kill(sig); } catch {}
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGHUP', () => forwardSignal('SIGHUP'));
  process.on('SIGQUIT', () => forwardSignal('SIGQUIT'));

  // 8. On child exit: cleanup, then propagate status/signal
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) {
      // Re-kill self with the same signal for proper 128+N exit
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });

  // Handle child error events
  child.on('error', (err) => {
    process.stderr.write(`governed-run: child error: ${err.message}\n`);
    cleanup();
    process.exit(127);
  });
}
