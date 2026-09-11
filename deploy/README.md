# 游戏大厅部署

当前站点为 https://8.153.150.101/，服务器通过 `root@100.121.69.44` 管理。

## 路由

| 路径 | 处理方式 |
| --- | --- |
| `/` | `deploy/home` 中的静态游戏大厅 |
| `/lobby/` | 大厅样式与 SVG 图标 |
| `/tavern/` | 酒馆生产构建，全部图片与脚本带此前缀 |
| `/tavern/thumbs/` | 320 像素 WebP 界面图片，缓存 7 天 |
| `/tavern-api/` | 反向代理到 `127.0.0.1:8787` 的游客和房间服务 |
| `/sector/` | 反向代理到 `127.0.0.1:5173/` |
| `/assets/`、`/ws`、`/api/` 等原路径 | 保持 SECTOR 原服务路由 |

HTTP 80 继续跳转到 HTTPS。原证书、ACME 验证目录及 SECTOR systemd 服务沿用原配置。大厅 HTML 不缓存；大厅资源缓存 1 天，酒馆原画缓存 7 天，带内容哈希的脚本和样式缓存 1 年。构建时预生成 gzip，降低服务器运行负担。新增 `bobs-tavern` Node 进程提供游客和房间功能，服务设置 384 MiB 内存上限，最多同时运行 6 个在线房间。

根路径现在是大厅。SECTOR 的左侧品牌链接原本指向 `/`，现在用于返回大厅。酒馆的本地保存键不变，相同浏览器和 HTTPS 来源下切换路径不丢失存档。

## 本地构建

```bash
npm ci
npm run build:site
python3 -m http.server 5180 --bind 127.0.0.1 --directory site-dist
```

`npm run dev` 仍在根路径提供独立开发版；`build:site` 生成 `/tavern/` 版本并把大厅与游戏打包到 `site-dist`。不需要在 2 GiB 的线上服务器执行 npm 构建。

```bash
SITE_BASE_URL=http://127.0.0.1:5180 npx playwright test tests/site.spec.ts
SITE_BASE_URL=https://8.153.150.101 CHECK_SECTOR=1 npx playwright test tests/site.spec.ts
```

第二条检查公网的两个入口、卡图、手游模式、存档返回与 SECTOR 的 WebSocket ping/pong。

## 上传及激活

每次发布使用新的时间戳目录，不覆盖正在服务的文件。以下为本项目这台服务器的配置，不能直接用于其他主机。

```bash
release_id=$(date -u +%Y%m%dT%H%M%SZ)
release_dir="/var/www/playroom/releases/$release_id"
ssh root@100.121.69.44 "mkdir -p '$release_dir'"
set -o pipefail
tar -C site-dist -cf - . | ssh root@100.121.69.44 "tar --no-same-owner -xf - -C '$release_dir'"
scp deploy/nginx.conf deploy/sector-proxy.conf "root@100.121.69.44:$release_dir/"
ssh root@100.121.69.44 "chmod 755 '$release_dir'; runuser -u www-data -- test -r '$release_dir/index.html'"
ssh root@100.121.69.44 "python3 - '$release_dir'" < scripts/activate-site.py
```

临时打包目录可能是 0700；tar 会保留目录权限，上传后必须确保发布根目录为 0755，并检查 Nginx 用户可以读取首页。否则切换后会返回 403。

激活脚本校验全部文件的 SHA-256，备份现有 Nginx 站点与当前目录链接，再原子切换 `/var/www/playroom/current`。只有 `nginx -t` 通过才 reload，随后检查 HTTPS 主页、两个游戏及各自 API；失败会自动恢复旧配置。它不重启 SECTOR，也不改防火墙或证书配置。

正在运行的 SECTOR 后续发布仍应通过 `/opt/sector/current` 更新，不要重新用旧版 `sector-public.conf` 覆盖 Nginx 站点，否则会删除大厅路由。更改域名或证书配置时同步维护本目录的 `nginx.conf`。

## 回滚

针对当前发布目录执行：

```bash
ssh root@100.121.69.44 'python3 - /var/www/playroom/releases/20260908T033043Z' < scripts/rollback-site.py
```

请将路径替换成需要撤销的当前发布。脚本读取该发布的 `rollback/state.json`，恢复激活前的站点配置及目录链接，再检查并 reload Nginx。首次发布回滚后，根路径恢复为原来的 SECTOR 页面。原发布文件保留。


## 房间服务部署与数据

当前服务器 Nginx 1.26.3 已启用 [HTTP/2](https://nginx.org/en/docs/http/ngx_http_v2_module.html)，浏览器将对局请求设为高优先级，其他玩家头像设为低优先级。界面图片使用 WebP 缩略图，共约 8.9 MB，相比原始 PNG 减少 93.4%。满房测试使用独立浏览器缓存，覆盖多人首次加载时的带宽竞争。

前端激活前先构建并启动房间服务。`npm run build:server` 生成独立的 `server-dist/server.cjs`，运行时不需要 `node_modules`。服务器使用 Node 20。

1. 将 `server.cjs` 和 `deploy/bobs-tavern.service` 上传到新的 `/opt/bobs-tavern/releases/<版本>/`。
2. 运行 `ssh root@100.121.69.44 'python3 - /opt/bobs-tavern/releases/<版本>' < scripts/activate-online.py`。
3. 按上文发布静态站点。新版激活脚本还会验证 `/tavern-api/health`。

房间服务使用独立的 `bobs-tavern` 系统用户，监听回环地址 8787。`/var/lib/bobs-tavern/state.json` 每秒检查变更，通过串行异步写入和原子替换保存，合并写入期间的新变更；正常停止时等待最终落盘。未变化的房间复用序列化缓存，游客最近在线时间每分钟触发保存。文件权限为 0600，包含游客令牌的哈希、房间和对局快照；不要放入静态站点、源码仓库或公开备份。浏览器只保存自己的随机游客令牌，不接收其他玩家的手牌与酒馆。

`systemctl status bobs-tavern` 查看状态，`journalctl -u bobs-tavern` 查看服务日志。服务重启会恢复游客和房间；突然断电会丢失尚未落盘的变更，范围取决于一秒检查周期和磁盘写入耗时。首次升级旧版存档会给已有房间补一次五分钟重连宽限期，避免旧版未保存空闲心跳造成误回收。发布脚本保存上一后端链接到新目录的 `rollback.json`，失败会恢复旧服务；后端成功但前端发布失败时，前端脚本会恢复原站点，可在排查后重新发布前端。

回滚在线版本时，先按后端 `rollback.json` 恢复 `/opt/bobs-tavern/current`，再重启 `bobs-tavern`，随后回滚对应静态站点。回滚到早期纯本地版本后没有在线大厅；确认不再需要在线房间时再停止该服务。独立数据目录保留，SECTOR 不需要重启。

为限制小服务器开销，等待房间和进行中的房间总数最多 24，同时进行最多 6 局；长战斗只发送前 179 个快照和最终快照，规则结算完整执行。对局最多 50 回合，届时按剩余生命与护甲排序，同值按座位顺序。全体真人连续离线 5 分钟后回收房间，自动推进回合不会延长宽限期；完成的房间空闲 10 分钟、其他房间空闲 2 小时也会回收。无房间的游客 30 天未访问后清理。

每位玩家的当前回放有独立 `battleId`。新版前端在请求头 `X-Tavern-Battle` 中携带已缓存的标识，匹配时响应省略帧内容；首次进入、刷新页面或标识不匹配时返回完整回放，旧前端仍能直接使用完整响应。客户端按 `gameVersion` 复用棋盘状态，倒计时组件独立更新。

公网在线测试：

```bash
TEST_BASE_URL=https://8.153.150.101 TAVERN_TEST_PATH=/tavern/ npx playwright test tests/online.spec.ts --workers=1
```

测试会创建独立游客和临时好友房，结束后退出房间。
