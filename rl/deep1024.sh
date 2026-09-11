#!/usr/bin/env bash
set -euo pipefail
rl_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# New experiment; the 64/256-layer jobs and their checkpoints are independent.
# Default to one bounded iteration. Extra train arguments override these defaults.
exec bash "$rl_root/rl/run.sh" train \
  --architecture entity-gru-resnet --policy-depth 1024 --value-depth 1024 \
  --hidden 128 --heads 4 --layers 2 \
  --device cuda --rollout-device cuda --threads 1 \
  --workers 24 --games-per-iteration 48 \
  --sequence-length 16 --burn-in 8 --sequence-batch-size 16 \
  --epochs 2 --learning-rate 3e-5 --league-size 12 \
  --iterations 1 --output "rl/runs/deep1024-$(date -u +%Y%m%dT%H%M%SZ)" "$@"
