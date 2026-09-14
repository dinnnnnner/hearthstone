# 自己上线模型和继续训练

下面对应“把训练好的模型上线到客户端，再继续训练”的日常操作。入口是仓库中的 `scripts/tavern-ops.py`，在本机执行即可，不需要逐台手动复制模型。

## 先记住三台机器

| 用途 | SSH 地址 | 做什么 |
|---|---|---|
| 训练服务器 | `ssh -p 34884 root@connect.nmb2.seetacloud.com` | GPU 模仿学习、自我对战、保存完整训练检查点 |
| 计算服务器 | `ssh zich@100.97.24.15` | 运行网页对局所用的三个模型 |
| 公网服务器 | `ssh root@100.121.69.44` | 提供客户端和对局服务，通过隧道请求计算服务器 |

客户端地址：<https://8.153.150.101/tavern/>。

SSH 密码在终端提示时输入，脚本不会保存密码。如果 Tailscale 显示验证链接，打开链接完成登录，再继续。脚本会复用训练服务器的 SSH 连接。

## 1. 查看当前状态

在本机打开终端：

```bash
cd /home/zich/hearthstone
python3 scripts/tavern-ops.py status
```

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

保持当前配置：三个模型各 16 个模拟器，每轮 16 局，每两轮交换历史对手，外部对手占比 0.4；第一名排名奖励 +2、第八名 −1，每枚剩余铸币惩罚 0.01。

一次完成“上线，再续训两小时”：

```bash
python3 scripts/tavern-ops.py publish && python3 scripts/tavern-ops.py train --hours 2
```

只有上线检查成功，后面的续训才会执行。训练结束后仍需再次运行 `publish`，客户端才会使用更新后的权重。

## 提前停止

```bash
python3 scripts/tavern-ops.py stop
```

该命令向已核实身份的训练监督进程发送停止信号，等待其停止三个学习进程，保留已保存检查点。当前尚未保存的一轮采样会舍弃。停止确认后，可以执行 `publish` 或 `train`。

## 日志、磁盘和检查点

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
ssh -p 34884 root@connect.nmb2.seetacloud.com
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

训练服务器重启后，可恢复现有磁盘维护程序：

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
