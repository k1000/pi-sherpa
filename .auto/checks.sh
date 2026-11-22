#!/usr/bin/env bash
# Autoresearch validation gate for pi-sherpa.
# Correctness must hold: extension checks + the full unit/integration suite.
set -euo pipefail
cd "$(dirname "$0")/.."

bun scripts/check-extension.ts >/dev/null

fail=0
for f in tests/*.test.ts; do
  if ! bunx tsx "$f" >/dev/null 2>&1; then
    echo "FAILED: $f"
    bunx tsx "$f" 2>&1 | tail -20
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "checks: FAILED"
  exit 1
fi
echo "checks: all test files + extension checks passed"
