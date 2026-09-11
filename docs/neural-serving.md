# 已训练模型的在线推理

2026-09-11 公网页面支持选择 64、256、1024 层人机。三个模型的每次推理都在当前本机完成，公网游戏后端通过反向 SSH 隧道发送观察并接收动作。浏览器仍访问原来的公网地址。默认选择 64 层，页面记住上次选择。

当前检查点 SHA-256 为 `7c56298516f3f207b283e67c4c6176b72a48df339f65106dc743668645f295e8`。四小时任务到时停止，最后完成 680 局、44 次迭代。部署冻结了这个版本，后续训练不会覆盖它。层数和局数不代表经过统一评估的棋力排名。

## 按房间选择模型

| 页面名称 | 冻结模型标识 | 训练局数 | 公网回环端口 | 本机端口 |
| --- | --- | --- | --- | --- |
| 64 层模型 | deep64-680 | 680 | 18791 | 18790 |
| 256 层模型 | deep256-636 | 636 | 18793 | 18792 |
| 1024 层模型 | deep1024-260 | 260 | 18795 | 18794 |

三项均为四小时任务到时后最后完成的检查点。模型清单、检查点哈希、地址和观察配置保存在 `deploy/inference-models.json`。完整训练检查点另行冻结在训练机的 `deep256-serving-20260911`、`deep1024-serving-20260911` 目录，后续续训不会覆盖部署文件。

大厅的“人机对手模型”适用于人机匹配和创建好友房。房主选择同桌全部人机使用的模型，加入者沿用房间选择。`POST /tavern-api/create` 的 `modelId` 为清单中的标识，省略时使用首项。服务器拒绝未知或不可用的模型，不接受客户端提供的地址或权重路径。

房间保存模型标识、标签和检查点哈希。刷新、重连、后端重启和再来一局保留选择；未指定模型的旧房间迁移到默认 64 层。服务端核对保存的检查点与配置，Python 核对请求中的检查点与实际权重，拒绝同输入格式下的错误版本。每个座位独立维护记忆。

`GET /tavern-api/models` 返回模型名称、训练局数和可用状态，不暴露推理地址。后台每 10 秒核验各端点的健康、输入契约和检查点哈希。页面禁用不可用选项，并在对局回退时提示本轮使用脚本人机。一个模型的故障退避不影响其他模型的房间。健康接口的 `ai.models` 分别记录决策数、错误和回退。

## 本机服务与公网转发

本机的 `~/.local/share/tavern-deep64/releases/20260911-680-multi` 保存约 14 MB 的推理文件、观察定义和 Python 运行代码，`current` 指向该目录。导出文件只含权重、模型定义和部署元数据，不含优化器和历史对手；服务使用 `weights_only=True` 加载。

两个用户服务分别运行模型和隧道，配置保存在 `deploy/tavern-deep64-inference.service` 与 `deploy/tavern-deep64-tunnel.service`。

```sh
systemctl --user status tavern-deep64-inference tavern-deep64-tunnel
curl -fsS http://127.0.0.1:18790/health
ssh root@100.121.69.44 'curl -fsS http://127.0.0.1:18791/health'
```

公网 `127.0.0.1:18791` 转发到本机 `127.0.0.1:18790`。模型端口仅监听回环地址。本机模型进程限用一个逻辑核、1 GiB 内存，压测时约占 418 MiB，峰值约 501 MiB。隧道由 systemd 自动重启，并用 SSH 心跳检测断线。

本机必须保持开机、联网并登录。两个服务已设置为登录后启动，但当前账户的 `Linger=no`，无权开启注销后常驻，不能保证注销或重启后未登录时仍可用。本机 Python 环境位于 `~/hearthstone/.venv`，迁移工作目录时需同步修改 unit。

256、1024 层使用 `deploy/tavern-model@.service`，分别启用 `tavern-model@deep256` 和 `tavern-model@deep1024`。权重与独立 Python 代码位于 `~/.local/share/tavern-models/<模型>/releases/<版本>`，`current` 指向冻结版本。每个进程限一个逻辑核、1 GiB 内存。`tavern-model-tunnel` 管理这两个端口的自动转发。所有用户服务同样要求本机保持开机、联网并登录。

公网后端使用以下环境变量：

```ini
Environment=TAVERN_INFERENCE_MODELS=/opt/bobs-tavern/current/inference-models.json
Environment=TAVERN_INFERENCE_MAX_KBPS=512
```

## 3 Mbps 带宽预算

推理请求和响应使用 gzip。三个模型共用一个发送预算，增加模型数量不会将预算乘三。公网后端按压缩请求大小加每次 512 字节的协议开销预留，控制发送间隔，预算为 512 kbps，约占 3 Mbps 的 17%。这属于应用层请求调度，不是网卡硬限速；流量计数也不包含 SSH、TCP 的实际开销。公网收到的动作响应属于入站方向。

首次 64 层部署时，公网经 SSH 到本机的三房间、八回合测试完成 1,794 次模型决策，耗时 102.56 秒，错误和回退均为零。平均请求耗时 42.1 ms，p95 为 52.6 ms。原始请求共 16,364,932 字节，压缩后 5,175,823 字节，平均出站请求载荷约 0.404 Mbps；响应载荷共 2,451,382 字节。此结果只覆盖当时三房间负载，房间增多仍会增加排队时间。

加入三个模型后，各开一间房跑到第八回合，共 1,781 次决策，耗时 101.24 秒，错误和回退均为零。合计出站请求载荷约 0.407 Mbps。64、256、1024 层的平均请求耗时分别为 41.5、43.0、47.5 ms，p95 分别为 52.8、53.5、58.2 ms。公网浏览器逐一选择三个模型、完成一回合、刷新重连和好友房继承选择均已通过。

`/tavern-api/health` 的 `ai.traffic` 给出累计请求数、原始及压缩请求字节数、响应字节数和发送预算，服务重启后清零。

## 观察格式与导出

`server/neural-profile.ts` 按配置选择输入。`legacy-v3` 保留旧 780 局模型的观察投影；`scouting-v4` 使用当前训练格式，包含已公开的战况信息，不传入其他玩家私有手牌或未公开阵容。64 层模型使用观察版本 4、实体版本 3。

导出工具核对动作编号、实体编号及槽位布局，检查权重有限性，并记录静态定义适配数。本次 64 层模型适配数为零。Python 与 Node 对完整动作和实体定义计算同一个 SHA-256，契约不匹配则拒绝推理。

```sh
node --import tsx --input-type=module -e 'import {inferenceProfile} from "./server/neural-profile.ts"; import {writeFileSync} from "node:fs"; writeFileSync("/tmp/tavern-serving-schema.json", inferenceProfile("scouting-v4").schema)'
.venv/bin/python scripts/export-inference.py PATH_TO_TRUSTED_CHECKPOINT /tmp/tavern-serving-schema.json PATH_TO_MODEL_PT
PYTHONPATH=rl/python .venv/bin/python -m tavern_rl.serve PATH_TO_MODEL_PT --port 18790
```

多模型部署和压测结果见 [本次部署记录](neural-multi-model-2026-09-11.json)。后续检查要求见 [多模型接入计划](rl-serving-plan.md)。

## 房间行为与故障处理

全局异步队列轮流处理各房间、各人机的一步操作，每个座位维护独立的 128 维 GRU 状态和上一步动作。状态跨回合保留，随座位回收，服务重启后从零开始。64 层模型推理只计算策略，不运行训练用的价值分支。

单次 HTTP 推理超时为 5 秒。模型不可用或响应无效时，本轮回退到脚本人机，清空对应隐藏状态，10 秒后允许重试。健康接口分别记录实际模型决策数、错误数和回退回合数。界面显示当前房间的所选模型和回退状态。

响应返回后重新检查房间、阶段、回合和座位修订号，丢弃过期响应。共享卡池变化导致操作失败时重新观察和预测。每回合最多执行 64 次普通操作，强制选择另有保护上限。计时对局继续遵循原房间计时规则。

## 验证与回滚

```sh
npm run test:server
PYTHONPATH=rl/python .venv/bin/python -m unittest discover -s rl/tests
node --import tsx scripts/benchmark-inference.ts http://127.0.0.1:18790 8 3 scouting-v4 512
```

基准测试使用内存中的独立房间，八个座位均由模型决策，不写入公开房间或线上存档。参数依次为推理地址、回合数、房间数、观察配置和 kbps 预算。部署记录见 [64 层本机转发验证](neural-deep64-local-2026-09-11.json)。

回滚到仅支持 64 层的旧后端前，应等待其他模型的活动房间结束，避免旧版忽略模型选择。

旧 780 局模型进程已停止，文件与 `tavern-inference` 服务配置保留在公网，历史记录见 [旧模型部署](neural-deployment-2026-09-11.json)。恢复旧模型时，先启动公网 `tavern-inference`，再恢复旧后端 `/opt/bobs-tavern/releases/20260911T024800Z` 和 `/opt/bobs-tavern/releases/20260911T073324Z/previous.service` 保存的旧 unit，并重启 `bobs-tavern`。回滚必须同时恢复旧观察配置，不能将新观察直接发给旧模型。移除 `TAVERN_INFERENCE_URL` 后重启则恢复脚本人机。
