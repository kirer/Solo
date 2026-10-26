# 内网穿透：cloudflared-manager

把本机 `ai-company`（`127.0.0.1:7788`）通过 Cloudflare Tunnel 暴露到公网，
用 [cloudflared-manager](https://github.com/cocardoso/cloudflared-manager) 的网页界面管理隧道。

## 现在的状态

| 项 | 值 |
|---|---|
| 公网地址 | **https://oxfff.com**（根域，`www.oxfff.com` 同源） |
| 访问控制 | **Cloudflare Access**（一次性邮箱验证码，仅白名单邮箱）
| Access 应用 | 两个：`ai-company`（`oxfff.com`，需登录）+ `ai-company static (bypass)`（静态资源，免登录） |
| 管理界面 | http://127.0.0.1:8080 （只绑回环，不对公网） |
| 隧道名 / id | `ai-company` / `aaeb552a-9d6f-497d-877a-931b38ef1ec1` |
| 隧道协议 | `auto`（实际走 quic）。曾试过 `http2`，**实测更慢**，已改回，见下文「隧道协议实测」 |
| 前端产物 | `ui/dist/`（可选加速层，`npm run ui:build` 生成；没有或过期时服务端自动回退源码） |
| 落地服务 | `http://host.docker.internal:7788` |
| 数据卷 | `cloudflared-manager_cloudflared-manager-data` |

## 拓扑

```
浏览器
  │ https
  ▼
Cloudflare 边缘（TLS 终止、WAF、Access 校验）
  │ QUIC 隧道（4 条连接，出站，无需公网 IP / 端口映射）
  ▼
容器 cloudflared-manager ── cloudflared 子进程
  │  host.docker.internal:7788
  ▼
宿主机 ai-company（node --experimental-strip-types src/server/main.ts）
```

**不需要**路由器端口映射、DDNS、公网 IP。cloudflared 是出站连接。

## 目录

```
/Users/kirer/projects/cloudflared-manager/
├── docker-compose.yml        编排（端口只绑 127.0.0.1）
├── .ui-password              管理界面密码（600）
├── .cf-token-user            User API Token（600，隧道/隧道路由用这把）
├── .cf-token-access          Account Token（600，Access Apps 权限：建/改 Access 应用）
├── .cf-token                 Account-owned token（600，仅用来建 Access App / 额度用完）
├── .cf-token-scoped          限定权限 token（600，备份用途）
├── .access-app-id            Access 应用 id
└── .tunnel-id                已废弃（旧隧道已删）
```

⚠️ **`docker compose down -v` 会删掉数据卷**，隧道凭据和加密密钥全在里面，隧道就废了。

## 日常操作

```bash
cd /Users/kirer/projects/cloudflared-manager

docker compose up -d          # 启动
docker compose ps             # 状态（应看到 healthy）
docker compose logs -f        # 日志
docker compose restart        # 重启（隧道会自动恢复）
docker compose pull && docker compose up -d   # 升级（含新版 cloudflared）
```

**重启宿主机后**：`restart: unless-stopped` 会自动拉起容器和隧道，什么都不用做。
**但 ai-company 本身不会自动启动** —— 容器起来了、隧道通了，`host.docker.internal:7788`
没人听，访问会是 502。所以宿主机重启后要手动起 ai-company。

## 管理界面用法

打开 http://127.0.0.1:8080 ，用户名 `kirer`，密码在 `.ui-password`。

| 想干什么 | 在界面哪 |
|---|---|
| 加一个新的主机名 | 隧道 → Public hostnames → Add |
| 改隧道设置（协议 / keep-alive / 容忍时间） | 隧道 → Settings |
| 看实时日志 | 隧道 → Logs |
| 看连接和流量 | 隧道 → Status / 流量图 |
| 停掉某个隧道 | 隧道 → Stop（停了就不会自动起） |
| 换 API Token | Settings → Cloudflare |

**加路由必须用界面或 `PUT /api/tunnels/:id/routes`**，别手动去 CF 面板加 CNAME ——
应用会维护 `managed by cloudflared-manager` 注释，手动改会让它不认识。

## 静态资源免 Access 登录（第二个 Access 应用）

页面本身要登录，但 `app.css` / `app.js` / `vendor/` 这些**就是要给未登录浏览器加载的**，
让它们每次也走一遍 Access 校验不止浪费，还会在 302 → 回跳时丢掉浏览器的并发优势。

做法：建第二个 Access 应用，`decision: bypass` + `include: [{"everyone":{}}]`，
只覆盖静态路径（**精确到子路径，不用通配符**）：

| 项 | 值 |
|---|---|
| app id | `b5b81c89-8763-4d65-a6b1-af8b140e12fc` |
| 覆盖 | `/app.css` `/app.js` `/js/*` `/css/*` `/vendor/*`（`oxfff.com` 与 `www.oxfff.com` 各一份） |
| 策略 | `bypass` / `everyone`（不需要身份即可访问） |

建它的命令（用 `.cf-token-access`，该 token 需 **Access: Apps and Policies: Edit**）：

```bash
cd /Users/kirer/projects/cloudflared-manager
T=$(cat .cf-token-access)
A=acb671c66f086c5d79e9a8f24c34aeeb
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$A/access/apps" \
  -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{
  "name": "ai-company static (bypass)",
  "type": "self_hosted",
  "domain": "oxfff.com/js",
  "self_hosted_domains": ["oxfff.com/js","oxfff.com/css","oxfff.com/vendor",
    "oxfff.com/app.js","oxfff.com/app.css",
    "www.oxfff.com/js","www.oxfff.com/css","www.oxfff.com/vendor",
    "www.oxfff.com/app.js","www.oxfff.com/app.css"],
  "app_launcher_visible": false,
  "policies": [{"name":"bypass static","decision":"bypass","include":[{"everyone":{}}]}]
}'
```

**验收结果**（2026-10-26 实测）：

| 路径 | 期望 | 实测 |
|---|---|---|
| `/app.css` `/app.js` `/js/*` `/css/*` `/vendor/*` | 200 免登录 | 200 |
| `/` | 302 → Access | 302 |
| `/api/org` `/api/board` `/api/stream/org` | 302 → Access | 302 |
| `/index.html` `/settings` | 302 → Access | 302 |

安全边界：**只放开了静态资源**，`/api/*` 与页面本身仍需登录。
Access 的 domain 匹配是前缀式的，所以**没有**用 `oxfff.com/*` 或 `/js*` 这种会把
`/js...` 以外的路径也呑进来的写法。

## 隧道协议实测（`auto`/quic vs `http2`）

2026-10-26 同一台机器、同一时段，各 15 次 `curl -w %{time_starttransfer}` 采样
（`https://oxfff.com/`，`Accept-Encoding: br`）：

| 协议 | 中位数 | 最小 | 最大 | 超时/失败 |
|---|---|---|---|---|
| `auto` → quic | 2.87 s | 0.00 s | 15.35 s | 0 |
| `http2` | **4.90 s** | 0.00 s | 19.20 s | 0 |

结论：**http2 更慢，不要改**。默认 `auto` 会选 quic（UDP/443），比 http2 的
TCP 握手 + 队头阻塞更适合这条跨境链路。Jain 抖动极大（min 0、max 19 s）主要是
本机运营商对 CF 网段的干扰，不是协议问题，见下文「为什么还是慢」。

修改方式（需要 UI 会话 cookie，`/api` 只认它）：

```bash
cd /Users/kirer/projects/cloudflared-manager
curl -s -b .ui-cookies -X PATCH \
  http://127.0.0.1:8080/api/tunnels/aaeb552a-9d6f-497d-877a-931b38ef1ec1 \
  -H 'content-type: application/json' -d '{"protocol":"auto"}'
```

改完等 15–20 秒（`edgeStatus` 会先 `down` 再 `healthy`，`local` 走 `activating`），
期间公网会 502。

## 为什么还是慢（剩下的瓶颈）

已做的优化：服务端 brotli + ETag/304、前端打包成 3 个请求（见
`docs/perf-notes` 相关章节与 `npm run ui:build`）。

**但首字节仍然是 3–8 秒**，因为瓶颈不在字节数：

1. **边缘 PoP 在洛杉矶**（`cf-ray: ...-LAX`）—— 大陆访问被路由到 LAX，
   一次往返 150–250 ms；TLS 握手 + Access 跳转 = 至少 3 个往返打底；
2. **本机运营商对 CF 网段有干扰** —— 同一域名连续请求会出现 `ttfb=0`（连接被重置）
   和 19 秒尖峰，`https://1.1.1.1/` 同样超时。这不是服务端问题；
3. **Cloudflare Access 每次都要验一次** —— 校验发生在边缘，但会话 cookie 是
   `oxfff.com` 域的，静态资源也走同一条路径，没法靠 `Cache-Control` 越过。

真正能再降一个数量级的只剩「换落地机到香港/新加坡做反代」或「大陆节点 +
备案」，都属于换基础设施，不是改代码能解决的。

## Access 白名单怎么加人

```bash
CF=$(cat /Users/kirer/projects/cloudflared-manager/.cf-token)
ACC=acb671c66f086c5d79e9a8f24c34aeeb
APP=$(cat /Users/kirer/projects/cloudflared-manager/.access-app-id)

# 看现有策略
curl -sS -H "Authorization: Bearer $CF" \
  "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps/$APP/policies" | python3 -m json.tool

# 加一个邮箱（改成目标邮箱）
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACC/access/apps/$APP/policies" \
  -H "Authorization: Bearer $CF" -H 'content-type: application/json' \
  --data '{"name":"allow bob","decision":"allow","precedence":2,
           "include":[{"email":{"email":"bob@example.com"}}]}'
```

或者网页上：Zero Trust → Access → Applications → `ai-company` → Policies。

当前白名单只有一个邮箱：`Lin77777777777777k@gmail.com`（登录方式是 One-time PIN，
`kirer.cloudflareaccess.com` 那套，用户点邮件里的码即可，不用注册账号）。

## 坑（都是这次实际踩到的）

### 1. 只接受 User API Token，不接受 Account-owned Token

代码里写死的是（容器内 `/app/server.mjs:66959`）：

```js
static verifyToken(c) {
  return c.request("GET", "/user/tokens/verify");
}
```

`cfat_...`（account-owned）打这个端点是 `1000: Invalid API Token`，虽然它打
`/accounts/{id}/tokens/verify` 是 active。所以必须去
https://dash.cloudflare.com/profile/api-tokens 建 **User API Token**（`cfut_...`）。

### 2. 别用 API 手建隧道

应用会给它托管的隧道装 keep-alive、监控、watchdog。用 API 建的隧道在界面里显示
`managedHere: false` / `local: not-installed`，**点 Start 也起不来**。
正确做法：在界面上建，或者建完让应用 adopt（`POST /api/tunnels/:id/adopt`）。

### 3. 端口不要暴露到局域网

compose 里是 `127.0.0.1:8080:8080`。这个 UI 自己有登录，但没必要让局域网看到它。

### 4. 容器里 `127.0.0.1` 是容器自己

所以路由要写 `http://host.docker.internal:7788`，不能写 `127.0.0.1:7788`。
compose 里加了 `extra_hosts: host.docker.internal:host-gateway` 才通（Linux 需要）。

### 5. ai-company 本身没有鉴权

`src/server/main.ts` 顶部注释：**服务没有鉴权，只应在可信内网使用**。
所以 Access 不是「可选加强」，是**必须**。不加 Access 等于把这个项目的全部能力
（发消息给 CEO、点「立即处理」abort agent、改模型设置）交给任何知道域名的人。

## 已知风险

| 风险 | 现状 | 缓解 |
|---|---|---|
| ai-company 无鉴权 | 靠 Access 挡在边缘 | 别删 Access 应用 |
| SSE 长连接 | `src/server/http.ts:518` 心跳 15 秒，远低于 CF 100 秒空闲限制 | 无需处理，实测正常 |
| 容器重启后隧道恢复 | keep-alive + watchdog，5 秒后自动重起 | — |
| 宿主机重启 | 容器会起，ai-company 不会 | 手动起 ai-company |
| 数据卷丢失 | 隧道凭据在卷里 | 备份卷；丢了就在界面上重建隧道 + 改 DNS |

## 验证命令

```bash
# 匿名应被拦到 Access 登录（302）
curl -sS -o /dev/null -w "%{http_code}\n" https://oxfff.com/

# 隧道状态
cd /Users/kirer/projects/cloudflared-manager
TID=aaeb552a-9d6f-497d-877a-931b38ef1ec1
curl -sS -b .ui-cookies "http://127.0.0.1:8080/api/tunnels/$TID" | python3 -m json.tool

# 落地服务（容器内）
curl -sS -b .ui-cookies -X POST http://127.0.0.1:8080/api/tools/test-origin \
  -H 'content-type: application/json' --data '{"service":"http://host.docker.internal:7788"}'
```

`edgeStatus: healthy` + `connections` 有 4 条 + `local: active` = 正常。

## 附：为什么需要账号级 token

建 Access 应用、查 zone、建 token 这些是**账号级 API**，用的是 `.cf-token`（`cfat_`）。
它不能喂给 cloudflared-manager，但可以命令行用。用完了可以在 CF 面板吊销。
