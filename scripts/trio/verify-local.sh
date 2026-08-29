#!/bin/sh
# Convenience launcher only. This script has no authority: it performs exactly one exec of
# the authoritative Node entry point and contains no parsing, testing, credential logic,
# status transformation, or publication logic. A gate implemented in shell can be satisfied
# by a comment, which is why the decision does not live here.
set -u
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 2
exec node "$script_dir/verify-authoritative.mjs" "$@"
