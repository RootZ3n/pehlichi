#!/usr/bin/env bash
# GOVERNED NPM WRAPPER — establishes governed temporary storage BEFORE npm/Node starts.
#
# npm's lib/cli.js calls module.enableCompileCache() which defaults to
# os.tmpdir()/node-compile-cache. This wrapper exports TMPDIR/TMP/TEMP and
# NODE_COMPILE_CACHE before npm starts, so the cache lands under governed storage.
#
# Usage: scripts/trio/governed-npm.sh <npm-command> [args...]
#        scripts/trio/governed-npm.sh test
#        scripts/trio/governed-npm.sh run test:runtime
#
# Part of the byte-identical Trio shared core.
set -euo pipefail

# Validate PEHVERSE_TEMP_ROOT
root="${PEHVERSE_TEMP_ROOT:-}"
if [ -z "$root" ]; then
  echo "governed-npm.sh: PEHVERSE_TEMP_ROOT is not set. The lab never falls back to /tmp." >&2
  exit 1
fi
if [[ "$root" != /* ]]; then
  echo "governed-npm.sh: PEHVERSE_TEMP_ROOT is not absolute: $root" >&2
  exit 1
fi
if [[ "$root" == "/tmp" || "$root" == /tmp/* ]]; then
  echo "governed-npm.sh: PEHVERSE_TEMP_ROOT must not be /tmp: $root" >&2
  exit 1
fi
if [ ! -d "$root" ]; then
  echo "governed-npm.sh: PEHVERSE_TEMP_ROOT does not exist: $root" >&2
  exit 1
fi

# Create a unique run directory for this npm invocation
run_id="npm-$$-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
run_dir="$root/trio-agent/$run_id"
mkdir -p "$root/trio-agent"
mkdir -p "$run_dir"

# Export governed variables — npm and every child process sees them
export TMPDIR="$run_dir"
export TMP="$run_dir"
export TEMP="$run_dir"
export NODE_COMPILE_CACHE="$run_dir/node-compile-cache"

# Cleanup on exit
cleanup() {
  rm -rf "$run_dir" 2>/dev/null || true
  rm -rf "$root/trio-agent/.runs/$run_id.json" 2>/dev/null || true
}
trap cleanup EXIT

# Run the npm command
exec npm "$@"
