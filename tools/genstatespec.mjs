#!/usr/bin/env node
/**
 * 生成 / 校验顶层状态登记表（tools/state-spec.json）。
 *
 *   node tools/genstatespec.mjs --init     首次生成（已有文件会拒绝覆盖）
 *   node tools/genstatespec.mjs --enrich   把新出现、还没登记的状态补进去（不覆盖已有条目）
 *
 * 为什么要有这张表：主程序有 200+ 个顶层可变状态，"哪些是玩法状态、哪些只是缓存、
 * 哪些必须进存档"以前只存在我脑子里。结果就是加字段忘存档、测试随手改全局导致偶发失败。
 * 登记之后：新增一个顶层 let 却没登记，`statemap.mjs --check` 会直接报错。
 *
 * 分类（kind）：
 *   domain   玩法状态。必须标 saved，且 saved:false 时要写 note 说明为什么不存
 *   derived  从内容或常量推导出来的只读结构（找不到就重建，不进存档）
 *   session  会话内瞬态：面板开关、悬停、进行中的动作。刷新即丢，属正常
 *   cache    可随时清空重建的缓存。约定 _ 开头，一眼可辨
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SPEC = path.join(ROOT, 'tools/state-spec.json');
const src = fs.readFileSync(path.join(ROOT, '2.5D小屋.html'), 'utf8');

/* 与 statemap 保持一致：排除 DOM 句柄与画布上下文 */
const NOT_STATE = new Set(['ctx', 'lCtx', 'aCtx', 'canvas', 'SND', 'SAVE', 'HomeCore', 'css', 'body']);
const domBound = new Set();
for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*document\./gm)) domBound.add(m[1]);

const names = [];
for (const m of src.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[|\{)/gm)) names.push(m[1]);
const all = [...new Set(names)].filter(n => !NOT_STATE.has(n) && !domBound.has(n));

const saveBody = (src.match(/function collectSave\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
const isSaved = (n) => new RegExp(`\\b${n}\\b`).test(saveBody);

/* 推导结构：内容/常量/索引/内容派生的对象图。不进存档，重建即可。 */
const DERIVED = new Set([
  'HOUSE_W', 'HOME_W', 'HOME_H', 'DOOR_INNER', 'DOOR_YARD', 'DOOR_HOME', 'DOOR_STREET', 'MAILBOX_CELL',
  'HOME', 'CTX_OPTS', 'SEASON_FALLBACK', 'FOOD_VERB', 'LEDGER_CATS', 'LEDGER_XFER', 'SPEED_LABEL',
  'SKIN_TONES', 'HAIR_COLORS', 'TOP_COLORS', 'BOTTOM_COLORS', 'SHOE_COLORS', 'HAIR_STYLES', 'FACE_STYLES',
  'YARD_DECOR', 'ACC_PAL', 'PET_DEF_BY_ID', 'FURN_BY_ID', 'FURN_SVG', 'BUILDING_SVG',
  'TRAFFIC_PALETTE', 'TRAFFIC_TYPE_BY_ID', 'GUARANTEED_TRAFFIC', 'CLERK_ACTS', 'CLERKS',
  'WEEK_CN', 'CN_DIGIT', 'HINT_BUCKETS', 'AGE_STAGES', 'AGE_STAGE_NAME', 'AGE_STAGE_LEGACY',
  'TALK_DEFAULT', 'VERB_HOOKS', 'DEFAULT_NPC_ACTS', 'CLOUD_TEXT', 'CAR_MODEL_BY_ID',
  'JOB_BY_ID', 'JOB_BY_ZONE', 'ACH_BY_ID', 'KEY_DIRS', 'SEX_ID', 'VISIT_LINES',
  'HUD_STAT_IDS', 'statsEl', 'pStats'
]);

/* 玩法状态但不入档：每一条都要写清为什么，否则就是"忘了存" */
const DOMAIN_UNSAVED = {
  MED_LAST_MINUTE: '诊所买药冷却（游戏分钟）。不入档 → 刷新页面可以重算冷却，已知漏洞，先记着',
  SHIFT: '进行中的那一班。不入档 → 刷新即作废，代价是不拿钱也不扣体力，可接受',
  petUidSeq: '宠物自增号。读档时按已有宠物最大号 +1 恢复，不必单独存',
  cozyTierSeen: '上次看到的装修度星级，只用于"升星了"提示一次；刷新重提示一次，不影响玩法',
  BIZ_LAST_INCOME: '昨天承包结算的金额，面板展示用，能重算'
};

const OWNER = {
  MONEY: 'economy', STATS: 'survival', MINUTE: 'clock', DAY: 'clock', WORLD: 'clock',
  placed: 'house', inventory: 'house', houseLevel: 'house', floorStyle: 'house', wallStyle: 'house',
  ownedFloors: 'house', ownedWalls: 'house', RESIDENCE: 'house', ADDRESS: 'house', ESTATES: 'house',
  CAREER: 'career', LAST_SHIFT_DAY: 'career', LAST_SHIFT_JOB: 'career',
  ACH: 'achievement', PERSON: 'person', APPEARANCE: 'person',
  BANK: 'bank', STOCK_HOLD: 'stock', STOCK_ORDERS: 'stock', LOTTERY_STATS: 'lottery',
  BILLS: 'bills', BILL_CURSOR: 'bills', BILL_LATE_DAY: 'bills', BILL_LATE_TOTAL: 'bills',
  BIZ_LIST: 'business', BIZ_LAST_DAY: 'business', PARCELS: 'shop', FAVOR: 'favor',
  MY_CAR: 'vehicle', RENT_LAST_DAY: 'rent', PANTRY: 'food', BAG: 'food',
  MY_PETS: 'pets', PETFOOD: 'pets', LEDGER: 'ledger', TALK_DEFAULT: 'talk'
};

let spec = {};
if (fs.existsSync(SPEC)) {
  if (!process.argv.includes('--enrich')) {
    console.error('state-spec.json 已存在。要补新状态请用 --enrich；要重建先手动删掉它。');
    process.exit(1);
  }
  spec = JSON.parse(fs.readFileSync(SPEC, 'utf8')).states || {};
}

let added = 0;
for (const n of all) {
  if (spec[n]) continue;
  let entry;
  if (isSaved(n)) entry = { kind: 'domain', saved: true };
  else if (n.startsWith('_')) entry = { kind: 'cache' };
  else if (DERIVED.has(n)) entry = { kind: 'derived' };
  else if (DOMAIN_UNSAVED[n]) entry = { kind: 'domain', saved: false, note: DOMAIN_UNSAVED[n] };
  else entry = { kind: 'session' };
  if (OWNER[n]) entry.owner = OWNER[n];
  spec[n] = entry;
  added++;
}

const out = {
  note: '顶层可变状态登记表。domain = 玩法状态（saved 必须明确）；derived = 从内容/常量推导；' +
        'session = 会话内瞬态（刷新即丢）；cache = 可重建缓存（约定 _ 开头）。' +
        '新增顶层状态后跑 node tools/genstatespec.mjs --enrich 登记，再跑 node tools/statemap.mjs --check 验证。',
  counts: {},
  states: Object.fromEntries(Object.entries(spec).sort(([a], [b]) => a.localeCompare(b)))
};
for (const e of Object.values(spec)) out.counts[e.kind] = (out.counts[e.kind] || 0) + 1;

fs.writeFileSync(SPEC, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`已登记 ${Object.keys(spec).length} 个状态（本次新增 ${added}）：` +
  Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(' / '));
