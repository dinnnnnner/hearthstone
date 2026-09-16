# 训练巡检邮件

`scripts/mail-training.py` 独立读取指定训练任务的 `health/latest.json`，使用带证书验证的 SMTP SSL 发送邮件，不改变训练或原有巡检进程。每个新巡检快照发送一次；`mode: "alerts"` 则仅发送异常和结束结果。任务结束后通知进程退出。

配置文件示例，放在 Git 仓库外：

```json
{
  "sender": "your-address@qq.com",
  "recipient": "your-address@qq.com",
  "host": "smtp.qq.com",
  "port": 465,
  "passwordFile": "/root/tavern-ops/qq-smtp-auth",
  "job": "/root/tavern-ops/YOUR-JOB/resume.json",
  "output": "/root/tavern-ops/YOUR-JOB/email",
  "mode": "all"
}
```

QQ 邮箱需要先开启 SMTP 并生成授权码。授权码存入 `passwordFile` 指定的文件，权限设为 `600`。程序不输出授权码，也不输出可能包含认证信息的 SMTP 异常原文。

```bash
# 预览当前快照对应的邮件，不联网发信。
python3 scripts/mail-training.py --config /path/to/config.json --preview
# 发送当前快照，随后退出。
python3 scripts/mail-training.py --config /path/to/config.json --once
# 持续检查新快照；需由后台进程或服务管理器运行。
python3 scripts/mail-training.py --config /path/to/config.json
```

成功提交给 SMTP 服务器后，`output/state.json` 保存已发送快照标识，重启时据此去重。失败时保留原状态并重试。SMTP 接收不等于最终投递到收件箱；提交结果不明或提交后进程异常退出时仍可能重发。

邮件内容包括巡检时间、截止时间、三个模型已保存的累计局数、CPU 配额利用率、GPU 瞬时读数及异常。该程序转发既有巡检结果，不承担对巡检进程本身的独立监控。

2026-09-15 的 13 小时任务已完成 SMTP 授权并启用邮件通知。首次配置时使用的交互式脚本为：

```bash
/root/miniconda3/bin/python /root/tavern-ops/20260915-selfplay-13h/email/enable-email.py
```

脚本隐藏授权码输入，先发送当前快照，再启动后台转发。配置及邮件状态位于本次任务的 `email/` 目录。

2026-09-16 的 4 小时续训已复用服务器上的授权码，通知目录为 `/root/tavern-ops/20260915T235413-publish-4h/email/`。每个五分钟巡检快照发送一封邮件，训练结束后发送最后一次结果并退出。当前训练任务可从 `/root/tavern-ops/current-training.json` 查询，无需再次执行旧任务的启用脚本。

10:03 重启后，邮件与五分钟巡检已改绑直接搜索任务 `/root/tavern-ops/20260916-gold-sales/`。首封巡检邮件于北京时间 10:03:58 获 SMTP 接受，继续使用原授权文件。

11:25 改绑持续对局任务 `/root/tavern-ops/20260916-streaming/`，首封巡检邮件于11:25:28获SMTP接受。原任务的巡检和邮件进程已停止，新任务每五分钟检查，截止时间仍为12:23:05。

11:53 改绑逐牌估值续训 `/root/tavern-ops/20260916-card-value/`，首封邮件于11:53:14获SMTP接受，沿用五分钟间隔及原截止时间。

12:11 改绑统一动作估值训练 `/root/tavern-ops/20260916-action-value/`，首封邮件于12:11:17获SMTP接受，沿用五分钟间隔及12:23:05截止时间。

12:24再续训4小时，通知改绑 `/root/tavern-ops/20260916-action-value-4h/`，截止时间同步为北京时间16:24:41。

13:23 改绑场面评估续训 `/root/tavern-ops/20260916-scene-value/`，首封邮件于13:23:28获SMTP接受。仍每五分钟巡检，截止时间为16:24:41。

13:50 改绑多时间尺度续训 `/root/tavern-ops/20260916-multi-horizon/`，首封邮件于13:50:42获SMTP接受，沿用五分钟间隔和16:24:41截止时间。
