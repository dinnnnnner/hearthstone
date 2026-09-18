# 饰品实现范围

按用户要求提前启用 36.6.1 已公布内容，当前为 `36.6.1-preview`。官方计划于 2026 年 9 月 22 日上线，版本与卡池核对见[当前赛季说明](current-season.md)。

当前随机池包含 237 件饰品。饰品池由 `src/season/trinket-pool.json` 明确列出；新增、回归和移除清单保存在 `src/season/preview-pool.json`。

依据：

- [36.6.1 畸变怪及饰品公告](https://hearthstone.blizzard.com/en-us/news/24302091/aberrations-join-battlegrounds-at-blizzcon)
- [第 14 赛季饰品清单](https://us.forums.blizzard.com/en/hearthstone/t/battlegrounds-season-14-trinket-updates/163710)
- [36.2.2 调整和退池清单](https://hearthstone.blizzard.com/en-gb/news/24293284)
- [36.4.2 调整和退池清单](https://hearthstone.blizzard.com/en-gb/news/24296231)
- [开发者说明的出现条件与满手保护](https://us.forums.blizzard.com/en/hearthstone/t/battlegrounds-developer-insights-updated-trinket-rules/158955)
- 饰品数值、中文卡面与关联卡使用 [251952 中文数据](https://api.hearthstonejson.com/v1/251952/zhCN/cards.json)。卡图按原始卡牌 ID 下载；中文整卡图片使用 latest 接口，可能与固定数值版本不同。

实现包括购买、回合开始与结束、买卖、施法、召唤、攻击、亡语、复仇、合金、磁力、发现、英雄技能次数及饰品替换。新增弃牌事件、神明强化、配对法术、基利复制和第二英雄技能发现。满手时，饰品直接生成的牌进入等待队列，腾出空位后再进入手牌。等待中的牌仍计入公共牌池核对。饰品重复、进度和每回合上限分别按槽位记录。

饰品提供的特殊内容还包括等级 7 随从、暗月奖品、塑造法术和消耗为 2 的时空扭曲随从。普通刷新仍然只使用原有 1 至 6 星随从池。

## 尚未完成的部分

- **惊喜肖像**：已确认即时获取惊喜元素，以及存在多个隐藏随机事件，但未确认固定版本的完整触发条件和概率。没有采用猜测的“每回合 25%”实现，暂不加入随机池。
- **时空扭曲磊的伙伴链**：当前只接入馆长的混合体。其他英雄的伙伴体系尚未实现，因此烛台发现暂时不会向其他英雄提供时空扭曲磊。这是实现限制，不是官方出现规则。
- 官方没有公布完整的饰品权重。现有选择器实现公开的种族、价格、去重和专属条件，不能据此宣称抽取分布与官方完全一致。

`docs/rules-coverage.json` 记录数量和这些限制。接入事件表示可执行，不代表已经证明所有官方联动及结算顺序完全一致。

## AI 模型兼容性

`legacy-v3` 和 `scouting-v4` 保留扩展前的完整编号和规则快照，文件为 `server/neural-legacy-schema.json`，从提交 `ee7d6aee6343c4b5e8ccea225188ca44a350999d` 的 `server/neural-observation.ts` 导出。旧模型遇到新增身份会走已有的规则 AI 回退流程，观战模式会暂停并提示推理不可用。它们不能直接识别新增饰品。

新增卡牌的训练、示范记录与后续部署使用 `trinkets-v5`，其协议与当前训练环境一致。现有已发布模型需要重新训练或迁移后才能切换到这个协议，不能只改配置里的协议名称。此次没有修改线上模型配置或部署服务。

## 维护与验证

- `scripts/sync-trinket-dependencies.py` 从固定构建提取关联卡、七星池和种族标签；不会自行扩大饰品池。
- `scripts/download-season-art.py` 下载饰品与关联卡图片，`scripts/build-thumbnails.py` 生成游戏内缩略图。
- `src/season/trinkets.test.ts` 检查池中每件饰品的购买、发现、回合和战斗流程，并单独验证满手、合金、复制、替换、支付、回合限制与永久效果。断言公共牌池守恒。
- `npm test`、`npm run build` 与服务器测试用于检查已有玩法和客户端、服务端兼容性。
