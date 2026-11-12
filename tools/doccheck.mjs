#!/usr/bin/env node
/**
 * 文档数字对账：README 里写死的统计数，跟内容包实算出来的对不上就报错。
 *
 *   node tools/doccheck.mjs
 *
 * 为什么需要它：README 上一轮同时出现 430 / 305 / 397 三个"回归项数"，
 * 而真实是 448——因为数字全靠手写。手写的东西一定会漂，唯一的解法是让它可验证。
 * 这个脚本只校验"能从内容算出来"的数：包数、家具、房型、人物、职业、话题、
 * 台词数、股票、门面、车位、车型、地图尺寸、引导步数。
 * 回归项数无法静态算出（要真跑），仍靠 `node tools/test.mjs` 的输出人工同步。
 *
 * 退出码 1 表示对不上，信息里直接给出"文档写的是多少 / 实际是多少"。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------- 实算 ---------- */
const manifest = readJSON('content/manifest.json');
const packs = (manifest.packs || []).length;

let furniture = 0;
for (const rel of manifest.packs) {
  if (!rel.startsWith('catalog/')) continue;
  const d = readJSON('content/' + rel);
  furniture += (d.items || []).length;
}

const levels = (readJSON('content/house/levels.json').levels || []).length;
const cars = (readJSON('content/vehicles/cars.json').models || []).length;
const chars = readJSON('content/characters/npcs.neighbors.json');
const people = (chars.npcs || []).length + (chars.clerks || []).length + (chars.sites || []).length;
const jobs = (chars.jobs || []).length;
const chatTopics = (readJSON('content/characters/topics.json').topics || []).length;

const amb = readJSON('content/environment/ambient.json');
const chatter = amb.chatter || {};
const pairs = (chatter.topics || []).length;
const solos = (chatter.solos || []).length;
const trafficTypes = ((amb.traffic || {}).types || []).length;
const busStops = ((readJSON('content/maps/street.map.json').busStops) || []).length;

const stock = (readJSON('content/stock/stock.json').stocks || []).length;
const shops = (readJSON('content/business/business.json').shops || []).length;
const map = readJSON('content/maps/street.map.json');

let firstSteps = 0, achievements = 0;
for (const rel of manifest.packs) {
  if (!rel.startsWith('achievements/')) continue;
  const d = readJSON('content/' + rel);
  for (const a of (d.achievements || [])) {
    achievements++;
    if ((a.group || '') === 'first') firstSteps++;
  }
}

/* ---------- 对账表 ---------- */
const CHECKS = [
  { file: 'README.md', label: '内容包数', re: /内容校验 \*\*(\d+) 包\*\*/, want: packs },
  { file: 'README.md', label: '家具件数', re: /家具目录（(\d+) 件）/, want: furniture },
  { file: 'README.md', label: '房型数量', re: /房型（(\d+) 种）/, want: levels },
  { file: 'README.md', label: '人物数量', re: /人物 \*\*(\d+) 人\*\*/, want: people },
  { file: 'README.md', label: '职业数量', re: /（(\d+) 种职业）/, want: jobs },
  { file: 'README.md', label: '地图宽', re: /街区 \*\*(\d+)×\d+\*\*/, want: map.grid.w },
  { file: 'README.md', label: '地图高', re: /街区 \*\*\d+×(\d+)\*\*/, want: map.grid.h },
  { file: 'README.md', label: '对聊组数', re: /(\d+) 组对聊 \+ \d+ 句独白/, want: pairs },
  { file: 'README.md', label: '独白句数', re: /\d+ 组对聊 \+ (\d+) 句独白/, want: solos },
  { file: 'README.md', label: '问话话题数', re: /点开任何一个人是一张\*\*问话菜单\*\*：([^。]+)/, kind: 'count-list', want: chatTopics },
  { file: 'README.md', label: '车型数', re: /街上跑 (\d+) 种车/, want: trafficTypes },
  { file: 'README.md', label: '股票数', re: /证券营业部：(\d+) 支股票/, want: stock },
  { file: 'README.md', label: '可承包门面', re: /(\d+) 个门面可按月承包/, want: shops },
  { file: 'README.md', label: '引导步数', re: /是一条 (\d+) 步顺序链/, want: firstSteps },
  { file: '内容数据架构设计.md', label: '[架构] 内容包数', re: /唯一真相（\*\*(\d+) 个包\*\*）/, want: packs },
  { file: '内容数据架构设计.md', label: '[架构] 人物数', re: /人物 (\d+) 人（(\d+) 种职业）/, want: people },
];

const problems = [];
for (const c of CHECKS) {
  let text = '';
  try { text = readText(c.file); } catch { problems.push(`[文档] 找不到 ${c.file}`); continue; }
  const m = text.match(c.re);
  if (!m) { problems.push(`[${c.file}] 找不到「${c.label}」这句话，规则可能要更新（正则 ${c.re}）`); continue; }
  let got;
  if (c.kind === 'count-list') got = m[1].split('/').filter(s => s.trim()).length;
  else got = Number(m[1] === undefined ? m[0] : m[1]);
  if (got !== c.want) {
    problems.push(`[${c.file}] ${c.label}：文档写 ${got}，实际 ${c.want}`);
  }
}

if (problems.length) {
  console.error(`✗ 文档与内容对不上，共 ${problems.length} 处：`);
  for (const p of problems) console.error('  ' + p);
  console.error('\n改文档里的数字，或者确认内容真的变了（后者顺手更新 README）。');
  process.exit(1);
}
console.log(`✓ 文档数字对账通过（${CHECKS.length} 项：包 ${packs} / 家具 ${furniture} / 房型 ${levels} / 人 ${people} / 职业 ${jobs} / 话题 ${chatTopics} / 对聊 ${pairs} / 独白 ${solos} / 车型 ${trafficTypes} / 股票 ${stock} / 门面 ${shops} / 引导 ${firstSteps} / 车站 ${busStops} / 车款 ${cars} / 成就 ${achievements}）`);
