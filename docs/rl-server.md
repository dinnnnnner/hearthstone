# 租用服务器训练

训练目录为 `/root/autodl-tmp/tavern-selfplay`，Node 安装在 `/root/autodl-tmp/runtime/node`。模型、日志和代码均放在数据盘。服务器连接信息由租用平台提供，本文不保存登录密码。

## 环境

| 项目 | 实际配置 |
| --- | --- |
| GPU | RTX 3080 Ti，12 GiB 显存 |
| CPU / 内存 | 10 vCPU / 30 GB |
| Python | 3.12.3 |
| PyTorch | 2.12.1+cu130 |
| CUDA runtime | 13.0 |
| NVIDIA 驱动 | 595.71.05 |
| NumPy | 2.4.6 |
| Node | 22.23.2 |

保留镜像的 PyTorch 和 NumPy，未使用源码仓库锁定 2.14.0 的 `requirements.txt` 覆盖它们。服务器上的 `run-server.sh` 指定镜像 Python 和数据盘 Node 路径，可在新的 SSH 会话直接使用。脚本不需要开放 HTTP 端口。

## 查看验证结果

```bash
cd /root/autodl-tmp/tavern-selfplay
cat logs/gpu-check-v2.log
cat rl/runs/gpu-check-v2/manifest.json
```

v1 验证发现克罗米的法术槽位编码不足，已修复为 v2。旧检查点保留在 `rl/runs/gpu-check`，不能跨动作编码版本续训。

验证任务使用 6 个模拟器，每轮 12 局，batch size 为 512，网络隐藏层为 128，每玩家每回合最多 64 次普通决策。验证结束后进程退出，租用实例本身仍会按平台规则计费。

## 继续训练

从验证检查点另开一个正式输出目录，本次再训练 100 轮：

```bash
cd /root/autodl-tmp/tavern-selfplay
nohup ./run-server.sh train \
  --resume rl/runs/gpu-check-v2/latest.pt \
  --output rl/runs/main \
  --device cuda --workers 6 --iterations 100 \
  > logs/main.log 2>&1 < /dev/null &
printf '%s\n' "$!" > logs/main.pid
```

已有 `rl/runs/main/latest.pt` 时，续训改用这个文件，避免从早期验证模型重新开始。续训从检查点读取每轮局数、网络、奖励、批次大小及优化参数。

```bash
tail -f logs/main.log
nvidia-smi
```

按 Ctrl+C 退出 `tail` 不会停止后台训练。训练结束后检查 `latest.pt` 和 `manifest.json`，并把重要检查点备份到本机。数据盘不会随保存系统镜像一起保存。

## 独立评估

```bash
./run-server.sh evaluate rl/runs/main/latest.pt \
  --device cuda --workers 6 --games 64 \
  --seed 1000000 --output rl/runs/main/evaluation.json
```

不要在测量训练速度时同时运行评估。评估默认用池中的冻结历史模型；比较不同候选时，应通过 `--opponent-checkpoints` 固定同一组对手，并使用同一组独立种子。短测试用于验证流程，不能代表人类对局水平。
