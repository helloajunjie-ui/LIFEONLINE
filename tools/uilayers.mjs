/* 分层体检：哪些函数「既改玩法状态、又写 DOM」
 *
 * 目标架构是「UI 为主、逻辑置后」：
 *   状态（domain） ← 只有动作函数写
 *   视图（view）   ← 只读状态，写 DOM / canvas
 *   一个函数同时做两件事，就是层次被打穿了——它既是 UI 又是玩法，
 *   测试要么没法测（要开浏览器），要么测了也是假的。
 *
 * 用法：
 *   node tools/uilayers.mjs            # 列出全部混合函数
 *   node tools/uilayers.mjs --check    # 有新增的混合函数就失败（对照 tools/ui-allow.json）
 *   node tools/uilayers.mjs --top 20   # 只看 DOM 写最多的
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, '2.5D小屋.html'), 'utf8');
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/state-spec.json'), 'utf8')).states;

/* 玩法状态：kind === 'domain'。它们代表"玩家的世界"，只该由动作函数改。 */
const DOMAIN = new Set(Object.entries(spec).filter(([, v]) => v.kind === 'domain').map(([k]) => k));
/* 另外几个虽登记成 derived/session，但语义上是玩法数据（撤销主控权在动作层） */
for (const extra of ['SHIFT', 'CHATTER', 'bizState']) DOMAIN.add(extra);

/* 只认"真的写"：赋值、复合赋值、自增、push/splice。`===` 和 == 不算。 */
function domainWrites(body) {
  const hits = [];
  for (const name of DOMAIN) {
    const re = new RegExp(`\\b${name}\\b\\s*(?:\\[[^\\]]{0,24}\\]|\\.[A-Za-z_$][\\w$]*)?\\s*(?:[-+*/%]?=(?!=)|\\+\\+|--)`, 'g');
    const m = body.match(re);
    if (m) hits.push(name);
  }
  return hits;
}
/* DOM 写：textContent / innerHTML / classList / style / 属性 / appendChild */
const DOM_WRITE = /\.(?:textContent|innerHTML|className|value|disabled|checked)\s*=[^=]|\.classList\.(?:add|remove|toggle|replace)\(|\.style\.[A-Za-z]+\s*=[^=]|\.(?:appendChild|removeChild|insertAdjacentHTML|setAttribute)\(|document\.getElementById\('[^']+'\)\.(?:textContent|value)/g;

/* 提取顶层函数（含相互嵌套的块）。用花括号配平，够用：这个文件没有正则字面量里带裸花括号的写法。 */
function topFunctions(text) {
  const out = [];
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out.push({ name: m[1], start: m.index, body: text.slice(start, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

const fns = topFunctions(src);
const rows = [];
for (const f of fns) {
  const dom = (f.body.match(DOM_WRITE) || []).length;
  const dom2 = domainWrites(f.body);
  if (!dom && !dom2.length) continue;
  rows.push({ name: f.name, dom, domain: dom2, line: src.slice(0, f.start).split('\n').length });
}
const mixed = rows.filter(r => r.dom > 0 && r.domain.length > 0).sort((a, b) => b.dom - a.dom);
const viewOnly = rows.filter(r => r.dom > 0 && !r.domain.length);
const logicOnly = rows.filter(r => !r.dom && r.domain.length);

const allowPath = path.join(ROOT, 'tools/ui-allow.json');
const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, 'utf8')) : { allow: {} };
const allowed = allow.allow || {};

if (process.argv.includes('--check')) {
  const fresh = mixed.filter(r => !allowed[r.name]);
  const stale = Object.keys(allowed).filter(n => !mixed.some(r => r.name === n));
  const errs = [];
  for (const r of fresh) {
    errs.push(`${r.name}（第 ${r.line} 行）：写 DOM ${r.dom} 处，同时改 ${r.domain.join('/')}`);
  }
  if (errs.length) {
    console.error(`✗ 有 ${errs.length} 个函数同时改状态和写 DOM（视图与玩法没分开）：`);
    for (const e of errs.slice(0, 15)) console.error('  ' + e);
    if (errs.length > 15) console.error(`  …还有 ${errs.length - 15} 个`);
    console.error('  拆法：状态改动放进动作函数（如 bumpStat / credit / setScene），视图只读不写。');
    console.error('  确实要混的（正处过渡期）在 tools/ui-allow.json 里登记并注明原因。');
    process.exit(1);
  }
  if (stale.length) console.error(`! 白名单里有 ${stale.length} 条已经不再混合，可以删：${stale.join(', ')}`);
  console.log(`✓ 分层体检通过：${mixed.length} 个混合函数全在白名单（视图 ${viewOnly.length} / 纯逻辑 ${logicOnly.length}）`);
  process.exit(0);
}

const topN = (() => {
  const i = process.argv.indexOf('--top');
  return i > 0 ? Number(process.argv[i + 1]) || 20 : 0;
})();

console.log(`函数总数 ${fns.length} · 视图 ${viewOnly.length} · 纯逻辑 ${logicOnly.length} · 混合 ${mixed.length}`);
console.log('');
console.log('混合函数（写 DOM 又改状态），按 DOM 写次数排：');
for (const r of (topN ? mixed.slice(0, topN) : mixed)) {
  const tag = allowed[r.name] ? '（已登记）' : '';
  console.log(`  ${String(r.dom).padStart(4)} 行 ${String(r.line).padStart(6)}  ${r.name}${tag}  ← ${r.domain.join(', ')}`);
}
