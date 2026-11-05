package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// 单包下发：模块级热更新的数据来源
func (s *selftest) casePackEndpoint() {
	// meta 里的模块键必须带 content/ 前缀（客户端按这个键比对）
	metaRec := s.do("GET", "/api/v1/meta", "", nil)
	var meta struct {
		Modules map[string]struct {
			Version int    `json:"version"`
			Hash    string `json:"hash"`
		} `json:"modules"`
	}
	_ = json.Unmarshal(metaRec.Body.Bytes(), &meta)
	allPrefixed := len(meta.Modules) > 0
	for k := range meta.Modules {
		if len(k) < 8 || k[:8] != "content/" {
			allPrefixed = false
		}
	}
	if allPrefixed {
		s.pass++
		fmt.Printf("PASS | meta 模块键带 content/ 前缀（%d 个）\n", len(meta.Modules))
	} else {
		s.failed++
		fmt.Printf("FAIL | meta 模块键前缀异常: %v\n", len(meta.Modules))
	}

	rec := s.do("GET", "/api/v1/content/pack/catalog/furniture.core.json", "", nil)
	if !s.check("pack 200", rec.Code, http.StatusOK) {
		return
	}
	etag := rec.Header().Get("ETag")
	ver := rec.Header().Get("X-Module-Version")
	var pack struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &pack)
	if etag != "" && ver != "" && len(pack.Items) > 0 {
		s.pass++
		fmt.Printf("PASS | pack 带版本头 etag=%s ver=%s items=%d\n", etag, ver, len(pack.Items))
	} else {
		s.failed++
		fmt.Printf("FAIL | pack 响应异常 etag=%q ver=%q items=%d\n", etag, ver, len(pack.Items))
	}

	rec2 := s.do("GET", "/api/v1/content/pack/catalog/furniture.core.json", "", map[string]string{"If-None-Match": etag})
	s.check("pack ETag 复用 304", rec2.Code, http.StatusNotModified)

	rec3 := s.do("GET", "/api/v1/content/pack/not/a/real/pack.json", "", nil)
	s.check("未知包 404", rec3.Code, http.StatusNotFound)
}

// 作弊数值：单次写入钱数暴增 → 夹紧 + 标记 + 不进排行榜
func (s *selftest) caseCheatMoneyClamped() {
	rec := s.do("POST", "/api/v1/auth/guest", `{"nickname":"作弊测试"}`, nil)
	var g struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &g)
	auth := map[string]string{"Authorization": "Bearer " + g.Token, "If-Match": "0"}

	normal := `{"data":{"placed":[],"money":500,"day":1,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	if !s.check("作弊用例：首存 200", s.do("PUT", "/api/v1/save", normal, auth).Code, http.StatusOK) {
		return
	}

	cheat := `{"data":{"placed":[],"money":999999,"day":99,"houseLevel":0,"floorStyle":0,"wallStyle":0}}`
	rec = s.do("PUT", "/api/v1/save", cheat, map[string]string{"Authorization": "Bearer " + g.Token, "If-Match": "1"})
	if !s.check("作弊写入仍 200（夹紧而非报错）", rec.Code, http.StatusOK) {
		return
	}

	// 回读：钱和天数应被夹到合理范围
	rec = s.do("GET", "/api/v1/save", "", map[string]string{"Authorization": "Bearer " + g.Token})
	var saved struct {
		Data struct {
			Money float64 `json:"money"`
			Day   int     `json:"day"`
		} `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &saved)
	if saved.Data.Money <= 500+1500 && saved.Data.Day <= 1+3 {
		s.pass++
		fmt.Printf("PASS | 作弊数值被夹紧 money=%.0f day=%d\n", saved.Data.Money, saved.Data.Day)
	} else {
		s.failed++
		fmt.Printf("FAIL | 作弊数值未被夹紧 money=%.0f day=%d\n", saved.Data.Money, saved.Data.Day)
	}

	// 排行榜必须把被标记的存档排除
	lb := s.do("GET", "/api/v1/leaderboard?limit=50", "", nil)
	if strings.Contains(lb.Body.String(), "作弊测试") {
		s.failed++
		fmt.Println("FAIL | 被标记的存档仍出现在排行榜")
	} else {
		s.pass++
		fmt.Println("PASS | 被标记的存档不出现在排行榜")
	}
}

// 世界时钟：懒推进、单调不回退
func (s *selftest) caseWorldClock() {
	rec := s.do("GET", "/api/v1/world", "", nil)
	if !s.check("world 200", rec.Code, http.StatusOK) {
		return
	}
	type clock struct {
		TotalMinute float64 `json:"totalMinute"`
		Day         int     `json:"day"`
		Minute      float64 `json:"minute"`
		Rate        float64 `json:"rate"`
	}
	var c1 clock
	_ = json.Unmarshal(rec.Body.Bytes(), &c1)
	if c1.Day >= 1 && c1.Minute >= 0 && c1.Minute < 1440 && c1.TotalMinute > 0 {
		s.pass++
		fmt.Printf("PASS | world 时钟合法 day=%d minute=%.1f rate=%.2f\n", c1.Day, c1.Minute, c1.Rate)
	} else {
		s.failed++
		fmt.Printf("FAIL | world 时钟异常 %+v\n", c1)
	}

	rec2 := s.do("GET", "/api/v1/world", "", nil)
	var c2 clock
	_ = json.Unmarshal(rec2.Body.Bytes(), &c2)
	if c2.TotalMinute >= c1.TotalMinute {
		s.pass++
		fmt.Println("PASS | world 时钟不回退")
	} else {
		s.failed++
		fmt.Printf("FAIL | 时钟回退 %.3f -> %.3f\n", c1.TotalMinute, c2.TotalMinute)
	}
	// 推进速度：真实 1 秒应推进 rate/60 游戏分钟（rate=60 → 1 秒正好 1 游戏分钟）。
	// 这条是整个节奏的命门：算错这里，"一天 24 分钟""每天一班"就全歪了。
	if c2.Rate >= 30 {
		const gap = 200 * time.Millisecond
		time.Sleep(gap)
		rec3 := s.do("GET", "/api/v1/world", "", nil)
		var c3 clock
		_ = json.Unmarshal(rec3.Body.Bytes(), &c3)
		got := c3.TotalMinute - c2.TotalMinute
		want := gap.Seconds() * c2.Rate / 60
		if got >= want*0.5 && got <= want*2.0+0.05 {
			s.pass++
			fmt.Printf("PASS | world 推进速度 真实%.2fs -> %.3f 游戏分钟（期望 %.3f）\n", gap.Seconds(), got, want)
		} else {
			s.failed++
			fmt.Printf("FAIL | world 推进速度异常 真实%.2fs -> %.3f 游戏分钟（期望 %.3f）\n", gap.Seconds(), got, want)
		}
	}

}
