# 「我的 2.5D 小屋」架构升级方案（Go + Vue）

> 文件名保留历史称呼。**Vue 最终未采用**（原因见 §1），实际形态是「Go 服务端 + 原生模块化前端 + 单文件产物」。
> 版本：v2.2（2026-11-05 收尾更新）
> 现状：`src/` 已模块化 + 单文件构建产物 `dist/2.5D小屋.html`；Go 服务端已落地（SQLite，56 项自测）；内容层 20 个包；回归 201 项
> 目标：数据落库（服务端为唯一真相）、前端模块化、支持多玩家与跨端同步
>
> **读法提醒**：本文 §0–§5 是 2026-11-05 上午的推演稿，部分数字（包数、测试数、M1 状态）已被实现超越；
> **进度与结论以 §0.1 和 §6 的表格为准**，历史推演保留是为了记录"为什么这么定"，不是现状。

---

## 0. 先把问题说准：确实要升级，但升级的理由要分清

| 你提到的 | 实际情况 | 结论 |
|---|---|---|
| 数据存网页，会被玩家改 | localStorage **可被玩家用 DevTools 任意篡改**，且只存在于他自己的浏览器；换设备/清缓存即丢失，无法校验、无法回滚 | ✅ 必须服务端存储，`saves` 表为唯一真相 |
| 多玩家 | 现在每个浏览器各存一份，玩家之间**根本看不到彼此**，谈不上"被改"；要做邻居互访、排行榜、好友串门，必须共享存储 | ✅ 需要后端 |
| 页面要模块化 | 3175 行 JS 塞在一个 `<script>` 里，渲染/逻辑/UI/存档互相直连，改一处要通读全局 | ✅ 需要拆分 |

**但有一点要纠正**：这属于**架构迁移（重构）**，并非简单升级。端到端语义变了——存档从"浏览器本地"变成"服务端真相 + 本地缓存"。
不过实际落地时**保住了"双击 HTML 即玩"**：单文件产物仍自带一份内容与 Local provider，断网照常玩，联网后自动补推同步。
所以方案的核心原则是：

> **不要重写游戏内核，只做"搬家 + 分层"。** 等距渲染、BFS、家具系统、SVG 素材这 2000 多行是资产，原样保留；
> 真正新写的是"服务端 + 数据层 + 同步层 + 内容层"。

---

## 0.1 进度快照（唯一进度看板，2026-11-05 23:00）

| 层 | 落地形态 | 状态 | 怎么验证 |
|---|---|---|---|
| 内容层 L1 | `content/` **20 个包**（catalog 19 件 / interaction 13 动词 + 10 预留 / house 3 房型 + 4 地板 + 4 墙面 / maps 2 / characters 3 / rules 2 / environment 3 / careers 11 岗位 / achievements 15 目标 / ui 1） | ✅ 完成 | `node tools/content.mjs validate` |
| 玩家存档 L2 | `saves` 一人一行 + `version` 乐观锁 + 服务端 cozy 重算 + 数值夹紧 | ✅ 完成 | `home-server.exe -selftest` |
| 跨玩家 L3 | `room_snapshots` / `visit_log`，串门只读快照 | ✅ 完成 | 同上 |
| 审计 L4 | `save_history` 最近 20 版 | ✅ 完成 | 同上 |
| 服务端 | Go + `modernc.org/sqlite`，16 条路由（health/meta/world/auth/content/content pack/me/save/leaderboard/rooms/visit/**buildings**/**friends**） | ✅ 完成 | 56 项 `httptest` 自测 |
| 前端模块化 | `src/core/*`（content/pathfind/rules/version/environment/clock）、`src/net/*`、`src/content/generated.js` | ✅ 主体完成（渲染与 UI 仍在 HTML 内，按需再拆） | `src/README.md` |
| 云同步 | `src/net/save-provider.js`：本地优先 + 离线队列 + 409 字段级合并 | ✅ 接线完成 | 回归 201 项含云同步用例 |
| 世界/环境 | 北京时间双时钟、四季光照、确定性天气/车流/生长、68×48 街区、16×16 区块惰性生成 | ✅ 完成 | `node tools/perf.mjs`、`node tools/bench-world.mjs` |
| 职业系统 | 11 个岗位绑定分区，打卡/任务/整班/熟练度，班次进度不存档 | ✅ 完成 | 回归 J1–J10 |
| 生活目标（成就） | `content/achievements` 15 个目标，4 组；进度由状态推导不存档，只记解锁与去过谁家 | ✅ 完成 | 回归 A1–A8 |
| 好友 | `friendships` 单向关系；社区面板加/删好友、好友置顶、去串门 | ✅ 完成 | 服务端含好友用例；回归 P7–P10 |
| 住址 | 公寓/独栋两类楼栋；公寓按 uid 分到「楼栋 楼层+房号」（公寓楼 1602）；点公寓楼打开 18×4 住户目录，可以选房间串门 | ✅ 完成 | 回归 D1–D5 / B1–B3 |
| 房态与搬入 | 空房按稳定散列挂 待售/待租/空置；目录里点开可看房、买下或租下，即时改住址并存档（家具跟着人走） | ✅ 完成 | 回归 C1–C8 |
| 房产上限 | 每人最多 **3 套**（含自住）；名下可免费换着住、卖出回收 70%、退租不退押金；自住不能卖；服务端 `estates` 表让所有房在目录里都有主 | ✅ 完成 | 客户端 Q1–Q8 / 服务端 5 项 |
| 车辆 | `vehicles/cars.json` 3 款车只在 4S 店卖；提车停在店旁停车场，可上车驾驶（车速倍率、只走硬质路面），可卖回 4S 店 | ✅ 完成 | 回归 I1–I6 |
| 货币流通 | 车卖回 60% / 医院门诊与买药（冷却）/ 家具半价回收 / 卖房 70% 回收 | ✅ 完成 | 回归 O1–O6 |
| **生活开支** | 食材制：菜市场/超市/便利店三档价买食材 → 做饭吃饭扣份数；老张饭馆 4 道菜不耗食材；超市货架（便当/水/泡面）。楼下信箱投递账单：房租 7 天 / 电费 15 天 / 水费 15 天 / 物业 30 天 / 停车 7 天，宽限 3 天、逾期扣情绪封顶 −15 | ✅ 完成 | 回归 V1–V6 / W1–W3 / X1–X6 |
| **工资重标** | 十种岗位日薪 ¥100–¥180（月薪 ¥2200–¥3960，对标 2026 年最低工资第一档）；面板同时显示日薪与折合月薪 | ✅ 完成 | 回归包含日薪计算 |
| **不动产增值** | `units.appreciate` 每年 +5% 复利（按游戏天数）；买卖同价 + 卖出 7 折，短期倒手必亏、长期持有才回本 | ✅ 完成 | 回归 Y1–Y4 |
| **世界时钟** | `timeSource = world`：服务端 `/api/v1/world` 懒推进，客户端插值 + 30 秒校准。`rate` 单位「游戏分钟/真实分钟」，60 → 1 天 = 24 分钟真实。暂停/倍速关闭，所有人共用一个日历 | ✅ 完成 | 回归含时钟换算；服务端自测含 world 200/合法/不回退 |
| **日薪制** | 每天只能上一次班：`career.lastShift{day,jobId}`，打卡即占名额，次日自动恢复；HUD / 岗位卡片 / 岗位列表三处同步状态 | ✅ 完成 | 回归 J12 / J12b |
| **随身背包** | 家具电器直接入库（装修类不占背包）；背包只装食材，上限 20 份；做饭先用背包再开冰箱；进家门自动归仓 | ✅ 完成 | 回归 V3–V8 |
| **功能点承包** | 10 个门面可按月承包（¥1,200–¥26,000/月），承包期内按**客流浮动**结算净收益（0.7–1.3 倍 + 周末加成，逐日累加），到期需续约；**全局独占**由服务端 `businesses` 表保证，别人占了就灰掉；中途退包回收 50% | ✅ 完成 | 回归 Z1–Z11 / 服务端 10 项 |
| **收支账本** | 24 处 `MONEY ±=` 全部收口到 `credit/debit(金额, 分类, 备注)`；面板分今日三格 / 近 7 天双色柱（平方根归一化）/ 当天分类结构 / 最近 12 条流水；每日留 30 天、流水留 60 条；纯本地记账，不参与任何数值判定 | ✅ 完成 | 回归 AA1–AA15 |
| **银行与股市** | 银行：活期 0.2%/天（上限 50 万）、30/90 天定期（提前支取罚 20%）、三档贷款（每天自动扣、逾期只扣情绪）；股市：6 支股票，价格由「股票序号+游戏日」稳定散列推导（同日全服一致、可复现），双向 0.15% 手续费 | ✅ 完成 | 回归 AB1–AB12 / AC1–AC15 |
| 彩票 | 彩票站卖双色球（2 元一注），奖级与奖金在内容里，概率按组合数现算（一等奖 1/17,721,088）；多注共用同一组开奖号 | ✅ 完成 | 回归 G1–G6 |
| 基础操作 | 仓库入口+件数、半价卖出、买下即摆（取消退回）、WASD/方向键、阻挡点击反馈、HUD 分组（更多）、触屏摇杆 | ✅ 完成 | 回归 W/K/U/T 组 |
| 多人实时 | 无 WebSocket，串门/排行榜为拉取式 | ⬜ 未做（按需再加） | — |
| Vue 组件化 | 仍为原生 DOM + 单文件构建；Vue 仅作为"将来要拆 UI"的选项保留 | ⬜ 未做（不阻塞） | — |
| 部署 | 仅本地 `127.0.0.1:8787`，无 HTTPS/Docker | ⬜ 未做 | — |

> 一句话：**"数据置后 + 模块化 + 内容数据化 + 玩法扩到小区/职业"这条主线已经通了**；
> 剩下的是"上线相关"（部署、账号升级、实时多人）和"UI 框架化"，都不影响现在继续加内容。

---

## 1. 目标架构（v2.1 实际落地形态）

> 早期版本画的是 Vue 3 + Vite + TS + Pinia。实测后**没有采用**：单文件双击即玩是这个项目的重要手感，
> 而现有 UI 用原生 DOM + 模板字符串已足够，引入构建链的收益不抵"打包产物变成目录"的代价。
> 分层原则不变，只是"UI 层"仍是原生 DOM。

```
┌──────────────────── 前端（原生 ES modules + 迷你打包器 → 单文件） ────────────────────┐
│  HTML/CSS + UI 渲染函数：HUD / 商店 / 仓库 / 装修面板 / 人物卡 / 工作面板 / 社区面板    │
│              只做 DOM 与事件，不直接改存档                                             │
│  src/core/   引擎内核（零依赖，可在 Node 跑）：content / pathfind / rules / version      │
│              environment / clock                                                     │
│  src/net/    save-provider（本地优先 + 离线队列 + 409 合并）/ social（排行榜·串门）      │
│  src/content/generated.js  由 tools/content.mjs bundle 生成，勿手改                     │
└───────────────────────────────────┬───────────────────────────────────────────────┘
                                    │ REST / JSON
┌───────────────────────────────────▼───────────────────────────────────────────────┐
│                   后端（Go 1.26 + net/http 原生路由 + SQLite）                      │
│  main.go     路由、鉴权中间件、存档读写与乐观锁、内容下发、世界时间、排行榜、串门       │
│  selftest*.go 56 项 httptest 自测（进程内，不依赖网络）                              │
│  schema.sql  users / saves / save_history / room_snapshots / visit_log / world_state │
│  content/    bundle 产物（前后端共享的唯一数据源，由 tools/content.mjs 生成）          │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**关键设计决定**

1. **引擎与 UI 彻底解耦**：`src/core/*` 不碰 DOM。这样同一套代码既能跑在网页里，也能被 Node 跑单测、被 headless 浏览器做回归——现有这套"注入式无头测试"能继续用，甚至更好用。
2. **配置数据只存一份**：家具目录 / 房型 / 房间风格以 JSON 由后端下发（`GET /content`），前端缓存。避免"改价改了前端忘了后端"这种事。
3. **存档 = 快照 + 版本号**（不做逐条数据库化）。存档本来就是一个小 JSON（家具列表 + 数值 + 风格 + 职业进度），塞进 TEXT 最简单、最好迁移、最好回滚。真正需要索引的只有 `user_id / updated_at / version / cozy_score`。
4. **本地优先（offline-first）**：断网继续玩，恢复后补同步。理由：这是个单机感很强的游戏，不该因为网络抖一下就崩。

---

## 2. 现有代码 → 新模块映射（历史推演，行号指改造前的单文件）

> 这张表是改造**前**的估算，用来判断"哪些是资产、哪些要重写"。实际执行时：
> 引擎逻辑没有搬成 `engine/`，而是**留在 HTML 里 + 只把可复用部分抽到 `src/core/*`**（内容层、寻路、规则、版本、环境、时钟）。
> 这是有意的取舍：全量搬家会引入大量回归风险，而"内容层先出去"已经解决了"加东西要改 5 处"的核心痛点。
> 表中 `ui/components/*.vue` 一列仅代表"将来若拆 UI 的落点"，当前仍是原生 DOM 函数。

| 现位置（行） | 内容 | 迁移到 | 行数 |
|---|---|---|---|
| 1–495 | HTML 骨架 + CSS 285 行 | `ui/` 组件 + `styles/`（CSS 变量沿用） | ~490 |
| 496–605 | 基础配置、房型、装修风格、数值 | `engine/config/` + `content/*.json` | ~110 |
| 606–651 | WebAudio 音效合成 | `engine/audio.ts` | 46 |
| 652–763 | 房间/墙定义、场景切换 | `engine/world/` | ~110 |
| 764–819 | 角色外观、相机、坐标换算 | `engine/iso/` | ~56 |
| 820–1043 | 菱形 tile / 墙 / 门垫 / 花草 绘制 | `engine/render/tiles.ts` | 224 |
| 1044–1261 | 角色 SVG 生成 + 部件化兜底 | `engine/render/char.ts` | ~218 |
| 1262–1448 | 街景绘制 | `engine/render/street.ts` | 187 |
| 1449–1540 | 家具目录 | `content/catalog.json` | 92 |
| 1541–2088 | 15 件 SVGA 素材 + 程序化兜底 | `engine/assets/`（可按家具拆文件） | ~547 |
| 2089–2318 | 主渲染（画家算法排序 + 氛围） | `engine/render/index.ts` | 230 |
| 2319–2540 | 阻挡判定、BFS、数值衰减、工作、主循环、移动 | `engine/systems/` | ~220 |
| 2540–2761 | 点击/悬停输入 | `engine/input.ts` | 222 |
| 2762–2855 | 邻居之家（参观场景） | `engine/world/visit.ts` | 94 |
| 2856–2932 | HUD | `ui/components/Hud.vue` | 77 |
| 2933–3067 | 人物档案卡 | `ui/components/CharacterCard.vue` | 135 |
| 3068–3187 | 商店 | `ui/components/ShopPanel.vue` | 120 |
| 3188–3411 | 建造/家具交互/房型扩建 | `engine/systems/build.ts` + `ui/UpgradeDialog.vue` | ~220 |
| 3412–3475 | 装修（地板/墙面） | `engine/systems/decor.ts` + `ui/DecorDialog.vue` | 64 |
| 3476–3566 | 捏人面板 | `ui/components/LookEditor.vue` | 91 |
| 3567–3612 | 存档（localStorage） | `app/save/provider.ts`（Local / Remote 两实现） | 46 |
| 3613–3664 | 尺寸适配、启动 | `app/bootstrap.ts` | 52 |

**结论**：约 **2100 行（65%）是"引擎资产"，原样搬迁**；约 **900 行 UI 改写成 Vue 组件**；真正新写的是 Go 服务（约 600–900 行）+ 同步层（约 200 行）。

---

## 3. 数据模型（混合模型：关系列 + JSON 快照）

> 关键结论：**用 SQL 是对的，但"用 SQL"≠"把家具拆成行"。**
> 需要查询/排序/统计的字段抽成列；前端强耦合的布局细节留在 JSON 里。

```sql
-- 用户（游客一键开局；后续可挂第三方登录）
CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- uuid
  nickname    TEXT NOT NULL,
  token_hash  TEXT NOT NULL,              -- 只存 hash，不存明文
  created_at  TEXT NOT NULL,
  last_seen   TEXT
);

-- 存档：一人一条快照；常用字段抽列，布局存 JSON
CREATE TABLE saves (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  version     INTEGER NOT NULL DEFAULT 1, -- 乐观锁：每次写入 +1
  data_json   TEXT    NOT NULL,           -- { placed[], yardDecor[], appearance, stats, ... }
  cozy_score  INTEGER NOT NULL DEFAULT 0, -- 排行榜用（写入时由服务端复核）
  money       INTEGER NOT NULL DEFAULT 0,
  day         INTEGER NOT NULL DEFAULT 1,
  house_level INTEGER NOT NULL DEFAULT 0,
  floor_style INTEGER NOT NULL DEFAULT 0,
  wall_style  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX idx_saves_cozy ON saves(cozy_score DESC);

-- 历史版本：最近 20 版，防手滑 / 防作弊回溯
CREATE TABLE save_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_hist_user ON save_history(user_id, version DESC);

-- 参观快照（只读；由玩家存档裁剪生成）
CREATE TABLE room_snapshots (
  user_id    TEXT PRIMARY KEY,
  nickname   TEXT NOT NULL,
  payload    TEXT NOT NULL,               -- 房型 + 风格 + 家具布局（不含数值）
  cozy_score INTEGER NOT NULL DEFAULT 0,
  visits     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_room_cozy ON room_snapshots(cozy_score DESC);

-- 串门记录（后续做"今日访客""互访奖励"）
CREATE TABLE visit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user  TEXT NOT NULL,
  to_user    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

**为什么布局不拆表**

1. 家具是**前端渲染契约**：字段随玩法演进（v1.5 刚给目录加 `walk`、给存档加 `ownedFloors`），拆表意味着每次玩法调整都要写迁移脚本
2. **查询收益接近零**：没有"查第 3 行家具 gx"这种需求，真实查询都是"谁装修度最高""最近谁活跃"
3. 整块 JSON 让**回滚/备份/导出**都变成一次拷贝，出问题好救

**什么时候再拆（演进路径）**

当出现以下需求时，加一张**投影表**（由存档写入时同步生成，只读、可随时重建，不参与主流程）：

```sql
CREATE TABLE room_items (            -- v2 预留，现在不建
  save_version INTEGER, catalog_id TEXT,
  gx INTEGER, gy INTEGER, w INTEGER, h INTEGER
);
```
用途：家具热度榜、按家具搜索房间、跨玩家统计。因为是投影，重建成本为零，**不需要现在为它付出复杂度**。

**服务端校验（防篡改）**

客户端提交的 `cozy_score / money / day` 一律**不信任**，由服务端用 `content/catalog.json` 重算：遍历 `data_json.placed` 累加 cozy；`money` 与 `day` 若与上版本相比出现不可能的变化（如单次 +999999），写审计日志并按规则收敛。

---

## 4. API 设计（v1）

```
GET    /api/v1/health              → { ok: true }
GET    /api/v1/meta                → { app, minApp, saveSchema, contentVersion, modules } 版本握手
GET    /api/v1/world               → 统一世界时间（world_state，tick 锚点）
POST   /api/v1/auth/guest          → { userId, token, nickname }    游客一键开局（首访自动建号）
GET    /api/v1/me                  → 用户信息 + 是否有存档
GET    /api/v1/content             → 全量内容包（带 ETag；304 直接复用缓存）
GET    /api/v1/content/pack/{id}   → 单个包热替换（ETag=包 hash，X-Module-Version）
GET    /api/v1/save                → { version, data, updatedAt }
PUT    /api/v1/save                → Header: If-Match: <version>
                                     Body: { data }
                                     200 新版本 / 409 冲突（返回服务端版本，前端合并）
GET    /api/v1/rooms/feed          → 随机若干玩家房间（做"串门"）
GET    /api/v1/buildings/{id}/rooms → 公寓楼住户目录（按楼层/房号，含房间快照）
POST   /api/v1/rooms/{userId}/visit → 记录一次串门并返回只读房间快照
GET    /api/v1/friends             → 我的好友（join 房间快照，带布局）
POST   /api/v1/friends/{userId}    → 加好友（幂等，只能加已有房间的玩家）
DELETE /api/v1/friends/{userId}    → 移除好友
GET    /api/v1/leaderboard?by=cozy → 装修度排行榜（装修度是天然的可比指标）
```

> 实现比早期方案少了一个 `GET /rooms/{userId}`（被 `POST .../visit` 合并：串门既要拿快照也要记日志，
> 两个请求拆开会出现"看了没记上"）。服务端路由共 **16 条**，全部有 `httptest` 自测。

**冲突处理**：客户端每次提交带上自己基于的 `version`。服务端版本更高时返回 409 + 服务端存档，前端用**字段级合并**（`placed` 按家具实例 id 取并集，`stats` 取较新时间戳，`floorStyle` 以提交方为准），合并结果再提交一次。这样"手机和电脑同时玩"不会丢装修。

---

## 5. 工具链现状与实施路线（2026-11-05 实测）

| 依赖 | 实测结果 | 结论 |
|---|---|---|
| Node v22.22.2 | ✅ 可用 | 可跑引擎单测、headless 截图 |
| `node:sqlite`（Node 内置） | ✅ 实测通过 | Node 侧也能零依赖写 SQL（备用方案） |
| Go 1.22.5（`D:/Go/go/bin`） | ⚠️ 可用，但**版本偏低** | `modernc.org/sqlite v1.61.0` 要求 Go ≥ 1.26 |
| **Go 1.26.10 工具链（模块缓存）** | ✅ **实测编译并运行 SQLite 成功** | **主用这条** |
| npm registry / goproxy.cn | ✅ **可用（需绕开两个坑）** | 实测 `npm install vue` 7 秒装好 |
| `modernc.org/sqlite v1.61.0`（已缓存，纯 Go 无 cgo） | ✅ 可用 | 不需要 gcc、不需要 cgo |

### 5.1 网络与工具链的真实情况（重点，之前的结论有误）

**机器有网**。之前判断"网络不通"是踩了两个坑叠加：

| 坑 | 现象 | 绕开方式 |
|---|---|---|
| 系统环境变量 `http_proxy=127.0.0.1:50229` 指向**根本没在监听**的端口 | 所有走代理的命令（curl/npm/goproxy）卡到超时 | 执行前清空：`$env:HTTP_PROXY=$null` 等 |
| Git Bash（MSYS）里 DNS 不可用：`getaddrinfo() thread failed to start` | Bash 工具内 curl 全失败，**包括 localhost** | 改用 **PowerShell** 工具执行网络命令 |

实测证据：
```
PowerShell: Invoke-WebRequest https://registry.npmjs.org/ → HTTP 200
            Invoke-WebRequest https://www.baidu.com/        → HTTP 200
            npm install vue@3                               → added 23 packages in 7s
DNS 解析到 198.18.3.5（Clash 类 TUN 代理的假 IP，属正常）
```

**PowerShell 里直接敲 `npm` 会报"禁止运行脚本"**（ExecutionPolicy 限制 `npm.ps1`），改用 `npm.cmd`：

```powershell
$env:HTTP_PROXY=$null; $env:HTTPS_PROXY=$null; $env:http_proxy=$null; $env:https_proxy=$null
$npm = "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\npm.cmd"
& $npm install --registry=https://registry.npmjs.org
```

### 5.2 Go 的离线编译（仍然适用）

```bash
GO="C:/Users/Administrator/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.windows-amd64/bin/go.exe"
cd E:/QHTML/server
GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off "$GO" mod tidy
GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off "$GO" build -o home-server.exe .
```

- 不要用 `D:/Go/go/bin/go`（1.22.5，低于 `modernc.org/sqlite` 要求的 1.26）
- 走模块缓存即可，无需联网；`GOPROXY=off` 避免 go 去校验卡住
- 若之后要拉新依赖，可在 PowerShell 里配 `GOPROXY=https://goproxy.cn,direct` 并清空代理变量

### 5.3 由约束反推的路线

1. **后端就是 Go**（工具链已通，见上）。
2. **前端可以上 Vue + Vite**（npm 已通）。但 `src/core/*` 继续**保持框架无关**——引擎不应依赖 UI 框架，这样单测、服务端复用、将来换框架都不受影响。
3. 现阶段已有的"迷你打包器 + 单文件产物"保留，作为**离线分发通道**；Vite 负责开发体验，两者不冲突。

## 5.5 修复记录（2026-11-05 上午，测试驱动）

| 级别 | 问题 | 后果 | 修法 |
|---|---|---|---|
| 🔴 | **参观时点「回原位」**：`switchScene('home')` 只改 `scene`，没还原对方房型/家具 | 紧接着的 10 秒自动存档会把**别人家存成自己的**（不可逆的数据损坏） | `switchScene` 开头检测 `peerSnapshot` → 先 `leavePeer()`；`saveGame` 再加一道 `peerSnapshot` 保险 |
| 🔴 | **409 合并结果没回灌本地** | 合并进来的家具在本地不存在，下次自动存档又把服务端覆盖回去 → 远端改动丢失 | `save-provider` 新增 `onMerge` 回调，合并成功后把结果灌回游戏状态并重绘 |
| 🟠 | **参观把对方家具收进我的仓库** | `applyHouseLevel()` 会把压墙家具 `invAdd` 到全局 `inventory` | 参观时临时置空 `inventory`，算完恢复 |
| 🟠 | **串门计数永远 0** | `SOCIAL.visit` 没带 token，服务端 401 被 catch 吞掉 | 暴露 `SAVE.token` 并在访问时带上；补测试断言 Authorization 头 |
| 🟠 | **地毯抢点击** | 台灯压在地毯上时，点台灯命中地毯 → 变成"走过去"，无法交互 | `placedAt` 改为实体家具优先、可走装饰兜底 |
| 🟡 | 参观误报"装修度提升" | 进到装修更好的家会弹升级提示 | 档位提示只在 `scene==='home'` 时结算 |
| 🟡 | 商店与社区侧栏叠加 | 两个面板同时滑入互相遮挡 | 打开一个时自动收起另一个 |
| 🟡 | 服务端不校验脏数据 | 负钱/负天数会污染排行榜列 | `money<0 || day<0` → 400；等级/风格索引按内容层长度夹紧 |

**测试现状（当时 → 现在）**：这一轮结束时服务端 `-selftest` 24 项、客户端回归 40 项；
**当前是服务端 56 项、客户端 170 项**（dist 与 src 两套各跑一遍，全绿）。
后来新增的用例覆盖：内容包热替换、版本握手、统一世界时间、职业打卡/任务/整班/熟练度（J1–J10）、
街区布局（M3 门不被遮）、区块惰性生成。

## 6. 分阶段实施（每阶段结束都能玩，不做"大爆炸重写"）
| 阶段 | 内容 | 产出 | 状态 |
|---|---|---|---|
| **M0 服务端骨架** | `server/`：Go + SQLite（modernc）、schema 建库、游客鉴权、save 读写（乐观锁）、content 下发、排行榜、参观快照、好友 | 数据落库的可用后端，**56 项接口自测全通过** | ✅ 已完成 |
| **M0.5 内容层** | `content/` **19 个数据包** + `assets/furniture/` 19 个 SVG + `tools/content.mjs`（validate/bundle/all）+ 9 条校验规则（含可达性 BFS、交互/职业/成就完整性） | 内容即数据，**加内容不改代码**；详见《内容数据架构设计.md》 | ✅ 已完成 |
| **M1 前端模块化** | `src/core/{content,pathfind,rules,version,environment,clock}.js` + `src/net/*` + `src/content/generated.js`；自带迷你打包器（无 npm）与无头回归 | 引擎读内容层、数据不再分散；**dist/src 两套回归各 201 项全绿** | ✅ 核心完成（渲染与 UI 暂留单文件，按需再拆） |
| **M2 前端接后端** | `src/net/save-provider.js`：本地优先 + 离线队列 + 409 字段级合并；HUD 云同步徽章；`version.generated.js` 版本握手 | 存档真正"置后"；回归含云同步用例，端到端脚本待本机跑 | ✅ 接线完成（E2E 需桌面执行 `tools/verify-cloud.cmd`） |
| **M3 多人玩法** | `src/net/social.js` + 社区面板（好友 / 排行榜 / 串门）；`enterPeer` 套用对方房型·风格·家具，离开恢复；参观时禁写档 | 能真的去别人家看装修；好友置顶 | ✅ 完成（验收需本机双账号） |
| **M4 世界与环境** | 双时钟（北京时间 `realtime` / 模拟 `game`）、四季光照、确定性天气·车流·生长、68×48 街区、日夜/温度 HUD | 氛围与"不会每帧乱跳"的确定性生成 | ✅ 完成 |
| **M5 职业系统** | `content/careers/jobs.json` 11 岗位绑分区；打卡/单任务/整班/熟练度；`civic` 公共建筑；HUD 徽章与面板 | 地图功能点"能进去上班" | ✅ 完成 |
| **M6 无限画布** | 16×16 区块惰性生成（分区/树木/楼房）、视野裁剪、外围荒野、相机以玩家为中心 | 启动成本与地图尺寸解耦（20 万格 4.3ms） | 🟡 地基完成（跨区块寻路、街区拆文件未做） |

### M0 落地清单（已完成，数字已按当前状态修正）

```
E:/QHTML/
├─ server/
│  ├─ main.go          服务端全部逻辑（路由/鉴权/存档/排行榜/世界时间/内容热替换）
│  ├─ selftest.go      56 项接口自测（httptest，不走网络）
│  ├─ schema.sql       7 张表（users/saves/save_history/room_snapshots/visit_log/friendships/world_state）
│  ├─ content/content.json   bundle 产物（源自 content/，由 tools/content.mjs 生成）
│  ├─ home-server.exe  15 MB 单文件，直接运行
│  └─ README.md        构建/运行/接口文档
├─ content/               内容层唯一真相（见《内容数据架构设计.md》）
│  ├─ manifest.json       包清单 + contentVersion + modules 版本
│  ├─ catalog/            家具 15 + 装饰 4 + 分类表（未来 food/pet/seed 同构）
│  ├─ characters/         色板 / 玩家默认 / NPC 5 个
│  ├─ house/              房型 3 级 + 地板 4 / 墙面 4
│  ├─ maps/               家 + 小区（68×48，zones/houses/civic/portals/spawn）
│  ├─ rules/              生存衰减、经济、cozy 公式、社交数值
│  ├─ environment/        天气光照、随机物/生长/车流、四季
│  ├─ careers/            11 个岗位（绑分区、班次、任务、薪酬、晋升）
│  └─ ui/                 文案 zh-CN（i18n 种子）
├─ assets/furniture/      19 个 SVG 素材（已从 HTML 抽出）
├─ src/                   前端模块（core/net/content）
└─ tools/                 content.mjs / build.mjs / test.mjs / perf.mjs / bench-world.mjs
```

**自测覆盖（56 项）**：health、版本握手、世界时间、游客鉴权、content ETag 304、单包热替换与版本头、首次写档、
服务端 cozy 复核、过期版本 409、正确版本递增、负值/未知家具拒写、排行榜排除 flagged、参观快照、串门日志、
访问不存在房间 404、无 token/假 token 401、好友增删与幂等/加自己/加不存在的人。

**两个额外发现（已写入 README）**
1. 本机 `http_proxy=127.0.0.1:50229` 是个**失效代理**，凡是走它的命令（npm/curl/go proxy）都会超时——排障时先 `unset http_proxy`
2. 沙箱环境下**本地回环出站被拦**（端口 LISTENING 但连不上），所以自测改成进程内 `httptest`，不依赖网络

---

## 6.4 风险与对策

| 风险 | 对策 |
|---|---|
| 重写导致手感回归（角色穿墙、点击错位、深度排序错乱——这些历史 BUG 都可能复发） | 已把无头功能测试固化成 `tools/test.mjs`（当前 **201 项**，dist/src 双跑）；改逻辑前先跑一遍，红了不提交 |
| 失去离线/双击即玩 | 双通道：`Local` provider 永不删除，可以打包一个"离线版"单文件产物（Vite 构建 standalone 配置） |
| 部署成本 | Go 编译单二进制 + SQLite 文件，一条 `docker run` 就能跑；不需要 Redis/K8s |
| 数据安全 | token 只存 hash、存档带历史版本、写入限流；不做道具交易就不需要复杂审计 |
| 前后端目录漂移 | 目录 JSON 由后端下发 + ETag，前端禁止写死价格 |

---

## 6.5 版本号与升级策略

### 四套版本号，各管一件事（不要混用）

| 版本 | 存在哪 | 什么时候 +1 | 谁读它 |
|---|---|---|---|
| **appVersion** `1.6.0` | `version.json` → 构建时注入 `src/version.generated.js` | 改了游戏代码/UI/玩法 | 客户端自报、服务端 `minAppVersion` 比对 |
| **contentVersion** `1` | `content/manifest.json` → bundle 进 `server/content/content.json` | 改了 `content/` 的**结构**（新增字段、改语义） | 服务端 `/meta` 下发，客户端比对 |
| **contentHash** `ffb1b5c71a16` | 构建时算，两边各算各的 | 每次构建都变 | **只做日志/人工核对**，不参与判定 |
| **saveSchema** `2` | `version.json` → 存进存档 JSON 的 `schema` 字段 | 改了存档字段（加/删/改语义） | 客户端 `migrateSave()` 链式迁移 |

此外还有一个与版本无关的 `saves.version`：**每人一条的乐观锁计数器**，每次写入 +1，只用于 409 冲突检测。

### 更新从哪里来？——服务端只下发"信息"，不下发"代码"

```
version.json ──┐
               ├─→ tools/build.mjs ─→ src/version.generated.js ─→ 内联进 dist（客户端自报版本）
content/*.json ┘                     └→ 内容指纹

content/*.json ─→ tools/content.mjs bundle ─→ server/content/content.json ─→ Go 服务端 /meta
                                                                          └→ /content（ETag）
```

- 客户端**不会**从服务器热更新内容：`content/` 在构建时被内联进单文件（这是"双击即玩"的代价）。所以服务端发布新内容后，玩家需要**刷新拿到新构建**。
- 因此 `/api/v1/meta` 的作用是**告诉客户端该不该刷新**，而不是下发数据：

```json
{
  "appVersion": "1.6.0",
  "minAppVersion": "1.6.0",
  "saveSchema": 2,
  "contentVersion": 1,
  "contentHash": "f4d0889e3588",
  "startedAt": "2026-11-05T09:31:00+08:00"
}
```

客户端启动后 `checkServerVersion()` → `evaluateUpdate()`：

| 判定 | 条件 | 动作 |
|---|---|---|
| `ok` | 版本一致 | 不打扰 |
| `content-updated` | 服务端内容版本 > 客户端 | 底部提示条 + 「刷新」按钮 |
| `client-outdated` | 客户端 appVersion < `minAppVersion` | 同上（强制刷新语义） |
| `server-outdated` | 服务端内容版本 < 客户端 | 只提示，不引导刷新（多半是服务端没重启/没 bundle） |

### 模块级版本（每个模块自己的版本号）

除了上面四套"全局"版本，**每个内容包自己有独立版本**，台账在 `content/versions.json`：

```json
{
  "catalog/furniture.core.json": { "version": 1, "hash": "0b6ae0c6854f", "updatedAt": "…" },
  "rules/economy.json":          { "version": 3, "hash": "9c1f…",        "updatedAt": "…" },
  "ui/strings.zh-CN.json":       { "version": 2, "hash": "77ad…",        "updatedAt": "…" }
}
```

- **hash 自动算**（去掉 `generatedAt` 这类易变字段后做稳定序列化再 sha256）
- **version 自动递增**：`node tools/content.mjs bundle` 时逐包比对，hash 变了就 `version+1` 并记 `updatedAt`
  ```
  ↑ ui/strings.zh-CN.json  1 → 2
  ```
  只改了一个包，就只有一个包升版本——**这就是"可核查"**
- 源码模块（`src/**/*.js`）没有人工版本号，用**指纹**当身份（代码改动 → 指纹变）

### 客户端只更新变化的那一块

```
GET /api/v1/meta            → { modules: { "content/xxx": {version, hash}, … } }
GET /api/v1/content/pack/catalog/furniture.core.json   → 单个包的完整 JSON（带 ETag + X-Module-Version）
```

启动流程：

1. `diffModules(CLIENT, meta)` 逐个比对指纹，得到变化清单
2. `splitHotPatchable` 分类：
   - `content/catalog|house|characters|maps|ui` → **可热替换**
   - `rules/*`、`src/*` → **必须刷新**（规则是 `const` 常量，替换不彻底，宁可不做假热更）
3. 可热替换的：逐包 `GET /content/pack/...` → `HomeCore.content.applyPack(id, data)` → `refreshContentBindings()` 就地把引擎里的目录/房型/风格数组改掉 → 重绘，**不刷新页面**
4. 有必须刷新的模块：底部提示条列出**具体哪个模块变了**，例如
   `有更新需要刷新：家具目录 1→2、规则参数 3→4`

> 因此"改个家具价格"只需要 `node tools/content.mjs bundle` + 重启服务端，玩家刷新页面时会被**热替换**，不需要重新构建客户端、也不会整页闪一下。
> 但如果动了 `rules/`（数值公式）或 `src/`（代码），就必须重新构建 + 刷新——这是刻意保留的边界，避免"看起来更新了其实没生效"。

### 日常发布怎么做

```bash
# 只改了家具数值/新增一件家具（结构没变）
node tools/content.mjs all          # 重新 bundle（逐包 hash 变则 version+1）
# 重启 home-server，玩家刷新页面 → 客户端比对 /meta，逐包热替换，不重新构建客户端

# 改了 content 的结构（加了字段/改了语义）
#   1) content/manifest.json 的 contentVersion +1
#   2) node tools/content.mjs all && node tools/build.mjs
#   3) 重启服务端 → 老客户端会提示"内容已更新，请刷新"

# 改了存档字段
#   1) version.json 的 saveSchema +1
#   2) 在 HTML 的 migrateSave() 里加一个 if 分支处理旧档
#   3) 重新构建客户端（存档会在下次保存时自动带新 schema）

# 发布了不兼容的客户端
#   1) version.json 的 app +1、minApp 同步收紧
#   2) 重新构建 + 重启服务端
```

### 已知取舍

- 指纹（contentHash）两边输入不同（客户端 hash `generated.js`、服务端 hash `content.json`），**刻意不参与自动判定**，否则会天天误报"内容不一致"。
- 热替换只覆盖 `content/**`；`rules/*` 与 `src/*` 变了仍要求刷新（规则是闭包里的常量，替换不彻底，宁可不做假热更）。
- 单文件产物内联了一份内容包作为**离线兜底**；联网时以服务端 `/meta` + `/content/pack` 为准。断网仍可双击即玩，只是拿不到最新内容。

## 6.6 数据到底存在哪：SQL 与 JSON 不是二选一

### 同一行里既有列，也有 JSON

```
saves 表（SQLite）
├─ user_id     TEXT      ← 关系列：能索引、能排序
├─ version     INTEGER   ← 乐观锁
├─ cozy_score  INTEGER   ← 排行榜排序用
├─ money/day/house_level/floor_style/wall_style  ← 抽出来便于统计与夹紧
├─ flagged     INTEGER   ← 检测到异常数值时置 1（不展示在排行榜）
├─ data_json   TEXT      ← ★ 存档正文以 JSON 存在这一列里
└─ updated_at  TEXT
```

所以"用 SQL"和"用 JSON"不是对立的：**SQL 是存储与查询引擎，JSON 是复杂对象的载荷格式**。
家具布局是前端渲染契约（字段随玩法演进），塞进关系表只会让每次玩法调整都要写迁移，而查询收益为零——所以放在 `data_json` 里；而"谁装修度高""谁第几天"这类问题必须能 `ORDER BY`，所以抽成列。

### 前端能看到什么（实测）

| 数据 | 谁能看到 | 结论 |
|---|---|---|
| 家具目录、价格、房型、装修风格、规则数值（衰减率/工资/cozy 公式） | **任何人**（打开 DevTools 或右键查看源码即可，实测 `"price":320`、`"decayPerGameMinute":0.05`、`"bonusExpr":"min(20, round(sqrt(cozy) * 1.5))"` 都在 dist 里明文） | **不可避免**：客户端要画商店、要算装修度徽章，就必须拿到这些数。这不是"泄露"，是客户端游戏的物理现实 |
| 自己的存档（localStorage 副本） | 玩家自己（可改） | 所以真相在服务端；本地只是缓存 |
| 登录 token（localStorage） | 玩家自己 | 它是"我是谁"的凭据，不是别人的秘密；风险是 XSS，靠不引入第三方脚本控制 |
| 别人的存档全文 | **看不到** | `/leaderboard` 只给昵称/装修度/房型/天数，`/rooms/feed` 只给房间布局（这是"串门"功能本身要展示的） |
| 服务端数据库 | 看不到 | 只在服务端进程内 |

**如果确实要藏**：唯一办法是把 UI 也搬到服务端渲染（每次进商店都由服务端出图），代价是失去离线与流畅度。对这类单机向游戏，业界普遍接受"内容公开、数值可信"。

### 可见 ≠ 可改：防作弊边界

客户端上报的数值可以"看见"，但服务端不当真：

1. **装修度（cozy）由服务端重算**：遍历 `placed` 用 `content.json` 的 cozy 值累加，客户端传什么都不看
2. **钱/天数异常跳变夹紧**：单次写入 `money +1500`、`day +3` 为上限（正常工作 60/5 秒、睡觉 +1 天），超出则夹紧并把 `data_json` 也改正
3. **被标记的存档不进排行榜**（`flagged=1`），但仍可正常游玩
4. 负数直接 `400` 拒写

实测：写入 `money:999999, day:99` → 落库变成 `money=2000, day=4`，排行榜里查不到该玩家。

### 仍存在的缺口（已知，未修）

**"购买"仍由客户端计算**：玩家理论上可以谎报钱（在被夹紧的上限内）反复买家具。

彻底解决需要把交易搬到服务端：
```
POST /api/v1/shop/buy  { catalogId }
→ 服务端校验钱够不够、扣钱、写 inventory，返回新存档
```
这属于"服务端权威经济"，改动量中等（要重构 `buyFurniture` 与存档写入时序）。当前优先级低于玩法开发，先记录在案。

## 6.7 数据架构总览（四层，不是两层）

> 常见误解：只有"公共配置 + 玩家存档"两层。实际还有一个**跨玩家层**（串门/排行榜要用）和一个**审计层**（回滚/追责要用）。

### L1 公共配置 —— `content/`（只读，逐包版本）

| 包 | 内容 | 消费者 |
|---|---|---|
| `catalog/furniture.core.json` | 15 件有交互的家具（价格/占地/cozy/效果） | 客户端商店、服务端 cozy 复核 |
| `catalog/items.decor.json` | 4 件装饰（地毯可踩、画架、置物架） | 同上 |
| `catalog/categories.json` | 分类表（furniture/appliance/decor，预留 food/seed/pet） | 商店分组、图标兜底 |
| `house/levels.json` | 房型 3 级（净尺寸 + 室内隔墙 + 区域） | 客户端渲染、服务端夹紧等级 |
| `house/residence.json` | 住址体系：公寓（18 层 × 4 户）与独栋两类楼栋、分配规则 | 客户端门牌/住址、串门显示"公寓楼 1803" |
| `house/styles.json` | 地板 4 / 墙面 4（配色 + 纹理类型） | 客户端渲染 |
| `maps/home.map.json` | 室内家（网格、家具初始位、门） | 客户端渲染与寻路 |
| `maps/street.map.json` | 小区 68×48（zones / houses / civic / portals / spawn / treeRules） | 客户端渲染、寻路、职业打卡点 |
| `characters/*.json` | 色板、玩家默认外观、5 个 NPC | 客户端渲染、串门名牌 |
| `interaction/verbs.json` | 13 个在用动词 + 10 个预留（含 hook 白名单） | 点击菜单、校验器 |
| `rules/*.json` | 生存衰减、经济、cozy 公式与档位、社交数值 | 客户端模拟、服务端校验口径 |
| `environment/*.json` | 天气光照（climate）、随机物/生长/车流（ambient）、四季（seasons） | 客户端环境层 |
| `careers/jobs.json` | 11 个岗位（分区、班次、任务、薪酬、晋升、门槛） | 客户端职业面板、HUD 徽章 |
| `achievements/achievements.json` | 15 个生活目标（4 组：生活/小家/工作/邻里），目标类型 + 奖励 | 客户端目标面板、达成结算 |
| `ui/strings.*.json` | 界面文案（i18n 种子） | 客户端 |

**这份数据对所有人可见**（客户端要画商店），且**每个包有自己的版本号**（见 §6.5）。

### L2 玩家存档 —— `saves`（一人一行，可写，乐观锁）

一个玩家的"数据包"实际长这样（`data_json` 里的字段）：

```jsonc
{
  "schema": 9,                       // 存档结构版本（驱动迁移）
  "savedAt": 1762345678901,          // 用于多端冲突合并时判新旧
  "money": 1240,                     // 个人数值
  "minute": 830, "day": 6,           // 模拟时钟存档（realtime 下显示时间取北京时间；这两个只用于衰减与回退）
  "stats": { "hunger": 72, "thirst": 65, "emotion": 80 },
  "placed": [ { "catalogId": "bed", "gx": 5, "gy": 9 } ],        // 已摆放：id + 坐标
  "inventory": [ { "catalogId": "lamp", "count": 2 } ],          // 仓库：id + 数量
  "houseLevel": 1, "floorStyle": 2, "wallStyle": 1,              // 房屋级别 / 装修风格
  "ownedFloors": [0,2], "ownedWalls": [0,1],                     // 已购风格（买了可反复切换）
  "appearance": { "skin": "#f3c9a0", "hairStyle": 1, ... },      // 外观
  "person": { "name": "我的屋主", "gender": "女", ... },          // 档案
  "career": {
    "shiftsByJob": { "job.store": 4 }, "total": 4,               // 职业进度（不存等级，等级由它推导）
    "lastShift": { "day": 6, "jobId": "job.store" }              // ★ v11 今天上过班没（日薪制）
  },
  "achievements": { "unlocked": { "ach.first_shift": 1762345678901 }, "visited": ["u123"] }, // 只存已解锁与去过谁家
  "residence": { "buildingId": "house.公寓楼", "floor": 16, "room": 2 },  // 住哪：公寓楼层+房号
  "estates": [                       // ★ 房产，最多 3 套（含自住）；自住那套一定在列表里
    { "buildingId": "house.公寓楼", "floor": 16, "room": 2, "mode": "owned",  "paid": 0 },
    { "buildingId": "house.公寓楼", "floor": 9,  "room": 3, "mode": "owned",  "paid": 19200 },
    { "buildingId": "house.公寓楼", "floor": 4,  "room": 1, "mode": "rented", "paid": 580 }
  ],
  "car": { "model": "car.suv", "gx": 51, "gy": 32 },  // 车（一人一辆，买了才有）；"正在车上"不存档
  "address": "公寓楼 1602",          // 显示用；由 residence 推导，服务端快照也带一份
  "pantry": 12,                      // ★ v10 冰箱里的食材份数（做饭吃饭都扣它，上限 food.max=40）
  "bag": 6,                          // ★ v11 随身背包里的食材份数（买菜先进这里，进家门自动归仓）
  "world": { "total": 8060, "rate": 60 },   // ★ v11 世界时钟锚点：第 6 天 14:20，倍率 60（离线续走用）
  "biz": {                           // ★ v12 功能点承包（服务端 businesses 表才是权威，这里只是本地缓存）
    "list": [{ "shopId": "biz.cafe", "start": 6, "end": 36, "fee": 2000 }],
    "lastDay": 6                     // 上次结算日，离线回来按天数补
  },
  "bank": {                          // ★ v14 银行：savings 是整数元，acc 存不足一元的利息零头
    "savings": 26000, "acc": 0.3,
    "fixed": [{ "uid": "fx80_1", "termId": "fx.30", "amount": 5000, "start": 20, "end": 50, "rate": 0.003 }],
    "loans": [{ "id": "ln.s", "principal": 5000, "total": 5400, "paid": 2160, "due": 60, "perDay": 180, "missed": 0 }],
    "lastDay": 42, "lateTotal": 0
  },
  "stock": { "hold": [{ "id": "st.conv", "shares": 300, "cost": 3900 }] },  // ★ v14 只存股数/成本，股价是推导出来的
  "ledger": {                        // ★ v13 收支账本：容量固定，不会随游玩时长膨胀
    "day": 6,                        // 当前汇总的是哪一天
    "today": {                       // 当天分类累计
      "in":  { "wage": 180, "biz": 65 },
      "out": { "food": 44, "bill": 28 }
    },
    "days": [{ "d": 5, "i": 365, "o": 64 }],   // 每日汇总，最多 30 条（空白天不落）
    "log": [                                   // 最近流水，最多 60 条
      { "d": 6, "m": 865, "k": "in", "c": "biz", "a": 65, "n": "经营收入" }
    ]
  },
  "bills": {                         // ★ v10 楼下信箱：账单列表 + 每个模板的发单游标
    "list": [                        // 只留未付 + 最近 keepPaid 张已付，避免存档无限长
      { "key": "bill.power#115", "tplId": "bill.power", "title": "电费",
        "amount": 28, "issued": 115, "due": 118, "paid": 0,
        "detail": "基本 ¥16 + 3 件电器 × ¥4 = ¥12 → 合计 ¥28" }
    ],
    "cursor": { "bill.power": 115, "bill.water": 115, "bill.property": 90 },  // 上次发单日
    "lateDay": 0,                    // 上次因逾期扣情绪的那天（一天只扣一次）
    "lateTotal": 0                   // 累计已扣（负数，含 −15 上限判断）
  },
  "sndOn": true
}
```

其中**抽成列**的：`cozy_score`（装修度，排序用）、`money`、`day`、`house_level`、`floor_style`、`wall_style`、`flagged`、`version`、`updated_at`。

**为什么职业进度不抽列**：目前没有"按岗位排行/查询"的需求，等级由 `floor(班次/promoShifts)` 推导，
抽列反而多一份要同步的冗余（一旦对不上就说不清哪个是对的）。真要做"最佳店员榜"时再加列，成本很低。

**关键区分**：
- `placed` 是"摆在哪"，`inventory` 是"仓库里还有几件"——两者分开，因为摆出来和囤着是两种状态
- **`cozy_score` 是派生值**：虽然落了列，但**每次写入由服务端按 `catalog` 重算**，客户端算的不作数

### L3 跨玩家 —— `room_snapshots` / `visit_log` / `friendships`

| 表 | 内容 | 来源 |
|---|---|---|
| `room_snapshots` | 昵称、房型、风格、家具布局、装修度、被参观次数 | 每次写存档时**由服务端裁剪生成**（不含钱/数值） |
| `saves.res_building/floor/room` | 住址索引列（当前自住那套） | 写存档时从 `data.residence` 抽出并夹紧 |
| `estates` | 房产（一人最多 3 套，含自住）：building/floor/room/mode/paid | 写存档时整表替换（先删后插）；楼栋目录按它查，只有自住那套挂快照 |
| `visit_log` | 谁去过谁家、时间 | 串门接口写入 |
| `friendships` | 单向好友关系（我加了你 ≠ 你加了我） | 加/删好友接口写入；昵称与房间一律 join `room_snapshots` 现取 |
| 排行榜 | 昵称 + 装修度 + 房型 + 天数 | 对 `saves` 的查询视图，不是独立表 |

**为什么不做成"每人一份公开数据"**：布局是别人存档的一部分，公开的必须**裁剪**（去掉钱、时间、仓库），否则等于把玩家全部状态暴露出去。

### L4 审计 —— `save_history`（只追加）

每次写入存一版，保留最近 20 版。用途：玩家申诉回滚、排查异常数值来源。

### 还没建的

目前 §6.7 里没有"缺表"级别的缺口了。按需要再说的三件事：

| 想做的 | 现状 | 动手时怎么加 |
|---|---|---|
| 双向好友（申请/同意） | 现在是单向关注，加了就出现，不需要对方同意 | `friendships` 加 `status`（pending/accepted）+ 一个 `POST /friends/{id}/accept` |
| 全服成就榜 | 成就只在各自存档与面板里 | 加 `achievement_unlocks(user_id, ach_id, unlocked_at)`，解锁时上报（服务端按目标类型复核） |
| 今日访客/互访奖励 | 有 `visit_log`，但没做聚合查询 | 加索引后按 `date(created_at)` 聚合，不需要新表 |


> `world_state(key, value, tick_at)` 与 `GET /api/v1/world` **已经建好**，但客户端当前用
> `timeSource: "realtime"`（本地 UTC+8 真实时间）走钟，没有依赖服务端。这是有意的：
> 北京时间是全球统一的，玩家改本地时钟就能"作弊"改游戏时间，但改不出额外收益（昼夜只影响观感与睡觉），
> 所以暂时不值得为它引入一次网络往返。要做"全服同一天气/同一场活动"时，再把时钟源切到服务端。
>
> **成就为什么不建表**：目标值由当前状态推导（钱/装修度/班次/串门人数），服务端不需要逐条校验；
> 存档里只记 `achievements.unlocked`（id → 时间戳）与 `visited`（去过谁家），塞在 `data_json` 里即可。
> 真要做"全服首个达成 XX"时，再加一张 `achievement_unlocks(user_id, ach_id, unlocked_at)` 做查询索引。

### 加字段的规矩（避免以后维护困难）

| 改什么 | 必须做什么 |
|---|---|
| 存档加/改字段 | `version.json` 的 `saveSchema +1`，并在客户端 `migrateSave()` 加一个分支 |
| 内容包加字段 | 该包的 `version` 会**自动 +1**（hash 变了），无需手工 |
| 内容包**结构**变化 | `content/manifest.json` 的 `contentVersion +1`，老客户端会收到"请刷新" |
| 加一张表 | 写进 `schema.sql`，并在 `migrate()` 里加 `ALTER TABLE`（老库兼容） |
| 加一个公开接口 | 只读字段白名单，不要把整行 `saves` 直接返回 |

## 6.8 环境层：天气 / 随机物 / 马路车流 / 生长

> 修正一处理解：环境**不是**一份"参数表"，它由三类完全不同的东西组成。混在一起会导致存档膨胀、串门看到不同的草地、断网就没天气。

### 三类，界线要划清

| 类别 | 例子 | 存哪 | 为什么 |
|---|---|---|---|
| **A 静态定义**（策划数据） | 天气种类与权重、光照系数、昼夜时段、随机物密度、生长阶段时长、车速 | `content/environment/*.json` | 可调、可版本化、对所有人可见 |
| **B 确定性派生**（算出来） | 此刻天气、路边花草分布、某株植物长到第几阶段、路上几辆车在哪 | **不存** | 存了就是冗余：每加一棵草写库、每辆车写状态，存档会爆 |
| **C 持久状态**（玩家改变的东西） | 自己种下的花（位置 + 种下时间 + 浇水累计）、买的地皮 | 存档 `data_json` | 这是"玩家行为"，无法推导，必须存 |

**判定规则**：能由「种子 + 时间 + 玩家行为」重算出来的，一律不存。

### 现在的环境包

```
content/environment/
├─ climate.json   天气 5 种（晴/多云/小雨/雷雨/雪）+ 权重 + 光照关键帧；昼夜 5 段环境光；scope=local|global
├─ ambient.json   随机物密度（花/草/石头/蘑菇）、生长 3 阶段、车流速度与车型
└─ seasons.json   四季草色/树冠/落叶 + months 分配 + weatherBias（冬雪夏雨）
```

### 确定性生成：为什么串门能看到同一片草地

```
seed = hash(userId)            // 每人家自己的一套天气与植被
weatherAt(seed, day, minute)   // 180 分钟一个 slot，slot 内稳定，末尾 25 分钟过渡
scatterProps(seed, rect)       // 逐格哈希：同一 seed + 同一格 → 永远同一个结果
growthStage(plantedAt, now)    // 由时间差推导，不写状态机
trafficAt(seed, minute, lanes) // 位置 = f(seed, minute, lane)，不需要服务端广播
```

因此：
- **换设备 / 断网重连**：同一片草地、同一场雨，因为都是算出来的
- **串门**：用对方的 seed 计算，看到的就是他平时看到的样子
- **存档体积**：只多出玩家亲手种的那几株（每株 4 个字段）

### 如果要"全服同一场雨"

现在是**每人家各自一套天气**（时间也是各自的）。要全服同步，加一张表：

```sql
CREATE TABLE world_state (
  key      TEXT PRIMARY KEY,   -- 'weather' / 'season' / 'event'
  value    TEXT NOT NULL,
  tick_at  TEXT NOT NULL
);
```

服务端定时 tick 写 `world_state`，客户端不再自己算 `weatherAt`，改为拉取。代价是多一次网络依赖，断网时天气会静止——**这是"共享"必然的代价**，与现在的离线优先是互斥的。

### 新增内容对应的改动

| 想加 | 改哪 | 要改代码吗 |
|---|---|---|
| 一种天气（如雾） | `climate.json` 加一条（id/label/weight/light/particles） | 否；粒子类型若全新，需注册一个粒子渲染器 |
| 一种随机物（如野果） | `ambient.json` 的 `densityPer100` 加键 + 一个贴图 | 否 |
| 一条马路 / 车道 | `maps/street.map.json` 加 `lanes` | 否（渲染器按 lane 画） |
| 生长更慢/更快 | `ambient.json` 的 `afterMinutes` | 否 |
| 天气影响玩法（如雨天心情-） | `climate.json` 的 `emotionPerHour` + 引擎读取 | 一次性接线 |

### 工具语义变更（重要）

内容搬到 `content/` 之后，`extract`（从 HTML 抽数据）方向就反了。现在：

```bash
node tools/content.mjs validate   # 校验
node tools/content.mjs bundle     # 刷新版本台账 + 打包给服务端
node tools/content.mjs all        # = validate + bundle（日常用这个）
node tools/content.mjs extract    # 已停用：检测到数据已迁移会直接拒绝并提示
```

`extract` 现在只保留"从旧版单文件重建内容"的能力，且必须有字面量才工作——否则会把手工维护的 `content/` 覆盖掉。

## 6.9 时间与天气：统一还是局部

> 结论：**时间最适合统一**（世界有唯一的钟），**天气两种都要支持**（局部=每人家各自，全局=全服同一场雨）。基础设施已建好，但默认仍跑旧模式——因为统一时间会打破三个现有机制，需要先定规则。

### 已建好的部分

**服务端：锚点式世界时钟（懒推进，无后台 goroutine）**

```sql
CREATE TABLE world_state (key TEXT PRIMARY KEY, value TEXT, tick_at TEXT);
-- key='clock'，value=世界总分钟数，tick_at=锚点现实时间
```

```
GET /api/v1/world
→ { totalMinute: 486.32, day: 1, minute: 486.32, rate: 1.0, syncedAt: "…" }
```

每次请求按 `现实时间差 × rate` 把时钟推到当下并写回锚点——**重启不回退、无需定时任务**。实测：`day=1 minute=480.0 rate=1.00`，连续两次请求单调不回退。

**客户端：`src/core/clock.js`（纯函数）**

```
totalMinute = anchor.totalMinute + (now - anchor.at) * rate / 60000
splitTotal / joinTotal / tickClock / clockDrift / fmtClock / isNight
```

- 两次同步之间客户端自己走钟，界面不卡
- 断网：用最后锚点继续走（自动降级为本地时钟）
- 回到线上：`clockDrift` 给出偏差；**≤30 分钟平滑插值抹平，>30 分钟硬对齐**（避免时钟"闪一下"）

**天气：`climate.json` 的 `scope` 开关**

```json
{ "scope": "local",      // local = 每人家各自天气；global = 全服同一场雨
  "scopeNote": "global 需要服务端 world_state 下发种子" }
```

```
weatherSeed(climate, userId, worldSeed)
  scope=local  → 'user:<userId>'
  scope=global → 'world:<worldSeed>'   // 所有人算出来同一场雨
```

### 统一时间会打破的三个机制（必须先定）

| 机制 | 现在的行为 | 统一时间下的冲突 | 可选方案 |
|---|---|---|---|
| **暂停 / 倍速**（HUD 有 0×/1×/2×） | 玩家自己控制时间流速 | 一个人暂停不能暂停全世界 | A 取消（世界统一）；B 保留为"个人表现倍率"但会与统一时间矛盾；C 倍率由服务端设定（`WORLD_RATE`） |
| **睡觉跳到早上 7 点** | `MINUTE = 7*60; DAY++`，跳过整夜 | 不能为自己跳过世界的一夜 | A 睡觉改为"休息 N 分钟、不跳钟"（世界照走）；B 多人投票跳过夜晚；C 睡眠只恢复数值 |
| **离线走钟** | 关闭页面时间也照走（存在存档里） | 存档不再拥有时间，只能暂存本地估算 | 已实现：锚点 + 漂移校正 |

### 当时的建议（已被 §6.9.1 的实现取代，保留作为决策记录）

- **时间统一，但要接受 A 方案**：取消暂停/倍速（或只保留"暂停时暂停输入"），睡觉改成"休息 120 游戏分钟"。这是唯一自洽的组合。
- **天气先保持局部**（`scope=local`）：单机手感更好、断网也有天气；等有多人玩法需要"一起看雨"时再切 `global`。
- 切换动作只有两行配置：`version.json` 的 `clockMode: "global"` + `climate.json` 的 `scope: "global"`，再加三个机制的具体改法。

### 6.9.1 已落地的第三种模式：对标北京时间（`timeSource: realtime`）

比 `global` 更彻底也更简单：**不假装世界有钟，直接用现实世界的钟**。

```jsonc
// content/rules/survival.json → clock
{ "timeSource": "realtime", "timeZoneOffsetHours": 8, "simMinutesPerRealSecond": 1 }
```

关键设计是**两个时钟解耦**：

| 时钟 | 来源 | 用途 |
|---|---|---|
| 显示时钟 `MINUTE/DAY` | UTC+8 真实时间 | 光照、季节、HUD 时刻、窗户亮不亮 |
| 模拟时钟 `simMin` | 在线时长 × `simMinutesPerRealSecond` | 饥饿 / 口渴 / 情绪衰减 |

若共用一个时钟：用真实时间 → 一天 24 小时现实，玩家永远不饿；用快速时钟 → 显示时刻脱离真实。
**拆开才能两者都对**：晚上 9 点打开就是夜晚，玩 10 分钟就过 10 分钟的生活。

上表那三个冲突按"A 方案"处理并已实现：

- 暂停/倍速 → **禁用**（按钮显示"实时·北京"，点了给提示）
- 睡觉跳钟 → 改**小憩**（情绪照给、时钟不动）
- 离线走钟 → 下次打开直接对齐当时真实时间，跨天按日期差补

> 想回旧手感：`timeSource` 改回 `"game"`，其余代码零改动。
> `clockMode: global`（服务端世界钟）仍然保留，适合将来"多人同一场雨/同一个节日"的场景。
>
> **两个开关不要混**：`version.json` 的 `clockMode` 决定"要不要接服务端世界钟"（local/global），
> `survival.clock.timeSource` 决定"显示时间是不是北京时间"（realtime/game）。当前是 `local + realtime`：
> 不连服务端，但光照与时刻跟着现实走。


## 6.10 渲染性能（实测 + 已完成的优化）

```bash
node tools/perf.mjs                    # 三场景，CPU 软件光栅（稳定可复现，悲观值）
node tools/perf.mjs --gpu              # 硬件加速路径（接近玩家真实体验）
node tools/perf.mjs --dpr 2            # 高 DPI 屏
node tools/perf.mjs --scene stress     # 只跑压测
```

测量方式：注入探针，`render()` 连跑 120 次取均值（JS 录制）；每帧 `getImageData` 强制回读 1 像素逼浏览器立刻完成光栅化（含光栅化，属于**上界**）。另测**静止重绘率**：手动驱动 `loop` 150 帧让相机收敛后，统计后 120 帧真正重绘的比例。

### 优化前后对比（DPR 1，1280×800）

| 场景 | 网格 | 家具 | JS 录制 | 含光栅化 | 帧预算 | 静止重绘 |
|---|---|---|---|---|---|---|
| 普通小屋 | 20×16 | 8 | 0.65 → **0.39ms** | 2.81 → **2.15ms** | 17% → **13%** | 100% → **7%** |
| 别墅 | 26×20 | 18 | 1.19 → **0.64ms** | 5.17 → **3.78ms** | 31% → **23%** | 100% → **7%** |
| 压测（+夜晚） | 26×20 | 60 | 1.38 → **0.86ms** | 7.13 → **5.43ms** | 43% → **33%** | 100% → **7%** |

### DPR 2 压测（最恶劣：60 件家具 + 夜景）

| 渲染路径 | 含光栅化 | 帧预算 |
|---|---|---|
| 优化前 · CPU 软件光栅 | 20.30ms | 122% ⚠️ |
| **优化后 · CPU 软件光栅** | **17.23ms** | **103%** |
| **优化后 · GPU 硬件加速** | **4.98ms** | **30%** ✅ |

**关键结论：GPU 下 DPR 2 只比 DPR 1 慢 15%（4.34 → 4.98ms），CPU 软件光栅下慢 3.2 倍。**
填充率是 GPU 的强项，所以真实浏览器里这个场景**完全流畅**；软件光栅的 103% 是低端集显 / 远程桌面 / 虚拟机这类没有硬件加速的极端情况。

### 已完成的优化

| # | 优化 | 做法 | 实测收益 |
|---|---|---|---|
| ① | **画布上下文参数** | `getContext('2d', {alpha:false, desynchronized:true, colorSpace:'srgb'})` | 不透明画布让合成器跳过逐像素混合；desync 降低输入延迟；零成本 |
| ② | **地板静态层缓存** | 地板/草地画进离屏 canvas（世界坐标包裹盒），每帧只贴可见区 | 地板从 320–520 次填充降到 1 次贴图：别墅 5.17→3.78ms、压测 7.13→5.43ms |
| ③ | **按需渲染（dirty flag）** | 只在有移动/粒子/浮字/相机未收敛/状态标脏时绘制，静止时跳过 | **静止重绘 100% → 7%**（等于 250ms 兜底频率），静止时几乎不耗电 |
| ④ | **DPR 上限 2** | `min(devicePixelRatio, 2)` | DPR 3 设备像素量从 9× 降到 4×（实测 canvas 2512×1416 而非 3768×2124） |
| ⑤ | **灯晕贴图缓存** | 光晕预绘成 190×190 离屏图，运行时 `drawImage` + `globalAlpha` | 夜间每帧不再为每盏灯建 radialGradient |
| ⑥ | **异步素材标脏** | 家具/角色 SVG `onload` 里 `markDirty()` | 修掉"家具停在兜底方块"的显示 bug |

> `alpha:false` 与 `desynchronized` 在 headless 里实测均被接受（`getContextAttributes()` 读回 `alpha:false / desynchronized:true`）。

### 三个反直觉的教训（都踩过）

**1. 缓存不是免费午餐。** 第一版离屏层用透明背景，整张贴上去是**全屏 alpha 混合**——即使大部分像素 alpha=0 也要逐像素混合，DPR 2 光栅从 20.5ms **涨到** 25.4ms。改成 `alpha:false` + 自铺底色后才回到正向收益。

**2. `drawImage` 的坐标必须是整数物理像素、缩放比必须精确 1:1。** 在 DPR 变换下用逻辑坐标贴图（源/目标缩放比 2:1 但经过浮点），浏览器会走双线性重采样，代价极高。改到 `setTransform(1,0,0,1,0,0)` 下按物理像素 1:1 对齐后，DPR 2 从 24.2ms → **17.8ms**。

**3. 按需渲染必须给"异步改变画面"留出标脏点。** 家具 SVG 是异步栅格化的，加载完成若没有 `markDirty()`，画面就永远停在程序化兜底形状——家具全变方块。同理：内容热替换、窗口 resize、存档套用都要标脏。保底手段是 250ms 兜底重绘 + "动画由真变假时补一帧"，避免漏标导致画面卡死或残影。

### 技术路线调研结论（2026-11，GitHub + 生态）

| 候选技术 | 现状 | 对本项目的判断 |
|---|---|---|
| **WebGPU** | 已 Baseline：Chrome 113 / Firefox 141 / Safari 18.2+；2026 桌面约 87%、移动约 71%，iOS 老设备是短板 | **不做**。它赢在 10k+ draw call（约 3×），我们只有几百个；2D 休闲游戏留在 Canvas 2D 无实质劣势，还要付兼容性与"双击即玩"的代价 |
| **OffscreenCanvas + Worker 渲染** | 稳定可用 | **暂不做**。主线程渲染只占 4–5ms，搬到 worker 是为 60fps 都快保不住的场景准备的；且会引入消息同步复杂度 |
| **WebGL2 实现 Canvas2D API**（如 canvas-ultrafast） | 有成熟实现，`alpha:false + desynchronized` 是其核心卖点 | **不引入**。能保留 API 换来 GPU，但要加依赖、破单文件分发；我们靠静态层缓存已在 GPU 路径上跑到 30% |
| **等距游戏优化套路**（cull / atlas batch / 静态层缓存 / 干掉每帧分配） | 业界共识，GitHub 上有成套 skill 文档 | **全部采纳**。其中"静态层缓存"和"干掉每帧分配"是本次收益的主体；culling 对我们的固定小地图无意义（全部可见） |

> 一句话：**我们缺的不是更强的 API，而是"别重复画静止的东西"**。这一轮全部收益都来自后者。

### 仍可做（按性价比）

| 优化 | 说明 | 预计收益 | 风险 |
|---|---|---|---|
| drawables 数组复用 | 每帧仍新建 200–300 个 `{depth, fn}` 闭包，可改为数据驱动 + 对象池 | 减少 GC 抖动，JS 0.86 → 约 0.5ms | 中（要改深度排序的数据结构，易出错） |
| `ambientTint` 交给 CSS 合成层 | 夜景全屏叠加目前是 canvas 内一次全屏混合 | 夜间再省 2–3ms | 中（会影响灯晕亮度关系，需调视觉） |
| 地板层分块（chunk） | 超大地图时整层位图会超纹理上限 | 只对多地图/大房子有意义 | 低（当前地图远未到） |

### 其它规模指标（同一探针）

| 指标 | 值 | 说明 |
|---|---|---|
| 单文件体积 | 255 KB | 其中内容内联 40 KB、SVG 素材内联约占一半 |
| DOM 节点 | 219 | UI 很轻，加面板也不会炸 |
| 本地存档 | < 5 KB | 19 件家具 + 数值 |
| updateHUD | 0.01–0.03ms | 不需要节流 |
| 地板层位图 | 1472×752 逻辑 / DPR2 下 2944×1504（约 17MB） | 房型/风格/DPR 变化才重建 |


## 6.11 小区世界：从 32×20 到 68×48，以及"无限画布"的路

小区地图扩到 **68×48（3264 格）**：三条横路 + 两条纵路切出 9 个街区，24 栋楼（2–4 层）、
四家店、中心广场 + 喷泉、篮球场、儿童乐园、停车位、带荷花池的街心公园。

### 三个必须解决的工程问题

| 问题 | 做法 | 踩过的坑 |
|---|---|---|
| 地图变大不能变卡 | `visibleTileRange()` 由相机+视口反推可见格，只画视口内 | 无（但地面与物件必须分层，见下） |
| 地面不能参与深度排序 | 地面单独一层，先铺完再画物件 | 喷泉被前排地砖整块盖住，广场中央"看起来是空的" |
| 边界之外不能是空白 | 外围按哈希生成荒野草地/树林，随距离向灰雾化 | 无 |

### 数据驱动的程度

- 尺寸：`grid.w/h` → 引擎的 `STREET_W/H`（不再有硬编码常量）
- 楼房：`houses[].rect/floors/palette` → 高度、层数、窗户排数、门牌
- 分区：`zones[]` → 地面材质、地标（喷泉/篮架/滑梯/长椅）、寻路阻挡，**同一份数据**
- 出生点：`spawn` → 门口格子，传送门 `portals[].at` 与它一致
- 树：`treeRules` 的密度 + 门口避让，按哈希播种，不再手写坐标

### 实测（1280×800，CPU 软件光栅，悲观值）

| 场景 | JS 录制 | 含光栅化 | 帧预算 |
|---|---|---|---|
| 普通小屋（20×16，8 件家具） | 0.42ms | 2.56ms | 15% |
| 小区街道（68×48，24 栋楼 + 商店 + 家具级细节） | 1.70ms | 5.33ms | 32% |

地图从 640 格涨到 3264 格（5.1×），渲染成本只从 3.8ms 涨到 5.3ms——**涨的是"屏幕上的东西"，不是"地图里的东西"**。

### 走向"无限画布"还差什么

已经具备的：

- 相机始终以玩家为中心，没有边界夹取（走到哪画到哪）
- 视野裁剪，开销与地图尺寸解耦
- 地图之外有程序化荒野过渡，不会露出底色
- 加街区 = 加数据（zones / houses），渲染、寻路、树木播种自动跟随

**已经做完的**：

- 分区归属 / 树木播种 / 楼房索引全部改成 **16×16 区块惰性生成 + 缓存**（上限 1024 区块），
  启动成本与地图尺寸解耦。
- 实测（`node tools/bench-world.mjs`）：544×384（20.9 万格）下，
  旧的"全表预计算"要 **386ms**，新的"只建视口区块"是 **4.3ms**。
- 寻路与渲染都用上了分桶：`isStreetBlocked` 只查所在区块的楼，`renderStreet` 只取可见矩形内的楼。

**还差的（按顺序）**：

1. **街区数据拆文件**：现在所有街区都写在 `street.map.json` 一个文件里；
   拆成 `maps/street/district.*.json` 后，可以按玩家位置只加载附近几个。
2. **跨区块寻路**：BFS 仍限制在 `STREET_W/H` 内；真无限时要在区块图上分层寻路
   （先算区块级路线，再在区块内细化），否则一次远距离寻路会扫过整张图。
3. **远端街区**：多人玩法里"别人家所在的街区"需要从服务端拉布局，接口形态与 `room_snapshots` 一致。

## 7. 已确认的决策

| 议题 | 决定 | 影响 |
|---|---|---|
| 账号形态 | **游客一键开局**（首访自动建号 + token，后续可升级为第三方登录） | 无登录门槛；token 存 localStorage，只做"我是谁"的凭据，不做权限体系 |
| 部署环境 | **暂不部署，只做本地联调** | 服务端监听 `127.0.0.1:8787`，前端开发态直连；Docker/HTTPS 脚本留到上线再说 |
| 数据存储 | **SQL（关系列 + JSON 快照混合）**，不用纯 KV 也不拆家具行 | 见 §3 |
| 后端语言 | **Go（已落地）**：Go 1.26.10 + `modernc.org/sqlite`（纯 Go，无 cgo）+ `net/http` 原生路由；Node 方案仅作离线兜底不再使用 | 单二进制 15 MB，数据一个 `.db` 文件 |
| 前端形态 | **原生 DOM + 迷你打包器**，产出单文件可双击产物；**不引入 Vue/Vite**（引擎与 UI 已分层，将来要拆不阻塞） | 保留"双击即玩"的离线通道；`src/core/*` 保持框架无关 |
| 数据可见性 | 前端能看到自己的存档（必须能渲染），但**看不到别人的**；写入一律服务端复核 | 可见 ≠ 可改，见 §6.6 |
| 时间基准 | **对标北京时间**（`timeSource: "realtime"`，UTC+8），显示时钟与模拟衰减时钟分离 | 暂停/倍速在实时模式下禁用；睡觉改小憩，见 §6.9.1 |
| 天气范围 | `climate.scope: local \| global`，默认局部（每个玩家自己的天气），需要"全服一场雨"时切 global | 生成必须是确定性的（seed+天+分钟），不存档 |
| 未来地图 | **无限画布**，以玩家为中心；当前 68×48 是"一个街区"，不是上限 | 区块惰性生成已铺好路，见 §6.11 |
| 交互形态 | **点击对象弹菜单**（物品与 NPC 同一套动作表，verb 数据驱动） | 加动作只改数据，见内容文档 §6 |

**待办（不影响继续加内容）**：跨区块寻路、街区数据拆文件、WebSocket 实时多人、上线部署。
