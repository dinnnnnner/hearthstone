# 模仿后接入自我对战

`bootstrap_imitation` 将选定的 `best.pt` 转成新的完整 PPO 检查点。它校验真人记录的观察与动作契约，要求候选来自验证最优轮次，并逐张量保留模仿权重。PPO 优化器重新初始化，自我对战局数与迭代数从 0 开始；初始历史池只有该模仿策略的冻结副本，价值塔与价值头重新允许梯度更新。

```sh
PYTHONPATH=rl/python .venv/bin/python -m tavern_rl.bootstrap_imitation \
  --candidate /path/to/deep64/best.pt --output /path/to/bootstrap-64 \
  --learning-rate 3e-5 --hero-pool src/season/ai-hero-pool.json
```

之后用 `tavern_rl.train --resume /path/to/bootstrap-64/latest.pt` 开始完整对局 PPO。首次对手交换要求每个模型先完成实际自我对战，因此三个深度各完成 2 局、一次 PPO，再进入常规 population。名次奖励第一名 +2、第八名 −1，AI 收尾冻结与换位限制继续启用。金币规划保持关闭，先让价值头从真实回报学习；不会用随机价值头构造搜索标签。

## 精度试验

`selective_precision.bf16_tower_linears` 是显式实验上下文，只将策略塔和价值塔的线性矩阵计算切到 BF16，输出立即转回 FP32。主权重、优化器状态、归一化、残差累加、实体与注意力编码、GRU 记忆、动作头和价值输出、概率与对数概率、优势、回报、PPO 损失和梯度裁剪均为 FP32。上下文不会修改权重文件格式或默认训练精度。

精度上下文先安装，CUDA Graph 在其中捕获，并在上下文退出前释放。关闭 autocast 权重缓存，避免优化器更新后重用旧的低精度权重。CPU 回退为 FP32。

```sh
PYTHONPATH=rl/python .venv/bin/python scripts/benchmark-selective-precision.py \
  --candidates-root /path/to/fresh-imitation --dataset /path/to/selected-games \
  --output /path/to/precision.json
```

脚本使用真实公开观察，测量批量 8、32 的完整推理和批量 512 的塔前向、反向与 Adam 耗时，报告概率差、KL 和价值误差。塔基准只验证计算与有限梯度，不代表完整 PPO 或棋力。正式接入前另用相同的完整对局轨迹、初始化权重与随机状态比较 FP32 和 BF16 的完整 PPO 更新，只保留 FP32 试验产生的训练检查点。

采样测试让三个深度同时运行，比较每个模型 64 个模拟器配 4 或 8 个采样进程。固定每模型 64 个种子，每局前 128 次操作，截断轨迹全部丢弃。该测试包含进程启动与图捕获，测的是短局面吞吐，不能直接当作完整训练加速。若 4 进程相对 8 进程超过 5% 吞吐增益，则先采用 4 进程，并继续通过正式训练巡检观察。

## 当前运行

2026-09-15 北京时间 17:37 已启动三个深度的混合自我对战，仍于 19:57:55 截止。64 层使用模仿第 9 轮，256、1024 层使用第 7 轮最佳候选。每个模型先完成 2 局及一次实际 PPO，确认价值参数已更新后接入 population。

正式配置使用 FP32、每模型 64 个模拟器和 4 个采样进程、每轮 64 局，每两轮交换对手。4 进程短测总吞吐为 925.7 次操作/秒，8 进程为 827.6 次操作/秒，约快 12%。这只是短前缀采样结果。BF16 保留为实验工具；64 层交换顺序复测后 FP32 为 1.60 秒，BF16 为 1.67 秒，首次运行开销会夸大 BF16 的收益。用户随后要求停止继续测试并直接训练，正式任务不启用 BF16。

运行目录为 `/root/autodl-tmp/tavern-fresh-selfplay-20260915/population`，任务记录和五分钟检查为 `/root/tavern-ops/20260915-fresh-selfplay/`。见[接入与性能记录](rl-fresh-selfplay-validation-20260915.json)。

## 特征准备优化

17:44 后切换到 `/root/autodl-tmp/tavern-packed-features-20260915/population`，任务与五分钟巡检为 `/root/tavern-ops/20260915-packed-features/`。三个模型均从实际累计 66 局继续，保留完整优化器和历史池。截止时间、奖励和 FP32 精度保持原配置。

实时采样中 CPU 的 25 核配额已满，平均推理批量约 3.6。`pack_entities` 将 9 组 int64 索引合并传输，再按原形状建立视图；数值字段单独保留 FP32。每次打包的主要数据传输从 10 次减少到 2 次。模型缓存静态卡牌定义的解析结果，动态牌面仍逐次读取；缓存不包含依赖模型权重的嵌入，参数更新不会使用旧嵌入。缓存仅适用于该模型固定的 schema。

CPU 与 CUDA 上检查整数、FP32 字段和负零的字节均与原传输方式相同，循环记忆回归通过。17:45 已确认三个训练进程恢复。这里没有声称新的完整训练加速倍率，后续吞吐由正常训练日志记录。
