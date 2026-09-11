# 旧录像采样记录

这套录像切片已停用。用户两次反馈声音不对后，当前版本改用独立音效文件重做全部 26 项操作，并删除电子合成代码。当前素材、组合及来源见 [clean-audio.json](clean-audio.json)，重建脚本为 `scripts/build-clean-audio.py`。该文件以下内容仅保留旧版处理记录，不代表当前线上行为。

# 录像音效采样

当前配置为 13 种录像切片：拿牌、购买、出牌、出售、刷新、冻结、升级、发现、开战、招募回合、攻击命中、死亡和三连。素材共约 830 KiB，44.1 kHz 单声道 PCM WAV。其余音效沿用合成版本。每条采样独立加载和解码，保持原始播放速率；未加载或下载失败时跳过该声音，不用合成音替代，也不补播旧操作。

2026-09-10 用户反馈音效不对：上述操作对应关系和听感尚未通过验收。此前的自动检查只能证明解码、播放与音量功能正常，不能证明切片选对或背景音被充分去除。购买切片来自购买法术，当前也用于购买随从；通用出牌、命中和死亡切片可能包含该随从特有的声音。切片不等同于原始游戏独立音效，仍需逐项试听核对。

## 来源与筛选

- 采用 [Reepeen 的 Hearthstone Battlegrounds Gameplay #34](https://www.youtube.com/watch?v=zlO0YpSqU64)，[IDC Games 的原视频索引](https://idcgames.com/nl/hearthstone/media/reepeen-hearthstone-battlegrounds-%28pc%29-gameplay-34-%28no-commentary%29-2026-03-20-12-17-8008)。无主播解说，游戏界面和酒馆台词为法语。
- 同时检查了 [lighting 的 2026-08-24 直播回放第一段](https://www.bilibili.com/video/BV1pyhA6ZEKe/?p=1) 的 04:00–08:00。游戏声相对人声过低，未收入最终采样。
- 对照录像逐帧标记操作，按波形细调切点。用 Whisper tiny 法语识别辅助查找台词区间，识别结果仅作辅助，不能证明短片段绝无人声。
- 每条采样的原视频秒数、背景参考区间和增益目标见 [audio-samples.json](audio-samples.json)。发布目录的 `audio/sources.json` 另记录成品时长、峰值及 SHA-256。

## 处理

对每个片段取邻近背景作为噪声参考，使用 1024 点 STFT、128 点步长做软频谱减法，并平滑频谱掩码。之后应用 75 Hz–11 kHz 带通，按不同操作归一化峰值，首尾分别做 3 ms 和 25 ms 淡入淡出。处理只针对短操作片段，不包含整段录像或完整音乐。

降噪能压低底乐和环境声，但混合音轨无法保证完全还原成游戏原始独立音轨。与台词重叠的三连和开战尾部已截短；尚未找到干净片段的破盾、解冻、英雄技能等继续使用合成音，未将它们标作实机采样。

## 重建

需要 Python、FFmpeg、yt-dlp、NumPy、SciPy 和 SoundFile。下载与分析文件放在仓库外。

```bash
mkdir -p /tmp/tavern-audio-reference
uv run --with yt-dlp yt-dlp --no-playlist -f 140 \
  -o '/tmp/tavern-audio-reference/reepeen-audio.%(ext)s' \
  'https://www.youtube.com/watch?v=zlO0YpSqU64'
uv run --with numpy --with scipy --with soundfile python scripts/sample-game-audio.py \
  --sources /tmp/tavern-audio-reference
```

脚本将成品写入 `public/audio/`，并在 `/tmp/tavern-audio-review/index.html` 生成原始切片与降噪成品的试听对照。对照采用相同增益，便于区分降噪和单纯降低音量的效果。

## 验证

`tests/sound.spec.ts` 在 Chromium 的真实 AudioContext 中检查每个音效的输出、13 条采样的解码与播放、静音时取消音源、素材缺失时不播放替代音，以及单条下载卡住时其他采样仍可原速播放。设置中的音量和静音仍保存在本地。这些检查不验证素材听感。
