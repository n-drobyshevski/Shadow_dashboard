#!/usr/bin/env bash
# Local run of the CI security scans (.github/workflows/security.yml). Each tool must be on PATH:
# semgrep, gitleaks, osv-scanner. A missing tool is reported and skipped.
# This script uses whatever semgrep is first on PATH, at whatever version: it does not install it.
# For the version CI pins, install it in a venv:
#   python3.12 -m venv ~/.venv-semgrep
#   ~/.venv-semgrep/bin/pip install --require-hashes --no-deps --only-binary :all: -r security/requirements-semgrep.txt
#   PATH="$HOME/.venv-semgrep/bin:$PATH" npm run security
set -u
cd "$(dirname "$0")/.."
status=0
have() { command -v "$1" >/dev/null 2>&1 || { echo "-- $1: not installed, skipped"; return 1; }; }

if have semgrep; then
  dir=$(mktemp -d)
  node security/extract-client-js.js "$dir/src" && cp src/*.js "$dir/src/"
  echo "== Semgrep $(semgrep --version 2>/dev/null) ($(command -v semgrep); CI pins $(sed -n 's/^semgrep==//p' security/requirements-semgrep.in))"
  (cd "$dir" && semgrep scan --metrics=off --error --quiet \
    --config p/javascript --config p/security-audit --config p/secrets --config p/xss --config p/nodejsscan \
    --config "$OLDPWD/security/semgrep.yml" \
    --exclude-rule ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack \
    --exclude-rule ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure \
    --exclude-rule ajinabraham.njsscan.dos.regex_dos.regex_dos \
    src) || status=1
  rm -rf "$dir"
fi
if have gitleaks; then
  echo "== gitleaks"
  gitleaks git --no-banner --redact . || status=1
fi
if have osv-scanner; then
  echo "== osv-scanner"
  osv-scanner scan source --config osv-scanner.toml -L package-lock.json || status=1
fi
exit $status
