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
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const argStaged = process.argv.includes('--staged');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.html', '.md', '.css', '.txt', '.go', '.sql', '.svg', '.gitattributes', '']);
const problems = [];

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
