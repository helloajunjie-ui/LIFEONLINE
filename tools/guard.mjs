#!/usr/bin/env node
/**
 * 提交前体检：专抓"看起来没事、其实已经坏掉"的改动。
 *
 *   node tools/guard.mjs          # 工作区 vs HEAD
 *   node tools/guard.mjs --staged # 只看暂存区
 *
 * 为什么需要它（每一条都是真踩过的）：
 *   ① 行尾被翻转：工作区与 HEAD 只差 \r，提交上去整文件重写（这次全仓归一之前，
 *      README 一次被翻成 CRLF，100 行的改动变成 30000 行 diff）
 *   ② 行数暴涨：补丁脚本被沙箱跑两遍，同一段被插两次（测试块、updateDrips 都中过）
 *   ③ 同一行重复多次：README 的表格行被插了 256 遍，文件 271KB，肉眼根本看不出来
 *   ④ 未跟踪的大文件：截图/临时产物混进提交
 *
 * 退出码 1 表示有问题。这个脚本不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argStaged = process.argv.includes('--staged');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.html', '.md', '.css', '.txt', '.go', '.sql', '.svg', '.gitattributes', '']);
const problems = [];
const src800 = fs.readFileSync(path.join(ROOT, '2.5D小屋.html'), 'utf8');

/* ---------- 变更清单 ---------- */
let entries = [];
try {
  const out = git(argStaged ? ['diff', '--numstat', '--cached'] : ['diff', '--numstat', 'HEAD']);
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    entries.push({ add: Number(add), del: Number(del), file: rest.join('\t') });
  }
} catch (e) {
  console.error('拿不到 git diff：' + e.message);
  process.exit(2);
}

/* ---------- ① 工作区里混进了 CRLF ----------
 * `.gitattributes` 已经声明 `* text=auto eol=lf`，所以 CRLF 不会再造成大 diff；
 * 但工作区出现 CRLF 说明"有工具按 Windows 文本模式写过这个文件"，
 * 下一步很可能就是行尾混乱（本地比对、grep -c 计数都会跟着漂）。这里直接点出来。 */
{
  const files = git(['ls-files']).split('\n').filter(Boolean);
  for (const file of files) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    const buf = fs.readFileSync(full);
    const crlf = buf.toString('latin1').split('\r\n').length - 1;
    if (crlf > 0) {
      problems.push(`[行尾] ${file} 工作区是 CRLF（${crlf} 处）：有工具用文本模式写过它。` +
        `提交虽会被归一，但本地比对会漂，建议二进制写成 LF`);
    }
  }
}

/* ---------- ② 行数暴涨 ---------- */
for (const e of entries) {
  if (!Number.isFinite(e.add) || !Number.isFinite(e.del)) continue;
  const file = e.file;
  if (!fs.existsSync(path.join(ROOT, file))) continue;
  let headLines = 0;
  try { headLines = git(['show', 'HEAD:' + file]).split('\n').length; } catch { continue; }
  const nowLines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
  if (headLines > 20 && nowLines > 400 && nowLines > headLines * 1.6) {
    problems.push(`[暴涨] ${file}：${headLines} → ${nowLines} 行（+${Math.round((nowLines / headLines - 1) * 100)}%）。` +
      `补丁跑两遍？先看有没有重复块`);
  }
}

/* ---------- ③ 同一行重复过多（文档最容易被补丁插成复读机） ---------- */
for (const e of entries) {
  const file = e.file;
  if (!/\.md$/i.test(file)) continue;
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  const count = new Map();
  for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length < 40) continue;                       // 短行天然会重复
    if (/^[|\-: ]+$/.test(t)) continue;                // 表格分隔线
    count.set(t, (count.get(t) || 0) + 1);
  }
  for (const [line, n] of count) {
    if (n >= 8) {
      problems.push(`[重复] ${file}：同一行出现 ${n} 次 —— ${line.slice(0, 48)}…`);
    }
  }
}

/* ---------- ⑤ 服务端 bundle 与内容包是否同步 ----------
 * server/content/content.json 是构建产物。改了 content/ 却忘了跑 `content.mjs all`，
 * 服务端（排行榜、cozy 重算、热更新下发）就会拿旧数据，而客户端一切正常——
 * 这种"只有别人看到错"的问题最难查。 */
{
  try {
    const versions = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/versions.json'), 'utf8'));
    const bundlePath = path.join(ROOT, 'server/content/content.json');
    if (fs.existsSync(bundlePath)) {
      const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      const mods = bundle.modules || {};
      const stale = [];
      for (const [pack, info] of Object.entries(versions)) {
        const b = mods[pack];
        if (!b || b.hash !== info.hash) stale.push(pack);
      }
      for (const pack of Object.keys(mods)) if (!(pack in versions)) stale.push(pack + '（bundle 里多出来的）');
      if (stale.length) {
        problems.push(`[不同步] server/content/content.json 落后于 content/：${stale.slice(0, 5).join(', ')}` +
          `${stale.length > 5 ? ' …' : ''} —— 跑 node tools/content.mjs all`);
      }
    }
  } catch (e) { /* 缺文件就不管，构建会自己生成 */ }
}

/* ---------- ⑥ 客户端内联包是否跟上 content/ ----------
 * 改了 content 却没跑 build，dist 与 src/content/generated.js 里的还是旧内容：
 * 客户端能跑、测试也可能过（两套都用旧数据），但玩家看到的是上一版。
 * build 已把 generated.js 的 sha256 前 12 位写进 version.generated.js，这里对一下即可。 */
{
  try {
    const gen = fs.readFileSync(path.join(ROOT, 'src/content/generated.js'));
    const want = crypto.createHash('sha256').update(gen).digest('hex').slice(0, 12);
    const verSrc = fs.readFileSync(path.join(ROOT, 'src/version.generated.js'), 'utf8');
    const m = verSrc.match(/"contentHash":\s*"([0-9a-f]+)"/);
    if (m && m[1] !== want) {
      problems.push(`[不同步] src/content/generated.js 变了但没重建（版本里记的是 ${m[1]}，实际 ${want}）—— 跑 node tools/build.mjs`);
    }
  } catch (e) { /* 首次构建前没有生成物，跳过 */ }
}

/* ---------- ⑦ 资源必须走唯一入口 ----------
 * 玩法状态里最容易被绕过的两个：现金与三条生存数值。
 * 绕过去的那一笔在账本里就是"隐形收支"，玩家对不上账；或者用错 clamp 口径，
 * 上限 120 的资源被按 100 截断。这条规则以前靠人记，现在靠扫。 */
{
  const lines = src800.split('\n');
  let fn = '';
  const bad = [];
  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    const fm = line.match(/^function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (fm) fn = fm[1];
    if (/^\s*(?:if\s*\([^)]*\)\s*)?STATS\.\w+\s*=[^=]/.test(line) &&
        fn !== 'bumpStat' && fn !== 'applyFx'){
      bad.push(`第 ${i + 1} 行（${fn || '顶层'}）：${line.trim().slice(0, 60)}`);
    }
    if (/^\s*MONEY\s*(?:[-+*/]?=[^=]|\+\+|--)/.test(line) &&
        !['credit', 'debit', 'applySave', ''].includes(fn)){
      bad.push(`第 ${i + 1} 行（${fn}）：现金绕过 credit/debit —— ${line.trim().slice(0, 60)}`);
    }
  }
  if (bad.length){
    problems.push(`[入口] 有 ${bad.length} 处绕过唯一入口：\n      ` + bad.slice(0, 6).join('\n      ') +
      (bad.length > 6 ? `\n      …还有 ${bad.length - 6} 处` : ''));
  }
}

/* ---------- ④ 未跟踪的大文件 ---------- */
try {
  const out = git(['ls-files', '--others', '--exclude-standard']);
  for (const f of out.split('\n')) {
    if (!f) continue;
    const st = fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false });
    if (st && st.size > 1024 * 1024 * 2) {
      problems.push(`[大文件] 未跟踪但超过 2MB：${f}（${(st.size / 1048576).toFixed(1)}MB）——确认要提交吗`);
    }
  }
} catch { /* 无 git 信息就跳过 */ }

if (problems.length) {
  console.error(`✗ 体检发现 ${problems.length} 处要注意：`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`✓ 体检通过（${entries.length} 个改动文件：无行尾翻转 / 无暴涨 / 无重复行 / 无大文件）`);
