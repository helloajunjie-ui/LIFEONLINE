-- 「我的 2.5D 小屋」服务端 Schema（SQLite）
-- 设计原则：需要查询/排序/统计的字段抽成列，前端强耦合的布局细节存 JSON

PRAGMA foreign_keys = ON;

-- 用户：游客一键开局（token 只存 hash）
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  nickname   TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen  TEXT
);

-- 存档：一人一条快照，version 做乐观锁
CREATE TABLE IF NOT EXISTS saves (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL DEFAULT 1,
  data_json   TEXT NOT NULL,
  cozy_score  INTEGER NOT NULL DEFAULT 0,
  money       INTEGER NOT NULL DEFAULT 0,
  day         INTEGER NOT NULL DEFAULT 1,
  house_level INTEGER NOT NULL DEFAULT 0,
  floor_style INTEGER NOT NULL DEFAULT 0,
  wall_style  INTEGER NOT NULL DEFAULT 0,
  res_building TEXT NOT NULL DEFAULT '',  -- 住址：楼栋 id（公寓楼目录按它查）
  res_floor    INTEGER NOT NULL DEFAULT 0,
  res_room     INTEGER NOT NULL DEFAULT 0,
  flagged     INTEGER NOT NULL DEFAULT 0,   -- 1 = 检测到异常数值（本轮被夹紧），排行榜不展示
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saves_cozy ON saves(cozy_score DESC);
-- 注：idx_saves_building 不在这里建。老库的 saves 表还没有 res_* 列，
-- schemaSQL 先执行会直接报 "no such column"；该索引统一放到 migrate() 补完列之后再建。

-- 房产：一人最多 3 套（含自住），自住那套一定在这里
-- 为什么要单独建表：公寓楼目录要按楼栋列出这一户是谁的，
-- 只靠 saves.res_* 的话，第二、第三套房在世界上是看不见的（还会被当成待售重复卖）。
CREATE TABLE IF NOT EXISTS estates (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  building   TEXT NOT NULL,
  floor      INTEGER NOT NULL DEFAULT 0,
  room       INTEGER NOT NULL DEFAULT 0,
  mode       TEXT NOT NULL DEFAULT 'owned',   -- owned=自有 / rented=租住
  paid       INTEGER NOT NULL DEFAULT 0,      -- 当初付了多少（卖房回收按它算）
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, building, floor, room)
);
CREATE INDEX IF NOT EXISTS idx_estates_unit ON estates(building, floor, room);

-- 历史版本：保留最近 20 版，防手滑 / 可回溯
CREATE TABLE IF NOT EXISTS save_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  data_json  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_user ON save_history(user_id, version DESC);

-- 参观快照：从存档裁剪出的只读房间（不含数值）
CREATE TABLE IF NOT EXISTS room_snapshots (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  cozy_score INTEGER NOT NULL DEFAULT 0,
  visits     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_cozy ON room_snapshots(cozy_score DESC);

-- 串门记录：后续做"今日访客""互访奖励"
CREATE TABLE IF NOT EXISTS visit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user  TEXT NOT NULL,
  to_user    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 好友：单向关注（我加了你 ≠ 你加了我）。查"谁加了我"用 friend_id 索引。
-- 只存关系，不存副本：好友的昵称/房间一律 join room_snapshots 现取，避免改名/搬家后不一致。
CREATE TABLE IF NOT EXISTS friendships (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_reverse ON friendships(friend_id);

-- 世界状态：统一时间 / 全服天气等"所有人共享"的值
-- 目前用 clock：value 存 totalMinute（第1天00:00起的游戏分钟），tick_at 存锚点现实时间
CREATE TABLE IF NOT EXISTS world_state (
  key     TEXT PRIMARY KEY,
  value   TEXT NOT NULL,
  tick_at TEXT NOT NULL
);
