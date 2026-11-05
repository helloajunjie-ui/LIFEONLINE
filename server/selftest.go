// 内置接口自测：直接用 httptest 记录器打真实路由，不监听端口。
// 用途：本机联调或 CI 里验证「鉴权 / 存档读写 / 乐观锁 / 服务端 cozy 复核」是否正常。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
)

type selftest struct {
	handler http.Handler
	pass    int
	failed  int
	token   string
	userID  string
}

func runSelfTest(h http.Handler) int {
	s := &selftest{handler: h}
	s.caseHealth()
	s.caseMeta()
	s.caseWorldClock()
	s.caseGuest()
	s.caseContent()
	s.caseSaveCreate()
	s.caseSaveConflict()
	s.caseSaveUpdate()
	s.caseLeaderboard()
	s.caseRoomsFeed()
	s.caseBuildingRooms()
	s.caseEstates()
	s.caseVisit()
	s.caseUnauthorized()
	s.caseUnknownCatalog()
	s.caseDoublePutSameVersion()
	s.caseVisitSelf()
	s.caseNegativeValues()
	s.casePackEndpoint()
	s.caseCheatMoneyClamped()
	s.caseFriends()
	s.caseBusiness()

	fmt.Printf("\n自测结果：PASS %d / FAIL %d\n", s.pass, s.failed)
	if s.failed > 0 {
		return 1
	}
	return 0
}

// 未知家具 id 不应报错，只是不计入装修度（避免前端新增了家具但服务端内容包还没更新就全挂）
func (s *selftest) caseUnknownCatalog() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"未知家具"}`, nil)
	var g struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)

	body := `{"data":{"placed":[{"catalogId":"not_a_real_item","gx":5,"gy":5}],"money":10,"day":1,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	rec = s.do("PUT", "/api/v1/save", body, map[string]string{
		"Authorization": "Bearer " + g.Token, "If-Match": "0",
	})
	if !s.check("未知家具写入 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		CozyScore int `json:"cozyScore"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if v.CozyScore == 0 {
		s.pass++
		fmt.Println("PASS | 未知家具不计入装修度")
	} else {
		s.failed++
		fmt.Printf("FAIL | 未知家具竟然计入 %d 分\n", v.CozyScore)
	}
}

// 同一版本号连推两次 → 第二次必须 409（乐观锁的核心保证）
func (s *selftest) caseDoublePutSameVersion() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"连推"}`, nil)
	var g struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	body := `{"data":{"placed":[],"money":1,"day":1,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	first := s.do("PUT", "/api/v1/save", body, map[string]string{"Authorization": "Bearer " + g.Token, "If-Match": "0"})
	second := s.do("PUT", "/api/v1/save", body, map[string]string{"Authorization": "Bearer " + g.Token, "If-Match": "0"})
	if s.check("首推 200", first.Code, http.StatusOK) {
		s.check("同版本重推 409", second.Code, http.StatusConflict)
	}
}

// 参观自己 → 400
func (s *selftest) caseVisitSelf() {
	rec := s.do("POST", "/api/v1/rooms/" + s.userID + "/visit", "", map[string]string{"Authorization": "Bearer " + s.token})
	s.check("参观自己 400", rec.Code, http.StatusBadRequest)
}

// 负数钱/天数 → 400（防止损坏的客户端状态污染存档与排行榜）
func (s *selftest) caseNegativeValues() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"脏数据"}`, nil)
	var g struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	body := `{"data":{"placed":[],"money":-100,"day":-3,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	rec = s.do("PUT", "/api/v1/save", body, map[string]string{
		"Authorization": "Bearer " + g.Token, "If-Match": "0",
	})
	s.check("负钱/负天数 400", rec.Code, http.StatusBadRequest)
}

func (s *selftest) do(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.handler.ServeHTTP(rec, req)
	return rec
}

func (s *selftest) check(name string, cod, want int) bool {
	if cod == want {
		s.pass++
		fmt.Printf("PASS | %s | %d\n", name, cod)
		return true
	}
	s.failed++
	fmt.Printf("FAIL | %s | 期望 %d 实得 %d\n", name, want, cod)
	return false
}

func (s *selftest) caseHealth() {
	rec := s.do("GET", "/api/v1/health", "", nil)
	s.check("health 200", rec.Code, http.StatusOK)
}

// 版本元信息：客户端靠它判断"要不要提示刷新"
func (s *selftest) caseMeta() {
	rec := s.do("GET", "/api/v1/meta", "", nil)
	if !s.check("meta 200", rec.Code, http.StatusOK) {
		return
	}
	var m struct {
		AppVersion     string `json:"appVersion"`
		MinAppVersion  string `json:"minAppVersion"`
		SaveSchema     int    `json:"saveSchema"`
		ContentVersion int    `json:"contentVersion"`
		ContentHash    string `json:"contentHash"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		s.failed++
		fmt.Printf("FAIL | meta 解析失败 %v\n", err)
		return
	}
	if m.AppVersion != "" && m.ContentVersion > 0 && len(m.ContentHash) == 12 && m.SaveSchema > 0 {
		s.pass++
		fmt.Printf("PASS | meta 字段完整 app=%s content=%d hash=%s schema=%d\n",
			m.AppVersion, m.ContentVersion, m.ContentHash, m.SaveSchema)
	} else {
		s.failed++
		fmt.Printf("FAIL | meta 字段异常 %+v\n", m)
	}
}

func (s *selftest) caseGuest() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"自测玩家"}`, nil)
	if !s.check("guest 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		Token  string `json:"token"`
		UserID string `json:"userId"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	s.token, s.userID = v.Token, v.UserID
	if len(s.token) == 64 && s.userID != "" {
		s.pass++
		fmt.Println("PASS | guest 返回 token/userId")
	} else {
		s.failed++
		fmt.Printf("FAIL | guest 返回异常 token=%q userId=%q\n", s.token, s.userID)
	}
}

func (s *selftest) caseContent() {
	rec := s.do("GET", "/api/v1/content", "", nil)
	s.check("content 200", rec.Code, http.StatusOK)
	if et := rec.Header().Get("ETag"); et != "" {
		rec2 := s.do("GET", "/api/v1/content", "", map[string]string{"If-None-Match": et})
		s.check("content 304 (ETag 复用)", rec2.Code, http.StatusNotModified)
	} else {
		s.failed++
		fmt.Println("FAIL | content 缺少 ETag")
	}
}

func (s *selftest) caseSaveCreate() {
	// 3 件家具：bed(6) + sofa(5) + rug_warm(4) = 15 分（服务端自行复核，不信客户端）
	body := `{"data":{"placed":[{"catalogId":"bed","gx":5,"gy":5},{"catalogId":"sofa","gx":8,"gy":5},{"catalogId":"rug_warm","gx":9,"gy":8}],
		"money":500,"day":1,"houseLevel":0,"floorStyle":0,"wallStyle":0,"address":"公寓楼 1803","residence":{"buildingId":"house.公寓楼","floor":18,"room":3}}}`
	rec := s.do("PUT", "/api/v1/save", body, map[string]string{
		"Authorization": "Bearer " + s.token, "If-Match": "0",
	})
	if !s.check("save 首次写入 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		Version    int `json:"version"`
		CozyScore  int `json:"cozyScore"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if v.Version == 1 && v.CozyScore == 15 {
		s.pass++
		fmt.Printf("PASS | 服务端 cozy 复核 = %d（版本 %d）\n", v.CozyScore, v.Version)
	} else {
		s.failed++
		fmt.Printf("FAIL | cozy 复核异常 version=%d cozy=%d\n", v.Version, v.CozyScore)
	}

	rec = s.do("GET", "/api/v1/save", "", map[string]string{"Authorization": "Bearer " + s.token})
	s.check("save 读取 200", rec.Code, http.StatusOK)
}

func (s *selftest) caseSaveConflict() {
	// 用过期版本再写一次 → 必须 409
	body := `{"data":{"placed":[],"money":1,"day":1,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	rec := s.do("PUT", "/api/v1/save", body, map[string]string{
		"Authorization": "Bearer " + s.token, "If-Match": "0",
	})
	s.check("过期版本写入 409", rec.Code, http.StatusConflict)
}

func (s *selftest) caseSaveUpdate() {
	body := `{"data":{"placed":[{"catalogId":"bed","gx":5,"gy":5}],"money":700,"day":2,"houseLevel":1,"floorStyle":1,"wallStyle":2,"address":"公寓楼 1803","residence":{"buildingId":"house.公寓楼","floor":18,"room":3}}}`
	rec := s.do("PUT", "/api/v1/save", body, map[string]string{
		"Authorization": "Bearer " + s.token, "If-Match": "1",
	})
	if !s.check("正确版本写入 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		Version   int `json:"version"`
		CozyScore int `json:"cozyScore"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if v.Version == 2 && v.CozyScore == 6 {
		s.pass++
		fmt.Printf("PASS | 版本递增到 %d，cozy 重算 %d\n", v.Version, v.CozyScore)
	} else {
		s.failed++
		fmt.Printf("FAIL | 更新后 version=%d cozy=%d\n", v.Version, v.CozyScore)
	}
}

func (s *selftest) caseLeaderboard() {
	rec := s.do("GET", "/api/v1/leaderboard?limit=5", "", nil)
	if !s.check("leaderboard 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		Items []struct {
			Nickname  string `json:"nickname"`
			CozyScore int    `json:"cozyScore"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if len(v.Items) == 1 && v.Items[0].Nickname == "自测玩家" {
		s.pass++
		fmt.Printf("PASS | 排行榜含自测玩家 cozy=%d\n", v.Items[0].CozyScore)
	} else {
		s.failed++
		fmt.Printf("FAIL | 排行榜内容异常 %+v\n", v.Items)
	}
}

func (s *selftest) caseRoomsFeed() {
	rec := s.do("GET", "/api/v1/rooms/feed?limit=5", "", nil)
	if !s.check("rooms/feed 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		Items []struct {
			Room map[string]any `json:"room"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if len(v.Items) == 1 && v.Items[0].Room["placed"] != nil {
		s.pass++
		fmt.Println("PASS | 参观快照含家具布局")
		if v.Items[0].Room["address"] == "公寓楼 1803" {
			s.pass++
			fmt.Println("PASS | 参观快照带房号地址")
		} else {
			s.failed++
			fmt.Printf("FAIL | 快照地址异常 %v\n", v.Items[0].Room["address"])
		}
	} else {
		s.failed++
		fmt.Printf("FAIL | 参观快照异常 %+v\n", v.Items)
	}
}

func (s *selftest) caseVisit() {
	// 访问一个不存在的房间 → 404
	rec := s.do("POST", "/api/v1/rooms/nobody/visit", "", map[string]string{"Authorization": "Bearer " + s.token})
	s.check("访问不存在的房间 404", rec.Code, http.StatusNotFound)
}

func (s *selftest) caseUnauthorized() {
	rec := s.do("GET", "/api/v1/save", "", nil)
	s.check("无 token 读取存档 401", rec.Code, http.StatusUnauthorized)
	rec = s.do("GET", "/api/v1/save", "", map[string]string{"Authorization": "Bearer deadbeef"})
	s.check("假 token 读取存档 401", rec.Code, http.StatusUnauthorized)
}

// 保证未使用 os 的编译告警不会出现（selftest 在 main 中被引用）
var _ = os.Getenv

// 好友：只能加"有房间"的玩家；重复添加幂等；删了就真没了。
// 放在最后跑，避免多出来的玩家影响前面"排行榜/参观列表只有 1 人"的断言。
func (s *selftest) caseFriends() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"好友测试"}`, nil)
	if !s.check("好友用例：建邻居账号 200", rec.Code, http.StatusOK) {
		return
	}
	var g struct {
		UserID string `json:"userId"`
		Token  string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	if g.UserID == "" || g.Token == "" {
		s.failed++
		fmt.Println("FAIL | 好友用例：游客信息为空")
		return
	}

	body := `{"data":{"placed":[{"catalogId":"bed","gx":5,"gy":5}],"money":300,"day":2,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	rec = s.do("PUT", "/api/v1/save", body, map[string]string{
		"Authorization": "Bearer " + g.Token, "If-Match": "0",
	})
	if !s.check("好友用例：邻居建房间 200", rec.Code, http.StatusOK) {
		return
	}

	auth := map[string]string{"Authorization": "Bearer " + s.token}
	rec = s.do("POST", "/api/v1/friends/"+g.UserID, "", auth)
	s.check("加好友 200", rec.Code, http.StatusOK)
	rec = s.do("POST", "/api/v1/friends/"+g.UserID, "", auth)
	s.check("重复加好友幂等 200", rec.Code, http.StatusOK)

	var list struct {
		Items []struct {
			UserID   string         `json:"userId"`
			Nickname string         `json:"nickname"`
			Room     map[string]any `json:"room"`
		} `json:"items"`
	}
	rec = s.do("GET", "/api/v1/friends", "", auth)
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if rec.Code == http.StatusOK && len(list.Items) == 1 &&
		list.Items[0].UserID == g.UserID && list.Items[0].Room["placed"] != nil {
		s.pass++
		fmt.Printf("PASS | 好友列表含房间布局 (%s)\n", list.Items[0].Nickname)
	} else {
		s.failed++
		fmt.Printf("FAIL | 好友列表异常 code=%d len=%d\n", rec.Code, len(list.Items))
	}

	rec = s.do("POST", "/api/v1/friends/"+s.userID, "", auth)
	s.check("加自己 400", rec.Code, http.StatusBadRequest)
	rec = s.do("POST", "/api/v1/friends/nobody", "", auth)
	s.check("加不存在的玩家 404", rec.Code, http.StatusNotFound)

	rec = s.do("DELETE", "/api/v1/friends/"+g.UserID, "", auth)
	s.check("删好友 200", rec.Code, http.StatusOK)

	rec = s.do("GET", "/api/v1/friends", "", auth)
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if rec.Code == http.StatusOK && len(list.Items) == 0 {
		s.pass++
		fmt.Println("PASS | 删除后好友列表为空")
	} else {
		s.failed++
		fmt.Printf("FAIL | 删除后仍有 %d 位好友\n", len(list.Items))
	}
}


// 公寓楼目录：按楼栋列出已入住房间（前端用它渲染 18×4 的房间网格）
func (s *selftest) caseBuildingRooms() {
	rec := s.do("GET", "/api/v1/buildings/house.%E5%85%AC%E5%AF%93%E6%A5%BC/rooms", "", nil)
	if !s.check("楼栋房间目录 200", rec.Code, http.StatusOK) {
		return
	}
	var v struct {
		BuildingID string `json:"buildingId"`
		Items      []struct {
			Nickname  string `json:"nickname"`
			Floor     int    `json:"floor"`
			Room      int    `json:"room"`
			CozyScore int    `json:"cozyScore"`
			RoomData  map[string]any `json:"snapshot"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	if len(v.Items) == 1 && v.Items[0].Floor == 18 && v.Items[0].Room == 3 && v.Items[0].RoomData["placed"] != nil {
		s.pass++
		fmt.Printf("PASS | 楼栋目录含 1803（%s）\n", v.Items[0].Nickname)
	} else {
		s.failed++
		fmt.Printf("FAIL | 楼栋目录异常 items=%d %+v\n", len(v.Items), v.Items)
	}

	rec = s.do("GET", "/api/v1/buildings/nope/rooms", "", nil)
	if rec.Code == http.StatusOK {
		var empty struct{ Items []any `json:"items"` }
		_ = json.Unmarshal(rec.Body.Bytes(), &empty)
		if len(empty.Items) == 0 {
			s.pass++
			fmt.Println("PASS | 不存在的楼栋返回空列表")
		} else {
			s.failed++
			fmt.Println("FAIL | 不存在的楼栋返回了房间")
		}
	} else {
		s.failed++
		fmt.Printf("FAIL | 不存在的楼栋返回 %d\n", rec.Code)
	}
}

// 房产上限：一个人最多 3 套（含自住），服务端要再夹一次；
// 目录按房产查，所以第 2/3 套在世界上也是"有主的"，不会被当成待售重复卖。
func (s *selftest) caseEstates() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"囤房测试"}`, nil)
	if !s.check("房产用例：建号 200", rec.Code, http.StatusOK) {
		return
	}
	var g struct {
		UserID string `json:"userId"`
		Token  string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	if g.UserID == "" || g.Token == "" {
		s.failed++
		fmt.Println("FAIL | 房产用例：游客信息为空")
		return
	}

	// 故意送 4 套：服务端应只留 3 套（自住 501 必须在里面）
	body := `{"data":{"placed":[{"catalogId":"bed","gx":5,"gy":5}],"money":9000,"day":3,
		"houseLevel":1,"floorStyle":0,"wallStyle":0,
		"residence":{"buildingId":"house.公寓楼","floor":5,"room":1},"address":"公寓楼 501",
		"estates":[
		  {"buildingId":"house.公寓楼","floor":5,"room":1,"mode":"owned","paid":2400},
		  {"buildingId":"house.公寓楼","floor":7,"room":2,"mode":"rented","paid":300},
		  {"buildingId":"house.公寓楼","floor":12,"room":3,"mode":"owned","paid":5000},
		  {"buildingId":"house.公寓楼","floor":18,"room":4,"mode":"owned","paid":6000}
		]}}`
	auth := map[string]string{"Authorization": "Bearer " + g.Token, "If-Match": "0"}
	rec = s.do("PUT", "/api/v1/save", body, auth)
	if !s.check("房产用例：带 4 套房写档 200", rec.Code, http.StatusOK) {
		return
	}

	rec = s.do("GET", "/api/v1/buildings/house.%E5%85%AC%E5%AF%93%E6%A5%BC/rooms", "", nil)
	if rec.Code != http.StatusOK {
		s.failed++
		fmt.Printf("FAIL | 房产用例：目录 %d\n", rec.Code)
		return
	}
	var v struct {
		Items []struct {
			UserID   string         `json:"userId"`
			Floor    int            `json:"floor"`
			Room     int            `json:"room"`
			Mode     string         `json:"mode"`
			Current  bool           `json:"current"`
			Snapshot map[string]any `json:"snapshot"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &v)

	mine := make([]int, 0, 4)
	withSnap := 0
	currentOK := false
	for _, it := range v.Items {
		if it.UserID != g.UserID {
			continue
		}
		mine = append(mine, it.Floor*100+it.Room)
		if it.Snapshot != nil {
			withSnap++
			if it.Floor == 5 && it.Room == 1 && it.Current {
				currentOK = true
			}
		}
	}
	if len(mine) == 3 && withSnap == 1 && currentOK {
		s.pass++
		fmt.Printf("PASS | 房产上限夹到 3 套且只有自住那套带快照 %v\n", mine)
	} else {
		s.failed++
		fmt.Printf("FAIL | 房产异常 rooms=%v snapshots=%d current=%v\n", mine, withSnap, currentOK)
	}

	// 卖掉一套（只剩 2 套）后目录应立刻少一间
	body2 := `{"data":{"placed":[{"catalogId":"bed","gx":5,"gy":5}],"money":9500,"day":3,
		"houseLevel":1,"floorStyle":0,"wallStyle":0,
		"residence":{"buildingId":"house.公寓楼","floor":5,"room":1},"address":"公寓楼 501",
		"estates":[
		  {"buildingId":"house.公寓楼","floor":5,"room":1,"mode":"owned","paid":2400},
		  {"buildingId":"house.公寓楼","floor":7,"room":2,"mode":"rented","paid":300}
		]}}`
	rec = s.do("PUT", "/api/v1/save", body2, map[string]string{
		"Authorization": "Bearer " + g.Token, "If-Match": "1",
	})
	if !s.check("房产用例：卖房后写档 200", rec.Code, http.StatusOK) {
		return
	}
	rec = s.do("GET", "/api/v1/buildings/house.%E5%85%AC%E5%AF%93%E6%A5%BC/rooms", "", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &v)
	after := 0
	for _, it := range v.Items {
		if it.UserID == g.UserID {
			after++
		}
	}
	s.check("卖房后目录剩 2 套", after, 2)
}

/* ---------------------- 功能点承包：全局独占 ---------------------- */

type guestAcc struct {
	UserID string `json:"userId"`
	Token  string `json:"token"`
}

func (s *selftest) newGuest(nick string) guestAcc {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"`+nick+`"}`, nil)
	var g guestAcc
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	return g
}

// caseBusiness：同一家店同时只能有一个承包人。
// 这条规则只能由服务端保证——客户端各存一份的话，两个人会各以为自己是老板。
func (s *selftest) caseBusiness() {
	auth := map[string]string{"Authorization": "Bearer " + s.token}
	body := `{"termDays":30,"fee":1500}`

	rec := s.do("GET", "/api/v1/business", "", nil)
	s.check("承包列表 200", rec.Code, http.StatusOK)

	rec = s.do("POST", "/api/v1/business/biz.store/take", body, auth)
	s.check("承包店铺 200", rec.Code, http.StatusOK)

	// 刚承包 30 天，再租 30 天应当**顺延**到 60 天，而不是重置回 30 天
	var firstEnd int
	{
		var l struct {
			Items []struct {
				ShopID   string `json:"shopId"`
				DaysLeft int    `json:"daysLeft"`
			} `json:"items"`
		}
		r0 := s.do("GET", "/api/v1/business", "", auth)
		_ = json.Unmarshal(r0.Body.Bytes(), &l)
		for _, it := range l.Items {
			if it.ShopID == "biz.store" {
				firstEnd = it.DaysLeft
			}
		}
	}
	rec = s.do("POST", "/api/v1/business/biz.store/take", body, auth)
	s.check("自己续约 200", rec.Code, http.StatusOK)
	{
		var l struct {
			Items []struct {
				ShopID   string `json:"shopId"`
				DaysLeft int    `json:"daysLeft"`
			} `json:"items"`
		}
		r0 := s.do("GET", "/api/v1/business", "", auth)
		_ = json.Unmarshal(r0.Body.Bytes(), &l)
		after := 0
		for _, it := range l.Items {
			if it.ShopID == "biz.store" {
				after = it.DaysLeft
			}
		}
		if after >= firstEnd+29 {
			s.pass++
			fmt.Printf("PASS | 续租顺延 %d 天 → %d 天\n", firstEnd, after)
		} else {
			s.failed++
			fmt.Printf("FAIL | 续租没有顺延 %d 天 → %d 天\n", firstEnd, after)
		}
	}

	b := s.newGuest("承包乙")
	if b.Token == "" {
		s.failed++
		fmt.Println("FAIL | 承包用例：第二个账号建号失败")
		return
	}
	bAuth := map[string]string{"Authorization": "Bearer " + b.Token}

	rec = s.do("POST", "/api/v1/business/biz.store/take", body, bAuth)
	s.check("他人承包同一家 409", rec.Code, http.StatusConflict)

	var list struct {
		Day   int `json:"day"`
		Items []struct {
			ShopID   string `json:"shopId"`
			UserID   string `json:"userId"`
			Nickname string `json:"nickname"`
			DaysLeft int    `json:"daysLeft"`
		} `json:"items"`
	}
	rec = s.do("GET", "/api/v1/business", "", nil)
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	mine := false
	for _, it := range list.Items {
		if it.ShopID == "biz.store" && it.UserID == s.userID && it.DaysLeft > 0 {
			mine = true
		}
	}
	if mine {
		s.pass++
		fmt.Printf("PASS | 列表里能看到我的承包 day=%d 共 %d 家\n", list.Day, len(list.Items))
	} else {
		s.failed++
		fmt.Printf("FAIL | 列表里没有我的承包 items=%d\n", len(list.Items))
	}

	// 别人退不掉我的店
	rec = s.do("POST", "/api/v1/business/biz.store/release", "", bAuth)
	var rel struct {
		Released int `json:"released"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &rel)
	if rec.Code == http.StatusOK && rel.Released == 0 {
		s.pass++
		fmt.Println("PASS | 他人无法释放我的承包")
	} else {
		s.failed++
		fmt.Printf("FAIL | 他人释放了我的承包 released=%d code=%d\n", rel.Released, rec.Code)
	}

	// 我自己退，之后别人就能接
	rec = s.do("POST", "/api/v1/business/biz.store/release", "", auth)
	_ = json.Unmarshal(rec.Body.Bytes(), &rel)
	if rec.Code == http.StatusOK && rel.Released == 1 {
		s.pass++
		fmt.Println("PASS | 本人释放成功")
	} else {
		s.failed++
		fmt.Printf("FAIL | 本人释放异常 released=%d code=%d\n", rel.Released, rec.Code)
	}

	rec = s.do("POST", "/api/v1/business/biz.store/take", body, bAuth)
	s.check("释放后他人可承包 200", rec.Code, http.StatusOK)

	// 收尾：清掉，别影响别的用例
	s.do("POST", "/api/v1/business/biz.store/release", "", bAuth)

	// 参数校验
	rec = s.do("POST", "/api/v1/business/biz.store/take", `{"termDays":0,"fee":1500}`, auth)
	s.check("承包周期非法 400", rec.Code, http.StatusBadRequest)
}
