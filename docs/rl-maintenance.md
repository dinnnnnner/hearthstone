# 训练后的自动清理

`tavern_rl.maintenance` 每分钟检查项目的群体训练目录。
训练结束、截止或异常退出后，只有监督进程和学习进程都不存在，且所有训练锁均可获取时，才会清理。
监督进程被强制终止、状态未及时更新的目录也遵循相同的进程与锁检查。
它不终止训练进程，也不会调用全系统 `drop_caches`。

清理内容：

- 对字节完全相同的 `.pt` 检查点做完整 SHA-256 校验，在同一文件系统内合并为硬链接。保留所有原路径。
- 删除已停止任务中未完成的 `*.pt.next` 临时文件。
- 用 `POSIX_FADV_DONTNEED` 建议内核释放这些已读完检查点的干净文件缓存，文件内容不变。

完整续训模型、独有历史模型、最佳模型、人类数据、视频、回放、指标和日志均保留。
硬链接要求训练器像当前实现一样通过临时文件加原子替换保存模型，不能原地改写共享文件。
此策略不会无限制保留重复占用，但独有模型仍会随训练次数增长；需要进一步压缩时，应另行确定归档或历史保留策略。
文件缓存、进程内存和显存是不同的资源；正在运行的模型权重和优化器不能靠清缓存释放。

## 使用

预览具体目录：

```bash
bash rl/run.sh maintenance --run rl/runs/population --report-dir rl/maintenance-reports
```

持续清理服务器上符合项目布局的训练目录：

```bash
bash rl/run.sh maintenance --base /root --base /root/autodl-tmp \
  --report-dir /root/tavern-maintenance/reports --watch --interval 60 --apply
```

自动发现仅检查 `tavern*/rl/runs/**/status.json` 下有 `members` 的群体任务。
单模型脚本、人类数据训练等其他布局不会被猜测为可清理任务。
同一个报告目录只能启动一个维护进程。哈希缓存在内存中按 inode、大小和变更时间复用，
不会每分钟重新读完所有检查点；进程重启后首次扫描需要重新计算哈希。
`latest.json` 记录最新状态，有实际文件操作时另留审计记录，最多保留 100 份维护审计。
文件系统可用空间可能同时受其他正在运行的任务影响，不能把全部变化都归因于清理。

## 当前训练服务器

独立的 Supervisor 配置位于 `/root/tavern-maintenance/supervisord.conf`，只管理维护进程。
它不依赖 SSH 会话，维护进程异常退出时会自动重启，日志自动轮转。
实例重启后执行 `/root/tavern-maintenance/start.sh` 即可恢复维护服务。
当前还通过 `--run /root/tavern-four-hour-20260914/population` 显式纳入正在运行的四小时任务；
该目录使用同样的状态和训练锁，运行期间跳过，结束后再清理。
首次扫描清理记录见 [rl-maintenance-deployment-20260914.json](rl-maintenance-deployment-20260914.json)。
