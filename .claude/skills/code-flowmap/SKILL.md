---
name: code-flowmap
description: 给任意代码仓库生成一张自包含的代码流程图 HTML（零依赖、多语言）。自动扫描文件、按目录分模块、探测入口，画出「流程」（入口 → 调用顺序 → 分支，带静态条件、外部依赖、回环）与「结构」（模块 → 文件 → 类/函数 → 方法）两种视图；都是左→右、连线零交叉的树。每张卡片上方是中文短释、下方点击展开详情；固定 git commit，之后重跑即可标出新增/修改/删除；支持深/浅色主题。用户说「代码流程图 / 架构图 / 把代码画出来 / 看看所有代码 / 代码流程」时使用。
---

# 代码流程图（code-flowmap）

把一个仓库的代码变成一张可滚动、可搜索、可缩放的自包含 HTML。不依赖服务、不联网、
不用装解析器，双击就能看。

- **流程视图**：从真实入口出发的调用树。左→右就是执行顺序；每步带「第几步 / 发生条件 /
  文件行号」；解析不到的调用如实画成虚框「外部」；递归/回环用紫色标出。
- **结构视图**：完整的 模块 → 文件 → 类 / 函数 / 方法 树。
- 两种视图都是**左→右 tidy tree**，连线**构造性零交叉**（不是「看起来差不多」）。

## 一条命令

```bash
node .claude/skills/code-flowmap/flowmap.mjs
```

默认扫当前目录，输出 `<当前目录>/code-flow.html`。生成器会：

1. 按扩展名识别语言，扫源码（跳过 `.git`、`node_modules`、`dist`、`vendor`、`target`、
   `venv`、`__pycache__` 等；跳过压缩文件和 `.d.ts`）；
2. 抽 文件 → 类 / 结构体 / 接口 / 函数 / 对象 → 方法 / 嵌套函数；注释取第一句做中文短释；
3. 按顶层目录自动分模块（`src/core/channel`、`ui/app`、`scripts`…），自动配色；
4. 自动探测入口：`main` / `start` / `serve` / `cli` 等函数，`main.*` / `index.*` /
   `server.*` / `__main__.*` 等文件，以及文件顶层执行；都没有时退回「被调用最多」的函数；
5. 从入口展开调用树（默认深度 ≤7、节点 ≤700），带上静态条件和外部依赖；
6. 把当前 `git rev-parse HEAD` 钉进 HTML；下次重跑自动和**上一次出图**的 pin 对比，
   给新增 / 修改 / 删除的文件与声明打标。

## 支持的语言

零依赖的正则 + 括号/缩进启发式抽取，不调用编译器：

| 语言 | 扩展名 | 抽取 |
| --- | --- | --- |
| JavaScript / TypeScript | `.js .jsx .mjs .cjs .ts .tsx .mts .cts` | 函数、类、对象、方法、箭头函数、导入 |
| Python | `.py .pyw` | 函数、类、方法、docstring、相对导入 |
| Go | `.go` | 函数、方法（接收者）、struct、import |
| Rust | `.rs` | 函数、struct、enum、trait、impl 方法、use |
| Java / Kotlin | `.java .kt .kts` | 类、接口、枚举、方法、构造器、import |
| C# | `.cs` | 类、接口、结构体、方法、构造器、using |
| C / C++ | `.c .h .cc .cpp .cxx .hpp .hh .hxx` | 类/struct、函数、方法、`#include` |
| Ruby | `.rb .rake` | 类/模块、方法、无括号调用 |
| PHP | `.php` | 类、接口、trait、函数、方法、use |
| Swift | `.swift` | 类/结构体/协议/扩展、func、init |
| Dart | `.dart` | 类、函数、构造器、import |
| Lua | `.lua` | 函数、`require` |
| Shell | `.sh .bash .zsh` | 函数、`source` |
| R | `.r .R` | 函数、`source` |
| Elixir | `.ex .exs` | defmodule、def/defp、alias/import |

`node flowmap.mjs --langs` 打印当前支持的扩展名。

## 常用参数

```bash
node .claude/skills/code-flowmap/flowmap.mjs --root /path/to/repo   # 指定仓库
node .claude/skills/code-flowmap/flowmap.mjs --stats                # 只打印统计与入口
node .claude/skills/code-flowmap/flowmap.mjs --sample               # 每个模块抽 3 个文件看摘要
node .claude/skills/code-flowmap/flowmap.mjs --base <sha>           # 固定基线做 diff
node .claude/skills/code-flowmap/flowmap.mjs --no-diff              # 不做 git 对比
node .claude/skills/code-flowmap/flowmap.mjs --out /tmp/x.html
node .claude/skills/code-flowmap/flowmap.mjs --config .flowmap.json
node .claude/skills/code-flowmap/flowmap.mjs --langs
```

**增量更新**：每次生成把当时的 HEAD 钉进 HTML。下次有新提交后直接重跑，基线自动取旧 HTML
里的 pin，所以「改了什么」是相对**上次出图**。想固定一条基线就用 `--base`。

## 配置（可选）

自动探测够用；想控制标题、分组、入口或文件摘要时，在仓库根放 `.flowmap.json`
（或 `flowmap.config.json`，或用 `--config` 指定）：

```json
{
  "title": "我的项目",
  "include": ["src/**", "packages/**"],
  "exclude": ["**/generated/**", "**/*.gen.ts"],
  "groupDepth": 2,
  "groups": [
    { "id": "core", "title": "核心", "color": "#c2410c", "dirs": ["src/core"] },
    { "id": "ui", "title": "界面", "color": "#0f766e", "dirs": ["ui/app/src"] }
  ],
  "entries": [
    { "file": "src/main.py", "name": "main", "title": "启动" },
    { "file": "scripts/build.ts", "title": "构建脚本（文件顶层）" }
  ],
  "docMap": "docs/CODE.md",
  "maxFlowDepth": 7,
  "maxFlowNodes": 700,
  "maxFlows": 12
}
```

| 字段 | 作用 |
| --- | --- |
| `title` | 页面标题；不填就用 `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` 的名字 |
| `include` / `exclude` | 路径 glob；`*` 不跨目录，`**` 跨目录 |
| `groupDepth` | 自动分组取目录前几段；0 = 智能判断 |
| `groups` | 手工分组：`dirs` 或 `files`，按数组顺序排列；没归进去的进「其他」 |
| `entries` | 手工入口：`file` + 可选 `name`；没有 `name` 就是文件顶层执行 |
| `docMap` | 一张 markdown 表，第一列路径、第二列摘要；文件摘要优先取它 |
| `maxFlowDepth` / `maxFlowNodes` / `maxFlows` | 流程展开深度、单条流程节点上限、最多几条流程 |
| `maxFileBytes` | 单文件大小上限，默认 2 MB |

`docMap` 表格示例：

```markdown
| 文件 | 作用 |
| --- | --- |
| `src/main.py` | 进程入口：读配置 → 建服务 → 监听 |
| `src/store.py` | 内存存储 |
```

## 为什么线不会交叉

布局是**左→右的 tidy tree**（Reingold–Tilford 的横向版）：

- 每棵子树占一条**连续、互不重叠的纵向带**；父节点在自己的带内，孩子按阅读顺序自上而下排。
- 连线走正交折线：父右侧 → 竖直干线 → 每个孩子的左侧，全部落在两列之间的专属走廊里。
- 兄弟子树的纵带不相交，所以不同父节点的干线/支线在 y 上也不相交 → **零交叉**。
  这是构造保证，不是「看起来差不多」；`template.html` 里的 `band()` / `place()` /
  `drawEdges()` 就是全部。

跨文件依赖**不画线**（任意 DAG 画在平面上必然交叉），放在卡片详情里当可点标签；
点一下会滚到目标文件并闪烁。这样「树线」永远干净，「依赖网」靠交互查。

## 流程视图怎么读、边界在哪

- 树根是一条流程的入口（函数，或文件顶层执行）。
- 每个节点是**一次调用**：`第 N 步` 是它在父函数里的调用顺序；橙色小签是**静态**条件
  （`当 …` / `否则` / `case …` / `出错时` / `收尾` / `循环`），不是运行时真值。
- **虚框 + 「外部」**：调用名解析不到源码（注入依赖、标准库、第三方模块）。
  如实留成叶子，不猜、不连假线。
- **紫色「回环」**：这个函数已在祖先链上出现（递归或互相调用），到此为止。
- 只收**调用**，不画纯赋值 / return；同一函数里的重复调用去重。
- 入口是启发式：`main` / `start` / `serve` / `cli` / `entry`，以及 `main.*` / `index.*` /
  `server.*` / `cli.*` / `__main__.*` / `manage.*` / `wsgi.*` / `asgi.*` 文件。
  自动选错时用配置里的 `entries` 覆盖。
- 解析顺序：同文件 → 导入表 → 同目录 → 全仓库唯一同名。接收者是普通局部变量时拿不到类型，
  只有同名方法全仓库唯一才敢连；否则留成外部。
- 深度 / 节点超限会在卡片底部标「已省略」。

## 界面约定

- 卡片结构固定：**中文短释在上 → 名字在下 → 「详情 ＋」在底**。点「详情」原地展开
  （签名、全文注释、行号、调用了谁、类型、依赖/被依赖、测试用例），再点收起。
- 顶部：**流程 / 结构**切换、搜索（`/` 聚焦，回车跳到第一个命中）、仅文件（只在结构视图可用）、
  缩放、图例（流程视图是流程签 + 步数；结构视图是模块签，第一次点跳过去、第二次点隐藏）、
  diff 徽标。
- 缩放：按钮或 **Ctrl / ⌘ + 滚轮**（以光标为中心，30%–250%）；**按住图上拖动可平移**
  （按钮/链接除外），右下角说明面板本身也能拖。
- 颜色按模块（流程签统一用强调色）；连线颜色取子树所属模块。
- **深 / 浅色主题**：右上角 ☾ / ☀ 切换；首屏跟随系统 `prefers-color-scheme`，手动切过就记在
  `localStorage["flowmap-theme"]`。所有颜色走 `:root` / `:root[data-theme="dark"]` 的 CSS 变量；
  深色下模块色会朝白色混 40%，保证边框、图例和连线不发闷。新增颜色时不要写死，先加变量。
- 左下角列出本次删掉的项；右下角是连线规则的说明（可关）。

## 数据与改哪里

| 想改 | 动这里 |
| --- | --- |
| 支持新语言 / 改声明正则 | `languages.mjs` 的 `PROFILES`（每个 profile 有 `classes/types/objects/functions/methods`，正则第 1 组必须是名字） |
| 注释 / 字符串剥离、括号/缩进块边界 | `languages.mjs` 的 `stripSource` / `blockEnd` / `bodyInfo` |
| 条件识别（if / else / switch / try / loop） | `languages.mjs` 的 `CONTROL` / `controlOf` / `conditionMap` |
| 导入解析 | `languages.mjs` 的 `parseImports` + `flowmap.mjs` 的 `resolveSpec` |
| 自动分组 / 配色 | `flowmap.mjs` 的 `groupKey` / `buildGroups` / `PALETTE` |
| 入口探测 | `flowmap.mjs` 的 `ENTRY_FILES` / `STRONG_ENTRY_NAMES` / `WEAK_ENTRY_NAMES` / `detectEntries` |
| 调用解析（`this.x` / 导入 / 同目录 / 同名） | `flowmap.mjs` 的 `resolveCallee` / `collectSites` / `fileSites` |
| 流程展开的深度 / 节点上限 | 配置 `maxFlowDepth` / `maxFlowNodes` / `maxFlows` |
| 文件级摘要 | 配置 `docMap`（一张 markdown 表）；没有表项才回退文件头注释 |
| 类/函数/方法的中文短释 | 源码里的 JSDoc / 行注释 / Python docstring（生成器只认注释，不猜语义） |
| 卡片长什么样、交互、布局 | `template.html`（CSS + 渲染 / 布局 / 搜索 / diff 展示） |

注意：

- **不写假数据**：没有注释就如实显示「（源码无注释）」+ 签名派生的一句话，不编业务含义。
- 摘要只取注释第一句（≤72 字）；全文留在详情里。
- 这是启发式抽取，不是编译器：动态调用、`eval`、运行时分发、跨语言 FFI 解析不到，
  会如实留成「外部」；JSX 组件如果没有显式函数/类声明，只按文件顶层执行处理。
- 测试文件进结构视图，但不作为流程入口；`isTestPath` 认 `tests/`、`__tests__/`、
  `*.test.*`、`*.spec.*`、`*_test.*`、`*Test.java` 等。
- 生成物默认叫 `code-flow.html`，建议加进 `.gitignore`（每个仓库自己决定）。

## 验收（每次改完生成器都跑）

```bash
node .claude/skills/code-flowmap/flowmap.mjs --stats
node .claude/skills/code-flowmap/flowmap.mjs
```

然后在浏览器里：

1. 控制台无报错；流程视图默认打开，「流程签」数量 = 生成器打印的流程数，`.node` 数量 =
   该流程步数 + 1；切到结构视图后 `.node` 数量 = 文件 + 声明 + 方法 + 模块 + 1；
2. 两种视图都：节点两两不重叠；
3. 两种视图都：所有 `#edge-g path` 的线段两两不相交（正交线段检查：横线 y 穿过竖线 x
   且都在内部才算交叉）；
4. 点开任意卡片详情能展开/收起；搜索只搜当前视图、回车能跳；流程签切换会重排；
   结构视图的模块图例能跳转与隐藏，文件详情里的「依赖 / 被依赖」标签能切到目标文件；
5. 深浅色各看一遍：正文、路径、条件签、代码签名块、虚框「外部」卡都清楚可读，刷新后主题保持；
6. 换一个 `--base` 能看到 diff 徽标和节点上的「新增/改动」。

一段可直接粘进控制台的零交叉检查：

```js
(() => {
  const rects = [...document.querySelectorAll('.node')].map(n => n.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], b = rects[j];
    if (a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5) overlaps++;
  }
  const segs = [];
  for (const p of document.querySelectorAll('#edge-g path')) {
    const toks = (p.getAttribute('d') || '').match(/[MHVmhv]|-?\d+(?:\.\d+)?/g) || [];
    let x = 0, y = 0, i = 0;
    while (i < toks.length) {
      const t = toks[i++];
      if (t === 'M' || t === 'm') { x = +toks[i++]; y = +toks[i++]; }
      else if (t === 'H' || t === 'h') { const nx = +toks[i++]; segs.push([x, y, nx, y]); x = nx; }
      else if (t === 'V' || t === 'v') { const ny = +toks[i++]; segs.push([x, y, x, ny]); y = ny; }
    }
  }
  let cross = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [x1, y1, x2, y2] = segs[i], [x3, y3, x4, y4] = segs[j];
    const v1 = x1 === x2, v2 = x3 === x4;
    if (v1 === v2) continue;
    const [vx, vy1, vy2, hx1, hx2, hy] = v1 ? [x1, y1, y2, x3, x4, y3] : [x3, y3, y4, x1, x2, y1];
    if (vx > Math.min(hx1, hx2) + .01 && vx < Math.max(hx1, hx2) - .01 &&
        hy > Math.min(vy1, vy2) + .01 && hy < Math.max(vy1, vy2) - .01) cross++;
  }
  console.log({ nodes: rects.length, overlaps, segs: segs.length, cross });
})()
```

## 文件

```
.claude/skills/code-flowmap/
  SKILL.md       本文件
  flowmap.mjs    扫仓库 / 分组 / 入口 / 调用解析 / 流程展开 / git pin+diff / 写 HTML
  languages.mjs  多语言抽取层（零依赖；注释、块边界、声明、导入、条件）
  template.html  样式与全部前端逻辑（__FLOWMAP_JSON__ 注入数据）
```

Node 18+，无第三方依赖。产物是单个 HTML，数据内嵌在
`<script id="flow-data" type="application/json">` 里。
