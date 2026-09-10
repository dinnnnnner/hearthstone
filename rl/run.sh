#!/usr/bin/env bash
set -euo pipefail
rl_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rl_python="${TAVERN_RL_PYTHON:-$rl_root/.venv/bin/python}"
if [[ ! -x "$rl_python" ]]; then
  echo "Python environment missing. Follow rl/README.md or set TAVERN_RL_PYTHON." >&2
  exit 1
fi
export PYTHONPATH="$rl_root/rl/python${PYTHONPATH:+:$PYTHONPATH}"
cd "$rl_root"
rl_command="${1:-train}"
if [[ $# -gt 0 ]]; then shift; fi
case "$rl_command" in
  train|evaluate|replay|benchmark) exec "$rl_python" -m "tavern_rl.$rl_command" "$@" ;;
  test) exec "$rl_python" -m unittest discover -s rl/tests -v "$@" ;;
  *) echo "Usage: bash rl/run.sh {train|evaluate|replay|benchmark|test} [arguments]" >&2; exit 2 ;;
esac
