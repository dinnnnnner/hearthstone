# 三个深度模型独立续训

`independent` 从完整训练检查点继续 PPO，各模型只使用自身历史网络作为冻结对手。
不交换权重、对手快照、优化器或训练数据。三个进程可共享一张 GPU。

进入独立模式前移除 `external=true` 的对手、导入锚点和架构不一致的对手。
保留自身整数代号的历史网络，以及学习者当前权重、Adam 状态、随机数状态、训练进度和奖励设置。
如果没有可用自身历史，则以当前学习者的冻结副本初始化对手池。
此前混训产生的学习效果仍在当前权重里；独立续训不等于重新随机初始化。

```bash
bash rl/run.sh independent \
  --resumes /path/deep64/latest.pt /path/deep256/latest.pt /path/deep1024/latest.pt \
  --output rl/runs/independent-four-hour \
  --hours 4 --workers 3 --device cuda
```

每个模型一个训练进程和 3 个模拟器，检查点写到各自 `member-N/training/latest.pt`。
学习率、每轮局数、序列批量等从各自检查点恢复。
`--prepare-only` 仅生成隔离后的检查点及 `isolation.json`；随后以相同参数加 `--prepared` 启动。
输出目录必须全新，或是尚未启动的准备目录；不覆盖旧训练任务。

四小时时限从准备完成、开始启动三个训练进程时计算。监督进程在截止时间终止三个进程组，
其中包括模拟器子进程；某一个进程意外退出也会停止其他进程，避免无人监控地继续运行。
训练器每轮完成后原子保存检查点。截止时尚未完成的一轮不计入保存进度。
`status.json` 记录进程、开始/截止时间和退出原因，`isolation.json` 记录被移除的对手。

2026-09-14 的独立训练保留冻结的 36.4.2 模拟器和未用金币惩罚 0.01。
独立模式本身不是规则升级，不会将源码工作区里的未验证规则变更打入旧训练环境。

本次启动记录见 [rl-independent-launch-20260914.json](rl-independent-launch-20260914.json)。
北京时间 2026-09-14 09:29 启动，13:29 截止；64、256、1024 层分别从
1112、908、436 局继续，启动检查确认三个模型均已开始采样。
这些是启动时记录，后续进度以服务器运行目录中的 `status.json` 和训练日志为准。

## 客户端与训练共用 15 位英雄

唯一名单是 [`src/season/ai-hero-pool.json`](../src/season/ai-hero-pool.json)。
离线练习对手、在线人机和好友房补位人机均从此名单选择，避开玩家已选英雄。
玩家的自选英雄和四选一候选池仍使用全部已实现英雄；已开局的英雄不会被替换。
芬利等英雄的技能发现池不受初始英雄名单限制。

训练参数示例：

```bash
bash rl/run.sh independent \
  --resumes /path/deep64/latest.pt /path/deep256/latest.pt /path/deep1024/latest.pt \
  --output rl/runs/popular-independent --hours 4 --workers 3 \
  --hero-pool src/season/ai-hero-pool.json
```

单模型 `train` 同样支持 `--hero-pool`。名单内容随完整检查点和 manifest 保存；
恢复时未传参数会保留检查点中的名单，修改 JSON 文件本身不会改变正在运行的训练。
每局从名单中等概率、不放回地分配八个英雄，学习者和历史对手都受限制。
这限定了英雄的训练分布，没有新增英雄选择动作或改变英雄技能规则。
`game_start` 日志记录本局八位英雄，每轮指标中的 `hero_counts` 记录实际完成的英雄局数。
名单必须至少包含八个不同的已实现英雄；种族兼容性仍由模拟器检查，不会静默回退到全英雄池。

当前名单为历史热度的暂定子集，来源是 2026-04-18 的 35.2 公开榜。
当前完整选用率榜暂不可读取，因此不能把它称为 36.4.2 实时热门前十五。
来源链接和历史选用率在 JSON 中；这些选用率不作为采样权重。

2026-09-14 本轮已切换到 `/root/tavern-popular-heroes-20260914/rl/runs/popular-independent`。
保留冻结模拟器和独立对手历史，从最近完整检查点的 1128、908、436 局继续；
切换时未完成的一轮舍弃。使用 `--deadline-utc 2026-09-14T05:29:33.374655+00:00`
保留原定北京时间 13:29 截止时间，没有重新增加四小时。
训练启动与实际采样验证见 [rl-popular-heroes-launch-20260914.json](rl-popular-heroes-launch-20260914.json)，
公网发布和开房验证见 [ai-hero-pool-deployment-20260914.json](ai-hero-pool-deployment-20260914.json)。

之后本轮进行了采样吞吐优化，当前运行目录和参数以
[rl-rollout-optimization.md](rl-rollout-optimization.md) 为准；截止时间保持不变。

## 清理重复检查点

`scripts/deduplicate-checkpoints.py` 用 SHA-256 比较字节完全相同的 `.pt` 文件。
默认只报告；`--apply` 在同一文件系统内用硬链接合并重复文件，保留全部原路径和内容。
只对已经停止的训练目录使用。训练器必须像本项目一样原子替换检查点，不能原地改写共享文件。
检查文件内容没有变化后再替换，并记录校验和、原路径、实际释放空间。
不同训练进度即使文件尺寸相同也不会合并。

2026-09-14 在训练服务器的数据盘合并了 20 组完全相同的检查点、50 个重复副本，
释放约 22.1 GiB，可用空间增加到约 29.6 GiB。
完整路径和校验和见 [rl-checkpoint-cleanup-20260914.json](rl-checkpoint-cleanup-20260914.json)。
新训练输出位于系统盘 `/root/tavern-independent-20260914/rl/runs/independent-four-hour`，
不在本次清理范围内。
