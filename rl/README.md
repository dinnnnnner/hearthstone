# 训练包使用说明

训练器用 PyTorch 学习策略，Node.js 运行与游戏共享的八人规则引擎。双方通过本地标准输入输出通信。自我对战不依赖网站、真人数据或脚本人机，安装完成后可以离线运行。

先读 [网络结构](../docs/rl-network.md) 和 [训练流程](../docs/rl-training.md)。管理现有三台服务器使用仓库中的 [日常运维入口](../docs/tavern-operations.md)，本页说明从源码或独立包运行训练。

## 环境和构建

项目使用 Node.js 20 或更新版本，已验证的 Python 环境为 3.12 / 3.13。源码仓库先构建模拟器：

```bash
npm ci
npm run build:rl
npm run build:search
```

独立包已有 `rl-dist/bridge.cjs`，不需要 npm 依赖。Python 模块由 `rl/run.sh` 设置路径。

本机 CPU 环境按仓库锁定依赖安装：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install torch==2.14.0 --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install -r rl/requirements.txt
```

`rl/requirements.txt` 固定 NumPy 2.5.3 和 PyTorch 2.14.0。GPU 环境需要与驱动匹配的 CUDA 构建。当前 Blackwell 冻结运行环境使用 Python 3.12.3 和 PyTorch 2.12.1+cu130，不能用上面的 CPU 安装命令或锁定文件覆盖它。该环境通过 `TAVERN_RL_PYTHON` 指向已有解释器，例如：

```bash
export TAVERN_RL_PYTHON=/root/miniconda3/bin/python
"$TAVERN_RL_PYTHON" -c 'import torch; print(torch.__version__, torch.cuda.is_available())'
```

这个绝对路径仅适用于现有训练服务器。换机器时设置实际解释器路径，并先完成短任务验证。版本与硬件实测见 [Blackwell 记录](../docs/rl-blackwell-20260915.md)。

## 从头训练

以下为有限轮流程检查，不用于评估棋力：

```bash
bash rl/run.sh train --output rl/runs/smoke --iterations 1 \
  --architecture entity-gru-resnet --policy-depth 64 --value-depth 64 \
  --hidden 128 --heads 4 --layers 2 --games-per-iteration 2 --workers 2 \
  --max-actions 8 --epochs 1 --first-place-bonus 1 --device cpu
```

较长实验可从下面配置开始，再根据本机吞吐调整：

```bash
bash rl/run.sh train --output rl/runs/deep64 --iterations 100 \
  --architecture entity-gru-resnet --policy-depth 64 --value-depth 64 \
  --hidden 128 --heads 4 --layers 2 --learning-rate 0.00003 \
  --games-per-iteration 8 --workers 4 --learner-seats 4 \
  --max-actions 64 --epochs 2 --first-place-bonus 1 --device cpu
```

在已验证的 CUDA 环境中将 `--device cpu` 改为 `--device cuda`。256 / 1024 层实验需同时修改 `--policy-depth` 与 `--value-depth`，也可查看 `rl/deep256.sh`、`rl/deep1024.sh` 的参数。新目录省略 `--architecture` 时使用较浅的 `entity-gru`。

需要与目前训练一致的英雄子集时，添加 `--hero-pool src/season/ai-hero-pool.json`，八席位从名单中不重复抽取。省略参数的新任务使用模拟器默认英雄池；续训继承已保存名单。

## 续训与评估

```bash
bash rl/run.sh train --output rl/runs/deep64 \
  --resume rl/runs/deep64/latest.pt --iterations 100 --workers 4 --device cpu

bash rl/run.sh evaluate rl/runs/deep64/latest.pt \
  --games 64 --workers 4 --seed 1000000 --output rl/runs/deep64/evaluation.json
```

`--iterations` 表示本次额外更新轮数。续训恢复网络、优化器、历史对手、奖励设置和随机状态，移除旧 `unused_gold_penalty` 配置。第一名额外奖励默认继承；旧检查点没有该字段时为 0，可显式传 `--first-place-bonus 1`。不要传已移除的 `--unused-gold-penalty`。

修改已保存的每轮局数、学习率或序列批量时，分别使用 `--resume-games-per-iteration`、`--resume-learning-rate`、`--resume-sequence-batch-size`。普通新建参数不会自动覆盖这些保存值。同一输出目录只允许一个训练进程。

评估应指定固定 `--opponent-checkpoints`、种子和对局预算，报告候选模型的平均名次、前四率和第一率。没有固定评估基准的训练局数和损失不能证明棋力提高。完整说明见 [训练流程](../docs/rl-training.md#如何判断训练有效)。

## 并行采样和混合对手

单进程内批量推理配合多个 Node 模拟器。`--sampling-processes` 将采样分到多个 Python 进程，每轮使用同一冻结策略，完成整批对局后执行 PPO。CUDA 环境可试用 `--fused-adam` 和 `--training-graphs`；后者只对支持的残差网络启用图执行。

NVIDIA MPS 的启停由现有服务器的运维入口管理，直接运行 `rl/run.sh` 不会替你配置 MPS。并发数需按实际 CPU 配额、内存和显存测试，见 [性能记录](../docs/rl-blackwell-20260915.md)。

混合已有检查点使用 `mix_league`；持续交换对手使用 `population`。各模型只更新自己的轨迹，保持独立参数和优化器。`independent` 用于移除外部对手后的独立实验，当前线上训练采用混合模式。具体命令见 [对手池](../docs/rl-opponent-diversity.md)、[群体训练](../docs/rl-population.md) 和 [独立训练](../docs/rl-independent.md)。

## 文件和兼容性

| 产物 | 内容 |
| --- | --- |
| `latest.pt` | 完整检查点，含模型、优化器、配置、历史对手、随机状态 |
| `manifest.json` | 网络规格、参数量、规则和源码哈希、版本、局数、配置 |
| `metrics.jsonl` | 采样和更新耗时、样本数、损失、熵、KL、对手抽样统计 |
| `replays/` | 使用 `--replays` 时保存种子和动作记录 |
| `debug/` | 异常或截断对局诊断 |
| 导出的 `model.pt` | 网站推理权重，不是完整 PPO 续训检查点 |

每轮完整更新后原子保存检查点。中断恢复会舍弃尚未保存的采样；更换设备或并发配置不保证逐位复现。完整 PyTorch 检查点仅加载可信来源。

检查点要求模拟器规则、观察和动作协议兼容。当前源码重新构建的 bundle 与服务器历史冻结 bundle 可能拥有不同哈希，不能直接混用。需要复现旧训练时，保留其原始软件包，或通过 `TAVERN_RL_BUNDLE` 指向对应 `bridge.cjs`。包名中的 `v3` 不是兼容性凭据。

`benchmark` 测随机合法动作的模拟器速度；`profile` 测网络及短采样。它们的截断对局不进入 PPO。动作回放见 `bash rl/run.sh replay --help`，目前用于离线调试。

## 检查和打包

源码仓库执行：

```bash
npm run test:rl
npm run test:search
bash rl/run.sh test
npm run package:rl
```

产物为 `rl-dist/tavern-selfplay-v3.tar.gz`，包含模拟器、Python 模块、说明文档和文件校验清单，不包含模型权重、真人原始对局和卡面素材。解压后先核对 `checksums.json`，在包根目录执行命令。

部分 Python 集成测试还依赖仓库中的 TypeScript、开发脚本或浏览器环境；它们需要在源码仓库运行。独立包可用本页的有限轮训练命令检查运行环境。

真人数据需要主动录制，模仿学习通过单独阶段接入完整检查点，见 [真人示范](../docs/rl-human-demonstrations.md)。视频提取是可选联网工具，当前产物仍需行为克隆输入适配，见 [视频说明](../docs/rl-video-extraction.md)。
