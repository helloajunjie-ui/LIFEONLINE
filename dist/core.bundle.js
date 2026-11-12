/* 由 tools/build.mjs 生成：2026-11-12T13:29:17.561Z */
(function(){
  'use strict';
  var __defs = {}, __cache = {};
  function __define(id, fn){ __defs[id] = fn; }
  function __require(id){
    if (__cache[id]) return __cache[id];
    if (!__defs[id]) throw new Error('模块未打包: ' + id);
    var exp = {};
    __cache[id] = exp;
    __defs[id](exp, __require);
    return exp;
  }
__define("src/core/content.js", function(__exports, __require){
/**
 * 内容层加载器：把 content/ 的多个包索引成"运行时只读数据"，
 * 并提供「旧结构适配器」——让尚未模块化的引擎代码能用一行接入，逐步迁移。
 *
 * 数据来自 content/generated.js（由 tools/build.mjs 从 content/*.json 生成），
 * 因此在单文件分发时也不需要 fetch。
 */
const { CONTENT } = __require("src/content/generated.js");
/* ------------------------- 交互动词注册表 -------------------------
 * 一条 verb = 一套默认行为（时长/音效/前置条件/默认效果/hook）。
 * 物品与 NPC 的 actions 都只引用 verb，引擎里不再出现 action 字面量。
 * 加一个"只改数值"的新交互：content/interaction/verbs.json 加一条即可，代码零改动。 */
function buildVerbTable(packs){
  const table = {};
  for (const [id, pack] of Object.entries(packs)){
    if (!id.startsWith('interaction/')) continue;
    for (const [k, v] of Object.entries(pack.verbs || {})) table[k] = Object.assign({ id: k, reserved: false }, v);
    for (const [k, v] of Object.entries(pack.reserved || {})) {
      if (k === 'note') continue;
      if (!table[k]) table[k] = Object.assign({ id: k, reserved: true }, v);
    }
  }
  return table;
}

/* 分类表：商店分组 / 图标兜底 / 校验都读它 */
function buildCategories(packs){
  for (const [id, pack] of Object.entries(packs)){
    if (id.startsWith('catalog/') && Array.isArray(pack.categories)){
      const list = pack.categories.slice().sort((a, b) => (a.order || 99) - (b.order || 99));
      const byId = {};
      for (const c of list) byId[c.id] = c;
      return { list, byId };
    }
  }
  return { list: [], byId: {} };
}

/* 资源条（stat）定义：顺序即 HUD 显示顺序，字段齐全到可以纯数据驱动渲染 */
function buildStats(rulesSurvival){
  const defs = (rulesSurvival && rulesSurvival.stats) || {};
  const list = Object.entries(defs)
    .map(([k, v], i) => Object.assign({ id: k, order: v.order ?? i }, v))
    .sort((a, b) => a.order - b.order);
  const byId = {};
  for (const s of list) byId[s.id] = s;
  return { list, byId };
}

/** 把物品的 interaction / interactions 归一化成动作数组 */
function normalizeActs(it, verbTable){
  const raw = Array.isArray(it.interactions) ? it.interactions
    : (it.interaction ? [it.interaction] : []);
  return raw.map((a, i) => {
    const v = verbTable[a.verb] || {};
    return {
      verb: a.verb,
      label: a.label || v.label || a.verb,
      durationSec: a.durationSec ?? v.durationSec ?? 2,
      sfx: a.sfx || v.sfx || 'ok',
      hook: a.hook || v.hook || null,
      effects: Object.assign({}, v.effects || {}, a.effects || {}),
      requirements: a.requirements || v.requirements || null,
      consumes: a.consumes || null,
      produces: a.produces || null,
      failText: a.failText || v.failText || null,
      order: a.order ?? i
    };
  }).sort((x, y) => x.order - y.order);
}

/** 从 pack 集合构建运行时索引（可重复调用：热更新时用它重建） */
function buildIndex(packs, meta){
  const catalog = [];
  for (const [id, pack] of Object.entries(packs)){
    if (!id.startsWith('catalog/')) continue;
    for (const it of (pack.items || [])) catalog.push(it);
  }
  const catalogById = {};
  for (const it of catalog) catalogById[it.id] = it;

  const house = packs['house/levels.json'] || { levels: [] };
  const styles = packs['house/styles.json'] || { floors: [], walls: [] };

  const rules = { survival: {}, economy: {}, bills: {} };
  for (const [id, pack] of Object.entries(packs)){
    if (!id.startsWith('rules/')) continue;
    if (pack.id === 'rules.survival.default') rules.survival = pack;
    if (pack.id === 'rules.economy.default') rules.economy = pack;
    if (pack.id === 'rules.bills.default') rules.bills = pack;
  }

  const npcs = [];
  const clerks = [];
  for (const [id, pack] of Object.entries(packs)){
    if (!id.startsWith('characters/')) continue;
    if (pack.npcs) npcs.push(...pack.npcs);
    if (Array.isArray(pack.clerks)) clerks.push(...pack.clerks);
  }

  const maps = {};
  for (const [id, pack] of Object.entries(packs)){
    if (id.startsWith('maps/') && pack.id) maps[String(pack.id).replace('map.', '')] = pack;
  }

  const uiPack = Object.entries(packs).find(([id]) => id.startsWith('ui/'))?.[1] || {};

  const verbTable = buildVerbTable(packs);
  const categories = buildCategories(packs);
  const stats = buildStats(rules.survival);
  const climate = packs['environment/climate.json'] || {};
  // 随机物密度与车流：观感参数放数据里，改密度/车速不用碰渲染代码
  const ambient = packs['environment/ambient.json'] || {};
  const seasons = packs['environment/seasons.json'] || { seasons: [] };
  // 职业：岗位绑定地图分区，走到那个分区就能上班
  const careers = [];
  /* 熟练等级的规则（满级/每级涨多少/几班升一级）也放内容里：
   * 这些数字以前硬编码在 careerPay 里，想调平衡得改代码。 */
  let careerCfg = {};
  for (const [id, pack] of Object.entries(packs)){
    if (!id.startsWith('careers/')) continue;
    if (Array.isArray(pack.jobs)) careers.push(...pack.jobs);
    if (pack.career && typeof pack.career === 'object') careerCfg = pack.career;
  }

  // 成就：目标由引擎按 kind 从当前状态推导，数据只描述"要什么"和"给什么"
  let achievements = [], achGroups = [];
  for (const [id, pack] of Object.entries(packs)){
    if (id.startsWith('achievements/') && Array.isArray(pack.achievements)){
      achievements = achievements.concat(pack.achievements);
      achGroups = achGroups.concat(pack.groups || []);
    }
  }
  // 注意用 ??: order=0 是合法值，用 || 会把第一组排到最后
  achGroups = achGroups.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  // 住址体系：独栋/公寓两类楼栋，玩家住址由它分配
  const residence = packs['house/residence.json'] || {};

  // 彩票：号码规则与奖级表（概率现算，不写死）
  const lottery = packs['lottery/lottery.json'] || null;

  // 功能点承包：付一个月承包金，期内每天结算净收益
  const business = packs['business/business.json'] || { shops: [], termDays: 30, maxOwned: 3 };

  // 银行：存贷利率（按游戏天算，不是年化）
  const bank = packs['bank/bank.json'] || null;

  // 股市：可交易标的 + 手续费 + 随机游走参数
  const stock = packs['stock/stock.json'] || { stocks: [], feeRate: 0.0015 };

  // 宠物：可领养猫狗 + 需求衰减 + 互动动作 + 宠物粮
  const pets = packs['pets/pets.json'] || null;

  // 车款：4S 店卖的车（不在家具目录里，车不是家具）
  let cars = [], carParking = null;
  for (const [id, pack] of Object.entries(packs)){
    if (id.startsWith('vehicles/') && Array.isArray(pack.models)){
      cars = cars.concat(pack.models);
      carParking = pack.parking || carParking;
    }
  }

  return {
    manifest: meta || {},
    catalog,
    catalogById,
    levels: (house.levels || []).slice().sort((a, b) => a.level - b.level),
    floors: styles.floors || [],
    walls: styles.walls || [],
    rules,
    npcs,
    clerks,
    maps,
    ui: uiPack.strings || {},
    verbs: verbTable,
    categories,
    stats,
    climate,
    ambient,
    seasons,
    careers,
    careerCfg,
    achievements,
    achGroups,
    residence,
    cars,
    carParking,
    lottery,
    business,
    bank,
    stock,
    pets
  };
}

/** 建立索引 + 基础引用校验（与 tools/content.mjs 的校验互补：这里防运行期踩空） */
function indexContent(raw){
  const r = raw || {};
  const packs = r.packs || {};
  return buildIndex(packs, r.manifest || {});
}

const packStore = Object.assign({}, CONTENT.packs || {});
const content = buildIndex(packStore, CONTENT.manifest || {});

/**
 * 模块级热更新：只替换一个内容包并重建索引。
 * 返回 true 表示已生效（调用方随后需要刷新自己的"旧结构"副本）。
 */
function applyPack(packId, packData){
  if (!packId || !packData) return false;
  packStore[packId] = packData;
  Object.assign(content, buildIndex(packStore, CONTENT.manifest || {}));
  return true;
}

/** 当前已加载的模块（id → pack） */
function loadedPacks(){
  return packStore;
}

/* ------------------------- 旧结构适配器 -------------------------
 * 目标：不改动原有引擎逻辑，只把数据来源换掉。
 * 一旦某个系统完成模块化，就可以直接读 content.catalogById，不再用这里。 */

/** → [{id,name,cat,catLabel,price,w,h,cozy,action,fx,acts,desc,walk,wallMounted}]
 *  acts 是归一化后的动作数组（支持一个物品多个动作 → UI 弹菜单）；
 *  action/fx 是旧字段，保留给尚未迁移的代码。 */
function toLegacyCatalog(){
  return content.catalog.map(it => {
    const acts = normalizeActs(it, content.verbs);
    return {
      id: it.id,
      name: it.name,
      cat: (content.categories.byId[it.category] || {}).label || it.category,
      catId: it.category,
      price: it.price,
      w: it.footprint.w,
      h: it.footprint.h,
      cozy: it.cozy,
      action: acts.length ? acts[0].verb : null,
      fx: acts.length ? acts[0].effects : {},
      acts,
      desc: (it.ui && it.ui.desc) || '',
      walk: !!(it.placement && it.placement.walkable),
      wallMounted: !!(it.placement && it.placement.wallMounted),
      category: it.category
    };
  });
}

/** 交互动词表（运行时只读） */
function verbs(){ return content.verbs; }
/** 物品分类表 */
function categories(){ return content.categories; }
/** 资源条定义（顺序 = HUD 顺序） */
function statsDef(){ return content.stats; }
/** 地图（含分区/装饰/传送门） */
function maps(){ return content.maps; }
/** 邻居 NPC（外观 / 出生点 / 归属房屋 / 台词） */
function npcs(){ return content.npcs; }
/** 店员：站在自家门口，认上下班时间 */
function clerks(){ return content.clerks; }

/** 气候：天气权重 + 一天的光照关键帧 */
function climate(){ return content.climate; }
/** 四季配置 */
function seasons(){ return content.seasons; }
/** 环境细节（随机物密度、车流） */
function ambient(){ return content.ambient; }
/** 职业岗位（绑定地图分区的可上班点） */
function careers(){ return content.careers; }
/** 熟练等级规则：{ maxLevel, payPerLevel, shiftsPerLevel } */
function careerCfg(){ return content.careerCfg || {}; }
/** 生活目标（成就）：目标由 kind 推导，进度不存档 */
function achievements(){ return content.achievements; }
/** 成就分组（顺序即面板分组顺序） */
function achievementGroups(){ return content.achGroups; }
/** 住址体系（楼栋/楼层/房号规则） */
function residence(){ return content.residence; }
/** 车款（4S 店卖的） */
function cars(){ return content.cars; }
/** 4S 店停车场配置 */
function carParking(){ return content.carParking; }
/** 彩票规则（号码/奖级/票价） */
function lottery(){ return content.lottery; }

/** → [{name,w,h,price,walls:[[x,y],...],zones:[{id,name,x,y,w,h,floor}]}]（引擎里 walls 用绝对坐标数组形式；zones 为地面分区，坐标相对 footprint 左上角） */
function toLegacyHouseLevels(){
  return content.levels.map(lv => ({
    name: lv.name,
    /* apartment = 公寓楼里的一套；villa = 楼外独栋。两类户型互不升级 */
    type: lv.type || 'apartment',
    id: lv.id,
    /* 精装交付：买下就带着整套家具与墙面配色（别墅专用，公寓没有这个字段） */
    furnish: lv.furnish || null,
    furnished: !!lv.furnished,
    w: lv.footprint.w,
    h: lv.footprint.h,
    price: lv.price,
    walls: (lv.walls || []).map(w => [w.x, w.y]),
    zones: (lv.zones || []).map(z => ({
      id: z.id, name: z.name,
      x: z.rect.x, y: z.rect.y, w: z.rect.w, h: z.rect.h,
      floor: z.floor
    }))
  }));
}

function toLegacyFloorStyles(){
  return content.floors.map(f => Object.assign(
    { name: f.name, price: f.price, pattern: f.pattern },
    f.palette
  ));
}

function toLegacyWallStyles(){
  return content.walls.map(w => Object.assign(
    { name: w.name, price: w.price },
    w.palette
  ));
}

/** → { DECAY, EMOTION_DECAY, WORK_PAY, WORK_TIME, WORK_COST, STATS_INIT, CLOCK } */
function toLegacyRules(){
  const s = content.rules.survival || {};
  const stats = s.stats || {};
  return {
    DECAY: {
      hunger: stats.hunger ? stats.hunger.decayPerGameMinute : 0.05,
      thirst: stats.thirst ? stats.thirst.decayPerGameMinute : 0.05
    },
    EMOTION_DECAY: stats.emotion ? stats.emotion.decayPerGameMinute : 0.025,
    WORK_PAY: (s.work && s.work.pay) ?? 60,
    WORK_TIME: (s.work && s.work.durationSec) ?? 5,
    WORK_COST: (s.work && s.work.cost) || { hunger: 1.5, thirst: 2 },
    STATS_INIT: {
      hunger: stats.hunger ? stats.hunger.initial : 100,
      thirst: stats.thirst ? stats.thirst.initial : 100,
      emotion: stats.emotion ? stats.emotion.initial : 70
    },
    START_MINUTE: s.clock ? s.clock.startMinute : 480,
    TIME_SOURCE: (s.clock && s.clock.timeSource) || 'game',
    TZ_OFFSET: (s.clock && s.clock.timeZoneOffsetHours != null) ? s.clock.timeZoneOffsetHours : 8,
    SIM_MIN_PER_SEC: (s.clock && s.clock.simMinutesPerRealSecond) || 1,
    /* 世界时钟倍率：游戏分钟 / 真实分钟。60 → 1 天 = 24 分钟真实时间。
     * 客户端在服务端倍率异常时用这个兜底，所以必须从内容层读，不能写死在引擎里。 */
    WORLD_RATE: (s.clock && s.clock.worldRate) || 60
  };
}

/** 引擎里最常见的三个查询 */
function catalogItem(id){ return content.catalogById[id] || null; }
function cozyOf(id){ const it = content.catalogById[id]; return it ? it.cozy : 0; }
function economy(){ return content.rules.economy || {}; }
/** 缴费通知模板（账单周期、金额算法字段、逾期规则） */
function bills(){ return content.rules.bills || {}; }
/** 功能点承包：可承包的店铺、承包金、日收益、承包周期 */
function business(){ return content.business || { shops: [], termDays: 30 }; }
/** 银行：活期利率、定期档位、贷款档位 */
function bank(){ return content.bank || {}; }
/** 股市：可交易标的、手续费、价格模型参数 */
function stock(){ return content.stock || { stocks: [], feeRate: 0.0015 }; }
/** 宠物：可领养猫狗、需求衰减、互动动作、宠物粮配置 */
function pets(){ return content.pets; }

  __exports.indexContent = indexContent;
  __exports.content = content;
  __exports.applyPack = applyPack;
  __exports.loadedPacks = loadedPacks;
  __exports.toLegacyCatalog = toLegacyCatalog;
  __exports.verbs = verbs;
  __exports.categories = categories;
  __exports.statsDef = statsDef;
  __exports.maps = maps;
  __exports.npcs = npcs;
  __exports.clerks = clerks;
  __exports.climate = climate;
  __exports.seasons = seasons;
  __exports.ambient = ambient;
  __exports.careers = careers;
  __exports.careerCfg = careerCfg;
  __exports.achievements = achievements;
  __exports.achievementGroups = achievementGroups;
  __exports.residence = residence;
  __exports.cars = cars;
  __exports.carParking = carParking;
  __exports.lottery = lottery;
  __exports.toLegacyHouseLevels = toLegacyHouseLevels;
  __exports.toLegacyFloorStyles = toLegacyFloorStyles;
  __exports.toLegacyWallStyles = toLegacyWallStyles;
  __exports.toLegacyRules = toLegacyRules;
  __exports.catalogItem = catalogItem;
  __exports.cozyOf = cozyOf;
  __exports.economy = economy;
  __exports.bills = bills;
  __exports.business = business;
  __exports.bank = bank;
  __exports.stock = stock;
  __exports.pets = pets;
});

__define("src/core/pathfind.js", function(__exports, __require){
/**
 * 纯函数寻路：BFS 四邻接，返回最短路径（含终点，不含起点）。
 * 依赖全部注入，不碰全局状态，便于单测与复用（家 / 小区 / 邻居家共用一套）。
 *
 * @param {object}   o
 * @param {number}   o.width    网格宽
 * @param {number}   o.height   网格高
 * @param {{x:number,y:number}} o.start 起点（格子坐标）
 * @param {{x:number,y:number}} o.goal  终点
 * @param {(x:number,y:number)=>boolean} o.blocked 是否阻挡
 * @returns {Array<{gx:number,gy:number}>|null} 路径；无路返回 null；起点即终点返回 []
 */
function findPath({ width, height, start, goal, blocked }){
  const { x: sx, y: sy } = start;
  const { x: tx, y: ty } = goal;

  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
  if (blocked && blocked(tx, ty)) return null;
  if (sx === tx && sy === ty) return [];

  const key = (x, y) => y * width + x;
  const prev = new Map();
  const seen = new Set([key(sx, sy)]);
  const queue = [[sx, sy]];
  let head = 0;

  while (head < queue.length){
    const [x, y] = queue[head++];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (blocked && blocked(nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, [x, y]);
      if (nx === tx && ny === ty){
        const path = [];
        let cx = nx, cy = ny;
        while (!(cx === sx && cy === sy)){
          path.unshift({ gx: cx, gy: cy });
          const p = prev.get(key(cx, cy));
          cx = p[0]; cy = p[1];
        }
        return path;
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

/** 从起点能走到的所有格子（含起点）。用于"房间是否被封死"这类检查。 */
function reachableCells({ width, height, start, blocked }){
  const key = (x, y) => y * width + x;
  const seen = new Set([key(start.x, start.y)]);
  const queue = [[start.x, start.y]];
  let head = 0;
  while (head < queue.length){
    const [x, y] = queue[head++];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (blocked && blocked(nx, ny)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

  __exports.findPath = findPath;
  __exports.reachableCells = reachableCells;
});

__define("src/core/rules.js", function(__exports, __require){
/**
 * 规则求值：把"数值规则"从代码里搬到 content/rules/*.json，代码只负责求值。
 * 表达式只允许白名单函数，变量由调用方显式传入，避免变成"随便写 JS"的口子。
 */

const FN = {
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  abs: Math.abs
};

/** 校验表达式只用了白名单函数（内容层校验器与服务端也用同一逻辑） */
function assertSafeExpr(expr){
  const re = /([a-zA-Z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(expr))){
    if (!Object.prototype.hasOwnProperty.call(FN, m[1])){
      throw new Error('表达式使用了非白名单函数: ' + m[1]);
    }
  }
  return expr;
}

/** 求值：evalExpr('min(20, round(sqrt(cozy) * 1.5))', { cozy: 10 }) */
function evalExpr(expr, vars){
  assertSafeExpr(expr);
  const names = Object.keys(vars || {});
  const values = names.map(n => vars[n]);
  const fnNames = Object.keys(FN);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, ...fnNames, '"use strict"; return (' + expr + ');');
  return fn(...values, ...fnNames.map(n => FN[n]));
}

/**
 * 装修度带来的心情加成。
 * @param {number} cozy     当前装修度
 * @param {object} economy  rules/economy.json 内容
 * @param {number} [scale]  兼容旧调用：传了就走旧公式 min(20, sqrt(cozy)*scale)
 */
function cozyBonus(cozy, economy, scale){
  if (typeof scale === 'number'){
    return Math.round(Math.min(20, Math.sqrt(cozy) * scale));
  }
  const expr = (economy && economy.cozy && economy.cozy.bonusExpr)
    || 'min(20, round(sqrt(cozy) * 1.5))';
  return evalExpr(expr, { cozy });
}

/** 装修度等级：取 min <= cozy 的最高档 */
function cozyTier(cozy, tiers){
  const list = tiers || [];
  let pick = list[0] || { min: 0, name: '', stars: 0 };
  for (const t of list) if (cozy >= t.min) pick = t;
  return pick;
}

/** 晨间加成系数（跨天时用 cozyBonus * morningScale） */
function cozyMorningBonus(cozy, economy){
  const scale = (economy && economy.cozy && economy.cozy.morningScale) ?? 0.6;
  return Math.round(cozyBonus(cozy, economy) * scale);
}

/**
 * 按游戏分钟推进生存数值（不修改入参，返回新对象）。
 * @param {{hunger:number,thirst:number,emotion:number}} stats
 * @param {object} survival rules/survival.json
 * @param {number} gameMinutes
 */
function applyDecay(stats, survival, gameMinutes){
  const out = Object.assign({}, stats);
  for (const [k, def] of Object.entries(survival.stats || {})){
    const rate = def.decayPerGameMinute || 0;
    const max = def.max ?? 100;
    out[k] = clamp(out[k] - rate * gameMinutes, 0, max);
  }
  return out;
}

function clamp(v, lo, hi){
  const min = lo === undefined ? 0 : lo;
  const max = hi === undefined ? 100 : hi;
  return Math.max(min, Math.min(max, v));
}

  __exports.assertSafeExpr = assertSafeExpr;
  __exports.evalExpr = evalExpr;
  __exports.cozyBonus = cozyBonus;
  __exports.cozyTier = cozyTier;
  __exports.cozyMorningBonus = cozyMorningBonus;
  __exports.applyDecay = applyDecay;
  __exports.clamp = clamp;
});

__define("src/net/save-provider.js", function(__exports, __require){
/**
 * 存档服务：本地优先（offline-first）+ 服务端同步。
 *
 * 设计要点
 *  1. localStorage 是"本地缓存"，不是真相；服务端才是真相。
 *  2. 断网照常玩：本地立即写，联网后补推。
 *  3. 冲突用「版本号 + 字段级合并」解决：
 *     服务端版本更高 → 409 带服务端数据 → 家具取并集、数值取较新、装修风格取较新 → 再推一次。
 *  4. 所有外部依赖（fetch / storage / 时间）都可注入，方便在页面里用假实现跑测试。
 */

const DEFAULT_API = 'http://127.0.0.1:8787/api/v1';

function safeStorage(s){
  if (s) return s;
  try { return window.localStorage; } catch(e){ return null; }
}

/** 家具列表取并集（同一 catalogId + 坐标视为同一件） */
function mergePlaced(a, b){
  const out = [];
  const seen = new Set();
  for (const item of [].concat(a || [], b || [])){
    if (!item || !item.catalogId) continue;
    const k = item.catalogId + '@' + item.gx + ',' + item.gy;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ catalogId: item.catalogId, gx: item.gx, gy: item.gy });
  }
  return out;
}

/**
 * 字段级合并：谁新，数值与风格听谁的；家具永远取并集（避免"在另一台机器上摆的东西丢了"）。
 */
function mergeSaves(local, remote){
  const l = local || {}, r = remote || {};
  const newer = (r.savedAt || 0) > (l.savedAt || 0) ? r : l;
  const merged = {
    money: newer.money ?? l.money ?? r.money ?? 500,
    minute: newer.minute ?? l.minute,
    day: newer.day ?? l.day,
    stats: Object.assign({}, r.stats || {}, newer.stats || {}),
    person: Object.assign({}, r.person || {}, newer.person || {}),
    appearance: Object.assign({}, r.appearance || {}, newer.appearance || {}),
    houseLevel: Math.max(l.houseLevel || 0, r.houseLevel || 0),
    sndOn: newer.sndOn ?? l.sndOn,
    floorStyle: newer.floorStyle ?? l.floorStyle ?? 0,
    wallStyle: newer.wallStyle ?? l.wallStyle ?? 0,
    ownedFloors: unionNums(l.ownedFloors, r.ownedFloors),
    ownedWalls: unionNums(l.ownedWalls, r.ownedWalls),
    placed: mergePlaced(l.placed, r.placed),
    inventory: mergeInventory(l.inventory, r.inventory),
    savedAt: Math.max(l.savedAt || 0, r.savedAt || 0)
  };
  return merged;
}

function unionNums(a, b){
  const set = new Set([].concat(a || [], b || []));
  set.add(0);
  return [...set].filter(n => typeof n === 'number').sort((x, y) => x - y);
}

function mergeInventory(a, b){
  const map = new Map();
  for (const it of [].concat(a || [], b || [])){
    if (!it || !it.catalogId) continue;
    const cur = map.get(it.catalogId) || 0;
    map.set(it.catalogId, Math.max(cur, it.count || 0));
  }
  return [...map.entries()].map(([catalogId, count]) => ({ catalogId, count }));
}

/**
 * 创建存档服务。
 * @param {object} o
 * @param {string}   [o.apiBase]   服务端地址
 * @param {object}   [o.storage]   localStorage 兼容对象（getItem/setItem/removeItem）
 * @param {Function} [o.fetchImpl] fetch 实现
 * @param {Function} [o.now]       时间源（测试可注入）
 */
function createSaveService(o){
  const opt = o || {};
  const apiBase = (opt.apiBase || DEFAULT_API).replace(/\/$/, '');
  const storage = safeStorage(opt.storage);
  const fetchImpl = opt.fetchImpl || (typeof fetch === 'function' ? fetch.bind(window) : null);
  const now = opt.now || (() => Date.now());
  const tokenKey = opt.tokenKey || 'home_token';
  const debounceMs = opt.debounceMs ?? 1500;
  const timeoutMs = opt.timeoutMs ?? 5000;

  // 包一层超时：服务端不可达时不能把页面卡在 pending 状态（浏览器 fetch 默认没有超时）
  function req(url, init){
    if (!fetchImpl) return Promise.reject(new Error('no fetch'));
    if (typeof AbortController === 'undefined') return fetchImpl(url, init);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const merged = Object.assign({}, init, { signal: ctl.signal });
    return fetchImpl(url, merged).finally(() => clearTimeout(timer));
  }

  let status = 'idle';      // idle | local | syncing | synced | offline | merged
  let version = 0;
  let token = '';
  let lastError = '';
  let timer = null;
  let pending = null;       // 待推送的存档
  let inflight = false;
  const listeners = [];
  const mergeListeners = [];

  try { token = (storage && storage.getItem(tokenKey)) || ''; } catch(e){ token = ''; }

  function emit(s, err){
    status = s;
    lastError = err || '';
    for (const fn of listeners) { try { fn(status, lastError); } catch(e){} }
  }

  function headers(extra){
    const h = Object.assign({ Authorization: 'Bearer ' + token }, extra || {});
    return h;
  }

  async function ensureToken(){
    if (token) return token;
    if (!fetchImpl) throw new Error('no fetch');
    const r = await req(apiBase + '/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!r.ok) throw new Error('guest ' + r.status);
    const j = await r.json();
    token = j.token;
    if (storage) { try { storage.setItem(tokenKey, token); } catch(e){} }
    return token;
  }

  /** 拉取服务端存档；没有则返回 { empty: true } */
  async function pull(){
    await ensureToken();
    let r = await req(apiBase + '/save', { headers: headers() });
    if (r.status === 401 || r.status === 403){
      token = '';
      if (storage) { try { storage.removeItem(tokenKey); } catch(e){} }
      await ensureToken();
      r = await req(apiBase + '/save', { headers: headers() });
    }
    if (r.status === 404) return { empty: true };
    if (!r.ok) throw new Error('pull ' + r.status);
    const j = await r.json();
    version = j.version || 0;
    return { empty: false, version: version, data: j.data, updatedAt: j.updatedAt };
  }

  /** 推送一次；冲突返回 { conflict: true, serverVersion, serverData } */
  async function pushRaw(data){
    await ensureToken();
    const r = await req(apiBase + '/save', {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json', 'If-Match': String(version) }),
      body: JSON.stringify({ data })
    });
    if (r.status === 409){
      const j = await r.json();
      return { conflict: true, serverVersion: j.serverVersion, serverData: j.serverData };
    }
    if (!r.ok) throw new Error('push ' + r.status);
    const j = await r.json();
    version = j.version || version + 1;
    return { ok: true, version: version, cozyScore: j.cozyScore };
  }

  /** 推送存档（遇到冲突自动合并后重试一次） */
  async function push(data){
    if (!fetchImpl) { emit('local'); return { skipped: true }; }
    inflight = true;
    emit('syncing');
    try {
      let payload = data;
      let res = await pushRaw(payload);
      if (res.conflict){
        payload = mergeSaves(payload, res.serverData || {});
        version = res.serverVersion || version;
        payload.savedAt = now();
        res = await pushRaw(payload);
        if (res.conflict) throw new Error('conflict again');
        emit('merged');
        // 合并结果必须回灌到本地，否则下一次自动存档会把刚合并进来的家具又覆盖掉
        for (const fn of mergeListeners) { try { fn(payload); } catch(e){} }
      } else {
        emit('synced');
      }
      pending = null;
      return Object.assign({ ok: true, merged: !!res }, { version: version, data: payload });
    } catch (e){
      pending = data;
      emit('offline', e.message);
      return { ok: false, error: e.message };
    } finally {
      inflight = false;
    }
  }

  /** 标记有改动：防抖后推送（连续操作只推最后一次） */
  function markDirty(data){
    if (!fetchImpl) { emit('local'); return; }
    pending = data;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (pending) push(pending); }, debounceMs);
  }

  /**
   * 启动：本地已有存档时立即用本地（不阻塞首屏），再与远端对齐。
   * @returns {Promise<{source:'remote'|'local'|'none', data?:object}>}
   */
  async function boot(localData){
    if (!fetchImpl) { emit('local'); return { source: localData ? 'local' : 'none' }; }
    emit('syncing');
    try {
      const remote = await pull();
      if (remote.empty){
        if (localData) {
          const r = await push(Object.assign({}, localData, { savedAt: localData.savedAt || now() }));
          return { source: 'local', pushed: !!r.ok };
        }
        emit('synced');
        return { source: 'none' };
      }
      if (!localData){
        emit('synced');
        return { source: 'remote', data: remote.data };
      }
      const localAt = localData.savedAt || 0;
      const remoteAt = Date.parse(remote.updatedAt || '') || 0;
      if (remoteAt > localAt + 1500){
        const merged = mergeSaves(localData, remote.data || {});
        emit('synced');
        return { source: 'remote', data: merged };
      }
      const r = await push(localData);
      return { source: 'local', pushed: !!r.ok };
    } catch (e){
      emit('offline', e.message);
      return { source: localData ? 'local' : 'none' };
    }
  }

  /** 重新尝试推送积压（联网恢复时调用） */
  async function flush(){
    if (!pending || inflight) return { ok: false, skipped: true };
    return push(pending);
  }

  return {
    boot, push, flush, markDirty, pull,
    merge: mergeSaves,
    onStatus(fn){ listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    /** 订阅"冲突合并后的最终存档"，调用方应把它灌回游戏状态 */
    onMerge(fn){ mergeListeners.push(fn); return () => { const i = mergeListeners.indexOf(fn); if (i >= 0) mergeListeners.splice(i, 1); }; },
    get status(){ return status; },
    get version(){ return version; },
    get token(){ return token; },
    get error(){ return lastError; },
    get hasPending(){ return !!pending; },
    get apiBase(){ return apiBase; }
  };
}

  __exports.DEFAULT_API = DEFAULT_API;
  __exports.mergePlaced = mergePlaced;
  __exports.mergeSaves = mergeSaves;
  __exports.createSaveService = createSaveService;
});

__define("src/net/social.js", function(__exports, __require){
/**
 * 社区客户端：排行榜 / 串门房间 / 访问计数。
 * 只做"取数据 + 归一化"，不碰渲染；失败一律抛出，由调用方决定降级。
 */

const DEFAULT_API = 'http://127.0.0.1:8787/api/v1';

/** 服务端 room 载荷 → 引擎可直接使用的房间描述 */
function normalizeRoom(item){
  const r = (item && item.room) || {};
  return {
    userId: item.userId,
    name: r.nickname || item.nickname || '邻居',
    cozyScore: item.cozyScore || 0,
    visits: item.visits || 0,
    address: r.address || '',
    houseLevel: Math.max(0, r.houseLevel | 0),
    floorStyle: Math.max(0, r.floorStyle | 0),
    wallStyle: Math.max(0, r.wallStyle | 0),
    placed: Array.isArray(r.placed) ? r.placed.filter(p => p && p.catalogId) : []
  };
}

/**
 * @param {object} o
 * @param {string}   [o.apiBase]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.now]
 */
function createSocialClient(o){
  const opt = o || {};
  const apiBase = (opt.apiBase || DEFAULT_API).replace(/\/$/, '');
  const fetchImpl = opt.fetchImpl || (typeof fetch === 'function' ? fetch.bind(window) : null);
  const timeoutMs = opt.timeoutMs ?? 5000;

  function req(url, init){
    if (!fetchImpl) return Promise.reject(new Error('no fetch'));
    if (typeof AbortController === 'undefined') return fetchImpl(url, init);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    return fetchImpl(url, Object.assign({}, init, { signal: ctl.signal }))
      .finally(() => clearTimeout(timer));
  }

  async function getJSON(path, token){
    const r = await req(apiBase + path, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  }

  return {
    /** 服务端版本元信息（客户端据此判断是否需要刷新） */
    async meta(){
      return getJSON('/meta');
    },

    /** 单独拉一个内容包（模块级热更新用） */
    async pack(packId){
      const path = String(packId).split('/').map(encodeURIComponent).join('/');
      return getJSON('/content/pack/' + path);
    },

    /** 装修度排行榜 */
    async leaderboard(limit){
      const j = await getJSON('/leaderboard?limit=' + (limit || 20));
      return (j.items || []).map(it => ({
        userId: it.userId,
        name: it.nickname,
        cozyScore: it.cozyScore || 0,
        houseLevel: it.houseLevel || 0,
        day: it.day || 1
      }));
    },

    /** 可参观的房间（随机） */
    async feed(limit){
      const j = await getJSON('/rooms/feed?limit=' + (limit || 12));
      return (j.items || []).map(normalizeRoom);
    },

    /** 记录一次串门（不阻塞界面，失败忽略） */
    async visit(userId, token){
      if (!userId) return false;
      const r = await req(apiBase + '/rooms/' + encodeURIComponent(userId) + '/visit', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      return r.ok;
    },

    /** 公寓楼房间目录：某栋楼里已入住的房间（含房间快照） */
    async buildingRooms(buildingId){
      if (!buildingId) return [];
      const j = await getJSON('/buildings/' + encodeURIComponent(buildingId) + '/rooms');
      return (j.items || []).map(it => {
        const snap = it.snapshot || null;
        return {
          userId: it.userId,
          name: it.nickname || '邻居',
          floor: it.floor || 0,
          room: it.room || 0,
          cozyScore: it.cozyScore || 0,
          roomData: snap ? normalizeRoom({
            userId: it.userId, nickname: it.nickname, cozyScore: it.cozyScore, visits: 0, room: snap
          }) : null
        };
      });
    },

    /** 好友列表（需要 token）：与 feed 同构，直接能拿去 enterPeer */
    async friends(token){
      if (!token) return [];
      const j = await getJSON('/friends', token);
      return (j.items || []).map(normalizeRoom);
    },

    /** 加好友：幂等；失败抛出由调用方提示 */
    async addFriend(userId, token){
      if (!userId || !token) return false;
      const r = await req(apiBase + '/friends/' + encodeURIComponent(userId), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      });
      return r.ok;
    },

    async removeFriend(userId, token){
      if (!userId || !token) return false;
      const r = await req(apiBase + '/friends/' + encodeURIComponent(userId), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      return r.ok;
    },

    get apiBase(){ return apiBase; }
  };
}

  __exports.DEFAULT_API = DEFAULT_API;
  __exports.normalizeRoom = normalizeRoom;
  __exports.createSocialClient = createSocialClient;
});

__define("src/core/version.js", function(__exports, __require){
/**
 * 版本与升级判定（纯函数，可单测）。
 *
 * 四套版本号各管一件事，不要混用：
 *   appVersion    客户端构建版本（改了游戏代码就 +1）——决定"你的客户端是不是旧的"
 *   contentVersion 内容结构版本（改了 content/ 的结构就 +1）——决定"服务端有没有新内容"
 *   contentHash   内容指纹（构建产物指纹）——只用于日志/人工核对，参与自动判定会让两边天天"不一致"
 *   saveSchema    存档结构版本（改了存档字段就 +1）——驱动迁移函数
 */
const { BUILD } = __require("src/version.generated.js");
/** 本次构建的版本信息（构建时注入） */
const CLIENT = BUILD;

/** 解析 "1.6.0" / "1.6.0+ab12cd34" / "1.6.0-beta.1" */
function parseVersion(v){
  const s = String(v || '').trim().split('+')[0];
  const [core, pre] = s.split('-');
  const nums = core.split('.').map(n => {
    const x = parseInt(n, 10);
    return isNaN(x) ? 0 : x;
  });
  while (nums.length < 3) nums.push(0);
  return { major: nums[0], minor: nums[1], patch: nums[2], pre: pre || '' };
}

/**
 * 比较两个版本号：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 规则：主次修订依次比较；正式版 > 预发布版；构建元数据（+xxx）不参与比较。
 */
function compareVersion(a, b){
  const A = parseVersion(a), B = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']){
    if (A[k] !== B[k]) return A[k] > B[k] ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;          // 1.6.0 > 1.6.0-beta
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/**
 * 判定客户端与服务端的版本关系。
 * @param {{appVersion:string, contentVersion:number, contentHash:string}} client
 * @param {{appVersion?:string, contentVersion:number, contentHash:string, minAppVersion?:string}} server
 * @returns {{status:'ok'|'content-updated'|'client-outdated'|'server-outdated', message:string, action:string}}
 *   ok              版本一致，什么都不用做
 *   content-updated 服务端内容更新（客户端内联的是旧内容）→ 提示刷新
 *   client-outdated 客户端太旧，服务端已不接受 → 强制刷新
 *   server-outdated 服务端内容比客户端旧（服务端没重启/没 bundle）→ 提示运维
 */
function evaluateUpdate(client, server){
  const c = client || {};
  const s = server || {};

  if (s.minAppVersion && compareVersion(c.appVersion || '0.0.0', s.minAppVersion) < 0){
    return {
      status: 'client-outdated',
      message: '客户端版本过旧（' + (c.appVersion || '?') + ' < ' + s.minAppVersion + '），请刷新页面',
      action: 'reload'
    };
  }
  const scv = Number(s.contentVersion || 0);
  const ccv = Number(c.contentVersion || 0);
  if (scv > ccv){
    return {
      status: 'content-updated',
      message: '服务端内容已更新（内容 ' + scv + ' > 本地 ' + ccv + '），刷新后可获得新家具/新规则',
      action: 'reload'
    };
  }
  if (scv < ccv){
    return {
      status: 'server-outdated',
      message: '服务端内容较旧（内容 ' + scv + ' < 本地 ' + ccv + '），请重启服务端或重新 bundle',
      action: 'warn'
    };
  }
  // 注意：contentHash 不参与判定。客户端指纹取自 generated.js、服务端取自 content.json，
  // 两者输入不同，直接比较必然不等 → 会天天误报"需要刷新"。
  // 指纹只用于日志与人工核对（构建产物是否一致）。
  return { status: 'ok', message: '版本一致（客户端 ' + (c.appVersion || '?') + ' · 内容 ' + ccv + '）', action: 'none' };
}

/** 存档是否需要迁移 */
function needsSaveMigration(save, targetSchema){
  const cur = (save && save.schema) || 1;      // 老存档没有 schema 字段 → 视为 1
  return targetSchema > cur;
}

/**
 * 模块级差异：客户端与服务端逐个模块比对指纹，返回变化的模块清单。
 * @param {{modules:Object}} client
 * @param {{modules:Object}} server
 * @returns {Array<{id:string, from:number|null, to:number|null, kind:'new'|'content'|'code'}>}
 */
function diffModules(client, server){
  const c = (client && client.modules) || {};
  const s = (server && server.modules) || {};
  const changed = [];
  for (const id of Object.keys(s)){
    const sv = s[id] || {};
    const cv = c[id];
    if (!cv){
      changed.push({ id, from: null, to: sv.version, kind: 'new' });
      continue;
    }
    if (cv.hash !== sv.hash){
      changed.push({ id, from: cv.version, to: sv.version, kind: sv.version == null ? 'code' : 'content' });
    }
  }
  return changed;
}

/** 只有内容包能热替换；代码模块变化必须重新加载页面 */
function splitHotPatchable(changed){
  const hot = [];
  const needsReload = [];
  for (const m of changed){
    if (m.id.startsWith('content/')) hot.push(m);
    else needsReload.push(m);
  }
  return { hot, needsReload };
}

  __exports.CLIENT = CLIENT;
  __exports.parseVersion = parseVersion;
  __exports.compareVersion = compareVersion;
  __exports.evaluateUpdate = evaluateUpdate;
  __exports.needsSaveMigration = needsSaveMigration;
  __exports.diffModules = diffModules;
  __exports.splitHotPatchable = splitHotPatchable;
});

__define("src/core/environment.js", function(__exports, __require){
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
function hashSeed(str){
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而稳的伪随机数发生器 */
function makeRng(seed){
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
function rand01(seed, key){
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
function weatherAt(seed, day, minute, climate, bias){
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
function scatterProps(o){
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
function growthStage(plantedAt, nowMinute, growth, wateredBonus){
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
function trafficAt(seed, minute, lanes, traffic){
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
function daytimeAt(minute, climate){
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
function weatherSeed(climate, userId, worldSeed){
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
function sampleDaylight(climate, minute){
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
function seasonAt(seasons, opts){
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

  __exports.hashSeed = hashSeed;
  __exports.makeRng = makeRng;
  __exports.rand01 = rand01;
  __exports.weatherAt = weatherAt;
  __exports.scatterProps = scatterProps;
  __exports.growthStage = growthStage;
  __exports.trafficAt = trafficAt;
  __exports.daytimeAt = daytimeAt;
  __exports.weatherSeed = weatherSeed;
  __exports.sampleDaylight = sampleDaylight;
  __exports.seasonAt = seasonAt;
});

__define("src/core/clock.js", function(__exports, __require){
/**
 * 世界时钟（统一时间）
 *
 * 模型：服务端存一个"锚点" —— 某一刻的世界总分钟数 + 那一刻的现实时间戳。
 * 客户端拿到锚点后，用现实时间差推算当前世界时间：
 *
 *   totalMinute = anchor.totalMinute + (now - anchor.at) * rate / 60000
 *
 * 为什么用锚点而不是"每秒广播"：
 *   - 一个字段就能同步，流量几乎为零
 *   - 客户端两次同步之间自己走钟，界面不会卡顿
 *   - 断网时用最后锚点继续走（自动降级为本地时钟）
 *
 * 与旧模型（存档里存 minute/day）的差别：
 *   时间是**全局**的，存档不再拥有它；存档只在离线时暂存"本地估算"。
 */
const MINUTES_PER_DAY = 1440;

/** 世界总分钟 → {day, minute} */
function splitTotal(totalMinute){
  const total = Math.max(0, Math.floor(totalMinute || 0));
  return {
    day: Math.floor(total / MINUTES_PER_DAY) + 1,   // 第 1 天起
    minute: total % MINUTES_PER_DAY
  };
}

/** {day, minute} → 世界总分钟 */
function joinTotal(day, minute){
  const d = Math.max(1, Math.floor(day || 1));
  const m = Math.max(0, Math.floor(minute || 0));
  return (d - 1) * MINUTES_PER_DAY + m;
}

/**
 * 由锚点推算当前世界时间。
 * @param {{totalMinute:number, at:number}} anchor 服务端锚点（at = 毫秒时间戳）
 * @param {number} nowMs 当前现实时间戳
 * @param {number} rate 时间倍率（1 = 1 现实秒推进 1 游戏分钟）
 */
function tickClock(anchor, nowMs, rate){
  const a = anchor || {};
  const base = Number(a.totalMinute || 0);
  const at = Number(a.at || nowMs || 0);
  const r = typeof rate === 'number' ? rate : 1;
  const elapsedMs = Math.max(0, (nowMs || at) - at);
  const total = base + (elapsedMs / 60000) * r;
  return Object.assign({ totalMinute: total, rate: r }, splitTotal(total));
}

/**
 * 漂移校正：客户端自己走了很久后，与服务端锚点比较，返回需要插值的差值。
 * 直接硬跳会让时钟"闪一下"，所以调用方应该在一段时间内线性抹平这个差值。
 * @returns {{driftMinutes:number, shouldSnap:boolean}}
 */
function clockDrift(localTotal, serverTotal){
  const drift = (serverTotal || 0) - (localTotal || 0);
  return { driftMinutes: drift, shouldSnap: Math.abs(drift) > 30 };
}

/** 便于显示：分钟 → HH:MM */
function fmtClock(minute){
  const m = ((Math.floor(minute || 0) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** 是否夜晚（用于环境光 / 睡觉判定） */
function isNight(minute, sleep){
  const from = (sleep && sleep.fromHour) ?? 21;
  const to = (sleep && sleep.toHour) ?? 5;
  const h = Math.floor(((minute || 0) % MINUTES_PER_DAY) / 60);
  // from<=to 是普通区间（如 9→17）；from>to 是跨午夜（如 21→5）
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);
}

  __exports.MINUTES_PER_DAY = MINUTES_PER_DAY;
  __exports.splitTotal = splitTotal;
  __exports.joinTotal = joinTotal;
  __exports.tickClock = tickClock;
  __exports.clockDrift = clockDrift;
  __exports.fmtClock = fmtClock;
  __exports.isNight = isNight;
});

__define("src/content/generated.js", function(__exports, __require){
// 由 tools/build.mjs 自动生成，请勿手改（源数据在 content/*.json）
const CONTENT = {"manifest":{"contentVersion":1,"generatedAt":"2026-11-04T19:19:13.294Z"},"modules":{"achievements/achievements.json":{"version":4,"hash":"7c1e700a25c3","updatedAt":"2026-11-12T08:13:03.207Z"},"bank/bank.json":{"version":2,"hash":"fe2d1cad7a50","updatedAt":"2026-11-05T20:55:37.853Z"},"business/business.json":{"version":3,"hash":"5e5248ad66a2","updatedAt":"2026-11-05T20:32:27.142Z"},"careers/jobs.json":{"version":6,"hash":"ed778bd88d35","updatedAt":"2026-11-12T12:27:40.268Z"},"catalog/categories.json":{"version":1,"hash":"5599bf855145","updatedAt":"2026-11-05T12:55:12.499Z"},"catalog/furniture.core.json":{"version":3,"hash":"634f86f85e9e","updatedAt":"2026-11-05T12:58:38.488Z"},"catalog/home.goods.json":{"version":1,"hash":"67bec37ae834","updatedAt":"2026-11-07T01:36:49.247Z"},"catalog/items.decor.json":{"version":1,"hash":"f4800b19fb18","updatedAt":"2026-11-05T09:56:34.049Z"},"characters/npcs.neighbors.json":{"version":25,"hash":"0360903f004a","updatedAt":"2026-11-12T13:29:02.886Z"},"characters/palettes.json":{"version":1,"hash":"9cf60aa16886","updatedAt":"2026-11-05T09:56:34.049Z"},"characters/player.default.json":{"version":1,"hash":"1b632f4c14f5","updatedAt":"2026-11-05T09:56:34.049Z"},"environment/ambient.json":{"version":5,"hash":"089ad64b6a33","updatedAt":"2026-11-12T09:52:04.721Z"},"environment/climate.json":{"version":4,"hash":"ef5ded811ec6","updatedAt":"2026-11-05T13:42:24.750Z"},"environment/seasons.json":{"version":2,"hash":"0611393d2e77","updatedAt":"2026-11-05T13:42:24.753Z"},"house/levels.json":{"version":3,"hash":"416b75486996","updatedAt":"2026-11-07T17:42:32.336Z"},"house/residence.json":{"version":5,"hash":"8a974e46249c","updatedAt":"2026-11-07T17:42:32.337Z"},"house/styles.json":{"version":1,"hash":"558eb9062d64","updatedAt":"2026-11-05T09:56:34.049Z"},"interaction/verbs.json":{"version":1,"hash":"7b5108c68803","updatedAt":"2026-11-05T12:55:12.501Z"},"lottery/lottery.json":{"version":1,"hash":"b1cd4c62e2d5","updatedAt":"2026-11-05T19:01:54.435Z"},"maps/home.map.json":{"version":1,"hash":"fa7263c09f78","updatedAt":"2026-11-05T09:56:34.049Z"},"maps/street.map.json":{"version":23,"hash":"e73a869d9694","updatedAt":"2026-11-12T09:52:04.723Z"},"pets/pets.json":{"version":1,"hash":"07c5b1133cb7","updatedAt":"2026-11-07T01:36:49.254Z"},"rules/bills.json":{"version":1,"hash":"2ff3cf93c8a8","updatedAt":"2026-11-05T19:17:35.958Z"},"rules/economy.json":{"version":8,"hash":"b38c4438ae77","updatedAt":"2026-11-12T11:22:08.491Z"},"rules/survival.json":{"version":6,"hash":"75e1f3ea0d42","updatedAt":"2026-11-12T08:55:33.995Z"},"stock/stock.json":{"version":2,"hash":"b628686e5439","updatedAt":"2026-11-12T07:35:50.423Z"},"ui/strings.zh-CN.json":{"version":2,"hash":"9afa3735c2fe","updatedAt":"2026-11-05T09:58:52.984Z"},"vehicles/cars.json":{"version":2,"hash":"e28eaf242a03","updatedAt":"2026-11-05T19:17:35.959Z"}},"packs":{"achievements/achievements.json":{"schema":"achievements/1","id":"achievements.default","note":"生活目标（成就）：目标值由引擎按 kind 从当前状态推导，不单独存进度；只把已解锁的 id 记进存档。新增一条 = 加数据，代码零改动（kind 见 note）。kind: day=天数 money=存款 cozy=装修度 houseLevel=房型等级 placed=摆放件数 shifts=总班次 jobShifts=某岗位班次(需 job) careerLevel=最高熟练等级 visits=串门过的人家数 「第一次」组是有顺序的引导链（step 1→7），前一条做完再做下一条：教的是\"第一个必需动词\"，不要往中间插无关目标。","groups":[{"id":"first","name":"第一次","order":-1},{"id":"life","name":"生活","order":0},{"id":"home","name":"小家","order":1},{"id":"career","name":"工作","order":2},{"id":"social","name":"邻里","order":3}],"achievements":[{"id":"first.street","group":"first","step":1,"name":"出门看看","desc":"第一次走进小区","hint":"走到院子门口往下，就进小区了","goal":{"kind":"event","value":"street"},"reward":{"money":20,"effects":{"emotion":2}}},{"id":"first.meal","group":"first","step":2,"name":"吃第一顿饭","desc":"第一次填饱肚子","hint":"菜市场买食材回家点灶台做饭，或到老张饭馆吃一顿","goal":{"kind":"event","value":"meal"},"reward":{"money":20,"effects":{"emotion":3}}},{"id":"first.job","group":"first","step":3,"name":"上第一天班","desc":"第一次打卡拿到工资","hint":"走到便利店或咖啡店门口点「打卡上班」，一天只有一班","goal":{"kind":"shifts","value":1},"reward":{"money":30,"effects":{"emotion":4}}},{"id":"first.furniture","group":"first","step":4,"name":"摆下第一件家具","desc":"第一次自己把新买的家具摆进屋","hint":"去家具店买一件，回家点「仓库」把新买的那件摆出来","goal":{"kind":"event","value":"placed"},"reward":{"money":30,"effects":{"emotion":4}}},{"id":"first.decor","group":"first","step":5,"name":"换个地板或墙纸","desc":"第一次给屋子换一种地面或墙面","hint":"回家点「装修」，挑一种地板或墙纸——买一次永久解锁","goal":{"kind":"event","value":"decor"},"reward":{"money":50,"effects":{"emotion":6}}},{"id":"first.savings","group":"first","step":6,"name":"存下第一笔钱","desc":"活期存款达到 ¥300","hint":"去民生银行存 ¥300，活期每天生息，急用随时取","goal":{"kind":"savings","value":300},"reward":{"money":50,"effects":{"emotion":5}}},{"id":"first.home","group":"first","step":7,"name":"搬进自己的家","desc":"买下或租下第二套房（现在住的这间也算一套）","hint":"在公寓楼目录里挑一间买下或租下——每人最多 3 套","goal":{"kind":"estates","value":2},"reward":{"money":200,"effects":{"emotion":10}}},{"id":"first.restaurant","group":"first","step":8,"name":"下馆子吃一顿","desc":"第一次在老张饭馆点菜","hint":"饭馆在商业街，点一道菜——不用自己开火，贵一点但省事","goal":{"kind":"event","value":"restaurant"},"reward":{"money":30,"effects":{"emotion":5}}},{"id":"first.pet","group":"first","step":9,"name":"多一个室友","desc":"第一次养一只小动物","hint":"宠物店有猫狗仓鼠，买之前记得先备好宠物粮","goal":{"kind":"pets","value":1},"reward":{"money":60,"effects":{"emotion":8}}},{"id":"first.sold","group":"first","step":10,"name":"第一次出手","desc":"卖掉一套房产（自住那套不算）","hint":"公寓楼目录里选自己另一套房，可以空房卖，也可以带装修一起卖","goal":{"kind":"event","value":"soldEstate"},"reward":{"money":100,"effects":{"emotion":6}}},{"id":"first.stockwin","group":"first","step":11,"name":"股市里赚到第一笔","desc":"持仓浮盈第一次转正","hint":"证券营业部看走势图，跌的时候买、涨的时候卖；浮盈转正就算","goal":{"kind":"stockProfit","value":1},"reward":{"money":80,"effects":{"emotion":8}}},{"id":"ach.savings_800","group":"life","name":"开始有积蓄","desc":"存款达到 ¥800","goal":{"kind":"money","value":800},"reward":{"effects":{"emotion":4}}},{"id":"ach.first_night","group":"life","name":"住了一夜","desc":"在这个小区过完第一晚","goal":{"kind":"day","value":2},"reward":{"money":40,"effects":{"emotion":4}}},{"id":"ach.one_week","group":"life","name":"一周住户","desc":"住满七天，把这里当成家","goal":{"kind":"day","value":7},"reward":{"money":120,"effects":{"emotion":6}}},{"id":"ach.saver","group":"life","name":"小有积蓄","desc":"存款达到 ¥3000","goal":{"kind":"money","value":3000},"reward":{"effects":{"emotion":10}}},{"id":"ach.ten_pieces","group":"home","name":"十件家当","desc":"屋里同时摆着十件家具","goal":{"kind":"placed","value":10},"reward":{"money":150,"effects":{"emotion":5}}},{"id":"ach.cozy_50","group":"home","name":"温馨小屋","desc":"装修度达到 50","goal":{"kind":"cozy","value":50},"reward":{"money":120,"effects":{"emotion":6}}},{"id":"ach.cozy_120","group":"home","name":"梦想之家","desc":"装修度达到 120","goal":{"kind":"cozy","value":120},"reward":{"money":300,"effects":{"emotion":10}}},{"id":"ach.expand_once","group":"home","name":"第一次扩建","desc":"把小屋升到更大的房型","goal":{"kind":"houseLevel","value":1},"reward":{"money":200,"effects":{"emotion":8}}},{"id":"ach.first_shift","group":"career","name":"打的第一份工","desc":"完整上完一个班次","goal":{"kind":"shifts","value":1},"reward":{"money":60,"effects":{"emotion":5}}},{"id":"ach.ten_shifts","group":"career","name":"老手","desc":"累计上完十个整班","goal":{"kind":"shifts","value":10},"reward":{"money":300,"effects":{"emotion":8}}},{"id":"ach.store_veteran","group":"career","name":"便利店熟手","desc":"在便利店上完十个整班","goal":{"kind":"jobShifts","job":"job.store","value":10},"reward":{"money":200,"effects":{"emotion":6}}},{"id":"ach.teacher","group":"career","name":"站上讲台","desc":"在学校代课五个整班","goal":{"kind":"jobShifts","job":"job.teacher","value":5},"reward":{"money":200,"effects":{"emotion":8}}},{"id":"ach.promoted","group":"career","name":"升了一级","desc":"任意岗位的熟练度达到 Lv.2","goal":{"kind":"careerLevel","value":2},"reward":{"money":250,"effects":{"emotion":10}}},{"id":"ach.first_visit","group":"social","name":"第一次串门","desc":"去一位邻居家里做客","goal":{"kind":"visits","value":1},"reward":{"money":50,"effects":{"emotion":6}}},{"id":"ach.five_homes","group":"social","name":"走遍小区","desc":"去过五位不同邻居的家","goal":{"kind":"visits","value":5},"reward":{"money":150,"effects":{"emotion":8}}}]},"bank/bank.json":{"schema":"bank/1","zone":"shop_bank","label":"民生银行","note":"银行是资金的「蓄水池」也是「杠杆」：存钱拿利息（低但稳、无上限），借钱先花后还（要付利息，是持续的资金出口）。所有利率都按游戏天算，因为游戏里 1 天 = 24 分钟真实时间，「年化」在这里没有意义。","savings":{"dailyRate":0.002,"cap":500000,"note":"活期：随存随取，按游戏天计息（每天跨天结算一次）。0.2%/天 ≈ 月 6.2%，比承包低但无风险、无上限。设上限是为了不让钱多到没处花之后彻底躺平。"},"fixed":{"penaltyRatio":0.2,"note":"定期：锁定若干天，到期一次性还本付息，利率比活期高。中途提前支取按本金的 20% 罚款（利息全没），所以定期是「这笔钱我短期不动」的承诺。","terms":[{"id":"fx.30","days":30,"dailyRate":0.003,"minAmount":1000,"note":"30 天短期"},{"id":"fx.90","days":90,"dailyRate":0.0037,"minAmount":5000,"note":"90 天中长期"}]},"loan":{"maxActive":2,"lateEmotionPerDay":-1,"lateEmotionCap":-20,"lateFeeRate":0.001,"note":"贷款一次性到账，之后每个游戏日从现金自动扣一期。现金不够就算逾期：当天扣 1 情绪（累计上限 -20）、并按欠款加 0.1% 罚息。逾期不清零，随时可以手动提前还。为什么不设「强制收房」：这是 cozy 游戏，欠钱不该让人一夜之间失去家。","tiers":[{"id":"ln.s","amount":5000,"days":30,"rate":0.08,"note":"小额应急"},{"id":"ln.m","amount":20000,"days":60,"rate":0.14,"note":"中额周转"},{"id":"ln.l","amount":60000,"days":90,"rate":0.2,"note":"大额置业"}]}},"business/business.json":{"schema":"business/1","id":"business.default","note":"功能点承包：付一个月承包金，承包期内每天自动结算净收益，到期自动失效、需要重新续约。这是「钱生钱」的那条腿——上班赚日薪（100-180/天）是劳动收入，承包是资产收入，前期靠劳动攒钱、后期靠资产滚雪球。daily 已经是扣掉人工/水电/损耗之后的净额，玩家不用管经营细节。","balanceNote":"月净利 = daily × termDays − fee，控制在 27%–50%（规模递减）：便利店这类小店回本最快，4S 店这种重资产最慢。上一版是 15%–30%，玩家反馈太低——钱滚不起来就没有\"当老板\"的感觉。","termDays":30,"termNote":"一个承包周期 = 30 个游戏日（约 12 小时真实时间）。**1 个月起租**，租金一次付清；租期内全自动营业，每天跨天自动结算，不需要盯着，也不影响上班（两条收入互不冲突）。","maxOwned":3,"maxOwnedNote":"一个人最多同时承包 3 处（精力有限）。和房产上限 3 套对齐，避免「有钱就全包下来」把游戏玩成挂机。","refundRatio":0.5,"refundNote":"中途退包按承包价 50% 回收，已产生的收益不退：转让要折价，也防止「承包-退包」刷钱。","catchUpDays":30,"catchUpNote":"离线回来最多补结算 30 天，避免挂机一年回来直接暴富。","settleNote":"每天跨天结算一次，钱直接进账；承包当天不结算，从第二天开始，共 termDays 天。","shops":[{"id":"biz.store","zone":"shop1","name":"便利店","fee":1500,"daily":75,"desc":"24 小时营业，流水最稳，适合第一次当老板","tag":"入门","code":1024},{"id":"biz.parking","zone":"parking_4s","name":"4S 店停车场","fee":1200,"daily":56,"desc":"车位按天收租，不用进货不用看店","tag":"躺赚","code":1188},{"id":"biz.cafe","zone":"shop2","name":"咖啡店","fee":2000,"daily":100,"desc":"靠写字楼客流，早高峰一刻都不能停","tag":"","code":2046},{"id":"biz.teashop","zone":"shop5","name":"奶茶店","fee":2400,"daily":118,"desc":"学生放学那一波顶一天，节假日更猛","tag":"","code":2377},{"id":"biz.lottery","zone":"shop_lottery","name":"彩票站","fee":3000,"daily":145,"desc":"卖一张提一注的佣金，稳赚不赔的是站主不是彩民","tag":"稳","code":2737},{"id":"biz.market","zone":"shop3","name":"菜市场","fee":3200,"daily":158,"desc":"每天凌晨进货，损耗大但走量也大","tag":"","code":3162},{"id":"biz.courier","zone":"shop4","name":"快递站","fee":4000,"daily":190,"desc":"派件按票结算，双十一能翻倍（游戏里按月均算）","tag":"","code":3508},{"id":"biz.restaurant","zone":"shop_restaurant","name":"老张饭馆","fee":6000,"daily":270,"desc":"老张退休了，锅气还在，熟客都认这个招牌","tag":"口碑","code":4126},{"id":"biz.super","zone":"shop_super","name":"惠民超市","fee":9000,"daily":400,"desc":"整个小区的菜篮子，客流稳定得可怕","tag":"大件","code":5280},{"id":"biz.carshop","zone":"shop_car","name":"4S 店","fee":26000,"daily":1100,"desc":"卖一台抵小店一个月，但压货也压钱","tag":"重资产","code":7702}],"codeNote":"每家店有独立门牌号（4 位），显示成「2737 号 · 彩票站」。同一个 zone 只能有一条承包记录；同类想开第二家（比如第二家彩票站），要在地图里新增一个 zone，再在这里加一条并分配新编号——编号是实体的身份，不是品类的。","exclusiveNote":"店铺是全局独占的：一个门牌同一时间只能有一个承包人，由服务端 businesses 表保证，别人承包了你这儿就是灰的。到期后自动变成空位，谁先付钱谁接。","dailyNote":"daily 是「平日期望日收」，实际每天 = daily × 当日客流系数。系数由「门牌号 + 游戏日」稳定散列出来（0.7–1.3），同一天谁来算都一样，不会读档就变；周末（每 7 天中的 2 天）再 ×1.25。所以经营是\"有起伏的\"，不是每天一个死数。","factor":{"min":0.7,"max":1.3,"weekendMul":1.25,"weekendDays":[0,6],"note":"weekendDays 是 DAY % 7 的取值：0 和 6 算周末，客流多两成半。"},"termOptions":[{"months":1,"mul":1,"note":"标准价"},{"months":2,"mul":0.95,"note":"95 折"},{"months":3,"mul":0.9,"note":"9 折"}],"termOptionsNote":"起租 1 个月，可以一次租 2–3 个月：租期越长单价越便宜（2 月 95 折、3 月 9 折），好处是省去到期续约的手续，钱还能锁定更久的稳定现金流。"},"careers/jobs.json":{"schema":"careers/1","id":"careers.jobs.default","note":"岗位直接绑定地图分区（zone.id）：走到那个分区就能打卡上班。改班次、工资、任务数只改这里，不用碰代码。","payNote":"实发日薪 = payPerTask × tasks + completionBonus（基础）；熟练满级后单价 ×(1 + payPerLevel × maxLevel)，见 career。monthlyPay = 日薪 × 22 个工作日，只用于面板展示和数值校对。","jobs":[{"id":"job.store","name":"便利店店员","zone":"shop1","desc":"24 小时营业：理货、收银、补货，夜里也能上班","shift":{"startHour":0,"endHour":24},"tasks":6,"taskSeconds":5,"taskLabels":["整理货架","收银结账","补货上架","擦柜台","查临期商品","对账"],"payPerTask":13,"completionBonus":32,"costPerTask":{"hunger":-1.2,"thirst":-1.6,"emotion":-0.5},"finish":{"emotion":8},"earlyLeave":{"emotion":-6},"promoShifts":3,"require":{},"dailyPay":110,"monthlyPay":2420},{"id":"job.cafe","name":"咖啡师","zone":"shop2","desc":"出品咖啡与甜点，需要一点好心情","shift":{"startHour":7,"endHour":19},"tasks":6,"taskSeconds":5,"taskLabels":["磨豆","打奶泡","出杯","洗杯子","擦桌子","补豆子"],"payPerTask":15,"completionBonus":40,"costPerTask":{"hunger":-1,"thirst":-1.8,"emotion":-0.4},"finish":{"emotion":9},"earlyLeave":{"emotion":-6},"promoShifts":3,"require":{"emotion":30},"dailyPay":130,"monthlyPay":2860},{"id":"job.market","name":"生鲜理货","zone":"shop3","desc":"冷柜搬货，渴得快，但收工早","shift":{"startHour":6,"endHour":20},"tasks":7,"taskSeconds":5,"taskLabels":["搬菜筐","挑拣","打码称重","摆堆头","清冷柜","补冰","扫地"],"payPerTask":12,"completionBonus":31,"costPerTask":{"hunger":-1.6,"thirst":-2.2,"emotion":-0.6},"finish":{"emotion":6},"earlyLeave":{"emotion":-7},"promoShifts":3,"require":{},"dailyPay":115,"monthlyPay":2530},{"id":"job.courier","name":"快递分拣","zone":"shop4","desc":"单件最贵，也最累：一趟下来又饿又渴","shift":{"startHour":8,"endHour":21},"tasks":7,"taskSeconds":4.5,"taskLabels":["扫码入库","分拣格口","装车","核对面单","贴标","清场"],"payPerTask":16,"completionBonus":38,"costPerTask":{"hunger":-1.8,"thirst":-2,"emotion":-0.7},"finish":{"emotion":5},"earlyLeave":{"emotion":-8},"promoShifts":3,"require":{"hunger":30},"dailyPay":150,"monthlyPay":3300},{"id":"job.coach","name":"篮球陪练","zone":"court","desc":"陪人打球，越打越开心，但要先有精神","shift":{"startHour":9,"endHour":21},"tasks":5,"taskSeconds":6,"taskLabels":["热身","传球练习","一对一","投篮训练","拉伸放松"],"payPerTask":22,"completionBonus":50,"costPerTask":{"hunger":-2,"thirst":-2.4,"emotion":1},"finish":{"emotion":12},"earlyLeave":{"emotion":-4},"promoShifts":2,"require":{"emotion":40},"dailyPay":160,"monthlyPay":3520},{"id":"job.gardener","name":"公园园丁","zone":"park","desc":"修剪花草，钱少但心情好","shift":{"startHour":7,"endHour":18},"tasks":6,"taskSeconds":5,"taskLabels":["浇水","修剪灌木","捡落叶","松土","换花坛","扫步道"],"payPerTask":11,"completionBonus":34,"costPerTask":{"hunger":-1.2,"thirst":-1.8,"emotion":0.8},"finish":{"emotion":10},"earlyLeave":{"emotion":-3},"promoShifts":2,"require":{},"dailyPay":100,"monthlyPay":2200},{"id":"job.teashop","name":"奶茶店店员","zone":"shop5","desc":"点单、摇茶、封口，站一天手不停","shift":{"startHour":10,"endHour":22},"tasks":6,"taskSeconds":4.5,"taskLabels":["点单","煮珍珠","摇茶","封口","擦台面","补杯子"],"payPerTask":14,"completionBonus":36,"costPerTask":{"hunger":-1.2,"thirst":-2,"emotion":-0.4},"finish":{"emotion":7},"earlyLeave":{"emotion":-6},"promoShifts":3,"require":{},"dailyPay":120,"monthlyPay":2640},{"id":"job.nurse","name":"社区护士","zone":"hospital","desc":"分诊、换药、量血压，要有耐心","shift":{"startHour":7,"endHour":19},"tasks":6,"taskSeconds":5.5,"taskLabels":["分诊登记","量血压","换药","整理病历","消毒器械","安抚病人"],"payPerTask":20,"completionBonus":50,"costPerTask":{"hunger":-1.4,"thirst":-1.8,"emotion":-1},"finish":{"emotion":10},"earlyLeave":{"emotion":-8},"promoShifts":3,"require":{"emotion":35},"dailyPay":170,"monthlyPay":3740},{"id":"job.teacher","name":"代课老师","zone":"school","desc":"带一节自习，讲题改作业，费嗓子","shift":{"startHour":8,"endHour":17},"tasks":5,"taskSeconds":6,"taskLabels":["点名","讲课","巡堂","改作业","答疑"],"payPerTask":25,"completionBonus":40,"costPerTask":{"hunger":-1.2,"thirst":-2.2,"emotion":-0.6},"finish":{"emotion":11},"earlyLeave":{"emotion":-6},"promoShifts":2,"require":{"emotion":45},"dailyPay":165,"monthlyPay":3630},{"id":"job.police","name":"辅警","zone":"police","desc":"24 小时值班：巡逻、登记、调解纠纷，夜里也有岗","shift":{"startHour":0,"endHour":24},"tasks":6,"taskSeconds":5.5,"taskLabels":["片警巡逻","登记来访","调解纠纷","查看监控","写值班记录","整理装备"],"payPerTask":22,"completionBonus":48,"costPerTask":{"hunger":-1.6,"thirst":-2,"emotion":-0.9},"finish":{"emotion":9},"earlyLeave":{"emotion":-9},"promoShifts":3,"require":{"emotion":50},"dailyPay":180,"monthlyPay":3960},{"id":"job.property","name":"物业客服","zone":"property","desc":"接报修、登记快递、催缴物业费","shift":{"startHour":9,"endHour":18},"tasks":6,"taskSeconds":5,"taskLabels":["接报修","登记快递","催缴物业费","巡楼","贴通知","回访"],"payPerTask":26,"completionBonus":44,"costPerTask":{"hunger":-1,"thirst":-1.8,"emotion":-0.7},"finish":{"emotion":7},"earlyLeave":{"emotion":-6},"promoShifts":3,"require":{},"dailyPay":200,"monthlyPay":4400}],"costNote":"costPerTask 是「每单带来的数值变化」，负数=消耗；finish / earlyLeave 同理","career":{"maxLevel":5,"payPerLevel":0.1,"shiftsPerLevel":3,"note":"熟练等级：每完成 shiftsPerLevel 个整班升一级（岗位可用 promoShifts 单独覆盖），最高 maxLevel 级；每级实发单价 +payPerLevel。15% 一级太陡（满级 +75%，等于干同样的活多拿四分之三），5% 又几乎看不出来；10% 折中：满级 +50%，需要 15 个班次（约 6 小时真实时间）。"}},"catalog/categories.json":{"schema":"catalog-categories/1","id":"categories.default","note":"物品分类表：商店分组、图标兜底、校验器都读这里。加新品类（食物/种子/宠物用品）= 加一条，不用改代码。iconPath 是 24×24 viewBox 下的 SVG path，用于没有专属图标时的兜底。","categories":[{"id":"furniture","label":"家具","order":1,"iconPath":"M4 12h16v6H4zM6 8h12v4H6z"},{"id":"appliance","label":"电器","order":2,"iconPath":"M5 4h14v16H5zM8 8h8v2H8z"},{"id":"decor","label":"装饰","order":3,"iconPath":"M12 3l2.5 5.5L20 11l-5.5 2.5L12 19l-2.5-5.5L4 11l5.5-2.5z"},{"id":"food","label":"食物","order":4,"reserved":true,"iconPath":"M6 3v8a3 3 0 006 0V3M9 11v10M16 3c-1.5 2-2 4-2 6h4c0-2-.5-4-2-6z"},{"id":"seed","label":"种子","order":5,"reserved":true,"iconPath":"M12 20c-4 0-7-3-7-7 0-4 3-8 7-10 4 2 7 6 7 10 0 4-3 7-7 7z"},{"id":"pet","label":"宠物用品","order":6,"reserved":true,"iconPath":"M8 8a2 2 0 100-4 2 2 0 000 4zm8 0a2 2 0 100-4 2 2 0 000 4zM12 20c-3 0-6-2-6-5 0-2 2-3 4-3h4c2 0 4 1 4 3 0 3-3 5-6 5z"}],"reservedFields":{"note":"未来可能给分类加的字段，引擎当前会忽略未知字段，可先写不报错","list":["iconPath","order","reserved","hiddenFromShop","stackable","maxStack"]}},"catalog/furniture.core.json":{"schema":"catalog/1","note":"核心家具：有交互数值效果的一批","items":[{"id":"bed","name":"床","category":"furniture","tags":["comfort"],"price":320,"footprint":{"w":2,"h":1},"cozy":6,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"sleep","durationSec":2,"effects":{"emotion":6},"special":"sleepToMorning"},"asset":{"kind":"svg","ref":"assets/furniture/bed.svg","size":{"w":128,"h":80},"anchor":{"ax":64,"ay":54}},"ui":{"icon":"bed","desc":"躺下休息，恢复情绪","order":0}},{"id":"sofa","name":"沙发","category":"furniture","tags":["comfort"],"price":260,"footprint":{"w":2,"h":1},"cozy":5,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":5},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/sofa.svg","size":{"w":128,"h":84},"anchor":{"ax":64,"ay":54}},"ui":{"icon":"sofa","desc":"坐下放松，恢复情绪","order":10}},{"id":"dining","name":"餐桌","category":"furniture","tags":["food"],"price":180,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"eat","durationSec":2,"effects":{"hunger":34},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/dining.svg","size":{"w":128,"h":70},"anchor":{"ax":64,"ay":44}},"ui":{"icon":"dining","desc":"吃饭，补充饥饿","order":20}},{"id":"fridge","name":"冰箱","category":"appliance","tags":["food","water","electric"],"price":460,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"snack","durationSec":2,"effects":{"hunger":20,"thirst":12},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/fridge.svg","size":{"w":64,"h":64},"anchor":{"ax":32,"ay":39}},"ui":{"icon":"fridge","desc":"取食，补充饥饿和口渴","order":30}},{"id":"stove","name":"灶台","category":"appliance","tags":["food","electric"],"price":520,"footprint":{"w":2,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"cook","durationSec":2,"effects":{"hunger":28},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/stove.svg","size":{"w":128,"h":70},"anchor":{"ax":64,"ay":44}},"ui":{"icon":"stove","desc":"做饭，大幅补充饥饿","order":40}},{"id":"sink","name":"水槽","category":"furniture","tags":["water"],"price":140,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":34},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/sink.svg","size":{"w":64,"h":62},"anchor":{"ax":32,"ay":36}},"ui":{"icon":"sink","desc":"喝水，补充口渴","order":50}},{"id":"tv","name":"电视","category":"appliance","tags":["comfort","electric"],"price":580,"footprint":{"w":2,"h":1},"cozy":5,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/tv.svg","size":{"w":128,"h":68},"anchor":{"ax":64,"ay":48}},"ui":{"icon":"tv","desc":"看电视，恢复情绪","order":60},"interactions":[{"verb":"watch","effects":{"emotion":7},"label":"看电视"},{"verb":"play","effects":{"emotion":4},"label":"玩一局游戏","requirements":{"statMin":{"emotion":20}},"failText":"心情太差，先歇会儿吧"}]},{"id":"stereo","name":"音响","category":"appliance","tags":["comfort","electric"],"price":300,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"music","durationSec":2,"effects":{"emotion":6},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/stereo.svg","size":{"w":64,"h":76},"anchor":{"ax":32,"ay":52}},"ui":{"icon":"stereo","desc":"听音乐，恢复情绪","order":70}},{"id":"bookshelf","name":"书柜","category":"furniture","tags":["comfort"],"price":200,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"read","durationSec":2,"effects":{"emotion":4},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/bookshelf.svg","size":{"w":64,"h":96},"anchor":{"ax":32,"ay":68}},"ui":{"icon":"bookshelf","desc":"看书，恢复情绪","order":80}},{"id":"plant","name":"绿植","category":"decor","tags":["decor"],"price":60,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"water","durationSec":2,"effects":{"emotion":2},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/plant.svg","size":{"w":64,"h":86},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"plant","desc":"浇花，心情愉悦","order":90}},{"id":"wardrobe","name":"衣柜","category":"furniture","tags":[],"price":230,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/wardrobe.svg","size":{"w":64,"h":98},"anchor":{"ax":32,"ay":70}},"ui":{"icon":"wardrobe","desc":"存放衣物","order":100}},{"id":"lamp","name":"台灯","category":"decor","tags":["decor"],"price":45,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/lamp.svg","size":{"w":64,"h":96},"anchor":{"ax":32,"ay":72}},"ui":{"icon":"lamp","desc":"照明装饰，夜里发光","order":110}},{"id":"toilet","name":"马桶","category":"furniture","tags":["comfort"],"price":120,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"wc","durationSec":2,"effects":{"emotion":3},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/toilet.svg","size":{"w":64,"h":66},"anchor":{"ax":32,"ay":44}},"ui":{"icon":"toilet","desc":"上厕所，舒畅","order":120}},{"id":"bathtub","name":"浴缸","category":"furniture","tags":["comfort"],"price":480,"footprint":{"w":2,"h":1},"cozy":6,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"bath","durationSec":2,"effects":{"emotion":9},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/bathtub.svg","size":{"w":128,"h":70},"anchor":{"ax":64,"ay":44}},"ui":{"icon":"bathtub","desc":"泡澡，放松身心","order":130}},{"id":"pc","name":"电脑","category":"appliance","tags":["comfort","electric"],"price":550,"footprint":{"w":1,"h":1},"cozy":5,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"net","durationSec":2,"effects":{"emotion":6},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/pc.svg","size":{"w":64,"h":72},"anchor":{"ax":32,"ay":52}},"ui":{"icon":"pc","desc":"上网冲浪，恢复情绪","order":140}}]},"catalog/home.goods.json":{"schema":"catalog/1","note":"室内家电/家具扩展包（24 件，落地式）","items":[{"id":"washer","name":"洗衣机","category":"appliance","tags":["electric","water"],"price":380,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/washer.svg","size":{"w":64,"h":97},"anchor":{"ax":32,"ay":72}},"ui":{"icon":"washer","desc":"洗衣服，焕然一新","order":200},"interaction":{"verb":"laundry","durationSec":2,"effects":{"emotion":5},"special":null}},{"id":"microwave","name":"微波炉","category":"appliance","tags":["electric","food"],"price":220,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/microwave.svg","size":{"w":64,"h":83},"anchor":{"ax":32,"ay":58}},"ui":{"icon":"microwave","desc":"快速加热，补充饥饿","order":201},"interaction":{"verb":"snack","durationSec":2,"effects":{"hunger":16},"special":null}},{"id":"oven","name":"烤箱","category":"appliance","tags":["electric","food"],"price":420,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/oven.svg","size":{"w":128,"h":125},"anchor":{"ax":64,"ay":84}},"ui":{"icon":"oven","desc":"烘焙烹饪，大幅补饥饿","order":202},"interaction":{"verb":"cook","durationSec":2,"effects":{"hunger":26},"special":null}},{"id":"dishwasher","name":"洗碗机","category":"appliance","tags":["electric","water"],"price":300,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/dishwasher.svg","size":{"w":64,"h":93},"anchor":{"ax":32,"ay":68}},"ui":{"icon":"dishwasher","desc":"自动洗碗，省心","order":203},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":3},"special":null}},{"id":"coffee","name":"咖啡机","category":"appliance","tags":["electric"],"price":240,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/coffee.svg","size":{"w":64,"h":87},"anchor":{"ax":32,"ay":62}},"ui":{"icon":"coffee","desc":"冲一杯咖啡，提神","order":204},"interaction":{"verb":"brew","durationSec":2,"effects":{"thirst":14,"emotion":3},"special":null}},{"id":"waterdisp","name":"饮水机","category":"appliance","tags":["electric","water"],"price":200,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/waterdisp.svg","size":{"w":64,"h":103},"anchor":{"ax":32,"ay":78}},"ui":{"icon":"waterdisp","desc":"冷热饮水，快速解渴","order":205},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":30},"special":null}},{"id":"ricecooker","name":"电饭煲","category":"appliance","tags":["electric","food"],"price":180,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/ricecooker.svg","size":{"w":64,"h":79},"anchor":{"ax":32,"ay":54}},"ui":{"icon":"ricecooker","desc":"焖饭煮粥，补充饥饿","order":206},"interaction":{"verb":"eat","durationSec":2,"effects":{"hunger":22},"special":null}},{"id":"aircon","name":"立式空调","category":"appliance","tags":["electric"],"price":520,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/aircon.svg","size":{"w":64,"h":111},"anchor":{"ax":32,"ay":86}},"ui":{"icon":"aircon","desc":"调节室温，舒适自在","order":207},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":4},"special":null}},{"id":"robotvac","name":"扫地机器人","category":"appliance","tags":["electric"],"price":280,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/robotvac.svg","size":{"w":64,"h":63},"anchor":{"ax":32,"ay":38}},"ui":{"icon":"robotvac","desc":"自动清扫，解放双手","order":208},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":2},"special":null}},{"id":"kettle","name":"电热水壶","category":"appliance","tags":["electric","water"],"price":120,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/kettle.svg","size":{"w":64,"h":81},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"kettle","desc":"烧水煮茶，补充口渴","order":209},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":18},"special":null}},{"id":"toaster","name":"烤面包机","category":"appliance","tags":["electric","food"],"price":150,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/toaster.svg","size":{"w":64,"h":77},"anchor":{"ax":32,"ay":52}},"ui":{"icon":"toaster","desc":"烤出香脆面包","order":210},"interaction":{"verb":"snack","durationSec":2,"effects":{"hunger":14},"special":null}},{"id":"desk","name":"书桌","category":"furniture","tags":["comfort"],"price":240,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/desk.svg","size":{"w":128,"h":123},"anchor":{"ax":64,"ay":82}},"ui":{"icon":"desk","desc":"看书工作，配电脑","order":211},"interaction":{"verb":"read","durationSec":2,"effects":{"emotion":5},"special":null}},{"id":"chair","name":"办公椅","category":"furniture","tags":["comfort"],"price":120,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/chair.svg","size":{"w":64,"h":85},"anchor":{"ax":32,"ay":60}},"ui":{"icon":"chair","desc":"坐下休息，配书桌","order":212},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":3},"special":null}},{"id":"coffeetable","name":"茶几","category":"furniture","tags":["comfort"],"price":140,"footprint":{"w":2,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/coffeetable.svg","size":{"w":128,"h":111},"anchor":{"ax":64,"ay":70}},"ui":{"icon":"coffeetable","desc":"沙发区小桌","order":213},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":2},"special":null}},{"id":"tvstand","name":"电视柜","category":"furniture","tags":[],"price":180,"footprint":{"w":2,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/tvstand.svg","size":{"w":128,"h":107},"anchor":{"ax":64,"ay":66}},"ui":{"icon":"tvstand","desc":"摆放电视，收纳杂物","order":214},"interaction":null},{"id":"nightstand","name":"床头柜","category":"furniture","tags":["comfort"],"price":100,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/nightstand.svg","size":{"w":64,"h":81},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"nightstand","desc":"床边小柜，随手置物","order":215},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":2},"special":null}},{"id":"vanity","name":"梳妆台","category":"furniture","tags":[],"price":260,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/vanity.svg","size":{"w":128,"h":111},"anchor":{"ax":64,"ay":70}},"ui":{"icon":"vanity","desc":"对镜梳妆，精致一天","order":216},"interaction":null},{"id":"shower","name":"淋浴间","category":"furniture","tags":["water","comfort"],"price":360,"footprint":{"w":2,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/shower.svg","size":{"w":128,"h":115},"anchor":{"ax":64,"ay":74}},"ui":{"icon":"shower","desc":"快速淋浴，清爽提神","order":217},"interaction":{"verb":"shower","durationSec":2,"effects":{"emotion":7},"special":null}},{"id":"washbasin","name":"洗手台","category":"furniture","tags":["water"],"price":160,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/washbasin.svg","size":{"w":64,"h":91},"anchor":{"ax":32,"ay":66}},"ui":{"icon":"washbasin","desc":"洗漱洗手，整理仪容","order":218},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":12},"special":null}},{"id":"shoecab","name":"鞋柜","category":"furniture","tags":[],"price":140,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/shoecab.svg","size":{"w":64,"h":95},"anchor":{"ax":32,"ay":70}},"ui":{"icon":"shoecab","desc":"收纳鞋子，玄关整洁","order":219},"interaction":null},{"id":"kitcab","name":"橱柜","category":"furniture","tags":[],"price":200,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/kitcab.svg","size":{"w":64,"h":109},"anchor":{"ax":32,"ay":84}},"ui":{"icon":"kitcab","desc":"厨房收纳，碗碟归位","order":220},"interaction":null},{"id":"mirror","name":"落地穿衣镜","category":"decor","tags":["decor"],"price":120,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/mirror.svg","size":{"w":64,"h":93},"anchor":{"ax":32,"ay":68}},"ui":{"icon":"mirror","desc":"整理穿搭，点亮房间","order":221},"interaction":null},{"id":"floorlamp","name":"落地灯","category":"decor","tags":["decor"],"price":150,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/floorlamp.svg","size":{"w":64,"h":111},"anchor":{"ax":32,"ay":86}},"ui":{"icon":"floorlamp","desc":"柔和照明，温馨氛围","order":222},"interaction":null},{"id":"gfclock","name":"落地座钟","category":"decor","tags":["decor"],"price":220,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/gfclock.svg","size":{"w":64,"h":111},"anchor":{"ax":32,"ay":86}},"ui":{"icon":"gfclock","desc":"滴答作响，典雅摆设","order":223},"interaction":null}]},"catalog/items.decor.json":{"schema":"catalog/1","note":"纯装修装饰：只贡献装修度，或提供可走/可贴墙等放置特性","items":[{"id":"rug_warm","name":"暖阳地毯","category":"decor","tags":["decor","walkable"],"price":150,"footprint":{"w":2,"h":2},"cozy":4,"placement":{"indoor":true,"walkable":true,"wallMounted":false,"blocksPath":false,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/rug_warm.svg","size":{"w":128,"h":64},"anchor":{"ax":64,"ay":32}},"ui":{"icon":"rug_warm","desc":"可踩的暖色地毯","order":150}},{"id":"rug_cool","name":"晴空地毯","category":"decor","tags":["decor","walkable"],"price":150,"footprint":{"w":2,"h":2},"cozy":4,"placement":{"indoor":true,"walkable":true,"wallMounted":false,"blocksPath":false,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/rug_cool.svg","size":{"w":128,"h":64},"anchor":{"ax":64,"ay":32}},"ui":{"icon":"rug_cool","desc":"可踩的冷色地毯","order":160}},{"id":"painting","name":"装饰画","category":"decor","tags":["decor"],"price":90,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/painting.svg","size":{"w":64,"h":82},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"painting","desc":"落地画架，点亮墙面","order":170}},{"id":"shelf","name":"置物架","category":"decor","tags":["decor"],"price":170,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/shelf.svg","size":{"w":64,"h":88},"anchor":{"ax":32,"ay":58}},"ui":{"icon":"shelf","desc":"摆书和绿植的小架子","order":180}}]},"characters/npcs.neighbors.json":{"schema":"characters/1","note":"小区 NPC：spawn 为街景初始格；home 指向 street.map 里的房屋 id dialogues 支持按场合（street/visit）+ 时段（morning/day/eve/night）+ rain 分池，first 只在初次见面时用一次。每个 NPC 的语气必须互不串味：老王短句、阿芳长句带感叹号、小杰带停顿、王婶爱劝人、老周爱打比方。","npcs":[{"id":"npc.n1","name":"老王","appearance":{"skin":"#e8a878","hair":"#7a7a7a","top":"#5fae62","bottom":"#3a3a4a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":0,"faceStyle":2,"acc":"band","age":"elder","sex":"m","facial":"stubble"},"spawn":{"x":10,"y":13},"home":"house.2栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["你是新搬来的吧。我姓王，二栋。"],"any":["嗯。","天不错。","这楼我住了二十年了。","上班去了？"],"morning":["这么早。菜市场刚开门。"],"day":["树下坐会儿，比屋里凉快。"],"eve":["下班的人都回来了。"],"night":["这么晚还不睡。"],"rain":["下雨天，膝盖先知道。"]},"visit":{"first":["进来吧，不用换鞋。"],"any":["随便坐。","水在桌上，自己倒。","电视响，我关小点。"]}}},{"id":"npc.n2","name":"阿芳","appearance":{"skin":"#f0b98e","hair":"#5a3a24","top":"#c94f6b","bottom":"#4a6b52","shoes":"#8a5a2b","face":"#3b3226","hairStyle":6,"faceStyle":0,"acc":"tote","age":"adult","sex":"f","earring":true},"spawn":{"x":38,"y":16},"home":"house.3栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["哎哟！新面孔啊，几栋的？"],"any":["吃了没啊？","你这衣服好看，哪儿买的？","小区门口那家又涨价了。"],"morning":["这么早出门，没吃早饭吧？我包了包子。"],"day":["太阳这么大，记得打伞。"],"eve":["晚上来我家坐坐呗，我炖了汤。"],"night":["这么晚才回来？路上小心啊。"],"rain":["带伞了没？没带我这有！"]},"visit":{"first":["快进来快进来，别站门口！"],"any":["坐坐坐，别客气。","我刚烤了饼干，尝尝。","你这孩子，来就来还带什么。"]}}},{"id":"npc.n3","name":"小杰","appearance":{"skin":"#f3c9a0","hair":"#c79a3a","top":"#8a6fc9","bottom":"#8a4a4a","shoes":"#f2ede2","face":"#3b3226","hairStyle":1,"faceStyle":1,"acc":"scarf","age":"teen","sex":"m","uniform":"delivery"},"spawn":{"x":14,"y":21},"home":"house.4栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["呃……你好。我四栋的。"],"any":["那个……我出来拿外卖。","昨晚打到三点，眼睛疼。"],"morning":["啊……现在几点了。"],"day":["太阳好晃眼，我回去了。"],"eve":["晚上网好，适合排位。"],"night":["这么晚……你也睡不着？"],"rain":["下雨啊……那点外卖吧。"]},"visit":{"first":["进来吧，有点乱……别笑我。"],"any":["那个……随便坐。","显示器攒了半年才买上。","先玩会儿？"]}},"spawnNote":"证券营业部占了原来 (16,21) 的位置，小杰挪到隔壁，仍在中区溜达"},{"id":"npc.n4","name":"王婶","appearance":{"skin":"#f0b98e","hair":"#8d8478","top":"#6fae6f","bottom":"#5d5a78","shoes":"#8a5a2b","face":"#3b3226","hairStyle":2,"faceStyle":0,"acc":"apron","age":"elder","sex":"f","uniform":"food"},"spawn":{"x":46,"y":21},"home":"house.5栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["你就是新来的吧？我五栋的，姓王。"],"any":["三楼那家又换人了。","你脸色不太好，早点睡。","别老点外卖，自己做点。"],"morning":["早晨空气好，多走走。"],"day":["晒被子了吗？今天太阳好。"],"eve":["晚上记得关好门窗。"],"night":["还不睡？年轻也不能这么熬。"],"rain":["下雨了，收衣服！"]},"visit":{"first":["来啦，快坐，我给你倒水。"],"any":["家里乱，别嫌弃。","我一个人住，清静。","你爸妈在老家吧？常打电话。"]}}},{"id":"npc.n5","name":"老周","appearance":{"skin":"#e8a878","hair":"#5a3a24","top":"#c8964a","bottom":"#3a3a4a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":3,"faceStyle":2,"acc":"cane","age":"elder","sex":"m","facial":"mustache"},"spawn":{"x":18,"y":41},"home":"house.6栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["新邻居？我六栋的，姓周。"],"any":["急不来的。","这几盆花，我浇了三年。","下棋不？石桌那边。"],"morning":["早上浇花，最舒坦。"],"day":["这日头，花喜欢。"],"eve":["太阳一落，虫就出来了。"],"night":["夜里的风，跟白天不一样。"],"rain":["下雨好，省得我浇水。"]},"visit":{"first":["进来，随便看看。"],"any":["花得放窗边才活得了。","坐，别急，慢慢说。","下一盘？我让你两个子。"]}}}],"clerks":[{"id":"clerk.shop1","name":"王小雨","zoneId":"shop1","hours":[0,24],"appearance":{"skin":"#f0c090","hair":"#2f2a26","top":"#e2703a","bottom":"#3f4a6a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":7,"faceStyle":1,"acc":"apron","age":"adult","sex":"f","uniform":"shop"},"lines":{"hello":["夜宵在第二排，热的。","这么晚还出来转？","关东煮刚上，要不要来一串。"],"tip":["货架上的饭团和关东煮点一下就能吃，比下馆子省事。","买食材包能带回家做，小包装贵一点但不用一次囤太多。"]}},{"id":"clerk.shop2","name":"阿哲","zoneId":"shop2","hours":[8,21],"appearance":{"skin":"#e8b088","hair":"#3c2f28","top":"#4a5a4a","bottom":"#2f3340","shoes":"#2b2b2b","face":"#3b3226","hairStyle":5,"faceStyle":0,"acc":"apron","age":"adult","sex":"m","uniform":"food"},"lines":{"hello":["……要喝什么。","坐着吧，不急。","今天豆子换了。"],"tip":["点柜台能点单；坐一会儿情绪会好些。","美式最提神，拿铁暖手——看你现在缺哪样。"]}},{"id":"clerk.shop3","name":"张婶","zoneId":"shop3","hours":[6,19],"appearance":{"skin":"#e8a878","hair":"#8a8078","top":"#c85a5a","bottom":"#4a4a5e","shoes":"#2b2b2b","face":"#3b3226","hairStyle":10,"faceStyle":2,"acc":"none","age":"elder","sex":"f","uniform":"food"},"lines":{"hello":["今早的青菜水灵！","来点啥？给你挑好的。","自己做饭才划算，别老吃外头。"],"tip":["买食材回家开火，比下馆子便宜一半还多。","当季的菜最便宜，一趟买够两三天的量。"]}},{"id":"clerk.shop4","name":"小陈","zoneId":"shop4","hours":[8,20],"appearance":{"skin":"#eab48c","hair":"#22201e","top":"#3f6fa8","bottom":"#33384a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":5,"faceStyle":1,"acc":"bag","age":"teen","sex":"m","uniform":"delivery"},"lines":{"hello":["稍等，这批件马上就分完。","包裹都在这儿，报房号就行。","一天跑三十趟，腿都不是自己的了。"],"tip":["分拣的活儿点门面就能接，一天三十来单。","包裹和寄件都在这儿，别在门口站着等。"]}},{"id":"clerk.shop5","name":"圆圆","zoneId":"shop5","hours":[10,22],"appearance":{"skin":"#f4c8a0","hair":"#5a3a2a","top":"#f2d06b","bottom":"#8a5a7a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":0,"faceStyle":1,"acc":"none","age":"teen","sex":"f","uniform":"shop","earring":true},"lines":{"hello":["三分糖还是五分？","今天第二杯半价——开玩笑的。","学生证没有优惠哦。"],"tip":["奶茶解渴、心情也会好点，但顶不住饿。","渴得厉害就要柠檬水，甜的反而不解渴。"]}},{"id":"clerk.shop_restaurant","name":"老张","zoneId":"shop_restaurant","hours":[10,22],"appearance":{"skin":"#e0a070","hair":"#8f8a82","top":"#e8e2d4","bottom":"#3a3a48","shoes":"#2b2b2b","face":"#3b3226","hairStyle":9,"faceStyle":2,"acc":"apron","age":"elder","sex":"m","uniform":"chef","facial":"mustache"},"lines":{"hello":["吃点什么？锅还热着。","一个人？里面随便坐。","今天的汤熬了两个钟头。"],"tip":["不用自己开火，就是比自己做饭贵点。"]}},{"id":"clerk.shop_super","name":"刘姐","zoneId":"shop_super","hours":[7,22],"appearance":{"skin":"#eeb890","hair":"#3a2e2a","top":"#5fae62","bottom":"#43485a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":1,"faceStyle":0,"acc":"none","age":"adult","sex":"f","uniform":"shop"},"lines":{"hello":["袋子要吗？","米面油都在最里头那排。","一次买够几天，省得来回跑。"],"tip":["日常吃用这儿最全，囤一点能省不少趟腿。"]}},{"id":"clerk.shop_bank","name":"周敏","zoneId":"shop_bank","hours":[9,17],"appearance":{"skin":"#f2c49c","hair":"#2a2422","top":"#2f3a55","bottom":"#2a2e3a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":2,"faceStyle":1,"acc":"bag","age":"adult","sex":"f","uniform":"office","earring":true},"lines":{"hello":["办什么业务？","利率牌在右边墙上。","定期没到期取出来会损失利息。"],"tip":["活期随时能取；定期锁 90 天，到期利息高得多。"]}},{"id":"clerk.shop_lottery","name":"老宋","zoneId":"shop_lottery","hours":[9,21],"appearance":{"skin":"#e8b088","hair":"#8a8a86","top":"#8a6a3a","bottom":"#3a3a4a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":3,"faceStyle":2,"acc":"none","age":"elder","sex":"m","facial":"stubble","uniform":"shop"},"lines":{"hello":["两块钱买个念想。","中了别忘了我。","概率这东西，写着呢。"],"tip":["中奖概率很低，当个乐子就行，别上头。"]}},{"id":"clerk.shop_stock","name":"方磊","zoneId":"shop_stock","hours":[9,15],"appearance":{"skin":"#e6ae84","hair":"#2a2622","top":"#4a5f75","bottom":"#2c303c","shoes":"#2b2b2b","face":"#3b3226","hairStyle":0,"faceStyle":1,"acc":"none","age":"adult","sex":"m","uniform":"office"},"lines":{"tip":["浮盈要卖掉才算钱；拿着的时候只是账面数字。"],"hello":["今天走势还行。","别追高，跌下来再买。","账面浮盈浮亏，别当现金。"]}},{"id":"clerk.shop_car","name":"小林","zoneId":"shop_car","hours":[9,18],"appearance":{"skin":"#f0c49c","hair":"#33291f","top":"#6b7488","bottom":"#33384a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":9,"faceStyle":1,"acc":"bag","age":"adult","sex":"m","uniform":"office"},"lines":{"hello":["看车？哪台都行，能试。","买了就能开，比走路快多了。","停车位就在楼下。"],"tip":["买了车点自己就能上车，开起来比走路快。"]}},{"id":"clerk.shop_pet","name":"阿May","zoneId":"shop_pet","hours":[9,20],"appearance":{"skin":"#f2c8a4","hair":"#402a20","top":"#c98aa0","bottom":"#4a4450","shoes":"#2b2b2b","face":"#3b3226","hairStyle":2,"faceStyle":1,"acc":"bag","age":"adult","sex":"f","earring":true,"uniform":"shop"},"lines":{"hello":["想养点什么？","先想清楚，养了就得管它。","猫粮狗粮在左边架子。"],"tip":["先把粮备好再接它回家，不然它会饿。"]}},{"id":"clerk.hospital","name":"小何","zoneId":"hospital","hours":[8,20],"appearance":{"skin":"#f4ccaa","hair":"#241f1c","top":"#f2f4f6","bottom":"#4a5568","shoes":"#2b2b2b","face":"#3b3226","hairStyle":6,"faceStyle":0,"acc":"scarf","age":"adult","sex":"f","uniform":"medical"},"lines":{"hello":["哪里不舒服？","别硬扛，坐下说。","最近降温，多穿点。"],"tip":["累到没状态就来看一趟，能缓过来。"]}},{"id":"clerk.police","name":"老赵","zoneId":"police","hours":[0,24],"appearance":{"skin":"#e2a878","hair":"#7e7a74","top":"#2f3a55","bottom":"#2a2e3a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":1,"faceStyle":2,"acc":"bag","age":"elder","sex":"m","uniform":"uniform","facial":"stubble"},"lines":{"hello":["有事说事。","门别忘锁。","这小区挺太平的。"],"tip":["丢了东西来这儿问一声，多半有人捡到送来。"]}},{"id":"clerk.property","name":"孙姐","zoneId":"property","hours":[9,18],"appearance":{"skin":"#eeb08a","hair":"#3a2e28","top":"#5a7a9a","bottom":"#3f4450","shoes":"#2b2b2b","face":"#3b3226","hairStyle":7,"faceStyle":1,"acc":"tote","age":"adult","sex":"f","uniform":"office"},"lines":{"hello":["交费在窗口。","电梯又坏了？我记一下。","房租水电按时交，省得催。"],"tip":["账单会自动扣，余额不够就会欠费，留意着点。"]}},{"id":"clerk.school","name":"老马","zoneId":"school","hours":[7,17],"appearance":{"skin":"#dfa074","hair":"#8a8a8a","top":"#4a5a4a","bottom":"#3a3a48","shoes":"#2b2b2b","face":"#3b3226","hairStyle":3,"faceStyle":2,"acc":"band","age":"elder","sex":"m","uniform":"uniform","facial":"beard"},"lines":{"hello":["接孩子？还没放学。","上课呢，别在门口站着。","铃一响就都跑出来了。"],"tip":["放学那阵子最热闹，路口车也多。"]}}],"clerksNote":"店员：站在自己门口，按 hours（24 小时制，含头不含尾）上下班。lines.hello 是打招呼，lines.tip 是\"这家店怎么用\"，新手不知道柜台能点的时候，问一句话比翻说明快。 便利店 24 小时（[0,24]），深夜也有人。 便利店 24 小时（[0,24]），深夜也有人。","accNote":"appearance.acc 是剪影配饰：apron 围裙 / band 发带 / bag 挎包 / tote 手提袋 / scarf 围巾 / cane 拐杖。可省略（等于 none）。颜色已经有区分时，配饰负责\"远看也能分出是谁\"——美术规范里要求每个角色一条颜色线索 + 一条剪影线索。","profNote":"appearance 的三层识别：age（kid/teen/adult/elder，改头身比与眼睛大小）、sex（f/m/x，改肩宽与睫毛）、uniform（food/office/medical/uniform/delivery，画制服层）。acc 是剪影配饰，和 uniform 叠加使用：制服管\"是干什么的\"，配饰管\"是谁\"。","hairNote":"hairStyle 0~10：短发 / 中发 / 长发 / 卷发 / 双马尾 / 短刺 / 丸子头 / 齐耳短发 / 高马尾 / 短寸 / 麻花辫。0~5 的刘海在上方，6~10 各自有独立的剪影。","faceNote":"facial：胡茬 stubble / 小胡子 mustache / 络腮 beard（都不碰眼鼻）；earring：耳垂下一颗小金属点。这两样比再加发型更容易\"一眼认出是谁\"。"},"characters/palettes.json":{"schema":"characters/1","slots":{"skin":{"label":"肤色","values":["#f3c9a0","#f0b98e","#e8a878","#d18a5f","#b96f43","#8d4f2b"]},"hair":{"label":"发色","values":["#2b2b2b","#5a3a24","#8a5a2b","#c79a3a","#d95f5f","#7a7a7a","#e0d8c8"]},"top":{"label":"上衣","values":["#4f8ac9","#c94f6b","#5fae62","#c8964a","#8a6fc9","#e0b84f","#f2ede2","#2b4a6b"]},"bottom":{"label":"下装","values":["#5d5a78","#4a6b52","#8a4a4a","#3a3a4a","#6b5a3a","#2b2b2b"]},"shoes":{"label":"鞋子","values":["#8a5a2b","#2b2b2b","#f2ede2","#c0392b","#4a6b8a"]},"face":{"label":"五官","values":["#3b3226","#2b2b2b","#5a3a24"]}},"hairStyles":[{"index":0,"name":"短发"},{"index":1,"name":"中发"},{"index":2,"name":"长发"},{"index":3,"name":"卷发"}],"faceStyles":[{"index":0,"name":"微笑"},{"index":1,"name":"开心"},{"index":2,"name":"平静"},{"index":3,"name":"惊讶"}]},"characters/player.default.json":{"schema":"characters/1","id":"player.default","person":{"name":"我的屋主","gender":"女","role":"自由职业","marital":"单身","address":"幸福小区 · 1栋 101"},"appearance":{"skin":"#f3c9a0","hair":"#5a3a24","top":"#4f8ac9","bottom":"#5d5a78","shoes":"#8a5a2b","face":"#3b3226","hairStyle":0,"faceStyle":0}},"environment/ambient.json":{"schema":"environment/1","note":"随机物与生长：全部由种子确定性生成，不入存档（否则每加一棵草都要写库）。玩家亲手种/浇的东西例外，存进存档的 planted[]。 daily = 每天一条的小区广播。","scatter":{"note":"按格子哈希决定是否生成，同一 seed + 同一格永远得到同一个结果 → 换设备/串门看到的是同一片草地","densityPer100":{"flower":6,"grass":12,"stone":3,"mushroom":2},"zones":{"yard":{"kinds":["flower","grass","stone"],"excludeNearHouse":1},"street":{"kinds":["grass","stone"],"excludeRoads":true}}},"growth":{"note":"装饰物生长阶段由「种下时间 + 当前时间」推导，不写状态机","stages":[{"id":"seed","afterMinutes":0,"scale":0.45},{"id":"sprout","afterMinutes":720,"scale":0.7},{"id":"bloom","afterMinutes":2160,"scale":1}],"waterBonusMinutes":240},"traffic":{"note":"车流：位置 = f(当前秒, 车道, 车号)，不需要服务端广播，也不需要存档。speedPerMinute 是游戏分钟口径（很慢，只用于逻辑推演），实际观感用 speedPerSecond。 types 是车型表：weight 是相对权重，where=arterial 只跑主干道（中央大道/南环路），speedMul 是相对速度。 nearZones 让车型按路段加权：靠近哪类设施，那类车就多。","speedPerMinute":0.08,"speedPerSecond":2.4,"carsPerLane":3,"kinds":[],"light":{"note":"红绿灯：两个相位交替（横绿/纵绿），周期秒数由它决定；车辆在红灯前 0.6 格停车，行人站在斑马线上时两侧都停。","cycleSec":16},"types":[{"id":"car.sedan","label":"私家车","weight":34,"where":"any","speedMul":1,"colors":["#c8553d","#4a6fa8","#8b8b8b","#5e7a52","#b08a5a"],"note":"街上最多的那种。随机配色，跟 4S 店卖的车区分开（那是玩家自己的车）"},{"id":"car.taxi","label":"网约车","weight":12,"where":"any","speedMul":1.05,"color":"#2f6f5a","roofColor":"#f2ede2","beacon":"#e8d47a","note":"绿牌网约车，车顶小灯常亮（不闪，跟警灯区分）","nearZones":{"plaza":2,"shop_car":1}},{"id":"car.van","label":"快递车","weight":12,"where":"any","speedMul":0.92,"color":"#f2efe8","roofColor":"#dcd6c8","len":1.25,"wid":1.06,"boxy":true,"note":"方厢小货车，跑得比轿车慢一点；快递站在东商业街，送货车满街都是才合理","nearZones":{"shop4":2,"shop_super":1.5,"shop3":1.5},"nearNote":"靠近快递站/超市/菜市场的路段，快递车权重 ×3——送货车应该聚在要送货的地方，而不是均匀撒满全图"},{"id":"car.bus","label":"公交车","weight":9,"where":"arterial","speedMul":0.8,"color":"#3f6fa8","roofColor":"#e9eef3","len":1.75,"wid":1.08,"stripe":"#f2f6fa","note":"只跑中央大道和南环路这两条主干道。车长是轿车 1.75 倍——再长路口就拐不过弯了"},{"id":"car.police","label":"警车","weight":4,"where":"any","speedMul":1.15,"color":"#f4f4f2","roofColor":"#2a3a55","stripe":"#2a3a55","beacon":"#3a6ee8","flash":true,"note":"白底蓝条，车顶蓝灯闪。比普通车快一点，但不快过救护车","nearZones":{"police":2}},{"id":"car.ambulance","label":"救护车","weight":4,"where":"any","speedMul":1.3,"color":"#f6f4f0","roofColor":"#e4e0d8","stripe":"#c0392b","beacon":"#e0453a","flash":true,"note":"白底红条，车顶红灯闪，全场最快——社区医院就在小区里，救护车该跑得急","nearZones":{"hospital":2}},{"id":"car.sanitation","label":"环卫车","weight":4,"where":"any","speedMul":0.72,"color":"#6d8a5f","roofColor":"#5a7350","len":1.3,"wid":1.1,"boxy":true,"note":"慢吞吞的扫地车，给街道一点层次，不然满街都是一种车"},{"id":"bike","label":"电动车","weight":11,"where":"any","speedMul":0.85,"note":"外卖/通勤电动车，原来就有"}]},"daily":{"note":"每天一条小区广播：按游戏日做稳定散列挑一句，同一天读档重进还是同一句（和股票行情一个道理，不存盘）。when=any 是无条件池，when=rain 只在雨天参与。写的时候按街坊会说的话来，不要写成系统提示。","lines":[{"when":"any","text":"三号楼电梯检修，今天走楼梯吧。"},{"when":"any","text":"周六上午广场有旧物交换，带点东西去。"},{"when":"any","text":"物业提醒：楼道别堆杂物，消防通道要留着。"},{"when":"any","text":"门口早餐铺出摊了，豆浆两块一碗。"},{"when":"any","text":"有人丢了一只黄猫，见着了招呼一声。"},{"when":"any","text":"广场的象棋摊又支起来了，下午最热闹。"},{"when":"any","text":"快递柜满了，记得早点去取。"},{"when":"any","text":"楼下小孩在学骑车，路过慢一点。"},{"when":"any","text":"花坛的月季开了一丛，路过能闻见。"},{"when":"any","text":"今晚广场放露天电影，八点开场。"},{"when":"any","text":"小区群里在团鸡蛋，一板十五，明天到。"},{"when":"any","text":"收废品的老陈今天在西门，纸箱别扔。"},{"when":"rain","text":"下雨了，晾在外面的被子收一下。"},{"when":"rain","text":"地下车库返潮，走的时候小心打滑。"},{"when":"rain","text":"雨不小，路上那几个水洼别踩。"}]}},"environment/climate.json":{"schema":"environment/1","note":"环境=天气与光照。天气序列由种子+时间确定性推导，不落库存状态；只有玩家主动改变的东西才进存档。","seedRule":"worldSeed = hash(userId)（每人家自己的一套天气）；若要全服同步，改读 server 的 world_state","slotMinutes":180,"transitionMinutes":25,"weathers":[{"id":"clear","label":"晴","weight":52,"light":1,"emotionPerHour":0,"particles":null,"tempDelta":0},{"id":"cloudy","label":"多云","weight":24,"light":0.88,"emotionPerHour":0,"particles":null,"tempDelta":-1},{"id":"rain","label":"小雨","weight":16,"light":0.72,"emotionPerHour":-0.6,"particles":"rain","tempDelta":-3},{"id":"storm","label":"雷雨","weight":5,"light":0.55,"emotionPerHour":-1.2,"particles":"rain","tempDelta":-4},{"id":"snow","label":"雪","weight":3,"light":0.8,"emotionPerHour":0.4,"particles":"snow","tempDelta":-6}],"daytimes":[{"id":"dawn","fromHour":5,"toHour":7,"ambient":"rgba(255,205,150,.12)"},{"id":"morning","fromHour":7,"toHour":11,"ambient":"rgba(255,240,200,.05)"},{"id":"noon","fromHour":11,"toHour":15,"ambient":"rgba(255,255,255,.03)"},{"id":"dusk","fromHour":15,"toHour":19,"ambient":"rgba(255,170,110,.14)"},{"id":"night","fromHour":19,"toHour":5,"ambient":"rgba(24,34,74,.30)"}],"scope":"local","scopeNote":"local=每人家各自天气（离线可玩）；global=全服同一场雨（需服务端 world_state 下发 seed）","daylight":{"note":"一天中的光照关键帧（按小时线性插值）。改这里就能调整任意时刻的明暗与色温，不需要改代码。","keys":[{"hour":0,"label":"深夜","light":0.06,"tint":[16,24,58,0.44]},{"hour":4.5,"label":"凌晨","light":0.1,"tint":[24,34,72,0.38]},{"hour":5.5,"label":"黎明","light":0.3,"tint":[255,190,130,0.2]},{"hour":6.5,"label":"日出","light":0.55,"tint":[255,215,170,0.14]},{"hour":7.5,"label":"清晨","light":0.74,"tint":[255,238,210,0.08]},{"hour":9,"label":"上午","light":0.9,"tint":[255,250,242,0.03]},{"hour":12,"label":"正午","light":1,"tint":[255,255,255,0]},{"hour":14.5,"label":"午后","light":0.95,"tint":[255,250,236,0.04]},{"hour":16.5,"label":"傍晚","light":0.82,"tint":[255,214,160,0.1]},{"hour":18,"label":"黄昏","light":0.55,"tint":[255,160,96,0.2]},{"hour":19.5,"label":"入夜","light":0.26,"tint":[120,96,150,0.28]},{"hour":21,"label":"夜晚","light":0.11,"tint":[24,34,74,0.4]},{"hour":24,"label":"深夜","light":0.06,"tint":[16,24,58,0.44]}]}},"environment/seasons.json":{"schema":"seasons/1","id":"seasons.default","note":"四季配置。只影响视觉与天气倾向，不改玩法数值（要改玩法请放 rules/）。季节由日期推导：game 模式按游戏天数轮转，realtime 模式按北京时间所在月份。","mode":"byMonth","noteMode":"byMonth=按月份（12-2 冬 / 3-5 春 / 6-8 夏 / 9-11 秋）；byDayCount=按游戏天数平均轮转","seasons":[{"id":"spring","label":"春","months":[3,4,5],"order":1,"grass":["#a6d48d","#97c77c"],"treeCanopy":["#8ac47a","#a7d897"],"bush":["#6fb35c","#8ac47a"],"trunk":"#8a5a2b","flowerStem":"#7cb342","tintShift":[6,10,2],"lightScale":1,"snowCover":0,"weatherBias":{"clear":1.15,"cloudy":1,"rain":1.1,"storm":0.9,"snow":0},"desc":"嫩绿、花开，一年里光线最柔和的一季","tempBase":18,"tempSwing":8},{"id":"summer","label":"夏","months":[6,7,8],"order":2,"grass":["#84bb63","#77ac57"],"treeCanopy":["#5f9e52","#79b968"],"bush":["#4f9146","#6aa85c"],"trunk":"#7d5226","flowerStem":"#6aa63a","tintShift":[10,4,-6],"lightScale":1.05,"snowCover":0,"weatherBias":{"clear":1.35,"cloudy":0.85,"rain":0.9,"storm":1.2,"snow":0},"desc":"饱和的浓绿，正午最亮","tempBase":28,"tempSwing":6},{"id":"autumn","label":"秋","months":[9,10,11],"order":3,"grass":["#c6bd78","#b8ae66"],"treeCanopy":["#d99a3f","#c47a2e"],"bush":["#b0893f","#c9a050"],"trunk":"#7a4e28","flowerStem":"#a89040","tintShift":[18,6,-10],"lightScale":0.96,"snowCover":0,"weatherBias":{"clear":1.2,"cloudy":1.1,"rain":1,"storm":0.8,"snow":0.1},"desc":"金黄与赭色，光线偏暖、影子变长","tempBase":14,"tempSwing":9},{"id":"winter","label":"冬","months":[12,1,2],"order":4,"grass":["#c3cdc0","#b4bfb1"],"treeCanopy":["#8a9a86","#9aa694"],"bush":["#7f8d7c","#93a08f"],"trunk":"#6b4a2c","flowerStem":"#8a9082","tintShift":[-6,0,12],"lightScale":0.9,"snowCover":0.55,"weatherBias":{"clear":1,"cloudy":1.3,"rain":0.5,"storm":0.5,"snow":2.4},"desc":"灰绿与冷白，天亮得晚、天黑得早","tempBase":2,"tempSwing":10}],"reservedFields":{"note":"以下字段已留位，引擎当前忽略，将来接入时不用改 schema","list":["snowCover","weatherBias","lightScale","tintShift","ambientSound","growSpeed"]},"tempNote":"tempBase=季节基准气温，tempSwing=昼夜温差幅度；实际温度 = base + swing×(光照-0.5) + 天气修正 + 每日随机波动"},"house/levels.json":{"schema":"house/1","note":"房型等级：升级只扩大室内区块，左上角固定；地面分区（无实墙），每区内联地板配色，空间完全可走 房型分两类：apartment（公寓楼里的一套）和 villa（公寓楼外面的独栋）。别墅户型更大更开放，房间数和分区都不同；两类互不升级，住哪种才能用哪种的户型。 别墅是精装交付：买下来就带着整套家具家电和墙面配色，拎包入住。","origin":{"x":3,"y":3},"yardMargin":3,"levels":[{"level":0,"id":"house.lv0","name":"温馨一居","price":0,"footprint":{"w":14,"h":10},"zones":[{"id":"bedroom","name":"卧室","rect":{"x":0,"y":0,"w":14,"h":4},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":4,"w":9,"h":6},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"bath","name":"卫生间","rect":{"x":9,"y":4,"w":5,"h":3},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":9,"y":7,"w":5,"h":3},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":1,"id":"house.lv1","name":"两室一厅","price":2000,"footprint":{"w":17,"h":12},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":9,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":9,"y":0,"w":8,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":5,"w":8,"h":7},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":8,"y":5,"w":4,"h":7},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"bath","name":"卫生间","rect":{"x":12,"y":5,"w":5,"h":3},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":12,"y":8,"w":5,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":2,"id":"house.lv2","name":"三室两厅","price":6000,"footprint":{"w":20,"h":14},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":9,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":9,"y":0,"w":5,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed3","name":"次卧","rect":{"x":14,"y":0,"w":6,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":6,"w":9,"h":8},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":9,"y":6,"w":5,"h":8},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"bath","name":"卫生间","rect":{"x":14,"y":6,"w":6,"h":4},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":14,"y":10,"w":6,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":3,"id":"house.lv3","name":"四室两厅","price":15000,"footprint":{"w":23,"h":16},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":8,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":8,"y":0,"w":5,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed3","name":"次卧","rect":{"x":13,"y":0,"w":5,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":18,"y":0,"w":5,"h":7},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":7,"w":9,"h":9},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":9,"y":7,"w":5,"h":9},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"bath1","name":"卫生间","rect":{"x":14,"y":7,"w":4,"h":5},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"bath2","name":"卫生间","rect":{"x":18,"y":7,"w":5,"h":5},"floor":{"pattern":"tile","palette":{"a":"#d6e8e0","b":"#c2d8ce","line":"rgba(90,125,110,.24)","grout":"rgba(120,155,140,.32)"}}},{"id":"kitchen","name":"厨房","rect":{"x":14,"y":12,"w":9,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":4,"id":"house.lv4","name":"大平层","price":32000,"footprint":{"w":27,"h":18},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":10,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"mbath","name":"主卫","rect":{"x":10,"y":0,"w":5,"h":7},"floor":{"pattern":"tile","palette":{"a":"#d6e8e0","b":"#c2d8ce","line":"rgba(90,125,110,.24)","grout":"rgba(120,155,140,.32)"}}},{"id":"closet","name":"衣帽间","rect":{"x":15,"y":0,"w":4,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}},{"id":"bed2","name":"次卧","rect":{"x":19,"y":0,"w":8,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed3","name":"次卧","rect":{"x":0,"y":7,"w":8,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":8,"y":7,"w":7,"h":5},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"guestbath","name":"客卫","rect":{"x":15,"y":7,"w":5,"h":5},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":20,"y":7,"w":7,"h":5},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":12,"w":13,"h":6},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":13,"y":12,"w":7,"h":6},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"storage","name":"储物间","rect":{"x":20,"y":12,"w":7,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"id":"house.villa.garden","name":"花园小墅","type":"villa","price":38000,"footprint":{"w":20,"h":14},"door":{"edge":"bottom","offset":"center"},"walls":[],"note":"独栋入门款：三间卧室横排在北侧，南面是一整片 12 格宽的客厅，尽头接厨房与卫浴。","zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":8,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":8,"y":0,"w":5,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"closet","name":"衣帽间","rect":{"x":13,"y":0,"w":7,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":5,"w":12,"h":9},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"kitchen","name":"厨房","rect":{"x":12,"y":5,"w":8,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"bath","name":"卫浴","rect":{"x":12,"y":9,"w":8,"h":5},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}}],"furnish":{"wallStyle":2,"wallName":"暮霭蓝","note":"精装交付：三间卧室、客厅、厨房、卫浴全部配齐，含床品、衣柜、整套厨电与洗浴。","items":[["bed",1,1],["wardrobe",5,0],["nightstand",3,1],["vanity",4,3],["bed",9,1],["wardrobe",8,1],["desk",9,3],["wardrobe",14,1],["shoecab",16,1],["mirror",18,1],["shelf",14,3],["sofa",1,6],["coffeetable",1,8],["tv",1,10],["rug_cool",4,7],["floorlamp",0,6],["painting",0,12],["aircon",10,6],["gfclock",10,12],["fridge",13,6],["stove",15,6],["kitcab",18,6],["microwave",15,8],["oven",18,8],["bathtub",13,10],["toilet",17,10],["washbasin",13,12],["washer",17,12]]},"furnished":true},{"id":"house.villa.court","name":"中庭别墅","type":"villa","price":68000,"footprint":{"w":24,"h":16},"door":{"edge":"bottom","offset":"center"},"walls":[],"note":"客厅居中、四周环绕房间。进门一眼看到整个家，厨房餐厅在南侧一整排。","zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":12,"h":4},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":12,"y":0,"w":12,"h":4},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":0,"y":4,"w":4,"h":8},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"living","name":"中庭客厅","rect":{"x":4,"y":4,"w":16,"h":8},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"closet","name":"衣帽间","rect":{"x":20,"y":4,"w":4,"h":8},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}},{"id":"kitchen","name":"厨房","rect":{"x":0,"y":12,"w":12,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"dining","name":"餐厅","rect":{"x":12,"y":12,"w":12,"h":4},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}}],"furnish":{"wallStyle":1,"wallName":"抹茶绿","note":"精装交付：中庭客厅一套完整起居家具，两翼书房与衣帽间各自成套，厨房餐厅南北贯通。","items":[["bed",1,1],["wardrobe",6,0],["nightstand",3,1],["vanity",8,1],["bed",13,1],["wardrobe",18,1],["desk",20,1],["pc",1,5],["desk",0,7],["bookshelf",0,9],["chair",2,5],["sofa",6,5],["coffeetable",6,7],["tv",6,9],["rug_cool",10,6],["floorlamp",4,5],["painting",4,11],["aircon",18,5],["gfclock",18,10],["wardrobe",21,5],["shoecab",21,7],["mirror",21,9],["shelf",22,5],["fridge",1,13],["stove",3,13],["kitcab",6,13],["oven",8,13],["microwave",1,15],["dining",14,13],["chair",16,13],["chair",17,13]]},"furnished":true},{"id":"house.villa.loft","name":"横厅独栋","type":"villa","price":90000,"footprint":{"w":26,"h":16},"door":{"edge":"bottom","offset":"center"},"walls":[],"note":"北侧一整面 26 格宽的横厅，进门就是全屋最长的视野；南侧分成主卧、书房+卫浴、厨房餐厅三段。","zones":[{"id":"living","name":"横厅","rect":{"x":0,"y":0,"w":26,"h":8},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"master","name":"主卧","rect":{"x":0,"y":8,"w":10,"h":8},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":10,"y":8,"w":8,"h":4},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"bath2","name":"卫浴","rect":{"x":10,"y":12,"w":8,"h":4},"floor":{"pattern":"tile","palette":{"a":"#d6e8e0","b":"#c2d8ce","line":"rgba(90,125,110,.24)","grout":"rgba(120,155,140,.32)"}}},{"id":"kitchen","name":"厨房","rect":{"x":18,"y":8,"w":8,"h":5},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"dining","name":"餐厅","rect":{"x":18,"y":13,"w":8,"h":3},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}}],"furnish":{"wallStyle":3,"wallName":"蔷薇粉","note":"精装交付：横厅双沙发对坐，南侧三段各成一间，书房卫浴厨房餐厅全是成套的。","items":[["sofa",2,1],["sofa",6,1],["coffeetable",2,3],["tv",2,5],["rug_warm",6,3],["floorlamp",0,1],["painting",0,6],["aircon",12,1],["gfclock",23,1],["plant",23,6],["plant",0,7],["bed",1,9],["wardrobe",5,9],["nightstand",3,9],["vanity",6,12],["pc",11,9],["desk",10,10],["bookshelf",13,9],["chair",12,9],["bathtub",11,13],["toilet",14,13],["washbasin",16,13],["washer",11,15],["fridge",19,9],["stove",21,9],["kitcab",24,9],["oven",19,11],["dining",20,14],["chair",22,14],["chair",23,14]]},"furnished":true}]},"house/residence.json":{"schema":"residence/1","id":"residence.default","community":"幸福小区","note":"住址体系：独栋（villa）地址就是楼号；公寓（apartment）是「楼栋 + 楼层 + 房号」，1803 = 18 层 03 号。玩家的住址在首次建档时按 uid 散列分配，之后随存档走，不再变化。 独栋（villa）12-16 栋是可购买的别墅：每栋按楼号散列绑定一个别墅户型，所以同样一栋楼在谁的机器上都是同一种布局。","buildings":[{"id":"house.公寓楼","kind":"apartment","label":"公寓楼","floors":18,"unitsPerFloor":4},{"id":"house.12栋","kind":"villa","label":"12栋"},{"id":"house.13栋","kind":"villa","label":"13栋"},{"id":"house.14栋","kind":"villa","label":"14栋"},{"id":"house.15栋","kind":"villa","label":"15栋"},{"id":"house.16栋","kind":"villa","label":"16栋"}],"assign":{"defaultKind":"apartment","floorMin":3,"floorMax":18,"roomMin":1},"units":{"note":"房态：没人住的房间按 (楼栋,楼层,房号) 做稳定散列决定状态——同一间在任何人、任何次打开都算出同一个结果，服务端不必为 72 间空房各存一行。有人住时以服务端住户列表为准（名字优先）。","states":{"sale":{"label":"待售","desc":"业主挂牌出售，买下即落户"},"rent":{"label":"待租","desc":"房东出租，押一付一"},"vacant":{"label":"空置","desc":"暂不对外，可能是业主自住未上线"}},"salePercent":22,"rentPercent":18,"sale":{"base":12000,"perFloor":800,"roundTo":100},"rent":{"base":460,"perFloor":30,"roundTo":10,"depositMonths":1},"maxPerUser":3,"resaleRatio":0.7,"fitoutRatio":0.65,"appreciate":{"perYear":0.05,"yearDays":365,"note":"不动产每年增值 5%（复利）。买卖同价，卖出仍按 resaleRatio 打 7 折——所以短期倒手必亏，要涨 43%（约 7.5 年）才够回本，长期持有才是投资。租金不跟随增值，避免租客被通胀压死。"},"estatesNote":"每人最多持有 3 套房（含自住）；初始那间算 1 套。自有房可卖出回收 70%，租住房退租不退押金。屋里有家具时可选择「带装修卖」：家具按 fitoutRatio 折现一并结算、家具归买家（比在仓库零卖 50% 划算，但拿不回实物）；选「空房卖」则家具全退回仓库。"}},"house/styles.json":{"schema":"styles/1","floors":[{"id":"floor.0","index":0,"name":"原木地板","price":0,"palette":{"a":"#ecd9b0","b":"#e2cb98","line":"rgba(140,100,55,.16)","grout":"rgba(255,255,255,.22)"},"pattern":"plank"},{"id":"floor.1","index":1,"name":"灰白瓷砖","price":260,"palette":{"a":"#f3eee4","b":"#e1d9c9","line":"rgba(110,105,95,.22)","grout":"rgba(148,138,120,.32)"},"pattern":"tile"},{"id":"floor.2","index":2,"name":"暖绒地毯","price":520,"palette":{"a":"#e7c9b2","b":"#dfbda3","line":"rgba(150,100,70,.12)","grout":"rgba(255,240,225,.20)"},"pattern":"carpet"},{"id":"floor.3","index":3,"name":"深色木纹","price":760,"palette":{"a":"#c9a06c","b":"#bd9260","line":"rgba(88,58,28,.22)","grout":"rgba(255,235,200,.14)"},"pattern":"plank"}],"walls":[{"id":"wall.0","index":0,"name":"米白墙面","price":0,"palette":{"top":"#e7d3ae","right":"#d3b98d","left":"#c7ab7f","trim":"#b1926a","border":"rgba(122,82,48,.25)"}},{"id":"wall.1","index":1,"name":"抹茶绿墙","price":180,"palette":{"top":"#dfe5cc","right":"#c2cbac","left":"#b4bd9c","trim":"#8d9c74","border":"rgba(80,95,55,.28)"}},{"id":"wall.2","index":2,"name":"暮霭蓝墙","price":180,"palette":{"top":"#cfdce7","right":"#b0c0cf","left":"#a1b3c3","trim":"#7f95a9","border":"rgba(55,80,105,.26)"}},{"id":"wall.3","index":3,"name":"蔷薇粉墙","price":220,"palette":{"top":"#f1dcd8","right":"#e0bfbb","left":"#d4b1ad","trim":"#bd9894","border":"rgba(120,70,70,.24)"}}]},"interaction/verbs.json":{"schema":"verbs/1","id":"verbs.default","note":"交互动词注册表：家具通过 interaction.verb 引用这里的条目，引擎不再写死任何 action。新增普通交互（只改数值）= 只加一条，代码零改动；带特殊流程的交互用 hook，hook 名需在引擎 VERB_HOOKS 里注册。","verbs":{"sleep":{"label":"睡觉","durationSec":2,"sfx":"sleep","hook":"sleepToMorning","desc":"夜间入睡会直接到次日 7:00，并按装修度给情绪加成"},"rest":{"label":"休息","durationSec":2,"sfx":"ok"},"eat":{"label":"吃饭","durationSec":2,"sfx":"ok"},"snack":{"label":"取食","durationSec":2,"sfx":"ok"},"cook":{"label":"做饭","durationSec":2,"sfx":"ok"},"drink":{"label":"喝水","durationSec":2,"sfx":"ok"},"watch":{"label":"看电视","durationSec":2,"sfx":"ok"},"music":{"label":"听音乐","durationSec":2,"sfx":"ok"},"read":{"label":"看书","durationSec":2,"sfx":"ok"},"water":{"label":"浇水","durationSec":2,"sfx":"ok"},"wc":{"label":"上厕所","durationSec":2,"sfx":"ok"},"bath":{"label":"泡澡","durationSec":2,"sfx":"ok"},"net":{"label":"上网","durationSec":2,"sfx":"ok"}},"reserved":{"note":"以下为预留动词，引擎侧尚未有 hook；新增物品时可直接引用，不需要改引擎（普通数值型交互）。带 hook 的需先在 VERB_HOOKS 注册。","plant":{"label":"种植","durationSec":3,"sfx":"place","needsItems":"seed"},"harvest":{"label":"收获","durationSec":2,"sfx":"pickup"},"feed":{"label":"投喂","durationSec":2,"sfx":"ok","needsItems":"petfood"},"pet":{"label":"撸一撸","durationSec":2,"sfx":"ok"},"play":{"label":"玩一局","durationSec":3,"sfx":"ok"},"shower":{"label":"淋浴","durationSec":3,"sfx":"ok"},"laundry":{"label":"洗衣服","durationSec":3,"sfx":"ok"},"brew":{"label":"冲咖啡","durationSec":3,"sfx":"ok","needsItems":"coffee_bean"},"craft":{"label":"制作","durationSec":3,"sfx":"build"}}},"lottery/lottery.json":{"schema":"lottery/1","name":"双色球","note":"2 元一注。号码与奖级按官方玩法：红球 6 个（1-33）+ 蓝球 1 个（1-16），奖级与固定奖金按下表。概率不写死，由组合数学现算（C(33,6)×16 = 17,721,088 种）。","price":2,"maxTicketsPerBuy":10,"red":{"pick":6,"max":33},"blue":{"pick":1,"max":16},"tiers":[{"id":"t1","name":"一等奖","prize":5000000,"patterns":[{"red":6,"blue":1}]},{"id":"t2","name":"二等奖","prize":150000,"patterns":[{"red":6,"blue":0}]},{"id":"t3","name":"三等奖","prize":3000,"patterns":[{"red":5,"blue":1}]},{"id":"t4","name":"四等奖","prize":200,"patterns":[{"red":5,"blue":0},{"red":4,"blue":1}]},{"id":"t5","name":"五等奖","prize":10,"patterns":[{"red":4,"blue":0},{"red":3,"blue":1}]},{"id":"t6","name":"六等奖","prize":5,"patterns":[{"red":2,"blue":1},{"red":1,"blue":1},{"red":0,"blue":1}]}]},"maps/home.map.json":{"schema":"map/1","id":"map.home","renderer":"interior","note":"家 = 房子 + 院子；网格尺寸由房型推导（室内 w/h + 两侧各 3 格院子）","base":{"houseOrigin":{"x":3,"y":3},"yardMargin":3},"yardDecor":[{"kind":"tree","at":[4,1]},{"kind":"flower","at":[9,2]},{"kind":"tree","at":[15,1]},{"kind":"bush","at":[6,1]},{"kind":"flower","at":[13,2]},{"kind":"flower","at":[4,14]},{"kind":"bush","at":[9,14]},{"kind":"flower","at":[15,14]},{"kind":"tree","at":[6,13]},{"kind":"tree","at":[13,13]},{"kind":"tree","at":[1,4]},{"kind":"flower","at":[2,7]},{"kind":"bush","at":[1,11]},{"kind":"flower","at":[2,2]},{"kind":"bush","at":[18,4]},{"kind":"tree","at":[17,7]},{"kind":"flower","at":[18,11]},{"kind":"tree","at":[17,2]}],"portals":[{"id":"home.toStreet","role":"exit","at":{"x":1,"y":"bottom-1"},"target":"map.street"},{"id":"home.door","role":"innerDoor","at":{"edge":"bottom","offset":"center"},"target":null}],"spawn":{"rule":"houseCenter","fallback":"nearestFree"}},"maps/street.map.json":{"schema":"map/1","id":"map.street","renderer":"neighborhood","grid":{"w":88,"h":48},"border":{"note":"边界缓冲带：绿篱与内容之间留出的草坪格数，避免楼贴着围栏","margin":2},"wild":{"note":"地图外围的荒野：按哈希程序化生成，不占数据、不参与寻路。将来做\"无限画布\"时，新的街区只要往 zones/houses 里加，外围自动过渡。","treeDensity":0.045,"density":0.12},"layoutNote":"楼高 3 格、屋顶向上延伸约 6 格：同一条街上不要排两排楼，否则南排会挡住北排门口的人。商铺一律单排、门朝南，且必须落在铺装带（pavement）上，不能压道路。林荫北路被公共服务区大院截成东西两段——大院是不通车的，横向绕行请走中央大道。东商业街 (44,25) 起，和西边商业街同高，快递站/奶茶店在这一排。","houses":[{"id":"house.2栋","label":"2栋","rect":{"x":4,"y":4,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n1"},{"id":"house.3栋","label":"3栋","rect":{"x":10,"y":4,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n2"},{"id":"house.4栋","label":"4栋","rect":{"x":16,"y":4,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":4,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.5栋","label":"5栋","rect":{"x":4,"y":8,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.6栋","label":"6栋","rect":{"x":10,"y":8,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.7栋","label":"7栋","rect":{"x":16,"y":8,"w":4,"h":3},"palette":{"body":"#cfb894"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.8栋","label":"8栋","rect":{"x":54,"y":4,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.9栋","label":"9栋","rect":{"x":59,"y":4,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.10栋","label":"10栋","rect":{"x":54,"y":8,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":4,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n3"},{"id":"house.11栋","label":"11栋","rect":{"x":59,"y":8,"w":4,"h":3},"palette":{"body":"#cfb894"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.12栋","label":"12栋","rect":{"x":12,"y":14,"w":4,"h":3},"palette":{"body":"#d8b48a"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.13栋","label":"13栋","rect":{"x":12,"y":18,"w":4,"h":3},"palette":{"body":"#cfa87f"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.14栋","label":"14栋","rect":{"x":46,"y":14,"w":4,"h":3},"palette":{"body":"#dcc09a"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n4","villa":true},{"id":"house.15栋","label":"15栋","rect":{"x":52,"y":14,"w":4,"h":3},"palette":{"body":"#d3ae86"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.16栋","label":"16栋","rect":{"x":58,"y":14,"w":4,"h":3},"palette":{"body":"#c9a27a"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.17栋","label":"17栋","rect":{"x":46,"y":18,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.18栋","label":"18栋","rect":{"x":52,"y":18,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.19栋","label":"19栋","rect":{"x":58,"y":18,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.公寓楼","label":"公寓楼","rect":{"x":5,"y":39,"w":2,"h":3},"palette":{"body":"#cfc7b6"},"floors":18,"door":{"edge":"bottom","offset":"center"},"owner":null,"home":true},{"id":"house.20栋","label":"20栋","rect":{"x":12,"y":38,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n5"},{"id":"house.21栋","label":"21栋","rect":{"x":26,"y":38,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.22栋","label":"22栋","rect":{"x":33,"y":38,"w":4,"h":3},"palette":{"body":"#cfb894"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.23栋","label":"23栋","rect":{"x":48,"y":38,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.24栋","label":"24栋","rect":{"x":55,"y":38,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null}],"trees":[],"treeRules":{"note":"树的播种规则：草坪按哈希自动种，避免手工挪坐标；门口与路口保留空地","lawnDensity":0.05,"gardenDensity":0.07,"clearNearDoor":2},"portals":[{"id":"street.toHome","role":"enter","at":{"x":7,"y":43},"target":"map.home"}],"spawn":{"x":7,"y":43},"zonesNote":"分区表：按面积从小到大匹配（小区域覆盖大区域）；kind=shop 是店铺，kind=civic 是公共服务建筑","zones":[{"id":"road_h1","kind":"road","x":3,"y":12,"w":18,"h":2,"label":"林荫北路","note":"西段：x3..20，到公共服务区大院西墙为止"},{"id":"road_h1e","kind":"road","x":37,"y":12,"w":46,"h":2,"label":"林荫北路","note":"东段：x37..82，从大院东墙外接上"},{"id":"road_h2","kind":"road","x":3,"y":23,"w":82,"h":2,"label":"中央大道","note":"主干道，横贯全图（x3..84）"},{"id":"road_h3","kind":"road","x":3,"y":35,"w":82,"h":2,"label":"南环路"},{"id":"road_v1","kind":"road","x":20,"y":3,"w":2,"h":42,"label":"西支路"},{"id":"road_v2","kind":"road","x":42,"y":3,"w":2,"h":42,"label":"东支路"},{"id":"park","kind":"park","x":23,"y":3,"w":18,"h":8,"label":"街心公园"},{"id":"pond","kind":"pond","x":27,"y":5,"w":8,"h":4,"label":"荷花池"},{"id":"garden_ne","kind":"garden","x":45,"y":3,"w":8,"h":8,"label":"东花园"},{"id":"parking","kind":"parking","x":4,"y":14,"w":6,"h":5,"label":"停车位"},{"id":"garden_w","kind":"garden","x":4,"y":20,"w":6,"h":2,"label":"西花坛"},{"id":"garden_c","kind":"garden","x":23,"y":14,"w":18,"h":8,"label":"中央绿地"},{"id":"pavement","kind":"pavement","x":3,"y":25,"w":17,"h":10,"label":"商业街"},{"id":"shop1","kind":"shop","x":4,"y":26,"w":5,"h":3,"label":"便利店","tint":"#c85a4a"},{"id":"shop2","kind":"shop","x":10,"y":26,"w":5,"h":3,"label":"咖啡店","tint":"#6f8ba8"},{"id":"shop3","kind":"shop","x":15,"y":26,"w":4,"h":3,"label":"菜市场","tint":"#6fae6f"},{"id":"shop4","kind":"shop","x":46,"y":26,"w":4,"h":3,"label":"快递站","tint":"#c8964a","note":"原 (42,23) 压在中央大道和东支路上，移到东商业街北排"},{"id":"plaza","kind":"plaza","x":24,"y":26,"w":16,"h":7,"label":"中心广场"},{"id":"court","kind":"court","x":66,"y":26,"w":6,"h":5,"label":"篮球场"},{"id":"sand","kind":"sand","x":73,"y":26,"w":9,"h":5,"label":"儿童乐园"},{"id":"shop5","kind":"shop","x":53,"y":26,"w":4,"h":3,"label":"奶茶店","tint":"#d08aa0","note":"原 (54,23) 压在中央大道上，移到东商业街北排"},{"id":"hospital","kind":"civic","x":22,"y":12,"w":6,"h":4,"label":"社区医院","tint":"#6fa8c9"},{"id":"school","kind":"civic","x":29,"y":12,"w":7,"h":4,"label":"实验小学","tint":"#c9a24a"},{"id":"police","kind":"civic","x":22,"y":17,"w":5,"h":3,"label":"派出所","tint":"#4a6fa8"},{"id":"property","kind":"civic","x":29,"y":17,"w":5,"h":3,"label":"物业公司","tint":"#7a9a6a"},{"id":"shop_car","kind":"shop","x":44,"y":31,"w":5,"h":3,"label":"4S 店","tint":"#8a8f98"},{"id":"parking_4s","kind":"parking","x":50,"y":31,"w":4,"h":3,"label":"4S 停车场"},{"id":"shop_lottery","kind":"shop","x":16,"y":15,"w":4,"h":3,"label":"彩票站","tint":"#c86f9a","note":"原 (16,16)：南边缘正好是证券营业部的北墙，门口开在人家屋里。上移一格，y18 让出过道。"},{"id":"shop_restaurant","kind":"shop","x":4,"y":31,"w":5,"h":3,"label":"老张饭馆","tint":"#c9803f"},{"id":"shop_super","kind":"shop","x":10,"y":31,"w":6,"h":3,"label":"惠民超市","tint":"#6f9a8a"},{"id":"shop_bank","kind":"shop","x":16,"y":31,"w":4,"h":3,"label":"民生银行","tint":"#5b7fa6"},{"id":"shop_stock","kind":"shop","x":16,"y":19,"w":4,"h":3,"label":"证券营业部","tint":"#8a6aa6"},{"id":"shop_pet","kind":"shop","x":37,"y":37,"w":5,"h":4,"label":"宠物之家","tint":"#cf7d5e","note":"原来在 (18,36)，同时压在南环路(y35-36)和西支路(x20-21)上，等于把店盖在十字路口。移到南环路南侧的住宅带空位，门前(y41)留空。"},{"id":"pavement_e","kind":"pavement","x":44,"y":25,"w":17,"h":10,"label":"东商业街","note":"东半区原来没有商铺铺装带，快递站/奶茶店只能骑在中央大道上；补一条铺装，把两家接进来"},{"id":"park_e","kind":"park","x":68,"y":4,"w":14,"h":8,"label":"东公园","note":"地图东扩之后这片原本是纯野地，加个公园当东侧地标；林荫北路 y12 从它南边过"}],"zoneKinds":{"road":{"note":"沥青路面","ground":"#8f8b82"},"plaza":{"note":"广场砖石","ground":"#d5c9ae"},"court":{"note":"塑胶球场 + 白线","ground":"#6f9c6a"},"pavement":{"note":"商业街铺装","ground":"#cbc0a6"},"sand":{"note":"儿童乐园沙地","ground":"#e2d2ad"},"parking":{"note":"停车位（沥青 + 车位线）","ground":"#8a8880"},"park":{"note":"公园草坪","ground":"#93c07a"},"pond":{"note":"水面（不可行走，整体绘制）","ground":"#a9c489"},"garden":{"note":"花坛草坪","ground":"#8fbb72"},"shop":{"note":"店铺建筑占地（阻挡通行）"},"lawn":{"note":"默认草坪，颜色随季节"},"civic":{"note":"公共服务建筑（医院/学校/派出所/物业），楼体占格会阻挡"}},"fences":{"note":"围栏不手写整圈坐标：areas 给一个矩形（院落边界），gates 给大门格；客户端沿矩形画一圈栏杆、门格留洞，围栏格同时参与碰撞。border 是小区围墙。","border":{"style":"hedge"},"areas":[{"id":"civic_block","style":"rail","rect":{"x":21,"y":11,"w":16,"h":11},"note":"公共服务区院落：医院/小学/派出所/物业都在围墙里，南侧两个大门（x=27、x=34）通向中央大道","gates":[{"x":27,"y":22},{"x":34,"y":22}]}]},"mailbox":{"x":7,"y":42,"label":"信箱"},"mailboxNote":"楼下的信箱：账单一到就投这里，点开看通知、逐条支付。位置必须在公寓楼门口附近的可走格上。","financeNote":"金融一条街：商业街南排东端是银行（shop_bank），彩票站正南是证券营业部（shop_stock）。两者都只做「钱的生意」——银行给利息也给贷款，券商收手续费也承担涨跌。","busStops":[{"id":"stop.w","name":"西站","x":12,"y":25,"note":"商业街东口，中央大道北侧"},{"id":"stop.e","name":"东站","x":56,"y":25,"note":"东商业街，中央大道北侧"}],"busStopNote":"公交站：站在站牌旁边点它就能上车。地图扩到 88 格之后，从西头走到东头要 20 多秒，两个站各在中央大道两头，花 ¥2 坐过去比走路快。座位必须落在可走格上、不能压道路。"},"pets/pets.json":{"schema":"pets/1","id":"pets.default","note":"宠物系统：在宠物之家领养，回家后在室内自由活动。宠物有饱腹/心情/清洁三项需求，随游戏时间衰减；喂食、撸、玩、洗澡可恢复。宠物粮在宠物之家按包购买。","needs":{"note":"三项需求均为 0-100，越低越需要照顾；decayPerGameMinute 为每游戏分钟衰减量（对齐玩家数值按游戏分钟衰减的铁律）","hunger":{"label":"饱腹","initial":85,"decayPerGameMinute":0.045},"mood":{"label":"心情","initial":80,"decayPerGameMinute":0.035},"clean":{"label":"清洁","initial":90,"decayPerGameMinute":0.022}},"petfood":{"name":"宠物粮","unit":"份","pack":5,"price":30,"note":"一包 5 份，喂食一次消耗 1 份","feedHunger":38,"feedMood":4},"actions":{"feed":{"label":"喂食","durationSec":2,"sfx":"ok","desc":"喂一份宠物粮，恢复饱腹"},"pet":{"label":"撸一撸","durationSec":2,"sfx":"ok","mood":16,"playerEmotion":6,"desc":"摸摸它，它和你都开心"},"play":{"label":"玩一会","durationSec":3,"sfx":"ok","mood":30,"hunger":-6,"playerEmotion":9,"desc":"用逗猫棒/球玩一局，更开心但会饿"},"wash":{"label":"洗澡","durationSec":3,"sfx":"ok","clean":45,"mood":-6,"playerEmotion":2,"desc":"洗干净，多数宠物不太喜欢"}},"moodFeedback":{"note":"宠物整体状态会反过来影响玩家情绪：低需求宠物让人心疼，健康宠物让人治愈","happyThreshold":70,"happyPlayerEmotionPerPet":1,"sadThreshold":30,"sadFloat":"看起来蔫蔫的，多陪陪它吧"},"maxPets":3,"pets":[{"id":"pet.cat.orange","name":"橘猫","species":"cat","price":600,"desc":"十个橘猫九个胖，贪吃又黏人","colors":{"body":"#e89a4a","belly":"#f6dcb8","stripe":"#c4762c","earInner":"#f0b48a","eye":"#5aa04a","nose":"#d96a5a"}},{"id":"pet.cat.black","name":"黑猫","species":"cat","price":550,"desc":"镇宅辟邪，夜里只剩一双眼睛","colors":{"body":"#3c3c44","belly":"#5a5a64","stripe":"#26262c","earInner":"#6a5a64","eye":"#e0b84a","nose":"#8a5a6a"}},{"id":"pet.cat.ragdoll","name":"布偶猫","species":"cat","price":1500,"desc":"蓝眼睛长毛公主，脾气好得像布偶","colors":{"body":"#e8ddce","belly":"#f7f1e8","stripe":"#b89a82","earInner":"#eec9c0","eye":"#5a96c9","nose":"#e08a8a"}},{"id":"pet.dog.shiba","name":"柴犬","species":"dog","price":900,"desc":"笑脸表情包，倔强又忠诚","colors":{"body":"#d98a3c","belly":"#f3e2cc","stripe":"#b56a26","earInner":"#e8a86a","eye":"#3a2a20","nose":"#2b221c"}},{"id":"pet.dog.corgi","name":"柯基","species":"dog","price":1100,"desc":"小短腿大屁股，走起路来一扭一扭","colors":{"body":"#e09a4a","belly":"#f5ede0","stripe":"#f2ede2","earInner":"#d98a5a","eye":"#3a2a20","nose":"#2b221c"}},{"id":"pet.dog.golden","name":"金毛","species":"dog","price":1300,"desc":"暖男大哥哥，热情又温顺","colors":{"body":"#e8c06a","belly":"#f4e4bc","stripe":"#c99a44","earInner":"#d4a05a","eye":"#5a4026","nose":"#3a2a1c"}}]},"rules/bills.json":{"schema":"rules/1","id":"rules.bills.default","note":"缴费通知：到日子往楼下信箱投一张单，玩家自己去看、自己付。金额只会用到 amount 里的 source / flat / base / perAppliance / perFloor / villaBase 这几个字段——加新算法必须同步改引擎，别在数据里写代码。","mailbox":{"note":"信箱挂在公寓楼门口，具体格子写在 maps/street.map.json 的 mailbox 字段。","graceDays":3,"lateEmotionPerDay":-1,"lateEmotionCap":-15,"paidEmotionBonus":5,"keepPaid":8,"maxOpen":24},"bills":[{"id":"bill.rent","title":"房租","icon":"rent","cycleDays":7,"onlyWhen":"rented","amount":{"source":"rent","period":30},"desc":"本季房租","unitNote":"按房源月租 ÷ 30 天 × 7 天折算，租住才有这一单"},{"id":"bill.power","title":"电费","icon":"bolt","cycleDays":15,"onlyWhen":"always","amount":{"base":16,"perAppliance":4},"desc":"双月电费","unitNote":"基本电费 16 元 + 每件电器 4 元（电器越多越贵）"},{"id":"bill.water","title":"水费","icon":"water","cycleDays":15,"onlyWhen":"always","amount":{"base":12,"perFloor":0.3},"desc":"双月水费","unitNote":"基本水费 12 元 + 高层二次加压每层 0.3 元"},{"id":"bill.property","title":"物业费","icon":"building","cycleDays":30,"onlyWhen":"always","amount":{"base":38,"perFloor":1,"villaBase":62},"desc":"本月物业费","unitNote":"公寓按楼层递增，独栋按建筑面积固定"},{"id":"bill.parking","title":"停车费","icon":"car","cycleDays":7,"onlyWhen":"car","amount":{"flat":12},"desc":"本周停车费","unitNote":"有车才投这一单，停在 4S 店旁边的停车场"}]},"rules/economy.json":{"schema":"rules/1","id":"rules.economy.default","currency":"CNY","startMoney":500,"cozy":{"bonusExpr":"min(20, round(sqrt(cozy) * 1.5))","morningScale":0.6,"tiers":[{"min":0,"name":"毛坯房","stars":0},{"min":18,"name":"有点样子","stars":1},{"min":35,"name":"温馨小屋","stars":2},{"min":55,"name":"精致小窝","stars":3},{"min":80,"name":"梦想之家","stars":4}]},"social":{"streetChatEmotion":10,"visitChatEmotion":12,"chatCooldownSec":1.5},"sellRatio":0.5,"sellNote":"卖出比例：售价 = floor(原价 × sellRatio)。0.5 = 半价回收，避免买了再卖套利","rent":{"cycleDays":7,"note":"租住的房每 7 天扣一次月租（月租 = units.rent.base + perFloor × 楼层）。钱不够就欠着，下个周期再试，不强制搬走。"},"car":{"resaleRatio":0.6,"note":"卖回 4S 店按车价 60% 回收（车一落地就贬值，比家具狠一点）"},"food":{"note":"食材制：菜市场/超市买，回家做饭消耗。uses=用掉几份，hunger/thirst 是吃完回的数值。买不到食材就下馆子，贵但不占手。 背包（bagCap）是随身容量，冰箱（max）是家里容量；两者都满就吃不下也买不进。","unit":"份","max":40,"cook":{"uses":1,"hunger":22,"label":"做饭"},"meal":{"uses":2,"hunger":40,"label":"吃饭"},"snack":{"uses":1,"hunger":18,"thirst":10,"label":"取食"},"emptyHint":"冰箱空了，去菜市场或超市买点食材","bagCap":20,"bagNote":"随身背包只装食材，上限 bagCap 份。买菜先进背包，回家自动放进冰箱；家具电器属于装修类，买了直接进仓库、不占背包，大件本来也不该背着走。"},"groceries":[{"zone":"shop3","name":"菜市场","pack":10,"price":26,"desc":"散装当季菜，单价最低"},{"zone":"shop1","name":"便利店","pack":3,"price":15,"desc":"小包装应急，单价偏高"},{"zone":"shop_super","name":"超市","pack":6,"price":24,"desc":"标准装，明码标价"}],"restaurant":{"zone":"shop_restaurant","name":"老张饭馆","note":"下馆子不消耗食材，贵在人工和房租。吃完直接回数值，不用回家。","menu":[{"id":"dish.noodle","name":"牛肉面","price":14,"hunger":40,"emotion":2,"desc":"一碗管饱，汤头够味"},{"id":"dish.rice","name":"盖浇饭","price":18,"hunger":45,"emotion":3,"desc":"两荤一素，米饭管加"},{"id":"dish.set","name":"小炒套餐","price":28,"hunger":60,"emotion":6,"desc":"现炒三个菜，坐下来慢慢吃"},{"id":"dish.soup","name":"例汤","price":6,"hunger":8,"thirst":18,"emotion":1,"desc":"今日例汤，单点也行"}]},"mart":{"zone":"shop_super","name":"惠民超市","note":"货架商品：买了立刻生效（便当/水），食材进冰箱。食材包与 groceries 里 shop_super 那条同价。","goods":[{"id":"good.bento","name":"速食便当","price":12,"hunger":30,"desc":"微波炉热两分钟"},{"id":"good.water","name":"瓶装水","price":3,"thirst":25,"desc":"常温，冰的在里面"},{"id":"good.instant","name":"泡面","price":6,"hunger":22,"thirst":-6,"desc":"顶饿，但吃完更渴"}]},"clinic":{"note":"社区医院：门诊恢复状态，买药便宜但要等冷却。价格写在这里，改数值不用碰代码。","services":[{"id":"clinic.visit","name":"门诊","price":60,"desc":"医生看一眼：情绪 +25，饥饿/口渴 +10","effects":{"emotion":25,"hunger":10,"thirst":10}},{"id":"clinic.meds","name":"买药","price":25,"desc":"一盒药：情绪 +12，30 分钟内只能买一次","effects":{"emotion":12},"cooldownMinutes":30}]},"marts":[{"zone":"shop1","name":"便利店","note":"货架小、单价高，胜在 24 小时。","goods":[{"id":"good.onigiri","name":"饭团","price":8,"hunger":22,"desc":"冷的，能顶一阵"},{"id":"good.oden","name":"关东煮","price":11,"hunger":26,"thirst":8,"desc":"热汤，冷天最实在"},{"id":"good.cannedcoffee","name":"罐装咖啡","price":7,"emotion":8,"desc":"苦得很直接"}]},{"zone":"shop2","name":"咖啡店","note":"坐一会儿比喝了什么更要紧。","goods":[{"id":"good.americano","name":"美式","price":15,"emotion":12,"thirst":10,"desc":"苦，但醒"},{"id":"good.latte","name":"拿铁","price":18,"emotion":14,"thirst":12,"hunger":5,"desc":"奶味重，暖手"},{"id":"good.croissant","name":"可颂","price":12,"hunger":20,"desc":"早上配咖啡"}]},{"zone":"shop5","name":"奶茶店","note":"甜的东西让人心情好一点。","goods":[{"id":"good.bobatea","name":"珍珠奶茶","price":14,"thirst":22,"emotion":10,"desc":"三分糖，去冰"},{"id":"good.lemonade","name":"柠檬水","price":10,"thirst":25,"desc":"酸，解渴"},{"id":"good.cake","name":"小蛋糕","price":15,"hunger":18,"emotion":6,"desc":"一口一个"}]}],"martsNote":"小店的货架：和超市 mart 同一套结构（zone/name/goods）。有柜台的店，点门面就能买；如果这家还招人，柜台底下会多一个「打卡上班」。","online":{"zone":"shop4","name":"快递站","discount":0.88,"days":1,"note":"网上下单：便宜一点，但要等一天，自己到快递站取。取回来的家具进仓库，和到店买的一样。"},"favor":{"note":"熟客好感：**按店铺记**（键是 zoneId，不是店员 id）——熟的是门面，不是那个人。等级按 at 升序，discount 是到店消费的倍率；网购不参与（否则和 88 折叠加会套利）。","dailyCap":2,"levels":[{"at":0,"name":"陌生","discount":1,"hearts":0},{"at":3,"name":"脸熟","discount":1,"hearts":1},{"at":8,"name":"熟客","discount":0.95,"hearts":2},{"at":15,"name":"朋友","discount":0.92,"hearts":3}],"gainNote":"每天每家店最多 +2 点（dailyCap）：打招呼 +1、问这家店 +1、消费 +1、在这家上一天班 +1，按先来后到累计。"}},"rules/survival.json":{"schema":"rules/1","id":"rules.survival.default","stats":{"hunger":{"label":"饥饿","max":100,"initial":100,"decayPerGameMinute":0.05,"criticalBelow":35,"order":1,"color":"#d2691e","iconPath":"M4 13c1 2 3 3 6 3 2 0 3-1 3-2 0 4 3 6 7 6 1 0 2-1 2-2 0-6-4-11-9-11-3 0-6 2-9 6z","decayNote":"0.05/游戏分钟 = 72/游戏日。按平均单次 +26.8 算，一天约 2.7 顿——这就是\"三餐\"的数值基准，另外两条向它看齐。"},"thirst":{"label":"口渴","max":100,"initial":100,"decayPerGameMinute":0.05,"criticalBelow":35,"order":2,"color":"#4f8ac9","iconPath":"M12 3s6 7 6 12a6 6 0 1 1-12 0c0-5 6-12 6-12z","decayNote":"0.05/游戏分钟 = 72/游戏日。原来是 0.07（101/天，一整天补满都不够），而单次补水最大只有 +34（水槽）、日常 +18，等于一天要喝五次水才不掉格——扣得比饥饿快、补得比饥饿少，不合理。现在与饥饿同速，靠\"喝水次数本来就比吃饭多\"（单次幅度小）来区分。"},"emotion":{"label":"情绪","max":100,"initial":70,"decayPerGameMinute":0.025,"criticalBelow":30,"order":3,"color":"#e0b84f","iconPath":"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z","decayNote":"0.025/游戏分钟 = 36/游戏日。原来是 0.06（86/天），而日常小确幸只有 +3~+5、聊天 +10、门诊 +25，数学上不可能维持，情绪会长期贴地。现在约等于「睡觉 +8、聊两次天 +20、看会儿书 +5」刚好打平——不经营会慢慢滑，经营了就稳得住。"}},"clock":{"startMinute":480,"minutesPerRealSecond":{"0":0,"1":1,"2":2},"dayRolloverMinute":1440,"timeSource":"world","timeZoneOffsetHours":8,"simMinutesPerRealSecond":1,"timeSourceNote":"world=全服统一世界时钟（服务端 /api/v1/world 懒推进，客户端插值+每 30 秒校准）。所有人共用同一个游戏日，账单周期与「每天只能上一次班」都以它为准；暂停/倍速在 world 模式下无效。realtime=跟随北京时间（单人慢节奏），game=本地自走钟（可暂停/倍速/睡觉跳时）。","simNote":"simMinutesPerRealSecond 只用于生存数值衰减；world 模式下按 WORLD.rate/60 折算（rate 60 → 1 真实秒 = 1 游戏分钟）","worldRate":60,"worldRateNote":"世界时钟倍率：游戏分钟 / 真实分钟。60 → 1 真实分钟 = 1 游戏小时，1 天 = 24 分钟真实时间。这是「每天只能上一次班 + 账单按天记」的节奏来源，改它就是改整个游戏的快慢。服务端 WORLD_RATE 环境变量可覆盖；客户端在服务端倍率异常（< 30）时用这里的值兜底。"},"work":{"durationSec":5,"pay":60,"cost":{"hunger":1.5,"thirst":2}},"sleep":{"fromHour":21,"toHour":5,"wakeMinute":420,"cost":{"hunger":12,"thirst":12}},"reservedStatTemplate":{"note":"加新资源照这个填即可，引擎（STATS 初始化 / applyFx / HUD 条）会自动生效，无需改代码","example":{"stamina":{"label":"体力","max":100,"initial":100,"decayPerGameMinute":0.08,"criticalBelow":30,"order":4,"color":"#7b9ec9","iconPath":"M13 2 3 14h7l-1 8 10-12h-7l1-8z","hudVisible":true}}},"decayNote":"三条状态的日衰减都按\"一天要做几次动作\"反推，不按直觉调：日衰减 ÷ 该状态的平均单次补充 = 一天需要的动作次数。饥饿 72÷26.8≈2.7 顿、口渴 72÷18.3≈3.9 次、情绪 36÷5.2≈7 次小确幸。改任何一条之前先跑 tools/_stataudit.py，别凭感觉。"},"stock/stock.json":{"schema":"stock/1","zone":"shop_stock","label":"证券营业部","feeRate":0.0015,"maxHoldings":6,"lotSize":100,"note":"六支股票，全部以小区里的真实生意为原型。价格由「当日随机游走」推导：p(明天) = p(今天) × (1 + 日均漂移 + 周期项 + 波动)。抖动来自「股票编号 + 游戏日」的稳定散列——同一天所有人看到的收盘价完全一样，读档也不会变，所以不需要服务端存行情。漂移可以为负：地产和博彩是长期阴跌的，不加周期项的话「闭眼持有」就必然赚钱。","model":{"tailProb":0.025,"tailMul":2.5,"floorRatio":0.15,"note":"tailProb：约 2.5% 的日子会出现尾部事件（暴涨或暴跌），幅度放大 2.5 倍——这是股市「刺激感」的来源。floorRatio：价格永远不低于初始价的 15%，避免跌到 0 之后再也涨不回来。注意 floor 是硬夹紧，负漂移的股票跌到地板后会被「托住」，所以负漂移要保守（≥ -0.0015/天），否则 1000 天后地板本身变成无风险套利。"},"stocks":[{"id":"st.conv","code":"600102","name":"邻里便利","sector":"零售","base":12.4,"drift":0.0013,"vol":0.022,"cycleDays":150,"cycleAmp":0.001,"cyclePhase":10,"desc":"开遍小区的便利店连锁。现金流稳，涨得慢也跌不狠，适合当存钱的替代品。"},{"id":"st.cafe","code":"600215","name":"豆香咖啡","sector":"餐饮","base":28.6,"drift":0.0028,"vol":0.036,"cycleDays":90,"cycleAmp":0.0026,"cyclePhase":20,"desc":"年轻人排队的那家。故事讲得好，行情来得快去得也快——每次回撤都是上车机会，但你得敢接。"},{"id":"st.build","code":"600330","name":"城建地产","sector":"地产","base":8.9,"drift":-0.0012,"vol":0.02,"cycleDays":120,"cycleAmp":0.003,"cyclePhase":55,"desc":"盖公寓楼的那家。行业在下行通道里长期阴跌，四个月一轮反弹——反弹能吃，别拿长线。"},{"id":"st.auto","code":"600448","name":"远行汽车","sector":"汽车","base":46.2,"drift":0,"vol":0.032,"cycleDays":150,"cycleAmp":0.0024,"cyclePhase":80,"desc":"4S 店背后的整车厂。单价高、一手就要好几千，销量的季节性全写在走势里。"},{"id":"st.logi","code":"600512","name":"顺达物流","sector":"物流","base":19.8,"drift":0.0018,"vol":0.028,"cycleDays":90,"cycleAmp":0.0018,"cyclePhase":35,"desc":"快递站的上家。网购越旺它越忙，稳中有涨，是按季度结算的那种生意。"},{"id":"st.luck","code":"600777","name":"鸿运彩票","sector":"博彩","base":6.3,"drift":-0.0009,"vol":0.048,"cycleDays":60,"cycleAmp":0.0042,"cyclePhase":5,"desc":"彩票站的母公司。两个月一轮过山车：涨起来最凶，跌起来也最狠，久拿着是给庄家送钱。"}]},"ui/strings.zh-CN.json":{"schema":"ui/1","locale":"zh-CN","note":"界面文案种子；后续把 HTML 里的硬编码文案逐步搬进来，支持多语言","strings":{"app.title":"我的 2.5D 小屋","hud.work":"工作 +¥","hud.shop":"商店","hud.char":"人物","hud.edit":"整理","hud.decor":"装修","hud.expand":"房型","hud.scene.street":"小区","hud.scene.home":"回家","hud.home":"回原位","panel.shop":"家具商店","panel.inventory":"我的仓库","panel.decor":"房间装修","panel.upgrade":"房型扩建","stat.hunger":"饥饿","stat.thirst":"口渴","stat.emotion":"情绪","stat.money":"金钱","stat.cozy":"装修度","hud.version":"版本"}},"vehicles/cars.json":{"schema":"vehicles/1","note":"车款：只在 4S 店（zone shop_car）出售。speed 是相对步行的倍率（步行 4.2 格/秒）。车不占家具目录，单独一类内容。价格按「月薪 2400」的购买力定：代步车约 7 个月工资，SUV 约 13 个月，跑车约 20 个月。","models":[{"id":"car.mini","name":"小型代步车","price":16800,"color":"#c8553d","speed":2,"desc":"好停好开，新手上路先来这辆"},{"id":"car.suv","name":"家用 SUV","price":32000,"color":"#4a6fa8","speed":2.4,"desc":"空间大、视野高，跑起来也稳"},{"id":"car.sport","name":"双门跑车","price":48000,"color":"#d9a441","speed":3.2,"desc":"贵，但整条街最显眼的就是它"}],"parking":{"note":"4S 店旁边的停车场：买车后停第一个空位；车位占格不再算空位","zone":"parking_4s"}}},"catalog":[{"id":"bed","name":"床","category":"furniture","tags":["comfort"],"price":320,"footprint":{"w":2,"h":1},"cozy":6,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"sleep","durationSec":2,"effects":{"emotion":6},"special":"sleepToMorning"},"asset":{"kind":"svg","ref":"assets/furniture/bed.svg","size":{"w":128,"h":80},"anchor":{"ax":64,"ay":54}},"ui":{"icon":"bed","desc":"躺下休息，恢复情绪","order":0}},{"id":"sofa","name":"沙发","category":"furniture","tags":["comfort"],"price":260,"footprint":{"w":2,"h":1},"cozy":5,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":5},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/sofa.svg","size":{"w":128,"h":84},"anchor":{"ax":64,"ay":54}},"ui":{"icon":"sofa","desc":"坐下放松，恢复情绪","order":10}},{"id":"dining","name":"餐桌","category":"furniture","tags":["food"],"price":180,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"eat","durationSec":2,"effects":{"hunger":34},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/dining.svg","size":{"w":128,"h":70},"anchor":{"ax":64,"ay":44}},"ui":{"icon":"dining","desc":"吃饭，补充饥饿","order":20}},{"id":"fridge","name":"冰箱","category":"appliance","tags":["food","water","electric"],"price":460,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"snack","durationSec":2,"effects":{"hunger":20,"thirst":12},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/fridge.svg","size":{"w":64,"h":64},"anchor":{"ax":32,"ay":39}},"ui":{"icon":"fridge","desc":"取食，补充饥饿和口渴","order":30}},{"id":"stove","name":"灶台","category":"appliance","tags":["food","electric"],"price":520,"footprint":{"w":2,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"cook","durationSec":2,"effects":{"hunger":28},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/stove.svg","size":{"w":128,"h":70},"anchor":{"ax":64,"ay":44}},"ui":{"icon":"stove","desc":"做饭，大幅补充饥饿","order":40}},{"id":"sink","name":"水槽","category":"furniture","tags":["water"],"price":140,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":34},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/sink.svg","size":{"w":64,"h":62},"anchor":{"ax":32,"ay":36}},"ui":{"icon":"sink","desc":"喝水，补充口渴","order":50}},{"id":"tv","name":"电视","category":"appliance","tags":["comfort","electric"],"price":580,"footprint":{"w":2,"h":1},"cozy":5,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/tv.svg","size":{"w":128,"h":68},"anchor":{"ax":64,"ay":48}},"ui":{"icon":"tv","desc":"看电视，恢复情绪","order":60},"interactions":[{"verb":"watch","effects":{"emotion":7},"label":"看电视"},{"verb":"play","effects":{"emotion":4},"label":"玩一局游戏","requirements":{"statMin":{"emotion":20}},"failText":"心情太差，先歇会儿吧"}]},{"id":"stereo","name":"音响","category":"appliance","tags":["comfort","electric"],"price":300,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"music","durationSec":2,"effects":{"emotion":6},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/stereo.svg","size":{"w":64,"h":76},"anchor":{"ax":32,"ay":52}},"ui":{"icon":"stereo","desc":"听音乐，恢复情绪","order":70}},{"id":"bookshelf","name":"书柜","category":"furniture","tags":["comfort"],"price":200,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"read","durationSec":2,"effects":{"emotion":4},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/bookshelf.svg","size":{"w":64,"h":96},"anchor":{"ax":32,"ay":68}},"ui":{"icon":"bookshelf","desc":"看书，恢复情绪","order":80}},{"id":"plant","name":"绿植","category":"decor","tags":["decor"],"price":60,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"water","durationSec":2,"effects":{"emotion":2},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/plant.svg","size":{"w":64,"h":86},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"plant","desc":"浇花，心情愉悦","order":90}},{"id":"wardrobe","name":"衣柜","category":"furniture","tags":[],"price":230,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/wardrobe.svg","size":{"w":64,"h":98},"anchor":{"ax":32,"ay":70}},"ui":{"icon":"wardrobe","desc":"存放衣物","order":100}},{"id":"lamp","name":"台灯","category":"decor","tags":["decor"],"price":45,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/lamp.svg","size":{"w":64,"h":96},"anchor":{"ax":32,"ay":72}},"ui":{"icon":"lamp","desc":"照明装饰，夜里发光","order":110}},{"id":"toilet","name":"马桶","category":"furniture","tags":["comfort"],"price":120,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"wc","durationSec":2,"effects":{"emotion":3},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/toilet.svg","size":{"w":64,"h":66},"anchor":{"ax":32,"ay":44}},"ui":{"icon":"toilet","desc":"上厕所，舒畅","order":120}},{"id":"bathtub","name":"浴缸","category":"furniture","tags":["comfort"],"price":480,"footprint":{"w":2,"h":1},"cozy":6,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"bath","durationSec":2,"effects":{"emotion":9},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/bathtub.svg","size":{"w":128,"h":70},"anchor":{"ax":64,"ay":44}},"ui":{"icon":"bathtub","desc":"泡澡，放松身心","order":130}},{"id":"pc","name":"电脑","category":"appliance","tags":["comfort","electric"],"price":550,"footprint":{"w":1,"h":1},"cozy":5,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":{"verb":"net","durationSec":2,"effects":{"emotion":6},"special":null},"asset":{"kind":"svg","ref":"assets/furniture/pc.svg","size":{"w":64,"h":72},"anchor":{"ax":32,"ay":52}},"ui":{"icon":"pc","desc":"上网冲浪，恢复情绪","order":140}},{"id":"washer","name":"洗衣机","category":"appliance","tags":["electric","water"],"price":380,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/washer.svg","size":{"w":64,"h":97},"anchor":{"ax":32,"ay":72}},"ui":{"icon":"washer","desc":"洗衣服，焕然一新","order":200},"interaction":{"verb":"laundry","durationSec":2,"effects":{"emotion":5},"special":null}},{"id":"microwave","name":"微波炉","category":"appliance","tags":["electric","food"],"price":220,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/microwave.svg","size":{"w":64,"h":83},"anchor":{"ax":32,"ay":58}},"ui":{"icon":"microwave","desc":"快速加热，补充饥饿","order":201},"interaction":{"verb":"snack","durationSec":2,"effects":{"hunger":16},"special":null}},{"id":"oven","name":"烤箱","category":"appliance","tags":["electric","food"],"price":420,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/oven.svg","size":{"w":128,"h":125},"anchor":{"ax":64,"ay":84}},"ui":{"icon":"oven","desc":"烘焙烹饪，大幅补饥饿","order":202},"interaction":{"verb":"cook","durationSec":2,"effects":{"hunger":26},"special":null}},{"id":"dishwasher","name":"洗碗机","category":"appliance","tags":["electric","water"],"price":300,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/dishwasher.svg","size":{"w":64,"h":93},"anchor":{"ax":32,"ay":68}},"ui":{"icon":"dishwasher","desc":"自动洗碗，省心","order":203},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":3},"special":null}},{"id":"coffee","name":"咖啡机","category":"appliance","tags":["electric"],"price":240,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/coffee.svg","size":{"w":64,"h":87},"anchor":{"ax":32,"ay":62}},"ui":{"icon":"coffee","desc":"冲一杯咖啡，提神","order":204},"interaction":{"verb":"brew","durationSec":2,"effects":{"thirst":14,"emotion":3},"special":null}},{"id":"waterdisp","name":"饮水机","category":"appliance","tags":["electric","water"],"price":200,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/waterdisp.svg","size":{"w":64,"h":103},"anchor":{"ax":32,"ay":78}},"ui":{"icon":"waterdisp","desc":"冷热饮水，快速解渴","order":205},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":30},"special":null}},{"id":"ricecooker","name":"电饭煲","category":"appliance","tags":["electric","food"],"price":180,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/ricecooker.svg","size":{"w":64,"h":79},"anchor":{"ax":32,"ay":54}},"ui":{"icon":"ricecooker","desc":"焖饭煮粥，补充饥饿","order":206},"interaction":{"verb":"eat","durationSec":2,"effects":{"hunger":22},"special":null}},{"id":"aircon","name":"立式空调","category":"appliance","tags":["electric"],"price":520,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/aircon.svg","size":{"w":64,"h":111},"anchor":{"ax":32,"ay":86}},"ui":{"icon":"aircon","desc":"调节室温，舒适自在","order":207},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":4},"special":null}},{"id":"robotvac","name":"扫地机器人","category":"appliance","tags":["electric"],"price":280,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/robotvac.svg","size":{"w":64,"h":63},"anchor":{"ax":32,"ay":38}},"ui":{"icon":"robotvac","desc":"自动清扫，解放双手","order":208},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":2},"special":null}},{"id":"kettle","name":"电热水壶","category":"appliance","tags":["electric","water"],"price":120,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/kettle.svg","size":{"w":64,"h":81},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"kettle","desc":"烧水煮茶，补充口渴","order":209},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":18},"special":null}},{"id":"toaster","name":"烤面包机","category":"appliance","tags":["electric","food"],"price":150,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/toaster.svg","size":{"w":64,"h":77},"anchor":{"ax":32,"ay":52}},"ui":{"icon":"toaster","desc":"烤出香脆面包","order":210},"interaction":{"verb":"snack","durationSec":2,"effects":{"hunger":14},"special":null}},{"id":"desk","name":"书桌","category":"furniture","tags":["comfort"],"price":240,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/desk.svg","size":{"w":128,"h":123},"anchor":{"ax":64,"ay":82}},"ui":{"icon":"desk","desc":"看书工作，配电脑","order":211},"interaction":{"verb":"read","durationSec":2,"effects":{"emotion":5},"special":null}},{"id":"chair","name":"办公椅","category":"furniture","tags":["comfort"],"price":120,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/chair.svg","size":{"w":64,"h":85},"anchor":{"ax":32,"ay":60}},"ui":{"icon":"chair","desc":"坐下休息，配书桌","order":212},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":3},"special":null}},{"id":"coffeetable","name":"茶几","category":"furniture","tags":["comfort"],"price":140,"footprint":{"w":2,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/coffeetable.svg","size":{"w":128,"h":111},"anchor":{"ax":64,"ay":70}},"ui":{"icon":"coffeetable","desc":"沙发区小桌","order":213},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":2},"special":null}},{"id":"tvstand","name":"电视柜","category":"furniture","tags":[],"price":180,"footprint":{"w":2,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/tvstand.svg","size":{"w":128,"h":107},"anchor":{"ax":64,"ay":66}},"ui":{"icon":"tvstand","desc":"摆放电视，收纳杂物","order":214},"interaction":null},{"id":"nightstand","name":"床头柜","category":"furniture","tags":["comfort"],"price":100,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/nightstand.svg","size":{"w":64,"h":81},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"nightstand","desc":"床边小柜，随手置物","order":215},"interaction":{"verb":"rest","durationSec":2,"effects":{"emotion":2},"special":null}},{"id":"vanity","name":"梳妆台","category":"furniture","tags":[],"price":260,"footprint":{"w":2,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/vanity.svg","size":{"w":128,"h":111},"anchor":{"ax":64,"ay":70}},"ui":{"icon":"vanity","desc":"对镜梳妆，精致一天","order":216},"interaction":null},{"id":"shower","name":"淋浴间","category":"furniture","tags":["water","comfort"],"price":360,"footprint":{"w":2,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/shower.svg","size":{"w":128,"h":115},"anchor":{"ax":64,"ay":74}},"ui":{"icon":"shower","desc":"快速淋浴，清爽提神","order":217},"interaction":{"verb":"shower","durationSec":2,"effects":{"emotion":7},"special":null}},{"id":"washbasin","name":"洗手台","category":"furniture","tags":["water"],"price":160,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/washbasin.svg","size":{"w":64,"h":91},"anchor":{"ax":32,"ay":66}},"ui":{"icon":"washbasin","desc":"洗漱洗手，整理仪容","order":218},"interaction":{"verb":"drink","durationSec":2,"effects":{"thirst":12},"special":null}},{"id":"shoecab","name":"鞋柜","category":"furniture","tags":[],"price":140,"footprint":{"w":1,"h":1},"cozy":1,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/shoecab.svg","size":{"w":64,"h":95},"anchor":{"ax":32,"ay":70}},"ui":{"icon":"shoecab","desc":"收纳鞋子，玄关整洁","order":219},"interaction":null},{"id":"kitcab","name":"橱柜","category":"furniture","tags":[],"price":200,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/kitcab.svg","size":{"w":64,"h":109},"anchor":{"ax":32,"ay":84}},"ui":{"icon":"kitcab","desc":"厨房收纳，碗碟归位","order":220},"interaction":null},{"id":"mirror","name":"落地穿衣镜","category":"decor","tags":["decor"],"price":120,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/mirror.svg","size":{"w":64,"h":93},"anchor":{"ax":32,"ay":68}},"ui":{"icon":"mirror","desc":"整理穿搭，点亮房间","order":221},"interaction":null},{"id":"floorlamp","name":"落地灯","category":"decor","tags":["decor"],"price":150,"footprint":{"w":1,"h":1},"cozy":2,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/floorlamp.svg","size":{"w":64,"h":111},"anchor":{"ax":32,"ay":86}},"ui":{"icon":"floorlamp","desc":"柔和照明，温馨氛围","order":222},"interaction":null},{"id":"gfclock","name":"落地座钟","category":"decor","tags":["decor"],"price":220,"footprint":{"w":1,"h":1},"cozy":3,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"asset":{"kind":"svg","ref":"assets/furniture/gfclock.svg","size":{"w":64,"h":111},"anchor":{"ax":32,"ay":86}},"ui":{"icon":"gfclock","desc":"滴答作响，典雅摆设","order":223},"interaction":null},{"id":"rug_warm","name":"暖阳地毯","category":"decor","tags":["decor","walkable"],"price":150,"footprint":{"w":2,"h":2},"cozy":4,"placement":{"indoor":true,"walkable":true,"wallMounted":false,"blocksPath":false,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/rug_warm.svg","size":{"w":128,"h":64},"anchor":{"ax":64,"ay":32}},"ui":{"icon":"rug_warm","desc":"可踩的暖色地毯","order":150}},{"id":"rug_cool","name":"晴空地毯","category":"decor","tags":["decor","walkable"],"price":150,"footprint":{"w":2,"h":2},"cozy":4,"placement":{"indoor":true,"walkable":true,"wallMounted":false,"blocksPath":false,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/rug_cool.svg","size":{"w":128,"h":64},"anchor":{"ax":64,"ay":32}},"ui":{"icon":"rug_cool","desc":"可踩的冷色地毯","order":160}},{"id":"painting","name":"装饰画","category":"decor","tags":["decor"],"price":90,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/painting.svg","size":{"w":64,"h":82},"anchor":{"ax":32,"ay":56}},"ui":{"icon":"painting","desc":"落地画架，点亮墙面","order":170}},{"id":"shelf","name":"置物架","category":"decor","tags":["decor"],"price":170,"footprint":{"w":1,"h":1},"cozy":4,"placement":{"indoor":true,"walkable":false,"wallMounted":false,"blocksPath":true,"unique":false},"interaction":null,"asset":{"kind":"svg","ref":"assets/furniture/shelf.svg","size":{"w":64,"h":88},"anchor":{"ax":32,"ay":58}},"ui":{"icon":"shelf","desc":"摆书和绿植的小架子","order":180}}],"levels":[{"level":0,"id":"house.lv0","name":"温馨一居","price":0,"footprint":{"w":14,"h":10},"zones":[{"id":"bedroom","name":"卧室","rect":{"x":0,"y":0,"w":14,"h":4},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":4,"w":9,"h":6},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"bath","name":"卫生间","rect":{"x":9,"y":4,"w":5,"h":3},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":9,"y":7,"w":5,"h":3},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":1,"id":"house.lv1","name":"两室一厅","price":2000,"footprint":{"w":17,"h":12},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":9,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":9,"y":0,"w":8,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":5,"w":8,"h":7},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":8,"y":5,"w":4,"h":7},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"bath","name":"卫生间","rect":{"x":12,"y":5,"w":5,"h":3},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":12,"y":8,"w":5,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":2,"id":"house.lv2","name":"三室两厅","price":6000,"footprint":{"w":20,"h":14},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":9,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":9,"y":0,"w":5,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed3","name":"次卧","rect":{"x":14,"y":0,"w":6,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":6,"w":9,"h":8},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":9,"y":6,"w":5,"h":8},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"bath","name":"卫生间","rect":{"x":14,"y":6,"w":6,"h":4},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":14,"y":10,"w":6,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":3,"id":"house.lv3","name":"四室两厅","price":15000,"footprint":{"w":23,"h":16},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":8,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":8,"y":0,"w":5,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed3","name":"次卧","rect":{"x":13,"y":0,"w":5,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":18,"y":0,"w":5,"h":7},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":7,"w":9,"h":9},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":9,"y":7,"w":5,"h":9},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"bath1","name":"卫生间","rect":{"x":14,"y":7,"w":4,"h":5},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"bath2","name":"卫生间","rect":{"x":18,"y":7,"w":5,"h":5},"floor":{"pattern":"tile","palette":{"a":"#d6e8e0","b":"#c2d8ce","line":"rgba(90,125,110,.24)","grout":"rgba(120,155,140,.32)"}}},{"id":"kitchen","name":"厨房","rect":{"x":14,"y":12,"w":9,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"level":4,"id":"house.lv4","name":"大平层","price":32000,"footprint":{"w":27,"h":18},"zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":10,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"mbath","name":"主卫","rect":{"x":10,"y":0,"w":5,"h":7},"floor":{"pattern":"tile","palette":{"a":"#d6e8e0","b":"#c2d8ce","line":"rgba(90,125,110,.24)","grout":"rgba(120,155,140,.32)"}}},{"id":"closet","name":"衣帽间","rect":{"x":15,"y":0,"w":4,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}},{"id":"bed2","name":"次卧","rect":{"x":19,"y":0,"w":8,"h":7},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed3","name":"次卧","rect":{"x":0,"y":7,"w":8,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":8,"y":7,"w":7,"h":5},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"guestbath","name":"客卫","rect":{"x":15,"y":7,"w":5,"h":5},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}},{"id":"kitchen","name":"厨房","rect":{"x":20,"y":7,"w":7,"h":5},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":12,"w":13,"h":6},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"dining","name":"餐厅","rect":{"x":13,"y":12,"w":7,"h":6},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}},{"id":"storage","name":"储物间","rect":{"x":20,"y":12,"w":7,"h":6},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}}],"walls":[],"door":{"edge":"bottom","offset":"center"},"type":"apartment"},{"id":"house.villa.garden","name":"花园小墅","type":"villa","price":38000,"footprint":{"w":20,"h":14},"door":{"edge":"bottom","offset":"center"},"walls":[],"note":"独栋入门款：三间卧室横排在北侧，南面是一整片 12 格宽的客厅，尽头接厨房与卫浴。","zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":8,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":8,"y":0,"w":5,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"closet","name":"衣帽间","rect":{"x":13,"y":0,"w":7,"h":5},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}},{"id":"living","name":"客厅","rect":{"x":0,"y":5,"w":12,"h":9},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"kitchen","name":"厨房","rect":{"x":12,"y":5,"w":8,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"bath","name":"卫浴","rect":{"x":12,"y":9,"w":8,"h":5},"floor":{"pattern":"tile","palette":{"a":"#dde9f2","b":"#c8d8e6","line":"rgba(90,115,140,.24)","grout":"rgba(120,140,165,.34)"}}}],"furnish":{"wallStyle":2,"wallName":"暮霭蓝","note":"精装交付：三间卧室、客厅、厨房、卫浴全部配齐，含床品、衣柜、整套厨电与洗浴。","items":[["bed",1,1],["wardrobe",5,0],["nightstand",3,1],["vanity",4,3],["bed",9,1],["wardrobe",8,1],["desk",9,3],["wardrobe",14,1],["shoecab",16,1],["mirror",18,1],["shelf",14,3],["sofa",1,6],["coffeetable",1,8],["tv",1,10],["rug_cool",4,7],["floorlamp",0,6],["painting",0,12],["aircon",10,6],["gfclock",10,12],["fridge",13,6],["stove",15,6],["kitcab",18,6],["microwave",15,8],["oven",18,8],["bathtub",13,10],["toilet",17,10],["washbasin",13,12],["washer",17,12]]},"furnished":true},{"id":"house.villa.court","name":"中庭别墅","type":"villa","price":68000,"footprint":{"w":24,"h":16},"door":{"edge":"bottom","offset":"center"},"walls":[],"note":"客厅居中、四周环绕房间。进门一眼看到整个家，厨房餐厅在南侧一整排。","zones":[{"id":"master","name":"主卧","rect":{"x":0,"y":0,"w":12,"h":4},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"bed2","name":"次卧","rect":{"x":12,"y":0,"w":12,"h":4},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":0,"y":4,"w":4,"h":8},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"living","name":"中庭客厅","rect":{"x":4,"y":4,"w":16,"h":8},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"closet","name":"衣帽间","rect":{"x":20,"y":4,"w":4,"h":8},"floor":{"pattern":"plank","palette":{"a":"#d9bd90","b":"#cab084","line":"rgba(130,105,70,.16)","grout":"rgba(255,245,225,.15)"}}},{"id":"kitchen","name":"厨房","rect":{"x":0,"y":12,"w":12,"h":4},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"dining","name":"餐厅","rect":{"x":12,"y":12,"w":12,"h":4},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}}],"furnish":{"wallStyle":1,"wallName":"抹茶绿","note":"精装交付：中庭客厅一套完整起居家具，两翼书房与衣帽间各自成套，厨房餐厅南北贯通。","items":[["bed",1,1],["wardrobe",6,0],["nightstand",3,1],["vanity",8,1],["bed",13,1],["wardrobe",18,1],["desk",20,1],["pc",1,5],["desk",0,7],["bookshelf",0,9],["chair",2,5],["sofa",6,5],["coffeetable",6,7],["tv",6,9],["rug_cool",10,6],["floorlamp",4,5],["painting",4,11],["aircon",18,5],["gfclock",18,10],["wardrobe",21,5],["shoecab",21,7],["mirror",21,9],["shelf",22,5],["fridge",1,13],["stove",3,13],["kitcab",6,13],["oven",8,13],["microwave",1,15],["dining",14,13],["chair",16,13],["chair",17,13]]},"furnished":true},{"id":"house.villa.loft","name":"横厅独栋","type":"villa","price":90000,"footprint":{"w":26,"h":16},"door":{"edge":"bottom","offset":"center"},"walls":[],"note":"北侧一整面 26 格宽的横厅，进门就是全屋最长的视野；南侧分成主卧、书房+卫浴、厨房餐厅三段。","zones":[{"id":"living","name":"横厅","rect":{"x":0,"y":0,"w":26,"h":8},"floor":{"pattern":"plank","palette":{"a":"#efe3c8","b":"#e4d4b4","line":"rgba(150,120,80,.14)","grout":"rgba(255,255,255,.20)"}}},{"id":"master","name":"主卧","rect":{"x":0,"y":8,"w":10,"h":8},"floor":{"pattern":"plank","palette":{"a":"#d8b07e","b":"#c99e6a","line":"rgba(120,85,45,.20)","grout":"rgba(255,240,215,.14)"}}},{"id":"study","name":"书房","rect":{"x":10,"y":8,"w":8,"h":4},"floor":{"pattern":"plank","palette":{"a":"#b88a54","b":"#a87a46","line":"rgba(80,52,24,.26)","grout":"rgba(255,235,200,.14)"}}},{"id":"bath2","name":"卫浴","rect":{"x":10,"y":12,"w":8,"h":4},"floor":{"pattern":"tile","palette":{"a":"#d6e8e0","b":"#c2d8ce","line":"rgba(90,125,110,.24)","grout":"rgba(120,155,140,.32)"}}},{"id":"kitchen","name":"厨房","rect":{"x":18,"y":8,"w":8,"h":5},"floor":{"pattern":"tile","palette":{"a":"#f4ede0","b":"#e6dcc8","line":"rgba(120,110,95,.20)","grout":"rgba(155,145,128,.30)"}}},{"id":"dining","name":"餐厅","rect":{"x":18,"y":13,"w":8,"h":3},"floor":{"pattern":"plank","palette":{"a":"#e3c896","b":"#d6b880","line":"rgba(140,105,60,.16)","grout":"rgba(255,250,230,.16)"}}}],"furnish":{"wallStyle":3,"wallName":"蔷薇粉","note":"精装交付：横厅双沙发对坐，南侧三段各成一间，书房卫浴厨房餐厅全是成套的。","items":[["sofa",2,1],["sofa",6,1],["coffeetable",2,3],["tv",2,5],["rug_warm",6,3],["floorlamp",0,1],["painting",0,6],["aircon",12,1],["gfclock",23,1],["plant",23,6],["plant",0,7],["bed",1,9],["wardrobe",5,9],["nightstand",3,9],["vanity",6,12],["pc",11,9],["desk",10,10],["bookshelf",13,9],["chair",12,9],["bathtub",11,13],["toilet",14,13],["washbasin",16,13],["washer",11,15],["fridge",19,9],["stove",21,9],["kitcab",24,9],["oven",19,11],["dining",20,14],["chair",22,14],["chair",23,14]]},"furnished":true}],"styles":{"floors":[{"id":"floor.0","index":0,"name":"原木地板","price":0,"palette":{"a":"#ecd9b0","b":"#e2cb98","line":"rgba(140,100,55,.16)","grout":"rgba(255,255,255,.22)"},"pattern":"plank"},{"id":"floor.1","index":1,"name":"灰白瓷砖","price":260,"palette":{"a":"#f3eee4","b":"#e1d9c9","line":"rgba(110,105,95,.22)","grout":"rgba(148,138,120,.32)"},"pattern":"tile"},{"id":"floor.2","index":2,"name":"暖绒地毯","price":520,"palette":{"a":"#e7c9b2","b":"#dfbda3","line":"rgba(150,100,70,.12)","grout":"rgba(255,240,225,.20)"},"pattern":"carpet"},{"id":"floor.3","index":3,"name":"深色木纹","price":760,"palette":{"a":"#c9a06c","b":"#bd9260","line":"rgba(88,58,28,.22)","grout":"rgba(255,235,200,.14)"},"pattern":"plank"}],"walls":[{"id":"wall.0","index":0,"name":"米白墙面","price":0,"palette":{"top":"#e7d3ae","right":"#d3b98d","left":"#c7ab7f","trim":"#b1926a","border":"rgba(122,82,48,.25)"}},{"id":"wall.1","index":1,"name":"抹茶绿墙","price":180,"palette":{"top":"#dfe5cc","right":"#c2cbac","left":"#b4bd9c","trim":"#8d9c74","border":"rgba(80,95,55,.28)"}},{"id":"wall.2","index":2,"name":"暮霭蓝墙","price":180,"palette":{"top":"#cfdce7","right":"#b0c0cf","left":"#a1b3c3","trim":"#7f95a9","border":"rgba(55,80,105,.26)"}},{"id":"wall.3","index":3,"name":"蔷薇粉墙","price":220,"palette":{"top":"#f1dcd8","right":"#e0bfbb","left":"#d4b1ad","trim":"#bd9894","border":"rgba(120,70,70,.24)"}}]},"rules":{"economy":{"schema":"rules/1","id":"rules.economy.default","currency":"CNY","startMoney":500,"cozy":{"bonusExpr":"min(20, round(sqrt(cozy) * 1.5))","morningScale":0.6,"tiers":[{"min":0,"name":"毛坯房","stars":0},{"min":18,"name":"有点样子","stars":1},{"min":35,"name":"温馨小屋","stars":2},{"min":55,"name":"精致小窝","stars":3},{"min":80,"name":"梦想之家","stars":4}]},"social":{"streetChatEmotion":10,"visitChatEmotion":12,"chatCooldownSec":1.5},"sellRatio":0.5,"sellNote":"卖出比例：售价 = floor(原价 × sellRatio)。0.5 = 半价回收，避免买了再卖套利","rent":{"cycleDays":7,"note":"租住的房每 7 天扣一次月租（月租 = units.rent.base + perFloor × 楼层）。钱不够就欠着，下个周期再试，不强制搬走。"},"car":{"resaleRatio":0.6,"note":"卖回 4S 店按车价 60% 回收（车一落地就贬值，比家具狠一点）"},"food":{"note":"食材制：菜市场/超市买，回家做饭消耗。uses=用掉几份，hunger/thirst 是吃完回的数值。买不到食材就下馆子，贵但不占手。 背包（bagCap）是随身容量，冰箱（max）是家里容量；两者都满就吃不下也买不进。","unit":"份","max":40,"cook":{"uses":1,"hunger":22,"label":"做饭"},"meal":{"uses":2,"hunger":40,"label":"吃饭"},"snack":{"uses":1,"hunger":18,"thirst":10,"label":"取食"},"emptyHint":"冰箱空了，去菜市场或超市买点食材","bagCap":20,"bagNote":"随身背包只装食材，上限 bagCap 份。买菜先进背包，回家自动放进冰箱；家具电器属于装修类，买了直接进仓库、不占背包，大件本来也不该背着走。"},"groceries":[{"zone":"shop3","name":"菜市场","pack":10,"price":26,"desc":"散装当季菜，单价最低"},{"zone":"shop1","name":"便利店","pack":3,"price":15,"desc":"小包装应急，单价偏高"},{"zone":"shop_super","name":"超市","pack":6,"price":24,"desc":"标准装，明码标价"}],"restaurant":{"zone":"shop_restaurant","name":"老张饭馆","note":"下馆子不消耗食材，贵在人工和房租。吃完直接回数值，不用回家。","menu":[{"id":"dish.noodle","name":"牛肉面","price":14,"hunger":40,"emotion":2,"desc":"一碗管饱，汤头够味"},{"id":"dish.rice","name":"盖浇饭","price":18,"hunger":45,"emotion":3,"desc":"两荤一素，米饭管加"},{"id":"dish.set","name":"小炒套餐","price":28,"hunger":60,"emotion":6,"desc":"现炒三个菜，坐下来慢慢吃"},{"id":"dish.soup","name":"例汤","price":6,"hunger":8,"thirst":18,"emotion":1,"desc":"今日例汤，单点也行"}]},"mart":{"zone":"shop_super","name":"惠民超市","note":"货架商品：买了立刻生效（便当/水），食材进冰箱。食材包与 groceries 里 shop_super 那条同价。","goods":[{"id":"good.bento","name":"速食便当","price":12,"hunger":30,"desc":"微波炉热两分钟"},{"id":"good.water","name":"瓶装水","price":3,"thirst":25,"desc":"常温，冰的在里面"},{"id":"good.instant","name":"泡面","price":6,"hunger":22,"thirst":-6,"desc":"顶饿，但吃完更渴"}]},"clinic":{"note":"社区医院：门诊恢复状态，买药便宜但要等冷却。价格写在这里，改数值不用碰代码。","services":[{"id":"clinic.visit","name":"门诊","price":60,"desc":"医生看一眼：情绪 +25，饥饿/口渴 +10","effects":{"emotion":25,"hunger":10,"thirst":10}},{"id":"clinic.meds","name":"买药","price":25,"desc":"一盒药：情绪 +12，30 分钟内只能买一次","effects":{"emotion":12},"cooldownMinutes":30}]},"marts":[{"zone":"shop1","name":"便利店","note":"货架小、单价高，胜在 24 小时。","goods":[{"id":"good.onigiri","name":"饭团","price":8,"hunger":22,"desc":"冷的，能顶一阵"},{"id":"good.oden","name":"关东煮","price":11,"hunger":26,"thirst":8,"desc":"热汤，冷天最实在"},{"id":"good.cannedcoffee","name":"罐装咖啡","price":7,"emotion":8,"desc":"苦得很直接"}]},{"zone":"shop2","name":"咖啡店","note":"坐一会儿比喝了什么更要紧。","goods":[{"id":"good.americano","name":"美式","price":15,"emotion":12,"thirst":10,"desc":"苦，但醒"},{"id":"good.latte","name":"拿铁","price":18,"emotion":14,"thirst":12,"hunger":5,"desc":"奶味重，暖手"},{"id":"good.croissant","name":"可颂","price":12,"hunger":20,"desc":"早上配咖啡"}]},{"zone":"shop5","name":"奶茶店","note":"甜的东西让人心情好一点。","goods":[{"id":"good.bobatea","name":"珍珠奶茶","price":14,"thirst":22,"emotion":10,"desc":"三分糖，去冰"},{"id":"good.lemonade","name":"柠檬水","price":10,"thirst":25,"desc":"酸，解渴"},{"id":"good.cake","name":"小蛋糕","price":15,"hunger":18,"emotion":6,"desc":"一口一个"}]}],"martsNote":"小店的货架：和超市 mart 同一套结构（zone/name/goods）。有柜台的店，点门面就能买；如果这家还招人，柜台底下会多一个「打卡上班」。","online":{"zone":"shop4","name":"快递站","discount":0.88,"days":1,"note":"网上下单：便宜一点，但要等一天，自己到快递站取。取回来的家具进仓库，和到店买的一样。"},"favor":{"note":"熟客好感：**按店铺记**（键是 zoneId，不是店员 id）——熟的是门面，不是那个人。等级按 at 升序，discount 是到店消费的倍率；网购不参与（否则和 88 折叠加会套利）。","dailyCap":2,"levels":[{"at":0,"name":"陌生","discount":1,"hearts":0},{"at":3,"name":"脸熟","discount":1,"hearts":1},{"at":8,"name":"熟客","discount":0.95,"hearts":2},{"at":15,"name":"朋友","discount":0.92,"hearts":3}],"gainNote":"每天每家店最多 +2 点（dailyCap）：打招呼 +1、问这家店 +1、消费 +1、在这家上一天班 +1，按先来后到累计。"}},"survival":{"schema":"rules/1","id":"rules.survival.default","stats":{"hunger":{"label":"饥饿","max":100,"initial":100,"decayPerGameMinute":0.05,"criticalBelow":35,"order":1,"color":"#d2691e","iconPath":"M4 13c1 2 3 3 6 3 2 0 3-1 3-2 0 4 3 6 7 6 1 0 2-1 2-2 0-6-4-11-9-11-3 0-6 2-9 6z","decayNote":"0.05/游戏分钟 = 72/游戏日。按平均单次 +26.8 算，一天约 2.7 顿——这就是\"三餐\"的数值基准，另外两条向它看齐。"},"thirst":{"label":"口渴","max":100,"initial":100,"decayPerGameMinute":0.05,"criticalBelow":35,"order":2,"color":"#4f8ac9","iconPath":"M12 3s6 7 6 12a6 6 0 1 1-12 0c0-5 6-12 6-12z","decayNote":"0.05/游戏分钟 = 72/游戏日。原来是 0.07（101/天，一整天补满都不够），而单次补水最大只有 +34（水槽）、日常 +18，等于一天要喝五次水才不掉格——扣得比饥饿快、补得比饥饿少，不合理。现在与饥饿同速，靠\"喝水次数本来就比吃饭多\"（单次幅度小）来区分。"},"emotion":{"label":"情绪","max":100,"initial":70,"decayPerGameMinute":0.025,"criticalBelow":30,"order":3,"color":"#e0b84f","iconPath":"M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z","decayNote":"0.025/游戏分钟 = 36/游戏日。原来是 0.06（86/天），而日常小确幸只有 +3~+5、聊天 +10、门诊 +25，数学上不可能维持，情绪会长期贴地。现在约等于「睡觉 +8、聊两次天 +20、看会儿书 +5」刚好打平——不经营会慢慢滑，经营了就稳得住。"}},"clock":{"startMinute":480,"minutesPerRealSecond":{"0":0,"1":1,"2":2},"dayRolloverMinute":1440,"timeSource":"world","timeZoneOffsetHours":8,"simMinutesPerRealSecond":1,"timeSourceNote":"world=全服统一世界时钟（服务端 /api/v1/world 懒推进，客户端插值+每 30 秒校准）。所有人共用同一个游戏日，账单周期与「每天只能上一次班」都以它为准；暂停/倍速在 world 模式下无效。realtime=跟随北京时间（单人慢节奏），game=本地自走钟（可暂停/倍速/睡觉跳时）。","simNote":"simMinutesPerRealSecond 只用于生存数值衰减；world 模式下按 WORLD.rate/60 折算（rate 60 → 1 真实秒 = 1 游戏分钟）","worldRate":60,"worldRateNote":"世界时钟倍率：游戏分钟 / 真实分钟。60 → 1 真实分钟 = 1 游戏小时，1 天 = 24 分钟真实时间。这是「每天只能上一次班 + 账单按天记」的节奏来源，改它就是改整个游戏的快慢。服务端 WORLD_RATE 环境变量可覆盖；客户端在服务端倍率异常（< 30）时用这里的值兜底。"},"work":{"durationSec":5,"pay":60,"cost":{"hunger":1.5,"thirst":2}},"sleep":{"fromHour":21,"toHour":5,"wakeMinute":420,"cost":{"hunger":12,"thirst":12}},"reservedStatTemplate":{"note":"加新资源照这个填即可，引擎（STATS 初始化 / applyFx / HUD 条）会自动生效，无需改代码","example":{"stamina":{"label":"体力","max":100,"initial":100,"decayPerGameMinute":0.08,"criticalBelow":30,"order":4,"color":"#7b9ec9","iconPath":"M13 2 3 14h7l-1 8 10-12h-7l1-8z","hudVisible":true}}},"decayNote":"三条状态的日衰减都按\"一天要做几次动作\"反推，不按直觉调：日衰减 ÷ 该状态的平均单次补充 = 一天需要的动作次数。饥饿 72÷26.8≈2.7 顿、口渴 72÷18.3≈3.9 次、情绪 36÷5.2≈7 次小确幸。改任何一条之前先跑 tools/_stataudit.py，别凭感觉。"}},"npcs":[{"id":"npc.n1","name":"老王","appearance":{"skin":"#e8a878","hair":"#7a7a7a","top":"#5fae62","bottom":"#3a3a4a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":0,"faceStyle":2,"acc":"band","age":"elder","sex":"m","facial":"stubble"},"spawn":{"x":10,"y":13},"home":"house.2栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["你是新搬来的吧。我姓王，二栋。"],"any":["嗯。","天不错。","这楼我住了二十年了。","上班去了？"],"morning":["这么早。菜市场刚开门。"],"day":["树下坐会儿，比屋里凉快。"],"eve":["下班的人都回来了。"],"night":["这么晚还不睡。"],"rain":["下雨天，膝盖先知道。"]},"visit":{"first":["进来吧，不用换鞋。"],"any":["随便坐。","水在桌上，自己倒。","电视响，我关小点。"]}}},{"id":"npc.n2","name":"阿芳","appearance":{"skin":"#f0b98e","hair":"#5a3a24","top":"#c94f6b","bottom":"#4a6b52","shoes":"#8a5a2b","face":"#3b3226","hairStyle":6,"faceStyle":0,"acc":"tote","age":"adult","sex":"f","earring":true},"spawn":{"x":38,"y":16},"home":"house.3栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["哎哟！新面孔啊，几栋的？"],"any":["吃了没啊？","你这衣服好看，哪儿买的？","小区门口那家又涨价了。"],"morning":["这么早出门，没吃早饭吧？我包了包子。"],"day":["太阳这么大，记得打伞。"],"eve":["晚上来我家坐坐呗，我炖了汤。"],"night":["这么晚才回来？路上小心啊。"],"rain":["带伞了没？没带我这有！"]},"visit":{"first":["快进来快进来，别站门口！"],"any":["坐坐坐，别客气。","我刚烤了饼干，尝尝。","你这孩子，来就来还带什么。"]}}},{"id":"npc.n3","name":"小杰","appearance":{"skin":"#f3c9a0","hair":"#c79a3a","top":"#8a6fc9","bottom":"#8a4a4a","shoes":"#f2ede2","face":"#3b3226","hairStyle":1,"faceStyle":1,"acc":"scarf","age":"teen","sex":"m","uniform":"delivery"},"spawn":{"x":14,"y":21},"home":"house.4栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["呃……你好。我四栋的。"],"any":["那个……我出来拿外卖。","昨晚打到三点，眼睛疼。"],"morning":["啊……现在几点了。"],"day":["太阳好晃眼，我回去了。"],"eve":["晚上网好，适合排位。"],"night":["这么晚……你也睡不着？"],"rain":["下雨啊……那点外卖吧。"]},"visit":{"first":["进来吧，有点乱……别笑我。"],"any":["那个……随便坐。","显示器攒了半年才买上。","先玩会儿？"]}},"spawnNote":"证券营业部占了原来 (16,21) 的位置，小杰挪到隔壁，仍在中区溜达"},{"id":"npc.n4","name":"王婶","appearance":{"skin":"#f0b98e","hair":"#8d8478","top":"#6fae6f","bottom":"#5d5a78","shoes":"#8a5a2b","face":"#3b3226","hairStyle":2,"faceStyle":0,"acc":"apron","age":"elder","sex":"f","uniform":"food"},"spawn":{"x":46,"y":21},"home":"house.5栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["你就是新来的吧？我五栋的，姓王。"],"any":["三楼那家又换人了。","你脸色不太好，早点睡。","别老点外卖，自己做点。"],"morning":["早晨空气好，多走走。"],"day":["晒被子了吗？今天太阳好。"],"eve":["晚上记得关好门窗。"],"night":["还不睡？年轻也不能这么熬。"],"rain":["下雨了，收衣服！"]},"visit":{"first":["来啦，快坐，我给你倒水。"],"any":["家里乱，别嫌弃。","我一个人住，清静。","你爸妈在老家吧？常打电话。"]}}},{"id":"npc.n5","name":"老周","appearance":{"skin":"#e8a878","hair":"#5a3a24","top":"#c8964a","bottom":"#3a3a4a","shoes":"#2b2b2b","face":"#3b3226","hairStyle":3,"faceStyle":2,"acc":"cane","age":"elder","sex":"m","facial":"mustache"},"spawn":{"x":18,"y":41},"home":"house.6栋","behavior":{"kind":"wander","radius":{"x":4,"y":3},"waitSec":[1.5,4]},"dialogues":{"street":{"first":["新邻居？我六栋的，姓周。"],"any":["急不来的。","这几盆花，我浇了三年。","下棋不？石桌那边。"],"morning":["早上浇花，最舒坦。"],"day":["这日头，花喜欢。"],"eve":["太阳一落，虫就出来了。"],"night":["夜里的风，跟白天不一样。"],"rain":["下雨好，省得我浇水。"]},"visit":{"first":["进来，随便看看。"],"any":["花得放窗边才活得了。","坐，别急，慢慢说。","下一盘？我让你两个子。"]}}}],"maps":{"home":{"schema":"map/1","id":"map.home","renderer":"interior","note":"家 = 房子 + 院子；网格尺寸由房型推导（室内 w/h + 两侧各 3 格院子）","base":{"houseOrigin":{"x":3,"y":3},"yardMargin":3},"yardDecor":[{"kind":"tree","at":[4,1]},{"kind":"flower","at":[9,2]},{"kind":"tree","at":[15,1]},{"kind":"bush","at":[6,1]},{"kind":"flower","at":[13,2]},{"kind":"flower","at":[4,14]},{"kind":"bush","at":[9,14]},{"kind":"flower","at":[15,14]},{"kind":"tree","at":[6,13]},{"kind":"tree","at":[13,13]},{"kind":"tree","at":[1,4]},{"kind":"flower","at":[2,7]},{"kind":"bush","at":[1,11]},{"kind":"flower","at":[2,2]},{"kind":"bush","at":[18,4]},{"kind":"tree","at":[17,7]},{"kind":"flower","at":[18,11]},{"kind":"tree","at":[17,2]}],"portals":[{"id":"home.toStreet","role":"exit","at":{"x":1,"y":"bottom-1"},"target":"map.street"},{"id":"home.door","role":"innerDoor","at":{"edge":"bottom","offset":"center"},"target":null}],"spawn":{"rule":"houseCenter","fallback":"nearestFree"}},"street":{"schema":"map/1","id":"map.street","renderer":"neighborhood","grid":{"w":88,"h":48},"border":{"note":"边界缓冲带：绿篱与内容之间留出的草坪格数，避免楼贴着围栏","margin":2},"wild":{"note":"地图外围的荒野：按哈希程序化生成，不占数据、不参与寻路。将来做\"无限画布\"时，新的街区只要往 zones/houses 里加，外围自动过渡。","treeDensity":0.045,"density":0.12},"layoutNote":"楼高 3 格、屋顶向上延伸约 6 格：同一条街上不要排两排楼，否则南排会挡住北排门口的人。商铺一律单排、门朝南，且必须落在铺装带（pavement）上，不能压道路。林荫北路被公共服务区大院截成东西两段——大院是不通车的，横向绕行请走中央大道。东商业街 (44,25) 起，和西边商业街同高，快递站/奶茶店在这一排。","houses":[{"id":"house.2栋","label":"2栋","rect":{"x":4,"y":4,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n1"},{"id":"house.3栋","label":"3栋","rect":{"x":10,"y":4,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n2"},{"id":"house.4栋","label":"4栋","rect":{"x":16,"y":4,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":4,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.5栋","label":"5栋","rect":{"x":4,"y":8,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.6栋","label":"6栋","rect":{"x":10,"y":8,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.7栋","label":"7栋","rect":{"x":16,"y":8,"w":4,"h":3},"palette":{"body":"#cfb894"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.8栋","label":"8栋","rect":{"x":54,"y":4,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.9栋","label":"9栋","rect":{"x":59,"y":4,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.10栋","label":"10栋","rect":{"x":54,"y":8,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":4,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n3"},{"id":"house.11栋","label":"11栋","rect":{"x":59,"y":8,"w":4,"h":3},"palette":{"body":"#cfb894"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.12栋","label":"12栋","rect":{"x":12,"y":14,"w":4,"h":3},"palette":{"body":"#d8b48a"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.13栋","label":"13栋","rect":{"x":12,"y":18,"w":4,"h":3},"palette":{"body":"#cfa87f"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.14栋","label":"14栋","rect":{"x":46,"y":14,"w":4,"h":3},"palette":{"body":"#dcc09a"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n4","villa":true},{"id":"house.15栋","label":"15栋","rect":{"x":52,"y":14,"w":4,"h":3},"palette":{"body":"#d3ae86"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.16栋","label":"16栋","rect":{"x":58,"y":14,"w":4,"h":3},"palette":{"body":"#c9a27a"},"floors":1,"door":{"edge":"bottom","offset":"center"},"owner":null,"villa":true},{"id":"house.17栋","label":"17栋","rect":{"x":46,"y":18,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.18栋","label":"18栋","rect":{"x":52,"y":18,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.19栋","label":"19栋","rect":{"x":58,"y":18,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.公寓楼","label":"公寓楼","rect":{"x":5,"y":39,"w":2,"h":3},"palette":{"body":"#cfc7b6"},"floors":18,"door":{"edge":"bottom","offset":"center"},"owner":null,"home":true},{"id":"house.20栋","label":"20栋","rect":{"x":12,"y":38,"w":4,"h":3},"palette":{"body":"#c7ab7f"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":"npc.n5"},{"id":"house.21栋","label":"21栋","rect":{"x":26,"y":38,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.22栋","label":"22栋","rect":{"x":33,"y":38,"w":4,"h":3},"palette":{"body":"#cfb894"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.23栋","label":"23栋","rect":{"x":48,"y":38,"w":4,"h":3},"palette":{"body":"#e0c9a0"},"floors":2,"door":{"edge":"bottom","offset":"center"},"owner":null},{"id":"house.24栋","label":"24栋","rect":{"x":55,"y":38,"w":4,"h":3},"palette":{"body":"#d3b98d"},"floors":3,"door":{"edge":"bottom","offset":"center"},"owner":null}],"trees":[],"treeRules":{"note":"树的播种规则：草坪按哈希自动种，避免手工挪坐标；门口与路口保留空地","lawnDensity":0.05,"gardenDensity":0.07,"clearNearDoor":2},"portals":[{"id":"street.toHome","role":"enter","at":{"x":7,"y":43},"target":"map.home"}],"spawn":{"x":7,"y":43},"zonesNote":"分区表：按面积从小到大匹配（小区域覆盖大区域）；kind=shop 是店铺，kind=civic 是公共服务建筑","zones":[{"id":"road_h1","kind":"road","x":3,"y":12,"w":18,"h":2,"label":"林荫北路","note":"西段：x3..20，到公共服务区大院西墙为止"},{"id":"road_h1e","kind":"road","x":37,"y":12,"w":46,"h":2,"label":"林荫北路","note":"东段：x37..82，从大院东墙外接上"},{"id":"road_h2","kind":"road","x":3,"y":23,"w":82,"h":2,"label":"中央大道","note":"主干道，横贯全图（x3..84）"},{"id":"road_h3","kind":"road","x":3,"y":35,"w":82,"h":2,"label":"南环路"},{"id":"road_v1","kind":"road","x":20,"y":3,"w":2,"h":42,"label":"西支路"},{"id":"road_v2","kind":"road","x":42,"y":3,"w":2,"h":42,"label":"东支路"},{"id":"park","kind":"park","x":23,"y":3,"w":18,"h":8,"label":"街心公园"},{"id":"pond","kind":"pond","x":27,"y":5,"w":8,"h":4,"label":"荷花池"},{"id":"garden_ne","kind":"garden","x":45,"y":3,"w":8,"h":8,"label":"东花园"},{"id":"parking","kind":"parking","x":4,"y":14,"w":6,"h":5,"label":"停车位"},{"id":"garden_w","kind":"garden","x":4,"y":20,"w":6,"h":2,"label":"西花坛"},{"id":"garden_c","kind":"garden","x":23,"y":14,"w":18,"h":8,"label":"中央绿地"},{"id":"pavement","kind":"pavement","x":3,"y":25,"w":17,"h":10,"label":"商业街"},{"id":"shop1","kind":"shop","x":4,"y":26,"w":5,"h":3,"label":"便利店","tint":"#c85a4a"},{"id":"shop2","kind":"shop","x":10,"y":26,"w":5,"h":3,"label":"咖啡店","tint":"#6f8ba8"},{"id":"shop3","kind":"shop","x":15,"y":26,"w":4,"h":3,"label":"菜市场","tint":"#6fae6f"},{"id":"shop4","kind":"shop","x":46,"y":26,"w":4,"h":3,"label":"快递站","tint":"#c8964a","note":"原 (42,23) 压在中央大道和东支路上，移到东商业街北排"},{"id":"plaza","kind":"plaza","x":24,"y":26,"w":16,"h":7,"label":"中心广场"},{"id":"court","kind":"court","x":66,"y":26,"w":6,"h":5,"label":"篮球场"},{"id":"sand","kind":"sand","x":73,"y":26,"w":9,"h":5,"label":"儿童乐园"},{"id":"shop5","kind":"shop","x":53,"y":26,"w":4,"h":3,"label":"奶茶店","tint":"#d08aa0","note":"原 (54,23) 压在中央大道上，移到东商业街北排"},{"id":"hospital","kind":"civic","x":22,"y":12,"w":6,"h":4,"label":"社区医院","tint":"#6fa8c9"},{"id":"school","kind":"civic","x":29,"y":12,"w":7,"h":4,"label":"实验小学","tint":"#c9a24a"},{"id":"police","kind":"civic","x":22,"y":17,"w":5,"h":3,"label":"派出所","tint":"#4a6fa8"},{"id":"property","kind":"civic","x":29,"y":17,"w":5,"h":3,"label":"物业公司","tint":"#7a9a6a"},{"id":"shop_car","kind":"shop","x":44,"y":31,"w":5,"h":3,"label":"4S 店","tint":"#8a8f98"},{"id":"parking_4s","kind":"parking","x":50,"y":31,"w":4,"h":3,"label":"4S 停车场"},{"id":"shop_lottery","kind":"shop","x":16,"y":15,"w":4,"h":3,"label":"彩票站","tint":"#c86f9a","note":"原 (16,16)：南边缘正好是证券营业部的北墙，门口开在人家屋里。上移一格，y18 让出过道。"},{"id":"shop_restaurant","kind":"shop","x":4,"y":31,"w":5,"h":3,"label":"老张饭馆","tint":"#c9803f"},{"id":"shop_super","kind":"shop","x":10,"y":31,"w":6,"h":3,"label":"惠民超市","tint":"#6f9a8a"},{"id":"shop_bank","kind":"shop","x":16,"y":31,"w":4,"h":3,"label":"民生银行","tint":"#5b7fa6"},{"id":"shop_stock","kind":"shop","x":16,"y":19,"w":4,"h":3,"label":"证券营业部","tint":"#8a6aa6"},{"id":"shop_pet","kind":"shop","x":37,"y":37,"w":5,"h":4,"label":"宠物之家","tint":"#cf7d5e","note":"原来在 (18,36)，同时压在南环路(y35-36)和西支路(x20-21)上，等于把店盖在十字路口。移到南环路南侧的住宅带空位，门前(y41)留空。"},{"id":"pavement_e","kind":"pavement","x":44,"y":25,"w":17,"h":10,"label":"东商业街","note":"东半区原来没有商铺铺装带，快递站/奶茶店只能骑在中央大道上；补一条铺装，把两家接进来"},{"id":"park_e","kind":"park","x":68,"y":4,"w":14,"h":8,"label":"东公园","note":"地图东扩之后这片原本是纯野地，加个公园当东侧地标；林荫北路 y12 从它南边过"}],"zoneKinds":{"road":{"note":"沥青路面","ground":"#8f8b82"},"plaza":{"note":"广场砖石","ground":"#d5c9ae"},"court":{"note":"塑胶球场 + 白线","ground":"#6f9c6a"},"pavement":{"note":"商业街铺装","ground":"#cbc0a6"},"sand":{"note":"儿童乐园沙地","ground":"#e2d2ad"},"parking":{"note":"停车位（沥青 + 车位线）","ground":"#8a8880"},"park":{"note":"公园草坪","ground":"#93c07a"},"pond":{"note":"水面（不可行走，整体绘制）","ground":"#a9c489"},"garden":{"note":"花坛草坪","ground":"#8fbb72"},"shop":{"note":"店铺建筑占地（阻挡通行）"},"lawn":{"note":"默认草坪，颜色随季节"},"civic":{"note":"公共服务建筑（医院/学校/派出所/物业），楼体占格会阻挡"}},"fences":{"note":"围栏不手写整圈坐标：areas 给一个矩形（院落边界），gates 给大门格；客户端沿矩形画一圈栏杆、门格留洞，围栏格同时参与碰撞。border 是小区围墙。","border":{"style":"hedge"},"areas":[{"id":"civic_block","style":"rail","rect":{"x":21,"y":11,"w":16,"h":11},"note":"公共服务区院落：医院/小学/派出所/物业都在围墙里，南侧两个大门（x=27、x=34）通向中央大道","gates":[{"x":27,"y":22},{"x":34,"y":22}]}]},"mailbox":{"x":7,"y":42,"label":"信箱"},"mailboxNote":"楼下的信箱：账单一到就投这里，点开看通知、逐条支付。位置必须在公寓楼门口附近的可走格上。","financeNote":"金融一条街：商业街南排东端是银行（shop_bank），彩票站正南是证券营业部（shop_stock）。两者都只做「钱的生意」——银行给利息也给贷款，券商收手续费也承担涨跌。","busStops":[{"id":"stop.w","name":"西站","x":12,"y":25,"note":"商业街东口，中央大道北侧"},{"id":"stop.e","name":"东站","x":56,"y":25,"note":"东商业街，中央大道北侧"}],"busStopNote":"公交站：站在站牌旁边点它就能上车。地图扩到 88 格之后，从西头走到东头要 20 多秒，两个站各在中央大道两头，花 ¥2 坐过去比走路快。座位必须落在可走格上、不能压道路。"}},"ui":{"app.title":"我的 2.5D 小屋","hud.work":"工作 +¥","hud.shop":"商店","hud.char":"人物","hud.edit":"整理","hud.decor":"装修","hud.expand":"房型","hud.scene.street":"小区","hud.scene.home":"回家","hud.home":"回原位","panel.shop":"家具商店","panel.inventory":"我的仓库","panel.decor":"房间装修","panel.upgrade":"房型扩建","stat.hunger":"饥饿","stat.thirst":"口渴","stat.emotion":"情绪","stat.money":"金钱","stat.cozy":"装修度","hud.version":"版本"}};

  __exports.CONTENT = CONTENT;
});

__define("src/version.generated.js", function(__exports, __require){
// 由 tools/build.mjs 生成，请勿手改（源：version.json + content/*.json）
const BUILD = {
  "appVersion": "1.71.0",
  "minAppVersion": "1.6.0",
  "saveSchema": 22,
  "contentVersion": 1,
  "contentHash": "49e99f81530f",
  "builtAt": "2026-11-12T13:29:17.561Z",
  "modules": {
    "content/achievements/achievements.json": {
      "version": 4,
      "hash": "7c1e700a25c3"
    },
    "content/bank/bank.json": {
      "version": 2,
      "hash": "fe2d1cad7a50"
    },
    "content/business/business.json": {
      "version": 3,
      "hash": "5e5248ad66a2"
    },
    "content/careers/jobs.json": {
      "version": 6,
      "hash": "ed778bd88d35"
    },
    "content/catalog/categories.json": {
      "version": 1,
      "hash": "5599bf855145"
    },
    "content/catalog/furniture.core.json": {
      "version": 3,
      "hash": "634f86f85e9e"
    },
    "content/catalog/home.goods.json": {
      "version": 1,
      "hash": "67bec37ae834"
    },
    "content/catalog/items.decor.json": {
      "version": 1,
      "hash": "f4800b19fb18"
    },
    "content/characters/npcs.neighbors.json": {
      "version": 25,
      "hash": "0360903f004a"
    },
    "content/characters/palettes.json": {
      "version": 1,
      "hash": "9cf60aa16886"
    },
    "content/characters/player.default.json": {
      "version": 1,
      "hash": "1b632f4c14f5"
    },
    "content/environment/ambient.json": {
      "version": 5,
      "hash": "089ad64b6a33"
    },
    "content/environment/climate.json": {
      "version": 4,
      "hash": "ef5ded811ec6"
    },
    "content/environment/seasons.json": {
      "version": 2,
      "hash": "0611393d2e77"
    },
    "content/house/levels.json": {
      "version": 3,
      "hash": "416b75486996"
    },
    "content/house/residence.json": {
      "version": 5,
      "hash": "8a974e46249c"
    },
    "content/house/styles.json": {
      "version": 1,
      "hash": "558eb9062d64"
    },
    "content/interaction/verbs.json": {
      "version": 1,
      "hash": "7b5108c68803"
    },
    "content/lottery/lottery.json": {
      "version": 1,
      "hash": "b1cd4c62e2d5"
    },
    "content/maps/home.map.json": {
      "version": 1,
      "hash": "fa7263c09f78"
    },
    "content/maps/street.map.json": {
      "version": 23,
      "hash": "e73a869d9694"
    },
    "content/pets/pets.json": {
      "version": 1,
      "hash": "07c5b1133cb7"
    },
    "content/rules/bills.json": {
      "version": 1,
      "hash": "2ff3cf93c8a8"
    },
    "content/rules/economy.json": {
      "version": 8,
      "hash": "b38c4438ae77"
    },
    "content/rules/survival.json": {
      "version": 6,
      "hash": "75e1f3ea0d42"
    },
    "content/stock/stock.json": {
      "version": 2,
      "hash": "b628686e5439"
    },
    "content/ui/strings.zh-CN.json": {
      "version": 2,
      "hash": "9afa3735c2fe"
    },
    "content/vehicles/cars.json": {
      "version": 2,
      "hash": "e28eaf242a03"
    },
    "src/content/generated.js": {
      "version": null,
      "hash": "49e99f81530f"
    },
    "src/core/clock.js": {
      "version": null,
      "hash": "a2b91dcc4b8a"
    },
    "src/core/content.js": {
      "version": null,
      "hash": "6d6205b8003f"
    },
    "src/core/environment.js": {
      "version": null,
      "hash": "3f8e2ce2afa1"
    },
    "src/core/pathfind.js": {
      "version": null,
      "hash": "c0780f70037e"
    },
    "src/core/rules.js": {
      "version": null,
      "hash": "32f8a5521e3f"
    },
    "src/core/version.js": {
      "version": null,
      "hash": "b8ac44330b44"
    },
    "src/net/save-provider.js": {
      "version": null,
      "hash": "cbe49ee0a2aa"
    },
    "src/net/social.js": {
      "version": null,
      "hash": "ba87b3db7f3e"
    }
  }
};

  __exports.BUILD = BUILD;
});

  window.HomeCore = {
  content: __require("src/core/content.js"),
  pathfind: __require("src/core/pathfind.js"),
  rules: __require("src/core/rules.js"),
  save: __require("src/net/save-provider.js"),
  social: __require("src/net/social.js"),
  version: __require("src/core/version.js"),
  environment: __require("src/core/environment.js"),
  clock: __require("src/core/clock.js")
  };
})();
/* 用版本模块里的时间，而不是当场取：这样重复构建能产出完全一样的文件
 * （否则每次都会因为这一行产生差异，补丁跑两遍就留下一个只含产物的空提交） */
