#!/usr/bin/env node
/* 重复定义扫描
 *
 * 为什么需要它：这个项目的补丁脚本偶尔会被跑两遍（沙箱重试），于是同一段代码
 * 被插进文件两次。JS 里重复的顶层 function 声明**不报错**——后一个静默覆盖前一个，
 * 表现是"改了却没生效"；测试块被插两遍则会让断言数量翻倍、失败信息对不上行号。
 * 这两类问题肉眼看代码是发现不了的，必须机器扫。
 *
 * 用法：node tools/dupcheck.mjs        （有重复时退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const problems = [];

/* ① 单文件主程序：顶层 function 不能重名 */
{
  const src = read('2.5D小屋.html');
  const seen = new Map();
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))){
    const name = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    if (seen.has(name)) problems.push(`[函数重复] 2.5D小屋.html 第 ${line} 行重复定义 ${name}()（第一次在第 ${seen.get(name)} 行）`);
    else seen.set(name, line);
  }
}

/* ② 回归脚本：每个测试分组的 banner 只该出现一次 */
{
  const src = read('tests/regression.js');
  const seen = new Map();
  /* 分组名可能带数字（AT2 / SH / DP）：只写 [A-Z]{1,3} 会漏掉带数字的那批，
   * 之前就因为这个盲点放过了一次 AT2 重复插入 */
  const re = /\/\/ -{6,}\s*([A-Z]{1,3}\d{0,2})[：:]/g;
  let m;
  while ((m = re.exec(src))){
    const key = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    if (seen.has(key)) problems.push(`[分组重复] tests/regression.js 第 ${line} 行重复插入分组 ${key}（第一次在第 ${seen.get(key)} 行）`);
    else seen.set(key, line);
  }
  /* 注意：不去比对断言 id。这个脚本会被 dist / src 两套各跑一遍，
   * 同一批 id 天然出现两次；按 id 查重会报 50 多条假阳性。
   * 真正要防的是"整段被插进两次"，那一定会先让上面的分组 banner 重复。 */
}

if (problems.length){
  console.error('✗ 发现 ' + problems.length + ' 处重复：');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('✓ 没有重复的顶层函数 / 测试分组');
