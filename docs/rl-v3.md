# 有记忆的自博弈训练器 v3

v3 用卡牌实体注意力网络和 GRU 替换默认 MLP，仍然在本机离线模拟八人对局。对手只有当前策略和冻结的神经网络。当前成果是可训练、可比较的模型实现，棋力需要足量对局验证。

## 网络与训练

输入包含 73 个固定实体位置。每张牌有独立身份嵌入，基本属性、关键词、基础能力、附加能力、效果计数及可见目标引用分别编码。嵌套效果按路径分组，字段名和字符串通过有序 UTF-8 字节 GRU 编码，取消旧版计数哈希桶。数值使用带符号 log1p 和 tanh 特征。字段不会按固定数量截断，但神经网络会把信息压缩到有限维向量，不能保证理解所有效果。

默认两层 Transformer、128 维、4 个注意力头，让手牌、酒馆和战队互相提供上下文。每个玩家有独立的 128 维 GRU 记忆，输入公共状态编码和自己上一次动作。新对局清零记忆，不读取其他玩家的隐藏手牌、当前招募阵容、随机数状态或剩余共享卡池。上一场交战阵容可见。英雄、饰品的专用代码效果目前主要通过身份嵌入学习，尚未转成统一的效果描述语言。

策略按“动作类型 → 来源 → 目标 → 位置”逐级计算条件概率，最终映射到原有 4316 个动作。每级只在有合法后续动作的选项之间归一化。一个动作拥有更多摆放位置，不会因此在初始策略中自动获得更高的类型概率。价值网络预测最终名次奖励。

PPO 按每位玩家的完整轨迹计算 GAE，再分成连续片段。默认训练片段长 16，前面最多 8 步用当前网络预热记忆，每批 4 个片段。片段内部保持时间顺序，补齐位置不参与损失。预热开始的记忆取自采样策略，这是带预热的截断反向传播，仍有旧记忆近似；不是每次更新都从开局重算完整历史。

奖励保持 `(4.5 - 名次) / 3.5`。无购买或属性增长奖励。网络结构、动作编号、规则指纹、优化器、历史对手及随机状态都写入检查点。v3 默认不接受 v2 续训。只有构建时确认规则文件、动作映射、旧观察投影及调度类与已验证版本一致，才允许把指定 v2 模型作为冻结对手或评估参照。

历史池默认 12 个模型，保留初始网络、外部固定对手、部分较早版本和近期版本。采样一半均匀，一半偏向当前模型较难击败的对手。难度来自同局相对名次的平滑统计，不是 Elo。尚未加入独立训练的漏洞针对模型。

## 租用服务器运行

解压 `tavern-selfplay-v3.tar.gz`，进入 `tavern-selfplay-v3`。沿用服务器已有 PyTorch CUDA 环境和 Node，不必重新安装 GPU 驱动。

```bash
export PATH=/root/autodl-tmp/runtime/node/bin:$PATH
export TAVERN_RL_PYTHON=/root/miniconda3/bin/python
bash rl/run.sh test

# 先做有限轮验证，测量这一网络在实际机器上的吞吐。
bash rl/run.sh train --output rl/runs/v3-pilot --iterations 2 \
  --device cuda --workers 4 --games-per-iteration 8 \
  --hidden 128 --heads 4 --layers 2 --max-actions 64 \
  --sequence-length 16 --burn-in 8 --sequence-batch-size 4

bash rl/run.sh train --output rl/runs/v3-pilot \
  --resume rl/runs/v3-pilot/latest.pt --iterations 2 --workers 4 --device cuda
```

`--anchors /path/to/trusted.pt` 可加入冻结神经网络，只有新建实验时使用。`--architecture mlp` 保留旧结构，用于消融对照。续训恢复检查点内的训练参数，命令行可更换设备、进程数和本次追加轮数。

## 固定评估

先冻结基准，再评估候选模型。套件复制对手文件并记录 SHA-256、模拟器版本、每局种子、候选座位和对手分配，目录已经存在时拒绝覆盖。候选玩家每局轮换座位；各座位有独立动作随机流。改变候选策略仍会改变后续对局状态，共用种子不代表所有后续商店必然相同。

```bash
bash rl/run.sh arena create rl/runs/validation-suite \
  --opponents rl/runs/baseline-a/latest.pt rl/runs/baseline-b/latest.pt \
  --games 256 --seed 1000000 --max-actions 64

bash rl/run.sh arena evaluate rl/runs/validation-suite rl/runs/v3-pilot/latest.pt \
  --reference rl/runs/baseline-a/latest.pt --device cuda --workers 4 \
  --output rl/runs/v3-pilot/validation-001.json
```

报告平均名次、前四率、第一率、英雄和种族分组样本量，以及候选减参照的配对名次差和 95% bootstrap 区间。至少 256 局且区间上界小于零，才通过这一套件的比较门槛。少数英雄样本不足时只能展示结果，不能据此断言该英雄更强。门槛不会自动发布模型，也不能证明对人类或其他对手更强。

验证种子不能与候选、参照或固定对手的已训练种子重叠。反复查看同一验证集会带来选择偏差。最终测试另建 `--split final --seed 2000000` 套件，提前固定对手，训练调参期间不要查看结果。程序校验已训练种子的重叠，但不会限制人查看 final 结果的次数。

## 尚需推进

训练仍受项目的规则覆盖范围限制，详见 `rules-coverage.json`。官方缺失英雄、黑暗之赐、饰品和复杂事件顺序还需补齐。英雄开局自动分配，暂不学习四选一。搜索规划、独立漏洞针对模型、跨机器采样和网页推理接入也尚未实现。当前评估对手的多样性取决于收集到的神经网络，几个早期快照不足以证明高棋力。

实现文件为 `rl/entities.ts`、`features.py`、`entity_model.py`、`recurrent.py`、`rollout.py`、`train.py` 和 `arena.py`。算法实现参考 [PPO 论文](https://arxiv.org/abs/1707.06347)、[CleanRL 循环 PPO](https://github.com/vwxyzjn/cleanrl/blob/master/cleanrl/ppo_atari_lstm.py)、[PyTorch GRU](https://docs.pytorch.org/docs/main/generated/torch.nn.GRU.html) 和 [TransformerEncoderLayer](https://docs.pytorch.org/docs/stable/generated/torch.nn.TransformerEncoderLayer.html)。

## 2026-09-10 验证记录

通过 10 项 TypeScript 测试、13 项 Python 测试，独立训练包中的 Python 测试也通过。本地小配置分次续训与连续训练的模型、优化器、历史池及 PyTorch 随机状态完全一致。

3080 Ti 上的 128 维、两层、4 头网络完成 12 局训练及续训，共 27 次优化器更新，每回合动作预算 64。第三轮采样约 62 动作/秒，加上 PPO 和历史网络重建约 59 动作/秒，PyTorch 峰值分配显存约 377 MiB。采样是目前主要耗时，不能按显存空闲量直接推算更大网络的训练效率。

8 局固定种子对照的结果如下。新模型训练了 12 局，旧网络训练了 36 局，训练量不相同，不能用此实验断言哪种网络结构更好。

| 模型 | 平均名次 | 前四率 | 第一率 |
| --- | --- | --- | --- |
| 新网络 | 7.000 | 12.5% | 0% |
| 旧神经网络参照 | 4.125 | 62.5% | 12.5% |

配对名次差为 +2.875，95% 区间为 `[1.000, 4.875]`，没有通过评估门槛。当前产物只能用来继续训练和调试，没有接入网页人机。

试跑中修复了额外饰品位置不足的问题，出错动作序列已加入回归测试。主试跑之后又修正了跨轮座位轮换，最终源码另完成一局 CUDA 验证，未把旧评估记为修改后重训结果。机器可直接使用以下命令续训主检查点，轮次有明确上限。

```bash
cd /root/autodl-tmp/tavern-selfplay-v3
./run-server.sh train --resume rl/runs/gpu-pilot-r2/latest.pt \
  --output rl/runs/v3-next --iterations 2 --workers 4 --device cuda
```

详细指标、版本指纹与备份校验见 [验证数据](rl-v3-validation.json)。检查点、固定对手、评估结果和出错状态已下载至开发机 `rl/runs/server-v3-2026-09-10/`。本次实验进程已退出，租用实例是否关机需在平台管理。
