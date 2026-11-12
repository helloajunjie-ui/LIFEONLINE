#!/usr/bin/env node
/* 角色辨识度体检
 *
 * 依据（game-art-prompt-pack 硬规则 4）：
 *   「每个主体给唯一的识别线索：一条颜色线索 + 一条剪影线索，互不重复。」
 * 以及「同色系主体同框是最大隐患」。
 *
 * 判定用规则，不用加权分。加权分的问题是"男和女"到底值多少分全靠拍脑袋；
 * 而"这五个维度全同、只有衣服颜色不同"是客观的：
 *
 *   硬冲突（撞衫）：年龄 / 性别 / 制服 / 配饰 / 发型 五项全同
 *     → 这两个人在同一屏基本分不出来，只有衣服颜色不一样，必须改
 *   接近（看着眼熟）：五项里同四项，且衣服颜色也很接近（Δ<0.22）
 *     → 不一定要改，但站在一起会让人愣一下
 *
 * 用法：node tools/charcheck.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(fs.readFileSync(path.join(root, 'content/characters/npcs.neighbors.json'), 'utf8'));

const people = [];
for (const n of (doc.npcs || [])) people.push({ id: n.id, name: n.name, kind: '邻居', ap: n.appearance || {} });
for (const c of (doc.clerks || [])) people.push({ id: c.id, name: c.name, kind: '店员', ap: c.appearance || {} });
for (const s of (doc.sites || [])) people.push({ id: s.id, name: s.name, kind: '街坊', ap: s.appearance || {} });

function hexToHsl(hex) {
  const h = String(hex || '#888888').replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16) / 255, g = parseInt(n.slice(2, 4), 16) / 255, b = parseInt(n.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2, d = max - min;
  let hh = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
  }
  return [hh, s, l];
}
function colorDist(a, b) {
  const [h1, s1, l1] = hexToHsl(a), [h2, s2, l2] = hexToHsl(b);
  let dh = Math.abs(h1 - h2); if (dh > 180) dh = 360 - dh;
  return Math.min(1, (dh / 180) * 0.6 + Math.abs(s1 - s2) * 0.2 + Math.abs(l1 - l2) * 0.6);
}

/* 五个剪影/身份维度：数组里放"实际影响渲染的取值" */
function dims(p) {
  const a = p.ap;
  return {
    age: a.age || 'adult',
    sex: a.sex || 'x',
    uniform: a.uniform || '',
    acc: a.acc || 'none',
    hair: String(a.hairStyle == null ? 0 : a.hairStyle)
  };
}
const DIM_LABEL = { age: '年龄', sex: '性别', uniform: '制服', acc: '配饰', hair: '发型' };

const hard = [], soft = [];
for (let i = 0; i < people.length; i++) {
  for (let j = i + 1; j < people.length; j++) {
    const A = dims(people[i]), B = dims(people[j]);
    const same = Object.keys(A).filter(k => A[k] === B[k]);
    const diff = Object.keys(A).filter(k => A[k] !== B[k]);
    const cdist = colorDist(people[i].ap.top, people[j].ap.top);
    if (same.length === 5) hard.push({ a: people[i], b: people[j], same, cdist });
    else if (same.length === 4 && cdist < 0.22) soft.push({ a: people[i], b: people[j], same, diff, cdist });
  }
}

const show = (p) => `  ${p.a.name}（${p.a.kind}）× ${p.b.name}（${p.b.kind}）` +
  `\n      相同：${p.same.map(k => DIM_LABEL[k]).join('/') || '无'}` +
  (p.diff ? `  不同：${p.diff.map(k => DIM_LABEL[k]).join('/')}` : '') +
  `  衣服色差 ${p.cdist.toFixed(2)}` +
  `\n      A ${JSON.stringify(dims(p.a))}\n      B ${JSON.stringify(dims(p.b))}`;

console.log(`人物 ${people.length} 人 · 两两比较 ${people.length * (people.length - 1) / 2} 对`);
if (hard.length) {
  console.log(`\n✗ 撞衫 ${hard.length} 对（五项全同，只有衣服颜色不同）：`);
  for (const p of hard) console.log(show(p));
} else {
  console.log('\n✓ 没有撞衫（不存在"五项全同"的两个人）');
}
if (soft.length) {
  console.log(`\n⚠ 眼熟 ${soft.length} 对（同四项 + 衣服颜色接近，不一定要改）：`);
  for (const p of soft) console.log(show(p));
}
process.exit(hard.length ? 1 : 0);
