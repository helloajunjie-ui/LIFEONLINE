#!/usr/bin/env node
/**
 * 无依赖前端构建（npm 不可用时的替代方案）
 *
 *   node tools/build.mjs
 *
 * 做三件事：
 *   1. content/*.json  →  src/content/generated.js （把内容层内联成模块，避免运行时 fetch）
 *   2. src/core/*.js   →  dist/core.bundle.js     （迷你打包：受限 ESM → 单个经典脚本）
 *   3. 2.5D小屋.html   →  dist/2.5D小屋.html       （把 bundle 内联，保持"双击即玩"）
 *
 * 迷你打包器的语法约束（够用且不引入依赖）：
 *   - import 只支持具名导入：import { a, b } from './x.js';
 *   - export 只支持：export function f / export const c / export { a, b };
 *   - 不支持 default、re-export、动态 import、循环引用（循环会在运行时暴露为 undefined）
 * 违反约束时构建会直接报错，而不是产出坏包。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = 'E:/QHTML';
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const CONTENT = path.join(ROOT, 'content');
const HTML_IN = path.join(ROOT, '2.5D小屋.html');
const HTML_OUT = path.join(DIST, '2.5D小屋.html');
const GENERATED = path.join(SRC, 'content', 'generated.js');
const BUNDLE = path.join(DIST, 'core.bundle.js');

const ENTRY_MODULES = [
  'src/core/content.js',
  'src/core/pathfind.js',
  'src/core/rules.js',
  'src/net/save-provider.js',
  'src/net/social.js',
  'src/core/version.js',
  'src/core/environment.js',
  'src/core/clock.js'
];

/* ------------------------------ 1. 内容内联 ------------------------------ */

function generateContentModule(){
  const manifest = JSON.parse(fs.readFileSync(path.join(CONTENT, 'manifest.json'), 'utf8'));
  const packs = {};
  for (const rel of manifest.packs){
    packs[rel] = JSON.parse(fs.readFileSync(path.join(CONTENT, rel), 'utf8'));
  }
  const pick = (prefix) => Object.entries(packs)
    .filter(([rel]) => rel.startsWith(prefix))
    .map(([, v]) => v);

  const catalog = pick('catalog/').flatMap(p => p.items || []);
  const house = pick('house/').find(p => p.schema === 'house/1') || { levels: [] };
  const styles = pick('house/').find(p => p.schema === 'styles/1') || { floors: [], walls: [] };
  const rules = {};
  for (const p of pick('rules/')){
    if (p.id === 'rules.survival.default') rules.survival = p;
    if (p.id === 'rules.economy.default') rules.economy = p;
  }
  const npcs = pick('characters/').flatMap(p => p.npcs || []);
  const maps = {};
  for (const p of pick('maps/')) maps[p.id.replace('map.', '')] = p;
  const ui = pick('ui/').find(p => p.strings) || { strings: {} };

  const data = {
    manifest: { contentVersion: manifest.contentVersion, generatedAt: manifest.generatedAt },
    modules: manifest.modules || {},
    // 保留原始 pack 边界：运行时可以只替换其中一块（模块级热更新）
    packs,
    catalog,
    levels: house.levels || [],
    styles: { floors: styles.floors || [], walls: styles.walls || [] },
    rules,
    npcs,
    maps,
    ui: ui.strings
  };

  const code = '// 由 tools/build.mjs 自动生成，请勿手改（源数据在 content/*.json）\n'
    + 'export const CONTENT = ' + JSON.stringify(data) + ';\n';
  fs.mkdirSync(path.dirname(GENERATED), { recursive: true });
  fs.writeFileSync(GENERATED, code, 'utf8');
  return { packs: manifest.packs.length, catalog: catalog.length, bytes: code.length };
}

/* --------------------------- 1.5 版本信息 --------------------------- */

function generateVersionModule(){
  const ver = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(CONTENT, 'manifest.json'), 'utf8'));
  const content = fs.readFileSync(GENERATED, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  const build = {
    appVersion: ver.app,
    minAppVersion: ver.minApp,
    saveSchema: ver.saveSchema,
    contentVersion: manifest.contentVersion,
    contentHash: hash,
    builtAt: new Date().toISOString()
  };
  // 内容包：直接用 content/versions.json 里的独立版本
  const modules = {};
  for (const [id, v] of Object.entries(manifest.modules || {})) {
    modules['content/' + id] = { version: v.version, hash: v.hash };
  }
  // 源码模块：只有指纹（代码没有人工版本号，指纹就是它的身份）
  const walkSrc = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'generated') walkSrc(full); continue; }
      if (!e.name.endsWith('.js') || e.name.includes('.generated.')) continue;
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 12);
      modules[rel] = { version: null, hash: h };
    }
  };
  walkSrc(SRC);
  build.modules = modules;

  /* builtAt 只用来在关于面板里显示"构建于"，但它是唯一每次都会变的字段——
   * 于是重复跑一次构建就会生成一个只含产物的空提交（补丁脚本被跑两遍时尤其明显）。
   * 这里做幂等：其余字段（含源码指纹、内容指纹、版本号）都没变时，沿用旧的 builtAt，
   * 只有内容真的变了才更新成现在的时间。 */
  const outPath = path.join(SRC, 'version.generated.js');
  let builtAt = new Date().toISOString();
  try {
    const prev = fs.readFileSync(outPath, 'utf8');
    const m = prev.match(/"builtAt":\s*"([^"]+)"/);
    if (m && m[1]){
      const prevBody = prev.replace(/"builtAt":\s*"[^"]+"/, '"builtAt": "__same__"');
      const nextBody = JSON.stringify(Object.assign({}, build, { builtAt: '__same__' }), null, 2);
      if (prevBody.includes(nextBody)) builtAt = m[1];      // 除了时间，其它完全一致
    }
  } catch (e) {}
  build.builtAt = builtAt;

  const out = '// 由 tools/build.mjs 生成，请勿手改（源：version.json + content/*.json）\n'
    + 'export const BUILD = ' + JSON.stringify(build, null, 2) + ';\n';
  fs.writeFileSync(outPath, out, 'utf8');
  return build;
}

/* ------------------------------ 2. 迷你打包 ------------------------------ */

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm;
const EXPORT_FN = /^export\s+(function|const|let)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\};?\s*$/gm;

function toModuleId(absPath){
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function resolveImport(fromId, spec){
  const fromDir = path.posix.dirname(fromId);
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  const abs = path.join(ROOT, joined);
  if (!fs.existsSync(abs)) throw new Error(`${fromId} 引用了不存在的模块: ${spec}`);
  return joined;
}

function transformModule(id){
  const abs = path.join(ROOT, id);
  let code = fs.readFileSync(abs, 'utf8');
  const deps = [];
  const exports = [];

  code = code.replace(IMPORT_RE, (_m, names, spec) => {
    const depId = resolveImport(id, spec);
    deps.push(depId);
    const list = names.split(',').map(s => s.trim()).filter(Boolean);
    for (const n of list) if (n.includes(' as ')) throw new Error(`${id}: 不支持 import as 语法`);
    return `const { ${list.join(', ')} } = __require(${JSON.stringify(depId)});`;
  });

  // 兜底：发现没被处理的 import/export 就报错（避免静默产物损坏）
  code = code.replace(EXPORT_FN, (_m, kind, name) => {
    exports.push(name);
    return `${kind} ${name}`;
  });
  code = code.replace(EXPORT_LIST, (_m, names) => {
    for (const n of names.split(',').map(s => s.trim()).filter(Boolean)) exports.push(n);
    return '';
  });

  if (/^\s*import\s/m.test(code)) throw new Error(`${id}: 存在未处理的 import（只支持具名导入）`);
  if (/^\s*export\s/m.test(code)) throw new Error(`${id}: 存在未处理的 export（只支持 function/const/let 与列表）`);

  const tail = exports.map(n => `  __exports.${n} = ${n};`).join('\n');
  return { id, deps, code: code + '\n' + tail + '\n' };
}

function bundleModules(){
  const mods = new Map();
  const queue = [...ENTRY_MODULES];
  while (queue.length){
    const id = queue.shift();
    if (mods.has(id)) continue;
    const m = transformModule(id);
    mods.set(id, m);
    for (const d of m.deps) if (!mods.has(d)) queue.push(d);
  }

  const body = [...mods.values()].map(m =>
    `__define(${JSON.stringify(m.id)}, function(__exports, __require){\n${m.code}});`
  ).join('\n\n');

  const entryExports = {
    content: "src/core/content.js",
    pathfind: "src/core/pathfind.js",
    rules: "src/core/rules.js",
    save: "src/net/save-provider.js",
    social: "src/net/social.js",
    version: "src/core/version.js",
    environment: "src/core/environment.js",
    clock: "src/core/clock.js"
  };
  const expose = Object.entries(entryExports)
    .map(([k, id]) => `  ${k}: __require(${JSON.stringify(id)})`)
    .join(',\n');

  const out = `/* 由 tools/build.mjs 生成：$(date) */
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
${body}

  window.HomeCore = {
${expose}
  };
})();
/* 用版本模块里的时间，而不是当场取：这样重复构建能产出完全一样的文件
 * （否则每次都会因为这一行产生差异，补丁跑两遍就留下一个只含产物的空提交） */
`.replace('$(date)', ver.builtAt);

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(BUNDLE, out, 'utf8');
  return { modules: mods.size, bytes: out.length };
}

/* ------------------------------ 3. HTML 构建 ------------------------------ */

function buildHtml(bundleCode){
  let html = fs.readFileSync(HTML_IN, 'utf8');

  const extTag = /<!--@CORE_BUNDLE-->\s*<script src="\.\/dist\/core\.bundle\.js"><\/script>/;
  if (!extTag.test(html)) throw new Error('2.5D小屋.html 缺少 <!--@CORE_BUNDLE--> 占位（必须紧跟 core.bundle.js 引用）');

  const inline = '<!--@CORE_BUNDLE-->\n<script>\n' + bundleCode + '\n</script>';
  html = html.replace(extTag, inline);

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(HTML_OUT, html, 'utf8');
  return { bytes: html.length };
}

/* ------------------------------ run ------------------------------ */

const gen = generateContentModule();
console.log(`内容内联: ${gen.packs} 包 / ${gen.catalog} 件家具 → src/content/generated.js (${(gen.bytes/1024).toFixed(1)} KB)`);

const ver = generateVersionModule();
console.log(`版本: app ${ver.appVersion} · 内容 ${ver.contentVersion} (${ver.contentHash}) · 存档 schema ${ver.saveSchema}`);

const b = bundleModules();
console.log(`打包模块: ${b.modules} 个 → dist/core.bundle.js (${(b.bytes/1024).toFixed(1)} KB)`);

const h = buildHtml(fs.readFileSync(BUNDLE, 'utf8'));
console.log(`构建单文件: dist/2.5D小屋.html (${(h.bytes/1024).toFixed(1)} KB)`);
