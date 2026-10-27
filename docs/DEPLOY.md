# 部署与访问（DEPLOY）

> 面向「把它跑起来、让手机/同事也能用」的运维文档。
> 接口细节见 [WEB-API.md](WEB-API.md)；日常排障见 [RUNBOOK.md](RUNBOOK.md)。

## 1. 运行形态

只有一个进程：`src/server/main.ts`。它同时是：

- HTTP 服务（静态界面 + `/api/*`）
- agent 运行时（SQLite 数据库 + 后台任务）

没有反向代理、没有独立数据库服务、没有鉴权层。数据全在 `workspace/`：

```text
workspace/
  company.sqlite        # 组织、会话、任务、成本（单进程独占锁）
  settings.json         # 设置页写的东西：network / models / im
  logs/                 # 服务脚本的 stdout / stderr
  uploads/<id>/<name>   # 对话附件
  projects/<slug>/      # 各项目的工作空间
```

## 2. 本机启动

```bash
# 开发 / 临时验证（推荐先这样，带临时库不污染正式数据）
node --experimental-strip-types src/server/main.ts \
  --port 7811 --host 127.0.0.1 \
  --db /tmp/aic-dev.sqlite --workspace /tmp/aic-dev-ws --no-open

# 正式：launchd 托管（后台常驻、崩溃自愈）
./scripts/ai-company-service.sh start     # 等同全局命令 ai-company start
```

启动参数：

| 参数 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--port` | `PORT` | 7788 | 监听端口 |
| `--host` | `AI_COMPANY_HOST` | 127.0.0.1 | 监听地址；`0.0.0.0` = 局域网可访问 |
| `--db` | — | `workspace/company.sqlite` | 数据库路径（相对路径会转绝对） |
| `--workspace` | — | `workspace/` | 工作空间（settings / uploads / projects） |
| `--no-open` | — | 打开浏览器 | 不自动开浏览器 |

优先级：命令行 > 环境变量 > `workspace/settings.json` 的 `network` 段 > 默认值。
服务脚本写 plist 时会显式带上 `--port` / `--host`，`AI_COMPANY_HOST=0.0.0.0
./scripts/ai-company-service.sh restart` 即可切到局域网模式。

**`start` 与 `restart` 的区别（容易踩）**：`start` 是幂等的——服务已在跑且健康时
什么都不做，尤其不碰数据库锁；但如果这次的参数与 plist 里写的不一致，它会自动降级成
`restart`（否则就是「带了新 `--host` 跑 `start`，它回一句『无需重启』，实际什么都没改」）。
所以两个都可以用来改配置，不必记住哪个是哪个。`status` 会同时报「实际 bind 了什么」
与「plist 写了什么」，两者不一致时会直接告诉你重启。

`status` 里的「待你拍板」数是 `/api/org` 的 `pending[].forYou`（`decisionOwner === "owner"`），
不是 `/api/pending` 的全部条数——后者含所有人身上挂着的未答复问题，拿它数会让老板
以为一堆事等自己。旁边那个「CEO 攒着」是 `ceoQueue`。

## 3. 局域网访问（手机 / 同事）

```bash
node --experimental-strip-types src/server/main.ts --host 0.0.0.0
# 或
AI_COMPANY_HOST=0.0.0.0 ./scripts/ai-company-service.sh restart
```

启动日志会打印全部非回环 IPv4 地址；设置页「访问」段与
`GET /api/settings.network.lanUrls` 给出同样的清单，例如：

```text
  局域网（同一内网可访问）：
    http://192.168.1.71:7788/
  注意：服务没有鉴权，只在可信内网使用，不要暴露到公网。
```

- macOS 首次监听非回环地址可能弹「是否允许传入连接」，选允许。
- 手机打不开时先确认在同一 Wi-Fi、路由器没开 AP 隔离，再用
  `curl http://<IP>:<port>/api/org` 验证。
- 只监听回环时 `lanUrls` 为空是**有意的**：不输出连不上的地址。

## 4. 安全边界（重要）

这个服务**没有登录、没有 token、没有 CSRF 防护、没有 TLS**。任何能访问
端口的人都可以：

- 读取全部对话与组织数据（`/api/feed/*`、`/api/org`）
- 以老板身份发消息（`/api/message`）、拍板（`/api/answer`）、打断任务
- 修改设置、增删模型、读取**全部上传附件**、配置 IM webhook

因此：

1. **只绑定 `127.0.0.1` 或可信内网地址**。不要在公网 VPS 上直接
   `--host 0.0.0.0`，也不要做路由器端口映射 / 公网反向代理。
2. 需要远程访问时，用 **SSH 隧道** 或 **Tailscale / WireGuard** 之类
   的私有网络，而不是把端口裸露出去：
   ```bash
   ssh -L 7788:127.0.0.1:7788 user@mac-mini   # 本地浏览器开 http://127.0.0.1:7788
   ```
3. `settings.json` 里的模型 `apiKey`、`im.inboundToken` 都是**明文**。
   不要把这个文件提交到 git、不要丢进共享目录；换密钥时直接改设置页。
4. IM 入站 token 只是「防止误投」的最低门槛，不是身份认证：token 泄露
   等于任何人都能以老板身份说话。webhook 建议只指向本机 / 内网的桥。
5. 一旦发现端口可能被外网触达：先 `stop` 服务，轮换模型 key 与
   `inboundToken`，再检查 `workspace/logs/`。

### Docker 下的额外注意

- `docker-compose.yml` 把端口映射为 `"7788:7788"`（所有网卡）。只想本机
  访问时改成 `"127.0.0.1:7788:7788"`。
- 容器里的「本机」不是宿主机的本机：本地模型网关要写
  `http://host.docker.internal:3425/v1`（compose 已给示例）。
- 需要把容器里的服务暴露到局域网时，`AI_COMPANY_HOST=0.0.0.0` 且端口映射
  不能绑 `127.0.0.1`；安全边界同上，**仅在可信内网**这样做。

## 5. Docker

### 一键起

```bash
docker compose up -d --build
docker compose logs -f
# 打开 http://127.0.0.1:7788/
```

镜像选择「直接跑 TypeScript」而不是 `tsc` 构建：运行时只需要源码 + 依赖，
少一层 `dist/` 与构建产物不一致的风险（Node 22 的 `--experimental-strip-types`
只擦除类型，不做类型检查；类型检查在 CI/开发机用 `npx tsc --noEmit`）。

### 数据持久化

compose 默认用命名卷 `ai-company-workspace`。想直接看到文件：

```yaml
volumes:
  - ./workspace:/app/workspace
```

Linux 上需先把目录交给容器用户（镜像里是 uid 1000 的 `node`）：

```bash
mkdir -p workspace && sudo chown -R 1000:1000 workspace
```

### 模型与密钥

- 默认走本地 Command Code 网关；容器内要用
  `COMMANDCODE_BASE_URL=http://host.docker.internal:3425/v1`。
- 用官方 Anthropic / OpenAI 时在 compose 里设置 `AI_COMPANY_PROVIDER` 与
  对应 `*_API_KEY`，或启动后在设置页「添加模型」（需重启容器生效）。
- 不要在镜像里 bake 密钥；用 compose 的 `environment` / `env_file`。

### 健康检查与升级

```bash
docker compose ps                     # healthcheck 打 /api/org
docker compose pull && docker compose up -d --build   # 升级（先备份 workspace）
```

停止前尽量让它正常退出（`docker compose down` 会发 SIGTERM）：
数据库锁、事件日志、在途任务的收尾都依赖正常退出。

## 6. Tauri 桌面壳评估（只给结论，不实现）

**结论：可行，但这一轮不做；推荐路径是「Tauri 壳 + Node sidecar」，不要用
Rust 重写服务端。**

评估依据：

| 维度 | 结论 |
| --- | --- |
| node:sqlite | 底层用 Node 内置 `node:sqlite`，**没有原生 npm 模块**，因此不需要为每个平台重编 SQLite，sidecar 方案最大的坑不存在 |
| 运行时 | 需要把 Node ≥22.19 作为 sidecar 打进安装包（约 50–80MB）；Tauri 的 `externalBin` 正是为此设计 |
| 前端 | 现有 `ui/` 是纯静态页面，Tauri WebView 直接指 `http://127.0.0.1:<port>/` 即可，不用改前端 |
| 生命周期 | 需要 Tauri 负责 start/stop sidecar、随机端口、单实例锁（`instance-lock` 已存在）、退出时优雅关停；launchd 方案下这些由系统代管，迁到 App 内要自己写 |
| 分发 | macOS 需要签名 + 公证；Windows 安装包、自动更新都要额外工程；Linux AppImage/deb 相对容易 |
| 复杂度 | 真正麻烦的是「App 退出时后台任务怎么办」：老板可能期望关窗后 agent 继续跑，这需要一个常驻守护进程 + 菜单栏 App，而不是纯壳 |

推荐分两步：

1. **现在**：保持 `launchd` 常驻 + 浏览器访问（本文第 2 节）。零新增工程，
   已经满足「点开就用」。
2. **将来做桌面 App**：Tauri 2 + `externalBin` 打包 Node sidecar，WebView
   指向 sidecar 的 `127.0.0.1:<随机端口>`；sidecar 用 `--no-open` 启动，
   App 负责端口发现与优雅退出；workspace 固定在
   `~/Library/Application Support/ai-company/`。先只做 macOS 签名版。

不推荐：Electron（体积更大、没有收益）、Rust 重写服务端（sqlite 协议、
任务恢复、pi-durable 语义全部重来，风险极高）。

## 7. 备份 / 迁移

```bash
./scripts/ai-company-service.sh stop        # 先停，避免拷到写一半的库
tar czf ai-company-$(date +%F).tar.gz workspace
```

迁移到新机器：装 Node ≥22.19 → 拷 `workspace/` → `npm ci` →
`./scripts/ai-company-service.sh start`。`settings.json` 里的 `apiKey`
是明文，跨越不可信介质时先删掉、到新机器再填。

## 8. 排障速查

| 现象 | 先看 |
| --- | --- |
| 端口被占用 / EADDRINUSE | `lsof -nP -iTCP:7788 -sTCP:LISTEN`；确认没有第二个实例（数据库有独占锁） |
| 手机打不开 | 是否 `--host 0.0.0.0`、同一网段、防火墙/AP 隔离；`lanUrls` 是否为空 |
| 加了模型不生效 | `restartRequired` 为 true 时需重启服务；重启后看启动日志里的 `模型：` |
| 设置页保存失败 | 看响应状态：400 = 参数不合法，409 = 模型重名，500 = workspace 不可写 |
| 附件上传 413 | 单文件上限 20MiB；`x-file-size` 预检也会拦 |
| IM 入站 403 | `im.enabled`、`inboundToken` 是否已保存；token 要与 URL 完全一致 |
| IM 出站没反应 | webhook 只接受 http(s)、超时 3s、失败静默；先手动 `curl -X POST` 验证桥 |
| 服务日志 | `workspace/logs/server.log` / `server.err.log`（`ai-company logs`） |
