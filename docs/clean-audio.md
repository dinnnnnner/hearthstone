# 独立素材音效重做

用户反馈录像采样的声音不对后，26 项交互统一改用炉石独立音效文件。删除了振荡器、白噪声合成与录像切片播放；加载失败时不补播或替换成其他声音。

素材来自 [The Sounds Resource 的 Hearthstone General Sound Effects](https://sounds.spriters-resource.com/pc_computer/hearthstone/asset/396767/)。这是炉石通用素材包，不是经核对的战棋完整操作音库。购买、出售、三连和破盾使用多条独立音效组合，其他操作分配单条素材。英雄技能和随从动作目前仍使用通用声音，没有按卡牌匹配台词。

购买采用金币翻转和卡牌移入，出售采用卡牌移出和金币落下；刷新采用洗牌，出牌采用 `play_card_from_hand_1`。冻结、解冻分别使用 FreezeEvent 的施法命中和状态结束。命中采用爪击，死亡采用卡牌消散。选中和倒计时音量比主要操作低。

处理只包含静音边界裁剪、混音、增益和首尾淡入淡出；无录像底乐降噪、随机变调或电子合成。素材以带 SHA-256 前缀的文件名发布，避免浏览器继续使用上一版缓存。每条素材独立下载、独立解码。

重建需要 NumPy、SciPy 和 SoundFile：

```bash
.venv/bin/python scripts/build-clean-audio.py /tmp/hearthstone-general-sounds.zip
```

逐项来源文件、源文件哈希、裁剪范围、混音参数和成品哈希保存在 [clean-audio.json](clean-audio.json)。输出为 44.1 kHz 单声道 PCM WAV，总计 2,769,940 字节。生成的 `/tavern/audio/listen.html` 可单独试听所有操作，不会自动播放或叠加多段声音。

浏览器测试检查 26 个实际音频输出、缺失及卡住请求、无振荡器调用、静音和音量持久化。波形检查验证峰值不超过 0.5，边界归零。上述检查验证播放与文件处理，不等同于听感验收，也不证明与战棋原版逐项一致。
