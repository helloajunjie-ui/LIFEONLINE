#!/usr/bin/env node
/**
 * 状态地图：把主程序里的顶层可变状态列成表——谁、有没有入档、被写了几次。
 *
 *   node tools/statemap.mjs            # 全量表格
 *   node tools/statemap.mjs --top 15   # 只看写入最多的 15 个（"上帝状态"候选）
 *   node tools/statemap.mjs --check    # 对照 tools/state-spec.json 校验登记是否完整、口径是否自洽
 *
 * 为什么先量再改：这个文件有 147 个顶层 let，直接谈"改成单一 store"是空话。
 * 先看清哪些是领域状态（进存档、影响玩法）、哪些是缓存（_ 开头、可随时重建），
 * 再决定迁移顺序——否则重构会变成"把 147 个变量换个地方放"。
 *
 * 输出的是测量结果，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const src = fs.readFileSync(path.join(ROOT, '2.5D小屋.html'), 'utf8');

if (process.argv.includes('--check')) {
  const specPath = path.join(ROOT, 'tools/state-spec.json');
  if (!fs.existsSync(specPath)){
    console.error('✗ 缺少 tools/state-spec.json：先跑 node tools/genstatespec.mjs --init');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')).states || {};
  const saveBodyChk = (src.match(/function collectSave\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
  const savedIn = (n) => new RegExp(`\\b${n}\\b`).test(saveBodyChk);

  const NOT2 = new Set(['ctx', 'lCtx', 'aCtx', 'canvas', 'SND', 'SAVE', 'HomeCore', 'css', 'body']);
  const dom2 = new Set();
  for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*document\./gm)) dom2.add(m[1]);
  const declared = new Set();
  for (const m of src.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
  for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[|\{)/gm)) declared.add(m[1]);
  for (const n of [...declared]) if (NOT2.has(n) || dom2.has(n)) declared.delete(n);

  const errs = [];
  for (const n of declared) if (!spec[n]) errs.push(`未登记：${n}（新增状态要跑 genstatespec --enrich）`);
  for (const n of Object.keys(spec)) if (!declared.has(n)) errs.push(`登记了但代码里没有：${n}（删掉或改名同步）`);

  for (const [n, e] of Object.entries(spec)){
    if (!e || !e.kind) { errs.push(`${n}：缺少 kind`); continue; }
    if (e.kind === 'cache' && !n.startsWith('_')) errs.push(`${n} 标了 cache，但名字不是 _ 开头（缓存要一眼可辨）`);
    if (e.kind !== 'cache' && n.startsWith('_')) errs.push(`${n} 名字是 _ 开头，却标成了 ${e.kind}`);
    if (e.kind === 'domain'){
      if (typeof e.saved !== 'boolean') errs.push(`${n} 是玩法状态，必须明确 saved（true / false）`);
      else if (e.saved && !savedIn(n)) errs.push(`${n} 标了入档，但 collectSave 里没有它`);
      else if (!e.saved && !e.note) errs.push(`${n} 是玩法状态却不入档，必须写 note 说明为什么`);
    }
    if (e.kind === 'derived' && savedIn(n)) errs.push(`${n} 是从内容推导的，不该进存档（collectSave 里有它）`);
    if (e.kind === 'session' && e.saved) errs.push(`${n} 是瞬态状态，不能标入档`);
  }

  const c = {};
  for (const e of Object.values(spec)) c[e.kind] = (c[e.kind] || 0) + 1;
  const summary = Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' / ');
  if (errs.length){
    console.error(`✗ 状态登记表有 ${errs.length} 处问题（共 ${Object.keys(spec).length} 条：${summary}）：`);
    for (const e of errs.slice(0, 20)) console.error('  ' + e);
    if (errs.length > 20) console.error(`  …还有 ${errs.length - 20} 条`);
    process.exit(1);
  }
  console.log(`✓ 状态登记表一致（${Object.keys(spec).length} 条：${summary}）`);
  process.exit(0);
}

const topArg = process.argv.indexOf('--top');
const onlyTop = topArg > 0 ? Number(process.argv[topArg + 1]) || 15 : 0;

/* 存档段：只看 collectSave 的函数体，避免把别的对象键当成"已入档" */
const saveBody = (src.match(/function collectSave\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';

/* 顶层 let / 常量数组（const X = [...] 也会被就地修改，同样算可变状态） */
const decls = [];
for (const m of src.matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)) decls.push({ name: m[1], kind: 'let' });
/* const 也可以是可变状态：`const STATS = {}` / `const APPEARANCE = {...}` 就属于这类，
 * 只是绑定不可重赋值。只扫 `= [` 会漏掉最核心的那几个（STATS、APPEARANCE）。 */
for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[|\{)/gm)) decls.push({ name: m[1], kind: 'const' });

/* 不是"状态"的东西：DOM 句柄、画布上下文、单例服务。
 * 它们的 .foo = 是调用外部对象，不参与状态迁移，混进来会把排名全冲乱（ctx 一次就 383 处）。 */
const NOT_STATE = new Set(['ctx', 'lCtx', 'aCtx', 'canvas', 'SND', 'SAVE', 'HomeCore', 'css', 'body']);
const domBound = new Set();
for (const m of src.matchAll(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*document\./gm)) domBound.add(m[1]);

const rows = [];
for (const { name, kind } of decls){
  if (name.length < 2) continue;
  if (NOT_STATE.has(name) || domBound.has(name)) continue;
  /* 写入点：name = / += / -= / ++ / push / splice ……（排除 == ===） */
  const esc = name.replace(/\$/g, '\\$');
  /* 写入点：name = / name[k] = / name.prop = / += / ++ / push / splice / length= */
  const writeRe = new RegExp(
    `\\b${esc}\\s*(?:\\[[^\\]]{0,24}\\]|\\.[A-Za-z_$][\\w$]*)?\\s*` +
    `(?:[-+*/%]?=(?!=)|\\+\\+|--|\\.push\\(|\\.splice\\(|\\.length\\s*=)`, 'g');
  const writes = (src.match(writeRe) || []).length;
  const reads = (src.match(new RegExp(`\\b${esc}\\b`, 'g')) || []).length;
  const saved = new RegExp(`\\b${esc}\\b`).test(saveBody);
  rows.push({
    name, kind, writes, reads, saved: kind === 'let' ? saved : saved,
    cache: name.startsWith('_'),
    /* 领域状态：会入档、或名字不像缓存、且被多处写 */
    domain: !name.startsWith('_') && writes >= 3
  });
}

rows.sort((a, b) => b.writes - a.writes);

const domain = rows.filter(r => r.domain && !r.cache);
const cached = rows.filter(r => r.cache);
const savedCount = rows.filter(r => r.saved).length;
const unsavedDomain = domain.filter(r => !r.saved);

console.log(`顶层可变状态 ${rows.length} 个：领域 ${domain.length} / 缓存 ${cached.length} / 其它 ${rows.length - domain.length - cached.length}`);
console.log(`已入档 ${savedCount} 个；领域状态里没入档的 ${unsavedDomain.length} 个\n`);

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const show = onlyTop ? rows.slice(0, onlyTop) : rows;
console.log(pad('状态', 26) + pad('类型', 10) + pad('写', 6) + pad('读', 7) + '入档');
console.log('-'.repeat(58));
for (const r of show){
  console.log(pad(r.name, 26) + pad(r.kind, 10) + pad(r.writes, 6) + pad(r.reads, 7) + (r.saved ? '是' : '—'));
}

if (unsavedDomain.length && !onlyTop){
  console.log('\n未入档但会被多处写的领域状态（存档可能漏字段）：');
  for (const r of unsavedDomain) console.log(`  ${r.name}（写 ${r.writes} 次）`);
}

const heavy = domain.filter(r => r.writes >= 20);
if (heavy.length){
  console.log('\n写入 ≥20 次的"上帝状态"（重构优先级最高）：');
  for (const r of heavy) console.log(`  ${r.name}：${r.writes} 处写入`);
}
