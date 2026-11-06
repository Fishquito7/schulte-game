# 排行榜后端（Node.js，零依赖）

一个文件、不用 npm install、不用数据库。成绩存 `data/scores.json`。

## 运行

```bash
cd server
node server.js
```

默认监听 `127.0.0.1:8090`，同时会把**上级目录**当作静态站点托管——所以直接打开
`http://127.0.0.1:8090/` 就是游戏本体，前后端同源，不需要任何配置。

> 绑定 `127.0.0.1` 是给「前面有 nginx / Caddy 反代」的场景用的；如果想让局域网直接访问，
> 用 `HOST=0.0.0.0 node server.js`。

```bash
PORT=9000 node server.js                      # 换端口
ALLOW_ORIGIN=https://fishquito.github.io node server.js   # 限制跨域来源
HOST=0.0.0.0 node server.js                              # 允许局域网直连
DATA_FILE=/var/lib/schulte/scores.json node server.js     # 换数据文件位置
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8090` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（反代场景只开回环） |
| `DATA_FILE` | `server/data/scores.json` | 数据文件，不存在会自动创建 |
| `STATIC_DIR` | 仓库根目录 | 静态站点根目录 |
| `ALLOW_ORIGIN` | `*` | CORS 允许的来源，建议上线后改成你的站点域名 |

## 接口

```
POST  /api/register  {name}                 → {id, name}        建档案，返回 9 位档案号
POST  /api/login     {id}                   → {id, name} | 404  用档案号换回档案
PATCH /api/player    {id, name}             → {id, name}        改昵称
GET   /api/scores?mode=&size=&rev=&limit=   → {items:[{id,name,t,s,created_at}]}
POST  /api/scores    {id, mode, size, rev, t, s}
                                            → {ok, rank, improved, best}
GET   /api/health                           → {ok, players, scores}
```

**档案号**：`^[0-9]{3}[A-Z0-9]{6}$`，由服务端用 `crypto.randomInt` 生成并查重；字符表去掉了
`0/1/I/L/O/U`，避免手输时看错。它同时是身份凭证——**谁拿到档案号谁就是这个玩家**。

**一人一榜**：`(id, mode, size, rev)` 唯一。新成绩更快就覆盖，更慢则原样保留并返回
`improved:false`、`best` 为原最好成绩。昵称不写在成绩行上，读取时从 `players` 表 join，
所以改昵称只改一处。

校验规则（服务端强制）：

- `name` 去控制字符后截断到 12 字，不能为空
- `mode` ∈ `square | radial | star`，`size` ∈ 3–8
- `t`（秒）∈ 2–900；`s`（评分）∈ 0–150
- 提交成绩时 `id` 必须已存在，否则 401

单 IP 每分钟最多 30 次写操作（建档/登录/提交共用，`X-Forwarded-For` 优先）。
每个榜单最多保留 200 人，超出的按用时从慢到快裁掉。

## 部署到服务器

### 1. systemd

```ini
# /etc/systemd/system/schulte.service
[Unit]
Description=Schulte leaderboard
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/schulte/server
Environment=PORT=8090
Environment=ALLOW_ORIGIN=https://你的用户名.github.io
Environment=DATA_FILE=/var/lib/schulte/scores.json
ExecStart=/usr/bin/node /opt/schulte/server/server.js
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/schulte && sudo chown www-data /var/lib/schulte
sudo systemctl daemon-reload && sudo systemctl enable --now schulte
sudo systemctl status schulte
```

### 2. nginx 反代 + HTTPS

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 16k;
    }
}
```

```bash
sudo certbot --nginx -d api.example.com
```

### 3. 前端指向它

游戏部署在 GitHub Pages（和 API 不同源）时，改 `index.html` 顶部：

```js
const NET = Object.assign({
  base: 'https://api.example.com'
}, window.SCHULTE_NET || {});
```

如果是用本服务直接托管游戏（同源），**留空即可**，页面会自动探测 `/api/health`。

## 备份与清理

数据就是一个 JSON 文件，`cp` 就是备份：

```bash
cp /var/lib/schulte/scores.json ~/scores-$(date +%F).json
```

定时删重复/异常数据：

```bash
# 每项仅保留最快 200 条（服务端已自动做，这里是兜底）
sqlite3 不适用，直接用 node 读 JSON 处理即可
```

## 已知取舍

- **JSON 文件而非数据库**：单进程写、量级小（几百到几万人）完全够用；如果以后要多人同时刷榜、需要分页或统计，换 SQLite/Postgres 只改 `load / flush / boardOf` 三个函数。
- **档案号即凭证**：没有密码，也没有会话。拿到档案号的人就能用你的档案，这是为了「免注册」付出的代价；真要紧的话再叠一层「改昵称/删除成绩需要二次确认」。
- **防作弊是弱的**：只做了数值区间和限流，无法验证成绩真伪。真要防，需要服务端下发题目种子并校验过程，成本高一个量级。
- **不存 IP**：`ip` 只用于内存里的限流，不落盘。
