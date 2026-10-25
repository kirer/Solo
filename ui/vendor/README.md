# ui/vendor

浏览器端第三方依赖，直接提交进仓库：运行时不访问 CDN，也不需要构建步骤。

## three.module.js

- 包：`three`（npm）
- 版本：`0.170.0`（r170，稳定版）
- 来源：`https://unpkg.com/three@0.170.0/build/three.module.min.js`
- 体积：691,648 字节（约 676 KiB，minified ES module，单文件无子依赖）
- 许可证：MIT（文件头保留 three.js 版权与 SPDX 声明）

为什么锁 r170：r171 起 `build/three.module.js` 拆成 `three.module.js` + `three.core.js`
两个文件；r170 是最后一批「单文件、可直接被浏览器 ES module 加载」的稳定版本，
vendor 进来只需要一个文件、一条相对 import。

升级方式：

```bash
curl -sS -o ui/vendor/three.module.js \
  https://unpkg.com/three@<version>/build/three.module.min.js
```

升级后需要重新过一遍 `ui/js/starfield.js` 用到的 API
（`WebGLRenderer` / `OrthographicCamera` / `Points` / `PointsMaterial` / `BufferGeometry` /
`BufferAttribute` / `Group` / `Color` / `Scene`），并重跑截图验收。
