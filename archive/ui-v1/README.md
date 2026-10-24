# 网页界面 v1（已归档）

这是改版前的单文件界面：`index.html` + `app.css` + `app.js`。

它被 `ui/` 下的模块化实现替换（`ui/css/{tokens,shell,graph,chat}.css` +
`ui/js/{app,org,edges,chat,markdown,format,icons,ask}.js`）。保留在这里只为了回看
旧版结构与交互，不再被服务端加载。

改版契约与模块边界见 `docs/design/WEB-UI-CONTRACT.md`。
