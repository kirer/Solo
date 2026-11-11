# Solo

一个人 + 一个 AI 组织。**组织不是代码里的角色枚举，是磁盘上的一堆文件夹**：
每个人的身份、记忆、技能都是文本文件，随时可改、改了立刻就生效。

```
我 ── 直接对话 ── 助理 ── 助理招的人 ── 团队（一个频道 + 一份 README）
                    （组织是平的：没有上级，也没有团队负责人）
```

> **给接手维护的 AI / 人**：动手前先读 [AGENTS.md](AGENTS.md)。它写清了这个仓库的边界、
> 改代码前后必须跑什么、改了哪处该同步哪份文档。README 只负责「这是什么、怎么跑、怎么发版」。

## 它到底在解决什么

让一堆 agent 像一个团队一样运转，而不需要为每一个身份写一份代码：

- **身份是文件**：`~/.solo/members/<slug>/identity.md`。加一个人 = 加一个目录，不用改代码、不用重启。
- **提示词是投影**：模板在 `<appRoot>/prompt/*.md`（出厂在 `seed/prompt/`），每次发消息前从
  文件夹重新渲染（在哪个团队、同团队有谁、助理是谁、全员多少人、有哪些技能），不是启动时算好存起来。
  改文件或改措辞，下一条消息就变 —— 改文案不用编译。
- **能力是热的**：工具从注册表实拍，不分「管理层工具/成员工具」，现在是 9 个。
- **技能是文档**：要教 agent 一套做法就写 `SKILL.md`，不要写代码。
- **记忆在磁盘**：个人 `memory.md`、团队 `teams/<slug>/memory.md`。

两个根（`appRoot` = 这份安装自带的东西，`userRoot` = 我的组织）和全部路径规则只写在
[src/core/layout.ts](src/core/layout.ts)（ADR-030）。

## 快速开始

需要 Node ≥ 22.19。

```bash
npm install
npm start                 # http://127.0.0.1:7788
```

首次启动会在两个根（默认 `.solo-app/` 与 `~/.solo/`）里播种助理「Solo」（带《建立团队》《招人》
等个人技能）、全员层技能和五个出厂插件（模型管理 / 文件树 / Token 统计 / 悬浮球 / IM 机器人）。

**模型**：没有兜底模型 —— 没配就是没配，界面写「还没有配置模型」。装完打开界面按引导配置，
或写 `<appRoot>/settings.json`，或走环境变量（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）。
见 [docs/DEPLOY](docs/DEPLOY.md) §3。

桌面安装包在 [Releases](https://github.com/kirer/Solo/releases)：macOS arm64 出 dmg + zip，
Windows x64 出 NSIS 安装包 + zip；应用里「设置 → 检查更新」和 macOS 菜单栏的「检查更新…」都读这里。
桌面端由 `desktop/`（Electron 壳）拉起同一个后端，壳与后端只靠 `[core] http://…` 一行说话。

> 做实验别动真实数据：`npm start -- --app-root /tmp/x-app --user-root /tmp/x-home`。
> `~/.solo` 与 `.solo-app/` 是正在用的组织。

## 一次怎么用

1. 打开界面，在「全员」频道里跟助理说话。
2. 说「帮我做个贪吃蛇」——他会建一个团队、写 `teams/<slug>/README.md`。
3. 说「招个人写前端」——他会建 `members/<名字>/identity.md`，人立刻出现在界面上。
4. 团队频道里每条新消息先到助理，它在后台把相关的那条交给相关的人（频道里不显示「转交」）；
   组群（临时拉几个人）里每个人自己判断。成员拍不了板（花钱、超范围、改别人）就直接 @我，没有中间层。

## 目录

```
src/core/      内核（域）：路径 / 文档（markdown、身份、记忆、技能、提示词）/ 说话 / 消息流程 / 插件
src/app/       用例：读（快照、投影、轨迹）/ 人 / 团队 / 说话 / 上传 / 后台命令 / 诊断 / 重置
src/view/      契约层：只有 dto.ts，零 import
src/interface/ 唯一 import node:http 的地方：路由 / 静态资源 / SSE
src/shell/     装配与启动：assemble / wire（七段接线）/ serve / main / seed
ui/app/        网页界面源码（React + TS + Vite），构建产物在 ui/web/（别手改）
desktop/       Electron 壳：拉起后端 / 开窗 / 悬浮球窗与托盘 / 自动更新 / 打包
seed/          出厂内容：规矩 / 提示词模板 / 技能 / 助理身份 / 出厂插件
scripts/       边界检查 / 真模型冒烟与场景 / 提示词黄金渲染 / 更新清单与签名 / 改名迁移
test/          128 文件 / 1173 例（core 纯函数与装配、ui 纯函数与源码约定、desktop 更新与窗口）
docs/          概念、代码地图、界面稿、决策（ADR）、接口、部署、出厂契约
```

文件级清单与「我想改 X → 动这里」以 [docs/CODE](docs/CODE.md) 和 [AGENTS.md](AGENTS.md) §5 为准；
README 里的数字会漂，别拿它当准绳。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm start` | 起服务（`--port` `--host` `--app-root` `--user-root` `--no-seed`） |
| `npm run check` | 四份 tsc（根 / scripts / desktop / ui）+ 边界检查（唯 runtime 能碰底层库、分层不越界、路由必须有前端消费者） |
| `npm test` | 单测，128 文件 1173 例，<5s |
| `npm run prompt:check` | 提示词黄金渲染：确定性、插槽全填、每段 ≤12 行、模板里零工具名 |
| `npm run live` | **真实模型**端到端 13 项（会花 token；改了 agent 行为要连跑两次 13/13） |
| `npm run live:scenarios` | **真实模型**多 agent 场景（会花 token；`--list` 看场景） |
| `npm run ui:build` | 构建界面到 `ui/web/`（改完 `ui/app/` 必跑，产物一起提交） |
| `npm run desktop:dev` | 起桌面壳（开发态用临时两个根，不碰真实数据） |
| `npm run desktop:dist:mac` / `:win` | 本地打 dmg+zip / exe+zip（输出到 `release/`） |

提交前的最低要求：`npm run check && npm test` 全绿；改过界面还要看一眼（`npm start` 刷新或截图）。
完整清单在 [AGENTS.md](AGENTS.md) §3.2。

## 分支与协作

- **唯一开发分支是 `main`**（`kirer/Solo` 的默认分支）。历史分支 `V4` 和旧的 `master` 都已并入并删除；
  `V2` / `V3` 等旧分支只作存档，不要在上面开发。
- 小改动直接提交到 `main`；大改动可以开短分支、合回 `main` 后再删。
- 提交信息写「改了什么、为什么」；一次改动一套提交，别把不相干的混在一起。
- **`npm run ui:build` 同一时间只许一个人跑。** `ui/web/` 是跟着仓库走的构建产物：谁构建谁提交。
  两个人同时构建，产物里会混进对方没写完的源码 —— 打进去的 `RightPanel` 半成品没人看得出来，
  发出去就是真事故。要构建先在频道里发一声，等对方落完再动手。
- 文档同步是硬要求：改了行为就同步 `docs/` 与 AGENTS 那张表（见 AGENTS §3.3）。

## 发版

版本号是 `package.json` 的 `version`；**标签必须等于 `v<版本号>`**，否则 CI 的 publish 会拒绝。

```bash
# 1. 发版前检查（缺一不可）
npm run check && npm test
npm run ui:build                  # 改过 ui/app/ 才需要；产物一起提交
npm run live                      # 改过 agent 行为才需要；连跑两次都要 13/13

# 2. 升版本并提交（两个文件一起变）
npm version patch --no-git-tag-version     # 或 minor / major
git add -A && git commit -m "chore: 发版 X.Y.Z——一句话"

# 3. 打标签并推送（推标签就会触发打包发版）
git tag -a vX.Y.Z -m "Solo X.Y.Z"
git push origin main
git push origin vX.Y.Z
```

推上去之后 GitHub Actions 的「打包与发版」（[.github/workflows/release.yml](.github/workflows/release.yml)）会：

1. `verify`：`npm ci` → `npm run check` → `npm test` → 读出版本号；
2. `build-mac` / `build-win` 并行：各跑界面构建与 electron-builder，产出 dmg / zip / exe 与 zip；
3. `publish`：用仓库 secret `SOLO_UPDATE_KEY` 签两份更新清单（`latest-mac.json` / `latest-win.json`
   及 `.sig`）→ **先传二进制、最后传清单** → 把 Release 从 draft 改成正式发布并标 latest。

更新源就是这个仓库的 Releases（ADR-029 / ADR-067）。客户端检查更新时先问
`api.github.com` 要资产地址、再下载（ADR-123），所以弱网也能更新；「更新代理」只影响更新，
模型调用不走它。版本号只增不减；同一版本号重复发版会被拒绝，要重发请升版本。

**打包失败怎么办**

- 先在 Actions 页面看是哪个 job 红：`verify` 红是代码问题；`build-mac` / `build-win` 红多半是
  下载 Electron / electron-builder 辅助包时网络 504（workflow 已经用 npmmirror 的只读镜像取辅助包）；
  `publish` 红看日志里的清单签名与版本一致性检查。
- 重跑：`gh run rerun <run-id> --failed`（token 没权限时）删掉标签重建再推：
  `git tag -f -a vX.Y.Z -m "Solo X.Y.Z" && git push -f origin vX.Y.Z`。
- 打包只是发安装包，**不会**动 `main` 的代码；Release 正式发布后拒绝覆盖，必须升版本。

更多部署 / 局域网 / Docker / 排障见 [docs/DEPLOY](docs/DEPLOY.md) §9–10。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | **AI agent 在本仓库工作前先读这个**：边界、提交前检查、改了 X 该同步哪些文档 |
| [docs/CORE](docs/CORE.md) | 概念地基：组织为什么是文件夹、提示词怎么投影、消息怎么走、团队记忆怎么写 |
| [docs/CODE](docs/CODE.md) | 代码地图：「我想改 X → 动这里」 |
| [docs/DESIGN](docs/DESIGN.md) | 界面决策稿：每一屏长什么样、每个元素的数据来源 |
| [docs/DECISIONS](docs/DECISIONS.md) | 架构决策（ADR，只追加）：每条写了替代方案与理由 |
| [docs/WEB-API](docs/WEB-API.md) | 网页 API 的完整契约（先改文档再改代码） |
| [docs/DEPLOY](docs/DEPLOY.md) | 怎么跑、接模型、桌面壳与打包、更新源、排障 |
| [docs/CONCESSIONS](docs/CONCESSIONS.md) | 底座（pi-durable）做不到什么、我们怎么绕的 |
| [docs/design/SEED-CONTRACT](docs/design/SEED-CONTRACT.md) | 出厂内容契约：一条事实一个家、插槽表 |

## 已知不做

没有鉴权、没有登录、没有多租户；没有为每个身份写代码的能力模型（身份、技能、记忆一律是文件）；
不画后端没有的东西（界面上每个字段都有真实数据来源）。
