/**
 * 内容层加载器：把 content/ 的多个包索引成"运行时只读数据"，
 * 并提供「旧结构适配器」——让尚未模块化的引擎代码能用一行接入，逐步迁移。
 *
 * 数据来自 content/generated.js（由 tools/build.mjs 从 content/*.json 生成），
 * 因此在单文件分发时也不需要 fetch。
 */
import { CONTENT } from '../content/generated.js';

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
  const sites = [];
  /* 职业表：人物身份三件套之一是 job，名字与默认制服都写在这里。
   * 台词认人、档案卡、校验器读同一份，避免"代码里一套中文、内容里另一套"。 */
  let jobs = [];
  for (const [id, pack] of Object.entries(packs)){
    if (!id.startsWith('characters/')) continue;
    if (pack.npcs) npcs.push(...pack.npcs);
    if (Array.isArray(pack.clerks)) clerks.push(...pack.clerks);
    if (Array.isArray(pack.sites)) sites.push(...pack.sites);
    if (Array.isArray(pack.jobs)) jobs = jobs.concat(pack.jobs);
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
    sites,
    jobs,
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
export function indexContent(raw){
  const r = raw || {};
  const packs = r.packs || {};
  return buildIndex(packs, r.manifest || {});
}

const packStore = Object.assign({}, CONTENT.packs || {});
export const content = buildIndex(packStore, CONTENT.manifest || {});

/**
 * 模块级热更新：只替换一个内容包并重建索引。
 * 返回 true 表示已生效（调用方随后需要刷新自己的"旧结构"副本）。
 */
export function applyPack(packId, packData){
  if (!packId || !packData) return false;
  packStore[packId] = packData;
  Object.assign(content, buildIndex(packStore, CONTENT.manifest || {}));
  return true;
}

/** 当前已加载的模块（id → pack） */
export function loadedPacks(){
  return packStore;
}

/* ------------------------- 旧结构适配器 -------------------------
 * 目标：不改动原有引擎逻辑，只把数据来源换掉。
 * 一旦某个系统完成模块化，就可以直接读 content.catalogById，不再用这里。 */

/** → [{id,name,cat,catLabel,price,w,h,cozy,action,fx,acts,desc,walk,wallMounted}]
 *  acts 是归一化后的动作数组（支持一个物品多个动作 → UI 弹菜单）；
 *  action/fx 是旧字段，保留给尚未迁移的代码。 */
export function toLegacyCatalog(){
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
export function verbs(){ return content.verbs; }
/** 物品分类表 */
export function categories(){ return content.categories; }
/** 资源条定义（顺序 = HUD 顺序） */
export function statsDef(){ return content.stats; }
/** 地图（含分区/装饰/传送门） */
export function maps(){ return content.maps; }
/** 邻居 NPC（外观 / 出生点 / 归属房屋 / 台词） */
export function npcs(){ return content.npcs; }
/** 店员：站在自家门口，认上下班时间 */
export function clerks(){ return content.clerks; }
/** 场所里的人：学校门口 / 球场 / 公园 / 儿童乐园，只在自己那块地方活动 */
export function sites(){ return content.sites; }
/** 职业表：{ id, name, uniform? }。身份三件套 = age 阶段 / sex / job */
export function jobs(){ return content.jobs; }

/** 气候：天气权重 + 一天的光照关键帧 */
export function climate(){ return content.climate; }
/** 四季配置 */
export function seasons(){ return content.seasons; }
/** 环境细节（随机物密度、车流） */
export function ambient(){ return content.ambient; }
/** 职业岗位（绑定地图分区的可上班点） */
export function careers(){ return content.careers; }
/** 熟练等级规则：{ maxLevel, payPerLevel, shiftsPerLevel } */
export function careerCfg(){ return content.careerCfg || {}; }
/** 生活目标（成就）：目标由 kind 推导，进度不存档 */
export function achievements(){ return content.achievements; }
/** 成就分组（顺序即面板分组顺序） */
export function achievementGroups(){ return content.achGroups; }
/** 住址体系（楼栋/楼层/房号规则） */
export function residence(){ return content.residence; }
/** 车款（4S 店卖的） */
export function cars(){ return content.cars; }
/** 4S 店停车场配置 */
export function carParking(){ return content.carParking; }
/** 彩票规则（号码/奖级/票价） */
export function lottery(){ return content.lottery; }

/** → [{name,w,h,price,walls:[[x,y],...],zones:[{id,name,x,y,w,h,floor}]}]（引擎里 walls 用绝对坐标数组形式；zones 为地面分区，坐标相对 footprint 左上角） */
export function toLegacyHouseLevels(){
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

export function toLegacyFloorStyles(){
  return content.floors.map(f => Object.assign(
    { name: f.name, price: f.price, pattern: f.pattern },
    f.palette
  ));
}

export function toLegacyWallStyles(){
  return content.walls.map(w => Object.assign(
    { name: w.name, price: w.price },
    w.palette
  ));
}

/** → { DECAY, EMOTION_DECAY, WORK_PAY, WORK_TIME, WORK_COST, STATS_INIT, CLOCK } */
export function toLegacyRules(){
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
export function catalogItem(id){ return content.catalogById[id] || null; }
export function cozyOf(id){ const it = content.catalogById[id]; return it ? it.cozy : 0; }
export function economy(){ return content.rules.economy || {}; }
/** 缴费通知模板（账单周期、金额算法字段、逾期规则） */
export function bills(){ return content.rules.bills || {}; }
/** 功能点承包：可承包的店铺、承包金、日收益、承包周期 */
export function business(){ return content.business || { shops: [], termDays: 30 }; }
/** 银行：活期利率、定期档位、贷款档位 */
export function bank(){ return content.bank || {}; }
/** 股市：可交易标的、手续费、价格模型参数 */
export function stock(){ return content.stock || { stocks: [], feeRate: 0.0015 }; }
/** 宠物：可领养猫狗、需求衰减、互动动作、宠物粮配置 */
export function pets(){ return content.pets; }
