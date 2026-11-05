# 小屋服务端（Go + SQLite）

把玩家数据从 `localStorage` 挪到服务端，作为**唯一真相**。
零外部依赖：纯 Go 标准库 + `modernc.org/sqlite`（纯 Go 驱动，**不需要 cgo/gcc**）。

---

## 1. 环境前提（本机实测）

| 项 | 值 |
|---|---|
| Go 工具链 | `C:/Users/Administrator/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.windows-amd64/bin/go.exe` |
| 为什么不用 `D:/Go/go/bin/go` | 那是 1.22.5，而 `modernc.org/sqlite v1.61.0` 要求 `go >= 1.26`，会直接报错 |
| 网络 | 外网不可达（`goproxy.cn` 超时），但所需模块**已在本地模块缓存**，所以必须 `GOPROXY=off` |

## 2. 构建与运行

```bash
GO="C:/Users/Administrator/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.windows-amd64/bin/go.exe"

# 首次（或改了 go.mod 后）：只解析本地缓存
cd E:/QHTML/server
GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off "$GO" mod tidy

# 编译
GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off "$GO" build -o home-server.exe .

# 内容配置（改了家具目录/房型/装修风格/规则后统一走内容层工具）
cd E:/QHTML && node tools/content.mjs all   # extract → validate → bundle

# 启动（默认 127.0.0.1:8787，数据库 server/data/home.db）
cd E:/QHTML/server && ./home-server.exe

# 接口自测（进程内 httptest，不起端口、不需要网络）
./home-server.exe -selftest
```

环境变量：`ADDR`（监听地址）、`DB_PATH`（SQLite 文件）、`CONTENT_PATH`（内容配置）、`WORLD_RATE`（世界时钟倍率，单位「游戏分钟 / 真实分钟」，默认 60 → 1 天 = 24 分钟真实时间）。

> `WORLD_RATE` 就是整个游戏的时间快慢：账单周期和「每天只能上一次班」都挂在游戏日上。
> 调到 120 是「1 天 = 12 分钟」，调到 180 是「1 天 = 8 分钟」，不用改任何代码。

## 3. 接口（16 条）

带 🔒 的需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 存活探针 |
| GET | `/api/v1/meta` | 版本握手：`{app, minApp, saveSchema, contentVersion, modules}`，客户端据此决定要不要提示刷新 |
| GET | `/api/v1/world` | **统一世界时钟**：`{totalMinute, day, minute, rate, syncedAt}`，懒推进，见第 6 节 |
| POST | `/api/v1/auth/guest` | 游客一键开局，返回 `{userId, token, nickname}` |
| GET | `/api/v1/content` | 内容全量（`content/content.json`） |
| GET | `/api/v1/content/pack/{id...}` | 单包下发，供模块级热更新 |
| GET 🔒 | `/api/v1/me` | 当前用户 + 存档摘要 |
| GET 🔒 | `/api/v1/save` | 取存档，响应带 `ETag`（版本号） |
| PUT 🔒 | `/api/v1/save` | 写存档，请求头 `If-Match` 必须是客户端所基于的版本 |
| GET | `/api/v1/leaderboard` | 装修度排行榜（`flagged` 的存档不进榜） |
| GET | `/api/v1/rooms/feed` | 串门列表（最近上传的房间） |
| GET | `/api/v1/buildings/{buildingId}/rooms` | 楼栋住户目录：按楼层列出每个房号的状态与住户 |
| POST 🔒 | `/api/v1/rooms/{userId}/visit` | 记一次串门（被参观次数） |
| GET 🔒 | `/api/v1/friends` | 好友列表（带对方房间布局） |
| POST 🔒 | `/api/v1/friends/{userId}` | 加好友（单向关注，幂等） |
| DELETE 🔒 | `/api/v1/friends/{userId}` | 删好友 |

## 4. 数据表（8 张）

| 表 | 用途 |
|---|---|
| `users` | 账号（游客自动建号）、昵称、token |
| `saves` | 存档主体：`data_json` 原样保留，另抽 `cozy_score / money / day / house_level / floor_style / wall_style / res_* / flagged` 成列供查询与排序 |
| `estates` | 房产：一人最多 3 套（含自住），主键 `(user_id, building, floor, room)` |
| `save_history` | 存档历史版本，用于回溯与冲突排查 |
| `room_snapshots` | 房间快照：昵称 / 房型 / 风格 / 家具布局 / 装修度，**由服务端裁剪生成**（不含钱和数值） |
| `visit_log` | 串门记录 |
| `friendships` | 单向好友关系 |
| `world_state` | 世界时钟锚点：`key='clock'` → `value`(totalMinute) + `tick_at` |

## 5. 存档写入的并发控制

```
客户端 PUT /save
  ├─ If-Match 缺失或 "0"      → 首次写入
  ├─ If-Match == 服务端版本   → 正常覆盖，版本 +1
  └─ If-Match <  服务端版本   → 409，带服务端当前数据，客户端做字段级合并后重试
```

写档时的服务端动作：

1. `data_json` 原样保存（**不认识的新字段不会丢**，客户端加字段不用改服务端）
2. `cozy_score` **由服务端按 catalog 重算**，客户端算的不作数
3. 数值夹紧：`money/day` 为负直接 400；`house_level/style` 越界夹到合法区间并置 `flagged=1`
4. `estates` 整表替换（先 DELETE 后批量 INSERT），并夹到 3 套
5. `room_snapshots` 由本次存档裁剪生成，给排行榜和串门用

## 6. 世界时钟（`/api/v1/world`）

不跑后台 goroutine，**每次请求按现实时间差把时钟推到当下**并存回 `world_state`：

```
total = 上次存的 value + (now - tick_at) × rate
day   = floor(total / 1440) + 1
minute = total - (day-1) × 1440
```

- `rate` 单位是「游戏分钟 / 真实分钟」，默认 **60** → 1 真实分钟 = 1 游戏小时 → **1 天 = 24 分钟真实时间**
- 想改节奏直接设环境变量 `WORLD_RATE`，不用改代码也不用重新编译
- 客户端拿到锚点后本地插值，每 30 秒校准一次；离线时从存档里 `world.total` 继续走
- **所有玩家共用一个日历**：账单周期（7/15/30 天）和「每天只能上一次班」都以它为准

## 7. 自测与排错

```bash
./home-server.exe -selftest    # 进程内 httptest，不起端口、不需要网络
```

覆盖：游客建号、存档读写、并发 409、数值夹紧、排行榜过滤、楼栋目录、好友增删、内容包下发、
世界时钟（合法性 / 不回退 / 推进速度）。

**本机排错记录**

| 现象 | 原因 | 处理 |
|---|---|---|
| `curl` 连 `127.0.0.1:8787` 超时 | 环境里有 `http_proxy=127.0.0.1:xxxxx`，把本地请求也代理走了 | 用 `--noproxy '*'`，或 `unset http_proxy https_proxy`；只在这台机器上要处理 |
| `建表失败: no such column: res_building` | 老库缺 `res_*` 列，而 `schema.sql` 里的 `CREATE INDEX` 比 `migrate()` 的 `ALTER TABLE` 先执行 | 已把该索引挪进 `migrate()` 里建；老库启动时自动补列，无需手动干预 |
| `go: downloading go1.26.0` 卡住 | `go.mod` 要求 1.26，本机 `D:/Go/go` 是 1.22.5 | 用上面第 1 节的 toolchain 路径；或让 Go 自动下载（首次会慢） |
