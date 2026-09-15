# 文档索引

当前使用说明与带日期的实验记录分开维护。查具体运行状态用 `scripts/tavern-ops.py status`；历史 JSON 记录保留当时的局数、配置、部署目录和校验信息。

## 当前使用说明

| 文档 | 内容 |
| --- | --- |
| [项目首页](../README.md) | 功能、快速运行、代码目录 |
| [游戏说明](gameplay-guide.md) | 操作、卡池、技能与规则范围 |
| [规则覆盖](rules-coverage.json) | 实现数量和未实现项目 |
| [网络结构](rl-network.md) | 输入、Transformer、GRU、残差深度、动作和价值头 |
| [训练流程](rl-training.md) | PPO、混合对手、奖励、模仿和评估 |
| [训练包](../rl/README.md) | 环境、CLI、续训、检查点和打包 |
| [日常运维](tavern-operations.md) | 当前三台机器、状态、上线、续训和巡检 |
| [站点部署](../deploy/README.md) | 网页和房间服务部署 |
| [在线推理](neural-serving.md) | 模型注册、观察契约、隧道与带宽 |
| [招募回合搜索](rl-recruit-search.md) | 公开状态搜索、预算、回退和部署 |
| [真人示范](rl-human-demonstrations.md) | 录制、分段模仿与训练线接入 |
| [对手池](rl-opponent-diversity.md) | 历史快照、外部路线、抽样和兼容检查 |
| [群体训练](rl-population.md) | 多模型分别训练并交换对手 |
| [独立训练](rl-independent.md) | 去掉外部对手后的可选实验 |
| [磁盘维护](rl-maintenance.md) | 去重、检查点保留和运行锁 |
| [视频提取](rl-video-extraction.md) | 可选视频标注流程及未完成的训练适配 |

## 实验与历史记录

[Blackwell 调优](rl-blackwell-20260915.md) 记录当前硬件上的采样与 PPO 性能。[奖励迁移](rl-unused-gold-penalty.md) 和 [第一名奖励](rl-first-place-bonus.md) 说明训练目标变化。

[v3 架构](rl-v3.md)、[64 层](rl-deep64.md)、[256 层](rl-deep256.md)、[1024 层](rl-deep1024.md) 文档保留早期验证条件。它们的硬件、启动时间和旧模型局数不代表当前部署。[公开战况](rl-public-scouting.md) 说明观察协议变更。

`docs/checkpoints/` 保存游戏版本说明；`docs/*-YYYYMMDD.json` 保存训练与部署核验记录。历史记录中的旧奖励系数和运行目录不应直接套用到新任务。当前规则以源码及覆盖报告为准，当前训练参数以对应检查点的 `config` 为准。
