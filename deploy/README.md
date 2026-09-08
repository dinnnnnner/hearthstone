# 游戏大厅部署

当前站点为 https://8.153.150.101/，服务器通过 `root@100.121.69.44` 管理。

## 路由

| 路径 | 处理方式 |
| --- | --- |
| `/` | `deploy/home` 中的静态游戏大厅 |
| `/lobby/` | 大厅样式与 SVG 图标 |
| `/tavern/` | 酒馆生产构建，全部图片与脚本带此前缀 |
| `/sector/` | 反向代理到 `127.0.0.1:5173/` |
| `/assets/`、`/ws`、`/api/` 等原路径 | 保持 SECTOR 原服务路由 |

HTTP 80 继续跳转到 HTTPS。原证书、ACME 验证目录及 SECTOR systemd 服务沿用原配置。大厅 HTML 不缓存；大厅资源缓存 1 天，酒馆原画缓存 7 天，带内容哈希的脚本和样式缓存 1 年。构建时预生成 gzip，降低服务器运行负担。没有新增长驻 Node 进程。

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
tar -C site-dist -cf - . | ssh root@100.121.69.44 "tar -xf - -C '$release_dir'"
scp deploy/nginx.conf deploy/sector-proxy.conf "root@100.121.69.44:$release_dir/"
ssh root@100.121.69.44 "python3 - '$release_dir'" < scripts/activate-site.py
```

激活脚本校验全部文件的 SHA-256，备份现有 Nginx 站点与当前目录链接，再原子切换 `/var/www/playroom/current`。只有 `nginx -t` 通过才 reload，随后检查 HTTPS 主页、两个游戏和 SECTOR API；失败会自动恢复旧配置。它不重启 SECTOR，也不改防火墙或证书配置。

正在运行的 SECTOR 后续发布仍应通过 `/opt/sector/current` 更新，不要重新用旧版 `sector-public.conf` 覆盖 Nginx 站点，否则会删除大厅路由。更改域名或证书配置时同步维护本目录的 `nginx.conf`。

## 回滚

针对当前发布目录执行：

```bash
ssh root@100.121.69.44 'python3 - /var/www/playroom/releases/20260908T033043Z' < scripts/rollback-site.py
```

请将路径替换成需要撤销的当前发布。脚本读取该发布的 `rollback/state.json`，恢复激活前的站点配置及目录链接，再检查并 reload Nginx。首次发布回滚后，根路径恢复为原来的 SECTOR 页面。原发布文件保留。
