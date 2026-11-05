// 「我的 2.5D 小屋」服务端 —— 单文件 Go + SQLite（modernc，纯 Go 无 cgo）
//
// 职责：把玩家数据从 localStorage 挪到服务端，成为唯一真相。
// 目标环境：本机联调（127.0.0.1:8787），不依赖任何外部网络。
//
// 主要接口：
//   POST /api/v1/auth/guest        游客一键开局，返回 token
//   GET  /api/v1/me                当前用户信息 + 存档摘要
//   GET  /api/v1/content           家具目录 / 房型 / 装修风格（带 ETag）
//   GET  /api/v1/save              读存档
//   PUT  /api/v1/save              写存档（If-Match 版本号做乐观锁，冲突返回 409）
//   GET  /api/v1/leaderboard       装修度排行榜
//   GET  /api/v1/rooms/feed        可参观的房间（随机）
//   POST /api/v1/rooms/{id}/visit  记录一次串门
//   GET  /api/v1/health            健康检查
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

/* ------------------------------ 内容配置 ------------------------------ */

type CatalogItem struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Cat    string  `json:"cat"`
	Price  float64 `json:"price"`
	W      int     `json:"w"`
	H      int     `json:"h"`
	Cozy   int     `json:"cozy"`
	Walk   bool    `json:"walk"`
	Action *string `json:"action"`
}

type Content struct {
	Version     int                  `json:"version"`
	Modules     map[string]ModuleVer `json:"modules"`
	GeneratedAt string        `json:"generatedAt"`
	Catalog     []CatalogItem `json:"catalog"`
	HouseLevels []any         `json:"houseLevels"`
	FloorStyles []any         `json:"floorStyles"`
	WallStyles  []any         `json:"wallStyles"`
}

// 构建版本信息（version.json + 内容指纹），通过 /api/v1/meta 下发给客户端做升级判定
type BuildInfo struct {
	AppVersion     string               `json:"appVersion"`
	MinAppVersion  string               `json:"minAppVersion"`
	SaveSchema     int                  `json:"saveSchema"`
	ContentVersion int                  `json:"contentVersion"`
	ContentHash    string               `json:"contentHash"`
	StartedAt      string               `json:"startedAt"`
	Modules        map[string]ModuleVer `json:"modules"`
}

// 单个内容包的独立版本：version 给人看，hash 给机器比对
type ModuleVer struct {
	Version   int    `json:"version"`
	Hash      string `json:"hash"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

var (
	contentJSON []byte
	contentETag string
	cozyByID    = map[string]int{}
	// 内容层规模：用于夹紧客户端上报的等级/风格索引
	contentLevels int
	contentFloors int
	contentWalls  int
	buildInfo     = BuildInfo{AppVersion: "dev", MinAppVersion: "0.0.0", SaveSchema: 1}
)

func loadContent(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var c Content
	if err := json.Unmarshal(b, &c); err != nil {
		return err
	}
	for _, it := range c.Catalog {
		cozyByID[it.ID] = it.Cozy
	}
	contentLevels = len(c.HouseLevels)
	contentFloors = len(c.FloorStyles)
	contentWalls = len(c.WallStyles)
	contentJSON = b
	sum := sha256.Sum256(b)
	contentETag = `"` + hex.EncodeToString(sum[:8]) + `"`
	buildInfo.ContentVersion = c.Version
	buildInfo.Modules = c.Modules
	buildInfo.ContentHash = hex.EncodeToString(sum[:])[:12]
	return nil
}

// 读取仓库根目录的 version.json（与服务端 bundle 一起决定"谁该升级"）
func loadVersionFile(path string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var v struct {
		App    string `json:"app"`
		MinApp string `json:"minApp"`
		Save   int    `json:"saveSchema"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	if v.App != "" {
		buildInfo.AppVersion = v.App
	}
	if v.MinApp != "" {
		buildInfo.MinAppVersion = v.MinApp
	}
	if v.Save > 0 {
		buildInfo.SaveSchema = v.Save
	}
	return nil
}

/* ------------------------------ 存档结构 ------------------------------ */

type PlacedItem struct {
	CatalogID string `json:"catalogId"`
	Gx        int    `json:"gx"`
	Gy        int    `json:"gy"`
}

// 只解析服务端需要校验/建索引的字段，其余原样透传保存
type ResidenceShape struct {
	Building string `json:"buildingId"`
	Floor    int    `json:"floor"`
	Room     int    `json:"room"`
}

// 房产：一人最多 3 套（含自住）。paid 是当初付了多少，卖房回收按它算。
type EstateShape struct {
	Building string `json:"buildingId"`
	Floor    int    `json:"floor"`
	Room     int    `json:"room"`
	Mode     string `json:"mode"`
	Paid     int    `json:"paid"`
}

type SaveShape struct {
	Placed     []PlacedItem   `json:"placed"`
	Address    string         `json:"address"`
	Estates    []EstateShape  `json:"estates"`
	Residence  ResidenceShape `json:"residence"`
	Money      float64        `json:"money"`
	Day        int          `json:"day"`
	HouseLevel int          `json:"houseLevel"`
	FloorStyle int          `json:"floorStyle"`
	WallStyle  int          `json:"wallStyle"`
}

func (s SaveShape) cozyScore() int {
	total := 0
	for _, p := range s.Placed {
		total += cozyByID[p.CatalogID]
	}
	return total
}

/* ------------------------------ 应用上下文 ------------------------------ */

type App struct {
	db *sql.DB
}

func main() {
	selftest := flag.Bool("selftest", false, "运行内置接口自测（进程内 httptest，不走网络）后退出")
	flag.Parse()

	dbPath := envOr("DB_PATH", filepath.Join("data", "home.db"))
	contentPath := envOr("CONTENT_PATH", filepath.Join("content", "content.json"))
	addr := envOr("ADDR", "127.0.0.1:8787")
	if *selftest {
		dbPath = filepath.Join(os.TempDir(), "home-selftest.db")
		_ = os.Remove(dbPath)
	}

	if err := loadContent(contentPath); err != nil {
		log.Fatalf("加载内容配置失败 (%s): %v\n提示：先在仓库根目录执行 node tools/content.mjs all", contentPath, err)
	}
	// 版本文件缺失只告警：服务端仍可跑，但客户端拿不到准确的升级建议
	if err := loadVersionFile(envOr("VERSION_PATH", filepath.Join("..", "version.json"))); err != nil {
		log.Printf("提示: 未读到 version.json（%v），/meta 将使用默认版本", err)
	}
	buildInfo.StartedAt = now()

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		log.Fatalf("创建数据目录失败: %v", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1) // SQLite 单写者，串行化最省心
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`); err != nil {
		log.Fatalf("设置 PRAGMA 失败: %v", err)
	}
	if err := migrate(db); err != nil {
		log.Fatalf("建表失败: %v", err)
	}

	app := &App{db: db}
	handler := app.routes()

	if *selftest {
		os.Exit(runSelfTest(handler))
	}

	log.Printf("小屋服务端已启动  http://%s   (db=%s)", addr, dbPath)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatal(err)
	}
}

// routes 集中注册路由（main 与 selftest 共用同一份，保证测的就是跑的）
func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", a.health)
	mux.HandleFunc("GET /api/v1/meta", a.meta)
	mux.HandleFunc("GET /api/v1/world", a.world)
	mux.HandleFunc("POST /api/v1/auth/guest", a.guest)
	mux.HandleFunc("GET /api/v1/content", a.content)
	mux.HandleFunc("GET /api/v1/content/pack/{id...}", a.contentPack)
	mux.HandleFunc("GET /api/v1/me", a.withAuth(a.me))
	mux.HandleFunc("GET /api/v1/save", a.withAuth(a.getSave))
	mux.HandleFunc("PUT /api/v1/save", a.withAuth(a.putSave))
	mux.HandleFunc("GET /api/v1/leaderboard", a.leaderboard)
	mux.HandleFunc("GET /api/v1/rooms/feed", a.roomsFeed)
	mux.HandleFunc("GET /api/v1/buildings/{buildingId}/rooms", a.buildingRooms)
	mux.HandleFunc("POST /api/v1/rooms/{userId}/visit", a.withAuth(a.visitRoom))
	mux.HandleFunc("GET /api/v1/friends", a.withAuth(a.listFriends))
	mux.HandleFunc("POST /api/v1/friends/{userId}", a.withAuth(a.addFriend))
	mux.HandleFunc("DELETE /api/v1/friends/{userId}", a.withAuth(a.removeFriend))
	mux.HandleFunc("GET /api/v1/business", a.listBusiness)
	mux.HandleFunc("POST /api/v1/business/{shopId}/take", a.withAuth(a.takeBusiness))
	mux.HandleFunc("POST /api/v1/business/{shopId}/release", a.withAuth(a.releaseBusiness))
	return cors(mux)
}

func migrate(db *sql.DB) error {
	if _, err := db.Exec(schemaSQL); err != nil {
		return err
	}
	// 老库补列：SQLite 重复加列会报错，忽略即可
	_, _ = db.Exec(`ALTER TABLE saves ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`)
	// 老库补住址列（公寓楼目录靠它查；重复加列会报错，忽略即可）
	_, _ = db.Exec(`ALTER TABLE saves ADD COLUMN res_building TEXT NOT NULL DEFAULT ''`)
	_, _ = db.Exec(`ALTER TABLE saves ADD COLUMN res_floor INTEGER NOT NULL DEFAULT 0`)
	_, _ = db.Exec(`ALTER TABLE saves ADD COLUMN res_room INTEGER NOT NULL DEFAULT 0`)
	_, _ = db.Exec(`CREATE INDEX IF NOT EXISTS idx_saves_building ON saves(res_building, res_floor, res_room)`)
	// 老库补房产表：把每个存档的当前住址当成他的第一套房（初始房不收费，paid=0）
	_, _ = db.Exec(`INSERT OR IGNORE INTO estates(user_id, building, floor, room, mode, paid, updated_at)
		SELECT user_id, res_building, res_floor, res_room, 'owned', 0, updated_at
		FROM saves WHERE res_building <> ''`)
	return nil
}

/* ------------------------------ 中间件 ------------------------------ */

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 本地联调：前端可能是 file:// （Origin: null）或 localhost 任意端口
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-Match")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Expose-Headers", "ETag")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type ctxUser struct {
	ID       string
	Nickname string
}

type authedHandler func(http.ResponseWriter, *http.Request, ctxUser)

func (a *App) withAuth(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := bearer(r)
		if tok == "" {
			fail(w, http.StatusUnauthorized, "缺少 token")
			return
		}
		var u ctxUser
		err := a.db.QueryRow(
			`SELECT id, nickname FROM users WHERE token_hash = ?`, hashToken(tok),
		).Scan(&u.ID, &u.Nickname)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, http.StatusUnauthorized, "token 无效")
			return
		}
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		_, _ = a.db.Exec(`UPDATE users SET last_seen = ? WHERE id = ?`, now(), u.ID)
		h(w, r, u)
	}
}

// optionalUser：带 token 就认人，不带也放行。
// 用途是公开列表里标出"哪几家是我的"——客户端不需要自己维护 userId。
func (a *App) optionalUser(r *http.Request) string {
	tok := bearer(r)
	if tok == "" {
		return ""
	}
	var uid string
	_ = a.db.QueryRow(`SELECT id FROM users WHERE token_hash = ?`, hashToken(tok)).Scan(&uid)
	return uid
}

/* ------------------------------ handlers ------------------------------ */

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"ok": true, "time": now()})
}

// worldClock 返回当前世界时钟（total 游戏分钟、rate）。
// 懒推进：不跑后台 goroutine，每次调用按上次 tick_at 到现在的真实时间差 × rate 推到当下并存回。
// rate 的单位是「游戏分钟 / 真实分钟」：60 → 1 真实分钟 = 1 游戏小时 → 1 游戏天 = 24 分钟真实时间。
// 这是"每天只能上一次班 + 账单按天记 + 承包按天结算"的能量来源，调它就是调游戏节奏。
func (a *App) worldClock() (float64, float64, error) {
	rate := 60.0
	if v := os.Getenv("WORLD_RATE"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			rate = f
		}
	}
	stamp := time.Now()

	var val, tickAt string
	err := a.db.QueryRow(`SELECT value, tick_at FROM world_state WHERE key='clock'`).Scan(&val, &tickAt)
	var total float64
	switch {
	case errors.Is(err, sql.ErrNoRows):
		total = 8 * 60 // 第 1 天 08:00 起步
	case err != nil:
		return 0, rate, err
	default:
		base, _ := strconv.ParseFloat(val, 64)
		elapsed := 0.0
		if t, e := time.Parse(time.RFC3339Nano, tickAt); e == nil {
			elapsed = stamp.Sub(t).Minutes() * rate
		}
		if elapsed < 0 {
			elapsed = 0
		}
		total = base + elapsed
	}

	// 把锚点推到现在（下次请求从这里继续），保证重启后时间不回退
	if _, e := a.db.Exec(`INSERT INTO world_state(key, value, tick_at) VALUES('clock', ?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value, tick_at=excluded.tick_at`,
		strconv.FormatFloat(total, 'f', 3, 64), stamp.Format(time.RFC3339Nano)); e != nil {
		return 0, rate, e
	}
	return total, rate, nil
}

// worldDay 把总分钟换算成游戏天数（第 1 天起）
func worldDay(total float64) int { return int(total/1440) + 1 }

// world：统一世界时钟。返回锚点（totalMinute + 服务器时间戳），客户端据此推算。
func (a *App) world(w http.ResponseWriter, r *http.Request) {
	total, rate, err := a.worldClock()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	day := worldDay(total)
	minute := total - float64((day-1)*1440)
	w.Header().Set("Cache-Control", "no-store")
	ok(w, map[string]any{
		"totalMinute": total,
		"day":         day,
		"minute":      minute,
		"rate":        rate,
		"syncedAt":    time.Now().Format(time.RFC3339Nano),
	})
}

/* ------------------------ 功能点承包（全局独占） ------------------------
 * 一个店铺同时只能有一个承包人，所以状态必须放服务端。
 * 到期不清行：end_day 过了就当空位，下一个承包人用 upsert 覆盖，省掉定时任务。
 * 钱的校验在客户端（服务端只做"谁占着"的权威），因为数值体系都在内容层。 */

func (a *App) listBusiness(w http.ResponseWriter, r *http.Request) {
	total, _, err := a.worldClock()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	day := worldDay(total)
	rows, err := a.db.Query(`SELECT b.shop_id, b.user_id, COALESCE(u.nickname,''), b.start_day, b.end_day, b.fee
		FROM businesses b LEFT JOIN users u ON u.id = b.user_id
		WHERE b.end_day >= ? ORDER BY b.end_day`, day)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	me := a.optionalUser(r)
	mine := []string{}
	for rows.Next() {
		var shopID, userID, nick string
		var sd, ed, fee int
		if err := rows.Scan(&shopID, &userID, &nick, &sd, &ed, &fee); err != nil {
			continue
		}
		if me != "" && userID == me {
			mine = append(mine, shopID)
		}
		items = append(items, map[string]any{
			"shopId": shopID, "userId": userID, "nickname": nick,
			"startDay": sd, "endDay": ed, "fee": fee, "daysLeft": ed - day,
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	ok(w, map[string]any{"day": day, "items": items, "mine": mine})
}

// takeBusiness：承包 / 续约。用一条 upsert 完成"检查 + 占用"，避免两次请求之间的竞态。
func (a *App) takeBusiness(w http.ResponseWriter, r *http.Request, u ctxUser) {
	shopID := r.PathValue("shopId")
	if shopID == "" || len(shopID) > 64 {
		fail(w, http.StatusBadRequest, "店铺 id 不合法")
		return
	}
	var body struct {
		TermDays int `json:"termDays"`
		Fee      int `json:"fee"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "请求体解析失败")
		return
	}
	if body.TermDays < 1 || body.TermDays > 365 {
		fail(w, http.StatusBadRequest, "承包周期不合法")
		return
	}
	if body.Fee < 0 {
		fail(w, http.StatusBadRequest, "承包金不合法")
		return
	}
	total, _, err := a.worldClock()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	day := worldDay(total)
	// WHERE 条件就是并发锁：只有「本来就是我」或「已过期」才允许覆盖
	res, err := a.db.Exec(`INSERT INTO businesses(shop_id, user_id, start_day, end_day, fee, updated_at)
		VALUES(?,?,?,?,?,?)
		ON CONFLICT(shop_id) DO UPDATE SET
			user_id=excluded.user_id, start_day=excluded.start_day,
			end_day=excluded.end_day, fee=excluded.fee, updated_at=excluded.updated_at
		WHERE businesses.user_id = ? OR businesses.end_day < ?`,
		shopID, u.ID, day, day+body.TermDays, body.Fee, now(), u.ID, day)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		fail(w, http.StatusConflict, "这家店已经被别人承包了")
		return
	}
	ok(w, map[string]any{"ok": true, "day": day, "endDay": day + body.TermDays})
}

func (a *App) releaseBusiness(w http.ResponseWriter, r *http.Request, u ctxUser) {
	shopID := r.PathValue("shopId")
	if shopID == "" {
		fail(w, http.StatusBadRequest, "缺少店铺 id")
		return
	}
	res, err := a.db.Exec(`DELETE FROM businesses WHERE shop_id = ? AND user_id = ?`, shopID, u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, _ := res.RowsAffected()
	ok(w, map[string]any{"ok": true, "released": n})
}

// meta：把"服务端认哪个版本"告诉客户端，客户端据此决定是否提示刷新
func (a *App) meta(w http.ResponseWriter, r *http.Request) {	// 客户端模块键统一带 content/ 前缀（与服务端内部的文件路径键区分开，
	// 否则同一份数据两边键名不同，diff 会把所有模块都判成"新增"）
	prefixed := make(map[string]ModuleVer, len(buildInfo.Modules))
	for k, v := range buildInfo.Modules {
		prefixed["content/"+k] = v
	}
	out := buildInfo
	out.Modules = prefixed
	w.Header().Set("Cache-Control", "no-store")
	ok(w, out)
}

// contentPack：按模块单独下发一个内容包，让客户端只更新变化的那一块。
// id 形如 catalog/furniture.core.json，必须在 manifest 的模块表里，防止路径穿越。
func (a *App) contentPack(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ver, exists := buildInfo.Modules[id]
	if !exists || strings.Contains(id, "..") {
		fail(w, http.StatusNotFound, "没有这个内容包: "+id)
		return
	}
	// 内容目录：默认 ../content（与 server 同级）
	dir := envOr("CONTENT_DIR", filepath.Join("..", "content"))
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(id)))
	if err != nil {
		fail(w, http.StatusInternalServerError, "读取内容包失败: "+err.Error())
		return
	}
	etag := `"` + ver.Hash + `"`
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Module-Version", strconv.Itoa(ver.Version))
	_, _ = w.Write(b)
}

func (a *App) guest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Nickname string `json:"nickname"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<12)).Decode(&body)

	id := randomHex(8)
	tok := randomHex(32)
	nick := strings.TrimSpace(body.Nickname)
	if nick == "" {
		nick = "邻居" + id[:4]
	}
	if _, err := a.db.Exec(
		`INSERT INTO users(id, nickname, token_hash, created_at, last_seen) VALUES(?,?,?,?,?)`,
		id, nick, hashToken(tok), now(), now(),
	); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"userId": id, "token": tok, "nickname": nick, "hasSave": false})
}

func (a *App) content(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("If-None-Match") == contentETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("ETag", contentETag)
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(contentJSON)
}

func (a *App) me(w http.ResponseWriter, r *http.Request, u ctxUser) {
	var version, cozy, day int
	var updated string
	err := a.db.QueryRow(
		`SELECT version, cozy_score, day, updated_at FROM saves WHERE user_id = ?`, u.ID,
	).Scan(&version, &cozy, &day, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		ok(w, map[string]any{"userId": u.ID, "nickname": u.Nickname, "hasSave": false})
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{
		"userId": u.ID, "nickname": u.Nickname, "hasSave": true,
		"version": version, "cozyScore": cozy, "day": day, "updatedAt": updated,
	})
}

func (a *App) getSave(w http.ResponseWriter, r *http.Request, u ctxUser) {
	var version int
	var data, updated string
	err := a.db.QueryRow(
		`SELECT version, data_json, updated_at FROM saves WHERE user_id = ?`, u.ID,
	).Scan(&version, &data, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusNotFound, "还没有存档")
		return
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("ETag", strconv.Itoa(version))
	fmt.Fprintf(w, `{"version":%d,"data":%s,"updatedAt":%q}`, version, data, updated)
}

// putSave：写存档。
// 请求头 If-Match 必须是客户端当前所基于的版本（首次写入用 "0" 或不带）。
// 服务端版本更高时返回 409，并带上服务端版本与数据，交给前端做字段级合并。
func (a *App) putSave(w http.ResponseWriter, r *http.Request, u ctxUser) {
	var body struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4<<20)).Decode(&body); err != nil {
		fail(w, http.StatusBadRequest, "请求体解析失败: "+err.Error())
		return
	}
	if len(body.Data) == 0 {
		fail(w, http.StatusBadRequest, "缺少 data")
		return
	}
	var shape SaveShape
	if err := json.Unmarshal(body.Data, &shape); err != nil {
		fail(w, http.StatusBadRequest, "data 结构非法: "+err.Error())
		return
	}
	// 基本合法性：负钱/负天数说明客户端状态已损坏，宁可拒写也不要污染排行榜与存档
	if shape.Money < 0 || shape.Day < 0 {
		fail(w, http.StatusBadRequest, "存档数值非法（money/day 不能为负）")
		return
	}
	// 抽取列的取值按内容层长度夹紧（data_json 原样保留，避免篡改客户端数据）
	if max := contentLevels; max > 0 && (shape.HouseLevel < 0 || shape.HouseLevel >= max) {
		shape.HouseLevel = 0
	}
	if max := contentFloors; max > 0 && (shape.FloorStyle < 0 || shape.FloorStyle >= max) {
		shape.FloorStyle = 0
	}
	if max := contentWalls; max > 0 && (shape.WallStyle < 0 || shape.WallStyle >= max) {
		shape.WallStyle = 0
	}
	cozy := shape.cozyScore()

	// 住址列：服务端不做内容校验（楼栋是否存在由客户端 V4.8 保证），只做范围夹紧
	resB := strings.TrimSpace(shape.Residence.Building)
	if len(resB) > 64 {
		resB = ""
	}
	resF, resR := shape.Residence.Floor, shape.Residence.Room
	if resF < 0 { resF = 0 }
	if resF > 60 { resF = 60 }
	if resR < 0 { resR = 0 }
	if resR > 20 { resR = 20 }
	if resB == "" { resF, resR = 0, 0 }

	// 房产：客户端也会拦 3 套上限，但服务端不信客户端——再夹一遍，
	// 并且保证"自住那套"一定在列表里（否则目录会看不到自己，也卖不掉/搬不走）
	const maxEstates = 3
	estates := make([]EstateShape, 0, maxEstates)
	estateKeys := map[string]bool{}
	addEstate := func(b string, f, r int, mode string, paid int) bool {
		b = strings.TrimSpace(b)
		if b == "" || len(b) > 64 || len(estates) >= maxEstates {
			return false
		}
		if f < 0 {
			f = 0
		}
		if f > 60 {
			f = 60
		}
		if r < 0 {
			r = 0
		}
		if r > 20 {
			r = 20
		}
		key := fmt.Sprintf("%s|%d|%d", b, f, r)
		if estateKeys[key] {
			return false
		}
		estateKeys[key] = true
		if mode != "rented" {
			mode = "owned"
		}
		if paid < 0 {
			paid = 0
		}
		estates = append(estates, EstateShape{Building: b, Floor: f, Room: r, Mode: mode, Paid: paid})
		return true
	}
	for _, e := range shape.Estates {
		addEstate(e.Building, e.Floor, e.Room, e.Mode, e.Paid)
	}
	if resB != "" && !estateKeys[fmt.Sprintf("%s|%d|%d", resB, resF, resR)] {
		if len(estates) >= maxEstates {
			estates = estates[:maxEstates-1]
		}
		estates = append(estates, EstateShape{Building: resB, Floor: resF, Room: resR, Mode: "owned"})
	}

	// 读当前版本（顺带读上一版的钱/天数，用来做异常跳变检测）
	var curVersion int
	var curData string
	err := a.db.QueryRow(`SELECT version, data_json FROM saves WHERE user_id = ?`, u.ID).Scan(&curVersion, &curData)
	hasRow := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}

	var prevMoney, prevDay int64
	var prevFlagged int
	if hasRow {
		_ = a.db.QueryRow(`SELECT money, day, flagged FROM saves WHERE user_id = ?`, u.ID).
			Scan(&prevMoney, &prevDay, &prevFlagged)
	}

	// 客户端上报的数值可以"看见"，但不可以随便"改"：
	// 单次写入的钱/天数跳变超过合理上限 → 夹紧并标记，本次不入排行榜。
	// （正常产出：工作一次 +60 / 5 秒，睡觉 +1 天；1500 / 3 天已非常宽松）
	const maxMoneyJump = 1500
	const maxDayJump = 3
	flagged := prevFlagged
	if hasRow && flagged == 0 {
		if int64(shape.Money)-prevMoney > maxMoneyJump {
			shape.Money = float64(prevMoney + maxMoneyJump)
			flagged = 1
		}
		if int64(shape.Day)-prevDay > maxDayJump {
			shape.Day = int(prevDay) + maxDayJump
			flagged = 1
		}
	}
	if flagged == 1 {
		// 落库的 JSON 也改成夹紧后的值，避免客户端下次拉回来又是作弊值
		var mm map[string]any
		if json.Unmarshal(body.Data, &mm) == nil {
			mm["money"] = shape.Money
			mm["day"] = shape.Day
			if b, e := json.Marshal(mm); e == nil {
				body.Data = b
			}
		}
		log.Printf("存档数值异常已夹紧 user=%s money=%v day=%d", u.ID, shape.Money, shape.Day)
	}

	want := strings.Trim(r.Header.Get("If-Match"), `"`)
	if want == "" {
		want = "0"
	}
	base, err := strconv.Atoi(want)
	if err != nil {
		fail(w, http.StatusBadRequest, "If-Match 必须是版本号")
		return
	}
	current := 0
	if hasRow {
		current = curVersion
	}
	if base != current {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusConflict)
		fmt.Fprintf(w, `{"error":"版本冲突","serverVersion":%d,"serverData":%s}`, curVersion, curData)
		return
	}

	next := current + 1
	stamp := now()

	tx, err := a.db.Begin()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
		INSERT INTO saves(user_id, version, data_json, cozy_score, money, day, house_level, floor_style, wall_style,
		                  res_building, res_floor, res_room, flagged, updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET
		  version=excluded.version, data_json=excluded.data_json, cozy_score=excluded.cozy_score,
		  money=excluded.money, day=excluded.day, house_level=excluded.house_level,
		  floor_style=excluded.floor_style, wall_style=excluded.wall_style,
		  res_building=excluded.res_building, res_floor=excluded.res_floor, res_room=excluded.res_room,
		  flagged=excluded.flagged, updated_at=excluded.updated_at`,
		u.ID, next, string(body.Data), cozy, int64(shape.Money), shape.Day,
		shape.HouseLevel, shape.FloorStyle, shape.WallStyle,
		resB, resF, resR, flagged, stamp,
	); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 房产表：先清后写（一次保存就是一次全量快照，避免"卖掉又出现"）
	if _, err := tx.Exec(`DELETE FROM estates WHERE user_id = ?`, u.ID); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, e := range estates {
		if _, err := tx.Exec(`
			INSERT OR REPLACE INTO estates(user_id, building, floor, room, mode, paid, updated_at)
			VALUES(?,?,?,?,?,?,?)`,
			u.ID, e.Building, e.Floor, e.Room, e.Mode, e.Paid, stamp,
		); err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	if _, err := tx.Exec(
		`INSERT INTO save_history(user_id, version, data_json, created_at) VALUES(?,?,?,?)`,
		u.ID, next, string(body.Data), stamp,
	); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	// 只保留最近 20 版
	if _, err := tx.Exec(`DELETE FROM save_history WHERE user_id = ? AND id NOT IN (
		SELECT id FROM save_history WHERE user_id = ? ORDER BY version DESC LIMIT 20)`, u.ID, u.ID); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 参观快照：只放房间相关的部分
	snapshot := map[string]any{
		"nickname":   u.Nickname,
		"houseLevel": shape.HouseLevel,
		"floorStyle": shape.FloorStyle,
		"wallStyle":  shape.WallStyle,
		"placed":     shape.Placed,
		"address":    shape.Address,
		"building":   resB,
		"floor":      resF,
		"room":       resR,
	}
	snapJSON, _ := json.Marshal(snapshot)
	if _, err := tx.Exec(`
		INSERT INTO room_snapshots(user_id, nickname, payload, cozy_score, updated_at)
		VALUES(?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET
		  nickname=excluded.nickname, payload=excluded.payload,
		  cozy_score=excluded.cozy_score, updated_at=excluded.updated_at`,
		u.ID, u.Nickname, string(snapJSON), cozy, stamp,
	); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}

	if err := tx.Commit(); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}

	ok(w, map[string]any{"version": next, "cozyScore": cozy, "updatedAt": stamp})
}

func (a *App) leaderboard(w http.ResponseWriter, r *http.Request) {
	limit := clampInt(r.URL.Query().Get("limit"), 20, 1, 100)
	rows, err := a.db.Query(`
		SELECT u.id, u.nickname, s.cozy_score, s.house_level, s.day
		FROM saves s JOIN users u ON u.id = s.user_id
		WHERE s.flagged = 0
		ORDER BY s.cozy_score DESC, s.updated_at DESC LIMIT ?`, limit)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	list := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, nick string
		var cozy, level, day int
		if err := rows.Scan(&id, &nick, &cozy, &level, &day); err == nil {
			list = append(list, map[string]any{
				"userId": id, "nickname": nick, "cozyScore": cozy, "houseLevel": level, "day": day,
			})
		}
	}
	ok(w, map[string]any{"items": list})
}

func (a *App) roomsFeed(w http.ResponseWriter, r *http.Request) {
	limit := clampInt(r.URL.Query().Get("limit"), 10, 1, 50)
	rows, err := a.db.Query(`
		SELECT user_id, nickname, payload, cozy_score, visits
		FROM room_snapshots ORDER BY RANDOM() LIMIT ?`, limit)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	list := make([]map[string]any, 0, limit)
	for rows.Next() {
		var id, nick, payload string
		var cozy, visits int
		if err := rows.Scan(&id, &nick, &payload, &cozy, &visits); err == nil {
			list = append(list, map[string]any{
				"userId": id, "nickname": nick, "cozyScore": cozy, "visits": visits,
				"room": json.RawMessage(payload),
			})
		}
	}
	ok(w, map[string]any{"items": list})
}

// 公寓楼目录：某栋楼里所有已入住的房间（按楼层从高到低）。
// 客户端据此渲染 楼层×房号 网格，点有人住的房间就去串门；空房只显示"待入住"。
func (a *App) buildingRooms(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("buildingId"))
	if id == "" {
		fail(w, http.StatusBadRequest, "缺少楼栋 id")
		return
	}
	// 目录按"房产"查，而不是只按当前住址：一个人可能有 2~3 套，
	// 只看 saves.res_* 会让他的其它房在世界上显示成待售（然后被别人买走）。
	// 快照只在"这户就是他当前住址"时才挂上——空置的投资房没有可参观的装修。
	rows, err := a.db.Query(`
		SELECT e.user_id, u.nickname, e.floor, e.room, e.mode, s.cozy_score,
		       s.res_floor, s.res_room, r.payload
		FROM estates e
		JOIN saves s ON s.user_id = e.user_id
		JOIN users u ON u.id = e.user_id
		LEFT JOIN room_snapshots r ON r.user_id = e.user_id
		WHERE e.building = ? AND s.flagged = 0
		ORDER BY e.floor DESC, e.room ASC
		LIMIT 500`, id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	list := make([]map[string]any, 0, 24)
	for rows.Next() {
		var uid, nick, mode string
		var floor, room, cozy, homeFloor, homeRoom int
		var payload sql.NullString
		if err := rows.Scan(&uid, &nick, &floor, &room, &mode, &cozy, &homeFloor, &homeRoom, &payload); err != nil {
			continue
		}
		item := map[string]any{
			"userId": uid, "nickname": nick, "floor": floor, "room": room,
			"cozyScore": cozy, "mode": mode, "current": floor == homeFloor && room == homeRoom,
		}
		// 注意：房号字段已经叫 room，快照要用另一个键，否则会把房号覆盖成对象
		if floor == homeFloor && room == homeRoom && payload.Valid && payload.String != "" {
			item["snapshot"] = json.RawMessage(payload.String)
		}
		list = append(list, item)
	}
	ok(w, map[string]any{"buildingId": id, "items": list})
}

func (a *App) visitRoom(w http.ResponseWriter, r *http.Request, u ctxUser) {
	target := r.PathValue("userId")
	if target == "" || target == u.ID {
		fail(w, http.StatusBadRequest, "无效的访问目标")
		return
	}
	res, err := a.db.Exec(`UPDATE room_snapshots SET visits = visits + 1 WHERE user_id = ?`, target)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		fail(w, http.StatusNotFound, "这个房间不存在")
		return
	}
	_, _ = a.db.Exec(`INSERT INTO visit_log(from_user, to_user, created_at) VALUES(?,?,?)`, u.ID, target, now())
	ok(w, map[string]any{"ok": true})
}

/* ------------------------------ 好友 ------------------------------ */
// 好友列表：关系表只存 id，昵称/房间/装修度 join room_snapshots 现取，
// 这样对方改名、搬家、删档后列表不会残留过期副本。
func (a *App) listFriends(w http.ResponseWriter, r *http.Request, u ctxUser) {
	rows, err := a.db.Query(`
		SELECT s.user_id, s.nickname, s.payload, s.cozy_score, s.visits
		FROM friendships f JOIN room_snapshots s ON s.user_id = f.friend_id
		WHERE f.user_id = ? ORDER BY f.created_at DESC`, u.ID)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	list := make([]map[string]any, 0, 12)
	for rows.Next() {
		var id, nick, payload string
		var cozy, visits int
		if err := rows.Scan(&id, &nick, &payload, &cozy, &visits); err == nil {
			list = append(list, map[string]any{
				"userId": id, "nickname": nick, "cozyScore": cozy, "visits": visits,
				"room": json.RawMessage(payload),
			})
		}
	}
	ok(w, map[string]any{"items": list})
}

// 加好友：只能加"已经有房间快照"的玩家（否则加了也看不到东西）。
// 重复添加是幂等的，不报错——前端重试/双击不该弹失败。
func (a *App) addFriend(w http.ResponseWriter, r *http.Request, u ctxUser) {
	target := r.PathValue("userId")
	if target == "" || target == u.ID {
		fail(w, http.StatusBadRequest, "不能加自己为好友")
		return
	}
	var one int
	if err := a.db.QueryRow(`SELECT 1 FROM room_snapshots WHERE user_id = ?`, target).Scan(&one); err != nil {
		fail(w, http.StatusNotFound, "对方还没有房间，暂时加不了")
		return
	}
	if _, err := a.db.Exec(
		`INSERT OR IGNORE INTO friendships(user_id, friend_id, created_at) VALUES(?,?,?)`,
		u.ID, target, now(),
	); err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	ok(w, map[string]any{"ok": true})
}

func (a *App) removeFriend(w http.ResponseWriter, r *http.Request, u ctxUser) {
	target := r.PathValue("userId")
	if target == "" {
		fail(w, http.StatusBadRequest, "缺少好友 id")
		return
	}
	res, err := a.db.Exec(`DELETE FROM friendships WHERE user_id = ? AND friend_id = ?`, u.ID, target)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	n, _ := res.RowsAffected()
	ok(w, map[string]any{"ok": true, "removed": n})
}

/* ------------------------------ 小工具 ------------------------------ */

func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func now() string { return time.Now().Format(time.RFC3339) }

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func hashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func clampInt(s string, def, lo, hi int) int {
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
