# 我的 2.5D 小屋（LIFEONLINE）

一款单文件的等距视角生活模拟小游戏：**经营自己的小屋，在小区里上班、买菜、交房租、串门装修**。
客户端是一个可以双击打开的 HTML，服务端是可选的 Go + SQLite 存档服务。

> 当前版本 **1.29.0** · 存档结构 **schema 14** · 门禁：客户端回归 305 项 / 服务端自测 67 项 / 内容校验 26 包全绿

## 直接玩

双击 `dist/2.5D小屋.html` 即可（单文件，引擎与内容都内联，离线可玩）。
存档自动保存到 `localStorage`；如果服务端在跑，会同时同步到云端。

想连服务端：

```bash
cd server && ./home-server.exe        # 127.0.0.1:8787，数据库 server/data/home.db
```

然后打开 `dist/2.5D小屋.html`。没开服务端也能玩，只是不会有排行榜和串门。

## 目录结构

```
2.5D小屋.html            客户端源码（开发时改这个，引用 ./dist/core.bundle.js）
src/                     引擎模块：content 加载器、寻路、规则、时钟、联网
content/                 内容层（唯一真相）：26 个 JSON 包
  catalog/                家具目录（19 件）
  house/                  房型、地板墙面风格、住址与房态
  maps/                   家 / 街区地图（分区、围栏、信箱、传送门）
  careers/                职业岗位（日薪、班次、任务）
  characters/             玩家外观、邻居 NPC
  rules/                  生存规则、经济规则、账单模板
  lottery/ vehicles/      双色球、车款
  business/               可承包的门面（门牌号、承包金、日收益）
  bank/ stock/            银行存款与贷款、六支股票的行情参数
  achievements/ ui/       生活目标、文案
assets/                   SVG 素材（家具）
tools/                    内容校验与打包、构建、无头回归、性能基准
  gen-furniture.py        家具 SVG 参数化生成器（统一等距几何，改家具走这里）
  sync-furniture-assets.py  把生成结果同步到 assets/furniture/
  sync-furniture-assets.py  把生成结果同步到 assets/furniture/
tests/regression.js       浏览器内回归（305 项）
server/                   Go + SQLite 服务端
dist/                     构建产物（单文件 HTML + 引擎 bundle）
```

## 怎么改

**改内容**（家具价格、工资、房价、账单周期、地图分区……）——只动 `content/` 下的 JSON，不用碰代码：

```bash
node tools/content.mjs validate   # 校验：引用完整性、数值合法性（V1–V4.15）
node tools/content.mjs all        # extract → validate → bundle（生成服务端用的 content.json）
node tools/build.mjs              # 生成 dist/core.bundle.js 与单文件 HTML
```

**跑回归**：

```bash
node tools/test.mjs               # dist 与 src 各跑一遍（305 项），用无头 Edge
node tools/test.mjs dist          # 只跑构建产物
cd server && ./home-server.exe -selftest   # 服务端接口自测（进程内 httptest）
```

**编译服务端**（改了 `main.go` / `schema.sql` 必须重编，`schema.sql` 是 `go:embed` 进去的）：

```bash
cd server
GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off go build -o home-server.exe .
```

详见 [`server/README.md`](server/README.md)（含本机 Go 工具链路径、代理污染、老库迁移的排错记录）。

## 设计要点

| 主题 | 做法 |
|---|---|
| **数据驱动** | 引擎不写死任何数值。加一件家具、一个岗位、一种账单，只加 JSON，校验器会在写错时拦下来 |
| **纯函数推导** | 房态（待售/待租/空置）、车流位置、红绿灯相位都由稳定散列或时间函数现算，服务端不必为 72 间空房各存一行 |
| **存档全自动** | 10 秒定时 + 关键动作即时存 + 关页面前补存；本地优先，防抖推云端，断网进队列 |
| **服务端不当真** | `data_json` 原样保留（新字段不丢），但 `cozy_score` 由服务端按内容重算，越界数值夹紧并标记 |
| **统一世界时钟** | 全服共用一个游戏日（默认 1 天 = 24 分钟真实时间），账单周期与「每天只能上一次班」都挂在它上面 |
| **经济闭环** | 上班（日薪 100–180）→ 吃饭/房租/水电/看病/买车/买房 → 卖车 60%、卖房 70%、卖家具 50% 回收 |
| **钱生钱** | 10 个门面可按月承包（¥1,200–26,000/月），期内每天结算净收益；**全局独占**由服务端 `businesses` 表保证，一个门牌只能有一个老板 |
| **收支账本** | 点金钱条打开：今日收入/支出/净额、近 7 天双色柱、当天分类结构、最近 12 条流水。全部收支走同一个 `credit/debit` 入口，记账不参与任何数值判定 |
| **银行与股市** | 民生银行：活期 0.2%/天（上限 50 万）、30/90 天定期、三档贷款（每天自动扣、逾期只扣情绪不没收房产）；证券营业部：6 支股票，价格由「股票序号+游戏日」稳定散列推导，同日全服一致、可复现 |

## 文档

- [`架构升级方案_Go+Vue.md`](架构升级方案_Go+Vue.md) —— 整体架构、存档分层、服务端设计
- [`内容数据架构设计.md`](内容数据架构设计.md) —— 内容包结构、校验规则、热更新
- [`游戏逻辑设计文档.md`](游戏逻辑设计文档.md) —— 玩法与数值演进（v1.1 → v1.7 变更记录）
- [`server/README.md`](server/README.md) —— 接口、数据表、并发控制、排错
