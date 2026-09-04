import { spawnSync } from "node:child_process";

/**
 * Whether a working containment backend exists ON THIS HOST.
 *
 * `reason` is present exactly when `available` is false, and it is the text an operator sees in a
 * denial, so it has to say what to fix.
 */
export interface ContainmentAvailability {
  readonly available: boolean;
  readonly tool?: "bwrap";
  readonly version?: string;
  readonly reason?: string;
}

/**
 * The probe policy shape. Deliberately the same skeleton the real argv builder uses, because a
 * probe that tests something easier than the real thing reports availability that does not exist.
 */
const PROBE_ARGS = [
  "--ro-bind", "/", "/",
  "--dev", "/dev",
  "--proc", "/proc",
  "--tmpfs", "/tmp",
  "--unshare-all",
  "--die-with-parent",
  "--", "true",
];

let cached: ContainmentAvailability | undefined;

/** A probe function, injectable so conformance and tests can drive both branches. */
export type AvailabilityProbe = () => ContainmentAvailability;

/**
 * Probe for bubblewrap and actually RUN a no-op under the real policy shape.
 *
 * A version string is not evidence. `bwrap` is routinely installed on hosts where unprivileged user
 * namespaces are disabled, and there it reports a version and then fails every real invocation.
 * Running the policy is the only answer that means "works here".
 */
export function bwrapProbe(): ContainmentAvailability {
  try {
    const ver = spawnSync("bwrap", ["--version"], { encoding: "utf8", timeout: 5_000 });
    if (ver.status !== 0 || ver.error) {
      return { available: false, reason: "bwrap is not installed or not executable" };
    }
    const version = (ver.stdout ?? "").trim();

    const run = spawnSync("bwrap", PROBE_ARGS, { encoding: "utf8", timeout: 8_000 });
    if (run.status !== 0 || run.error) {
      const detail = (run.stderr ?? run.error?.message ?? "").toString().trim().slice(0, 160);
      return {
        available: false,
        reason: `bwrap ${version} is present but a policy probe failed (unprivileged user namespaces disabled?): ${detail}`,
      };
    }
    return { available: true, tool: "bwrap", version };
  } catch (error) {
    return { available: false, reason: `containment probe error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Probe once and cache. The answer cannot change without the host changing under us. */
export function detectContainment(probe: AvailabilityProbe = bwrapProbe): ContainmentAvailability {
  if (cached === undefined) cached = probe();
  return cached;
}

/** Drop the cached probe result. For tests and for a deliberate re-probe after host repair. */
export function resetContainmentAvailability(): void {
  cached = undefined;
}
