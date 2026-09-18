# Rust 战斗模拟原型

独立实验，不接入网页、房间服务或训练进程。用于测量把战斗计算迁到 Rust 的可行性；尚不能替代完整 TS 规则引擎。

## 范围

支持攻击方选择、轮流攻击、攻击游标、嘲讽、圣盾、风怒、潜行、剧毒、一次性烈毒、复生、同时死亡、伤害上限及 180 轮保护。

只接受六种已经检查过的基础随从：复活的骑兵、吵吵模组、义肢假手、青铜守卫、爆裂飓风、致命的孢子。测试可以调整它们的属性、金色状态和关键词；复生会恢复对应卡牌的基础攻击力、原生关键词和 1 点生命值。

不支持亡语效果、召唤连锁、顺劈、光环、英雄技能、饰品、黑暗之赐、神明、招募与经济。未知卡牌、未知字段、未知关键词、非法属性及重复身份编号会报错。输入是专门的实验协议，不能直接传入正式对局状态，也不要把不支持的字段删掉后当作等价对局。

## 运行

在仓库根目录执行，需要 Rust/Cargo、Node、已安装的 npm 依赖和 Linux/Python 3.10+：

```sh
python3 experiments/rust-combat/check.py
```

脚本会运行 Rust 单元测试，编译 release 版本和 TS 对照程序，然后执行：

1. 33 个固定边界场景和 10,000 个固定种子生成的随机场景。
2. 调用真正的 `src/season/engine.ts::seasonCombat`，逐次比较攻击者、目标、死亡前后阵容、复生位置和身份编号、最终阵容、伤害、随机数状态与抽取次数。
3. 检查不支持的输入确实返回错误。
4. 从随机场景中取 256 个双方均非空的阵容，在同一个 CPU 核上交替运行 TS/Rust 各五轮，每轮 25,600 场战斗，预热五遍输入集合。

可调整规模：

```sh
python3 experiments/rust-combat/check.py --random-cases 20000 --bench-cases 512 --repetitions 100 --rounds 5
cargo test --locked --manifest-path experiments/rust-combat/Cargo.toml
cargo clippy --locked --manifest-path experiments/rust-combat/Cargo.toml --all-targets -- -D warnings
npx tsc -p experiments/rust-combat/tsconfig.json
```

输出在忽略提交的 `results/` 中：`cases.json`、`bench.json`、各轮原始数据和 `report.json`。对照失败会保存 `first-mismatch.json`，包含输入和双方结果，不会继续发布性能结论。

## 实现和测量口径

- `src/lib.rs` 是 Rust 核心，使用与 TS 相同的 Mulberry32 随机数算法和整数环绕规则。
- `src/main.rs` 是逐行 JSON 实验接口。`{"cases":[...]}` 返回逐步战斗结果；加入 `repetitions` 则运行关闭轨迹记录的微基准。
- `oracle.ts` 直接调用生产 TS 战斗函数，没有另写一套简化 TS 引擎。测试环境清空英雄技能、饰品、手牌、全局增益和神明。
- `check.py` 构建、对照和测量。每轮都核对战斗数以及伤害、胜负、随机数抽取次数的校验和。

双方都使用预先准备的输入。核心计时包含每场战斗内部的阵容复制，关闭动画帧记录；不包含进程启动、JSON 解码、初始局面准备、预热和 Python 通信。另报从启动到退出的进程耗时。

内存读取各进程 `/proc/self/status` 的 `VmHWM`，包括运行时、已准备的输入和计算内存，不是单局内存。`wait4` 的 RSS 可能包含启动父进程的历史高水位，所以只单独保留作核查，不用于结论。

## 如何解读结果

TS 路径仍运行完整生产事件分发框架，Rust 只实现上述基础子集。因此吞吐差异同时包含语言、数据结构、事件分发与功能范围差异，不能解释为 Rust 相对 TS 的通用加速倍率，更不能直接外推到完整训练。

这些测试验证与当前 TS 行为一致，不证明当前规则与官方客户端完全一致。没有测量 GPU 推理、优化器更新或完整自我对弈。

扩展顺序建议为死亡队列与召唤连锁、亡语、光环和饰品。每增加一种能力都应加入固定回放及随机对照。覆盖真实训练阵容后，再接入 Python 原生绑定测量整轮采样吞吐，决定是否全面迁移。
