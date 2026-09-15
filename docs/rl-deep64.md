# 当前规则下的 64 层自博弈 PPO

本页保留早期实现或实验记录。当前网络、训练配置和已上线版本分别见 [网络结构](rl-network.md)、[训练流程](rl-training.md) 和 [在线推理](neural-serving.md)。旧命令需结合对应冻结版本使用。


`entity-gru-resnet` 保留 73 个实体槽位、两层 128 维注意力、每个玩家独立的 GRU，以及 4316 个分层合法动作。在 GRU 后分别设置策略和价值残差塔，默认各 64 个全连接层，两个塔不共享参数。

每个塔有 16 个残差块，每块依次执行四组 Linear、LayerNorm、SiLU，再加上输入。64 只统计这些块内的 Linear，不包含注意力编码器、GRU 和最终输出头。残差连接权重为 `1/sqrt(块数)`，塔输出还有 LayerNorm，以控制 PPO 输出初始尺度。

块内结构参考 [1000 Layer Networks for Self-Supervised RL](https://arxiv.org/html/2503.14858v3)。本项目仍使用带记忆的 PPO，额外采用残差缩放和输出归一化；论文中的 CRL 结论不能直接证明本项目增加深度就会提高棋力。需要在相同规则、对手、种子和训练预算下与浅层模型比较。

## 本次规则

使用当前排名、法术护甲、轮转配对和最近两回合公开战况，观察版本为 4，实体版本为 3。补充修复了招募阶段掉血刷新自我淘汰后保留旧配对的问题：每次淘汰立即按剩余玩家重新配对，六人存活时恢复三组存活玩家配对。正在等待推理的旧配对响应会被丢弃。

游戏规则覆盖仍以 `docs/rules-coverage.json` 为准。当前 234 个随从、67 个酒馆法术已列为实现，英雄为 89/116；这些数量不代表所有事件顺序都已完全复刻。

## 新建实验

在训练机器使用预装 PyTorch 时，设置 `TAVERN_RL_PYTHON` 为对应 Python，并让 Node 20 在 PATH 中。独立包已包含游戏模拟器，不依赖公网游戏服务器。

```bash
export TAVERN_RL_PYTHON=/root/miniconda3/bin/python
export PATH=/root/autodl-tmp/runtime/node/bin:$PATH
bash rl/run.sh test

# 完整 64 层网络的小规模验证
bash rl/run.sh train --architecture entity-gru-resnet \
  --policy-depth 64 --value-depth 64 --hidden 128 --heads 4 --layers 2 \
  --output rl/runs/deep64-smoke --iterations 1 --games-per-iteration 4 \
  --workers 4 --device cuda --rollout-device cuda --threads 1 \
  --max-actions 64 --epochs 2 --learning-rate 3e-5 \
  --sequence-length 16 --burn-in 8 --sequence-batch-size 4

# 续训恢复检查点中的真实网络、优化器和历史对手池
bash rl/run.sh train --resume rl/runs/deep64-smoke/latest.pt \
  --output rl/runs/deep64-smoke --iterations 1 --workers 4 --device cuda
```

`--policy-depth`、`--value-depth` 支持 4 的正整数倍，可建立 4、16、64 层对照。新实验默认仍是原 `entity-gru`，必须显式选择深层架构。续训时显式指定的架构或深度与检查点不一致会报错；省略则恢复保存的值。

旧 780 局模型的规则和观察版本不同，不能直接 `--resume` 到本次训练，也不进入新版冻结对手池。原浅层模型仍可用原软件包加载和在线推理。本次创建新的训练目录与检查点，从当前网络自博弈起步，再逐步加入同一规则下的历史网络。

## 正式训练和评估

验证配置可以通过下面命令扩大采样批次。`--iterations 100` 表示再做 100 次 PPO 更新，不代表固定小时数。

```bash
bash rl/run.sh train --resume rl/runs/deep64-smoke/latest.pt \
  --output rl/runs/deep64-main --iterations 100 --workers 8 --device cuda \
  --resume-games-per-iteration 16 --resume-learning-rate 3e-5
```

`manifest.json` 记录策略/价值深度、参数量、规则哈希和完成局数；`metrics.jsonl` 记录实际样本数、PPO 更新次数、KL、梯度范数、吞吐和显存峰值。长期运行前先用这些实测值确定时间预算。

同一模型八席自博弈的平均名次恒为 4.5，不能作为变强的证据。新规则下先积累多代冻结对手，随后使用 `arena` 固定评估套件，与浅层模型按相同种子和席位轮换比较。不要把旧规则模型的成绩当成新规则评估结果。

## 3080 Ti 验证

完整网络有 3,421,950 个参数。使用 4 个模拟器、每轮 4 局、每回合 64 次普通操作预算，在新目录完成一次训练和一次断点续训，共 8 局、7,442 次环境决策。首轮八席为当前网络，第二轮只有四席的当前策略数据进入 PPO，历史对手的数据不用于更新。

首轮学习率 `1e-4`，约 70 秒、3,795 个学习样本，触发 KL 提前停止，完成 9 次优化更新。第二轮显式改为 `3e-5`，约 82 秒、1,706 个学习样本，完成 58 次更新，平均 KL 为 0.0069，未触发提前停止。PyTorch 显存分配峰值约 434 MiB，不包含 CUDA 上下文的所有占用。深层架构默认初始学习率因此设为 `3e-5`，原浅层架构默认值保持 `3e-4`。

上述结果验证训练可运行和断点恢复，不是棋力评估。检查点位于训练服务器 `/root/autodl-tmp/tavern-selfplay-deep64-20260911/rl/runs/deep64-smoke/latest.pt`。详细验证记录见 `docs/rl-deep64-validation.json`。
