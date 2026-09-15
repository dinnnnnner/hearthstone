# 从主播录像自动提取操作

程序参考 t3code 的调用方式，启动本机 `codex app-server`，通过 stdio JSON-RPC
使用 Codex 已有登录。默认模型是 `gpt-5.6-luna`，推理强度固定 `max`。
启动时通过 `model/list` 检查模型、推理档位和图像能力，不会自动降级。
没有人工校验步骤，也不需要在 Web 游戏内录制玩家操作。

目前完成视频抽帧、模型标注、自动筛选和动作词表转换。产物是带缺失字段的
视频示范数据。现有 64/256/1024 层模型读取结构化实体，而视频提供的是部分可见状态。
还需要实体输入适配及行为克隆训练器，不能把这些 JSONL 直接传给 `train.py`。
脚本不会修改已有 checkpoint、运行中的 PPO 任务或公网人机。

## 加速模式

新增本地画面变化筛选、直播画面裁剪和只识别操作的模式。Luna 仍使用 `max`，
没有降低推理档位，也没有加入人工校验。

先生成处理计划，不调用模型：

```bash
TAVERN_RL_PYTHON=python3 bash rl/run.sh video_extract \
  --video rl/runs/video-demonstrations-20260911/source/BV17RYL64Ewv_p2.mp4 \
  --source-url 'https://www.bilibili.com/video/BV17RYL64Ewv?p=2' \
  --duration 420 --layout kimmy --width 1200 \
  --selection changes --annotation-mode actions \
  --out rl/runs/video-fast-p2 --plan-only
```

移除 `--plan-only` 后开始识别，仍默认最多处理 4 个新片段；重复运行继续处理。
`--layout kimmy` 只适用于本次下载录像的画面布局，裁剪掉摄像头和主要侧边插件。
它不是自动识别任何主播布局。其他录像默认用 `--layout full`，避免裁掉卡牌或操作区域。
裁剪后不放大图像；帧元数据保存原视频裁剪区域和 `partial_view=true`。

`--selection changes` 在 CPU 上比较酒馆、场上、手牌、金币和各按钮区域。
原始连续采样窗口没有足够变化就跳过；有变化时保留变化前后的连续帧，
不会把相隔很远的帧拼成一个连续操作。灰度缩略图逐帧处理，不把全部解码图像同时载入内存。
`plan.json` 记录原始/计划请求数、图片数、时间窗口和本地耗时。筛选结果会缓存。
`--change-threshold` 默认 0.06；调高会更容易漏掉细小操作。
`--audit-every 5` 可额外送检每第 5 个安静窗口，用来排查筛选是否漏掉操作。
完全没有候选窗口时不启动 Codex，也不要求登录。

`--annotation-mode actions` 只标记人类动作及前后帧，跳过整场状态抄录。
输出中的英雄、金币、卡牌列表等状态字段明确标为未识别，不能假装是空场或零金币。
它适合先建立图像与动作对应的数据。需要部分结构化状态时继续用 `--annotation-mode state`。

当前筛选器判断的是画面变化，**还不能可靠区分战斗阶段与招募阶段，也不负责 OCR 或卡图匹配**。
发光、动画、切换抉择面板仍可能产生候选；模型及后处理继续剔除不确定操作。
请求数量或输入像素下降不等于模型耗时按同比例下降，动作召回率仍需测量。

实现使用 [FFmpeg 的裁剪和采样过滤器](https://ffmpeg.org/ffmpeg-filters.html)，Python 端无需额外图像库。

2026-09-12 [加速实测记录](rl-video-speed-validation-20260912.json)：

- 7 分钟录像本地预处理约 14.7 秒，计划请求从 56 次降到 51 次，图片输入从 895 张降到 718 张。
- 合并裁剪效果，计划输入像素减少约 54.5%。这不是 token 费用或模型耗时的等比例预测。
- 同一打出随从片段，原完整状态模式 3 帧约 328 秒。操作模式 6 帧约 35.5 秒，并通过自动筛选。
- 操作模式首次 3 帧请求约 45 秒，但模型不确认连续性，样本被剔除；加密采样后才得到有效标签。
- 20 项自动测试通过。测试窗口仍包含已知 100.5–101.5 秒的操作；未测量全视频的动作召回率。

两个模式输出的信息量不同，上述单次耗时也受服务端负载影响，不能当作固定的整局加速倍数。
对快速动作可单独使用 `--fps 5 --frames-per-chunk 6`，以更密的连续画面确认操作，
不要通过降低置信度或跳过连续性检查来增加样本。

## 依赖与调用

需要 Python 3.10+、FFmpeg 和已登录的 Codex CLI。Python 部分只用标准库，不需要 GPU。
使用 `codex login` 登录；CLI 不在 PATH 时设置 `TAVERN_CODEX_BIN`，也可传 `--codex-bin`。
程序也会检查 `~/.npm-global/bin/codex`。不读取、复制或在项目里保存登录令牌。
模型调用使用该 Codex 登录的额度。

下载可公开访问的录像片段，例如：

```bash
uv tool run --from yt-dlp yt-dlp --no-playlist \
  --download-sections '*0-420' \
  -f 'bestvideo[height<=1080]/best[height<=1080]' --write-info-json \
  -o 'rl/runs/videos/%(id)s.%(ext)s' \
  'https://www.bilibili.com/video/BV17RYL64Ewv?p=2'
```

识别 24 秒招募画面：

```bash
TAVERN_RL_PYTHON=python3 bash rl/run.sh video_extract \
  --video rl/runs/videos/BV17RYL64Ewv_p2.mp4 \
  --source-url 'https://www.bilibili.com/video/BV17RYL64Ewv?p=2' \
  --start 78 --duration 24 \
  --out rl/runs/video-p2-recruit \
  --fps 2 --frames-per-chunk 16 --max-chunks 4
```

默认每次最多调用 4 个新片段，每片段最多重试 1 次，每次超时 600 秒。
`--prepare-only` 只抽帧，不调用模型。提高 `--max-chunks` 可继续处理长录像。
重复运行同一命令会复用成功的片段，模型、提示词、视频、帧内容改变后不复用旧结果。
同一输出目录不允许同时运行两个进程。更换抽帧配置或视频请使用新目录。
失败请求可能已经消耗模型额度；只有完整落盘的响应才能断点复用。

`--source-offset` 是本地文件第一帧在原始录像中的秒数。若下载从原视频第 600 秒开始，
传 `--source-offset 600`。时间戳来自 FFmpeg 选中帧的 PTS，转换为从首个解码帧起算的时间，
再加 source offset，不按固定帧率猜算。下载切片是否精确到目标秒数取决于下载/转码方式，
需使用实际切片起点。默认 `--patch unknown`，上传日期不证明录像规则版本。

## 输出

- `frames.json`：原始视频 SHA256、来源 URL、采样参数、每帧时间和文件哈希。
- `provider.json`：CLI 版本、模型能力和选择的推理档位，不含登录凭据。
- `raw/*.json`：每个片段的原始回复、提示词、帧列表、模型、thread/turn ID。
- `demonstrations.jsonl`：通过自动筛选的部分状态及操作。
- `rejected.jsonl`：不确定、跨剪辑、多动作、前置状态缺失或时间区间重叠的结果。
- `failures.json`：请求错误；`report.json`：本次汇总；`codex.stderr.log`：CLI 诊断。

相邻片段共享一个边界帧，以覆盖边界两侧。没有重叠的动作区间，不会按卡名删除
连续购买同一种牌的合法操作。快速操作仍可能落在采样间隙里；可提高 `--fps`，
代价是更多模型请求。置信度来自模型自报，自动过滤不能证明识别正确率。

状态只允许使用动作前画面及更早信息。动作标注可看后帧，但后帧单独保存为证据。
空卡片数组不证明区域为空；看不清的字段为 null。英雄及当前技能分别记录，
包括芬利换技能的情况；当前版本不会跨片段猜测未显示的技能。

## 转换到冻结模型的动作词表

从要训练的 checkpoint 导出其 `meta` JSON，以该文件中的 `actions` 为准。
名字表格式为 `{"cards":[{"id":"...","name":"..."}],"heroes":[...]}`。
这两份文件均应记录来源，不能用不兼容的动作表替换冻结训练版本。

在源码仓库中导出名字表，不需要重建 RL bridge：

```bash
mkdir -p rl/runs/video-catalog
node --import tsx scripts/export-video-catalog.ts > rl/runs/video-catalog/names.json
```

从自己的 checkpoint 导出元数据，例如：

```bash
.venv/bin/python - <<'PY'
import json
from pathlib import Path
import torch
checkpoint = torch.load('rl/runs/inference-deep64-680/checkpoint.pt',
                        map_location='cpu', weights_only=False)
Path('rl/runs/video-catalog/model-meta.json').write_text(
    json.dumps(checkpoint['meta'], ensure_ascii=False))
PY
```

```bash
TAVERN_RL_PYTHON=python3 bash rl/run.sh video_dataset \
  --input rl/runs/video-p2-recruit/demonstrations.jsonl \
  --meta rl/runs/video-demonstrations-20260911/model-meta.json \
  --catalog rl/runs/video-demonstrations-20260911/names.json \
  --out rl/runs/video-p2-recruit/bc-labels.jsonl
```

转换结果的 `policy_input` 只含动作前图像和部分状态；`labeling_evidence` 存后帧。
训练数据加载器必须只从 `policy_input` 取输入，避免未来信息泄漏。
已确定的动作映射单个 ID；缺少目标/位置时保留 `candidate_action_ids`。
模型只报告目标区域而没有槽位时，同时保留无目标动作，避免把随从落点误当成战吼目标。
这些候选表示标签的不确定性，**不是合法动作掩码**。同名多 ID 也保留候选，不随意选一个。

也可在 `video_extract` 命令中同时传 `--action-meta` 和 `--catalog`，提取结束后自动生成
`bc-labels.jsonl`，不必单独运行转换命令。

`ppo_ready=false`、`entity_policy_ready=false`、`patch_compatibility_verified=false`
明确表示没有完成模拟器状态恢复和规则兼容验证。数据没有捏造奖励、隐藏卡池、
随机种子或旧策略概率。下一步是适配部分状态的行为克隆，在独立 checkpoint 上训练，
按完整对局划分训练/验证集，再用自博弈评估收益。

## 参考

2026-09-11 的实测和限制见 [验证记录](rl-video-extraction-validation-20260911.json)。
实际调用 Luna Max，从第 2 局 100.5–101.5 秒的 3 帧识别出一次打出随从操作，
并自动导出动作候选标签。该请求耗时约 328 秒；重跑新增模型调用为 0。
较长片段有 3 次请求触及本次测试的 300 秒超时。12 项自动测试通过。
这只是一个实际操作样本，不能据此判断整体标注准确率，也没有进行棋力训练。

- [t3code Codex provider 源码](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Layers/CodexProvider.ts)
- [官方 Codex app-server 协议](https://learn.chatgpt.com/docs/app-server)
- [官方 Luna 模型说明](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

此处根据协议独立实现，没有复制 t3code 源码。尚未确认用户所指 luna-bot 的具体仓库。
