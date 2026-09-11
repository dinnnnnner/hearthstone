# 酒馆战棋原始音效查找结果

2026-09-10 搜索网上资源后，在本机已安装的 `D:\Hearthstone` 找到了更直接的素材来源。资源位于 `/mnt/d/Hearthstone/Data/Win`，客户端 `globalgamemanagers` 和 `UnityPlayer.dll` 中均识别到 Unity `2022.3.62f2`。用 UnityPy 1.25.3 只读解析，没有修改客户端。

已扫描 114 个音频包，索引 10,685 个音频片段，导出 28 个战棋相关的独立 WAV。导出保留原始时长、声道和增益，没有录像背景音分离、混音或合成。全部文件能解码，有非零波形，时长与客户端元数据相符。

| 素材组 | 原始文件名示例 |
| --- | --- |
| 选英雄和英雄入位 | `BG_SelectHero`、`BG_HeroDescend`、`BG_HeroSocket` |
| 招募、开战提示 | `Recruit_Popup`、`Combat_Popup` |
| 招募、战斗阶段切换 | `CornerFlipTo_Recruit`、`CornerFlipTo_Combat` |
| 星星特效，各 3 种 | `BG_StarBurst_*`、`BG_StarMissile_*`、`BG_StarImpact_*` |
| 对手列表 | `BG_OppsFanOut`、`BG_OppsToLeft` |
| 最终名次结算 | `BGSPopup_Victory_1`、`BGSPopup_Victory_234`、`BGSPopup_Defeat_5678` |
| 鲜血宝石 | `BG20_GEM_BloodGem` |
| 宝藏、任务和伙伴 | `Bacon_Treasure_*`、`BaconFX_Quest_Choice_*`、`BG_BuddySystem_Burst` |

中文标签按文件名解释；尚未逐项核对运行时调用。特别是最终名次结算音不能当作每场小战斗的胜负音，宝藏特效也不能直接当作三连音。

首次查找时，购买、出售、刷新、冻结、升级和三连的原始声音及组合方式尚未确认。后续已沿客户端配置找到购买、刷新和三连的 14 段原始分层素材，见 [购买、刷新、三连素材说明](battlegrounds-shop-audio-found.md)。下文记录前一批 8 个音效的接入情况。

试听文件位于 `references/battlegrounds-original/index.html`，28 个 WAV 在同目录。目录已忽略，不随源码提交。可复现的逐文件来源、资源包及成品哈希见 [battlegrounds-audio-found.json](battlegrounds-audio-found.json)。

```bash
.venv/bin/python scripts/extract-battlegrounds-audio.py /mnt/d/Hearthstone \
  --output references/battlegrounds-original
```

网上确认的入口：

- [Wiki 音效分类](https://hearthstone.wiki.gg/wiki/Category:Soundspell_base_global-1)列出鲜血宝石及 Bacon Treasure 等独立文件，但本环境对文件页/API 的访问返回 403，没有据此宣称成功下载。
- [战棋随从页面](https://hearthstone.wiki.gg/wiki/Battlegrounds/Sun-Bacon_Relaxer)列出出场、攻击和死亡文件。
- [酒保页面](https://hearthstone.wiki.gg/wiki/Battlegrounds/Bulldog_Bob)按冻结、出售、升级等动作列出台词；这是酒保语音，不是操作特效音。
- [UnityPy](https://github.com/K0lb3/UnityPy)提供独立音频提取功能，本次使用该工具处理本机客户端资源。

## 已接入的声音

用户确认替换后，8 个原始文件用于选英雄、招募提示、开战提示、英雄受到星星打击、鲜血宝石，以及第一名、第二至四名、第五至八名的整局结算。映射和文件哈希见 [battlegrounds-audio-active.json](battlegrounds-audio-active.json)。普通战斗胜负仍用独立提示，不播放整局名次音效。其余未核对用途的素材保留为参考。

发布的 WAV 与提取文件逐字节相同，保留声道和时长；播放时通过增益节点平衡响度，选英雄跳过开头 0.532 秒静音。重建通用素材后需重新运行接入脚本：

```bash
.venv/bin/python scripts/build-clean-audio.py /tmp/hearthstone-general-sounds.zip
.venv/bin/python scripts/install-battlegrounds-audio.py
```
