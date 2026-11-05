#!/usr/bin/env node
/**
 * 渲染性能基线（无头 Edge 测量）
 *
 *   node tools/perf.mjs                 # 三个场景都跑（DPR 1）
 *   node tools/perf.mjs --dpr 2         # 高 DPI 场景
 *   node tools/perf.mjs --scene stress  # 只跑压测
 *
 * 测两件事：
 *   JS 录制   —— 执行 draw 命令的 CPU 时间（纯逻辑开销）
 *   含光栅化  —— 每帧强制回读 1 像素，逼浏览器立刻把像素画完（悲观上界）
 *
 * 为什么用 getImageData 强制刷新：否则 canvas 绘制是异步的，测出来的只是"排队时间"。
 * 注意：headless --disable-gpu 是软件光栅，比真实 GPU 慢；但低端机/远程桌面接近这个数，
 *      所以它是"能用"的下界参考，不是最优值。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:/QHTML';
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TMP = path.join(ROOT, '.tmp_perf');

const args = process.argv.slice(2);
const getArg = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const dpr = Number(getArg('--dpr', '1'));
const only = getArg('--scene', '');
const useGpu = args.includes('--gpu');   // 默认软件光栅（稳定可复现）；--gpu 测硬件加速路径

const game = fs.readFileSync(path.join(ROOT, 'dist', '2.5D小屋.html'), 'utf8');
const CALL = 'requestAnimationFrame(loop);';
const anchor = game.lastIndexOf(CALL);
if (anchor < 0) { console.error('找不到启动锚点'); process.exit(2); }
fs.mkdirSync(TMP, { recursive: true });

const PROBE = `
(function(){
  var out = [], pre = document.createElement('pre');
  pre.id = 'perf'; document.body.appendChild(pre); pre.textContent = 'running';
  try {
    var R = window.render, H = window.updateHUD;
    function bench(fn, n){ fn(); var t = performance.now(); for (var i = 0; i < n; i++) fn(); return (performance.now() - t) / n; }
    function benchFlush(n){
      R(); try { ctx.getImageData(0,0,1,1); } catch(e){}
      var t = performance.now();
      for (var i = 0; i < n; i++){ R(); try { ctx.getImageData(0,0,1,1); } catch(e){} }
      return (performance.now() - t) / n;
    }
    var js = bench(function(){ R(); }, 120);
    var raster = benchFlush(30);
    var hud = bench(function(){ H(); }, 120);

    /* 静止重绘率：走真实 loop，手动喂时间（headless 下 rAF 不随 virtual-time 推进）
     * 先用 150 帧让相机收敛到目标（相机是渐近逼近，前 100+ 帧一直在动，属于"移动中"而非"静止"），
     * 再统计接下来 120 帧：这才是玩家真的不动时的重绘占比。 */
    PLAYER.moving = false; PLAYER.path = []; PLAYER.target = null;
    floats.length = 0; particles.length = 0;
    var tbase = performance.now();
    for (var w = 1; w <= 150; w++) loop(tbase + w * 16.7);
    var d0 = RENDER_STATS.draws, s0 = RENDER_STATS.skips;
    for (var k = 1; k <= 120; k++) loop(tbase + (150 + k) * 16.7);
    var dN = RENDER_STATS.draws - d0, sN = RENDER_STATS.skips - s0;

    var ca = ctx.getContextAttributes ? ctx.getContextAttributes() : {};
    out.push('SCENE=' + (window.SCENE_LABEL || 'default'));
    out.push('GRID=' + HOME_W + 'x' + HOME_H);
    out.push('ITEMS=' + placed.length);
    out.push('JS=' + js.toFixed(2));
    out.push('RASTER=' + raster.toFixed(2));
    out.push('HUD=' + hud.toFixed(2));
    out.push('DPR=' + (window.devicePixelRatio || 1));
    out.push('CANVAS=' + canvas.width + 'x' + canvas.height);
    out.push('CTXALPHA=' + (ca.alpha === false ? '1' : '0'));
    out.push('CTXDESYNC=' + (ca.desynchronized === true ? '1' : '0'));
    out.push('IDLE_DRAWS=' + dN);
    out.push('IDLE_SKIPS=' + sN);
    pre.textContent = out.join('\\n');
  } catch(e){ pre.textContent = 'ERR ' + e.message; }
})();
`;

const SCENES = {
  home: { label: '普通小屋（默认家）', setup: '' },
  villa: {
    label: '别墅 + 18 件家具',
    setup: `houseLevel=2;applyHouseLevel();placed=[
      {catalogId:'rug_warm',gx:10,gy:6},{catalogId:'rug_cool',gx:18,gy:6},
      {catalogId:'sofa',gx:12,gy:6},{catalogId:'painting',gx:10,gy:9},
      {catalogId:'shelf',gx:11,gy:9},{catalogId:'lamp',gx:14,gy:7},
      {catalogId:'plant',gx:15,gy:9},{catalogId:'bed',gx:18,gy:11},
      {catalogId:'bookshelf',gx:20,gy:5},{catalogId:'stereo',gx:19,gy:8},
      {catalogId:'dining',gx:12,gy:12},{catalogId:'painting',gx:14,gy:12},
      {catalogId:'plant',gx:6,gy:5},{catalogId:'bed',gx:5,gy:11},
      {catalogId:'rug_cool',gx:13,gy:9},{catalogId:'tv',gx:9,gy:5},
      {catalogId:'fridge',gx:21,gy:5},{catalogId:'stove',gx:20,gy:9}
    ];PLAYER.fx=12;PLAYER.fy=8;`
  },
  rain: {
    label: '别墅 + 小雨（170 粒子）',
    setup: (() => {
      const base = `houseLevel=2;applyHouseLevel();MINUTE=14*60;
        placed=[{catalogId:'rug_warm',gx:10,gy:6},{catalogId:'sofa',gx:12,gy:6},
                {catalogId:'bed',gx:18,gy:11},{catalogId:'lamp',gx:14,gy:7},
                {catalogId:'plant',gx:15,gy:9},{catalogId:'dining',gx:12,gy:12}];
        PLAYER.fx=12;PLAYER.fy=8;
        curWeather=function(){return {id:'rain',label:'小雨',light:0.72,emotionPerHour:-0.6,particles:'rain'};};
        WX.kind='rain';WX.items.length=0;wxResizePool();`;
      return base;
    })()
  },
  street: {
    label: '小区街道（68×48 地图）',
    setup: 'switchScene("street");PLAYER.fx=32;PLAYER.fy=29;PLAYER.moving=false;PLAYER.path=[];var pp=worldToScreen(PLAYER.fx,PLAYER.fy);cam.x=viewW/2-pp.x;cam.y=viewH/2-pp.y;MINUTE=10*60;markDirty();'
  },
  stress: {
    label: '压测：别墅 + 60 件家具 + 夜晚',
    setup: (() => {
      const kinds = ['lamp', 'plant', 'painting', 'shelf', 'stereo', 'toilet', 'sink'];
      const items = [];
      for (let i = 0; i < 60; i++) items.push(JSON.stringify({ catalogId: kinds[i % kinds.length], gx: 5 + (i % 12), gy: 5 + Math.floor(i / 12) }));
      return `MINUTE=22*60;houseLevel=2;applyHouseLevel();placed=[${items.join(',')}];PLAYER.fx=12;PLAYER.fy=8;`;
    })()
  }
};

const rows = [];
for (const [key, scene] of Object.entries(SCENES)){
  if (only && only !== key) continue;
  const head = `window.SCENE_LABEL=${JSON.stringify(scene.label)};\n${scene.setup}\n`;
  let html = game.slice(0, anchor) + head + game.slice(anchor);
  html = html.replace('</body>', '<scr' + 'ipt>' + PROBE + '</scr' + 'ipt></body>');
  const file = path.join(TMP, `perf_${key}.html`);
  fs.writeFileSync(file, html, 'utf8');

  const profile = path.join(TMP, 'profile_' + key);
  fs.rmSync(profile, { recursive: true, force: true });
  const edgeArgs = ['--headless'].concat(useGpu ? ['--use-angle=d3d11', '--enable-unsafe-swiftshader'] : ['--disable-gpu']).concat(['--user-data-dir=' + profile,
    '--window-size=1280,800', '--virtual-time-budget=9000', '--dump-dom']);
  if (dpr !== 1) edgeArgs.splice(2, 0, '--force-device-scale-factor=' + dpr);

  let dom = '';
  try {
    dom = execFileSync(EDGE, edgeArgs.concat(['file:///' + file.replace(/\\/g, '/')]),
      { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  } catch (e){
    dom = e.stdout || '';
  }
  const m = dom.match(/id="perf">([\s\S]*?)<\/pre>/);
  if (!m){ console.log(`${key}: 没拿到结果`); continue; }
  const kv = {};
  for (const line of m[1].split('\n')){
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();   // trim：Windows 换行会留 \r
  }
  const total = Number(kv.JS || 0) + Number(kv.HUD || 0);
  const totalRaster = Number(kv.RASTER || 0) + Number(kv.HUD || 0);
  rows.push({
    scene: kv.SCENE || key, grid: kv.GRID, items: kv.ITEMS,
    js: Number(kv.JS), raster: Number(kv.RASTER), hud: Number(kv.HUD),
    pctJs: (total / 16.7 * 100), pctRaster: (totalRaster / 16.7 * 100),
    canvas: kv.CANVAS, ctxAlpha: kv.CTXALPHA, ctxDesync: kv.CTXDESYNC,
    idleDraws: Number(kv.IDLE_DRAWS || 0), idleSkips: Number(kv.IDLE_SKIPS || 0)
  });
}

fs.rmSync(TMP, { recursive: true, force: true });

if (!rows.length){ console.log('没有采集到数据'); process.exit(1); }

const pad = (s, n) => String(s).padEnd(n);
console.log('\n场景'.padEnd(30) + pad('网格', 9) + pad('件数', 6) + pad('JS', 8) + pad('含光栅', 9) + pad('帧预算', 9) + pad('静止重绘', 10));
console.log('-'.repeat(82));
for (const r of rows){
  const idleTotal = r.idleDraws + r.idleSkips;
  const idleTxt = idleTotal ? Math.round(r.idleDraws / idleTotal * 100) + '%' : '-';
  console.log(
    pad(r.scene, 28) + pad(r.grid, 9) + pad(r.items, 6) +
    pad(r.js.toFixed(2) + 'ms', 8) + pad(r.raster.toFixed(2) + 'ms', 9) +
    pad(r.pctRaster.toFixed(0) + '%', 9) + pad(idleTxt, 10)
  );
}
const anyCanvas = rows[0] && rows[0].canvas;
console.log(`\n渲染=${useGpu ? 'GPU 硬件加速' : 'CPU 软件光栅'}  DPR=${dpr}  canvas=${anyCanvas}  alpha:false=${rows[0] && rows[0].ctxAlpha === '1' ? '生效' : '未生效'}  desynchronized=${rows[0] && rows[0].ctxDesync === '1' ? '生效' : '未生效'}`);
console.log(`帧预算按 16.7ms(60fps) 计；"含光栅"是强制回读的上界估计（软件光栅，比 GPU 慢）`);
console.log(`"静止重绘"= 玩家完全静止时真正重绘的帧占比（越低越省电）`);
