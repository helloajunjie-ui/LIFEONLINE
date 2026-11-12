#!/usr/bin/env node
/**
 * 内容层工具链（单一数据源 → 校验 → 打包）
 *
 *   node tools/content.mjs extract    从 2.5D小屋.html 抽取内容 → content/ 与 assets/
 *   node tools/content.mjs validate   校验内容包（引用完整性、数值范围、地图可达性）
 *   node tools/content.mjs bundle     打包成服务端用的 server/content/content.json
 *   node tools/content.mjs all        extract + validate + bundle
 *
 * 设计原则：
 *   1. content/ 是唯一真相；server/content/content.json 只是构建产物
 *   2. 实体 id 一经发布**永不改名**（存档里存的是 id，改名等于删档）
 *   3. 跨包引用必须能被校验器静态检查出来，不允许"运行时才炸"
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

const ROOT = 'E:/QHTML';
const GAME = path.join(ROOT, '2.5D小屋.html');
const CONTENT = path.join(ROOT, 'content');
const ASSETS = path.join(ROOT, 'assets');
/** 引擎 VERB_HOOKS 里已注册的特殊行为。新增 hook 时必须同时改引擎与这里（否则校验器报错） */
const HOOK_WHITELIST = ['sleepToMorning', 'npcTalk'];

const BUNDLE = path.join(ROOT, 'server', 'content', 'content.json');
const VERSIONS = path.join(CONTENT, 'versions.json');

/* ------------------------- 模块版本台账 -------------------------
 * 每个内容包有独立的 {version, hash, updatedAt}：
 *   hash 由内容自动计算（去掉了 generatedAt 这类易变字段）
 *   version 在 hash 变化时自动 +1 —— 不需要人手动记，也不会漏
 * 这样"哪一块变了"是可核查的，客户端也只更新变化的那一块。 */
function stableStringify(v){
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function packHash(pack){
  const clone = JSON.parse(JSON.stringify(pack));
  delete clone.generatedAt;
  return crypto.createHash('sha256').update(stableStringify(clone)).digest('hex').slice(0, 12);
}
function loadVersions(){
  try { return JSON.parse(fs.readFileSync(VERSIONS, 'utf8')); } catch(e){ return {}; }
}
/** 比对哈希，给每个包算出（可能递增的）版本号并落盘 */
function bumpVersions(packMap){
  const prev = loadVersions();
  const next = {};
  let bumpCount = 0;
  for (const [id, pack] of Object.entries(packMap)){
    const hash = packHash(pack);
    const old = prev[id];
    if (!old){
      next[id] = { version: 1, hash, updatedAt: new Date().toISOString() };
      bumpCount++;
      continue;
    }
    if (old.hash === hash){
      next[id] = { version: old.version, hash, updatedAt: old.updatedAt };
    } else {
      next[id] = { version: old.version + 1, hash, updatedAt: new Date().toISOString() };
      bumpCount++;
      console.log(`  ↑ ${id}  ${old.version} → ${old.version + 1}`);
    }
  }
  fs.writeFileSync(VERSIONS, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { versions: next, bumpCount };
}

const src = readOrDie(GAME);
const problems = [];

/* ============================== 解析工具 ============================== */

function readOrDie(p){
  if (!fs.existsSync(p)) { console.error('找不到文件: ' + p); process.exit(2); }
  return fs.readFileSync(p, 'utf8');
}

/** 取 `const NAME = <literal>;` 的字面量并求值（支持对象/数组/嵌套） */
function grabValue(name){
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*');
  const m = re.exec(src);
  if (!m) throw new Error('未找到常量 ' + name);
  let i = m.index + m[0].length;
  const start = i;
  let depth = 0, inStr = null;
  for (; i < src.length; i++){
    const ch = src[i];
    if (inStr){
      if (ch === '\\'){ i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`'){ inStr = ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    else if (ch === ']' || ch === '}' || ch === ')') depth--;
    else if (ch === ';' && depth === 0) break;
  }
  const literal = src.slice(start, i);
  return vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 3000 });
}

function grabNumber(re, label){
  const m = re.exec(src);
  if (!m) throw new Error('未找到 ' + label);
  return Number(m[1]);
}

const CATEGORY = { '家具': 'furniture', '电器': 'appliance', '装饰': 'decor' };

/* ============================== extract ============================== */

function extract(){
  // 数据已经搬到 content/（引擎改为读内容层），此时再从 HTML 抽取是反向操作。
  // 直接拒绝，避免把 content/ 里手工维护的内容覆盖掉。
  if (!/const FURNITURE_CATALOG = \[/.test(src)){
    console.error('extract 已停用：FURNITURE_CATALOG 现在来自 content/catalog/*.json，不再是 HTML 里的字面量。');
    console.error('  日常改内容：直接编辑 content/*.json，然后运行 node tools/content.mjs bundle');
    console.error('  只有从旧版单文件重建内容时才需要 extract（需先把字面量放回 HTML）。');
    process.exit(3);
  }
  fs.mkdirSync(CONTENT, { recursive: true });
  fs.mkdirSync(path.join(ASSETS, 'furniture'), { recursive: true });

  const originMatch = /const HOUSE_X = (\d+),\s*HOUSE_Y = (\d+)/.exec(src);
  if (!originMatch) throw new Error('未找到 HOUSE_X / HOUSE_Y');
  const HOUSE_X = Number(originMatch[1]);
  const YARD = Number(originMatch[2]);

  /* ---- 1. 家具目录 ---- */
  const catalog = grabValue('FURNITURE_CATALOG');
  const svgDefs = grabSvgDefs();

  const toItem = (d, i) => {
    const asset = svgDefs[d.id];
    return {
      id: d.id,
      name: d.name,
      category: CATEGORY[d.cat] || 'misc',
      tags: deriveTags(d),
      price: d.price,
      footprint: { w: d.w, h: d.h },
      cozy: d.cozy || 0,
      placement: {
        indoor: true,
        walkable: !!d.walk,
        wallMounted: false,
        blocksPath: !d.walk,
        unique: false
      },
      interaction: d.action ? {
        verb: d.action,
        durationSec: 2,
        effects: d.fx || {},
        special: d.action === 'sleep' ? 'sleepToMorning' : null
      } : null,
      asset: asset ? {
        kind: 'svg',
        ref: 'assets/furniture/' + d.id + '.svg',
        size: { w: asset.w, h: asset.h },
        anchor: { ax: asset.ax, ay: asset.ay }
      } : null,
      ui: { icon: d.id, desc: d.desc, order: i * 10 }
    };
  };

  const items = catalog.map(toItem);
  const core = items.filter(it => ['bed','sofa','dining','fridge','stove','sink','tv','stereo','bookshelf','plant','wardrobe','lamp','toilet','bathtub','pc'].includes(it.id));
  const decor = items.filter(it => !core.includes(it));

  writePack('catalog/furniture.core.json', {
    schema: 'catalog/1',
    note: '核心家具：有交互数值效果的一批',
    items: core
  });
  writePack('catalog/items.decor.json', {
    schema: 'catalog/1',
    note: '纯装修装饰：只贡献装修度，或提供可走/可贴墙等放置特性',
    items: decor
  });

  /* ---- 2. SVG 素材落盘 ---- */
  let svgCount = 0;
  for (const [id, def] of Object.entries(svgDefs)){
    fs.writeFileSync(path.join(ASSETS, 'furniture', id + '.svg'), def.svg.trim() + '\n', 'utf8');
    svgCount++;
  }

  /* ---- 3. 房型 / 风格 ---- */
  const levels = grabValue('HOUSE_LEVELS').map((lv, i) => ({
    id: 'house.lv' + i,
    level: i,
    name: lv.name,
    price: lv.price,
    footprint: { w: lv.w, h: lv.h },
    // 隔墙坐标相对房子左上角外墙（HOUSE_X/HOUSE_Y 由引擎给出）
    walls: lv.walls.map(w => ({ x: w[0], y: w[1] })),
    zones: deriveZones(lv),
    door: { edge: 'bottom', offset: 'center' }
  }));

  writePack('house/levels.json', {
    schema: 'house/1',
    note: '房型等级：升级只扩大室内区块，左上角固定不动；walls 为室内隔断（留门洞）',
    origin: { x: HOUSE_X, y: YARD },
    yardMargin: 3,
    levels
  });

  const floors = grabValue('FLOOR_STYLES');
  const walls = grabValue('WALL_STYLES');
  writePack('house/styles.json', {
    schema: 'styles/1',
    floors: floors.map((f, i) => ({ id: 'floor.' + i, index: i, name: f.name, price: f.price, palette: { a: f.a, b: f.b, line: f.line, grout: f.grout }, pattern: f.pattern })),
    walls: walls.map((w, i) => ({ id: 'wall.' + i, index: i, name: w.name, price: w.price, palette: { top: w.top, right: w.right, left: w.left, trim: w.trim, border: w.border } }))
  });

  /* ---- 4. 地图 ---- */
  const yardDecor = grabValue('YARD_DECOR');
  writePack('maps/home.map.json', {
    schema: 'map/1',
    id: 'map.home',
    renderer: 'interior',
    note: '家 = 房子 + 院子；网格尺寸由房型推导（室内 w/h + 两侧各 3 格院子）',
    base: { houseOrigin: { x: HOUSE_X, y: YARD }, yardMargin: 3 },
    yardDecor: yardDecor.map(d => ({ kind: d.kind, at: [d.gx, d.gy] })),
    portals: [
      { id: 'home.toStreet', role: 'exit', at: { x: 1, y: 'bottom-1' }, target: 'map.street' },
      { id: 'home.door', role: 'innerDoor', at: { edge: 'bottom', offset: 'center' }, target: null }
    ],
    spawn: { rule: 'houseCenter', fallback: 'nearestFree' }
  });

  const STREET_W = grabNumber(/const STREET_W = (\d+), STREET_H = (\d+)/, 'STREET_W');
  const STREET_H = grabNumber(/const STREET_W = \d+, STREET_H = (\d+)/, 'STREET_H');
  const houses = grabValue('STREET_HOUSES');
  const trees = grabValue('STREET_TREES');
  const neighbors = grabValue('NEIGHBORS');
  writePack('maps/street.map.json', {
    schema: 'map/1',
    id: 'map.street',
    renderer: 'neighborhood',
    grid: { w: STREET_W, h: STREET_H },
    houses: houses.map((h, i) => ({
      id: 'house.' + h.name,
      label: h.name,
      rect: { x: h.x, y: h.y, w: h.w, h: h.h },
      palette: { body: h.color },
      door: { edge: 'bottom', offset: 'center' },
      owner: neighbors[i] ? 'npc.' + neighbors[i].id : null
    })),
    trees: trees.map(t => ({ kind: 'tree', at: [t[0], t[1]] })),
    portals: [
      { id: 'street.toHome', role: 'enter', at: { x: 1, y: 'bottom-2' }, target: 'map.home' }
    ],
    spawn: { x: 1, y: STREET_H - 2 }
  });

  /* ---- 5. 角色 ---- */
  writePack('characters/palettes.json', {
    schema: 'characters/1',
    slots: {
      skin:   { label: '肤色', values: grabValue('SKIN_TONES') },
      hair:   { label: '发色', values: grabValue('HAIR_COLORS') },
      top:    { label: '上衣', values: grabValue('TOP_COLORS') },
      bottom: { label: '下装', values: grabValue('BOTTOM_COLORS') },
      shoes:  { label: '鞋子', values: grabValue('SHOE_COLORS') },
      face:   { label: '五官', values: ['#3b3226', '#2b2b2b', '#5a3a24'] }
    },
    hairStyles: grabValue('HAIR_STYLES').map((n, i) => ({ index: i, name: n })),
    faceStyles: grabValue('FACE_STYLES').map((n, i) => ({ index: i, name: n }))
  });

  writePack('characters/player.default.json', {
    schema: 'characters/1',
    id: 'player.default',
    person: { name: '我的屋主', gender: '女', role: '自由职业', marital: '单身', address: '幸福小区 · 1栋 101' },
    appearance: grabValue('APPEARANCE')
  });

  writePack('characters/npcs.neighbors.json', {
    schema: 'characters/1',
    note: '小区 NPC：spawn 为街景初始格；home 指向 street.map 里的房屋 id',
    npcs: neighbors.map((n, i) => ({
      id: 'npc.' + n.id,
      name: n.name,
      appearance: n.appearance,
      spawn: { x: n.fx, y: n.fy },
      home: 'house.' + (houses[i] ? houses[i].name : ''),
      behavior: { kind: 'wander', radius: { x: 4, y: 3 }, waitSec: [1.5, 4] },
      dialogues: {
        street: ['今天天气不错呀。', '小区最近挺安静的。'],
        visit: ['来啦？坐坐。', '家里有点乱，别介意。']
      }
    }))
  });

  /* ---- 6. 规则 ---- */
  const decay = grabValue('DECAY');
  const statsDef = grabValue('STATS');
  const workCost = grabValue('WORK_COST');
  writePack('rules/survival.json', {
    schema: 'rules/1',
    id: 'rules.survival.default',
    stats: {
      hunger:  { label: '饥饿', max: 100, initial: statsDef.hunger,  decayPerGameMinute: decay.hunger,  criticalBelow: 35 },
      thirst:  { label: '口渴', max: 100, initial: statsDef.thirst,  decayPerGameMinute: decay.thirst,  criticalBelow: 35 },
      emotion: { label: '情绪', max: 100, initial: statsDef.emotion, decayPerGameMinute: grabValue('EMOTION_DECAY'), criticalBelow: 30 }
    },
    clock: {
      startMinute: 8 * 60,
      minutesPerRealSecond: { '0': 0, '1': 1, '2': 2 },
      dayRolloverMinute: 24 * 60
    },
    work: {
      durationSec: grabValue('WORK_TIME'),
      pay: grabValue('WORK_PAY'),
      cost: { hunger: workCost.hunger, thirst: workCost.thirst }
    },
    sleep: {
      fromHour: 21, toHour: 5, wakeMinute: 7 * 60,
      cost: { hunger: 12, thirst: 12 }
    }
  });

  writePack('rules/economy.json', {
    schema: 'rules/1',
    id: 'rules.economy.default',
    currency: 'CNY',
    startMoney: 500,
    cozy: {
      // 只允许白名单函数：min/max/round/floor/ceil/sqrt
      bonusExpr: 'min(20, round(sqrt(cozy) * 1.5))',
      morningScale: 0.6,
      tiers: [
        { min: 0,  name: '毛坯房',   stars: 0 },
        { min: 18, name: '有点样子', stars: 1 },
        { min: 35, name: '温馨小屋', stars: 2 },
        { min: 55, name: '精致小窝', stars: 3 },
        { min: 80, name: '梦想之家', stars: 4 }
      ]
    },
    social: { streetChatEmotion: 10, visitChatEmotion: 12, chatCooldownSec: 1.5 }
  });

  writePack('ui/strings.zh-CN.json', {
    schema: 'ui/1',
    locale: 'zh-CN',
    note: '界面文案种子；后续把 HTML 里的硬编码文案逐步搬进来，支持多语言',
    strings: {
      'app.title': '我的 2.5D 小屋',
      'hud.work': '工作 +¥',
      'hud.shop': '商店',
      'hud.char': '人物',
      'hud.edit': '整理',
      'hud.decor': '装修',
      'hud.expand': '房型',
      'hud.scene.street': '小区',
      'hud.scene.home': '回家',
      'hud.home': '回原位',
      'panel.shop': '家具商店',
      'panel.inventory': '我的仓库',
      'panel.decor': '房间装修',
      'panel.upgrade': '房型扩建',
      'stat.hunger': '饥饿',
      'stat.thirst': '口渴',
      'stat.emotion': '情绪',
      'stat.money': '金钱',
      'stat.cozy': '装修度'
    }
  });

  /* ---- 7. manifest ---- */
  const packs = listPacks();
  // 给每个包算独立版本（hash 变了就 +1），结果写进 manifest.modules
  const packMap = {};
  for (const rel of packs) packMap[rel] = JSON.parse(fs.readFileSync(path.join(CONTENT, rel), 'utf8'));
  const { versions, bumpCount } = bumpVersions(packMap);
  writePack('manifest.json', {
    schema: 'manifest/1',
    contentVersion: 1,
    generatedAt: new Date().toISOString(),
    note: 'content/ 为唯一真相；modules 是每个内容包的独立版本（hash 变化时 version 自动 +1）',
    modules: versions,
    packs
  });
  console.log('模块版本：' + Object.keys(versions).length + ' 个，本次变更 ' + bumpCount + ' 个');

  console.log(`extract 完成：catalog ${items.length} 件（core ${core.length} / decor ${decor.length}），SVG ${svgCount} 个，房型 ${levels.length}，地图 2，NPC ${neighbors.length}`);
}

function grabSvgDefs(){
  const re = /\n {2}([a-z_][a-z0-9_]*): \{w:\s*(\d+),\s*h:\s*(\d+),\s*ax:\s*(\d+),\s*ay:\s*(\d+),\s*svg:\s*\r?\n`([\s\S]*?)`\}/g;
  const out = {};
  let m;
  while ((m = re.exec(src))){
    out[m[1]] = { w: +m[2], h: +m[3], ax: +m[4], ay: +m[5], svg: m[6] };
  }
  if (!Object.keys(out).length) throw new Error('未解析到任何 SVG 素材');
  return out;
}

function deriveTags(d){
  const t = [];
  if (['sleep','rest','watch','music','read','bath','net','wc'].includes(d.action)) t.push('comfort');
  if (['eat','cook','snack'].includes(d.action)) t.push('food');
  if (d.action === 'drink' || d.action === 'snack') t.push('water');
  if (d.cat === '电器') t.push('electric');
  if (d.cat === '装饰') t.push('decor');
  if (d.walk) t.push('walkable');
  return t;
}

/** 依据隔墙把室内切成区域（仅用于文档/校验，引擎可后续消费） */
function deriveZones(lv){
  if (!lv.walls.length) return [{ name: 'main', rect: { x: 0, y: 0, w: lv.w, h: lv.h } }];
  const zones = [];
  const xs = [...new Set(lv.walls.map(w => w[0]))].sort((a, b) => a - b);
  const ys = [...new Set(lv.walls.map(w => w[1]))].sort((a, b) => a - b);
  for (let i = 0; i < xs.length; i++){
    zones.push({ name: 'zone.w' + i, rect: { x: i === 0 ? 0 : xs[i], y: 0, w: lv.w, h: lv.h } });
  }
  if (!zones.length && ys.length) zones.push({ name: 'zone.main', rect: { x: 0, y: 0, w: lv.w, h: lv.h } });
  return zones;
}

function writePack(rel, data){
  const p = path.join(CONTENT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function listPacks(){
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })){
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json') && e.name !== 'manifest.json' && e.name !== 'versions.json'){
        out.push(path.relative(CONTENT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(CONTENT);
  return out.sort();
}

/* ============================== validate ============================== */

function loadPacks(){
  const manifest = JSON.parse(fs.readFileSync(path.join(CONTENT, 'manifest.json'), 'utf8'));
  /* 以磁盘实际文件为准：新增内容包不应该要求先手工改 manifest
   * （历史上就因为 loadPacks 只读 manifest.packs，导致新加的包被静默忽略） */
  const onDisk = listPacks();
  const packs = {};
  for (const rel of onDisk){
    const p = path.join(CONTENT, rel);
    if (!fs.existsSync(p)){ problems.push(`[缺失] 包不存在: ${rel}`); continue; }
    packs[rel] = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  for (const rel of (manifest.packs || [])){
    if (!onDisk.includes(rel)) problems.push(`[清单] manifest 引用了磁盘上已不存在的包: ${rel}`);
  }
  manifest.packs = onDisk;
  return { manifest, packs };
}

function validate(){
  const { manifest, packs } = loadPacks();
  const all = Object.values(packs);

  /* V1 包级必需字段 */
  const REQUIRED = {
    'catalog/1': ['items'],
    'house/1': ['levels'],
    'map/1': ['id', 'renderer'],
    'careers/1': ['jobs'],
    'achievements/1': ['groups', 'achievements'],
    'residence/1': ['buildings'],
    'characters/1': [],
    'rules/1': [],
    'styles/1': ['floors', 'walls'],
    'environment/1': [],
    'ui/1': ['strings']
  };
  for (const [rel, pack] of Object.entries(packs)){
    for (const f of (REQUIRED[pack.schema] || [])){
      if (pack[f] === undefined) problems.push(`[字段] ${rel} 缺少必需字段 ${f}`);
    }
  }

  /* V2 家具实体：必需字段 / id 唯一 / 数值范围 / 素材存在 */
  const ENTITY_FIELDS = ['id', 'name', 'category', 'price', 'footprint', 'cozy', 'placement', 'asset'];
  const items = all.flatMap(p => p.items || []);
  const seen = new Set();
  for (const it of items){
    for (const f of ENTITY_FIELDS){
      if (it[f] === undefined) problems.push(`[字段] 家具 ${it.id || '(无 id)'} 缺少 ${f}`);
    }
    if (seen.has(it.id)) problems.push(`[重复] 家具 id 重复: ${it.id}`);
    seen.add(it.id);
    if (!/^[a-z][a-z0-9_]*$/.test(it.id)) problems.push(`[命名] 家具 id 建议小写下划线: ${it.id}`);
    if (typeof it.price !== 'number' || it.price < 0) problems.push(`[数值] ${it.id} price 非法: ${it.price}`);
    const fp = it.footprint || {};
    if (!(fp.w >= 1 && fp.w <= 4 && fp.h >= 1 && fp.h <= 4)) problems.push(`[数值] ${it.id} 占地越界: ${fp.w}x${fp.h}`);
    if (!(it.cozy >= 0 && it.cozy <= 10)) problems.push(`[数值] ${it.id} cozy 越界: ${it.cozy}`);
    if (it.asset && it.asset.ref){
      const ap = path.join(ROOT, it.asset.ref);
      if (!fs.existsSync(ap)) problems.push(`[资源] ${it.id} 素材不存在: ${it.asset.ref}`);
      else if (!/<svg[\s>]/.test(fs.readFileSync(ap, 'utf8'))) problems.push(`[资源] ${it.id} 素材不是合法 SVG`);
    } else {
      problems.push(`[资源] ${it.id} 缺少 asset.ref`);
    }
    if (it.interaction){
      if (!it.interaction.verb) problems.push(`[规则] ${it.id} interaction 缺少 verb`);
      for (const [k, v] of Object.entries(it.interaction.effects || {})){
        if (!['hunger','thirst','emotion'].includes(k)) problems.push(`[规则] ${it.id} 未知效果键: ${k}`);
        if (typeof v !== 'number') problems.push(`[规则] ${it.id} 效果 ${k} 非数字`);
      }
    }
  }

  /* V3 房型：隔墙必须在室内范围内、且不能压门 */
  const house = packs['house/levels.json'];
  if (house){
    const origin = house.origin || { x: 3, y: 3 };
    for (const lv of house.levels){
      const innerW = lv.footprint.w, innerH = lv.footprint.h;
      const minX = origin.x + 1, maxX = origin.x + innerW;
      const minY = origin.y + 1, maxY = origin.y + innerH;
      const inX = (x) => x >= minX && x <= maxX;
      const inY = (y) => y >= minY && y <= maxY;
      for (const w of lv.walls){
        if (!inX(w.x) || !inY(w.y)){
          problems.push(`[房型] ${lv.name} 隔墙越界 (${w.x},${w.y})，室内范围 x[${minX},${maxX}] y[${minY},${maxY}]`);
        }
      }
      // 门：下墙中央
      const doorX = origin.x + Math.floor(innerW / 2) + 1;
      const doorY = origin.y + innerH + 1;
      if (lv.walls.some(w => w.x === doorX && w.y === doorY)) problems.push(`[房型] ${lv.name} 隔墙压住了房门 (${doorX},${doorY})`);
    }
  }

  /* V4.5 交互系统完整性 —— 这是"加物品/加交互"最容易出错的地方：
   *   · 物品引用了没注册的 verb      → 玩家点了没反应
   *   · effects 里写了没声明的资源    → 数值静默丢失
   *   · category 不在分类表里         → 商店分组/图标兜底失效
   *   · consumes/produces 指向不存在的物品 → 扣不掉/发不出  */
  const statIds = new Set(Object.keys((packs['rules/survival.json'] || {}).stats || {}));
  const verbPack = packs['interaction/verbs.json'];
  const knownVerbs = new Set();
  if (verbPack){
    for (const k of Object.keys(verbPack.verbs || {})) knownVerbs.add(k);
    for (const k of Object.keys(verbPack.reserved || {})){
      if (k !== 'note') knownVerbs.add(k);
    }
    for (const [k, v] of Object.entries(verbPack.verbs || {})){
      if (!v.label) problems.push(`[交互] verb ${k} 缺少 label`);
      if (v.durationSec !== undefined && !(v.durationSec > 0)) problems.push(`[交互] verb ${k} 的 durationSec 必须 > 0`);
      if (v.hook && !HOOK_WHITELIST.includes(v.hook)) {
        problems.push(`[交互] verb ${k} 的 hook "${v.hook}" 未在引擎 VERB_HOOKS 注册（可用：${HOOK_WHITELIST.join('/')}）`);
      }
      for (const sk of Object.keys(v.effects || {})){
        if (!statIds.has(sk)) problems.push(`[交互] verb ${k} 的效果引用了未声明的资源 ${sk}`);
      }
    }
  } else {
    problems.push('[交互] 缺少 interaction/verbs.json');
  }

  const catPack = packs['catalog/categories.json'];
  const catIds = new Set();
  if (catPack){
    const seenOrder = [];
    for (const c of catPack.categories || []){
      if (!c.id) { problems.push('[分类] 条目缺少 id'); continue; }
      if (catIds.has(c.id)) problems.push(`[分类] id 重复: ${c.id}`);
      catIds.add(c.id);
      if (c.order !== undefined) seenOrder.push(c.order);
    }
  } else {
    problems.push('[分类] 缺少 catalog/categories.json');
  }

  const itemIds = new Set(items.map(i => i.id));
  for (const it of items){
    if (catIds.size && !catIds.has(it.category)){
      problems.push(`[分类] 物品 ${it.id} 的 category "${it.category}" 不在分类表里`);
    }
    const acts = Array.isArray(it.interactions) ? it.interactions : (it.interaction ? [it.interaction] : []);
    if (Array.isArray(it.interactions) && it.interaction){
      problems.push(`[交互] 物品 ${it.id} 同时写了 interaction 和 interactions，请只留一个`);
    }
    for (const a of acts){
      if (!a.verb){ problems.push(`[交互] 物品 ${it.id} 有动作缺少 verb`); continue; }
      if (knownVerbs.size && !knownVerbs.has(a.verb)){
        problems.push(`[交互] 物品 ${it.id} 引用了未注册的 verb "${a.verb}"`);
      }
      if (a.durationSec !== undefined && !(a.durationSec > 0)){
        problems.push(`[交互] 物品 ${it.id}/${a.verb} 的 durationSec 必须 > 0`);
      }
      if (a.hook && !HOOK_WHITELIST.includes(a.hook)){
        problems.push(`[交互] 物品 ${it.id}/${a.verb} 的 hook "${a.hook}" 未在引擎注册`);
      }
      for (const sk of Object.keys(a.effects || {})){
        if (!statIds.has(sk)) problems.push(`[交互] 物品 ${it.id}/${a.verb} 的效果引用了未声明的资源 ${sk}`);
      }
      for (const src of ['consumes', 'produces', 'requirements']){
        const ref = src === 'requirements' ? (a.requirements && a.requirements.items) : a[src];
        for (const id of Object.keys(ref || {})){
          if (!itemIds.has(id)){
            problems.push(`[交互] 物品 ${it.id}/${a.verb} 的 ${src} 引用了不存在的物品 ${id}`);
          }
        }
      }
      for (const sk of Object.keys((a.requirements && a.requirements.statMin) || {})){
        if (!statIds.has(sk)) problems.push(`[交互] 物品 ${it.id}/${a.verb} 的 requirements 引用了未声明的资源 ${sk}`);
      }
      if (a.requirements && a.requirements.timeRange){
        const tr = a.requirements.timeRange;
        if (!Array.isArray(tr) || tr.length !== 2 || tr.some(h => !(h >= 0 && h <= 24))){
          problems.push(`[交互] 物品 ${it.id}/${a.verb} 的 timeRange 必须是 [起,止] 且 0–24`);
        }
      }
    }
  }

  /* V4.6 职业完整性 —— 岗位绑定的分区必须存在，班次/单价/门槛不能写错：
   *   · zone 写错 → 玩家走到那儿永远打不了卡（且没有任何报错）
   *   · 班次 start>=end → 一辈子不进班次
   *   · effects 里写了没声明的资源 → 数值静默丢失  */
  const careerPack = packs['careers/jobs.json'];
  if (careerPack){
    const streetPack = packs['maps/street.map.json'];
    const zoneIds = new Set((streetPack?.zones || []).map(z => z.id));
    const statIds = new Set(Object.keys(packs['rules/survival.json']?.stats || {}));
    const jobIds = new Set();
    for (const j of careerPack.jobs || []){
      if (!j.id) { problems.push('[职业] 有岗位缺少 id'); continue; }
      if (jobIds.has(j.id)) problems.push('[职业] 岗位 id 重复: ' + j.id);
      jobIds.add(j.id);
      if (!j.name) problems.push('[职业] ' + j.id + ' 缺少 name');
      if (!zoneIds.has(j.zone)) problems.push('[职业] ' + j.id + ' 绑定的分区不存在: ' + j.zone);
      if (!(j.tasks >= 1 && j.tasks <= 24)) problems.push('[职业] ' + j.id + ' tasks 应在 1..24');
      if (!(j.taskSeconds >= 0.5 && j.taskSeconds <= 30)) problems.push('[职业] ' + j.id + ' taskSeconds 应在 0.5..30');
      if (!(j.payPerTask > 0)) problems.push('[职业] ' + j.id + ' payPerTask 必须为正');
      /* dailyPay 只是给面板/文档看的派生值，但它必须跟公式对得上：
       * 有一版物业客服漏填了 dailyPay，其它岗位都有，很容易蒙混过去 */
      if (j.dailyPay != null){
        const want = j.payPerTask * (j.tasks || 1) + (j.completionBonus || 0);
        if (Math.abs(Number(j.dailyPay) - want) > 0.5){
          problems.push('[职业] ' + j.id + ' dailyPay 与公式不符: 写了 ' + j.dailyPay + '，应为 ' + want);
        }
      }
      const sh = j.shift || {};
      if (!(sh.startHour >= 0 && sh.startHour < 24 && sh.endHour > sh.startHour && sh.endHour <= 24)){
        problems.push('[职业] ' + j.id + ' 班次非法: ' + sh.startHour + '–' + sh.endHour);
      }
      for (const field of ['costPerTask', 'finish', 'earlyLeave', 'require']){
        for (const k of Object.keys(j[field] || {})){
          if (!statIds.has(k)) problems.push('[职业] ' + j.id + ' 的 ' + field + ' 引用了未声明的资源 ' + k);
        }
      }
    }
  }

  /* V4.7 成就完整性 —— 目标/奖励写错不会报错，只会"永远达不成"或"发了不存在的物品"：
   *   · kind 拼错 → 进度恒为 0
   *   · jobShifts 引用了不存在的岗位 → 只有那个岗位的成就永远不亮
   *   · reward.items 引用了不存在的家具 → 达成后静默少发东西  */
  const achPack = Object.entries(packs).find(([rel]) => rel.startsWith('achievements/'))?.[1];
  const careersPack = packs['careers/jobs.json'];
  if (achPack){
    const KINDS = ['day', 'money', 'cozy', 'houseLevel', 'placed', 'shifts', 'jobShifts', 'careerLevel', 'visits',
      'savings', 'estates', 'pets', 'stockProfit', 'event'];
    /* 事件型目标的标签由客户端 firstMark() 打点，改tag必须两边一起改，所以在这里列白名单 */
    const KNOWN_EVENTS = ['street', 'meal', 'placed', 'decor', 'restaurant', 'soldEstate'];
    const groupIds = new Set((achPack.groups || []).map(g => g.id));
    const jobIdSet = new Set((careersPack?.jobs || []).map(j => j.id));
    const itemIds = new Set(items.map(i => i.id));
    const statIds = new Set(Object.keys(packs['rules/survival.json']?.stats || {}));
    const achIds = new Set();
    for (const a of achPack.achievements || []){
      if (!a.id) { problems.push('[成就] 有成就缺少 id'); continue; }
      if (achIds.has(a.id)) problems.push('[成就] id 重复: ' + a.id);
      achIds.add(a.id);
      if (!a.name) problems.push('[成就] ' + a.id + ' 缺少 name');
      if (groupIds.size && !groupIds.has(a.group)) problems.push('[成就] ' + a.id + ' 的分组不存在: ' + a.group);
      const g = a.goal || {};
      if (!KINDS.includes(g.kind)) problems.push('[成就] ' + a.id + ' 未知目标类型: ' + g.kind);
      if (g.kind === 'event'){
        if (typeof g.value !== 'string' || !g.value) problems.push('[成就] ' + a.id + ' 事件目标必须写标签字符串');
        else if (!KNOWN_EVENTS.includes(g.value)) problems.push('[成就] ' + a.id + ' 引用了未打点的事件: ' + g.value);
      } else if (!(g.value >= 1)) problems.push('[成就] ' + a.id + ' 目标值必须 ≥ 1');
      /* 引导链：step 必须是从 1 开始的连续整数，否则面板里会莫名跳号 */
      if ((a.group || '') === 'first'){
        if (!(Number(a.step) >= 1)) problems.push('[成就] ' + a.id + ' 属于「第一次」链但缺少 step');
        if (!a.hint) problems.push('[成就] ' + a.id + ' 属于「第一次」链但缺少 hint（面板与底部提示都要用）');
      }
      if (g.kind === 'jobShifts' && !jobIdSet.has(g.job)) problems.push('[成就] ' + a.id + ' 引用了不存在的岗位: ' + g.job);
      const rw = a.reward || {};
      if (rw.money != null && !(rw.money >= 0)) problems.push('[成就] ' + a.id + ' 奖金非法');
      for (const k of Object.keys(rw.effects || {})){
        if (!statIds.has(k)) problems.push('[成就] ' + a.id + ' 的 reward.effects 引用了未声明的资源 ' + k);
      }
      for (const k of Object.keys(rw.items || {})){
        if (!itemIds.has(k)) problems.push('[成就] ' + a.id + ' 的 reward.items 引用了不存在的物品 ' + k);
      }
    }
  }

  /* V4.8 住址完整性：楼栋必须真的在地图上；公寓要给楼层与每层房数，否则分不出 1803 这种房号 */
  const resPack = packs['house/residence.json'];
  if (resPack){
    const mapHouseIds = new Set(((packs['maps/street.map.json'] || {}).houses || []).map(h => h.id));
    const KINDS = ['apartment', 'villa'];
    const ids = new Set();
    for (const b of resPack.buildings || []){
      if (!b.id) { problems.push('[住址] 有楼栋缺少 id'); continue; }
      if (ids.has(b.id)) problems.push('[住址] 楼栋重复: ' + b.id);
      ids.add(b.id);
      if (!mapHouseIds.has(b.id)) problems.push('[住址] 楼栋在地图上不存在: ' + b.id);
      if (!KINDS.includes(b.kind)) problems.push('[住址] ' + b.id + ' 未知楼栋类型: ' + b.kind);
      if (b.kind === 'apartment'){
        if (!(b.floors >= 1 && b.floors <= 60)) problems.push('[住址] ' + b.id + ' floors 应在 1..60');
        if (!(b.unitsPerFloor >= 1 && b.unitsPerFloor <= 20)) problems.push('[住址] ' + b.id + ' unitsPerFloor 应在 1..20');
      }
      if (!b.label) problems.push('[住址] ' + b.id + ' 缺少 label');
    }
    const dk = resPack.assign && resPack.assign.defaultKind;
    if (dk && !KINDS.includes(dk)) problems.push('[住址] assign.defaultKind 非法: ' + dk);

    /* 房态：待售/待租的比例与价格。写错不会崩，但会让"售"或"租"彻底不出现
     * （比例加起来 0），或者出现负价/0 价（搬进去免费），所以必须拦。 */
    const u = resPack.units || {};
    for (const k of ['sale', 'rent', 'vacant']){
      const st = (u.states || {})[k];
      if (!st || !st.label) problems.push('[房态] units.states.' + k + ' 缺少 label');
    }
    const sp = Number(u.salePercent), rp = Number(u.rentPercent);
    if (!(sp >= 0 && sp <= 100)) problems.push('[房态] units.salePercent 应在 0..100');
    if (!(rp >= 0 && rp <= 100)) problems.push('[房态] units.rentPercent 应在 0..100');
    if (sp + rp > 100) problems.push('[房态] salePercent + rentPercent 超过 100');
    if (sp + rp <= 0) problems.push('[房态] salePercent + rentPercent 为 0，空房永远不会挂牌');
    const sale = u.sale || {}, rent = u.rent || {};
    if (!(sale.base >= 0) || !(sale.perFloor >= 0)) problems.push('[房态] units.sale.base / perFloor 应为非负数');
    if (!(rent.base >= 0) || !(rent.perFloor >= 0)) problems.push('[房态] units.rent.base / perFloor 应为非负数');
    if (sale.base + sale.perFloor <= 0) problems.push('[房态] 售价恒为 0，等于白送');
    if (rent.base + rent.perFloor <= 0) problems.push('[房态] 租金恒为 0，等于白住');
    if (!(rent.depositMonths >= 1 && rent.depositMonths <= 12)) problems.push('[房态] units.rent.depositMonths 应在 1..12');
    for (const k of ['sale', 'rent']){
      const step = (u[k] || {}).roundTo;
      if (step !== undefined && !(step >= 1)) problems.push('[房态] units.' + k + '.roundTo 应 >= 1');
    }
    /* 房产上限：写 0 或负数会让任何人都买不了房；写太大等于没上限（世界容量会失控） */
    if (!(u.maxPerUser >= 1 && u.maxPerUser <= 6)) problems.push('[房态] units.maxPerUser 应在 1..6');
    if (!(u.resaleRatio >= 0 && u.resaleRatio <= 1)) problems.push('[房态] units.resaleRatio 应在 0..1');
  }

  /* V4.9 围栏：围栏矩形要在地图内，大门必须落在外圈那一格上——
   * 写歪一格，门洞就开在别处（玩家会撞在看不见的栏杆上，或者从墙上走进院子） */
  for (const [rel, m] of Object.entries(packs)){
    if (!rel.startsWith('maps/') || !m || !m.fences) continue;
    const grid = m.grid || {};
    for (const a of (m.fences.areas || [])){
      const r = a.rect || {};
      if (!(r.w > 0 && r.h > 0)) problems.push('[围栏] ' + rel + ' 的 ' + (a.id || '?') + ' 缺少 rect');
      if (r.x < 1 || r.y < 1 || r.x + r.w > (grid.w || 0) - 1 || r.y + r.h > (grid.h || 0) - 1)
        problems.push('[围栏] ' + rel + ' 的 ' + (a.id || '?') + ' 超出地图范围');
      for (const g of (a.gates || [])){
        if (!(g.x > 0 && g.y > 0)) { problems.push('[围栏] ' + (a.id || '?') + ' 大门坐标非法'); continue; }
        const onRing = g.x === r.x - 1 || g.x === r.x + r.w || g.y === r.y - 1 || g.y === r.y + r.h;
        if (!onRing) problems.push('[围栏] ' + (a.id || '?') + ' 的大门 (' + g.x + ',' + g.y + ') 不在围栏上');
      }
      for (const zid of (a.gateAt || [])){
        if (!(m.zones || []).some(z => z.id === zid)) problems.push('[围栏] ' + (a.id || '?') + ' gateAt 引用了不存在的分区: ' + zid);
      }
    }
  }

  /* V4.17 建筑不压路：商铺/公共建筑的矩形不能和道路重叠。
   * 街区是按矩形手摆的，坐标写错一格就会把楼盖在马路中间——渲染上完全看不出来，
   * 只有走过去才知道。宠物之家就踩过：同时压在南环路和西支路上。 */
  {
    /* 历史遗留：以下四处是早期版本就压着路的，挪动会牵动门口的交互点和分区锚点，
     * 得连东半区的商铺行一起重排。先记账，新增的一律拦住。 */
    /* 目前空：地图重排后已经没有压路的建筑。留着机制是给"临时豁免"用——
     * 但豁免必须带注释写清原因和打算什么时候清掉，否则就成了永久后门。 */
    const KNOWN_OVERLAPS = {};
    for (const [rel, m] of Object.entries(packs)){
      if (!rel.startsWith('maps/') || !m || !Array.isArray(m.zones)) continue;
      const roads = m.zones.filter(z => z.kind === 'road');
      const allow = new Set(KNOWN_OVERLAPS[m.id] || []);
      const hit = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      for (const z of m.zones){
        if (z.kind !== 'shop' && z.kind !== 'civic') continue;
        for (const r of roads){
          if (hit(z, r)){
            if (allow.has(z.id)) continue;
            problems.push('[地图] ' + rel + ' 的 ' + (z.label || z.id) + ' (' + z.x + ',' + z.y + ') 压在道路「' + (r.label || r.id) + '」上');
            break;
          }
        }
      }
    }
  }

  /* V4.10 车款：4S 店卖的车。价格写负/速度写 0 会让"买得起但开不动"或"倒贴钱" */
  for (const [rel, pack] of Object.entries(packs)){
    if (!rel.startsWith('vehicles/')) continue;
    const ids = new Set();
    if (!Array.isArray(pack.models) || !pack.models.length) problems.push('[车款] ' + rel + ' 没有 models');
    for (const m of (pack.models || [])){
      if (!m.id || !m.name) problems.push('[车款] ' + rel + ' 有车款缺 id/name');
      if (ids.has(m.id)) problems.push('[车款] 车款重复: ' + m.id);
      ids.add(m.id);
      if (!(m.price >= 0)) problems.push('[车款] ' + m.id + ' 价格应 >= 0');
      if (!(m.speed >= 1)) problems.push('[车款] ' + m.id + ' 车速倍率应 >= 1');
    }
    const pz = pack.parking && pack.parking.zone;
    if (pz){
      const street = packs['maps/street.map.json'] || {};
      const zone = (street.zones || []).find(z => z.id === pz);
      if (!zone) problems.push('[车款] parking.zone 在地图上不存在: ' + pz);
      else if (zone.kind !== 'parking') problems.push('[车款] parking.zone 不是停车区: ' + pz);
    }
  }

  /* V4.11 经济数值：房租周期/回收比例/医院服务。这些数字错得很安静——
   * effects 键写成 emtion 不会报错，只会让玩家"花了钱没效果" */
  const econ = packs['rules/economy.json'];
  if (econ){
    const statIds = Object.keys((packs['rules/survival.json'] || {}).stats || {});
    const rc = econ.rent && econ.rent.cycleDays;
    if (rc !== undefined && !(rc >= 1 && rc <= 30)) problems.push('[经济] rent.cycleDays 应在 1..30');
    const rr = econ.car && econ.car.resaleRatio;
    if (rr !== undefined && !(rr >= 0 && rr <= 1)) problems.push('[经济] car.resaleRatio 应在 0..1');
    const svcs = (econ.clinic && econ.clinic.services) || [];
    const sids = new Set();
    for (const s of svcs){
      if (!s.id || !s.name) problems.push('[经济] 医院服务缺少 id/name');
      if (sids.has(s.id)) problems.push('[经济] 医院服务重复: ' + s.id);
      sids.add(s.id);
      if (!(s.price >= 0)) problems.push('[经济] ' + s.id + ' 价格应 >= 0');
      if (s.cooldownMinutes !== undefined && !(s.cooldownMinutes >= 0)) problems.push('[经济] ' + s.id + ' 冷却应 >= 0');
      for (const k of Object.keys(s.effects || {})){
        if (statIds.length && !statIds.includes(k)) problems.push('[经济] ' + s.id + ' 的效果引用了未声明的资源: ' + k);
      }
    }
  }

  /* V4.12 彩票：票价、号码范围、奖级 patterns。奖级写错不会报错，
   * 只会让某一档永远中不了（玩家看不出来，只觉得"这彩票有问题"） */
  for (const [rel, pack] of Object.entries(packs)){
    if (!rel.startsWith('lottery/')) continue;
    const R = pack.red || {}, B = pack.blue || {};
    if (!(pack.price >= 0.5)) problems.push('[彩票] ' + rel + ' 票价应 >= 0.5');
    if (!(R.pick >= 1 && R.max > R.pick)) problems.push('[彩票] 红球 pick/max 不合法');
    if (!(B.pick >= 1 && B.max >= B.pick)) problems.push('[彩票] 蓝球 pick/max 不合法');
    const seen = new Set();
    for (const t of (pack.tiers || [])){
      if (!t.id || !t.name) problems.push('[彩票] 奖级缺少 id/name');
      if (seen.has(t.id)) problems.push('[彩票] 奖级重复: ' + t.id);
      seen.add(t.id);
      if (!(t.prize >= 0)) problems.push('[彩票] ' + t.id + ' 奖金应 >= 0');
      if (!Array.isArray(t.patterns) || !t.patterns.length) problems.push('[彩票] ' + t.id + ' 没有 patterns');
      for (const p of (t.patterns || [])){
        if (!(p.red >= 0 && p.red <= R.pick)) problems.push('[彩票] ' + t.id + ' 红球命中数越界: ' + p.red);
        if (!(p.blue === 0 || p.blue === 1)) problems.push('[彩票] ' + t.id + ' 蓝球的 blue 只能是 0/1');
      }
    }
  }

  /* V4.13 生活开支：食材 / 菜单 / 货架 / 账单 / 不动产增值
   * 这几处错得最安静——菜单把 hunger 拼成 hunnger，玩家花了钱什么也没发生，
   * 只会觉得"这游戏坏了"；账单 amount 里写个引擎不认识的键，金额会恒为 0，
   * 水电费从第一张起就白送。全部前置拦下来。 */
  {
    const statIds = new Set(Object.keys((packs['rules/survival.json'] || {}).stats || {}));
    const zoneIds = new Set(((packs['maps/street.map.json'] || {}).zones || []).map(z => z.id));
    const metaKeys = new Set(['uses', 'label', 'desc', 'note', 'id', 'name', 'price']);
    const checkFx = (who, obj) => {
      if (!statIds.size) return;
      for (const k of Object.keys(obj || {})){
        if (metaKeys.has(k)) continue;
        if (!statIds.has(k)) problems.push('[开支] ' + who + ' 引用了未声明的资源: ' + k);
      }
    };
    const fxOnly = (o) => {
      const out = {};
      for (const k in (o || {})) if (!metaKeys.has(k)) out[k] = o[k];
      return out;
    };

    if (econ){
      const food = econ.food;
      if (food){
        if (!(food.max >= 1 && food.max <= 200)) problems.push('[开支] food.max 应在 1..200');
        for (const key of ['cook', 'meal', 'snack']){
          const f = food[key];
          if (!f) continue;
          if (!(f.uses >= 0)) problems.push('[开支] food.' + key + '.uses 应 >= 0');
          checkFx('food.' + key, fxOnly(f));
        }
        if (!food.cook && !food.meal) problems.push('[开支] food 既没有 cook 也没有 meal，做饭这条线会断');
      }

      for (const g of (econ.groceries || [])){
        const who = '食材售卖 ' + (g.name || g.zone || '?');
        if (!g.zone) problems.push('[开支] ' + who + ' 缺少 zone');
        else if (!zoneIds.has(g.zone)) problems.push('[开支] ' + who + ' 的分区在地图上不存在: ' + g.zone);
        if (!(g.pack >= 1)) problems.push('[开支] ' + who + ' pack 应 >= 1');
        if (!(g.price >= 0)) problems.push('[开支] ' + who + ' price 应 >= 0');
      }

      const rest = econ.restaurant;
      if (rest){
        if (rest.zone && !zoneIds.has(rest.zone)) problems.push('[开支] 饭馆分区不存在: ' + rest.zone);
        const sids = new Set();
        if (!Array.isArray(rest.menu) || !rest.menu.length) problems.push('[开支] 饭馆没有菜单');
        for (const d of (rest.menu || [])){
          if (!d.id || !d.name) problems.push('[开支] 菜品缺 id/name');
          if (sids.has(d.id)) problems.push('[开支] 菜品重复: ' + d.id);
          sids.add(d.id);
          if (!(d.price >= 0)) problems.push('[开支] ' + d.id + ' 价格应 >= 0');
          checkFx(d.id, fxOnly(d));
        }
      }

      const mart = econ.mart;
      if (mart){
        if (mart.zone && !zoneIds.has(mart.zone)) problems.push('[开支] 超市分区不存在: ' + mart.zone);
        const gids = new Set();
        for (const g of (mart.goods || [])){
          if (!g.id || !g.name) problems.push('[开支] 货架商品缺 id/name');
          if (gids.has(g.id)) problems.push('[开支] 货架商品重复: ' + g.id);
          gids.add(g.id);
          if (!(g.price >= 0)) problems.push('[开支] ' + g.id + ' 价格应 >= 0');
          checkFx(g.id, fxOnly(g));
        }
        if (!Array.isArray(mart.goods) || !mart.goods.length) problems.push('[开支] 超市货架是空的');
      }
    }

    for (const [rel, pack] of Object.entries(packs)){
      if (pack.id !== 'rules.bills.default') continue;
      const ALLOWED = new Set(['source', 'flat', 'base', 'perAppliance', 'perFloor', 'villaBase', 'period']);
      const OK_WHEN = new Set(['rented', 'car', 'owned', 'always']);
      const bids = new Set();
      if (!Array.isArray(pack.bills) || !pack.bills.length) problems.push('[账单] ' + rel + ' 没有任何账单模板');
      for (const b of (pack.bills || [])){
        if (!b.id || !b.title) problems.push('[账单] 条目缺 id/title');
        if (bids.has(b.id)) problems.push('[账单] 条目重复: ' + b.id);
        bids.add(b.id);
        const cyc = Number(b.cycleDays);
        if (!(cyc >= 1 && cyc <= 365)) problems.push('[账单] ' + b.id + ' cycleDays 应在 1..365');
        const a = b.amount || {};
        for (const k of Object.keys(a)){
          if (!ALLOWED.has(k)) problems.push('[账单] ' + b.id + ' amount 里有引擎不认识的键: ' + k + '（金额会被静默忽略）');
        }
        if (a.source !== undefined && a.source !== 'rent')
          problems.push('[账单] ' + b.id + ' 不支持的 source: ' + a.source);
        if (a.source === undefined && a.flat === undefined && a.base === undefined)
          problems.push('[账单] ' + b.id + ' 既没有 source/flat 也没有 base，金额会恒为 0');
        if (!OK_WHEN.has(b.onlyWhen || 'always'))
          problems.push('[账单] ' + b.id + ' 未知的 onlyWhen: ' + b.onlyWhen);
      }
      const mb = pack.mailbox || {};
      if (mb.graceDays !== undefined && !(mb.graceDays >= 0 && mb.graceDays <= 60))
        problems.push('[账单] mailbox.graceDays 应在 0..60');
      if (mb.lateEmotionPerDay !== undefined && !(mb.lateEmotionPerDay <= 0))
        problems.push('[账单] mailbox.lateEmotionPerDay 应 <= 0（这是扣情绪，不是加）');
      if (mb.keepPaid !== undefined && !(mb.keepPaid >= 0 && mb.keepPaid <= 50))
        problems.push('[账单] mailbox.keepPaid 应在 0..50');
    }

    const resPack = packs['house/residence.json'];
    const ap = resPack && resPack.units && resPack.units.appreciate;
    if (ap){
      if (!(ap.perYear >= 0 && ap.perYear <= 1)) problems.push('[住址] appreciate.perYear 应在 0..1');
      if (!(ap.yearDays >= 1)) problems.push('[住址] appreciate.yearDays 应 >= 1');
    }
  }

  /* V4.14 功能点承包：门牌、承包金、日收益、周期。
   * 这几处错了会静默变成"承包了但不赚钱"，玩家只会觉得系统坏了。 */
  {
    const zoneIds = new Set(((packs['maps/street.map.json'] || {}).zones || []).map(z => z.id));
    for (const [rel, pack] of Object.entries(packs)){
      if (pack.schema !== 'business/1') continue;
      const term = Number(pack.termDays);
      if (!(term >= 1 && term <= 365)) problems.push('[承包] ' + rel + ' termDays 应在 1..365');
      const maxOwn = Number(pack.maxOwned);
      if (!(maxOwn >= 1 && maxOwn <= 6)) problems.push('[承包] ' + rel + ' maxOwned 应在 1..6');
      const rr = Number(pack.refundRatio);
      if (!(rr >= 0 && rr <= 1)) problems.push('[承包] ' + rel + ' refundRatio 应在 0..1');
      const ids = new Set(), codes = new Set(), zones = new Set();
      if (!Array.isArray(pack.shops) || !pack.shops.length) problems.push('[承包] ' + rel + ' 没有可承包的店铺');
      for (const s of (pack.shops || [])){
        const who = '承包 ' + (s.name || s.id || '?');
        if (!s.id || !s.name) problems.push('[承包] 有店铺缺 id/name');
        if (ids.has(s.id)) problems.push('[承包] 店铺 id 重复: ' + s.id);
        ids.add(s.id);
        // 门牌号是实体的身份：同类两家店必须有两个不同的号
        const code = String(s.code || '').trim();
        if (!/^[0-9]{3,6}$/.test(code)) problems.push('[承包] ' + who + ' 的 code 应是 3-6 位数字，实为: ' + code);
        if (codes.has(code)) problems.push('[承包] 门牌号重复: ' + code + '（同类多家必须各自编号）');
        codes.add(code);
        // 一个 zone 只能挂一家，否则"点这家店"没法确定承包的是谁
        if (zones.has(s.zone)) problems.push('[承包] 同一个 zone 挂了多家店: ' + s.zone);
        zones.add(s.zone);
        if (!zoneIds.has(s.zone)) problems.push('[承包] ' + who + ' 的 zone 在地图上不存在: ' + s.zone);
        const fee = Number(s.fee), daily = Number(s.daily);
        if (!(fee > 0)) problems.push('[承包] ' + who + ' 承包金应 > 0');
        if (!(daily > 0)) problems.push('[承包] ' + who + ' 日收益应 > 0');
        if (fee > 0 && daily > 0){
          const net = daily * term - fee;
          if (net <= 0) problems.push('[承包] ' + who + ' 一个周期净利为负（日收 ' + daily + ' × ' + term + ' ≤ 承包金 ' + fee + '）');
          else {
            const rate = net / fee;
            if (rate < 0.15 || rate > 0.8)
              problems.push('[承包] ' + who + ' 月回报率 ' + (rate * 100).toFixed(0) + '% 不在 15%-80% 之间（太低没人包，太高破坏经济）');
          }
        }
      }
    }
  }

  /* V4.15 银行与股市：利率、档位、行情参数。
   * 这几处错了不会报错，只会让玩家"存了钱不生息"或者"股票永远不涨"——
   * 那种 bug 只能靠玩家截图来发现，所以必须在构建期拦住。 */
  {
    const zoneIds = new Set(((packs['maps/street.map.json'] || {}).zones || []).map(z => z.id));
    const lo = (v, a, b) => Number(v) >= a && Number(v) <= b;

    const bank = packs['bank/bank.json'];
    if (!bank) problems.push('[银行] 缺少 bank/bank.json');
    else {
      if (bank.zone && !zoneIds.has(bank.zone)) problems.push('[银行] 分区在地图上不存在: ' + bank.zone);
      const sv = bank.savings || {};
      if (!lo(sv.dailyRate, 0.0001, 0.05)) problems.push('[银行] 活期日息应在 0.01%..5%，实为 ' + sv.dailyRate);
      if (!(Number(sv.cap) > 0)) problems.push('[银行] 活期上限应 > 0');
      const terms = (bank.fixed || {}).terms || [];
      if (!terms.length) problems.push('[银行] 没有定期档位');
      const tids = new Set();
      for (const t of terms){
        if (!t.id || tids.has(t.id)) problems.push('[银行] 定期档位 id 缺失或重复: ' + t.id);
        tids.add(t.id);
        if (!lo(t.days, 1, 365)) problems.push('[银行] 定期 ' + t.id + ' days 应在 1..365');
        if (!lo(t.dailyRate, 0.0001, 0.05)) problems.push('[银行] 定期 ' + t.id + ' 日息应在 0.01%..5%');
        if (!(Number(t.minAmount) > 0)) problems.push('[银行] 定期 ' + t.id + ' minAmount 应 > 0');
      }
      const lns = (bank.loan || {}).tiers || [];
      if (!lns.length) problems.push('[银行] 没有贷款档位');
      const lids = new Set();
      for (const l of lns){
        if (!l.id || lids.has(l.id)) problems.push('[银行] 贷款档位 id 缺失或重复: ' + l.id);
        lids.add(l.id);
        if (!(Number(l.amount) > 0)) problems.push('[银行] 贷款 ' + l.id + ' amount 应 > 0');
        if (!lo(l.days, 1, 365)) problems.push('[银行] 贷款 ' + l.id + ' days 应在 1..365');
        if (!lo(l.rate, 0, 1)) problems.push('[银行] 贷款 ' + l.id + ' 利率应在 0..100%');
      }
      if (!lo((bank.loan || {}).maxActive, 1, 5)) problems.push('[银行] maxActive 应在 1..5');
    }

    const st = packs['stock/stock.json'];
    if (!st) problems.push('[股市] 缺少 stock/stock.json');
    else {
      if (st.zone && !zoneIds.has(st.zone)) problems.push('[股市] 分区在地图上不存在: ' + st.zone);
      if (!lo(st.feeRate, 0, 0.05)) problems.push('[股市] 手续费应在 0..5%');
      if (!(Number(st.lotSize) >= 1)) problems.push('[股市] lotSize 应 >= 1');
      const arr = st.stocks || [];
      if (!arr.length) problems.push('[股市] 没有可交易标的');
      const ids = new Set(), codes = new Set();
      for (const s of arr){
        const who = '股票 ' + (s.name || s.id || '?');
        if (!s.id || ids.has(s.id)) problems.push('[股市] id 缺失或重复: ' + s.id);
        ids.add(s.id);
        if (!/^[0-9]{6}$/.test(String(s.code || ''))) problems.push('[股市] ' + who + ' 代码应是 6 位数字');
        if (codes.has(String(s.code))) problems.push('[股市] 代码重复: ' + s.code);
        codes.add(String(s.code));
        if (!(Number(s.base) > 0)) problems.push('[股市] ' + who + ' 基准价应 > 0');
        // 日漂移超过 ±2% 时，几十个游戏日就会涨到天上或跌成仙股
        if (!lo(s.drift, -0.02, 0.02)) problems.push('[股市] ' + who + ' 日漂移应在 ±2%，实为 ' + s.drift);
        if (!lo(s.vol, 0, 0.2)) problems.push('[股市] ' + who + ' 波动应在 0..20%');
      }
      const model = st.model || {};
      if (model.tailProb != null && !lo(model.tailProb, 0, 0.2)) problems.push('[股市] tailProb 应在 0..20%');
      if (model.floorRatio != null && !lo(model.floorRatio, 0, 1)) problems.push('[股市] floorRatio 应在 0..1');
    }
  }

  /* V4.16 生存数值：0-100 的三条状态，"每天掉多少"必须和"一次能补多少"对得上。
   * 这两边任何一边写歪了都不会报错，只会让玩家永远渴着/永远不开心，或者反过来
   * 吃一顿管三天，让吃饭喝水整套玩法形同虚设。
   *   判据：日衰减 ÷ 该状态平均单次恢复 = 一天需要的动作次数，必须 ≤ 8 次。 */
  {
    const sv = packs['rules/survival.json'];
    if (!sv) problems.push('[生存] 缺少 rules/survival.json');
    else {
      const stats = sv.stats || {};
      const DAY_MIN = 1440;
      /* 收集所有正向恢复来源：家具交互 + 三餐 + 饭馆 + 超市 + 门诊 */
      const srcs = {};
      const addFx = (eff) => {
        for (const [k, v] of Object.entries(eff || {})){
          if (!stats[k]) continue;
          if (typeof v !== 'number' || v <= 0) continue;
          (srcs[k] = srcs[k] || []).push(v);
        }
      };
      for (const it of items){
        const ix = it.interaction || {};
        if (ix.effects) addFx(ix.effects);
        for (const a of ix.acts || []) addFx(a.effects);
      }
      const eco = packs['rules/economy.json'] || {};
      const food = eco.food || {};
      for (const key of ['cook', 'meal', 'snack']) addFx(food[key]);
      for (const d of (eco.restaurant || {}).menu || []) addFx(d);
      for (const g of (eco.mart || {}).goods || []) addFx(g);
      for (const s of (eco.clinic || {}).services || []) addFx(s.effects || {});

      for (const [id, st] of Object.entries(stats)){
        const max = Number(st.max) || 100;
        const decay = Number(st.decayPerGameMinute) || 0;
        const perDay = decay * DAY_MIN;
        if (!(perDay >= max * 0.25 && perDay <= max * 1.0)){
          problems.push('[生存] ' + id + ' 日衰减 ' + perDay.toFixed(1) +
            ' 应在满格的 25%~100% 之间（太少没有生存感，太多必掉格）');
        }
        const list = srcs[id] || [];
        if (list.length < 3){
          problems.push('[生存] ' + id + ' 只有 ' + list.length + ' 个恢复来源，至少要有 3 个');
        } else {
          const avg = list.reduce((a, b) => a + b, 0) / list.length;
          const need = perDay / avg;
          if (need > 8){
            problems.push('[生存] ' + id + ' 每天要补 ' + perDay.toFixed(1) + ' 点，平均单次只 +' +
              avg.toFixed(1) + '，等于一天要做 ' + need.toFixed(1) + ' 次（上限 8）');
          }
          if (Math.max(...list) < max * 0.2){
            problems.push('[生存] ' + id + ' 最大的单次恢复只有 ' + Math.max(...list) + '，没有一个能补到两成');
          }
        }
      }
    }
  }

  /* V4.18 车流车型：车型表写错不会报错，只会"救护车永远不出现"或者"公交跑到小巷里" */
  {
    const amb = packs['environment/ambient.json'] || {};
    const types = (amb.traffic && amb.traffic.types) || [];
    if (amb.traffic && !types.length && (amb.traffic.kinds || []).length){
      problems.push('[车流] 还只有 kinds 颜色表，没有 types 车型表（会退化成单一私家车）');
    }
    const ids = new Set();
    for (const t of types){
      if (!t.id) { problems.push('[车流] 有车型缺少 id'); continue; }
      if (ids.has(t.id)) problems.push('[车流] 车型 id 重复: ' + t.id);
      ids.add(t.id);
      if (!t.label) problems.push('[车流] ' + t.id + ' 缺少 label');
      if (!(Number(t.weight) >= 1)) problems.push('[车流] ' + t.id + ' weight 必须 ≥ 1');
      const w = t.where || 'any';
      if (!['any', 'arterial'].includes(w)) problems.push('[车流] ' + t.id + ' where 只能是 any / arterial');
      const sp = Number(t.speedMul == null ? 1 : t.speedMul);
      if (!(sp >= 0.5 && sp <= 1.6)) problems.push('[车流] ' + t.id + ' speedMul 应在 0.5..1.6（太快会穿过路口，太慢会堵）');
      for (const k of ['len', 'wid']){
        if (t[k] != null && !(Number(t[k]) >= 0.8 && Number(t[k]) <= 2))
          problems.push('[车流] ' + t.id + ' ' + k + ' 应在 0.8..2');
      }
      for (const c of [t.color, t.roofColor, t.stripe, t.beacon].filter(Boolean)){
        if (!/^#[0-9a-fA-F]{3,8}$/.test(c)) problems.push('[车流] ' + t.id + ' 颜色格式不对: ' + c);
      }
      for (const c of (t.colors || [])){
        if (!/^#[0-9a-fA-F]{3,8}$/.test(c)) problems.push('[车流] ' + t.id + ' colors 里有非法色值: ' + c);
      }
    }
  }

  /* V4.19 店员：每家店上班时间得有人在，而且站得住。
   * 写错 zoneId 不会报错，只会"这家店永远没人"——玩家不会察觉，但街会变空。 */
  {
    const pk = packs['characters/npcs.neighbors.json'];
    const clerks = (pk && pk.clerks) || [];
    if (pk && !clerks.length) problems.push('[店员] 一个店员都没有，商业街会空荡荡');
    /* 地图里所有 shop / civic 分区 */
    const buildings = new Set();
    for (const [rel, m] of Object.entries(packs)){
      if (!rel.startsWith('maps/') || !m || !Array.isArray(m.zones)) continue;
      for (const z of m.zones) if (z.kind === 'shop' || z.kind === 'civic') buildings.add(z.id);
    }
    const seenId = new Set(), covered = new Set();
    for (const c of clerks){
      if (!c.id) { problems.push('[店员] 有店员缺少 id'); continue; }
      if (seenId.has(c.id)) problems.push('[店员] id 重复: ' + c.id);
      seenId.add(c.id);
      if (!c.name) problems.push('[店员] ' + c.id + ' 缺少 name');
      if (!c.zoneId) problems.push('[店员] ' + c.id + ' 缺少 zoneId');
      else if (!buildings.has(c.zoneId)) problems.push('[店员] ' + c.id + ' 的 zoneId「' + c.zoneId + '」不是商铺/公共建筑');
      else covered.add(c.zoneId);
      const h = c.hours;
      if (!Array.isArray(h) || h.length !== 2 || !h.every(v => Number(v) >= 0 && Number(v) <= 24)){
        problems.push('[店员] ' + c.id + ' hours 必须是 [开,关] 两个 0..24 的数字');
      } else if (Number(h[0]) === Number(h[1])){
        problems.push('[店员] ' + c.id + ' hours 开工和收工同一时刻，等于永不上班');
      }
      for (const pool of ['hello', 'tip']){
        const arr = (c.lines || {})[pool];
        if (!Array.isArray(arr) || !arr.length || !arr.every(x => typeof x === 'string' && x.trim())){
          problems.push('[店员] ' + c.id + ' 的 lines.' + pool + ' 至少要有 1 句有效台词');
        }
      }
      const ap = c.appearance || {};
      for (const k of ['skin', 'hair', 'top', 'bottom']){
        if (!ap[k]) problems.push('[店员] ' + c.id + ' 外观缺少 ' + k);
      }
    }
    for (const b of buildings){
      if (!covered.has(b)) problems.push('[店员]「' + b + '」没有店员，这家店会一直是空的');
    }
  }

  /* V4.20 小店柜台：店员说"柜台能买"，那柜台就得真的存在。
   * 之前便利店/咖啡店/奶茶店没有货架、菜市场连柜台都开不出来（食材数据配了却进不去），
   * 店员台词就成了空话。这里把"每个店员所在的店必须能交互"变成硬约束。 */
  {
    const eco = packs['rules/economy.json'] || {};
    const jobs = (packs['careers/jobs.json'] || {}).jobs || [];
    const jobZones = new Set(jobs.map(j => j.zone).filter(Boolean));
    const counterZones = new Set();
    for (const m of (Array.isArray(eco.marts) ? eco.marts : [])){
      if (!m || !m.zone) continue;
      if (counterZones.has(m.zone)) problems.push('[柜台] marts 里 zone 重复: ' + m.zone);
      counterZones.add(m.zone);
      if (!m.name) problems.push('[柜台] ' + m.zone + ' 缺少 name');
      const goods = Array.isArray(m.goods) ? m.goods : [];
      if (!goods.length) problems.push('[柜台] ' + m.zone + ' 一件货都没有，货架会是空的');
      const gid = new Set();
      for (const g of goods){
        if (!g.id) { problems.push('[柜台] ' + m.zone + ' 有商品缺少 id'); continue; }
        if (gid.has(g.id)) problems.push('[柜台] ' + m.zone + ' 商品 id 重复: ' + g.id);
        gid.add(g.id);
        if (!g.name) problems.push('[柜台] ' + g.id + ' 缺少 name');
        if (!(Number(g.price) >= 1)) problems.push('[柜台] ' + g.id + ' 价格必须 ≥ 1');
        const eff = (Number(g.hunger) || 0) + (Number(g.thirst) || 0) + (Number(g.emotion) || 0);
        if (eff <= 0) problems.push('[柜台] ' + g.id + ' 没有任何效果，买了等于白花钱');
      }
    }
    for (const g of (Array.isArray(eco.groceries) ? eco.groceries : [])){
      if (!g || !g.zone) continue;
      counterZones.add(g.zone);              // 只卖食材的店也算有柜台
      if (!(Number(g.pack) >= 1) || !(Number(g.price) >= 1))
        problems.push('[食材] ' + g.zone + ' 的 pack/price 必须 ≥ 1');
    }
    if (eco.mart && eco.mart.zone) counterZones.add(eco.mart.zone);
    if (eco.restaurant && eco.restaurant.zone) counterZones.add(eco.restaurant.zone);

    /* 这五家店点开是各自的专用面板（银行/证券/彩票/4S/宠物），没有柜台也没有岗位 */
    const PANEL_ONLY = new Set(['shop_bank', 'shop_stock', 'shop_lottery', 'shop_car', 'shop_pet']);

    const pk = packs['characters/npcs.neighbors.json'] || {};
    /* V4.27 场所 NPC：学校门口/球场/公园/沙地这类"本来就该有人"的地方。
     * zone 必须是真实存在的地点，而且不能是商铺（商铺该配 clerk，那是有柜台的）。 */
    {
      const zones = {};
      for (const [rel, m] of Object.entries(packs)){
        if (!rel.startsWith('maps/') || !m || !Array.isArray(m.zones)) continue;
        for (const z of m.zones) zones[z.id] = z;
      }
      const siteIds = new Set();
      for (const s0 of (pk.sites || [])){
        if (!s0.id) { problems.push('[场所] 有场所 NPC 缺少 id'); continue; }
        if (siteIds.has(s0.id)) problems.push('[场所] id 重复: ' + s0.id);
        siteIds.add(s0.id);
        const z = zones[s0.zoneId];
        if (!z) problems.push('[场所] ' + s0.id + ' 的 zoneId「' + s0.zoneId + '」不是地图上的地点');
        /* 只拦商铺：店里该配 clerk（有柜台、要上班）。
         * 公共建筑放得下场所 NPC——学校门口等家长的孩子就是这种。 */
        else if (z.kind === 'shop')
          problems.push('[场所] ' + s0.id + ' 站在商铺里——店里该配 clerk，场所 NPC 放公共场所');
        const h = s0.hours;
        if (!Array.isArray(h) || h.length !== 2 || !h.every(v => Number(v) >= 0 && Number(v) <= 24))
          problems.push('[场所] ' + s0.id + ' hours 必须是 [开,关] 两个 0..24 的数字');
        for (const pool of ['hello', 'tip']){
          const arr = (s0.lines || {})[pool];
          if (!Array.isArray(arr) || !arr.length)
            problems.push('[场所] ' + s0.id + ' 的 lines.' + pool + ' 至少要有 1 句');
        }
      }
    }
    for (const c of (pk.clerks || [])){
      const z = c.zoneId;
      if (!z) continue;
      if (counterZones.has(z) || jobZones.has(z) || PANEL_ONLY.has(z)) continue;
      problems.push('[店员] ' + c.id + ' 所在的「' + z + '」既没有柜台也没有岗位，' +
        '店员说的"柜台能买"会是空话');
    }
  }

  /* V4.21 网购：折扣与等待天数写歪了不会报错，只会让"网购"变成稳赚或者慢到没人用 */
  {
    const eco = packs['rules/economy.json'] || {};
    const on = eco.online;
    if (on){
      const shops = new Set();
      for (const [rel, m] of Object.entries(packs)){
        if (!rel.startsWith('maps/') || !m || !Array.isArray(m.zones)) continue;
        for (const z of m.zones) if (z.kind === 'shop' || z.kind === 'civic') shops.add(z.id);
      }
      if (!on.zone) problems.push('[网购] 缺少 zone（包裹放在哪个门面取）');
      else if (!shops.has(on.zone)) problems.push('[网购] zone「' + on.zone + '」不是商铺/公共建筑');
      const k = Number(on.discount);
      if (!(k > 0.5 && k < 1)) problems.push('[网购] discount 应在 0.5~1 之间（现在 ' + on.discount + '），1 就没有下单的理由，太低等于印钱');
      const days = Number(on.days);
      if (!(days >= 0 && days <= 5)) problems.push('[网购] days 应在 0~5（现在 ' + on.days + '）');
      if (!on.name) problems.push('[网购] 缺少 name');
      if (!on.note) problems.push('[网购] 缺少 note（面板上要有一句话解释为什么便宜）');
    } else {
      problems.push('[网购] 缺少 economy.online 配置');
    }
  }

  /* V4.22 熟客好感：等级表写歪了不会报错，只会让"熟客"比"朋友"还便宜，或者满级毫无意义 */
  {
    const eco = packs['rules/economy.json'] || {};
    const f = eco.favor;
    if (!f) problems.push('[好感] 缺少 economy.favor 配置');
    else {
      const cap = Number(f.dailyCap);
      if (!(cap >= 1 && cap <= 10)) problems.push('[好感] dailyCap 应在 1~10（现在 ' + f.dailyCap + '）');
      const lv = Array.isArray(f.levels) ? f.levels.slice() : [];
      if (lv.length < 2) problems.push('[好感] levels 至少要有两级');
      let prevAt = -1, prevDisc = 2, prevName = '';
      for (const l of lv){
        const at = Number(l.at);
        if (!(at >= 0)) problems.push('[好感] 等级 at 必须 ≥ 0');
        if (at <= prevAt) problems.push('[好感] 等级 at 必须严格递增，且按从小到大的顺序写');
        const d = Number(l.discount);
        if (!(d > 0.5 && d <= 1)) problems.push('[好感] ' + (l.name || at) + ' 的 discount 应在 0.5~1');
        if (d > prevDisc) problems.push('[好感] ' + (l.name || at) + ' 的折扣比上一级还贵——等级不能越升越亏');
        if (!l.name) problems.push('[好感] 等级缺少 name');
        else if (l.name === prevName) problems.push('[好感] 等级名重复: ' + l.name);
        const h = Number(l.hearts);
        if (!(h >= 0 && h <= 3)) problems.push('[好感] ' + (l.name || at) + ' 的 hearts 应在 0~3');
        prevAt = at; prevDisc = d; prevName = l.name || '';
      }
      if (lv.length && Number(lv[0].at) !== 0) problems.push('[好感] 第一级的 at 必须是 0（否则 0 点没有等级）');
      const top = lv[lv.length - 1];
      if (top && Number(top.discount) >= 1) problems.push('[好感] 最高一级没有折扣，攒好感就没有意义');
    }
  }

  /* V4.23 熟练等级：这套规则以前硬编码在 careerPay 里，现在放内容里了，得有人管 */
  {
    const cj = packs['careers/jobs.json'] || {};
    const c = cj.career;
    if (!c){
      problems.push('[职业] 缺少 career 块（maxLevel / payPerLevel / shiftsPerLevel）');
    } else {
      const lv = Number(c.maxLevel), step = Number(c.payPerLevel), per = Number(c.shiftsPerLevel);
      if (!(lv >= 1 && lv <= 10)) problems.push('[职业] career.maxLevel 应在 1~10（现在 ' + c.maxLevel + '）');
      if (!(step > 0 && step <= 0.5)) problems.push('[职业] career.payPerLevel 应在 0~0.5（现在 ' + c.payPerLevel + '），超过 0.5 一级太陡');
      if (!(per >= 1 && per <= 20)) problems.push('[职业] career.shiftsPerLevel 应在 1~20（现在 ' + c.shiftsPerLevel + '）');
      /* 满级总涨幅：太低等于没有成长，太高等于白送钱 */
      const total = step * lv;
      if (total < 0.1) problems.push('[职业] 满级只多 ' + Math.round(total * 100) + '%，升级几乎没有意义（建议 ≥ 10%）');
      if (total > 1.0) problems.push('[职业] 满级多 ' + Math.round(total * 100) + '%，超过翻倍太陡（建议 ≤ 100%）');
      /* 每级跨度太大：升一级从天到地 */
      if (step > 0.25) problems.push('[职业] 每级 +' + Math.round(step * 100) + '% 太陡，建议 ≤ 25%');
    }
    for (const j of (cj.jobs || [])){
      if (j.promoShifts != null && !(Number(j.promoShifts) >= 1 && Number(j.promoShifts) <= 20))
        problems.push('[职业] ' + j.id + ' 的 promoShifts 应在 1~20');
    }
  }

  /* V4.24 剪影配饰：写错一个字母，那个人身上的配饰就静默消失（渲染层当作没有） */
  {
    const ACC = ['none', 'apron', 'band', 'bag', 'tote', 'scarf', 'cane'];
    /* 年龄是四个阶段：儿童 / 青年 / 中年 / 老年。老名字（kid/teen/adult/elder）
     * 只留在引擎里做存档别名，内容里再写就报错，免得两套名字越漂越远。 */
    const AGES = ['child', 'youth', 'middle', 'senior'];
    const SEXES = ['f', 'm', 'x'];
    const UNIS = ['food', 'office', 'medical', 'uniform', 'delivery', 'chef', 'shop'];
    const HAIRS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    /* 写错一个字母，那一层就静默不画——人物看不出年龄/职业，界面上不会有任何报错 */
    const check = (who, ap) => {
      if (!ap) return;
      if (ap.acc != null && !ACC.includes(ap.acc))
        problems.push('[人物] ' + who + ' 的 appearance.acc「' + ap.acc + '」不在白名单（' + ACC.join('/') + '）');
      if (ap.age != null && !AGES.includes(ap.age))
        problems.push('[人物] ' + who + ' 的 appearance.age「' + ap.age + '」不在白名单（' + AGES.join('/') + '）');
      if (ap.sex != null && !SEXES.includes(ap.sex))
        problems.push('[人物] ' + who + ' 的 appearance.sex「' + ap.sex + '」只能是 f/m/x');
      if (ap.uniform != null && !UNIS.includes(ap.uniform))
        problems.push('[人物] ' + who + ' 的 appearance.uniform「' + ap.uniform + '」不在白名单（' + UNIS.join('/') + '）');
      const FACIALS = ['stubble', 'mustache', 'beard'];
      if (ap.facial != null && !FACIALS.includes(ap.facial))
        problems.push('[人物] ' + who + ' 的 appearance.facial「' + ap.facial + '」不在白名单（' + FACIALS.join('/') + '）');
      if (ap.earring != null && typeof ap.earring !== 'boolean')
        problems.push('[人物] ' + who + ' 的 appearance.earring 必须是 true/false');
      if (ap.hairStyle != null && !HAIRS.includes(ap.hairStyle))
        problems.push('[人物] ' + who + ' 的 hairStyle 必须在 0~10（现在 ' + ap.hairStyle + '）');
    };
    const pk = packs['characters/npcs.neighbors.json'] || {};
    for (const n of (pk.npcs || [])) check(n.id || n.name, n.appearance);
    for (const c of (pk.clerks || [])) check(c.id, c.appearance);
    /* V4.26 撞衫：年龄/性别/制服/配饰/发型 五项全同的两个人，屏幕上只差衣服颜色。
     * 这是 game-art-prompt-pack 硬规则 4（每个主体唯一识别线索）的机器化版本。
     * 同一条街上有两个"长得一样"的店员，玩家就会开始怀疑自己记错了。 */
    {
      const seen = {};
      const all = [...(pk.npcs || []), ...(pk.clerks || [])];
      for (const x of all){
        const a = x.appearance || {};
        const k = [a.age || 'middle', a.sex || 'x', a.uniform || '', a.acc || 'none',
                   String(a.hairStyle == null ? 0 : a.hairStyle)].join('|');
        if (seen[k]) problems.push('[人物] ' + (x.name || x.id) + ' 与 ' + seen[k] +
          ' 五项全同（年龄/性别/制服/配饰/发型），屏幕上只差衣服颜色');
        else seen[k] = (x.name || x.id);
      }
    }

    /* V4.30 职业：身份三件套里的第三个字段（年龄阶段 / 性别 / 职业）。
     * 没有 job 的人照样能走能说，只是永远只说通用台词、也不穿制服——
     * 这种缺失不会报任何错，所以必须在这里拦。 */
    {
      const jobs = Array.isArray(pk.jobs) ? pk.jobs : [];
      const byId = {};
      const UNIS = ['food', 'office', 'medical', 'uniform', 'delivery', 'chef', 'shop'];
      if (!jobs.length) problems.push('[职业] 人物包里没有 jobs[] 职业表，身份就少一条腿');
      for (const j of jobs){
        if (!j || !j.id){ problems.push('[职业] jobs[] 里有条目缺少 id'); continue; }
        if (byId[j.id]) problems.push('[职业] 职业 id 重复: ' + j.id);
        if (!j.name) problems.push('[职业] ' + j.id + ' 缺少 name（档案卡上会显示空白）');
        if (j.uniform != null && !UNIS.includes(j.uniform))
          problems.push('[职业] ' + j.id + ' 的默认制服「' + j.uniform + '」不在白名单');
        byId[j.id] = j;
      }
      const people = [...(pk.npcs || []), ...(pk.clerks || []), ...(pk.sites || [])];
      for (const x of people){
        const ap = x.appearance || {};
        if (!ap.job){ problems.push('[职业] ' + (x.name || x.id) + ' 没有 appearance.job'); continue; }
        const j = byId[ap.job];
        if (!j){ problems.push('[职业] ' + (x.name || x.id) + ' 的职业「' + ap.job + '」不在 jobs[] 里'); continue; }
        if (ap.uniform && j.uniform && ap.uniform !== j.uniform)
          problems.push('[职业] ' + (x.name || x.id) + ' 穿的是 ' + ap.uniform + '，但「' + j.name + '」的默认制服是 ' + j.uniform);
      }
    }

    /* V4.31 身份合理性：随机安排身份最容易出的就是"小孩跑去上班"、
     * "退休的人站在柜台后面收银"、"护士在便利店收银"。规则全写在
     * jobs[]（ages/where/zones/kind）和 placeAges 里，这里逐人核对。 */
    {
      const jobs = Array.isArray(pk.jobs) ? pk.jobs : [];
      const byId = {};
      for (const j of jobs) if (j && j.id) byId[j.id] = j;
      const STAGES = ['child', 'youth', 'middle', 'senior'];
      const WHERE = ['any', 'shop', 'civic', 'street', 'outdoor'];
      const OUTDOOR = new Set(['park', 'court', 'sand', 'pond', 'garden', 'plaza']);
      const zoneKind = {};
      for (const [rel, m] of Object.entries(packs)){
        if (!rel.startsWith('maps/') || !m || !Array.isArray(m.zones)) continue;
        for (const z of m.zones) zoneKind[z.id] = z.kind;
      }
      for (const j of jobs){
        if (!Array.isArray(j.ages) || !j.ages.length)
          problems.push('[职业] ' + j.id + ' 缺少 ages（允许的年龄阶段）——等于谁都能干');
        else for (const a of j.ages)
          if (!STAGES.includes(a)) problems.push('[职业] ' + j.id + ' 的 ages 里有非法阶段「' + a + '」');
        if (!Array.isArray(j.where) || !j.where.length)
          problems.push('[职业] ' + j.id + ' 缺少 where（允许的工作地点）');
        else for (const w of j.where)
          if (!WHERE.includes(w)) problems.push('[职业] ' + j.id + ' 的 where 里有非法地点「' + w + '」');
        if (j.kind != null && j.kind !== 'work' && j.kind !== 'idle')
          problems.push('[职业] ' + j.id + ' 的 kind 只能是 work（在岗）/ idle（不在岗）');
        if (j.zones != null){
          if (!Array.isArray(j.zones) || !j.zones.length)
            problems.push('[职业] ' + j.id + ' 的 zones 必须是非空数组');
          else for (const z of j.zones)
            if (!zoneKind[z]) problems.push('[职业] ' + j.id + ' 的 zones 里「' + z + '」不是地图上的地点');
        }
      }
      const placeAges = pk.placeAges || {};
      for (const [z, list] of Object.entries(placeAges)){
        if (!zoneKind[z]) problems.push('[场所] placeAges 里的「' + z + '」不是地图上的地点');
        for (const a of (list || []))
          if (!STAGES.includes(a)) problems.push('[场所] ' + z + ' 的年龄偏好里有非法阶段「' + a + '」');
      }
      const whereOk = (j, kind) => {
        const w = Array.isArray(j.where) ? j.where : ['any'];
        return w.includes('any') || w.includes(kind) || (OUTDOOR.has(kind) && w.includes('outdoor'));
      };
      const checkOne = (p, role) => {
        const ap = p.appearance || {};
        const j = byId[ap.job];
        if (!j) return;                                  // 缺职业由 V4.30 报过
        const age = ap.age || 'middle';
        const nm = p.name || p.id;
        if (Array.isArray(j.ages) && !j.ages.includes(age))
          problems.push('[身份] ' + nm + ' 是「' + age + '」，但「' + j.name + '」只收 ' + j.ages.join('/') + '——小孩不能跑去上班');
        if (age === 'child' && ap.job !== 'student')
          problems.push('[身份] ' + nm + ' 是儿童却干着「' + j.name + '」，儿童只能是学生');
        if (role === 'clerk' && j.kind === 'idle')
          problems.push('[身份] ' + nm + ' 守店，但「' + j.name + '」不是在岗职业');
        if (role === 'site' && j.kind !== 'idle')
          problems.push('[身份] ' + nm + ' 只是待在场地上，不该有岗位「' + j.name + '」');
        if (role !== 'neighbor' && p.zoneId){
          const kind = zoneKind[p.zoneId];
          if (kind && !whereOk(j, kind))
            problems.push('[身份] ' + nm + ' 是「' + j.name + '」，却在 ' + p.zoneId + '（' + kind + '）');
          if (Array.isArray(j.zones) && j.zones.length && !j.zones.includes(p.zoneId))
            problems.push('[身份] ' + nm + ' 是「' + j.name + '」，' + p.zoneId + ' 这一家不该有这个人');
        }
        if (role === 'site' && Array.isArray(placeAges[p.zoneId]) && !placeAges[p.zoneId].includes(age))
          problems.push('[身份] ' + nm + ' 是「' + age + '」，但 ' + p.zoneId + ' 通常是 ' + placeAges[p.zoneId].join('/'));
      };
      for (const p of (pk.npcs || [])) checkOne(p, 'neighbor');
      for (const p of (pk.clerks || [])) checkOne(p, 'clerk');
      for (const p of (pk.sites || [])) checkOne(p, 'site');
    }

    /* V4.32 聊天话题：玩家问什么、NPC 按身份怎么答。
     * 写漏了不会报错，只会出现"问了没反应"或者"往 走两步， 就在那儿"。 */
    {
      const tp = packs['characters/topics.json'];
      const STAGES2 = ['child', 'youth', 'middle', 'senior'];
      const ALLOWED_PH = new Set(['time', 'zone', 'dir', 'hint', 'name']);
      if (!tp){
        problems.push('[话题] 缺少 characters/topics.json，NPC 就只剩三条老动作');
      } else {
        const list = Array.isArray(tp.topics) ? tp.topics : [];
        const answers = tp.answers || {};
        if (list.length < 5) problems.push('[话题] 话题只有 ' + list.length + ' 个，玩家没什么可问的');
        const ids = new Set();
        for (const t of list){
          if (!t.id){ problems.push('[话题] 有话题缺少 id'); continue; }
          if (ids.has(t.id)) problems.push('[话题] 话题 id 重复: ' + t.id);
          ids.add(t.id);
          if (!t.label) problems.push('[话题] ' + t.id + ' 缺少 label（菜单上会是空白）');
          else if (String(t.label).length > 6) problems.push('[话题] ' + t.id + ' 的 label 超过 6 字，菜单会换行: ' + t.label);
          if (t.emotion != null && !(Number(t.emotion) >= 0 && Number(t.emotion) <= 10))
            problems.push('[话题] ' + t.id + ' 的 emotion 应在 0~10');
        }
        const jobs = (pk.jobs || []).map(j => j.id);
        for (const [tid, entry] of Object.entries(answers)){
          if (ids.has(tid) || tid === 'fallback') continue;
          if (typeof entry === 'object' && !Array.isArray(entry)) continue;
        }
        for (const id of ids){
          const entry = answers[id];
          if (!entry || Array.isArray(entry) || !Object.keys(entry).length){
            problems.push('[话题] ' + id + ' 没有任何答案，问下去会很尴尬');
            continue;
          }
          if (!Array.isArray(entry.any) || !entry.any.length)
            problems.push('[话题] ' + id + ' 缺少 any（通用答案），冷门身份的人就答不上来');
          for (const [k, pool] of Object.entries(entry)){
            if (k === 'fallback') continue;
            if (k === 'byJob'){
              for (const [jid, arr] of Object.entries(pool || {})){
                if (!jobs.includes(jid)) problems.push('[话题] ' + id + '.byJob 里的「' + jid + '」不是职业表里的 id');
                if (!Array.isArray(arr) || !arr.length) problems.push('[话题] ' + id + '.byJob.' + jid + ' 是空的');
              }
              continue;
            }
            if (k === 'byAge'){
              for (const [aid, arr] of Object.entries(pool || {})){
                if (!STAGES2.includes(aid)) problems.push('[话题] ' + id + '.byAge 里的「' + aid + '」不是年龄阶段');
                if (!Array.isArray(arr) || !arr.length) problems.push('[话题] ' + id + '.byAge.' + aid + ' 是空的');
              }
              continue;
            }
            if (!Array.isArray(pool)) { problems.push('[话题] ' + id + '.' + k + ' 必须是数组'); continue; }
            for (const line of pool){
              if (typeof line !== 'string' || !line){ problems.push('[话题] ' + id + '.' + k + ' 有空台词'); continue; }
              if (line.length > 26) problems.push('[话题] ' + id + ' 有 ' + line.length + ' 字的长句，气泡装不下：' + line);
              for (const m of line.matchAll(/\{([a-zA-Z]+)\}/g)){
                if (!ALLOWED_PH.has(m[1]))
                  problems.push('[话题] ' + id + ' 用了未知占位符 {' + m[1] + '}，界面上会原样显示');
              }
            }
          }
        }
        /* 时间那句要靠 hints 接话，缺一档就会出现"十点四十了，"这种半句 */
        const hints = tp.hints || {};
        for (const k of ['morning', 'noon', 'afternoon', 'evening', 'night']){
          if (!Array.isArray(hints[k]) || !hints[k].length)
            problems.push('[话题] hints.' + k + ' 是空的，"现在几点了"会答成半句');
        }
      }
    }

    /* V4.33 对话参数：气泡尺寸/停留时长/方位阈值集中到 ui/talk.json 之后，
     * 写错一个数不会崩，只会"气泡扁成一条"或者"一句话闪一下就没"。
     * 顺便查玩家身份映射：身份下拉的每一项都得对应一个不在岗的职业。 */
    {
      const tk = packs['ui/talk.json'];
      if (!tk){
        problems.push('[对话] 缺少 ui/talk.json，气泡尺寸与时长就没有统一出口');
      } else {
        const b = tk.bubble || {}, ls = tk.lineSec || {}, ch = tk.chatter || {};
        const pl = tk.place || {}, tp2 = tk.topics || {};
        const num = (v) => typeof v === 'number' && isFinite(v);
        if (!num(b.fontPx) || b.fontPx < 11 || b.fontPx > 18)
          problems.push('[对话] bubble.fontPx 应在 11~18（现在 ' + b.fontPx + '）');
        if (!num(b.maxWidth) || b.maxWidth < 120 || b.maxWidth > 400)
          problems.push('[对话] bubble.maxWidth 应在 120~400（现在 ' + b.maxWidth + '）');
        if (!num(b.lineHeight) || b.lineHeight < (b.fontPx || 13))
          problems.push('[对话] bubble.lineHeight 不能小于字号，否则两行会叠在一起');
        if (!num(b.padX) || !num(b.padY) || b.padX < 0 || b.padY < 0)
          problems.push('[对话] bubble.padX/padY 必须是非负数');
        if (!num(b.tailHeight) || b.tailHeight < 2 || b.tailHeight > 14)
          problems.push('[对话] bubble.tailHeight 应在 2~14（太小看不见，太大像泪滴）');
        if (!num(b.fadeInSec) || b.fadeInSec <= 0 || b.fadeInSec > 1)
          problems.push('[对话] bubble.fadeInSec 应在 0~1 秒');
        if (!num(b.fadeOutSec) || b.fadeOutSec <= 0 || b.fadeOutSec > 1)
          problems.push('[对话] bubble.fadeOutSec 应在 0~1 秒');
        for (const k of ['fill', 'stroke', 'textColor'])
          if (!b[k] || typeof b[k] !== 'string') problems.push('[对话] bubble.' + k + ' 缺颜色值');
        if (!num(ls.min) || !num(ls.max) || ls.min >= ls.max)
          problems.push('[对话] lineSec.min 必须小于 max');
        if (!num(ls.base) || !num(ls.perChar) || ls.base <= 0 || ls.perChar < 0.05 || ls.perChar > 0.5)
          problems.push('[对话] lineSec.base/perChar 不合理（base>0，perChar 0.05~0.5）');
        for (const k of ['retryMinutes', 'retryWhenPanel', 'retryOffScene'])
          if (!num(ch[k]) || ch[k] < 1 || ch[k] > 30)
            problems.push('[对话] chatter.' + k + ' 应在 1~30 游戏分钟（现在 ' + ch[k] + '）');
        if (!num(ch.pairCandidates) || ch.pairCandidates < 1 || ch.pairCandidates > 6)
          problems.push('[对话] chatter.pairCandidates 应在 1~6');
        if (!num(pl.rangeTiles) || pl.rangeTiles < 4 || pl.rangeTiles > 30)
          problems.push('[对话] place.rangeTiles 应在 4~30（太小说不到，太大指着天边）');
        if (!num(pl.dirDeadZone) || pl.dirDeadZone < 0 || pl.dirDeadZone > 5)
          problems.push('[对话] place.dirDeadZone 应在 0~5');
        if (!num(tp2.emotionDefault) || tp2.emotionDefault < 0 || tp2.emotionDefault > 10)
          problems.push('[对话] topics.emotionDefault 应在 0~10');
      }

      /* 时段边界：四刀切五档，必须严格递增且落在 0~24 */
      const tpc = packs['characters/topics.json'] || {};
      const bounds = (tpc.hints || {}).bounds;
      if (!Array.isArray(bounds) || bounds.length !== 4)
        problems.push('[对话] topics.hints.bounds 必须是 4 个边界（切出 morning/noon/afternoon/evening/night）');
      else {
        let prev = -1;
        for (const v of bounds){
          if (!(Number(v) > prev && Number(v) < 24))
            problems.push('[对话] hints.bounds 必须严格递增且在 0~24 之内：' + bounds.join(','));
          prev = Number(v);
        }
      }

      /* 玩家身份：只是档案卡上的称呼 + 决定立绘制服，不绑定工作地点，
       * 所以只查"中文不重复、排序不重复"。 */
      const seenRole = {};
      const seenOrder = {};
      for (const j of (pk.jobs || [])){
        if (!j.playerRole) continue;
        if (seenRole[j.playerRole]) problems.push('[身份] 玩家身份「' + j.playerRole + '」重复出现');
        seenRole[j.playerRole] = j.id;
        const o = j.playerOrder ?? 99;
        if (seenOrder[o]) problems.push('[身份] 玩家身份排序 ' + o + ' 撞车：' + seenOrder[o] + ' / ' + j.playerRole);
        seenOrder[o] = j.playerRole;
      }
      if (Object.keys(seenRole).length < 3)
        problems.push('[身份] 玩家可选身份只有 ' + Object.keys(seenRole).length + ' 个，档案卡太单调');
    }

    /* 一个人都没有配饰，说明这层等于没做——街区里所有剪影会一模一样 */
    const withAcc = [...(pk.npcs || []), ...(pk.clerks || [])]
      .filter(x => x.appearance && x.appearance.acc && x.appearance.acc !== 'none');
    if (!withAcc.length) problems.push('[人物] 没有任何人配剪影配饰，人群会只靠颜色区分');
  }

  /* V4 引用完整性：地图 → 房屋/NPC/目标地图 */
  const mapIds = new Set(all.filter(p => p.renderer).map(p => p.id));
  for (const p of all.filter(p => p.renderer)){
    for (const portal of p.portals || []){
      if (portal.target && !mapIds.has(portal.target)){
        problems.push(`[引用] ${p.id} 的门 ${portal.id} 指向不存在的地图 ${portal.target}`);
      }
    }
    for (const h of p.houses || []){
      if (h.owner && !/^npc\./.test(h.owner)) problems.push(`[引用] ${p.id}/${h.id} 的 owner 命名不规范: ${h.owner}`);
    }
  }
  const npcPack = packs['characters/npcs.neighbors.json'];
  if (npcPack){
    const street = packs['maps/street.map.json'];
    const houseIds = new Set((street?.houses || []).map(h => h.id));
    for (const n of npcPack.npcs){
      if (n.home && !houseIds.has(n.home)) problems.push(`[引用] NPC ${n.id} 的 home 不存在: ${n.home}`);
      if (!n.appearance) problems.push(`[引用] NPC ${n.id} 缺少 appearance`);
    }
  }

  /* V5 地图可达性：从门口出发能否走到每个室内格（历史 BUG：幻影墙把院子封死） */
  if (house){
    const origin = house.origin || { x: 3, y: 3 };
    const margin = house.yardMargin ?? 3;
    for (const lv of house.levels){
      const gw = lv.footprint.w + margin * 2;
      const gh = lv.footprint.h + margin * 2;
      const blocked = (x, y) => {
        if (x <= 0 || y <= 0 || x >= gw - 1 || y >= gh - 1) return true;      // 外圈围栏
        const L = origin.x, R = origin.x + lv.footprint.w + 1;
        const T = origin.y, B = origin.y + lv.footprint.h + 1;
        const onHouseWall = (x >= L && x <= R && y >= T && y <= B) && (x === L || x === R || y === T || y === B);
        const doorX = origin.x + Math.floor(lv.footprint.w / 2) + 1;
        const doorY = origin.y + lv.footprint.h + 1;
        if (x === doorX && y === doorY) return false;                          // 房门可通行
        if (onHouseWall) return true;
        return lv.walls.some(w => w.x === x && w.y === y);
      };
      const start = { x: origin.x + Math.floor(lv.footprint.w / 2) + 1, y: origin.y + lv.footprint.h }; // 门内一格
      const seenCells = new Set([start.x + ',' + start.y]);
      const queue = [start];
      while (queue.length){
        const { x, y } = queue.shift();
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const nx = x + dx, ny = y + dy;
          const k = nx + ',' + ny;
          if (seenCells.has(k)) continue;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          if (blocked(nx, ny)) continue;
          seenCells.add(k);
          queue.push({ x: nx, y: ny });
        }
      }
      const unreachable = [];
      for (let y = origin.y + 1; y <= origin.y + lv.footprint.h; y++){
        for (let x = origin.x + 1; x <= origin.x + lv.footprint.w; x++){
          if (blocked(x, y)) continue;            // 隔墙格本身不算功能区域
          if (!seenCells.has(x + ',' + y)) unreachable.push(`(${x},${y})`);
        }
      }
      if (unreachable.length){
        problems.push(`[可达性] ${lv.name} 有 ${unreachable.length} 个室内格走不到（门在 (${start.x},${origin.y + lv.footprint.h + 1})）：${unreachable.slice(0, 8).join(' ')}${unreachable.length > 8 ? ' …' : ''}`);
      }
    }
  }

  /* V6 规则包：表达式白名单 */
  const climate = packs['environment/climate.json'];
  if (climate){
    const ws = climate.weathers || [];
    if (!ws.length) problems.push('[环境] climate.weathers 为空');
    if (!(climate.slotMinutes >= 30)) problems.push('[环境] slotMinutes 过小（<30）');
    for (const w of ws){
      if (!w.id) problems.push('[环境] 天气缺少 id');
      if (!(w.weight > 0)) problems.push('[环境] 天气 ' + w.id + ' 权重非正');
      if (!(w.light > 0 && w.light <= 1)) problems.push('[环境] 天气 ' + w.id + ' light 应在 (0,1]');
    }
  }
  const ambient = packs['environment/ambient.json'];
  if (ambient){
    const st = (ambient.growth && ambient.growth.stages) || [];
    let last = -1;
    for (const stg of st){
      const at = stg.afterMinutes || 0;
      if (at <= last) problems.push('[环境] 生长阶段时间必须递增: ' + stg.id);
      last = at;
    }

    /* V4.28 街坊闲聊：写歪了不会报错，只会让"两个人各说各的"或者
     * 一句长到气泡装不下的台词贴在头上。 */
    const chat = ambient.chatter;
    if (!chat){
      problems.push('[闲聊] environment/ambient.json 缺少 chatter 配置');
    } else {
      const WHEN = new Set(['any', 'morning', 'day', 'eve', 'night', 'rain', 'meal']);
      const topics = Array.isArray(chat.topics) ? chat.topics : [];
      const solos = Array.isArray(chat.solos) ? chat.solos : [];
      const ids = new Set();
      let anyCount = 0;
      if (topics.length < 8) problems.push(`[闲聊] topics 只有 ${topics.length} 组，街上很快就会重复`);
      for (const t of topics){
        if (!t || !t.id){ problems.push('[闲聊] 有一组话题缺少 id'); continue; }
        if (ids.has(t.id)) problems.push('[闲聊] 话题 id 重复: ' + t.id);
        ids.add(t.id);
        const w = t.when || 'any';
        if (!WHEN.has(w)) problems.push(`[闲聊] ${t.id} 的 when「${w}」不是 any/morning/day/eve/night/rain/meal`);
        if (w === 'any') anyCount++;
        const lines = Array.isArray(t.lines) ? t.lines : [];
        if (lines.length < 2) problems.push(`[闲聊] ${t.id} 至少要两句（一问一答），现在 ${lines.length} 句`);
        const who = new Set();
        for (const l of lines){
          if (!l || !l.t){ problems.push(`[闲聊] ${t.id} 有空台词`); continue; }
          const s = l.s || 'a';
          if (s !== 'a' && s !== 'b') problems.push(`[闲聊] ${t.id} 的说话人只能是 a/b，现在 ${s}`);
          who.add(s);
          if (String(l.t).length > 16)
            problems.push(`[闲聊] ${t.id} 有 ${String(l.t).length} 字的长句，气泡会折行：${l.t}`);
        }
        if (!who.has('a') || !who.has('b')) problems.push(`[闲聊] ${t.id} 得两个人各说一句（缺 a 或 b）`);
      }
      if (anyCount < 6) problems.push(`[闲聊] when=any 的话题只有 ${anyCount} 组，不到 6 组时段外就没什么可聊`);
      if (solos.length < 6) problems.push(`[闲聊] solos 只有 ${solos.length} 句，独白会反复`);
      for (const s of solos){
        if (!s || !s.t){ problems.push('[闲聊] solos 有空台词'); continue; }
        const w = s.when || 'any';
        if (!WHEN.has(w)) problems.push(`[闲聊] 独白 when「${w}」不合法`);
        if (String(s.t).length > 16) problems.push(`[闲聊] 独白过长：${s.t}`);
      }
      const cd = Number(chat.cooldownMinutes);
      if (!(cd >= 8)) problems.push(`[闲聊] cooldownMinutes 应 ≥ 8（现在 ${chat.cooldownMinutes}），太短会一直有人说话`);
      const rg = Number(chat.rangeTiles);
      if (!(rg >= 2 && rg <= 8)) problems.push(`[闲聊] rangeTiles 应在 2~8（现在 ${chat.rangeTiles}）`);

      /* V4.29 台词认人：who/avoid 写错一个字母不会报错——标签永远匹配不上，
       * 那句台词就被静默吞掉，谁都听不到。这里把"标签表"和"有没有这个人"都查一遍。 */
      {
        /* 标签词表 = 身份（clerk/site/neighbor）+ 年龄阶段 + 性别 + 职业 id。
         * 职业那部分直接从 jobs[] 长出来，加一个职业不用回来改这里。 */
        const TAGS = new Set(['clerk', 'site', 'neighbor', 'child', 'youth', 'middle', 'senior',
                              'male', 'female']);
        for (const j of (packs['characters/npcs.neighbors.json'] || {}).jobs || [])
          if (j && j.id) TAGS.add(j.id);
        /* 场上真有这些标签的人吗：没有就说明这条台词永远说不出口 */
        const has = new Set();
        const pk = packs['characters/npcs.neighbors.json'] || {};
        for (const [list, role] of [[pk.npcs, 'neighbor'], [pk.clerks, 'clerk'], [pk.sites, 'site']]){
          for (const p of (list || [])){
            const a = p.appearance || {};
            has.add(role);
            has.add(a.age || 'middle');
            has.add(a.sex === 'f' ? 'female' : 'male');
            if (a.job) has.add(a.job);
          }
        }
        const unknownTag = [], noOne = [];
        const whoCount = {};
        let free = 0;
        for (const t of topics){
          const who = Array.isArray(t.who) ? t.who : [];
          const no = Array.isArray(t.avoid) ? t.avoid : [];
          if (!who.length && !no.length) free++;
          for (const g of who.concat(no)) if (!TAGS.has(g)) unknownTag.push((t.id || '?') + ':' + g);
          for (const g of who){ whoCount[g] = (whoCount[g] || 0) + 1; if (!has.has(g)) noOne.push((t.id || '?') + ':' + g); }
        }
        for (const s of solos){
          const who = Array.isArray(s.who) ? s.who : [];
          const no = Array.isArray(s.avoid) ? s.avoid : [];
          for (const g of who.concat(no)) if (!TAGS.has(g)) unknownTag.push('独白:' + g);
          for (const g of who){ whoCount[g] = (whoCount[g] || 0) + 1; if (!has.has(g)) noOne.push('独白:' + g); }
        }
        if (unknownTag.length)
          problems.push('[闲聊] 没见过的身份标签（永远匹配不上）：' + [...new Set(unknownTag)].slice(0, 6).join(', '));
        if (noOne.length)
          problems.push('[闲聊] 这些标签场上没有任何人，对应的台词一辈子说不出口：' + [...new Set(noOne)].slice(0, 6).join(', '));
        if (free < 4)
          problems.push(`[闲聊] 不限定身份的通用话题只有 ${free} 组，随便两个人凑一起就可能没话可说`);
        if ((whoCount.child || 0) < 4) problems.push(`[闲聊] 认小孩（child）的话题只有 ${whoCount.child || 0} 组，小孩子会像大人一样说话`);
        if ((whoCount.senior || 0) < 3) problems.push(`[闲聊] 认老人（senior）的话题只有 ${whoCount.senior || 0} 组`);
        const tagged = topics.filter(t => Array.isArray(t.who) && t.who.length).length;
        if (tagged < 8) problems.push(`[闲聊] 只有 ${tagged} 组台词认身份，剩下的人凑一起说的都是通用句`);
      }
    }
  }

  const eco = packs['rules/economy.json'];
  if (eco){
    const expr = eco.cozy?.bonusExpr || '';
    const allowed = /^(min|max|round|floor|ceil|sqrt|abs)$/;
    const fns = [...expr.matchAll(/([a-zA-Z_]\w*)\s*\(/g)].map(m => m[1]);
    for (const f of fns) if (!allowed.test(f)) problems.push(`[规则] economy.cozy.bonusExpr 使用了非白名单函数: ${f}`);
  }
  const surv = packs['rules/survival.json'];
  if (surv){
    for (const [k, s] of Object.entries(surv.stats || {})){
      if (s.decayPerGameMinute < 0) problems.push(`[规则] stats.${k} 衰减为负`);
      if (s.initial > s.max) problems.push(`[规则] stats.${k} 初始值超过上限`);
    }
  }

  /* 输出 */
  const itemCount = items.length;
  console.log(`校验 ${manifest.packs.length} 个内容包 / ${itemCount} 件家具 / ${(house?.levels || []).length} 个房型`);
  if (problems.length){
    console.log(`\n发现 ${problems.length} 个问题：`);
    for (const p of problems) console.log('  ✗ ' + p);
    return false;
  }
  console.log('\n✓ 全部检查通过');
  return true;
}

/* ============================== bundle ============================== */

function bundle(){
  const { manifest } = loadPacks();
  // 以磁盘上的实际文件为准：这样新增的包（如 environment/*）无需先跑 extract
  const packIds = listPacks();
  const packs = {};
  for (const rel of packIds) packs[rel] = JSON.parse(fs.readFileSync(path.join(CONTENT, rel), 'utf8'));
  manifest.packs = packIds;
  // bundle 时也刷新一遍版本台账：保证手改过 content/ 也能被识别
  const { versions: curVersions } = bumpVersions(packs);
  manifest.modules = curVersions;
  fs.writeFileSync(path.join(CONTENT, 'manifest.json'), JSON.stringify(
    Object.assign({}, manifest, { modules: curVersions }), null, 2) + '\n', 'utf8');
  const items = Object.values(packs).flatMap(p => p.items || []);
  const house = packs['house/levels.json'];
  const styles = packs['house/styles.json'];

  // 服务端只需要"能算 cozy、能校验"的最小字段集
  const catalog = items.map(it => ({
    id: it.id,
    name: it.name,
    cat: it.category,
    price: it.price,
    w: it.footprint.w,
    h: it.footprint.h,
    cozy: it.cozy,
    walk: !!it.placement?.walkable,
    action: it.interaction ? it.interaction.verb : null
  }));

  const out = {
    version: manifest.contentVersion,
    generatedAt: new Date().toISOString(),
    note: '构建产物：由 tools/content.mjs bundle 生成，请勿手改',
    modules: curVersions,
    catalog,
    houseLevels: (house?.levels || []).map(l => ({ name: l.name, w: l.footprint.w, h: l.footprint.h, price: l.price })),
    floorStyles: (styles?.floors || []).map(f => ({ name: f.name, price: f.price })),
    wallStyles: (styles?.walls || []).map(w => ({ name: w.name, price: w.price }))
  };
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  fs.writeFileSync(BUNDLE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`bundle 完成：${BUNDLE}（catalog ${catalog.length}）`);
}

/* ============================== CLI ============================== */

const cmd = process.argv[2] || 'all';
// all = 校验 + 打包（extract 只在需要从旧单文件补种时手动跑）
if (cmd === 'extract') extract();
if (cmd === 'validate' || cmd === 'all'){
  const okAll = validate();
  if (!okAll) process.exitCode = 1;
}
if ((cmd === 'bundle' || cmd === 'all') && process.exitCode !== 1) bundle();
if (!['extract','validate','bundle','all'].includes(cmd)){
  console.log('用法: node tools/content.mjs [extract|validate|bundle|all]');
  process.exit(2);
}
