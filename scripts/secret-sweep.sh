#!/usr/bin/env bash
# Secret sweep over the FULL git history — the pre-flip audit from
# plan/launch-v1.md. Report only: this never rewrites history. If it finds
# anything real, decide scrub vs fresh-history before flipping the repo public.
#
# Usage: scripts/secret-sweep.sh [report-path]
# Needs gitleaks (https://github.com/gitleaks/gitleaks): brew install gitleaks
set -uo pipefail
cd "$(dirname "$0")/.."

REPORT="${1:-gitleaks-report.json}"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed — brew install gitleaks (or see github.com/gitleaks/gitleaks)" >&2
  exit 2
fi

# --redact keeps most of each matched secret out of the report file itself.
gitleaks git . \
  --config .gitleaks.toml \
  --report-format json \
  --report-path "$REPORT" \
  --redact=75
code=$?

case $code in
  0) echo "✓ No secrets found in the git history." ;;
  1) echo "✗ Findings written to $REPORT — review before the repo goes public." ;;
  *) echo "gitleaks failed (exit $code)" >&2 ;;
esac
exit $code
