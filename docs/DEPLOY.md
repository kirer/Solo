# 部署与访问

> 面向「把它跑起来、让手机/家里人也用」。接口细节见 [WEB-API](WEB-API.md)。

## 1. 运行形态

只有一个进程：`src/core/shell/main.ts`。它同时是：

- HTTP 服务（静态界面 `ui/web/` + 19 条 `/api/*` 路由）
- agent 运行时（SQLite + 后台任务）

没有反向代理、没有独立数据库服务、**没有鉴权层**。后端没有构建步骤（`node --experimental-strip-types`
直接跑 TS）；**界面有**：改 `ui/app/` 后必须 `npm run ui:build` 把产物写回 `ui/web/`。
数据全在 `workspace/`：

```text
workspace/
  core.sqlite            # 频道、消息、会话、名册、沉淀游标（单进程独占锁）
  settings.json          # 模型接入配置（可选）
  agents/<slug>/         # 每个人：identity.md / memory.md / skills/
  teams/<slug>/          # 每个团队：README.md / memory.md
  skills/                # 全员层技能
  rules.md               # 全员规矩（每轮都进提示词）
```

**`workspace/` 是唯一的真相**。删掉数据库不会丢掉「人是谁」——从 `agents/` 重建即可；
反过来删掉 `agents/` 就没救了。备份先备份 `agents/`、`teams/`、`skills/`、`rules.md`。

## 2. 本机启动

```bash
npm start                      # = node --experimental-strip-types src/core/shell/main.ts
npm start -- --port 7811 --host 127.0.0.1 --workspace /tmp/aic-dev --no-seed
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 7788 | 监听端口 |
| `--host` | 127.0.0.1 | 监听地址；`0.0.0.0` = 局域网可访问 |
| `--workspace` | `<cwd>/workspace` | 数据目录（数据库、agents、teams、skills、rules.md 都在里面） |
| `--no-seed` | 关 | 不播种。首次启动且 `agents/` 为空时会自动建一个叫「知言」的人并给两份技能 |

启动成功会打印监听地址和局域网地址。Ctrl-C 退出。

**首次启动会做什么**：建 `workspace/` → 同步 `rules.md` 与全员层技能（《写技能》《找现成技能》
《工作规矩》《记忆整理》，缺的补上、改过的不覆盖）→ 若 `agents/` 里一个人都没有，播种「知言」
（含《建立团队》《招人》两份个人技能）→ 读模型配置 → 开会话 → 建全员频道。这个过程不产生对外
请求，模型不可用也能起来（只是 agent 不会回话）。

开机给**每个成员**补一条「我 ↔ 他」的私聊（幂等；`ensureOwnerDm`）：他的工作过程在那里看。
团队频道（`team:<slug>`）按 `teams/<slug>/README.md` 的成员投影，改完档案下一条消息就生效。

## 3. 模型接入

优先级（`src/core/runtime/models.ts` 的 `setupModels`）：

1. `workspace/settings.json` 里写了 `providers` → 用它；
2. 环境变量 `ANTHROPIC_API_KEY` → Anthropic（默认模型 `claude-sonnet-4-6`）；
3. 环境变量 `OPENAI_API_KEY` → OpenAI（默认模型 `gpt-5`）；
4. 都没有 → **没有模型**。服务照常起来、界面照常用，但 agent 不会回话；
   启动日志里会写一行「还没有配置模型」（ADR-023）。

配置文件优先于环境变量：只要 `settings.json` 里有非空 `providers[]`，就不会再看环境变量。

**为什么不给一只兜底模型**：以前第 4 条是「悄悄用本地网关」。没配的人看不出来自己没配 ——
界面一切正常，只是所有人都在用一只他没选过、也不知道存在的模型。现在宁可什么都不响。

### 本地网关（自己配一份）

本机有 `http://127.0.0.1:3425/v1`（OpenAI Responses 协议）这种网关时，在
`workspace/settings.json` 里写一份就是了，或者直接在界面「设置 → 模型 → 加一份本地网关」：

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
- `apiKey` 写在这个文件里（**不是**环境变量名），文件在 `workspace/` 下、已 gitignore。
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
const m = setupModels(process.env, { workspace: "workspace" });
console.log(m.defaultModel, m.models.getModels().map(x=>`${x.provider}/${x.id}`));'
```

错误信息 `Model <provider>/<id> is not available` = 引用对不上，改 `settings.json` 或
环境变量。历史事故：`settings.json` 里给**内置模型**改名，导致注册表出现两条同 id 的
provider，默认模型解析歧义后回落到 `no_model`，全员静默不回复，界面上看不出任何错。
V2 已经删掉「覆盖内置模型」这整套机制，provider 只能新增。

### 真实模型自测

单元测试不驱动生成，沟通跑偏只有真模型能测出来：

```bash
npm run live              # 出厂行为 16 项，需连续两次 16/16
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
不入库。两者都在 `mkdtemp` 工作区里跑，不碰 `workspace/` 真实数据。

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

工作区是命名卷 `solo-workspace`。想直接看到文件就改成 bind mount：

```yaml
volumes:
  - ./workspace:/app/workspace
```

Linux 上需要先 `mkdir -p workspace && sudo chown -R 1000:1000 workspace`（容器以
`uid 1000` 的 `node` 用户运行）。

镜像用 `node --experimental-strip-types` 直接跑源码，**不需要 `tsc` 构建**。`test/`、
`docs/`、`seed/` 不进镜像。

## 6. 备份与恢复

```bash
# 备份（数据库要在停服后拷，或者用 sqlite 的在线备份）
tar czf backup-$(date +%Y%m%d).tar.gz workspace/agents workspace/teams workspace/skills workspace/rules.md

# 恢复
tar xzf backup-20261027.tar.gz
```

`workspace/agents/`、`teams/`、`skills/` 是纯文本目录，可以直接 `git init` 进版本库
（仓库根的 `.gitignore` 忽略了 `workspace/`，如果想让它们进版本库要单独建仓库或改忽略）。

数据库 `core.sqlite` 里存的是频道消息、会话、名册、沉淀游标。丢了它等于丢掉全部聊天
记录，但人还在、频道会在下次启动时按 `agents/` + `teams/` 重建（消息没了）。

## 7. 排障

| 症状 | 先看这个 |
| --- | --- |
| 界面能开，但 agent 不说话 | §3 的模型解析；`tasks` 表里 `kind='pi.generation'` 的失败原因 |
| 这一轮为什么这么慢 / 他到底调没调工具 | `workspace/logs/tools.jsonl`：每次工具调用与每次模型回复各一行（成没成、耗时、token、停止原因） |
| agent 说话了，但回在别的频道 | `directory.wake` —— 他去「最后被叫到的那个频道」回话；我发的消息必须先把 wake 记下来再唤醒他 |
| 改了 `identity.md` 没生效 | 提示词每次发送前重新读盘，所以下一条消息就该生效。没生效说明改的是别人的文件 |
| 启动很慢 | 名册是不是每人一次 commit；`agents/` 里是不是有几百个目录 |
| agent 突然不干活了，日志里什么都没有 | `workspace/logs/runtime.jsonl` 有没有 `task_parked` / `restart_limit`（见下面「诊断三处」） |
| 报 provider 的 context overflow / 400 too long | 模型的 `contextWindow` 是不是取到了（见下面「压缩」） |
| 7788 端口被占 | `lsof -nP -iTCP:7788 -sTCP:LISTEN` |

### 诊断三处

服务本身的日志**只打 stderr**（没有进程日志文件）。另外有三份结构化日志，都在
`<workspace>/logs/` 下，都是「单文件 5MB、满了轮转成 `.1` 一代」（前两份单条再截 4KB）：

| 文件 | 装什么 | 怎么看 |
| --- | --- | --- |
| `runtime.jsonl` | 底座报上来的**运行报告**：`task_parked`（连续重启超限被挂起）、`session_failed`、`task_faulted`、`migration_failed`、`extension_error` 等，每条带 `at` / `kind` / `message`（中文人话）/ 可选任务 | `tail -n 5 workspace/logs/runtime.jsonl` |
| `jank.jsonl` | 浏览器自报的卡顿（长帧 > 240ms、长任务 > 200ms），带当时在干什么、是否切了后台 | `tail -n 5 workspace/logs/jank.jsonl` |
| `tools.jsonl` | 审计（ADR-010）：每次工具调用一行（谁、哪个工具、成没成、耗时）、每次模型回复一行（模型、停止原因、耗时、输入/输出/缓存 token、成本） | `tail -n 20 workspace/logs/tools.jsonl`；`grep '"ok":false'` 看失败的工具 |

`<workspace>/logs/run/` 是后台命令（`run` 的 `background: true`）的地盘：每条命令一个 `<id>.json` 记录（**跑完就删**，留在那儿的都是没跑完的）+ 一份 `<id>.log` 全文。服务启动时会自动结账（活着的杀掉、死掉的在频道里留一句话），一般不用手动碰；要查「那条命令到底输出了什么」就 `cat` 对应的 `.log`（ADR-013）。

**一眼分辨两类事故**：

- `restart_limit` / `task_parked` = 任务连续重启超限被底座挂起了，人还在、频道还在，
  但那个人此后不会再有输出。要么查 `message` 里的原因，要么让他重做。
- `storage` / `migration_failed` = 库或迁移出了问题，这类不看日志就是瞎的。

不想 `ssh` 进去读文件时，直接问接口（`lastReport` 是最近一条**非良性**报告，没有就是
`null`；`task_outdated` 不算异常，会被跳过）：

```bash
curl -s localhost:7788/api/diag | jq
# {"lastReport":{"type":"task_parked","at":"2026-10-30T12:03:11.412Z",
#                "text":"任务 \"daily-digest\" 被挂起：任务连续重启超限，已挂起"}}
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
| `background` | 5% | 后台任务（沉淀之类）更早触发，别把主对话挤爆 |

所以「128k 回落」的代价是：真·长上下文模型（1M）会被当成 128k 用，压缩来得比需要的早，
对话里更早出现「我记不清前面了」。症状是 agent 主动 `read_history` 变多。要修不是改代码，
而是在 `workspace/settings.json` 里把模型写成 pi-ai 目录认得的名字（见 §3）。

## 8. 自动沉淀

**任何**一条新消息落在团队频道（`team:<slug>`）里后，都会叫团队管理员按全员技能「记忆整理」
判断「哪些要不要写进团队记忆」（`src/core/team/settle.ts` 的 `settleTeam`）。问完只记一笔
「在等确认」，**`teams/<slug>/memory.md` 真的变了才推进游标**：管理员没写进去，
这批消息下次还会被看到。同一批在等确认期间不会重复催。这是正常行为，不是 bug。
找不到管理员（档案没写 `lead`）时游标照常推进，不阻塞别人。

失败时团队频道里会出现一条灰色 `note`「团队记忆整理失败（…）。这批消息下次再试。」——
它是系统留痕（`kind: "note"`），不唤醒任何人、不计未读。日志里另有 `[沉淀失败]` 一行。

如果 agent 忙，这个请求会用 `whenBusy: "followUp"` 排在当前这轮之后 —— 记忆整理不该
打断手头的事。

## 9. 发布更新（自建更新源）

桌面端升级读一份 JSON 清单（`latest-mac.json` / `latest-win.json`）和同名的
`.sig`（Ed25519 签名，`scripts/update-manifest.ts` 生成），再按清单里的文件名去下 zip
（ADR-029）。服务端**原样发文件**就够：不改写 URL、不校验签名、不存库、不认账号（ADR-027）。
清单与签名是 `no-cache`，产物按文件名长缓存。

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
壳起一个子进程用 Electron 自带的 Node 跑 `src/core/shell/main.ts`，窗口加载
`http://127.0.0.1:<port>/?shell=desktop`（ADR-028）。

```bash
npm run desktop:dev     # 开发：临时 userData + 临时工作区，带开发者工具
npm run desktop:pack    # 只出目录（release/mac-arm64/Solo.app），验证打包最常用
npm run desktop:dist:mac   # 出 dmg + zip（zip 是更新载体）
npm run desktop:dist:win   # 出 NSIS 安装包
```

**第一次出 dmg 会卡**：electron-builder 要从 GitHub 下 `dmgbuild-bundle` / `7zip`，直连不通时
会停在 0 字节。走镜像或本机代理：

```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run desktop:dist:mac
# 或者 HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890 npm run desktop:dist:mac
```

下载过一次会缓存在 `~/Library/Caches/electron-builder/`，之后不再需要。

- **数据在哪**：`app.getPath("userData")/workspace` —— macOS 是
  `~/Library/Application Support/solo/workspace`，Windows 是 `%APPDATA%/solo/workspace`。
  后端日志在 `.../solo/logs/core.log`（超过 5 MB 轮转一代）。**它不认仓库里的 `workspace/`**。
- **端口**：先试 7788（偏好按 origin 存，端口变就丢），被占（比如同时开着 `npm start`）
  自动退到随机端口。
- **开发态**连 userData 都在临时目录，删掉就干净重来。
- **改完界面**照旧 `npm run ui:build`，然后在应用里「重新加载页面」（⌘R）—— 不用重启应用。
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

- 应用读清单 `latest-mac.json` / `latest-win.json`，先验 `.sig`、再比版本、再下载、
  下完核对 sha512。任何一步不过都**不碰**这个版本。
- 安装由进程外脚本做：等应用退出 → 解包 → 旧包挪开、新包换进去（失败挪回来）→ 重新打开。
  macOS 用 `sh` + `ditto`，Windows 用 PowerShell `Expand-Archive` + `robocopy /MIR`。
- 更新源地址：`SOLO_UPDATE_URL` 环境变量优先，否则用 `desktop/src/feed.ts` 的 `DEFAULT_FEED_URL`
  （只认 https，或 http 的本机地址）。检查时机：启动 30 秒后一次，之后每 6 小时；
  「检查更新…」在应用菜单里。
- **Windows 的 zip 替换没有实机验证过**：快捷方式仍由首次安装的 NSIS 建立，更新只覆盖程序目录。
- `package.json` 的 `version` 是应用版本，也是清单比较的对象；`dmg` 只给人手动装，更新用 zip。
