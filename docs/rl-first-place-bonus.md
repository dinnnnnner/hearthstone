# 第一名额外奖励

原始终局排名分为 `(4.5 - 名次) / 3.5`，第一名 +1，第八名 −1，每相邻名次相差约 0.286。
用户要求鼓励第一名，因此在 PPO 的第一名终局回报上额外加 +1。

| 名次 | PPO 排名奖励 |
|---|---:|
| 1 | +2 |
| 2 | +0.714286 |
| 3 | +0.428571 |
| 4 | +0.142857 |
| 5 | −0.142857 |
| 6 | −0.428571 |
| 7 | −0.714286 |
| 8 | −1 |

原有回合结束剩余铸币惩罚继续使用每枚 −0.01，累计扣除。
第一名奖励与该惩罚在训练轨迹中合并。游戏名次、公开比分、评估结果及观察契约不变。
第一名比第二名多约 1.286，而其他相邻名次仍相差约 0.286，更强调争冠；这不保证实际胜率提高。

`placement_rewards.py` 负责回报计算和参数校验。
`scripts/enable-first-place-bonus.py` 向指定的冻结训练运行目录加入 `--first-place-bonus`，保存原文件及前后 SHA-256。
参数未指定时沿用检查点的 `config.first_place_bonus`，旧检查点默认 0。
本次服务器恢复协调器显式为每个训练进程传入 1，并写入后续检查点和训练日志。

该补丁用于服务器已有的铸币惩罚运行版本，要求原文本匹配后才修改，避免覆盖其他代码。
对应文件位于训练服务器 `/root/autodl-tmp/tavern-mixed-popular-20260914/rl/python/tavern_rl`，
协调器是 `/root/tavern-human-current-06cd2177/population_resume.py`。
原文件保存在 `/root/tavern-repeat-live-20260914/bonus-backup`。

测试覆盖奖励排序、旧检查点默认值、恢复与显式覆盖、铸币惩罚叠加、游戏原始奖励与评估结果保持不变。

```bash
PYTHONPATH=rl/python .venv/bin/python -m unittest discover -s rl/tests -p test_first_place_bonus.py
```
