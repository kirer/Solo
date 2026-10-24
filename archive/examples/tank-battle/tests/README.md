# 测试说明

零依赖，均为原生 Node 脚本。

## 1. 逻辑冒烟（无需浏览器）

```bash
node tests/smoke.mjs
```

覆盖：关卡校验、开局流程、玩家移动/边界/砖墙、子弹与四类地形、高速子弹不穿墙、
过关、基地被毁、命数耗尽、3 关通关、暂停/重开、长跑无泄漏、localStorage 存档。
成功输出 `SMOKE OK (29 tests passed)`。

## 2. 浏览器冒烟（真实 Chrome）

```bash
# 终端 1：启动静态服务器
python3 -m http.server 8123

# 终端 2：跑浏览器冒烟（自动定位 Chrome / Edge）
node tests/browser-smoke.mjs
```

可用环境变量覆盖：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `GAME_URL` | 页面地址 | `http://localhost:8123/index.html` |
| `CHROME_PATH` | 浏览器可执行文件 | 自动探测 Chrome/Edge |
| `SHOT_DIR` | 截图输出目录 | `/tmp/tank-shots` |

输出 42 项断言结果与 5 张截图（菜单 / 关卡提示 / 暂停 / 失败 / 通关）。

> 注意：headless Chrome 在模拟按键后会停止产生合成帧，`requestAnimationFrame` 随之停摆。
> 因此浏览器冒烟分两类断言：
> - **真实接线**：页面加载、Canvas 渲染、真实键盘事件→键位表映射、可见按钮点击、控制台无 error；
> - **玩法逻辑**：用 `loop.tickOnce(1/60, { skipInputSync: true })` 以固定步长精确推进（与线上同一套 game-core）。
>
> 真实人工验证请在**正常（非 headless）浏览器**中双击 `index.html` 游玩。
