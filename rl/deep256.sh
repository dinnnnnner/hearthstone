#!/usr/bin/env bash
set -euo pipefail
rl_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# New experiment: never resume a 64-layer checkpoint as a 256-layer model.
# Override defaults by appending train arguments, e.g. --iterations 1 --workers 2.
exec bash "$rl_root/rl/run.sh" train \
  --architecture entity-gru-resnet --policy-depth 256 --value-depth 256 \
  --hidden 128 --heads 4 --layers 2 \
  --device cuda --rollout-device cuda --threads 1 \
  --workers 24 --games-per-iteration 48 \
  --sequence-length 16 --burn-in 8 --sequence-batch-size 16 \
  --epochs 2 --learning-rate 3e-5 --league-size 12 \
  --iterations 1 --output "rl/runs/deep256-$(date -u +%Y%m%dT%H%M%SZ)" "$@"
