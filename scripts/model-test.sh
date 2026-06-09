#!/usr/bin/env bash
# MODEL TESTING HARNESS
# Sends the same task to all three trio agents and compares results.
#
# Usage:
#   ./model-test.sh "fix the greeting export in src/greeting.ts"
#   ./model-test.sh --model-luna llamacpp --model-ptah mimo-v2.5 "implement add function"
#
# Environment variables (can also be set per-agent in .env files):
#   AGENT_MODEL      — default model for all agents
#   AGENT_BASE_URL   — default base URL for all agents
#   LUNA_MODEL       — override model for Luna only
#   PTAH_MODEL       — override model for Ptah only
#   PEHLICHI_MODEL   — override model for Pehlichi only

set -euo pipefail

TASK="${1:?Usage: model-test.sh \"<task description>\"}"
RESULTS_DIR="/tmp/model-test-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RESULTS_DIR"

PEHLICHI_URL="http://127.0.0.1:18830"
PTAH_URL="http://127.0.0.1:18810"
LUNA_URL="http://127.0.0.1:18792"

echo "═══════════════════════════════════════════════════════"
echo "  MODEL TESTING HARNESS"
echo "  Task: $TASK"
echo "  Results: $RESULTS_DIR"
echo "═══════════════════════════════════════════════════════"
echo ""

# Send task to an agent and capture response
send_task() {
  local name="$1"
  local url="$2"
  local outfile="$3"
  
  echo "  Sending to $name..."
  local start_time=$(date +%s%N)
  
  curl -s -X POST "$url/chat" \
    -H "Content-Type: application/json" \
    -d "{\"message\": \"$TASK\"}" \
    --max-time 300 \
    > "$outfile" 2>/dev/null || echo '{"error": "timeout or connection failed"}' > "$outfile"
  
  local end_time=$(date +%s%N)
  local duration_ms=$(( (end_time - start_time) / 1000000 ))
  echo "$duration_ms" > "${outfile}.time"
  
  echo "  $name done in ${duration_ms}ms"
}

# Send to all three in parallel
echo "Sending task to all three agents..."
send_task "Pehlichi" "$PEHLICHI_URL" "$RESULTS_DIR/pehlichi.json" &
send_task "Ptah" "$PTAH_URL" "$RESULTS_DIR/ptah.json" &
send_task "Luna" "$LUNA_URL" "$RESULTS_DIR/luna.json" &
wait
echo ""

# Display results
echo "═══════════════════════════════════════════════════════"
echo "  RESULTS"
echo "═══════════════════════════════════════════════════════"

for agent in pehlichi ptah luna; do
  echo ""
  echo "--- ${agent^^} ---"
  echo "  Time: $(cat "$RESULTS_DIR/${agent}.json.time" 2>/dev/null || echo '?')ms"
  echo "  Model: $(cat "$RESULTS_DIR/${agent}.json" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('model','?'))" 2>/dev/null || echo '?')"
  echo "  Tool calls: $(cat "$RESULTS_DIR/${agent}.json" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('toolCalls',[])))" 2>/dev/null || echo '?')"
  echo "  Response:"
  cat "$RESULTS_DIR/${agent}.json" 2>/dev/null | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  content = d.get('content','')
  if len(content) > 500:
    print('    ' + content[:500] + '...')
  else:
    print('    ' + content)
except:
  print('    (failed to parse response)')
" 2>/dev/null
done

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Full results saved to: $RESULTS_DIR"
echo "═══════════════════════════════════════════════════════"
