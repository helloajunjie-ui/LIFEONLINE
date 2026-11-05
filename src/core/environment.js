/**
 * 环境层：天气 / 随机物 / 生长 / 车流
 *
 * 设计原则（这是本模块存在的理由）：
 *   1. **能算出来的就不要存**。天气序列、路边花草、车的位次，全部由「种子 + 时间」确定性推导，
 *      存档里只留玩家亲手改变的东西（种下的花、浇过水的时间）。
 *   2. **确定性**：相同的 seed + 相同输入 → 永远相同结果。换设备、串门看别人家、断网重连，
 *      看到的都是同一片草地同一场雨。
 *   3. 纯函数：不读全局、不碰 DOM、不写存储，可在 Node 里直接单测。
 */

/** FNV-1a 32 位哈希：把任意字符串/id 变成稳定种子 */
export function hashSeed(str){
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而稳的伪随机数发生器 */
export function makeRng(seed){
  let a = seed >>> 0;
  return function(){
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 单点随机：同一 (seed,key) 永远同一个 [0,1) 值，不依赖调用顺序 */
export function rand01(seed, key){
  return makeRng((seed ^ hashSeed(key)) >>> 0)();
}

/**
 * 当前天气。按 slot 切片，slot 内保持稳定，切换处做线性过渡。
 * @param {string} seed 世界种子（如 userId）
 * @param {number} day 第几天
 * @param {number} minute 当天分钟
 * @param {object} climate content/environment/climate.json
 * @returns {{id:string,label:string,light:number,emotionPerHour:number,particles:string|null,blend:number,next:object}}
 */
export function weatherAt(seed, day, minute, climate, bias){
  const weathers = (climate && climate.weathers) || [];
  if (!weathers.length) return { id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null, blend: 1, next: null };
  const slot = Math.max(30, climate.slotMinutes || 180);
  const totalMinute = (day || 1) * 1440 + (minute || 0);
  const idx = Math.floor(totalMinute / slot);
  const within = totalMinute - idx * slot;
  const trans = Math.min(slot / 2, climate.transitionMinutes || 20);

  // 季节权重：冬天的雪、夏天的雨，靠 seasons.json 的 weatherBias 调
  const weightOf = (w) => {
    const base = (w.weight == null) ? 1 : w.weight;
    const k = (bias && bias[w.id] != null) ? bias[w.id] : 1;
    return Math.max(0, base * k);
  };
  const pick = (n) => {
    const r = rand01(hashSeed(seed) >>> 0, 'weather:' + n);
    let total = 0;
    for (const w of weathers) total += weightOf(w);
    if (total <= 0) return weathers[0];          // 全被季节权重压到 0 时兜底，避免除零
    let acc = 0;
    for (const w of weathers){
      acc += weightOf(w) / total;
      if (r <= acc) return w;
    }
    return weathers[weathers.length - 1];
  };

  const cur = pick(idx);
  const nxt = pick(idx + 1);
  // 只在 slot 末尾 trans 分钟内过渡到下一个天气
  const blend = within > slot - trans ? (within - (slot - trans)) / trans : 0;
  return {
    id: cur.id, label: cur.label, light: cur.light,
    emotionPerHour: cur.emotionPerHour || 0,
    particles: cur.particles || null,
    tempDelta: cur.tempDelta || 0,          // 该天气对气温的修正（雨天降、雪天更冷）
    blend,
    next: blend > 0 ? { id: nxt.id, label: nxt.label } : null
  };
}

/**
 * 随机撒物：逐格哈希决定，可重复、可排除被占用的格子。
 * @param {object} o
 * @param {string} o.seed
 * @param {{x:number,y:number,w:number,h:number}} o.rect 区域
 * @param {Object<string,number>} o.density 每 100 格的期望数量（kind → 密度）
 * @param {(x:number,y:number)=>boolean} [o.blocked] 该格是否已被占用/不可放
 * @param {string} [o.salt] 区分不同区域，避免同一套随机
 * @returns {Array<{kind:string,x:number,y:number}>}
 */
export function scatterProps(o){
  const opt = o || {};
  const rect = opt.rect || { x: 0, y: 0, w: 0, h: 0 };
  const density = opt.density || {};
  const salt = opt.salt || 'scatter';
  const base = hashSeed(opt.seed + '|' + salt);
  const out = [];
  const kinds = Object.keys(density);
  if (!kinds.length) return out;
  const totalPer100 = kinds.reduce((s, k) => s + (density[k] || 0), 0);
  const p = Math.min(0.95, totalPer100 / 100);

  for (let y = rect.y; y < rect.y + rect.h; y++){
    for (let x = rect.x; x < rect.x + rect.w; x++){
      const r = rand01(base, x + ',' + y);
      if (r >= p) continue;
      if (opt.blocked && opt.blocked(x, y)) continue;
      // 按权重选种类
      let pickR = rand01(base ^ 0x9e3779b9, x + ',' + y + ',kind');
      let acc = 0, chosen = kinds[kinds.length - 1];
      const wsum = kinds.reduce((s, k) => s + (density[k] || 0), 0);
      for (const k of kinds){
        acc += (density[k] || 0) / wsum;
        if (pickR <= acc){ chosen = k; break; }
      }
      out.push({ kind: chosen, x, y });
    }
  }
  return out;
}

/**
 * 生长阶段：由「种下时间 + 当前时间」推导，不存状态机。
 * @param {number} plantedAt 种下的游戏分钟（存档里记这个）
 * @param {number} nowMinute 当前游戏分钟
 * @param {object} growth content/environment/ambient.json 的 growth
 * @param {number} [wateredBonus] 浇水累计加速的分钟数（存档里记）
 */
export function growthStage(plantedAt, nowMinute, growth, wateredBonus){
  const stages = (growth && growth.stages) || [{ id: 'bloom', afterMinutes: 0, scale: 1 }];
  const elapsed = Math.max(0, (nowMinute || 0) - (plantedAt || 0)) + (wateredBonus || 0);
  let cur = stages[0];
  for (const s of stages) if (elapsed >= (s.afterMinutes || 0)) cur = s;
  return { id: cur.id, scale: cur.scale == null ? 1 : cur.scale, elapsed };
}

/**
 * 车流：位置由 seed + 时间推演，无需服务端广播。
 * @param {string} seed
 * @param {number} minute
 * @param {Array<{id:string,length:number,axis:'x'|'y',at:number}>} lanes
 * @param {object} traffic content/environment/ambient.json 的 traffic
 */
export function trafficAt(seed, minute, lanes, traffic){
  const speed = (traffic && traffic.speedPerMinute) || 0.08;
  const kinds = (traffic && traffic.kinds) || ['car'];
  const out = [];
  for (const lane of (lanes || [])){
    const n = Math.max(1, Math.round(lane.length / 6));
    for (let i = 0; i < n; i++){
      const jitter = rand01(hashSeed(seed + '|car|' + lane.id), String(i));
      const pos = ((minute * speed + i * (lane.length / n) + jitter * 2) % (lane.length || 1) + (lane.length || 1)) % (lane.length || 1);
      const kind = kinds[Math.floor(rand01(hashSeed(seed + '|kind|' + lane.id), String(i)) * kinds.length)];
      out.push(lane.axis === 'y'
        ? { laneId: lane.id, kind, x: lane.at, y: pos + (lane.from || 0) }
        : { laneId: lane.id, kind, x: pos + (lane.from || 0), y: lane.at });
    }
  }
  return out;
}

/** 时段（晨/午/黄昏/夜）→ 环境光叠加色 */
export function daytimeAt(minute, climate){
  const list = (climate && climate.daytimes) || [];
  const h = Math.floor(((minute || 0) % 1440) / 60);
  for (const d of list){
    const from = d.fromHour, to = d.toHour;
    const inRange = from <= to ? (h >= from && h < to) : (h >= from || h < to);
    if (inRange) return d;
  }
  return list[list.length - 1] || { id: 'day', ambient: 'rgba(0,0,0,0)' };
}

/**
 * 天气种子：局部（每人家一套）还是全局（全服同一场雨）。
 * @param {object} climate content/environment/climate.json（scope: local | global）
 * @param {string} userId
 * @param {string} [worldSeed] 服务端 world_state 下发的种子（global 模式用）
 */
export function weatherSeed(climate, userId, worldSeed){
  const scope = (climate && climate.scope) || 'local';
  return scope === 'global'
    ? 'world:' + (worldSeed || 'default')
    : 'user:' + (userId || 'anon');
}

/**
 * 采样一天中的光照（按关键帧线性插值）。
 * @returns {{light:number, tint:number[], label:string}}
 *   light 0..1（1=正午最亮），tint [r,g,b,a] 叠加到画面，label 是时段名
 *
 * 为什么用关键帧而不是"区间表"：区间在边界处会硬跳变（19:59 亮、20:01 突然暗），
 * 关键帧插值天然平滑，而且改数值时只要调 hour/light 两个数。
 */
export function sampleDaylight(climate, minute){
  const keys = (climate && climate.daylight && climate.daylight.keys) || [];
  if (!keys.length) return { light: 1, tint: [0, 0, 0, 0], label: '' };
  const h = ((minute || 0) % 1440 + 1440) % 1440 / 60;
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++){
    if (h >= keys[i].hour && h <= keys[i + 1].hour){ a = keys[i]; b = keys[i + 1]; break; }
  }
  const span = (b.hour - a.hour) || 1;
  const t = Math.max(0, Math.min(1, (h - a.hour) / span));
  const lerp = (x, y) => x + (y - x) * t;
  const ta = a.tint || [0, 0, 0, 0], tb = b.tint || [0, 0, 0, 0];
  return {
    light: lerp(a.light, b.light),
    tint: [
      Math.round(lerp(ta[0], tb[0])),
      Math.round(lerp(ta[1], tb[1])),
      Math.round(lerp(ta[2], tb[2])),
      Math.round(lerp(ta[3], tb[3]) * 1000) / 1000
    ],
    label: t < 0.5 ? (a.label || '') : (b.label || '')
  };
}

/**
 * 判断当前季节。
 * @param {object} seasons content/environment/seasons.json
 * @param {{month?:number, dayIndex?:number}} opts month: 1-12（realtime 用）；dayIndex: 游戏天数（game 模式用）
 */
export function seasonAt(seasons, opts){
  const list = (seasons && seasons.seasons) || [];
  if (!list.length) return null;
  const o = opts || {};
  const mode = seasons.mode || 'byMonth';
  if (mode === 'byMonth' && o.month){
    for (const s of list){
      if ((s.months || []).indexOf(o.month) >= 0) return s;
    }
  }
  // 兜底：按游戏天数轮转（每 SEASON_DAYS 天换一季）
  const SEASON_DAYS = 7;
  const idx = Math.floor(((o.dayIndex || 0) / SEASON_DAYS) % list.length);
  return list[idx];
}
