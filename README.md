# 鲍勃的酒馆

酒馆战棋单人练习 Web 应用，使用 React、TypeScript 和 Vite。默认进入第 14 赛季练习模式，数据锁定 36.4.2 / build 251332，核对日期为 2026 年 9 月 8 日。可在新对局中切换经典精选模式。

## 已部署入口

- 游戏大厅：https://8.153.150.101/
- SECTOR：https://8.153.150.101/sector/
- 酒馆：https://8.153.150.101/tavern/

主页和酒馆由同一个 Nginx 提供静态文件。SECTOR 的进程及 `/ws`、`/api/`、原资源路径保持原有路由。线上酒馆可点击顶部“返回游戏大厅”；SECTOR 左侧标志也可返回主页。

部署配置、发布与回滚方法见 [deploy/README.md](deploy/README.md)。

## 运行

```bash
npm install
npm run dev -- --port 5174
```

打开 http://localhost:5174。进度自动保存到当前浏览器，支持手机、拖动招募与站位调整、战斗回放。

```bash
npm test          # 规则场景与有限牌池守恒测试
npm run build     # TypeScript 检查与生产构建
npm run test:e2e  # 启动开发服务后运行浏览器测试
```

浏览器测试默认连接 5174，可通过 `TEST_BASE_URL` 修改。首次运行可能需要 `npx playwright install chromium`。

## 实战棋盘与手机操作

默认使用木质棋盘，酒馆随从和双方战场显示为椭圆棋子。招募与战斗在同一场景进行，包含攻击位移、伤害数字、圣盾破碎、召唤、增益和三连反馈。战斗支持暂停、0.75 / 1 / 2 倍速及跳过，音效可以关闭。

- 酒馆随从拖到手牌区购买，也可双击购买。
- 手牌拖上战场打出；有目标的法术可以直接拖到适用的随从上。
- 场上随从拖动调整站位，拖向鲍勃出售。
- 点选棋子或手牌可查看技能，使用招募、打出、发动、出售及左右移动按钮。
- 黑暗发现位于棋盘右上方，饰品位于英雄左侧，英雄技能位于右侧。

支持手机横竖屏。手牌横向滑动浏览，向上拖动出牌；也可完全用点选操作。顶部全屏按钮在浏览器支持时进入全屏。设置中关闭“实战棋盘”即可回到旧版面板，再选择标准或手游布局。切换布局不会清除对局存档。

表现层使用 React、原生 SVG、Web Animations API 与按需运行的 Canvas 粒子。未增加服务端游戏进程或引擎依赖，棋盘沿用本地卡牌原画。参考片段、实现取舍与验证记录见 [docs/gameplay-presentation.md](docs/gameplay-presentation.md)。

## 当前赛季实现范围

| 内容 | 已接入 |
| --- | --- |
| 随从图鉴 | 234 种当前补丁单人模式 1 至 6 星随从 |
| 可玩随从 | 114 种，使用各自的普通与金色数值及技能 |
| 酒馆法术 | 图鉴 67 种，其中 32 种可购买和施放 |
| 英雄 | 11 名，采用当前技能费用、生命值和护甲 |
| 黑暗之赐 | 21 种已实现效果，使用第 3 回合起的发现及星级规则 |
| 饰品 | 23 种已实现效果，第 6、9 回合分别选取小型、大型饰品 |

购买、刷新、冻结、出售、升级、手牌上限、战场上限、有限随从池与三连已接通。三连合并增益、关键词及磁力材料，打出金色随从后领取高一星的发现奖励。

技能引擎支持战吼、亡语、进击、发动、塑造法术、磁力、复生、烈毒、圣盾、嘲讽、风怒、顺劈、回合增益及若干种族成长机制。英雄包括巫妖王、乔治、帕奇维克、疯狂金字塔、米尔菲丝、诺兹多姆、欧穆、奥拉基尔、霍格、霍利戴医生和萨维斯。

每局随机开放五个随从类型。随从按剩余份数加权抽取，AI、酒馆、手牌、战场、磁力材料及发现候选共同占用随从池；刷新、出售和未选择的发现候选归还牌池。

| 星级 | 每种随从份数 | 酒馆随从栏位 | 初始升星费用 |
| --- | --- | --- | --- |
| 1 | 15 | 3 | 5 |
| 2 | 15 | 4 | 7 |
| 3 | 13 | 4 | 8 |
| 4 | 11 | 5 | 9 |
| 5 | 9 | 5 | 10 |
| 6 | 7 | 6 | 已满级 |

酒馆法术独立提供一个栏位，按各星级 5、7、9、11、7、5 的每种份数加权。法术获取后即归还池中，因此不占用玩家持有的随从份数。战斗伤害先扣护甲，并采用前 3 回合 5 点、第 4 至 7 回合 10 点、之后 15 点的伤害上限，进入前四后解除。

这是当前赛季的部分复刻。未实现的随从和法术只展示图鉴，不加入招募池。完整饰品候选权重及限制尚未复刻，当前只从上述已实现饰品中选取。保险箱、鱼饵及其相关复杂卡牌未接入；不包含双打和网络匹配。

七名 AI 从共享池招募，按回合提升等级，轮流与玩家交战。它们尚无完整经济决策、三连、英雄技能和互相交战流程。复杂战斗触发采用本项目的事件处理逻辑，不能将模拟结果等同于官方客户端结果。经典精选模式保留最初 32 种历史随从及 8 名历史英雄规则。

## 网上卡面素材

已按真实卡牌 ID 从 [HearthstoneJSON 插画服务](https://hearthstonejson.com/) 下载素材，运行时读取本地文件。当前赛季的 507 个随从、法术、英雄、黑暗之赐与新饰品 ID 均有原始插画；此外下载了衍生牌与经典模式插画。

192 张中文完整卡面保存在 `public/cards`。部分卡没有中文渲染，界面会使用 `public/art` 中的真实原画搭配锁定补丁的中文数据排版。点击卡牌详情中的“查看网上卡面与素材来源”可查看原始素材和来源链接。素材站的完整卡面使用 latest 路径，可能与锁定补丁不同，游戏结算始终采用快照数值。

美术与商标属于原权利人。本项目为非官方练习作品。

## 更新与文件

```bash
python3 scripts/sync-season.py           # 下载锁定 build 并生成中文快照及 SHA-256
python3 scripts/download-season-art.py   # 下载原画和可用的中文完整卡面
```

- `src/season/snapshot.json`：版本固定的原始数据，不等于全部技能均已实现。
- `src/season/catalog.ts`：当前赛季可玩卡牌与技能声明。
- `src/season/engine.ts`：当前赛季招募、技能、发现、饰品与战斗结算。
- `src/season/Panels.tsx`：赛季操作区、法术栏、饰品及卡面来源。
- `src/table/`：独立棋盘、手势、战斗动画、粒子与音效。
- `src/data.ts`、`src/engine.ts`：共享类型与经典规则。
- `src/App.tsx`、`src/styles.css`：界面、交互、回放及浏览器保存。
- `docs/season-provenance.json`：数据来源、build 和哈希。
- `docs/art-manifest.json`：素材请求及源站缺失记录。
- `src/season/engine.test.ts`、`src/engine.test.ts`、`tests`：规则与浏览器验证。

## 版本参考

- [暴雪第 14 赛季公告](https://hearthstone.blizzard.com/en-us/news/24290433/announcing-battlegrounds-season-14-dark-gifts-of-dalaran)
- [暴雪 36.4.2 补丁说明](https://hearthstone.blizzard.com/en-us/news/24296231/3642-patch-notes)
- [开发者说明：黑暗之赐的提供规则](https://us.forums.blizzard.com/en/hearthstone/t/battlegrounds-developer-insight-dark-gifts/163606)
- [HearthstoneJSON build 251332 中文数据](https://api.hearthstonejson.com/v1/251332/zhCN/cards.json)
- [暴雪酒馆战棋基础规则介绍](https://hearthstone.blizzard.com/en-gb/news/23156373/introducing-hearthstone-battlegrounds)

## 版本基线与 AI / RL

当前 Demo 已保存为 Git 标签 `baseline-demo-2026-09-08`。恢复方法见 [版本基线](docs/checkpoints/baseline-demo-2026-09-08.md)，后续强化学习接口与模拟器差异见 [AI / RL 记录](docs/rl-roadmap.md)。
