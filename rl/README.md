# 酒馆战棋离线自博弈 PPO

这是可运行的离线训练器。八个席位由当前神经网络或冻结的历史网络控制，采样、战斗和训练都在本机完成。不依赖游戏网站、上传数据或现有脚本人机。安装依赖后，运行时不需要联网。

训练包不包含卡面和网页。Node 运行与游戏共享的规则引擎，Python 通过本地标准输入输出驱动多个模拟器。训练时关闭战斗逐帧记录和界面日志。

当前默认是 v3：73 个卡牌和状态实体、Transformer + GRU、4316 个分层动作，以及按玩家连续序列更新的 PPO。完整说明和固定评估命令见 [v3 说明](../docs/rl-v3.md)。本次规则与公开战况更新使用观察版本 4、实体版本 3，`--architecture mlp` 使用 3209 维观察。旧规则的 v1、v2、v3 检查点不可直接续训或用作新版冻结对手；原模型需配合原软件包使用。历史 GPU 验证不代表本次更新的测试结果。

租用服务器的预装环境与启动命令见 [服务器说明](../docs/rl-server.md)。

新增 `--architecture entity-gru-resnet`，在策略和价值分支各使用 64 层残差 MLP。具体层数定义、当前规则与 GPU 启动命令见 [64 层实验](../docs/rl-deep64.md)。原架构和检查点加载方式仍受支持。

## 安装与首次运行

需要 Linux、Node.js 20 或更新版本、Python 3.12 或更新版本。本地验证使用 Python 3.13 和 CPU。以下命令在解压后的 `tavern-selfplay-v3` 目录执行。

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

无外部固定对手时，第一轮八人均使用随机初始化的当前网络。以后默认四席使用当前网络，四席选择历史网络，席位轮换。历史池默认 12 个，保留初始网络、外部固定对手及分散的早期和近期快照，并混合均匀与困难对手采样。PPO 只更新当前策略采集的轨迹，不混入历史策略的数据。

评估时只有一个候选模型席位，其他七席使用冻结模型。报告候选席位的平均名次、前四率、第一率和名次标准误。可用 `--opponent-checkpoints file1.pt file2.pt` 指定固定对手。默认评估种子从 1000000 开始；不要与训练种子范围重合。比较候选模型时应固定对手、种子和对局预算。八席共用同一模型的平均名次恒为 4.5，不能用来判断进步。

中断后从上一个完整更新轮恢复。检查点包含网络、优化器、历史池、完成局数及 Python、NumPy、PyTorch 随机状态，不保存正在采集的一轮轨迹。已在相同 CPU 环境和并发配置下验证续训一致性；跨设备或改变并发数不保证逐位一致。长期实验应定期备份检查点。PyTorch 完整检查点只能加载自己生成或可信来源的文件。

## PPO 实现

- 观察包含己方手牌、酒馆、战队、经济、种族、技能、发现选项、公共对手信息和上一场敌方阵容。八席均提供最近两回合的公开阵容类型、交战座位、胜负和伤害；座位编号固定，幽灵单独编号。输入包含排名生命值和法术护甲，不提供实时对手手牌、招募阵容或剩余共享牌池。
- 默认两层 128 维 Transformer 编码卡牌关系，各玩家独立 GRU 记忆，分层策略和价值输出。实体模式、编号表与规则哈希写入检查点。
- 4316 个固定动作编码覆盖买卖、刷新、冻结、升级、出牌位置、目标、发现、英雄技能、第二技能和饰品。引擎验证动作，非法动作概率为零。编码容量不足直接报错。
- 每席位分别保存观察、掩码、动作、采样时 log probability、value、记忆和前一动作，按自己的决策序列计算 GAE；以有预热的连续片段进行 PPO 更新。
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

当前自动分配八个不同英雄，暂不学习四选一或刷新英雄。卡牌附加效果和计数字段已展开编码，默认网络已有 Transformer 和 GRU，但英雄、饰品的专用逻辑仍主要依赖身份嵌入学习。尚未实现 MCTS、独立训练的弱点针对模型或分布式多机采样。

小规模测试只能证明流程可运行，不能证明棋力。长期训练前应继续补规则、测量当前网络吞吐，并用固定评估套件检验进步。早先的 780 局模型已接入网站人机，见 [在线推理说明](../docs/neural-serving.md)。64、256、1024 层本轮最终检查点需等四小时任务结束并验证后再接入；模型选择、公网资源评估和本机转发安排见 [接入计划](../docs/rl-serving-plan.md)。

现有 2 核 2 GiB 服务器继续承载网页。采样主要消耗 CPU 和内存，小 MLP 不一定能充分使用大 GPU。先在租用机器上用小任务测采样与更新耗时，再扩大并发。带宽主要影响首次安装和搬运检查点。

256 层残差模型可用 `bash rl/deep256.sh` 新建实验，默认只运行一轮。3080 Ti 上的并行采样实测、推理优化、完整对局验证和固定规则说明见 [256 层训练文档](../docs/rl-deep256.md)。用 `bash rl/run.sh profile` 比较实际模型的 CPU/GPU 延迟；用 `--rollout-only --rollout-workers 4 12 24` 测短采样，截断局不进入训练。

1024 层试验使用 `bash rl/deep1024.sh`，同样默认一轮，详见 [1024 层试验记录](../docs/rl-deep1024.md)。深度增加的收益要结合采样吞吐和独立棋力评估判断。
