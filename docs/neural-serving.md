# 已训练模型的在线推理

2026-09-11 公网人机已切换到 64 层、680 局检查点。每次模型推理都在当前本机完成，公网游戏后端通过反向 SSH 隧道发送观察并接收动作。浏览器仍访问原来的公网地址。256、1024 层模型尚未接入，模型选择入口仍在后续计划中。

当前检查点 SHA-256 为 `7c56298516f3f207b283e67c4c6176b72a48df339f65106dc743668645f295e8`。四小时任务到时停止，最后完成 680 局、44 次迭代。部署冻结了这个版本，后续训练不会覆盖它。层数和局数不代表经过统一评估的棋力排名。

## 本机服务与公网转发

本机的 `~/.local/share/tavern-deep64/releases/20260911-680` 保存约 14 MB 的推理文件、观察定义和 Python 运行代码，`current` 指向该目录。导出文件只含权重、模型定义和部署元数据，不含优化器和历史对手；服务使用 `weights_only=True` 加载。

两个用户服务分别运行模型和隧道，配置保存在 `deploy/tavern-deep64-inference.service` 与 `deploy/tavern-deep64-tunnel.service`。

```sh
systemctl --user status tavern-deep64-inference tavern-deep64-tunnel
curl -fsS http://127.0.0.1:18790/health
ssh root@100.121.69.44 'curl -fsS http://127.0.0.1:18791/health'
```

公网 `127.0.0.1:18791` 转发到本机 `127.0.0.1:18790`。模型端口仅监听回环地址。本机模型进程限用一个逻辑核、1 GiB 内存，压测时约占 418 MiB，峰值约 501 MiB。隧道由 systemd 自动重启，并用 SSH 心跳检测断线。

本机必须保持开机、联网并登录。两个服务已设置为登录后启动，但当前账户的 `Linger=no`，无权开启注销后常驻，不能保证注销或重启后未登录时仍可用。本机 Python 环境位于 `~/hearthstone/.venv`，迁移工作目录时需同步修改 unit。

公网后端使用以下环境变量：

```ini
Environment=TAVERN_INFERENCE_URL=http://127.0.0.1:18791
Environment=TAVERN_INFERENCE_PROFILE=scouting-v4
Environment=TAVERN_INFERENCE_COMPRESS=1
Environment=TAVERN_INFERENCE_MAX_KBPS=512
```

## 3 Mbps 带宽预算

推理请求和响应使用 gzip。公网后端按压缩请求大小加每次 512 字节的协议开销预留，控制发送间隔，预算为 512 kbps，约占 3 Mbps 的 17%。这属于应用层请求调度，不是网卡硬限速；流量计数也不包含 SSH、TCP 的实际开销。公网收到的动作响应属于入站方向。

公网经 SSH 到本机的三房间、八回合测试完成 1,794 次模型决策，耗时 102.56 秒，错误和回退均为零。平均请求耗时 42.1 ms，p95 为 52.6 ms。原始请求共 16,364,932 字节，压缩后 5,175,823 字节，平均出站请求载荷约 0.404 Mbps；响应载荷共 2,451,382 字节。此结果只覆盖本次三房间负载，房间增多仍会增加排队时间。

`/tavern-api/health` 的 `ai.traffic` 给出累计请求数、原始及压缩请求字节数、响应字节数和发送预算，服务重启后清零。

## 观察格式与导出

`server/neural-profile.ts` 按配置选择输入。`legacy-v3` 保留旧 780 局模型的观察投影；`scouting-v4` 使用当前训练格式，包含已公开的战况信息，不传入其他玩家私有手牌或未公开阵容。64 层模型使用观察版本 4、实体版本 3。

导出工具核对动作编号、实体编号及槽位布局，检查权重有限性，并记录静态定义适配数。本次 64 层模型适配数为零。Python 与 Node 对完整动作和实体定义计算同一个 SHA-256，契约不匹配则拒绝推理。

```sh
node --import tsx --input-type=module -e 'import {inferenceProfile} from "./server/neural-profile.ts"; import {writeFileSync} from "node:fs"; writeFileSync("/tmp/tavern-serving-schema.json", inferenceProfile("scouting-v4").schema)'
.venv/bin/python scripts/export-inference.py PATH_TO_TRUSTED_CHECKPOINT /tmp/tavern-serving-schema.json PATH_TO_MODEL_PT
PYTHONPATH=rl/python .venv/bin/python -m tavern_rl.serve PATH_TO_MODEL_PT --port 18790
```

新模型需要独立冻结版本、端口和输入契约。后续安排见 [多模型接入计划](rl-serving-plan.md)。

## 房间行为与故障处理

全局异步队列轮流处理各房间、各人机的一步操作，每个座位维护独立的 128 维 GRU 状态和上一步动作。状态跨回合保留，随座位回收，服务重启后从零开始。64 层模型推理只计算策略，不运行训练用的价值分支。

单次 HTTP 推理超时为 5 秒。模型不可用或响应无效时，本轮回退到脚本人机，清空对应隐藏状态，10 秒后允许重试。健康接口分别记录实际模型决策数、错误数和回退回合数。当前界面没有独立的模型可用状态提示。

响应返回后重新检查房间、阶段、回合和座位修订号，丢弃过期响应。共享卡池变化导致操作失败时重新观察和预测。每回合最多执行 64 次普通操作，强制选择另有保护上限。计时对局继续遵循原房间计时规则。

## 验证与回滚

```sh
npm run test:server
PYTHONPATH=rl/python .venv/bin/python -m unittest discover -s rl/tests
node --import tsx scripts/benchmark-inference.ts http://127.0.0.1:18790 8 3 scouting-v4 512
```

基准测试使用内存中的独立房间，八个座位均由模型决策，不写入公开房间或线上存档。参数依次为推理地址、回合数、房间数、观察配置和 kbps 预算。部署记录见 [64 层本机转发验证](neural-deep64-local-2026-09-11.json)。

旧 780 局模型进程已停止，文件与 `tavern-inference` 服务配置保留在公网，历史记录见 [旧模型部署](neural-deployment-2026-09-11.json)。恢复旧模型时，先启动公网 `tavern-inference`，再恢复旧后端 `/opt/bobs-tavern/releases/20260911T024800Z` 和 `/opt/bobs-tavern/releases/20260911T073324Z/previous.service` 保存的旧 unit，并重启 `bobs-tavern`。回滚必须同时恢复旧观察配置，不能将新观察直接发给旧模型。移除 `TAVERN_INFERENCE_URL` 后重启则恢复脚本人机。
