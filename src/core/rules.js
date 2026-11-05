/**
 * 规则求值：把"数值规则"从代码里搬到 content/rules/*.json，代码只负责求值。
 * 表达式只允许白名单函数，变量由调用方显式传入，避免变成"随便写 JS"的口子。
 */

const FN = {
  min: Math.min,
  max: Math.max,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  sqrt: Math.sqrt,
  abs: Math.abs
};

/** 校验表达式只用了白名单函数（内容层校验器与服务端也用同一逻辑） */
export function assertSafeExpr(expr){
  const re = /([a-zA-Z_]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(expr))){
    if (!Object.prototype.hasOwnProperty.call(FN, m[1])){
      throw new Error('表达式使用了非白名单函数: ' + m[1]);
    }
  }
  return expr;
}

/** 求值：evalExpr('min(20, round(sqrt(cozy) * 1.5))', { cozy: 10 }) */
export function evalExpr(expr, vars){
  assertSafeExpr(expr);
  const names = Object.keys(vars || {});
  const values = names.map(n => vars[n]);
  const fnNames = Object.keys(FN);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, ...fnNames, '"use strict"; return (' + expr + ');');
  return fn(...values, ...fnNames.map(n => FN[n]));
}

/**
 * 装修度带来的心情加成。
 * @param {number} cozy     当前装修度
 * @param {object} economy  rules/economy.json 内容
 * @param {number} [scale]  兼容旧调用：传了就走旧公式 min(20, sqrt(cozy)*scale)
 */
export function cozyBonus(cozy, economy, scale){
  if (typeof scale === 'number'){
    return Math.round(Math.min(20, Math.sqrt(cozy) * scale));
  }
  const expr = (economy && economy.cozy && economy.cozy.bonusExpr)
    || 'min(20, round(sqrt(cozy) * 1.5))';
  return evalExpr(expr, { cozy });
}

/** 装修度等级：取 min <= cozy 的最高档 */
export function cozyTier(cozy, tiers){
  const list = tiers || [];
  let pick = list[0] || { min: 0, name: '', stars: 0 };
  for (const t of list) if (cozy >= t.min) pick = t;
  return pick;
}

/** 晨间加成系数（跨天时用 cozyBonus * morningScale） */
export function cozyMorningBonus(cozy, economy){
  const scale = (economy && economy.cozy && economy.cozy.morningScale) ?? 0.6;
  return Math.round(cozyBonus(cozy, economy) * scale);
}

/**
 * 按游戏分钟推进生存数值（不修改入参，返回新对象）。
 * @param {{hunger:number,thirst:number,emotion:number}} stats
 * @param {object} survival rules/survival.json
 * @param {number} gameMinutes
 */
export function applyDecay(stats, survival, gameMinutes){
  const out = Object.assign({}, stats);
  for (const [k, def] of Object.entries(survival.stats || {})){
    const rate = def.decayPerGameMinute || 0;
    const max = def.max ?? 100;
    out[k] = clamp(out[k] - rate * gameMinutes, 0, max);
  }
  return out;
}

export function clamp(v, lo, hi){
  const min = lo === undefined ? 0 : lo;
  const max = hi === undefined ? 100 : hi;
  return Math.max(min, Math.min(max, v));
}
