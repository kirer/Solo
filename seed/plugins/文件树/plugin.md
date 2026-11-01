---
name: 文件树
description: 右栏「文件」页签：看当前频道对应的工作区，点开图片 / markdown / 代码 / HTML 预览
---

# 文件树

给右栏加一个「文件」页签。它看的是**当前这个频道的工作区**：

- 私聊 → 那个人的 `members/<slug>/workspace/`；
- 团队频道 → `teams/<slug>/workspace/`；
- 全员频道没有工作区 —— 页签里写一句「这个频道没有工作区」，不画空树。

工作区在哪由内核回答（`api.scope(channelId)`），插件只拿到一个根目录。
**越界检查在插件里做完**：解析后必须仍在这个根下面（软链接再查一次）、
单文件 ≤ 1 MB、一次最多 400 条、深度最多 3 层。

- 图片给 data URL，HTML 只交给前端 `<iframe sandbox="">`，文本 / 代码 / markdown 给原文。
- 没有写权限：这个页签只读。

关掉它：`enabled: false`。
