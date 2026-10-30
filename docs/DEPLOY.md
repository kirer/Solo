# 部署与访问

> 面向「把它跑起来、让手机/家里人也用」。接口细节见 [WEB-API](WEB-API.md)。

## 1. 运行形态

只有一个进程：`src/core/shell/main.ts`。它同时是：

- HTTP 服务（静态界面 `ui/web/` + 17 条 `/api/*` 路由）
- agent 运行时（SQLite + 后台任务）

没有反向代理、没有独立数据库服务、**没有鉴权层**。后端没有构建步骤（`node --experimental-strip-types`
直接跑 TS）；**界面有**：改 `ui/app/` 后必须 `npm run ui:build` 把产物写回 `ui/web/`（ADR-079）。
数据全在 `workspace/`：

```text
workspace/
  core.sqlite            # 频道、消息、会话、名册、沉淀游标（单进程独占锁）
  settings.json          # 模型接入配置（可选）
  agents/<slug>/         # 每个人：identity.md / memory.md / skills/
  teams/<slug>/          # 每个团队：README.md / memory.md
  skills/                # 公司层技能
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

**首次启动会做什么**：建 `workspace/` → 同步 `rules.md` 与公司层技能（《写技能》《找现成技能》
《工作规矩》《记忆整理》，缺的补上、改过的不覆盖）→ 若 `agents/` 里一个人都没有，播种「知言」
（含《立项》《招人》两份个人技能）→ 读模型配置 → 开会话 → 建公司频道。这个过程不产生对外
请求，模型不可用也能起来（只是 agent 不会回话）。

开机**不建私聊**：私聊只有我在界面上开的时候才存在，一个 agent 不进任何群也能活。团队频道
（`team:<slug>`）按 `teams/<slug>/README.md` 的成员投影，改完档案下一条消息就生效。

## 3. 模型接入

三种方式，优先级：环境变量 > `workspace/settings.json` > 本地网关默认值。

### 本地网关（默认）

```bash
# 默认就连 http://127.0.0.1:3425/v1，模型 auto/deepseek-v4.1-flash
npm start
```

需要本机有该网关在跑。换地址：

```bash
COMMANDCODE_BASE_URL=http://127.0.0.1:3425/v1 npm start
```

### 官方 API

```bash
AI_COMPANY_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... npm start
AI_COMPANY_PROVIDER=openai    OPENAI_API_KEY=sk-...    npm start
```

### settings.json

```json
{
  "models": {
    "default": "auto/deepseek-v4.1-flash",
    "custom": [
      { "id": "monotoo/gpt-6.1-sol", "provider": "openai-responses",
        "baseUrl": "https://api.example.com/v1", "apiKeyEnv": "MONOTOO_KEY",
        "contextWindow": 200000, "maxTokens": 32000, "label": "GPT-6.1 Sol" }
    ]
  }
}
```

`custom[]` 的每一项都是**新 provider**，`id` 里第一个 `/` 之前是 provider 名、之后是
模型名（ADR-021）。`apiKeyEnv` 是环境变量名，不写明文。

**排障第一招**：如果所有人都不回话，先看这个模型引用能不能解析。

```bash
# 看当前生效的模型
node --experimental-strip-types -e '
process.env.X=1; const {setupModels}=await import("./src/core/runtime/models.ts");
const m = setupModels(process.env, { workspace: "workspace" });
console.log(m.defaultModel, m.models.map(x=>x.id ?? x.modelId));'
```

错误信息 `Model <provider>/<id> is not available` = 引用对不上，改 `settings.json` 或
环境变量。历史事故：`settings.json` 里给**内置模型**改名，导致注册表出现两条同 id 的
provider，默认模型解析歧义后回落到 `no_model`，全公司静默不回复，界面上看不出任何错。
V2 已经删掉「覆盖内置模型」这整套机制，`custom[]` 只能新增。

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
- **`COMMANDCODE_BASE_URL=http://host.docker.internal:3425/v1`**：容器里的
  `127.0.0.1` 是容器自己，不是宿主机。用本地网关时必须显式指向宿主机。

工作区是命名卷 `ai-company-workspace`。想直接看到文件就改成 bind mount：

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
| agent 说话了，但回在别的频道 | `directory.wake` —— 他去「最后被叫到的那个频道」回话；我发的消息必须先把 wake 记下来再唤醒他 |
| 改了 `identity.md` 没生效 | 提示词每次发送前重新读盘，所以下一条消息就该生效。没生效说明改的是别人的文件 |
| 启动很慢 | 名册是不是每人一次 commit；`agents/` 里是不是有几百个目录 |
| 7788 端口被占 | `lsof -nP -iTCP:7788 -sTCP:LISTEN` |

日志直接打到 stderr，没有日志文件、没有轮转。要留档就
`npm start 2>&1 | tee -a /tmp/aic.log`。

## 8. 自动沉淀

**任何**一条新消息落在团队频道（`team:<slug>`）里后，都会叫团队管理员按公司技能「记忆整理」
判断「哪些要不要写进团队记忆」（`src/core/team/settle.ts` 的 `settleTeam`）。问完只记一笔
「在等确认」，**`teams/<slug>/memory.md` 真的变了才推进游标**（ADR-033）：管理员没写进去，
这批消息下次还会被看到。同一批在等确认期间不会重复催。这是正常行为，不是 bug。
找不到管理员（档案没写 `lead`）时游标照常推进，不阻塞别人。

失败时团队频道里会出现一条灰色 `note`「团队记忆整理失败（…）。这批消息下次再试。」——
它是系统留痕（`kind: "note"`），不唤醒任何人、不计未读。日志里另有 `[沉淀失败]` 一行。

如果 agent 忙，这个请求会用 `whenBusy: "followUp"` 排在当前这轮之后 —— 记忆整理不该
打断手头的事。
