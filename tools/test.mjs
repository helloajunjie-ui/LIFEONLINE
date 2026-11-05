#!/usr/bin/env node
/**
 * 无头回归测试：把 tests/regression.js 注入到构建产物与源码 HTML 副本，
 * 用 Edge headless 跑一遍，抓取 PASS/FAIL。
 *
 *   node tools/test.mjs                 # 跑 dist + 源码两套
 *   node tools/test.mjs dist            # 只跑构建产物
 *
 * 为什么两套都跑：源码版验证"接线是否正确"，dist 版验证"打包有没有丢东西"。
 * 注意：必须用 --user-data-dir 起独立 profile，否则 file:// 会污染真实存档。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:/QHTML';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TMP = path.join(ROOT, '.tmp');

const TARGETS = {
  dist: path.join(ROOT, 'dist', '2.5D小屋.html'),
  src: path.join(ROOT, '2.5D小屋.html')
};

const only = process.argv[2];
const tests = fs.readFileSync(path.join(ROOT, 'tests', 'regression.js'), 'utf8');

fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
for (const [name, file] of Object.entries(TARGETS)){
  if (only && only !== name) continue;
  if (!fs.existsSync(file)){ console.log(`跳过 ${name}：找不到 ${file}`); continue; }

  const html = fs.readFileSync(file, 'utf8');
  const injected = html.replace('</body>', '<scr' + 'ipt>\n' + tests + '\n</scr' + 'ipt>\n</body>');
  // 关键：注入副本必须和目标同目录，否则 index.html 里的相对路径（./dist/core.bundle.js）会失效
  const work = path.join(path.dirname(file), '.regtest.html');
  fs.writeFileSync(work, injected, 'utf8');

  const profile = path.join(TMP, `profile_${name}`);
  fs.rmSync(profile, { recursive: true, force: true });

  let dom = '';
  try {
    dom = execFileSync(EDGE, [
      '--headless', '--disable-gpu',
      '--user-data-dir=' + profile,
      '--window-size=1280,800',
      '--virtual-time-budget=6000',
      '--dump-dom',
      'file:///' + work.replace(/\\/g, '/')
    ], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e){
    // Edge 退出时的段错误是已知噪音，产物仍可能是完整的
    dom = (e.stdout || '') + '';
  }
  fs.rmSync(work, { force: true });

  // 注意用 [^\n<]：断言输出是多行的，[^<]* 会跨行把整块 pre 吞成一条
  const lines = [...dom.matchAll(/(PASS|FAIL|FATAL) \| [^\n<]*/g)].map(m => m[0])
    .filter(l => !l.includes('e && e.message'));
  const pass = lines.filter(l => l.startsWith('PASS')).length;
  const fail = lines.filter(l => !l.startsWith('PASS'));

  console.log(`\n=== ${name}  (${path.relative(ROOT, file)}) ===`);
  if (!lines.length){
    console.log('  ✗ 没有抓到任何断言输出（页面可能没跑起来）');
    failed++;
    continue;
  }
  for (const l of fail) console.log('  ' + l);
  console.log(`  PASS ${pass} / FAIL ${fail.length}`);
  if (fail.length) failed++;
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n回归失败：${failed} 套` : '\n回归通过');
process.exit(failed ? 1 : 0);
