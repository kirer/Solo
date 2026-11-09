# 部署与访问

> 面向「把它跑起来、让手机/家里人也用」。接口细节见 [WEB-API](WEB-API.md)。

## 1. 运行形态

只有一个进程：`src/shell/main.ts`。它同时是：

- HTTP 服务（静态界面 `ui/web/` + 32 条 `/api/*` 路由，插件路由另算）
- agent 运行时（SQLite + 后台任务）

没有反向代理、没有独立数据库服务、**没有鉴权层**。后端没有构建步骤（`node --experimental-strip-types`
直接跑 TS）；**界面有**：改 `ui/app/` 后必须 `npm run ui:build` 把产物写回 `ui/web/`。
数据分**两个根**（ADR-030）：应用私有的那份跟着安装走，我的组织跟着我走。

```text
<appRoot>/                         # 默认 ./.solo-app；桌面端是 userData
  core.sqlite                      # 频道、消息、会话、名册（单进程独占锁）
  settings.json                    # 模型接入配置（可选）
  assistant/<slug>/                # 助理：identity.md / memory.md / skills/ / workspace/
  prompt/                          # 提示词模板（改完下一条消息生效）
  text/                            # 工具文案（改完要重启：装配时定型）
  plugins/                         # 插件（含出厂两个）
  uploads/                         # 附件

~/.solo/                           # 用户根（--user-root）
  members/<slug>/                  # 每个成员：identity.md / memory.md / skills/ / workspace/
  teams/<slug>/                    # 每个团队：README.md / memory.md / workspace/
  skills/                          # 全员层技能
  rules.md                         # 全员规矩（每轮都进提示词）
  logs/                            # 审计 / 诊断 / 后台命令（ADR-041）
```

**组织（`userRoot`）是唯一的真相**。删掉数据库不会丢掉「人是谁」——从 `members/` 重建即可；
反过来删掉 `members/` 就没救了。备份先备份 `members/`、`teams/`、`skills/`、`rules.md`。

## 2. 本机启动

```bash
npm start                      # = node --experimental-strip-types src/shell/main.ts
npm start -- --port 7811 --host 127.0.0.1 --app-root /tmp/aic-app --user-root /tmp/aic-home --no-seed
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 7788 | 监听端口 |
| `--host` | 127.0.0.1 | 监听地址；`0.0.0.0` = 局域网可访问 |
| `--app-root` | `<cwd>/.solo-app` | 应用私有目录（助理、提示词、插件、`settings.json`、`core.sqlite`、`uploads/`） |
| `--user-root` | `~/.solo` | 我的组织（`members/`、`teams/`、`skills/`、`rules.md`） |
| `--no-seed` | 关 | 不播种。首次启动且用户根里还没有人时会自动建一个叫「Solo」的助理（住在 `appRoot/assistant/`）并给两份技能 |

启动成功会打印监听地址和局域网地址。Ctrl-C 退出。

**首次启动会做什么**：建两个根 → 迁移磁盘上的旧形状（身份头的 `project:` → `team:`，幂等）→
同步提示词模板、`rules.md` 与全员层技能（缺的补上；`.seed-manifest.json` 记着「没改过」的升到
新版，改过的原样留着）→ 若用户根里一个人都没有，播种「Solo」（含《建立团队》《招人》两份个人
技能）→ 读模型配置 → 开会话 → 建全员频道。这个过程不产生对外请求，模型不可用也能起来
（只是 agent 不会回话）。`settings.json` 存在但读不懂时启动会报错并**不覆盖**它 —— 先把文件
改对再启动。

开机给**每个成员**补一条「我 ↔ 他」的私聊（幂等；`ensureOwnerDm`）：他的工作过程在那里看。
团队频道（`team:<slug>`）按 `teams/<slug>/README.md` 的成员投影，改完档案下一条消息就生效。

## 3. 模型接入

优先级（`src/core/runtime/models.ts` 的 `setupModels`）：

1. `<appRoot>/settings.json` 里写了 `providers` → 用它；
2. 环境变量 `ANTHROPIC_API_KEY` → Anthropic（默认模型 `claude-sonnet-4-6`）；
3. 环境变量 `OPENAI_API_KEY` → OpenAI（默认模型 `gpt-5`）；
4. 都没有 → **没有模型**。服务照常起来、界面照常用，但 agent 不会回话；
   启动日志里会写一行「还没有配置模型」（ADR-023）。

配置文件优先于环境变量：只要 `settings.json` 里有非空 `providers[]`，就不会再看环境变量。

**为什么不给一只兜底模型**：以前第 4 条是「悄悄用本地网关」。没配的人看不出来自己没配 ——
界面一切正常，只是所有人都在用一只他没选过、也不知道存在的模型。现在宁可什么都不响。

### 本地网关（自己配一份）

本机有 `http://127.0.0.1:3425/v1`（OpenAI Responses 协议）这种网关时，在
`<appRoot>/settings.json` 里写一份就是了，或者直接在界面「设置 → 模型 → 加一份本地网关」：

```json
{
  "providers": [
    {
      "id": "magpie",
      "name": "本地网关",
      "baseUrl": "http://127.0.0.1:3425/v1",
      "api": "openai-responses",
      "models": [{ "id": "auto/deepseek-v4.1-flash" }]
    }
  ]
}
```

`npm run live` / `live:scenarios` 这类真模型脚本不走产品这条路：它们在没有配置时
**自己**往临时工作区写一份本地网关配置（地址可用 `COMMANDCODE_BASE_URL` 改），
所以 `COMMANDCODE_*` 现在只对脚本有意义。

### 官方 API

```bash
ANTHROPIC_API_KEY=sk-... npm start
OPENAI_API_KEY=sk-...    npm start
```

两个都设时 Anthropic 优先。想换官方模型或同时接多家，写 `settings.json`（下一节）。

### settings.json

```json
{
  "defaultModel": "monotoo/gpt-6.1-sol",
  "providers": [
    {
      "id": "monotoo",
      "name": "Monotoo",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "api": "openai-responses",
      "models": [
        { "id": "gpt-6.1-sol", "name": "GPT-6.1 Sol", "contextWindow": 200000, "maxTokens": 32000 }
      ]
    }
  ]
}
```

- `providers[]` 每项是一个 provider；`models[]` 用 `id` 指向该 provider 的模型。
- `defaultModel` 是 `"<provider>/<modelId>"`。不写时用第一个 provider 的第一个模型。
- `agentModels`（可选）是 `{ "<slug>": "<provider>/<modelId>" }`：**单独给某个人指定模型**，
  压过 `defaultModel`。界面上在私聊/人物档案的「详情 → 模型」里改，改完当场生效并写进这一项；
  指着已删掉的 provider 的记录会被忽略（按默认走），不让人静默 `no_model`。
- 改这个文件**不用重启**：内核在下一次读模型时（开新会话、`GET /api/models`、给某个人换模型）
  发现文件变过，就把它就地重装进注册表（ADR-025）。删掉一家提供商，挂着它的人回到默认。
  唯一还按启动时算的是压缩阈值：新加的模型先用全局兜底窗口，重启一次才对齐它自己的窗口。
- `api` 可选 `openai-responses`（默认）、`anthropic`、`openai`。
- `apiKey` 写在这个文件里（**不是**环境变量名），文件在应用根下、已 gitignore。
  本地网关（`127.0.0.1` / `localhost`）可以省略或留空：装配时补占位符 `magpie`。
  远端提供商必须填 —— **空密钥不是「先不填」，是每次都失败**：底座不接受空凭据，
  生成在发请求之前就以 `model_error` 结束（审计里 `stop: error`、`ms: 0`），
  界面上只留下一条「他这一轮没答上来」。设置里的「模型」那一节会直接拒绝这种保存。
- `contextWindow` / `maxTokens` 不写时查 pi-ai 的模型目录，查不到按 128k / 32k 保守估算。
- 名字里带 `/` 的模型 id 不用拆：`id` 本身可以含 `/`，provider 由 `providers[].id` 决定。

**排障第一招**：如果所有人都不回话，先看这个模型引用能不能解析。

```bash
# 看当前生效的模型
node --experimental-strip-types -e '
const {setupModels}=await import("./src/core/runtime/models.ts");
const m = setupModels(process.env, { settingsFile: join(appRoot, "settings.json") });
console.log(m.defaultModel, m.models.getModels().map(x=>`${x.provider}/${x.id}`));'
```

错误信息 `Model <provider>/<id> is not available` = 引用对不上，改 `settings.json` 或
环境变量。历史事故：`settings.json` 里给**内置模型**改名，导致注册表出现两条同 id 的
provider，默认模型解析歧义后回落到 `no_model`，全员静默不回复，界面上看不出任何错。
V2 已经删掉「覆盖内置模型」这整套机制，provider 只能新增。

### 真实模型自测

单元测试不驱动生成，沟通跑偏只有真模型能测出来：

```bash
npm run live              # 出厂行为 13 项，需连续两次 13/13
npm run live:scenarios    # 多 agent 场景 6 个 × 3 轮；硬场景 3/3、行为场景 2/3
```

`live:scenarios` 的参数与证据位置：

```bash
npm run live:scenarios -- --list
npm run live:scenarios -- --scenario=dm-routing,restart --rounds=1 --smoke
npm run live:scenarios -- --rounds=3 --keep-failed
```

- `--settings=<path>`：把一份 `settings.json` 拷进临时工作区，换模型跑；
- `--out=<dir>`：报告目录（默认 `os.tmpdir()/solo-scenarios-<时间戳>/`）；
- `--keep` / `--keep-failed`：保留临时工作区排查；
- `--strict`：行为场景也要 3/3；`--smoke` 只用于 1 轮脚手架检查。

两者都会花 token：`npm run live` 约几分钟；场景套件约 20–40 分钟。报告写在临时目录，
不入库。两者都在 `mkdtemp` 的两个根里跑，不碰真实数据。

## 4. 局域网访问

```bash
AI_COMPANY_HOST=0.0.0.0 npm start
# 或 npm start -- --host 0.0.0.0
```

然后手机访问 `http://<本机局域网 IP>:7788/`（启动日志里会打印所有可用地址）。

**安全边界（必读）**：

- 服务**没有鉴权**，也没有 HTTPS。任何能连到这个端口的人都能以我（`owner`）的身份说话、看所有频道。
- 只在可信内网用。**不要**做公网端口映射、不要在咖啡厅 WiFi 上开 `0.0.0.0`。
- 需要公网访问就用 SSH 隧道或 WireGuard，不要直接暴露。
- 端口上的 `*` 路由会把 `ui/web/` 之外的一切 404，没有目录穿越（越界路径会被拒），
  但**这不是**安全边界。

## 5. Docker

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

`docker-compose.yml` 里已经处理了两件容易踩的事：

- **`AI_COMPANY_HOST=0.0.0.0`**：容器内必须监听所有网卡，否则宿主机连不上。
- **本地网关的地址要写宿主机**：容器里的 `127.0.0.1` 是容器自己，不是宿主机。
  用本地网关时在 `settings.json` 的 `baseUrl` 里写 `http://host.docker.internal:3425/v1`
  （或把网关跑在同一个 compose 网络里，按服务名写）。`COMMANDCODE_BASE_URL` 只管
  `npm run live` 这些脚本，产品本身不读它。

数据是一个命名卷 `ai-company-data`，里面分两个根：`/app/data/app`（应用私有）与
`/app/data/user`（我的组织）。想直接看到文件就改成 bind mount：

```yaml
volumes:
  - ./data:/app/data
```

Linux 上需要先 `mkdir -p data && sudo chown -R 1000:1000 data`（容器以
`uid 1000` 的 `node` 用户运行）。

镜像用 `node --experimental-strip-types` 直接跑源码，**不需要 `tsc` 构建**。`test/`、
`docs/`、`seed/` 不进镜像。

## 6. 备份与恢复

```bash
# 备份（数据库要在停服后拷，或者用 sqlite 的在线备份）
tar czf backup-$(date +%Y%m%d).tar.gz -C ~/.solo members teams skills rules.md

# 恢复
tar xzf backup-20261027.tar.gz
```

`members/`、`teams/`、`skills/`、`rules.md` 是纯文本目录，可以直接 `git init` 进版本库
（它们不在仓库里，本来就不会被忽略）。

数据库 `core.sqlite`（在应用根）里存的是频道消息、会话、名册。丢了它等于丢掉全部聊天
记录，但人还在、频道会在下次启动时按 `members/` + `teams/` 重建（消息没了）。

## 7. 排障

| 症状 | 先看这个 |
| --- | --- |
| 界面能开，但 agent 不说话 | §3 的模型解析；`tasks` 表里 `kind='pi.generation'` 的失败原因 |
| 这一轮为什么这么慢 / 他到底调没调工具 | `<userRoot>/logs/tools.jsonl`：每次工具调用与每次模型回复各一行（成没成、耗时、token、停止原因） |
| agent 说话了，但回在别的频道 | `directory.wake` —— 他去「最后被叫到的那个频道」回话；我发的消息必须先把 wake 记下来再唤醒他 |
| 改了 `identity.md` 没生效 | 提示词每次发送前重新读盘，所以下一条消息就该生效。没生效说明改的是别人的文件 |
| 启动很慢 | 名册是不是每人一次 commit；`members/` 里是不是有几百个目录 |
| agent 突然不干活了，日志里什么都没有 | `<userRoot>/logs/runtime.jsonl` 有没有 `task_interrupted` / `restart_limit`（见下面「诊断三处」） |
| 报 provider 的 context overflow / 400 too long | 模型的 `contextWindow` 是不是取到了（见下面「压缩」） |
| 7788 端口被占 | `lsof -nP -iTCP:7788 -sTCP:LISTEN` |

### 诊断三处

服务本身的日志**只打 stderr**（没有进程日志文件）。另外有三份结构化日志，都在
`<userRoot>/logs/` 下，都是「单文件 5MB、满了轮转成 `.1` 一代」（前两份单条再截 4KB）：

| 文件 | 装什么 | 怎么看 |
| --- | --- | --- |
| `runtime.jsonl` | 底座报上来的**运行报告**：`task_interrupted`（连续重启超限，任务已结束）、`storage_failed`、`task_faulted`、`migration_failed`、`extension_error` 等，每条带 `type` / `at` / `message`（中文人话）/ 可选任务 | `tail -n 5 <userRoot>/logs/runtime.jsonl` |
| `jank.jsonl` | 浏览器自报的卡顿（长帧 > 240ms、长任务 > 200ms），带当时在干什么、是否切了后台 | `tail -n 5 <userRoot>/logs/jank.jsonl` |
| `tools.jsonl` | 审计（ADR-010）：每次工具调用一行（谁、哪个工具、成没成、耗时）、每次模型回复一行（模型、停止原因、耗时、输入/输出/缓存 token、成本） | `tail -n 20 <userRoot>/logs/tools.jsonl`；`grep '"ok":false'` 看失败的工具 |

`<userRoot>/logs/run/` 是后台命令（`run` 的 `background: true`）的地盘：每条命令一个 `<id>.json` 记录（**跑完就删**，留在那儿的都是没跑完的）+ 一份 `<id>.log` 全文。服务启动时会自动结账（活着的杀掉、死掉的在频道里留一句话），一般不用手动碰；要查「那条命令到底输出了什么」就 `cat` 对应的 `.log`（ADR-013）。

**一眼分辨两类事故**：

- `restart_limit` / `task_interrupted` = 任务连续重启超限，底座把这一轮结束了（1.5.0
  起不再挂起等 `retryTask`）。人还在、频道还在，但这一轮不会有输出；查 `report.reason`
  与 `restarts`，或者让他重做。
- `storage` / `migration_failed` = 库或迁移出了问题，这类不看日志就是瞎的。

不想 `ssh` 进去读文件时，直接问接口（`lastReport` 是最近一条**非良性**报告，没有就是
`null`；`task_outdated` 不算异常，会被跳过）：

```bash
curl -s localhost:7788/api/diag | jq
# {"lastReport":{"type":"task_interrupted","at":"2026-11-05T12:03:11.412Z",
#                "text":"任务连续重启超限，已结束（任务 `generation`#t-1，原因 restart_limit）"}}
```

字段只有 `type` / `at` / `text` 三个（契约见 [WEB-API](WEB-API.md) §14.2）。

要留档 stderr 就 `npm start 2>&1 | tee -a /tmp/aic.log`。

### 压缩（compaction）阈值

上下文窗口**不再写死 1,000,000**。启动时从 pi-ai 的模型目录取真实
`contextWindow`，**取不到就回落 128k**（`FALLBACK_CONTEXT_WINDOW`）——保守方向：
宁可早一点压缩，也不要等 provider 回 400。阈值按窗口算：

| 项 | 比例 | 说明 |
| --- | --- | --- |
| `reserve` | 15% | 留给「下一轮回复 + 工具结果」的空间 |
| `keepRecent` | 10%，底 8192 token，封顶阈值的一半 | 压缩后原文保留的尾部 |
| `background` | 5% | 后台任务更早触发，别把主对话挤爆 |

所以「128k 回落」的代价是：真·长上下文模型（1M）会被当成 128k 用，压缩来得比需要的早，
对话里更早出现「我记不清前面了」。症状是 agent 主动 `read_history` 变多。要修不是改代码，
而是在 `<appRoot>/settings.json` 里把模型写成 pi-ai 目录认得的名字（见 §3）。

## 8. 团队记忆怎么写

没有后台自动整理了（ADR-058 删掉了 `settle.ts` 与那套游标）。`teams/<slug>/memory.md` 只有两条写路径：

- 团队里的人或助理调 `remember(scope="team", …)`，一行一条追加；
- 直接 `file` 写 `teams/<slug>/memory.md`。

要整理就让谁在频道里说一声「整理记忆」，由人（或助理）按全员技能「记忆整理」去做。

## 9. 发布更新（自建更新源）

桌面端升级读一份 JSON 清单（`latest-mac.json` / `latest-win.json`）和同名的
`.sig`（Ed25519 签名，`scripts/update-manifest.ts` 生成），再按清单里的文件名去下 zip
（ADR-029）。服务端**原样发文件**就够：不改写 URL、不校验签名、不存库、不认账号（ADR-027）。
清单与签名是 `no-cache`，产物按文件名长缓存。

**默认源是本仓库的 GitHub Releases**（ADR-067）：`.github/workflows/release.yml` 把两个 zip、
清单与签名上传成同一个 release 的资产，客户端读
`https://github.com/kirer/Solo/releases/latest/download/`。下面这套自建静态目录仍然保留，
内网或不想依赖 GitHub 时用 `SOLO_UPDATE_URL` 指过去即可。

发布机上一个目录、一个只读服务：

```bash
# 1. 把产物放进一个目录（清单与签名怎么生成见 §10）
mkdir -p feed
cp release/Solo-*-arm64.zip release/Solo-*-x64.zip feed/
cp release/latest-*.json release/latest-*.json.sig feed/

# 2. 发出去
npm run update:serve -- --dir feed --port 8899 --host 0.0.0.0
# [feed] http://127.0.0.1:8899
# [feed] 目录：/…/feed
```

- `GET /` 列出目录里发布了什么（名字 + 大小），先看它再排查版本问题。
- 清单 `Cache-Control: no-cache`，产物 `immutable`（文件名带版本号，永不改）。
- 目录外的路径一律 404（含 `%2e%2e%2f` 这类编码穿越）。
- 客户端读地址的顺序：环境变量 `SOLO_UPDATE_URL` → `desktop/src/feed.ts` 的 `DEFAULT_FEED_URL`。
  发版前把默认值改成你的域名（见 §10），和这里发的地址保持一致即可。

**两条发布纪律**（顺序错了客户端会拿到一个点不动的清单）：

1. **二进制先传、清单最后传**：清单一旦能取到，客户端就立刻去下载它点名的文件。
2. **旧版本产物永不删**：已经装上的老客户端可能还在按上一份清单更新；回滚 = 把旧清单
   重新盖回去，产物还在才回得去。

局限（刻意不做，等真需要再加）：没有上传接口（跨机搬运用 `rsync` / `scp`）、没有鉴权、
没有 TLS 终止（前面挂 nginx / caddy）、没有 Range 断点续传（客户端整包下载）。

## 10. 桌面应用（Electron）

壳在 `desktop/src/`，打包配置是仓库根的 `electron-builder.yml`。**后端还是同一份源码**：
壳起一个子进程用 Electron 自带的 Node 跑 `src/shell/main.ts`，窗口加载
`http://127.0.0.1:<port>/?shell=desktop&platform=<platform>`（ADR-028）。

**标题栏**：macOS 用系统标题栏，红绿灯与窗口标题单独占顶上一条，界面从它下面开始
（ADR-088）；Windows 是 `hidden` +
40px `titleBarOverlay`，原生标题栏和菜单栏都不画，界面在顶上画一条 40px 的标题带，
菜单「Solo / 视图」在里面（ADR-069）。最小化 / 最大化 / 关闭仍是系统的，画在最右边；
`Ctrl+R` / `Ctrl+Shift+I` 由隐藏的原生菜单继续提供。标题带只在 Windows 桌面壳里出现，
浏览器与 macOS 不受影响。**窗口默认按桌面比例开**（1180×820，屏幕小时按工作区收；最小 360×560）：
界面本来就是单列（ADR-084），窄到 375×812 也成立，不用开浏览器模拟器看排版。**Windows 的真机行为（拖拽 / 贴边 / 高 DPI / 按钮颜色）没有在
本机验证过**，改这块要在 Windows 上手工过一遍。

**悬浮球（ADR-116）**：壳多开一扇透明窗，加载 `?orb=1` —— 那一页只画插件的 `overlays`
插槽。窗口置顶、跨桌面、不占 Dock / 任务栏；透明的地方点击穿透，鼠标移进球 / 面板里才接
点击；拖球由 `orb:drag` 把屏幕增量报给壳，位置存在 `<appRoot>/orb-window.json`。
菜单栏 / 托盘图标（macOS 用模板图 `desktop/trayTemplate*.png`）左键一下开关悬浮球，
右键是菜单（显示 / 隐藏悬浮球、打开 Solo、退出）。macOS 关主窗口后悬浮球留着；
Windows / Linux 关主窗口即退出（悬浮窗不会把进程留在后台）。

```bash
npm run desktop:dev     # 开发：临时 userData + 临时工作区，带开发者工具
npm run desktop:pack    # 只出目录（release/mac-arm64/Solo.app），验证打包最常用
npm run desktop:dist:mac   # 出 dmg + zip（zip 是更新载体）
npm run desktop:dist:win   # 出 NSIS 安装包
```

**包体积（ADR-068）**

`electron-builder.yml` 只保留 `en-US` / `zh-CN` / `zh-TW` 三个 Electron 语言包，排除
source map、SDK 的 `src/`、Google / Bedrock 的 SDK 链，以及 Solo 没 import 的
`pi-codemode` / `quickjs-wasi` / `photon`；`react` / `react-dom` 是 devDependencies
（Vite 已打进 `ui/web`）。2.0.7 实测：Windows 解包 478 → 362 MB、zip 164 → 141 MB、
NSIS 安装包 130 → 112 MB；macOS `.app` 410 → 296 MB、dmg 139 → 106 MB、zip 139 → 116 MB；
`Resources/app` 104 → 35 MB（其中 `node_modules` 101 → 33 MB）。

再往下就是 Electron 本体：`Solo.exe` / dll / pak / `icudtl.dat` 约 326 MB。**不要**为了再省
几十 MB 删 `dxcompiler.dll`、`vk_swiftshader.dll`、`ffmpeg.dll` 或 `LICENSES.chromium.html` ——
会坏 GPU / 媒体兜底或法律合规。以后要支持 Gemini / Bedrock，先把对应 SDK 从 `files` 的排除项里
放回来。`compression: maximum` 会让打包慢几分钟，属正常。

**第一次出 dmg 会卡**：electron-builder 要从 GitHub 下 `dmgbuild-bundle` / `7zip`，直连不通时
会停在 0 字节。走镜像或本机代理：

```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run desktop:dist:mac
# 或者 HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npm run desktop:dist:mac
```

下载过一次会缓存在 `~/Library/Caches/electron-builder/`，之后不再需要。

- **数据在哪（两个根）**：应用私有的是 `app.getPath("userData")`（macOS
  `~/Library/Application Support/solo`，Windows `%APPDATA%/solo`）—— 助理、提示词、插件、
  `settings.json`、`core.sqlite`、`uploads/` 都在里面；我的组织是 `~/.solo`
  （`members/`、`teams/`、`skills/`、`rules.md`、`logs/`）。后端日志在 `~/.solo/logs/core.log`
  （超过 5 MB 轮转一代）。**它不认仓库里的 `.solo-app/`**。
- **端口**：先试 7788（偏好按 origin 存，端口变就丢），被占（比如同时开着 `npm start`）
  自动退到随机端口。
- **开发态**两个根都在临时目录（`solo-desktop-dev-userdata` / `solo-desktop-dev-home`），删掉就干净重来，不碰真实的 `~/.solo`。
- **改完界面**照旧 `npm run ui:build`，然后在应用里「重新加载页面」（macOS 菜单栏 / Windows
  标题带的「视图」里，或 `⌘R` / `Ctrl+R`）—— 不用重启应用。
- **打包出来的版本号**就是根 `package.json` 的 `version`，`npm version` 改它。

**发布与升级（ADR-029：自签清单 + zip 替换，不用 Squirrel / NSIS 更新）**

不需要 Apple 开发者证书。发布机持有一把 Ed25519 私钥，清单由它签名；应用里只放公钥。

```bash
# 0) 只做一次：生成密钥对。公钥写进 desktop/src/update-key.ts（要提交），
#    私钥默认 ~/.solo-update-key.pem，权限 600，别提交、别外传、别丢 —— 丢了老客户端就再也升级不了。
npm run update:key

# 1) 打包（版本号来自 package.json 的 version）
npm run desktop:dist:mac     # release/Solo-<版本>-arm64.dmg + .zip
npm run desktop:dist:win     # release/Solo-<版本>-x64.exe + .zip

# 2) 生成清单 + 签名（每个平台一份）
npm run update:manifest -- --feed feed --version 2.0.1 \
  --file darwin=release/Solo-2.0.1-arm64.zip \
  --file win32=release/Solo-2.0.1-x64.zip

# 3) 把 zip、清单、.sig 一起放进 feed 目录（§9），二进制先传、清单最后传
```

**GitHub Actions 发版（默认路径，ADR-067）**

第一次只做一次：把发布机上的私钥放进仓库 secret（保存后不会再显示，也不会进日志）：

```bash
gh secret set SOLO_UPDATE_KEY --repo kirer/Solo < ~/.solo-update-key.pem
```

之后每次发版就是改版本、推标签：

```bash
npm version patch --no-git-tag-version   # package.json + package-lock.json 一起改
git commit -am "chore: 版本 2.0.9"
git push origin main
git tag v2.0.9                           # 必须和 package.json 的版本一致
git push origin v2.0.9                   # 触发 .github/workflows/release.yml
```

工作流顺序：`npm run check` + `npm test` → mac arm64 / win x64 并行打包 → 建 **draft**
Release → 先传二进制、最后传清单与 `.sig` → 正式发布。Windows 打包前会再跑一遍
`npm test`，把 `defaultUiDir` 这类只在 Windows 上暴露的路径问题拦在发布前。客户端读
`https://github.com/kirer/Solo/releases/latest/download/`（`desktop/src/feed.ts` 的
`DEFAULT_FEED_URL`），所以清单一定不能比二进制先可见。手动跑一次用 Actions 页面的
「Run workflow」，标签取 `package.json` 的版本 `v<版本>`。

- 标签和版本对不上会被工作流拦下；已经正式发布过的标签拒绝覆盖，要重发就升版本。
- 没有 Apple / Windows 代码签名证书，首次打开会有系统警告（和本地打包一样）。

- 应用读清单 `latest-mac.json` / `latest-win.json`，先验 `.sig`、再比版本、再下载、
  下完核对 sha512。任何一步不过都**不碰**这个版本。
- 安装由进程外脚本做：先写 ready 文件（主进程看到才退出）→ 等旧进程 / 同路径 `Solo.exe` 退出 →
  解包 → 旧包换新（失败挪回来）→ 重新打开。macOS 用 `sh` + `ditto`；Windows 优先用
  `%SystemRoot%\System32\tar.exe` 解包（比 `Expand-Archive` 快一个数量级），没有才退回后者，
  再用 `robocopy /MIR`。
- 解包后和替换后都核对 `resources/app/package.json` 的版本；不是清单里的版本就弹窗中止，
  不会把半套文件当新版本打开。整个过程从第一行写 `%TEMP%\solo-update.log`（等待 / 解包 /
  robocopy 退出码 / 提权 / 版本 / 启动），失败时日志路径也写在弹窗里。
- 重启（`app.relaunch`）前会显式**释放单实例锁**，正常退出则在 `will-quit` 释放；否则新实例
  可能撞上旧进程的锁，静默退出，表现成「点了没反应」。
- Windows 装在 Program Files 这类普通权限写不进去的目录时，替换失败会走一次 UAC 提权重试；
  用户拒绝或仍然失败时弹窗说明，不再静默打开旧版本。
- 更新源地址：`SOLO_UPDATE_URL` 环境变量优先，否则用 `desktop/src/feed.ts` 的 `DEFAULT_FEED_URL`
  （默认 `https://github.com/kirer/Solo/releases/latest/download/`；只认 https，或 http 的本机地址）。
  检查时机：启动 30 秒后一次，之后每 6 小时；
  「检查更新…」在 macOS 的系统菜单栏 / Windows 标题带的「Solo」菜单里，也在设置 → 「检查更新」
  （那一行显示当前版本，按钮发同一个动作；浏览器里没有桌面壳，只说明一句）。
- **macOS 左上角没菜单栏 / Dock 里没图标**：进程被系统注册成了 `UIElement`（accessory）。
  悬浮球的全空间置顶（`setVisibleOnAllWorkspaces(…, { visibleOnFullScreen: true })`）会触发它，
  所以 `main.ts` 的 `regularApp()` 在开窗前、建球后各要一次 `regular`（ADR-122）。
- **清单和包从哪儿取**：源还是 `…/releases/latest/download/`，但每次检查先问一次
  `api.github.com/repos/<owner>/<repo>/releases/latest`，按资产名换成
  `…/releases/assets/<id>`（带 `Accept: application/octet-stream`）再下 ——
  `github.com` 连不上而 `api.github.com` 能连的网络里，这才能更新（ADR-123）。API 不通就退回原地址；
  5xx / 429 / 网络错误重试两次。
- **下载走代理**：设置 → 更新 → 「更新代理」写 `settings.json` 的 `updateProxy`
  （如 `http://127.0.0.1:7890`，空 = 直连）。壳每次检查更新前重读这个键，用独立会话
  （`solo-update` 分区）下载清单和包 —— **只给更新用**，模型调用不走它（ADR-087）。
  改完不用重启，下一次检查就生效。
- **Windows 的 zip 替换：2.0.9 → 2.0.10 实测失败**（安装器十分钟没回来，手动启动仍是旧版本）。
  2.0.11 起改成 ready 握手 + `tar.exe` 解包 + 替换前后版本核对（ADR-070）；2.0.9 / 2.0.10
  客户端必须先手动装一次 2.0.11 的 `.exe`，之后的更新才走新脚本。快捷方式仍由首次安装的
  NSIS 建立，更新只覆盖程序目录。
- `package.json` 的 `version` 是应用版本，也是清单比较的对象；`dmg` 只给人手动装，更新用 zip。
