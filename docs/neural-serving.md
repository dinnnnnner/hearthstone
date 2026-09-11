# 已训练模型的在线推理

在线房间通过 `server/neural.ts` 调用独立的 CPU PyTorch 进程。没有设置 `TAVERN_INFERENCE_URL` 时，继续使用原来的脚本人机。设置为 `http://127.0.0.1:8790` 后，补位人机和人机匹配使用训练模型。

本文记录的部署接入了四小时训练结束的 780 局检查点，SHA-256 为 `f98f4e2225049f74b4601ca13a2520c32d8a3b250927da17fa9266c06f2c2666`。原模型有 1,275,134 个训练参数，包含两层实体注意力和 128 维 GRU。这次部署使用原架构。

2026-09-11 另行启动的 64、256、1024 层训练有各自的四小时预算，不能把它们的中途检查点当作最终模型替换公网人机。先保持现有部署，等任务结束核验产物后，再评估公网资源；不足时在当前本机推理并转发。模型选择入口及多模型转发尚未实现，安排见 [训练完成后的接入计划](rl-serving-plan.md)。

## 规则适配

`server/neural-observation.ts` 固定了旧模型使用的实体观察格式，避免后续训练代码升级观察版本后意外改变在线模型输入。它使用当前游戏规则计算合法动作、费用和自身状态，但没有加入旧模型未训练过的新增侦察字段。

导出工具核对所有动作编号、实体编号和槽位布局，替换当前静态卡牌定义，并记录原训练规则哈希和变更定义数。本次有 9 个定义不同。这是已有权重对新规则的推理适配，不代表模型已经学习这些规则修复。新训练检查点仍须遵守训练代码的严格版本检查。

Python 和 Node 对完整动作及实体定义计算相同的 SHA-256。定义不匹配时拒绝推理，不会把错位的动作编号应用到游戏。

## 导出和运行

在项目根目录生成对应在线输入的元数据：

```sh
node --import tsx --input-type=module -e 'import {runtimeSchema} from "./server/neural.ts"; import {writeFileSync} from "node:fs"; writeFileSync("/tmp/tavern-serving-schema.json", runtimeSchema)'
.venv/bin/python scripts/export-inference.py PATH_TO_TRUSTED_CHECKPOINT /tmp/tavern-serving-schema.json rl/runs/inference-780/model.pt
PYTHONPATH=rl/python .venv/bin/python -m tavern_rl.serve rl/runs/inference-780/model.pt --port 8790
TAVERN_INFERENCE_URL=http://127.0.0.1:8790 npm run dev:server
```

训练检查点只在导出步骤按可信文件加载。推理文件仅包含权重、模型定义和部署元数据，约 6 MB；不包含优化器或历史对手。服务端使用 `weights_only=True` 加载。

服务器环境是 Python 3.13.5、PyTorch 2.14.0+cpu、NumPy 2.5.2。服务配置见 `deploy/tavern-inference.service`，CPU 限额为一个逻辑核的 80%，内存上限 512 MiB，端口只监听回环地址。CPU 推理不需要 CUDA，不消耗游戏服务器的公网出站带宽。

## 房间行为和故障处理

全局队列轮流处理各房间、各人机的一步操作，每个操作异步等待模型。每个座位有独立 GRU 状态和上一步动作；跨回合保留，离开房间后随座位对象回收。服务重启后隐藏状态从零开始。

推理超时为 5 秒。模型不可用或响应无效时，本轮回退到脚本人机，清空对应隐藏状态，10 秒后允许重试。`/tavern-api/health` 中的 `ai` 包含实际应用的模型决策数、错误数、回退回合数和模式。回退不会被计为模型决策。

响应返回后重新检查房间、阶段、回合和座位修订号，丢弃过期响应。共享卡池变化引起的操作失败会重新观察和预测。每回合按训练配置限制到 64 次普通操作；强制选择有额外保护上限。计时对局到期仍由原房间规则处理。

## 验证和回滚

```sh
npm run test:server
npm run test:rl
node --import tsx scripts/benchmark-inference.ts http://127.0.0.1:8790 8 3
```

基准测试创建内存中的独立房间，八个座位全部由模型决策，不写入公开房间或线上存档。参数依次是推理地址、回合数、房间数。

线上后端发布目录保留 `rollback.json` 和 `previous.service`。回滚时恢复后端旧软链接及旧 unit，然后重启 `bobs-tavern`；推理服务可以单独停止。网站资源和 SECTOR 服务独立部署。没有推理进程时，也可以通过移除 `TAVERN_INFERENCE_URL` 后重启来恢复脚本人机。
