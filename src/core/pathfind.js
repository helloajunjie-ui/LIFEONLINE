/**
 * 纯函数寻路：BFS 四邻接，返回最短路径（含终点，不含起点）。
 * 依赖全部注入，不碰全局状态，便于单测与复用（家 / 小区 / 邻居家共用一套）。
 *
 * @param {object}   o
 * @param {number}   o.width    网格宽
 * @param {number}   o.height   网格高
 * @param {{x:number,y:number}} o.start 起点（格子坐标）
 * @param {{x:number,y:number}} o.goal  终点
 * @param {(x:number,y:number)=>boolean} o.blocked 是否阻挡
 * @returns {Array<{gx:number,gy:number}>|null} 路径；无路返回 null；起点即终点返回 []
 */
export function findPath({ width, height, start, goal, blocked }){
  const { x: sx, y: sy } = start;
  const { x: tx, y: ty } = goal;

  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return null;
  if (blocked && blocked(tx, ty)) return null;
  if (sx === tx && sy === ty) return [];

  const key = (x, y) => y * width + x;
  const prev = new Map();
  const seen = new Set([key(sx, sy)]);
  const queue = [[sx, sy]];
  let head = 0;

  while (head < queue.length){
    const [x, y] = queue[head++];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (blocked && blocked(nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, [x, y]);
      if (nx === tx && ny === ty){
        const path = [];
        let cx = nx, cy = ny;
        while (!(cx === sx && cy === sy)){
          path.unshift({ gx: cx, gy: cy });
          const p = prev.get(key(cx, cy));
          cx = p[0]; cy = p[1];
        }
        return path;
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

/** 从起点能走到的所有格子（含起点）。用于"房间是否被封死"这类检查。 */
export function reachableCells({ width, height, start, blocked }){
  const key = (x, y) => y * width + x;
  const seen = new Set([key(start.x, start.y)]);
  const queue = [[start.x, start.y]];
  let head = 0;
  while (head < queue.length){
    const [x, y] = queue[head++];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (blocked && blocked(nx, ny)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}
