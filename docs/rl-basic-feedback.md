# 场面与经济评分接入训练

通过 `--basic-feedback` 启用。当前实现用于完整对局 PPO，可使用普通采样、多进程和常驻采样器。评分器在 CPU 上运行，使用 `rl/basic-evaluation.ts` 的同一套计算，不增加神经网络参数。最终名次奖励仍由真实对局提供。

## 奖励计算

每次学习座位行动前，计算该座位公开局面的总分 `S`，转成有界值：

```text
Φ(s) = coefficient × tanh(S(s) / scale)
中间反馈 = Φ(本座位下一次决策状态) − Φ(当前状态)
最后一步奖励 = 实际名次奖励 − Φ(最后一次决策状态)
```

默认 `coefficient=0.1`，`scale=20`。所有评分项非负，所以 `Φ` 在 0 到 0.1 之间。最终名次奖励仍为 `(4.5 − 名次) / 3.5`，如另设吃鸡奖励则保留该设置。

整个完整轨迹的奖励和等于“真实名次奖励减去开局 Φ”。开局评分在行动前确定，因此不会因为反复买卖、换位或拖延多走几步而凭空增加总奖励。终局必须将未来 Φ 归零；若遗漏这一步，就会把最后的高场面分当成额外获胜目标。

反馈按每个座位自己的轨迹计算，不把下一位玩家的局面当成当前玩家的动作结果。淘汰后该座位的轨迹在最终汇总时使用它的真实名次。截断的对局不生成训练轨迹，训练入口仍会拒绝截断批次。沿用 PPO 的短程优势计算，让局部变化进入优化；这种接入并不证明所设权重最优，也不保证棋力上升。

训练评分读取实际决策时的招募状态。上一回合剩余金币、战斗以及下一回合收入变化由游戏引擎实际执行，下一次该座位行动时再计算评分。不会假造对手阵容或将名次预测当成名次结果。

## 与旧估值结构的关系

此模式与 streaming、counterfactual、card-value、action-value、scene-value、multi-horizon、gold-planning 和 stage-feedback 分开。显式开启冲突模式或恢复含辅助估值头的检查点时，会报错说明需要新实验。可以新建模型，或在没有这些辅助头的 PPO 模型上单独实验。

已有辅助估值模型可用 `--warm-start old/latest.pt --basic-feedback` 建立新实验。它逐项复制原实体编码器、GRU、策略/价值主干和基础输出头，只丢弃明确列出的旧辅助估值头。缺失主干权重、多出未知权重或形状不匹配都会报错。转换保留旧知识，但移除估值项会改变动作偏好，不能称为行为无损迁移。优化器重新初始化，旧对局与迭代数保存在 `config.warm_start`，新实验独立计数。

```bash
bash rl/run.sh train --basic-feedback --warm-start old/latest.pt \
  --output rl/runs/basic-feedback-from-old --device cuda --rollout-device cuda \
  --workers 8 --sampling-processes 4 --persistent-samplers \
  --games-per-iteration 8 --sequence-batch-size 32 \
  --fused-adam --training-graphs --ai-action-limits --iterations 1
```

热启动保持原深度和宽度；不提供 `--tower-width 512` 等新架构参数。它和 `--resume` 互斥，后续恢复新实验应使用 `--resume`。`--anchors` 仍可载入未经转换的旧模型作为冻结对手，主学习模型不再包含旧辅助估值头。

明确选择 `--basic-feedback` 后，不读取环境变量中的旧辅助模式开关。它不会静默继承旧训练服务器的 `TAVERN_STREAMING=1` 等设置。已有旧实验和默认训练入口保持原行为。

参数、完整评分权重、评分器版本及实现哈希都保存在检查点。恢复时省略开关会保留原设置；评分器内容或规则定义改变时会拒绝恢复，避免相同实验悄悄换奖励。不能通过 `--no-basic-feedback` 移除已有实验的奖励目标。系数、缩放和权重的显式覆盖会写入后续检查点，应另存实验目录比较效果。

## 使用

首次构建独立评分器，不覆盖现有训练模拟器：

```bash
npm run build:basic
```

新建本地实验示例：

```bash
bash rl/run.sh train \
  --basic-feedback --output rl/runs/basic-feedback-experiment \
  --architecture entity-gru-resnet --policy-depth 64 --value-depth 64 \
  --tower-width 512 --ai-action-limits \
  --games-per-iteration 8 --workers 4 --learner-seats 4 \
  --epochs 2 --iterations 1 --device cpu
```

64×512 只是已具备速度基准的候选结构，不代表已经验证比 1024 层棋力更强。此命令是示例，没有启动该新架构实验。用户后来选择保留旧权重，GPU 服务器启动的是旧 64/256/1024 层热启动实验。没有冻结对手时，现有训练器第一批会让八个座位全部使用学习策略；后续使用冻结历史对手。

恢复同一实验：

```bash
bash rl/run.sh train --resume rl/runs/basic-feedback-experiment/latest.pt \
  --output rl/runs/basic-feedback-experiment --iterations 1 --workers 4 --device cpu
```

可选参数：`--basic-feedback-coefficient`、`--basic-feedback-scale`、`--basic-feedback-weights weights.json`。权重文件格式与独立评分器相同，例如 `{"attack":1,"health":1,"tier":3}`。系数限制在 `(0, 0.25]`。

`metrics.jsonl` 的 `basic_feedback` 包含评分状态数、CPU 评分耗时、训练轨迹数、正负反馈步数、反馈总和以及终局归零修正总和。多进程日志汇总所有采样进程。这里的反馈总和可能为负，是减去开局 Φ 的结果，不能直接作为棋力指标。

## 验证范围

本地规则测试覆盖奖励差值、终局归零、循环无净收益、每个座位的轨迹归属、对手样本排除、配置恢复、版本不一致拒绝以及关闭路径。另用一个小型残差模型跑真实完整对局，验证采样、奖励、PPO 更新、检查点和恢复链路。具体数值见 `rl-basic-feedback-validation-20260916.json`。

该小模型只用于验证接入，不是要发布的新机器人。正式比较仍需固定对手、独立种子、完整对局平均名次及前四率。当前评分器对亡语、成长体系和对手克制的近似限制仍然存在。

2026-09-16 后续已接入资源与进度巡检，并选用每路 24 个环境持续续训，见 [并发测试及持续训练记录](rl-basic-highload-20260916.md)。此前 15 分钟试训的停止时限只适用于该轮试训。
