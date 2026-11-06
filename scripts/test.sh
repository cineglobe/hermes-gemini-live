#!/usr/bin/env bash
# Run the plugin's tests with the SAME interpreter and import path Hermes itself uses, so the real
# agent.secret_scope / hermes_cli.config / tools.registry are exercised (no mocks of Hermes).
#
#   scripts/test.sh                       # Python tests + generated-bundle freshness + JS engine tests
#   PYTEST_EXTRA_PATH=/dir scripts/test.sh  # dir containing pytest if the Hermes env lacks it
#
# It never starts a Hermes server, so it is safe on a machine that runs one.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cmd_json="$(hermes --print-runtime-command)"
python="$(printf '%s' "$cmd_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')"
agent_root="$(printf '%s' "$cmd_json" | python3 -c 'import json,re,sys; print(re.search(r"sys.path.insert\(0, .([^\x27]+)", json.load(sys.stdin)[-1]).group(1))')"

python3 "$here/scripts/build.py" --check

env -u GEMINI_LIVE_API_KEY -u GEMINI_API_KEY -u GOOGLE_API_KEY \
  "$python" -I -c "
import os, sys
sys.path.insert(0, '$agent_root')
import hermes_bootstrap  # noqa: F401  — the PM environment Hermes runs in
extra = os.environ.get('PYTEST_EXTRA_PATH')
if extra:
    sys.path.append(extra)
import pytest
os.chdir('$here')
sys.exit(pytest.main(['-q', *sys.argv[1:]]))
" "$@"

node "$here/tests/engine.test.mjs"
