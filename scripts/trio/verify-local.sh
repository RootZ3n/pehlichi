#!/bin/sh
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || { echo 'TRIO_WRAPPER_ERROR class=WORKDIR_RESOLUTION'; exit 2; }
self_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P) || { echo 'TRIO_WRAPPER_ERROR class=WORKDIR_RESOLUTION'; exit 2; }
ecosystem_root=$(dirname -- "$self_root")
pehlichi_root=${1:-$self_root}
luna_root=${2:-$ecosystem_root/loony-luna}
ptah_root=${3:-$ecosystem_root/mad-ptah}
manifest=$self_root/trio/boundary-manifest.json
overall=0
parity_json=

cleanup() { if [ -n "$parity_json" ] && [ -f "$parity_json" ]; then rm -f -- "$parity_json"; fi; }
interrupted() { signal=$1; cleanup; echo "TRIO_WRAPPER_INTERRUPTED signal=$signal"; exit 130; }
trap cleanup EXIT
trap 'interrupted HUP' HUP
trap 'interrupted INT' INT
trap 'interrupted TERM' TERM

run_check() {
  label=$1
  shift
  echo "TRIO_CHECK_START $label"
  "$@"
  status=$?
  echo "TRIO_CHECK_END $label status=$status"
  if [ "$status" -ne 0 ]; then overall=1; fi
}

if ! command -v node >/dev/null 2>&1; then
  for label in strict-json schema hostile vulnerable-fixture historical-limit scaffolding characterization parity; do echo "TRIO_CHECK_END $label status=127 class=DEPENDENCY_MISSING dependency=node"; done
  exit 2
fi
if [ ! -d "$script_dir/node_modules/ajv" ]; then echo 'TRIO_DEPENDENCY_ERROR class=DEPENDENCY_MISSING dependency=ajv'; overall=1; fi

run_check strict-json node "$script_dir/strict-json-differential.test.mjs"
run_check schema node "$script_dir/schema-validation.test.mjs"
run_check hostile node "$script_dir/verify-runtime-parity.test.mjs"
run_check vulnerable-fixture node "$script_dir/vulnerable-six-reproduction.test.mjs"
run_check historical-limit node "$script_dir/preflight-hostile-audit.test.mjs"
run_check scaffolding node "$script_dir/scaffolding.test.mjs"
if node --import tsx -e '' >/dev/null 2>&1; then
  run_check characterization node --import tsx "$script_dir/current-behavior.characterization.test.mjs"
else
  echo 'TRIO_CHECK_END characterization status=127 class=DEPENDENCY_MISSING dependency=tsx'
  overall=1
fi

parity_json=$(mktemp "${TMPDIR:-/tmp}/trio-parity.XXXXXX.json")
mktemp_status=$?
if [ "$mktemp_status" -ne 0 ] || [ -z "$parity_json" ]; then
  echo "TRIO_PARITY_RESULT verifier-error class=TEMPORARY_FILE_FAILURE status=$mktemp_status"
  overall=1
else
  node "$script_dir/verify-runtime-parity.mjs" --json --manifest "$manifest" --pehlichi "$pehlichi_root" --loony-luna "$luna_root" --mad-ptah "$ptah_root" >"$parity_json"
  parity_status=$?
  cat "$parity_json"
  verifier_status=$(node -e 'const fs=require("fs");try{const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(x.status||"MISSING_STATUS"));}catch{process.stdout.write("MALFORMED_OUTPUT");}' "$parity_json")
  case "$verifier_status" in
    VERIFIER_OK_DIVERGENCE)
      echo "TRIO_PARITY_RESULT operated-correctly-known-divergence status=$parity_status"
      overall=1
      ;;
    VERIFIER_OK_PARITY)
      if [ "$parity_status" -eq 0 ]; then echo 'TRIO_PARITY_RESULT parity status=0'; else echo "TRIO_PARITY_RESULT verifier-error verifier_status=$verifier_status status=$parity_status"; overall=1; fi
      ;;
    *)
      echo "TRIO_PARITY_RESULT verifier-error verifier_status=$verifier_status status=$parity_status"
      overall=1
      ;;
  esac
fi

exit "$overall"
