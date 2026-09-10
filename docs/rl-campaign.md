# 持续自博弈实验

`campaign` 会从可信检查点继续训练，保持完整对局、八席位神经网络对手和原有名次奖励。默认追加 1024 局、最多运行 4 小时。先达到时间上限时保留最近完成的一轮，不承诺一定完成全部局数。

当前配置为每轮 16 局、8 个模拟器、GPU 推理与 PPO 更新、学习率 0.0001。增加批次并降低学习率，是为了减少之前小批次下过早触发 KL 停止的情况，效果仍需评估。相同两局的服务器测量中，CPU 采样约 43 动作/秒，GPU 约 46；不是稳定加速比。

每轮保存 `training/latest.pt`。每完成一批 128 局，额外保存独立快照，并用固定对手进行 32 局监测评估。对手包括本轮开始时的模型和此前的神经网络。初始参照结果只计算一次，后续报告配对名次差。32 局只用于查看趋势，不通过 256 局的晋级门槛。

训练目标完成且时间允许时，自动做另一套 256 局候选与初始参照的最终比较。最终套件的种子独立于监测套件。整个实验共用时间上限，包含评估；到点可能中断正在采集的一轮或尚未完成的评估，已经完成的检查点保持有效。

```bash
cd /root/autodl-tmp/tavern-selfplay-v3
mkdir -p logs
nohup ./run-server.sh campaign \
  --resume rl/runs/gpu-pilot-r2/latest.pt \
  --output rl/runs/strong-selfplay-v3-001 \
  --anchors /root/autodl-tmp/tavern-selfplay/rl/runs/gpu-check-v2/latest.pt \
  --games 1024 --hours 4 --workers 8 \
  --games-per-iteration 16 --evaluate-every-games 128 \
  --device cuda --rollout-device cuda --learning-rate 0.0001 \
  > logs/strong-selfplay-v3-001.log 2>&1 < /dev/null &
```

这段命令用于新建实验，已有目录会拒绝覆盖。SSH 断开后任务继续运行。时间上限会停止本次实验的子进程，不会关闭租用实例。

查看阶段和采样进度：

```bash
cat rl/runs/strong-selfplay-v3-001/status.json
tail -n 5 rl/runs/strong-selfplay-v3-001/train-001.log
cat rl/runs/strong-selfplay-v3-001/training/manifest.json
```

`status.json` 的局数在阶段切换时更新；训练进行中，以 `training/manifest.json` 的 `episodes` 为最近完整检查点的局数。出现 `failed` 时检查对应日志，不会自动忽略规则错误继续训练。

后续再建实验时，把 `--resume` 指向该目录的 `training/latest.pt`，并使用新的 `--output`。`train` 新增明确的 `--resume-games-per-iteration` 和 `--resume-learning-rate`，不会把普通命令行默认值误当作续训参数改动。`--rollout-device` 可将推理与优化器分别放在 CPU/GPU；本轮使用同一 GPU。
