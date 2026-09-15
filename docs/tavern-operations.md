# 自己上线模型和继续训练

下面对应“把训练好的模型上线到客户端，再继续训练”的日常操作。入口是仓库中的 `scripts/tavern-ops.py`，在本机执行即可，不需要逐台手动复制模型。

人机冻结与换位限制已同步到公网、搜索服务及 Blackwell 训练端。2026-09-15 的迁移保留三份完整训练状态，现有运维路径通过符号链接指向新目录，命令无需修改。后续更新 Git 仍不会自动替换服务器冻结的运行程序，见 [部署与回滚记录](ai-action-limits-deployment-20260915.md)。

## 先记住三台机器

| 用途 | SSH 地址 | 做什么 |
|---|---|---|
| 训练服务器 | `ssh -p 51735 root@connect.westb.seetacloud.com` | RTX PRO 6000 Blackwell，自我对战、保存完整训练检查点 |
| 计算服务器 | `ssh zich@100.97.24.15` | 运行三个普通模型及三个独立搜索版本 |
| 公网服务器 | `ssh root@100.121.69.44` | 提供客户端和对局服务，通过隧道请求计算服务器 |

客户端地址：<https://8.153.150.101/tavern/>。

SSH 密码在终端提示时输入，脚本不会保存密码。如果 Tailscale 显示验证链接，打开链接完成登录，再继续。脚本会复用训练服务器的 SSH 连接。

## 1. 查看当前状态

在本机打开终端：

```bash
cd /home/zich/hearthstone
python3 scripts/tavern-ops.py status
```

默认连接新 Blackwell 服务器。旧 3080 Ti 保持停止，可用 `python3 scripts/tavern-ops.py --training-server legacy status` 查看。两个服务器的 SSH 连接分别保存。

先显示训练状态，再显示客户端正在使用的模型版本。

| 字段 | 含义 |
|---|---|
| `stage: running` | 正在训练 |
| `stage: time_limit` | 已按时停止，可以上线或开始下一轮 |
| `stage: interrupted`，三个成员 `pid: null` | 已主动停止，可以上线或继续训练 |
| `deadline_utc` | 自动停止时间，换算北京时间加八小时 |
| `members` 中的 `stage: training` | 对应模型学习进程正在运行 |
| 在线模型的 `episodes` | 该上线版本的累计训练局数 |

训练继续写新检查点，客户端使用固定上线版本，因此两个位置的累计局数不一定相同。

## 2. 上线最新模型

等训练停止后执行：

```bash
python3 scripts/tavern-ops.py publish
```

命令更新三个普通模型，保留已注册的独立搜索版本。搜索权重需要另行验证和部署，见 [回合搜索](rl-recruit-search.md)。

命令会导出三个最终检查点，校验哈希和观察契约，把权重传给计算服务器，运行推理检查，然后切换公网版本并验证网页对局。

操作成功后刷新客户端，新开对局即可使用。每次生成独立版本目录，旧版保留。训练还在运行时命令会退出；切换前如果有人正在对局，也会退出。等对局结束后可以重新执行。

如果服务切换失败，脚本会尝试恢复切换前的计算与公网版本。网页测试在切换之后执行，若网页测试失败，命令会返回失败并保留日志，需要检查当时的线上状态。

## 3. 再训练两小时

```bash
python3 scripts/tavern-ops.py train --hours 2
```

八小时改成：

```bash
python3 scripts/tavern-ops.py train --hours 8
```

时间从实际启动续训时计算，终端会打印北京时间的截止时间。训练在服务器后台执行，关闭本机终端后继续运行，到时自动停止。训练服务器本身需要保持运行。

未指定模型和并行参数时，三个模型各用 16 个模拟器，每轮 16 局，每两轮交换历史对手，外部对手占比 0.4；第一名排名奖励 +2、第八名 −1，已移除回合结束剩余金币扣分及逐步扣分记录，仅使用终局排名奖励。

集中训练一个主模型并扩大采样批量，例如训练 256 层、64 并行、每轮 64 局：

```bash
python3 scripts/tavern-ops.py train --hours 2 --model 256 --workers 64 --games 64
```

`--sequence-batch-size` 可以明确修改 PPO 每次更新的序列数量，`--fused-adam` 启用融合 CUDA Adam，`--no-fused-adam` 可恢复普通实现。不传这些选项时沿用检查点设置。新续训会移除旧检查点中的金币扣分配置，优化器状态继续保留。

Blackwell 上可以将采样拆成多个 Python 进程，并通过 NVIDIA MPS 并发提交 GPU 工作：

```bash
python3 scripts/tavern-ops.py train --hours 4 --model 256 \
  --workers 256 --games 256 --sampling-processes 16 --mps \
  --sequence-batch-size 32 --fused-adam
```

上面是集中训练一个模型的配置。2026-09-15 四小时任务实际同时训练三种深度，启动参数为：

```bash
python3 scripts/tavern-ops.py train --hours 4 --model all \
  --workers 64 --games 64 --sampling-processes 8 --mps \
  --sequence-batch-size 32 --fused-adam --training-graphs
```

每个模型 64 个模拟器、8 个采样进程，合计 192 个模拟器、24 个采样进程。每两轮共 128 局后交换对手。混合对手比例、奖励和训练与模仿的关系见 [训练流程](rl-training.md)。

前面的单模型配置总计 256 个模拟器，每个采样进程 16 个。所有进程使用同一份冻结检查点，全部对局结束后才更新参数。`--training-graphs` 可为 PPO 的残差网络启用前向和反向 CUDA Graph，`--no-training-graphs` 关闭；只影响计算执行，不改变网络层数或浮点精度。MPS 使用独立的 `/tmp/tavern-training-mps` 管道，训练结束后守护进程可能继续空闲驻留。

这些参数按当前机器的 25 核、120 GiB 内存和约 96 GB 显存测试，不应直接套用旧 3080 Ti。CPU、GPU 在采样和更新阶段的占用会变化；内存和显存占满本身不会增加吞吐。监测和原始测试说明见 [Blackwell 调优记录](rl-blackwell-20260915.md)。

`--model` 可选 `64`、`256`、`1024` 或 `all`。只更新选中的模型，其他模型的已保存权重继续作为历史对手。`--games` 必须不小于 `--workers`；每轮收集指定局数后执行 PPO。CUDA Graph 采样加速默认启用。增加每轮局数也会改变 PPO 更新间隔，更多对局不直接等于更强棋力。

一次完成“上线，再续训两小时”：

```bash
python3 scripts/tavern-ops.py publish && python3 scripts/tavern-ops.py train --hours 2
```

只有上线检查成功，后面的续训才会执行。训练结束后仍需再次运行 `publish`，客户端才会使用更新后的权重。

## 提前停止

```bash
python3 scripts/tavern-ops.py stop
```

该命令向已核实身份的训练监督进程发送停止信号，等待其停止所有学习进程，保留已保存检查点。当前尚未保存的一轮采样会舍弃。停止确认后，可以执行 `publish` 或 `train`。

## 日志、磁盘和检查点

当前四小时任务已启用后台健康巡检，每 300 秒检查训练进程身份、采样进度、检查点、当前异常日志、内存、GPU 和磁盘。巡检绑定本次任务，到训练停止后结束；不会自动重启训练或上线模型。正常的 PPO 计算可能没有新日志，巡检还会比较进程 CPU 时间，避免仅凭 GPU 低占用或检查点未更新判断卡死。

在训练服务器查看最新结果和告警：

```bash
cat /root/tavern-ops/20260915-action-limits/health/latest.json
tail /root/tavern-ops/20260915-action-limits/health/alerts.jsonl
```

`healthy: true` 表示本次未发现异常；`checks.jsonl` 保存全部检查，`alerts.jsonl` 仅在发现异常时创建。`next_check_utc` 是下一次检查时间，`watch_complete` 表示巡检已结束。后台结果写在服务器文件中，不会自动向聊天窗口推送消息。实现入口为 `scripts/watch-training.py`，启动新的训练任务时需绑定新的 `resume.json`。

每次命令结束都会打印本次文件目录，位于本机：

```text
~/.local/share/tavern-ops/jobs/<本次编号>/
```

续训的服务器日志位于终端打印的路径：

```text
/root/tavern-ops/<本次编号>/population.log
```

进入训练服务器查看：

```bash
ssh -p 51735 root@connect.westb.seetacloud.com
cat /root/tavern-four-hour-20260914/population/status.json
nvidia-smi
df -h / /root/autodl-tmp
```

需要实时日志时，把下面的编号替换成刚才命令打印的编号；`Ctrl+C` 只退出日志查看：

```bash
tail -f /root/tavern-ops/本次编号/population.log
```

三个完整训练检查点始终位于：

```text
/root/tavern-four-hour-20260914/population/member-0/training/latest.pt
/root/tavern-four-hour-20260914/population/member-1/training/latest.pt
/root/tavern-four-hour-20260914/population/member-2/training/latest.pt
```

完整检查点含优化器、随机数状态及历史对手，用于续训。上线用的 `model.pt` 是精简推理文件。

以下磁盘维护程序位于旧 3080 Ti 服务器，新 Blackwell 服务器无需执行：

```bash
bash /root/tavern-maintenance/start.sh
```

## 环境与脚本检查

本机需要 Python 3、SSH、Node.js 和已安装的项目依赖。当前电脑已有这些环境。首次换到新电脑，先准备仓库与依赖：

```bash
npm ci
npx playwright install chromium
```

只检查本地脚本，不连接服务器：

```bash
python3 scripts/tavern-ops.py check
python3 -m unittest discover -s scripts -p test_tavern_ops.py
```

这套入口针对当前部署目录。训练端依赖 `/root/autodl-tmp/tavern-mixed-popular-20260914` 中的冻结运行程序、`/root/tavern-human-current-06cd2177/population_resume.py` 以及 `/root/tavern-repeat-live-20260914/export/schema.json`。计算端使用现有服务目录与 `incoming-1c52af64/preflight.json` 推理样本。整理服务器文件时需保留这些依赖。

入口复用了已完成上线和续训的脚本，并移除了固定发布日期及模仿对局数限制。本次新增入口已验证只读状态查询、模板语法，以及训练锁、活跃对局和切换回滚保护；未为测试它而再次切换线上版本或重启当前训练。

`publish` 成功后会更新本地 `deploy/inference-models.json`。需要同步 Git 时可单独提交这个文件；命令不会自动提交工作区里的其他修改。

## 停训后发布并续训

`publish --include-search` 会同时更新普通版和搜索版的六个选项。每个深度的两种选项使用同一份导出权重，保留各自服务端口、模型 ID 和搜索运行代码。发布先对六份新 release 做推理检查，搜索版额外验证合法动作和记忆隔离，再一起切换服务。普通 `publish` 仍只更新三个普通版。

`scripts/after-training.py` 可以接手一个指定的训练任务。它要求协调器 PID 和原定截止时间都吻合，并等待 `time_limit` 状态及全部子进程停止。手动中断、异常停止、换任务或改截止时间会终止接续流程。发布通过健康检查和六选项浏览器测试后，才从刚刚发布的完整检查点继续训练。

2026-09-15 已安排的流程使用本机用户 systemd 服务 `tavern-after-freeze-close-20260915`。它等待原任务在北京时间 15:50:39 停止，发布六个模型选项，再续训 4 小时。续训保持每模型 64 个模拟器、8 个采样进程、每轮 64 局、MPS、CUDA Graph 和融合 Adam，并新建每 300 秒检查一次的监控进程。新的 4 小时从发布验证完成后开始计算。

本机状态和日志位于 `~/.local/share/tavern-ops/jobs/20260915-after-freeze-close/status.json` 与 `pipeline.log`。发布及训练运行记录在训练机 `/root/tavern-ops/20260915-after-freeze-close/`。若有活跃房间，流程等房间空闲再切换。失败会记录为 `failed`，不会自动重试发布或重复启动训练。

查看接续流程：

```bash
systemctl --user status tavern-after-freeze-close-20260915
cat ~/.local/share/tavern-ops/jobs/20260915-after-freeze-close/status.json
```

流程作为后台服务运行，使用固定源码副本。后续编辑工作目录不会改变已安排的发布步骤。它依赖本机持续运行及三台主机的 SSH 连接。
