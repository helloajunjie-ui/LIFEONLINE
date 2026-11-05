# src/ —— 前端源码

> 目标：把 3000+ 行的单文件游戏拆成"有边界、可单测、可替换"的模块。
> 打包：自带的迷你打包器（零依赖，保离线分发）。**没有引入 Vue**——`core/` 保持框架无关，将来要换 UI 层也不受阻。

---

## 目录

```
src/
├─ core/
│  ├─ content.js      内容层加载器 + 旧结构适配器（toLegacyCatalog 等）+ 热更新 applyPack
│  ├─ pathfind.js     纯函数 BFS（家 / 小区 / 邻居家共用）
│  ├─ rules.js        规则求值：cozy 公式、档位、衰减（表达式白名单）
│  ├─ version.js      版本握手：四套版本号、模块差异、热替换分类
│  ├─ environment.js  天气/光照/季节的确定性推导（seed + 天 + 分钟）
│  └─ clock.js        北京时间 / 世界钟换算（纯函数）
├─ net/
│  ├─ save-provider.js  存档服务：本地缓存 + 服务端同步 + 离线队列 + 冲突合并
│  └─ social.js         社区：排行榜 / 串门房间 / 访问计数
├─ content/
│  └─ generated.js    由 tools/build.mjs 生成（内联 content/*.json），**勿手改**
└─ version.generated.js  构建注入的版本信息，**勿手改**
```

`2.5D小屋.html` 里的游戏主体仍是一个大 `<script>`，但它已经：
- 不再内置家具/房型/风格/规则数据（改为 `HomeCore.content.*`）
- 不再自己实现 BFS 与装修度公式（改为 `HomeCore.pathfind` / `HomeCore.rules`）

后续按"一次搬一个系统"的方式继续拆分，每步都用 `node tools/test.mjs` 守回归。

## 构建

```bash
node tools/build.mjs     # content → generated.js → core.bundle.js → dist/2.5D小屋.html
node tools/test.mjs      # 无头回归（dist 与源码两套都跑）
```

产物：

| 文件 | 用途 |
|---|---|
| `dist/core.bundle.js` | 引擎核心包（经典脚本，暴露 `window.HomeCore`），供源码 HTML 引用 |
| `dist/2.5D小屋.html` | 单文件分发版（bundle 已内联），**双击即玩** |

> 直接双击根目录的 `2.5D小屋.html` 也能玩，但需要 `dist/core.bundle.js` 存在；
> 缺包时页面右下角会给出提示，而不是一堆 undefined 报错。

## 迷你打包器的语法约束

没有 npm/babel，所以只能处理受限 ESM。**违反约束会在构建时报错而不是静默产出坏包**：

| 允许 | 禁止 |
|---|---|
| `import { a, b } from './x.js';` | `import x from ...`（默认导入） |
| `export function f(){}` | `export default` |
| `export const x = ...` / `export let` | `export * from ...`（re-export） |
| `export { a, b };` | 动态 `import()`、循环引用 |

模块包装成 `__define(id, fn)` + 惰性 `__require(id)`，按需执行、结果缓存。

## 为什么 core/ 不依赖 Vue

模块边界带来的收益来自**单向依赖 + 显式契约**，不来自框架：

- `core/*` 零 DOM、零全局，可在 Node 里直接单测（也可被 Go 侧对齐口径）
- `content/*` 是纯数据，前后端同时消费
- UI 用 Vue 还是原生，只影响 `ui/` 那一层；换框架时 `core/*` 一行都不用改

> npm 现已可用（见 `架构升级方案_Go+Vue.md` §5.1），Vue + Vite 可选。
> 但"引擎不依赖框架"这条边界建议保留——否则单测要拖 DOM，服务端也没法复用规则。

## 测试

`tests/regression.js` 会被注入到页面里执行，覆盖四块：

1. **内容层接线**（C1–C8）：目录条数、字段映射、房型/风格/规则是否来自 content
2. **核心模块**（R1–R5）：cozy 公式、档位、表达式白名单、BFS 绕障与无解
3. **引擎整体**（E1–E6）：渲染、装修度、地毯可走、睡觉加成、存档往返
4. **云同步**（S1–S6）：合并策略、首传、token 复用、409 合并重推、断网排队后补推、远端更新接管

云同步测试用**假 fetch**（内存模拟服务端），不依赖网络，所以能稳定跑。

## 存档同步的三种状态

| 徽章 | 含义 | 触发 |
|---|---|---|
| 已同步 ✓（绿） | 本地与远端一致 | 推送成功 / 拉取成功 |
| 离线·已存本地（橙） | 服务端不可达，改动已写 localStorage，待补推 | fetch 失败/超时（5s） |
| 已合并 ✓（绿） | 检测到版本冲突，家具取并集后重推成功 | 409 |

冲突策略：**家具取并集**（两台机器摆的东西都不丢），数值与装修风格听 `savedAt` 更新的那份。
