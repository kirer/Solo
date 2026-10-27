# 运维手册

本文档的每条命令都可以直接复制执行。

## 启动

```bash
cd /Users/kirer/projects/ai-company
npm install          # 首次运行
npm start            # 网页界面，自动打开浏览器
npm run tui          # 或者用终端界面
```

数据落在 `workspace/company.sqlite`，项目文件在 `workspace/projects/<slug>/`。

### 先看演示

```bash
node --experimental-strip-types scripts/seed-demo.ts
npm start -- --db workspace/demo.sqlite --workspace workspace/demo
```

生成一家有 2 个项目、7 名员工、1 条待拍板的公司（不调用模型，不花钱）。

### 网页界面打不开

1. 看终端里打印的地址，端口可能被占用后自动变了
2. 手动改端口：`npm start -- --port 8080`
3. 只想用终端：`npm run tui`

两个界面共享同一份数据，可以同时开。

### 换数据位置

```bash
npm start -- --db /path/to/company.sqlite --workspace /path/to/workspace --company "我的公司"
```

### 换模型

默认用本地 Command Code 网关。三种方式指定：

```bash
# ① 显式指定提供方
AI_COMPANY_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-... npm start
AI_COMPANY_PROVIDER=openai OPENAI_API_KEY=sk-... npm start

# ② 只设 key，自动识别
ANTHROPIC_API_KEY=sk-... npm start

# ③ 换本地网关地址或模型价格（价格填 0 时成本恒为 0）
COMMANDCODE_BASE_URL=http://127.0.0.1:3425/v1 \
COMMANDCODE_API_KEY=magpie \
COMMANDCODE_INPUT_PRICE=0.5 \
COMMANDCODE_OUTPUT_PRICE=1.5 \
npm start
```

**成本显示为 0 是正常现象**：本地网关账单未知，价格填 0 时 token 数准确但金额为 0。要真实金额，按网关账单设置 `COMMANDCODE_INPUT_PRICE` / `COMMANDCODE_OUTPUT_PRICE`（单位：美元 / 百万 token）。

### 检查网关是否可用

```bash
curl -sS http://127.0.0.1:3425/v1/responses \
  -H "Authorization: Bearer magpie" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto/deepseek-v4.1-flash","input":"ping"}' | head -c 200
```

## 备份

```bash
# 备份数据库与项目文件
tar -czf backup-$(date +%Y%m%d-%H%M).tar.gz workspace/

# 只备份数据库（项目文件通常已在 git 里）
cp workspace/company.sqlite backup-$(date +%Y%m%d).sqlite
```

**升级依赖前必须备份。** 底层库的 schema 迁移是单向的，迁移后旧版本打不开。

## 升级依赖

```bash
# 1. 备份
cp workspace/company.sqlite workspace/company.sqlite.bak

# 2. 改 package.json 里的精确版本号（不要用 ^）

# 3. 安装
npm install

# 4. 跑检查与测试（契约测试会验证规格里的每条行为仍然成立）
npm run check && npm test

# 5. 全绿才启动
npm start
```

若第 4 步失败，回退版本号并恢复备份。

## 排障

### 启动报 `no cwd` 或文件工具失败

某会话没有工作空间。检查 `workspace/projects/` 下对应目录是否存在；项目会话的目录在立项时创建。

### 员工显示「受阻：missing_task」

锚点任务定义没注册。这是代码问题，不是数据问题——确认 `bootstrapCompany` 与 `hireStaff` 都传了 `registry` 参数。

### 任务显示「受阻：restart_limit」

某任务连续崩溃 5 次被暂停。在界面任务面板可以看到，程序化重试：

```bash
node --experimental-strip-types -e "
import { openCompany, recover, retryParked, setupModels } from './src/runtime/index.ts';
const { models } = setupModels();
const rt = await openCompany({ databasePath: './workspace/company.sqlite', models, registry: (await import('./src/runtime/index.ts')).createRegistry() });
await recover(rt);
await retryParked(rt, 'TASK_ID');
await rt.close();
"
```

### 运行时因存储故障失效

日志里会有 `runtime-failed`。程序会自动重开（`watchForFailure`），重复投递靠请求标识去重。

手动恢复：

```bash
# 检查数据库完整性
sqlite3 workspace/company.sqlite "PRAGMA integrity_check;"
```

如果是**同时开了两个进程**导致的 `ID ... already belongs to entry`，先确认只剩一个进程：

```bash
lsof -nP -iTCP:7788 -sTCP:LISTEN
```

另一个进程写坏的通常是 `pi.live`（实时生成状态，短暂且可重建）。停掉所有进程后可以删掉它再启动：

```bash
sqlite3 workspace/company.sqlite <<'EOF'
DELETE FROM document_revisions WHERE document_id IN (SELECT id FROM documents WHERE kind='"pi.live"');
DELETE FROM documents WHERE kind='"pi.live"';
EOF
```

不要让两个进程同时打开同一个 `--db`：底层没有跨进程锁，除了 ID 冲突，还可能把文档 delta 写坏
（表现为 `PathError: unresolvable path: ["generation","message","content",...]`）。

### 员工一直卡在「运行中 / 等待输出…」

先看 `curl -s http://127.0.0.1:7788/api/org` 里谁在忙，再看会话流（`/api/conversations/:id/feed`）
里最后一条是什么。常见的两种：

- 工具真的跑很久（真模型 + 大文件写入）：看门狗会在超期后中断或重试，**同一条任务最多自动动手
  2 次**，之后如实标 error 并写一条 `app.alert` 进会话流（见 `docs/SYSTEM.md` §8）。
- 会话停在 `waiting`（工具中断后的僵住）：看门狗判定后中断一轮，下一条消息就能进去。

现在派活是 `assign_task`：建任务 + 发频道消息 + `deliver()` 投递，**投完立刻返回，不存在
跨会话同步等待**。工具卡在 `delegate_to_role` / `delegate_to_leader` 的情形是旧版本才会出现的
——那套同步派活（`delegation.ts` / `delegation-guard.ts`）已经整块删除，见 ADR-037。
如果升级前留下了卡死进程，重启一次即可（重启会把挂起的工具标成中断）；仍卡住时按上面的
`restart_limit` 或 `pi.live` 清理处理。

### 成本数字对不上

按顺序检查：

1. **模型价格是否为 0** → 成本恒为 0，token 仍然准确
2. **是否用了分叉会话** → 分叉从 0 计，父子分别统计（这是对的）
3. **是否混入了 compaction 成本** → 每次压缩尝试都计费，包括失败与过期的

### 员工一直无法自行拍板

这是设计如此：管理层的授权范围默认是「全部上转」。要让 CTO 自己拍板，需要在 `src/company/roles.ts` 的 `capabilityNames` 里给它 `decide`（默认已给），并调整它的 `charter` 说明可拍板范围。

### 员工拿不到工具

员工能力包的注册漏了。`hireStaff` 必须传 `registry` 参数，且 `employeeTools` 要显式给出（默认是空数组，最严格）。

## 数据文件说明

| 路径 | 内容 |
|---|---|
| `workspace/company.sqlite` | 全部会话、任务、文档、用量。**这是唯一真相源。** |
| `workspace/projects/<slug>/` | 项目工作空间：`PROJECT.md`、`PLAN.md`、代码、文档 |
| `workspace/*.sqlite-wal` `*.sqlite-shm` | SQLite 预写日志，不要手动删除 |

**不要手改 `company.sqlite`。** 它是底层库的持久化格式，结构由 schema 版本控制。要改数据，通过界面或代码调用 API。

## 并发限制

**一个数据库只能被一个进程打开。** 底层没有跨进程锁。同时开两个 `npm start` 会损坏数据。

需要并行运行时，每个进程用独立的 `--db` 路径。

## 卸载 / 重置

```bash
# 归档而不是删除（推荐）
mv workspace workspace-archive-$(date +%Y%m%d)

# 彻底重来（会丢全部历史）
rm -rf workspace/
```

## 迁移：把员工直属上级迁到项目负责人

**适用**：从「员工只能向管理层岗位汇报」的版本升级到支持 `leader:<slug>` 的版本之后，把存量员工迁到项目负责人名下。

**前提**：单进程单库——执行迁移前必须先停掉网页服务，否则两个进程会抢同一个库。

```bash
cd /Users/kirer/projects/ai-company

# 1. 停服
kill -TERM $(lsof -t -nP -iTCP:7788 -sTCP:LISTEN) 2>/dev/null || true
while lsof -t -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1; do sleep 0.2; done

# 2. 备份（库 + 项目产物）
cp workspace/company.sqlite "workspace/company.sqlite.bak-$(date +%Y%m%d-%H%M%S)"

# 3. 预演（不写库，只看会改什么）
node --experimental-strip-types scripts/migrate-staff-manager.ts \
  --db workspace/company.sqlite --project ops-defect-loop --dry-run

# 4. 执行（幂等，重复执行第二次为 migrated=0）
node --experimental-strip-types scripts/migrate-staff-manager.ts \
  --db workspace/company.sqlite --project ops-defect-loop

# 5. 校验（只读探针，0 FAIL 即通过）
node scripts/acceptance/reorg-probe.mjs --db workspace/company.sqlite --expect after

# 6. 起服
npm start
```

**回滚**：数据形状仍是字符串，旧版本代码能正常启动（只是把 `leader:<slug>` 显示成 `undefined`），所以回滚通常只需要回代码；要彻底复原再用备份覆盖 `workspace/company.sqlite`。

**注意**：迁移会重渲染员工提示词（把「直属上级是 COO」改成负责人姓名）。迁移期间不要同时跑真实任务；已归档员工不会被迁移。
