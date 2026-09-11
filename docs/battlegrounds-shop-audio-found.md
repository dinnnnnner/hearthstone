# 酒馆操作原始音效素材

2026-09-10，从已安装的 `/mnt/d/Hearthstone` 只读提取。与之前仅按音频文件名搜索不同，本次沿战棋卡牌配置、特效状态机和 SoundDef 的引用追踪，确认这些操作复用了通用炉石音频。

已导出 19 个独立 WAV，保留原始时长、声道和增益。前 14 个用于购买、刷新和三连，后补冻结主音、3 个碎冰变体和出售金币声。试听页：`references/battlegrounds-shop-actions/index.html`；完整压缩包：同目录 `battlegrounds-shop-audio.zip`。接入配方见 [当前操作音效](battlegrounds-shop-audio-active.json)。

| 操作 | 原始文件 | 用途 |
| --- | --- | --- |
| 购买 | `Coin_Missile_Sound` | 金币飞行 |
| 购买 | `mana_crystal_refresh`、`CoinBag_Underlay_Play_2` | 金币命中阶段的两层声音 |
| 刷新 | `Minion_Summon_Minion_01` | 新随从出现 |
| 刷新 | `Minion_Drop_Basic_1` 至 `_5` | 随机落桌变体 |
| 三连 | `BG_StarMissile_1` | `Goldenize` 变金阶段 |
| 三连 | `Treasure_Cards_Appear` | 合成卡牌显现 |
| 三连 | `add_card_to_hand_1` 至 `_3` | 随机入手变体 |
| 冻结 | `Mage_FrostNovaCast_New` | 冻结按钮特效主音 |
| 出售 | `GadgetzanAuctioneer_card_spawn_coins_No_Delay` | 出售金币声 |
| 冻结外观解除 | `Shared_Frost_Impact_Small_1` 至 `_3` | 随机碎冰变体 |

## 引用证据

核心特效包为 `initial_base_global-64194cb9-prefab-0.unity3d`。

- 购买：`TB_BaconShop_DragBuy` 的 `m_SubSpellEffectDefs` 指向 `Bacon_Purchase_AE_CoinThrow_Super`。其购买动画的 `Coin Toss` 状态启用 AudioPlaythroughAction，子对象 `SFX_Coin` 指定 `Coin_Missile_Sound`。`Impact FX` 状态启用两个 AudioPlayClipAction，分别指向 `mana_crystal_refresh` 和 `CoinBag_Underlay_Play_2`。
- 刷新：`TB_BaconShop_8p_Reroll_Button` 的 `m_PlayEffectDef` 指向 `Bacon_MinionSwap_OverrideSpawnIn_Super`，其 `m_CustomSpawnSpell` 指向包含 `Bacon_MinionSwap_CustomSpawnIn` 状态机的组件。`Action Init` 指定随从出现声；`Action Impact` 指定五个落桌变体，使用 AudioPlayRandomClipAction。
- 三连：`Bacon_TripleMerge_Impact_MergeMinion` 的 `Goldenize` 状态启用 `BG_StarMissile_1`。同组件 `FX!` 状态里的音频动作被禁用，复刻时不能重复播放。`Bacon_TripleMerge_CustomSpawn` 的 `Get Side` 状态启用卡牌显现和入手声音。入手 SoundDef 的随机列表有三个变体。
- 冻结：`TB_BaconShopLockAll_Button` 的 `m_SubSpellEffectDefs` 指向 `Bacon_FreezeMinions_AE_Super`，其区域特效指向 `Bacon_FreezeMinions_AE_OpponentSide`。`Action 1` 状态启用的 AudioPlayClipAction 指向 `Mage_FrostNovaCast_New`。同状态另一个引用 `AE_Frost_Cast_01` 的随机音频动作被禁用，未将它列入生效素材。
- 碎冰：`Card_Play_Bacon_Ability_Frozen` 的 `Death` 状态启用 AudioPlaythroughAction，指定子对象 `SFX_Shatter`，其 SoundDef 等权随机选择三个 `Shared_Frost_Impact_Small` 文件。确认了冻结外观移除的配置；手动解冻与回合转换各自触发几次仍需结合运行时核对。

购买和刷新卡牌配置在 `carddef_base_global-48ae08f3-prefab-21.unity3d`。购买配置 GUID 为 `786906b7c23b4b50afaca06a8b9f77e6`；刷新配置 GUID 为 `c643db5ba4c04f709a20582fdcf91202`。

冻结按钮也在同一卡牌配置包，GUID 为 `da95b1038b1e4800a763087d9ad5268a`。冻结主音 SoundDef 位于 `essential_base_global-prefab-0.unity3d`，path ID 为 `7198322678668642453`。碎冰 SoundDef 位于 `initial_base_global-2ebe64b8-prefab-2.unity3d`，path ID 为 `5800018870951527884`。

这次确认了序列化配置引用和动作启用状态，并验证文件能解码、波形非零、时长与客户端元数据相符。没有录制客户端运行过程，也没有声称完整复现每层声音的动画时序、随机音高和音量。试听页播放独立文件，不把随机变体全部叠加。

完整素材 GUID、资源包哈希、WAV 哈希、SoundDef 和状态引用见 [battlegrounds-shop-audio-found.json](battlegrounds-shop-audio-found.json)。

```bash
.venv/bin/python scripts/extract-battlegrounds-shop-audio.py /mnt/d/Hearthstone
```

## 出售与其他操作

出售卡牌配置 `TB_BaconShop_DragSell` 指向 `Bacon_Sell_AE_CoinThrow_Super`。`Bacon_Sell_Impact_MinionAnim` 的 `Coin FX` 状态启用 AudioPlayClipAction，引用 `initial_base_global-ffbd77eb-prefab-11.unity3d` 中 path ID `-7764571626953304889`，对应 `GadgetzanAuctioneer_card_spawn_coins_No_Delay`。出售飞金币状态中的 AudioPlaythroughAction 被禁用，未叠加购买的飞行声。

也检查了升级按钮卡牌配置和已有资源索引，尚未确认完整的升级音效引用链，继续保留原版本。伙伴、任务、宝藏等素材已有参考文件，但当前对应玩法或触发条件不完整，未强行接入其他操作。

## 接入处理

购买、刷新和三连按当前网页动画组合，保留原文件声道和尾音，不加入合成音或录像背景声。刷新有 5 个落桌变体，三连有 3 个入手变体。多层声音整体平衡响度，再生成 44.1 kHz 双声道 PCM WAV。使用的音高参数在配方中明确记录；动画延迟按本项目实现调整，未宣称与客户端录音逐采样相同。

冻结、3 个解冻变体和出售直接复制原 WAV，通过播放增益平衡响度。每次操作只选一个可用变体，多个变体已加载时避免立即重复。未加载的文件不阻塞操作，也不补播旧操作。仍沿用原来的静音、音量、阶段切换和回放取消处理。

重建顺序：

```bash
.venv/bin/python scripts/build-clean-audio.py /tmp/hearthstone-general-sounds.zip
.venv/bin/python scripts/install-battlegrounds-audio.py
.venv/bin/python scripts/extract-battlegrounds-shop-audio.py /mnt/d/Hearthstone
.venv/bin/python scripts/install-battlegrounds-shop-audio.py
```
