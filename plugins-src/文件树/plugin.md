---
name: 文件树
description: 资料表里的「工作空间」一行：点开是右侧工作台，标签页里翻目录、看文件、开浏览器
permissions: system.reveal, system.open, system.copyText
---

# 文件树

资料表里加一行「工作空间」。点开的是**右侧一列工作台**（`dock` 插槽，和对话并排），
上面一排标签页：

- `文件` —— 当前频道工作区的目录树，顶上一条路径（`api.scope` 给的根）+ 刷新；
- 每个打开的文件一页：路径 / 大小 / 时间 / 类型徽章，下面是内容；
- `+` 打开开始页：工作区文件、浏览器；
- 正文里点到的外链也开成浏览器页签（后退 / 前进 / 刷新 / 地址栏 / 在系统浏览器打开）。
  网页在**桌面壳里用 `<webview>`** 打开（独立进程，站点拦不住）；网页版没有 webview，
  退回 iframe —— 百度、GitHub 这类站点会拒绝被嵌，页面里会直说白屏是站点拦的。

工作区看的是**当前这个频道**的：

- 私聊 → 那个人的 `members/<slug>/workspace/`；
- 团队频道 → `teams/<slug>/workspace/`；
- 全员频道没有工作区 —— 页面里写一句，不画空树。

工作区在哪由内核回答（`api.scope(channelId)`），插件只拿到一个根目录。
**越界检查在插件里做完**：解析后必须仍在这个根下面（软链接再查一次）、
单文件 ≤ 1 MB（图片 ≤ 8 MB、媒体 ≤ 32 MB）、一次最多 400 条、深度最多 3 层；隐藏文件与
`node_modules` 不列，软链接列出来但不跟。

## 图标按后缀分

目录是文件夹，文件按后缀换形状和颜色，认不出的画通用文件图标（不装懂）：

| 类 | 后缀 | 颜色 |
| --- | --- | --- |
| 代码 | `ts tsx js jsx mjs cjs json jsonl css scss less py rb go rs java kt c h cpp hpp cs php swift sh bash zsh sql html htm vue svelte` | 蓝 |
| Markdown | `md markdown mdx` | 灰 |
| 图片 | `png jpg jpeg gif webp bmp avif svg ico` | 绿 |
| PDF | `pdf` | 红 |
| 音频 | `mp3 wav ogg oga m4a aac flac opus` | 紫 |
| 视频 | `mp4 m4v webm ogv mov` | 橙 |
| 数据 | `csv tsv yml yaml toml xml ini conf env log` | 青 |
| 压缩包 | `zip gz tgz tar rar 7z dmg pkg exe` | 棕 |

页签上的小图标用同一张表。分类**只决定画什么**，不决定能不能预览 —— 能不能放由后端说。

## 预览：能用的现成渲染器就用

| 类型 | 怎么画 | 谁来渲染 |
| --- | --- | --- |
| Markdown | 宿主渲染器（`ui.markdown`） | 宿主 |
| 文本 / 代码 | `<pre>` | 浏览器 |
| 图片 | `<img src="data:…">` | **浏览器** |
| PDF | `<iframe src="data:application/pdf…">` | **浏览器自带 PDF 阅读器** |
| 音频 | `<audio controls src="data:…">` | **浏览器** |
| 视频 | `<video controls src="data:…">` | **浏览器** |
| HTML | `<iframe sandbox="">`（不给脚本、不给同源） | 浏览器 |
| 其余 | 一句「这种格式不支持预览，用系统默认程序打开」+ 大小 | —— |

媒体与 HTML 的内容由 `GET /api/p/files/raw` 搬成 data URL —— **本插件里一行渲染代码都
没有**。为什么不是一条发字节的路由：插件路由的返回值只有 JSON，发不出 `Content-Type`
和原始字节；data URL 是同一套守卫下的等价物。

目录第一层有图片时，树上多一行「看这一层的图（N）」：一次搬最多 40 张，摆成网格。
这是唯一一处多文件预览。

## 快捷操作

文件页右上四颗：

- **复制路径**、**复制文件名** —— 前端剪贴板（`navigator.clipboard`，失败退回
  `execCommand`），不经后端。
- **在访达里显示**（`system.reveal`）、**用系统默认程序打开**（`system.open`）——
  走内核的 `api.system.act`：插件只报**工作区相对路径**，绝对路径由内核拼、由它
  `realpath` 复判、由它拒软链接与目录。插件这一层从头到尾没有路径字符串可用。
- **转成附件发出去** —— 走宿主已有的 `POST /api/files/stage`；转完的文件进输入框。

## 它要的权限

```yaml
permissions: system.reveal, system.open, system.copyText
```

三条，缺一不可：

- **`system.reveal`** —— 在访达 / 资源管理器里显示一个文件；
- **`system.open`** —— 用系统默认程序打开一个文件（不收目录）；
- **`system.copyText`** —— 把一段文字放进剪贴板（只写不读）。

**默认全不给**：清单里没写、或者写了但没批准，`api.system.act` 一律抛错，不会静默变成
「什么都没发生」。批准记录在同目录 `plugin.md` 头的 `granted:` 里，界面点「全部批准」和
用编辑器手改那一行是同一件事。

插件升级后如果 `permissions` 多了新的条目，**新增的那几条要重新问一遍**，已批过的不再问。

能做什么、做不到什么，都由内核定，不是由这个文件定：本事（readme 里怎么写）管不了
「能不能开」，只有 `permissions` + `granted` 管得了。

## 这一页做不了什么

- 没有写权限：只读。
- 不能打开文件夹（`open` / `reveal` 只收文件）——挡的是「拿工作区根去打开并顺手往上翻」。
- 不能开任意 URL：宿主根本没实现 `system.openUrl`。
- 不能执行命令：一个 exec 类的动作都没有。

没有写权限：这一页只读。

关掉它：`enabled: false`。
