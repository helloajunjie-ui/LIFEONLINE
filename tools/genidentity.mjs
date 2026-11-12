#!/usr/bin/env node
/**
 * 身份生成器：按规则给 NPC 随机安排「年龄阶段 / 性别 / 职业」。
 *
 *   node tools/genidentity.mjs --check          只体检，不改文件
 *   node tools/genidentity.mjs --fill           给缺字段的人补上（已有身份不动）
 *   node tools/genidentity.mjs --reroll         全部重排（会洗掉现有设定）
 *   node tools/genidentity.mjs --reroll --dry   只打印会变成什么，不写盘
 *
 * 规则来自 content/characters/npcs.neighbors.json 的 jobs[]：
 *   ages  —— 这个职业允许哪些年龄阶段（挡住"小孩跑去上班"）
 *   where —— 这个职业能在什么地点上班（挡住"护士在便利店收银"）
 * 随机是确定性的：种子由人物 id 散列而来，重跑得到同一份结果，
 * 不会因为"今天跑了一次"就把整个小区的身份洗一遍。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/QHTML';
const CH_PATH = path.join(ROOT, 'content/characters/npcs.neighbors.json');
const MAP_PATH = path.join(ROOT, 'content/maps/street.map.json');

const argv = process.argv.slice(2);
const MODE = argv.includes('--check') ? 'check'
  : argv.includes('--reroll') ? 'reroll'
  : argv.includes('--fill') ? 'fill' : 'check';
const DRY = argv.includes('--dry');

const ch = JSON.parse(fs.readFileSync(CH_PATH, 'utf8'));
const map = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
const ZONE_KIND = {};
for (const z of (map.zones || [])) ZONE_KIND[z.id] = z.kind;

const STAGES = ['child', 'youth', 'middle', 'senior'];
const JOBS = ch.jobs || [];
const JOB_BY_ID = {};
for (const j of JOBS) JOB_BY_ID[j.id] = j;
/* 场所的年龄偏好：沙地是小孩的、球场是年轻人、公园是老人 */
const PLACE_AGES = ch.placeAges || {};

/* 守店的人必须在岗（work），场地上闲着的必须不在岗（idle）。
 * 少了这条，随机就会安排"退休的人在柜台后面收银"。 */
function roleOk(job, role) {
  if (role === 'clerk') return job.kind !== 'idle';
  if (role === 'site') return job.kind === 'idle';
  return true;                       // 邻居：街上什么人都有
}

/* 户外场地：公园/球场/沙地/池塘/花园/广场。职业表里统一写 outdoor，避免每加一块草地都要改 */
const OUTDOOR = new Set(['park', 'court', 'sand', 'pond', 'garden', 'plaza']);

function whereOk(job, kind) {
  const w = Array.isArray(job.where) ? job.where : ['any'];
  if (w.includes('any')) return true;
  if (!kind) return true;                       // 邻居：住在这儿的人，职业与地点无关
  if (w.includes(kind)) return true;
  return OUTDOOR.has(kind) && w.includes('outdoor');
}
/* 门牌级：职业写了 zones 就只能在那几家（快递员只可能在快递站、警察只可能在派出所） */
function zoneOk(job, zoneId) {
  if (!zoneId || !Array.isArray(job.zones) || !job.zones.length) return true;
  return job.zones.includes(zoneId);
}

function ageOk(job, age) {
  const a = Array.isArray(job.ages) ? job.ages : STAGES;
  return a.includes(age);
}

/* ---------- 确定性随机 ---------- */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* 撞衫判定的五个维度，跟 tools/charcheck.mjs 保持一致 */
function lookKey(ap) {
  return [ap.age || 'middle', ap.sex || 'x', ap.uniform || '', ap.acc || 'none',
          String(ap.hairStyle == null ? 0 : ap.hairStyle)].join('|');
}

/* ---------- 找出身份不合理的人 ---------- */
function problemsOf(p, role) {
  const ap = p.appearance || {};
  const j = JOB_BY_ID[ap.job];
  const out = [];
  if (!j) return ['职业「' + (ap.job || '缺失') + '」不在 jobs[] 里'];
  const age = ap.age || 'middle';
  if (!STAGES.includes(age)) out.push('年龄「' + age + '」不是四阶段之一');
  else if (!ageOk(j, age)) out.push('年龄 ' + age + ' 不能当「' + j.name + '」（只收 ' + j.ages.join('/') + '）');
  if (age === 'child' && ap.job !== 'student') out.push('儿童只能当学生');
  if (role !== 'neighbor' && p.zoneId) {
    const kind = ZONE_KIND[p.zoneId];
    if (kind && !whereOk(j, kind)) out.push('「' + j.name + '」不该在 ' + p.zoneId + '（' + kind + '）上班');
    if (!zoneOk(j, p.zoneId)) out.push('「' + j.name + '」不该在 ' + p.zoneId + ' 这一家');
  }
  if (role !== 'neighbor' && j.playerOnly) out.push('「' + j.name + '」是玩家专用职业，NPC 不该是');
  if (!roleOk(j, role)) out.push(role === 'clerk'
    ? '「' + j.name + '」不是在岗职业，守店的人不能是他'
    : '守店以外的场所该是闲人，不能是「' + j.name + '」');
  const pAges = PLACE_AGES[p.zoneId];
  if (role === 'site' && Array.isArray(pAges) && !pAges.includes(ap.age || 'middle'))
    out.push(p.zoneId + ' 这种地方通常没有「' + (ap.age || 'middle') + '」');
  return out;
}

/* ---------- 给一个人挑身份 ---------- */
function pickIdentity(p, role, taken, salt) {
  const ap = p.appearance || {};
  const zoneId = p.zoneId || '';
  const kind = role === 'neighbor' ? '' : (ZONE_KIND[zoneId] || '');
  const rnd = mulberry32(hashStr(String(p.id || p.name) + '#' + salt));

  /* 候选 = 所有"年龄符合职业、地点符合职业"的组合。
   * 先按职业洗牌，再在每个职业里洗年龄，这样同一个人重跑结果稳定。 */
  const combos = [];
  for (const j of JOBS) {
    if (role !== 'neighbor' && kind && !whereOk(j, kind)) continue;
    if (role !== 'neighbor' && !zoneOk(j, zoneId)) continue;
    if (role !== 'neighbor' && j.playerOnly) continue;
    if (!roleOk(j, role)) continue;
    const pAges = role === 'site' ? PLACE_AGES[zoneId] : null;
    for (const age of STAGES) {
      if (!ageOk(j, age)) continue;
      if (Array.isArray(pAges) && pAges.length && !pAges.includes(age)) continue;
      if (age === 'child' && j.id !== 'student') continue;
      /* NPC 一律有明确性别：x（保密）只有玩家可选，给 NPC 随机 x 会让他看起来不像人 */
      for (const sex of ['f', 'm']) combos.push({ job: j.id, age, sex });
    }
  }
  if (!combos.length) return null;

  const tries = shuffled(combos, rnd);
  for (const c of tries) {
    const job = JOB_BY_ID[c.job];
    const next = Object.assign({}, ap, {
      age: c.age, sex: c.sex, job: c.job,
      /* 制服跟着职业走：学生/退休没有制服，其它职业穿上它该穿的那身 */
      uniform: job.uniform || undefined
    });
    if (!next.uniform) delete next.uniform;
    if (!taken.has(lookKey(next))) return next;
  }
  return null;
}

/* ---------- 主流程 ---------- */
const groups = [['npcs', 'neighbor'], ['clerks', 'clerk'], ['sites', 'site']];
const people = [];
for (const [key, role] of groups) for (const p of (ch[key] || [])) people.push({ p, role });

let bad = 0;
for (const { p, role } of people) {
  const issues = problemsOf(p, role);
  if (issues.length) {
    bad++;
    console.log(`✗ ${p.name}（${p.id}）：${issues.join('；')}`);
  }
}
console.log(`\n体检：${people.length} 人，${bad} 人不合理`);

if (MODE === 'check') {
  process.exit(bad ? 1 : 0);
}

const taken = new Set();
const changes = [];
for (const { p, role } of people) {
  const ap = p.appearance || (p.appearance = {});
  const missing = MODE === 'fill' && ap.age && ap.sex && ap.job;
  if (missing) { taken.add(lookKey(ap)); continue; }          // fill 模式：已有身份不动
  let next = null;
  for (let salt = 0; salt < 40 && !next; salt++) next = pickIdentity(p, role, taken, salt);
  if (!next) {
    console.log(`! ${p.name} 找不到既合理又不撞衫的组合，保持原样`);
    taken.add(lookKey(ap));
    continue;
  }
  const before = [ap.age, ap.sex, ap.job].join('/');
  /* 只写身份三件套，颜色/发型/配饰一概不碰 */
  ap.age = next.age; ap.sex = next.sex; ap.job = next.job;
  if (MODE === 'reroll') {
    if (next.uniform) ap.uniform = next.uniform; else delete ap.uniform;
  }
  const after = [ap.age, ap.sex, ap.job].join('/');
  if (before !== after) changes.push(`${p.name}：${before} → ${after}`);
  taken.add(lookKey(ap));
}

if (changes.length) {
  console.log(`\n${DRY ? '将' : '已'}改动 ${changes.length} 人：`);
  for (const c of changes) console.log('  ' + c);
} else {
  console.log('\n身份没有变化');
}

if (!DRY) {
  fs.writeFileSync(CH_PATH, JSON.stringify(ch, null, 2) + '\n', 'utf8');
  console.log('\n已写回 ' + path.relative(ROOT, CH_PATH));
}
