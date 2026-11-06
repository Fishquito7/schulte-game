# 运维层（NAS 自托管）

`deployment/` 里的游戏本体和排行榜后端是**原样运行**的；这个目录放的是把它真正上线所必需的那一层：
TLS 前端、`/api` 反代、真实 IP 还原、访问日志和 systemd / logrotate 配置。

```
浏览器 ──HTTPS──▶ SakuraFrp 节点(443) ──隧道──▶ frpc ──▶ 127.0.0.1:8090  server.mjs
                                                              │  TLS 终止 / 静态文件
                                                              │  PROXY protocol 还原真实 IP
                                                              └─ /api/* ──▶ 127.0.0.1:8097  server.js
```

两个进程都只监听回环，公网只能经隧道进来。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.mjs` | TLS 前端：静态文件 + `/api/*` 反代 + PROXY protocol 解析 + 访问日志 |
| `site.service` | systemd：`server.mjs` → `127.0.0.1:8090` |
| `schulte-api.service` | systemd：`deployment/server/server.js` → `127.0.0.1:8097` |
| `site-tunnel.service` | systemd：frpc，跑 `site-tunnel.ini` |
| `site-tunnel.ini.example` | 隧道配置样例（把 `<...>` 换成自己的访问密钥/节点） |
| `logrotate.d-fishquito-site` | 日志轮转（每天或 5 MB，留 14 份） |

## 为什么需要 `server.mjs`

隧道是 **HTTPS + SNI 透传**：TLS 在本地终止，证书必须装在服务端，所以后端那个只讲明文 HTTP 的
`server.js` 不能直接对外。`server.mjs` 负责：

1. 终止 TLS（证书在 `tls/cert.pem` + `tls/key.pem`，**pem 里必须带中间证书**）
2. 服务 `public/` 下的静态文件（HTML `no-cache` + ETag，其余 `max-age=3600`）
3. 把 `/api/*` 原样转发给 `127.0.0.1:8097`，并补 `X-Forwarded-For` / `X-Forwarded-Proto`
4. 解析 frpc 的 **PROXY protocol v1**，拿到访客真实 IP

### 真实 IP 是怎么来的

隧道配置里开启（见 `site-tunnel.ini.example`）：

```ini
[site]
proxy_protocol_version = v1
```

开启后 frpc 在连本地 8090 前会先写一行：

```
PROXY TCP4 <访客IP> <本地IP> <源端口> <目的端口>\r\n
```

`server.mjs` 在 TLS 握手前把这行剥掉，把 IP 挂到 socket 上，用于：

- `access-ip.log` 记录
- 反代给后端时的 `X-Forwarded-For`（后端的单 IP 限流才准确）

**首字节不是 `P` 的连接按普通 TLS 处理**，所以开了 PROXY 之后本地
`curl -k https://127.0.0.1:8090/` 依然能用，日志里记 `127.0.0.1`。

> ⚠️ 这两处是配套的。如果要回滚成不支持 PROXY 的旧 `server.mjs`，
> **必须同时删掉隧道 ini 里的 `proxy_protocol_version`**，否则网页会全部打不开。

## 安装

```bash
# 假设仓库已放到 /home/<user>/app/site（server.js 在 schulte-server/）
sudo install -m 644 deployment/ops/site.service        /etc/systemd/system/site.service
sudo install -m 644 deployment/ops/schulte-api.service /etc/systemd/system/schulte-api.service
sudo install -m 644 deployment/ops/site-tunnel.service /etc/systemd/system/site-tunnel.service
sudo install -m 644 deployment/ops/logrotate.d-fishquito-site /etc/logrotate.d/fishquito-site
sudo systemctl daemon-reload
sudo systemctl enable --now site schulte-api site-tunnel
```

证书目录 `tls/`、数据目录 `data/` 需自行创建：

```bash
mkdir -p ~/app/site/data ~/app/site/tls
chmod 600 ~/app/site/tls/key.pem
```

## 日志

| 文件 | 内容 |
| --- | --- |
| `site.log` | 访问日志：`时间 状态码 方法 路径 耗时` |
| `access-ip.log` | 带真实 IP，tab 分隔：`时间 IP 方法 路径 状态码 耗时` |
| `schulte-api.log` | 后端启动横幅与写盘错误 |
| `site-tunnel.log` | frpc 隧道日志 |

`access-ip.log` 的时间是 UTC（ISO 8601），北京时间 +8。

```bash
S=~/app/site
column -t -s$'\t' "$S/access-ip.log" | tail -20
awk -F'\t' '{print $2}' "$S/access-ip.log" | sort | uniq -c | sort -rn | head   # 谁来得最多
awk -F'\t' '$5 != 200 && $5 != 304' "$S/access-ip.log" | tail                   # 异常响应
```

页面里的 JS 每次加载都会探测一次 `/api/health`，所以一次首页访问通常是两条日志
（`/` 一条 + `/api/health` 一条），这是正常的；`304` 表示协商缓存命中，不是错误。

## 服务管理

```bash
systemctl status site schulte-api site-tunnel
sudo systemctl restart site            # 改了 server.mjs / 换证书
sudo systemctl restart schulte-api     # 改了后端
tail -f ~/app/site/site.log
```

- **只改 `public/` 里的页面**：不用重启，刷新即可（HTML 是 `no-cache`）
- 改了 css/js/图片会被浏览器缓存 1 小时，需要硬刷或改文件名

## 数据

排行榜数据就是一个 JSON 文件（`data/scores.json`，由 `schulte-api.service` 的 `DATA_FILE` 指定）：

```bash
cp ~/app/site/data/scores.json ~/scores-$(date +%F).json     # 备份

# 清空（先停服，否则内存状态会覆盖你的改动）
sudo systemctl stop schulte-api
echo '{"v":3,"players":{},"scores":[]}' > ~/app/site/data/scores.json
sudo systemctl start schulte-api
```

注意后端是**启动时把 JSON 读进内存**、写入时整库覆盖：服务运行期间手改文件既不生效，
也会被下一次写入覆盖。改数据要么走接口，要么停服改。

## 换证书

```bash
cp 新证书.crt ~/app/site/tls/cert.pem    # 需含中间证书链
cp 新私钥.key ~/app/site/tls/key.pem
chmod 600 ~/app/site/tls/key.pem
sudo systemctl restart site
```
