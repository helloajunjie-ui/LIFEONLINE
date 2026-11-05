/**
 * 世界时钟（统一时间）
 *
 * 模型：服务端存一个"锚点" —— 某一刻的世界总分钟数 + 那一刻的现实时间戳。
 * 客户端拿到锚点后，用现实时间差推算当前世界时间：
 *
 *   totalMinute = anchor.totalMinute + (now - anchor.at) * rate / 60000
 *
 * 为什么用锚点而不是"每秒广播"：
 *   - 一个字段就能同步，流量几乎为零
 *   - 客户端两次同步之间自己走钟，界面不会卡顿
 *   - 断网时用最后锚点继续走（自动降级为本地时钟）
 *
 * 与旧模型（存档里存 minute/day）的差别：
 *   时间是**全局**的，存档不再拥有它；存档只在离线时暂存"本地估算"。
 */
export const MINUTES_PER_DAY = 1440;

/** 世界总分钟 → {day, minute} */
export function splitTotal(totalMinute){
  const total = Math.max(0, Math.floor(totalMinute || 0));
  return {
    day: Math.floor(total / MINUTES_PER_DAY) + 1,   // 第 1 天起
    minute: total % MINUTES_PER_DAY
  };
}

/** {day, minute} → 世界总分钟 */
export function joinTotal(day, minute){
  const d = Math.max(1, Math.floor(day || 1));
  const m = Math.max(0, Math.floor(minute || 0));
  return (d - 1) * MINUTES_PER_DAY + m;
}

/**
 * 由锚点推算当前世界时间。
 * @param {{totalMinute:number, at:number}} anchor 服务端锚点（at = 毫秒时间戳）
 * @param {number} nowMs 当前现实时间戳
 * @param {number} rate 时间倍率（1 = 1 现实秒推进 1 游戏分钟）
 */
export function tickClock(anchor, nowMs, rate){
  const a = anchor || {};
  const base = Number(a.totalMinute || 0);
  const at = Number(a.at || nowMs || 0);
  const r = typeof rate === 'number' ? rate : 1;
  const elapsedMs = Math.max(0, (nowMs || at) - at);
  const total = base + (elapsedMs / 60000) * r;
  return Object.assign({ totalMinute: total, rate: r }, splitTotal(total));
}

/**
 * 漂移校正：客户端自己走了很久后，与服务端锚点比较，返回需要插值的差值。
 * 直接硬跳会让时钟"闪一下"，所以调用方应该在一段时间内线性抹平这个差值。
 * @returns {{driftMinutes:number, shouldSnap:boolean}}
 */
export function clockDrift(localTotal, serverTotal){
  const drift = (serverTotal || 0) - (localTotal || 0);
  return { driftMinutes: drift, shouldSnap: Math.abs(drift) > 30 };
}

/** 便于显示：分钟 → HH:MM */
export function fmtClock(minute){
  const m = ((Math.floor(minute || 0) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60), mm = m % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

/** 是否夜晚（用于环境光 / 睡觉判定） */
export function isNight(minute, sleep){
  const from = (sleep && sleep.fromHour) ?? 21;
  const to = (sleep && sleep.toHour) ?? 5;
  const h = Math.floor(((minute || 0) % MINUTES_PER_DAY) / 60);
  // from<=to 是普通区间（如 9→17）；from>to 是跨午夜（如 21→5）
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);
}
