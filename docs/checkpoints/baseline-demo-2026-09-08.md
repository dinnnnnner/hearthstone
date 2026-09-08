# 当前可玩基线

保存日期：2026-09-08。Git 标签：`baseline-demo-2026-09-08`。

这是用户要求保留的 Demo 版本。此版本在后续棋盘表现重做或 AI / RL 接入前冻结，不能视为完整官方模拟器。

## 包含内容

- 桌面布局、手游横竖屏模式、招募与战斗回放。
- 第 14 赛季 36.4.2 的固定数据、114 种可玩随从、32 种可买法术、11 名英雄。
- 有限随从池、三连、已实现的技能、黑暗发现与部分饰品。
- 经典精选规则、规则与浏览器测试。
- 本地卡牌插画及中文卡面，构建与素材来源脚本。
- 双游戏大厅、Nginx 配置、发布校验与回滚脚本。

线上入口：https://8.153.150.101/tavern/
线上固定发布：`/var/www/playroom/releases/20260908T033043Z`
源码独立备份：`/home/zich/hearthstone-checkpoints/baseline-demo-2026-09-08.bundle`
服务器发布备份：`/var/backups/playroom/baseline-demo-2026-09-08.tar.gz`

保存时确认 Nginx 和 SECTOR 服务正常运行，酒馆的活动发布仍为上述版本。此前通过 45 项规则测试及 3 项公网入口测试。视频对照和棋盘重做尚未实施。

## 恢复代码

在当前仓库创建一个独立工作目录，保留现有工作区：

```bash
git worktree add ../hearthstone-baseline baseline-demo-2026-09-08
```

如果原仓库丢失，可从独立备份恢复：

```bash
git clone /home/zich/hearthstone-checkpoints/baseline-demo-2026-09-08.bundle hearthstone-restored
cd hearthstone-restored
git switch --detach baseline-demo-2026-09-08
npm ci
npm run build:site
```

`node_modules`、构建缓存与浏览器测试临时文件不进源码快照。线上归档额外保留实际发布产物，不需要重新下载卡面。

浏览器中的个人对局进度保存在 localStorage，未包含在源码或服务器快照中。

## 后续开发

请从这个标签创建新分支，保留标签不动。AI / RL 的接口设计及已知模拟器限制见 `docs/rl-roadmap.md`。此标签不包含训练环境或训练好的模型。
