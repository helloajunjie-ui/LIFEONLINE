/**
 * 街区世界的两种建表方式对比：一次性全表 vs 按区块惰性生成。
 *
 * 用法：node tools/bench-world.mjs
 *
 * 这里复刻引擎里同一套规则（面积小的分区优先），
 * 只换"什么时候算"，用来回答一个问题：
 * 地图从 68×48 扩大到 10 倍、100 倍，启动成本还扛得住吗？
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const map = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'content', 'maps', 'street.map.json'), 'utf8'));
const BASE_ZONES = map.zones;
const BASE_W = map.grid.w, BASE_H = map.grid.h;
const CHUNK = 16;

/** 把当前街区按网格平铺，造出更大的地图（保持同样的街区密度） */
function tileZones(w, h){
  const out = [];
  const nx = Math.ceil(w / BASE_W), ny = Math.ceil(h / BASE_H);
  for (let ty = 0; ty < ny; ty++){
    for (let tx = 0; tx < nx; tx++){
      for (const z of BASE_ZONES){
        const x = z.x + tx * BASE_W, y = z.y + ty * BASE_H;
        if (x >= w || y >= h) continue;
        out.push({ ...z, x, y, w: Math.min(z.w, w - x), h: Math.min(z.h, h - y) });
      }
    }
  }
  return out;
}
const byArea = (zs) => zs.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h));

/** 旧方案：启动时把整张 W×H 表算完 */
function buildFull(w, h, zones){
  const zs = byArea(zones);
  const grid = new Array(w * h).fill(null);
  for (let gy = 0; gy < h; gy++){
    for (let gx = 0; gx < w; gx++){
      for (const z of zs){
        if (gx >= z.x && gx < z.x + z.w && gy >= z.y && gy < z.y + z.h){ grid[gy * w + gx] = z; break; }
      }
    }
  }
  return grid;
}

/** 新方案：只建视口覆盖到的区块（1280×800 大约 3×2 个区块，留点余量算 4×3） */
function buildViewportChunks(w, h, zones, chunksX = 4, chunksY = 3){
  const zs = byArea(zones);
  let built = 0, cells = 0;
  for (let cy = 0; cy < chunksY; cy++){
    for (let cx = 0; cx < chunksX; cx++){
      const arr = new Int16Array(CHUNK * CHUNK).fill(-1);
      const x0 = cx * CHUNK, y0 = cy * CHUNK;
      for (let ly = 0; ly < CHUNK; ly++){
        const gy = y0 + ly;
        if (gy >= h) break;
        for (let lx = 0; lx < CHUNK; lx++){
          const gx = x0 + lx;
          if (gx >= w) break;
          for (let i = 0; i < zs.length; i++){
            const z = zs[i];
            if (gx >= z.x && gx < z.x + z.w && gy >= z.y && gy < z.y + z.h){ arr[ly * CHUNK + lx] = i; break; }
          }
          cells++;
        }
      }
      built++;
    }
  }
  return { built, cells };
}

const sizes = [
  [68, 48, '当前地图'],
  [136, 96, '2× 边长'],
  [272, 192, '4× 边长'],
  [544, 384, '8× 边长']
];

console.log('\n地图尺寸            格子数      分区数   旧方案(全表)   新方案(视口区块)   倍差');
console.log('-'.repeat(88));
for (const [w, h, label] of sizes){
  const zones = tileZones(w, h);
  const t0 = process.hrtime.bigint();
  buildFull(w, h, zones);
  const t1 = process.hrtime.bigint();
  const view = buildViewportChunks(w, h, zones);
  const t2 = process.hrtime.bigint();
  const oldMs = Number(t1 - t0) / 1e6;
  const newMs = Number(t2 - t1) / 1e6;
  console.log(
    `${(w + '×' + h).padEnd(18)} ${String(w * h).padEnd(11)} ${String(zones.length).padEnd(8)} ` +
    `${oldMs.toFixed(1).padStart(8)}ms   ${newMs.toFixed(2).padStart(10)}ms   ` +
    `${(oldMs / Math.max(newMs, 0.01)).toFixed(0)}×   ${label}`
  );
}
console.log('\n说明：新方案只算"玩家看得见的区块"，所以耗时几乎不随地图变大而变；');
console.log('      旧方案是 O(格子数 × 分区数)，地图翻 4 倍边长就是 16 倍成本。\n');
