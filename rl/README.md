# 酒馆战棋离线自博弈 PPO

这是可运行的第一版训练器。八个席位由当前神经网络或冻结的历史网络控制，采样、战斗和训练都在本机完成。不依赖游戏网站、上传数据或现有脚本人机。安装依赖后，运行时不需要联网。

训练包不包含卡面和网页。Node 运行与游戏共享的规则引擎，Python 通过本地标准输入输出驱动多个模拟器。训练时关闭战斗逐帧记录和界面日志。

## 安装与首次运行

需要 Linux、Node.js 20 或更新版本、Python 3.12 或更新版本。本地验证使用 Python 3.13 和 CPU。以下命令在解压后的 `tavern-selfplay` 目录执行。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install -r rl/requirements.txt
bash rl/run.sh test

# 小规模验证，不用于衡量棋力
bash rl/run.sh train --output rl/runs/smoke --iterations 2 \
  --games-per-iteration 2 --workers 2 --hidden 64 --max-actions 8 --epochs 2
```

`python3 -m venv` 不可用时，先安装系统对应的 Python venv 包。GPU 机器先按 [PyTorch 安装说明](https://pytorch.org/get-started/locally/) 安装与驱动兼容的 PyTorch 2.14.0 CUDA wheel，再安装 requirements，不要先执行上面的 CPU wheel 命令。确认 CUDA 可用后，给训练命令添加 `--device cuda`。

```bash
.venv/bin/python -c 'import torch; print(torch.__version__, torch.cuda.is_available())'
```

源码仓库需要先运行 `npm ci && npm run build:rl`。独立包已有 `rl-dist/bridge.cjs`，无需安装 npm 依赖。

## 开始、续训与评估

下面是起始配置。机器确定后先测吞吐，再调整 workers 和每轮对局数。每轮采集完整对局后更新网络。`--iterations` 表示本次额外训练多少轮。

```bash
bash rl/run.sh train --output rl/runs/main --iterations 100 \
  --games-per-iteration 8 --workers 4 --learner-seats 4 \
  --max-actions 64 --device cpu

bash rl/run.sh train --output rl/runs/main \
  --resume rl/runs/main/latest.pt --iterations 100 --workers 4 --device cpu

bash rl/run.sh evaluate rl/runs/main/latest.pt \
  --games 64 --workers 4 --seed 1000000 --output rl/runs/main/evaluation.json
```

续训采用检查点中的网络结构、奖励、动作预算和优化参数。workers、device 和本次 iterations 可以重新指定。同一输出目录只能有一个训练进程；已有检查点时必须使用 `--resume`，或换一个输出目录。

第一轮八人均使用随机初始化的当前网络。以后默认四席使用当前网络，四席选择历史网络，席位轮换。历史池默认保留初始网络和最近七代。PPO 只更新当前策略采集的轨迹，不混入历史策略的数据。

评估时只有一个候选模型席位，其他七席使用冻结模型。报告候选席位的平均名次、前四率、第一率和名次标准误。可用 `--opponent-checkpoints file1.pt file2.pt` 指定固定对手。默认评估种子从 1000000 开始；不要与训练种子范围重合。比较候选模型时应固定对手、种子和对局预算。八席共用同一模型的平均名次恒为 4.5，不能用来判断进步。

中断后从上一个完整更新轮恢复。检查点包含网络、优化器、历史池、完成局数及 Python、NumPy、PyTorch 随机状态，不保存正在采集的一轮轨迹。已在相同 CPU 环境和并发配置下验证续训一致性；跨设备或改变并发数不保证逐位一致。长期实验应定期备份检查点。PyTorch 完整检查点只能加载自己生成或可信来源的文件。

## PPO 实现

- 观察包含己方手牌、酒馆、战队、经济、种族、技能、发现选项、公共对手信息和上一场敌方阵容，不提供实时对手手牌、招募阵容或剩余共享牌池。
- 两层 128 单元 MLP 共享编码器，分别输出动作分布和状态价值。输入维度、编号表与规则哈希写入检查点。
- 4004 个固定动作编码覆盖买卖、刷新、冻结、升级、出牌位置、目标、发现、英雄技能、第二技能和饰品。引擎验证动作，非法动作概率为零。编码容量不足直接报错。
- 每席位分别保存观察、掩码、动作、采样时 log probability 和 value，按该玩家自己的决策序列计算 GAE。
- 终局奖励为 `(4.5 - 名次) / 3.5`，第一名为 1，第八名为 -1。无购买或属性增长奖励。gamma 为 1，GAE lambda 为 0.95。
- PPO clip 为 0.2，价值损失系数 0.5，熵系数 0.01，梯度范数上限 0.5。重算采样动作的概率，更新策略和价值网络；KL 过大时提前停止优化。
- 默认每席位每回合最多 64 次普通决策，之后完成必要选择并结束回合。整局达到 30000 步仍未结束时标记 truncated，保存诊断并停止本轮训练，不编造名次。

算法参考 [PPO 原论文](https://arxiv.org/abs/1707.06347)。优化代码在 `rl/python/tavern_rl/model.py`，八席位采样在 `rollout.py`。

## 输出与回放

| 文件 | 用途 |
| --- | --- |
| `latest.pt` | 最新完整更新轮检查点 |
| `manifest.json` | 规则、网络、配置、依赖版本和历史池代数 |
| `metrics.jsonl` | 采样速度、样本数、损失、熵和 KL |
| `debug/` | 异常状态或截断对局动作记录 |
| `replays/` | 开启 `--replays` 后的种子和动作记录 |

回放要求规则哈希一致。默认只保存动作，需要战斗帧时离线重算。

```bash
bash rl/run.sh train --output rl/runs/replay-demo --iterations 1 \
  --games-per-iteration 2 --workers 2 --max-actions 8 --replays
bash rl/run.sh replay rl/runs/replay-demo/replays/game-42.json \
  --frames --output rl/runs/replay-demo/combat-42.json
bash rl/run.sh benchmark --games 4 --max-actions 16
```

benchmark 用均匀随机合法动作测模拟器速度，不参与 PPO 训练。JSON 战斗回放目前用于调试，尚未接入网页回放界面。

## 当前边界

训练范围为项目的 36.4.2 规则实现，有 234 张常规随从、67 张酒馆法术、89 位英雄。尚缺 27 位英雄；黑暗之赐实现 21/43；饰品有 23 种，官方池未完整核验。条目齐全不表示事件顺序与官方完全一致，见 `docs/rules-coverage.json`。

第一版自动分配八个不同英雄，暂不学习四选一或刷新英雄。观察采用固定槽位、标量卡牌编号和哈希计数，部分复杂附加效果只编码数量，表示仍需完善。网络没有记忆，尚未实现 GRU、Transformer、MCTS、专门寻找弱点的对手或分布式多机采样。

小规模测试只能证明流程可运行，不能证明棋力。大规模租机前应继续补规则、改进卡牌与效果表示，用固定对手和独立种子检验进步。训练产物尚未接入网站人机。

现有 2 核 2 GiB 服务器继续承载网页。采样主要消耗 CPU 和内存，小 MLP 不一定能充分使用大 GPU。先在租用机器上用小任务测采样与更新耗时，再扩大并发。带宽主要影响首次安装和搬运检查点。
