# 归档

这里放**不参与运行、但要留作证据**的东西。

日常开发与使用只需要看仓库根目录的 `src/`、`test/`、`ui/`、`docs/`。

---

## 内容

| 目录 | 是什么 | 为什么留着 |
|---|---|---|
| `spikes/` | 9 个可独立运行的脚本，验证 pi-durable 的每个关键机制（崩溃恢复、成本分账、分叉、升级链、会议、睡眠…） | 技术选型的**实证依据**。文档里所有标「实测」的结论都出自这里，可以随时复跑验证 |
| `reference/pi/` | Pi 官方 monorepo 的完整 git clone（v1.4.0，含 `packages/durable` 源码与 31 个测试示例） | 调研 `docs/research/03` 的原始材料。升级依赖时用它对比源码 |
| `examples/tank-battle/` | 系统自己产出的网页坦克大战（2603 行代码 + 32 个冒烟测试） | 端到端能力的证据。**可以直接双击 `index.html` 玩** |

---

## 怎么用

### 复跑验证脚本

```bash
cd archive/spikes
npm install        # 依赖已清理，需要时会重装
npm run all        # 9 个脚本全跑一遍，不需要 API key
```

### 玩那个游戏

```bash
open archive/examples/tank-battle/index.html
```

### 看 Pi 源码

```bash
cd archive/reference/pi
git log --oneline -3
ls packages/durable/src
```

⚠️ 这是独立的 git 仓库，不要在外层仓库里对它做提交操作。

---

## 关于空间

- `reference/pi` 约 114MB（含 `.git` 历史）。纯粹为了查阅，不需要时可以整个删掉——调研结论已经在 `docs/research/` 里了。
- `spikes/` 的 `node_modules` 已删除，需要时再 `npm install`。
