/**
 * 存档服务：本地优先（offline-first）+ 服务端同步。
 *
 * 设计要点
 *  1. localStorage 是"本地缓存"，不是真相；服务端才是真相。
 *  2. 断网照常玩：本地立即写，联网后补推。
 *  3. 冲突用「版本号 + 字段级合并」解决：
 *     服务端版本更高 → 409 带服务端数据 → 家具取并集、数值取较新、装修风格取较新 → 再推一次。
 *  4. 所有外部依赖（fetch / storage / 时间）都可注入，方便在页面里用假实现跑测试。
 */

export const DEFAULT_API = 'http://127.0.0.1:8787/api/v1';

function safeStorage(s){
  if (s) return s;
  try { return window.localStorage; } catch(e){ return null; }
}

/** 家具列表取并集（同一 catalogId + 坐标视为同一件） */
export function mergePlaced(a, b){
  const out = [];
  const seen = new Set();
  for (const item of [].concat(a || [], b || [])){
    if (!item || !item.catalogId) continue;
    const k = item.catalogId + '@' + item.gx + ',' + item.gy;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ catalogId: item.catalogId, gx: item.gx, gy: item.gy });
  }
  return out;
}

/**
 * 字段级合并：谁新，数值与风格听谁的；家具永远取并集（避免"在另一台机器上摆的东西丢了"）。
 */
export function mergeSaves(local, remote){
  const l = local || {}, r = remote || {};
  const newer = (r.savedAt || 0) > (l.savedAt || 0) ? r : l;
  const merged = {
    money: newer.money ?? l.money ?? r.money ?? 500,
    minute: newer.minute ?? l.minute,
    day: newer.day ?? l.day,
    stats: Object.assign({}, r.stats || {}, newer.stats || {}),
    person: Object.assign({}, r.person || {}, newer.person || {}),
    appearance: Object.assign({}, r.appearance || {}, newer.appearance || {}),
    houseLevel: Math.max(l.houseLevel || 0, r.houseLevel || 0),
    sndOn: newer.sndOn ?? l.sndOn,
    floorStyle: newer.floorStyle ?? l.floorStyle ?? 0,
    wallStyle: newer.wallStyle ?? l.wallStyle ?? 0,
    ownedFloors: unionNums(l.ownedFloors, r.ownedFloors),
    ownedWalls: unionNums(l.ownedWalls, r.ownedWalls),
    placed: mergePlaced(l.placed, r.placed),
    inventory: mergeInventory(l.inventory, r.inventory),
    savedAt: Math.max(l.savedAt || 0, r.savedAt || 0)
  };
  return merged;
}

function unionNums(a, b){
  const set = new Set([].concat(a || [], b || []));
  set.add(0);
  return [...set].filter(n => typeof n === 'number').sort((x, y) => x - y);
}

function mergeInventory(a, b){
  const map = new Map();
  for (const it of [].concat(a || [], b || [])){
    if (!it || !it.catalogId) continue;
    const cur = map.get(it.catalogId) || 0;
    map.set(it.catalogId, Math.max(cur, it.count || 0));
  }
  return [...map.entries()].map(([catalogId, count]) => ({ catalogId, count }));
}

/**
 * 创建存档服务。
 * @param {object} o
 * @param {string}   [o.apiBase]   服务端地址
 * @param {object}   [o.storage]   localStorage 兼容对象（getItem/setItem/removeItem）
 * @param {Function} [o.fetchImpl] fetch 实现
 * @param {Function} [o.now]       时间源（测试可注入）
 */
export function createSaveService(o){
  const opt = o || {};
  const apiBase = (opt.apiBase || DEFAULT_API).replace(/\/$/, '');
  const storage = safeStorage(opt.storage);
  const fetchImpl = opt.fetchImpl || (typeof fetch === 'function' ? fetch.bind(window) : null);
  const now = opt.now || (() => Date.now());
  const tokenKey = opt.tokenKey || 'home_token';
  const debounceMs = opt.debounceMs ?? 1500;
  const timeoutMs = opt.timeoutMs ?? 5000;

  // 包一层超时：服务端不可达时不能把页面卡在 pending 状态（浏览器 fetch 默认没有超时）
  function req(url, init){
    if (!fetchImpl) return Promise.reject(new Error('no fetch'));
    if (typeof AbortController === 'undefined') return fetchImpl(url, init);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const merged = Object.assign({}, init, { signal: ctl.signal });
    return fetchImpl(url, merged).finally(() => clearTimeout(timer));
  }

  let status = 'idle';      // idle | local | syncing | synced | offline | merged
  let version = 0;
  let token = '';
  let lastError = '';
  let timer = null;
  let pending = null;       // 待推送的存档
  let inflight = false;
  const listeners = [];
  const mergeListeners = [];

  try { token = (storage && storage.getItem(tokenKey)) || ''; } catch(e){ token = ''; }

  function emit(s, err){
    status = s;
    lastError = err || '';
    for (const fn of listeners) { try { fn(status, lastError); } catch(e){} }
  }

  function headers(extra){
    const h = Object.assign({ Authorization: 'Bearer ' + token }, extra || {});
    return h;
  }

  async function ensureToken(){
    if (token) return token;
    if (!fetchImpl) throw new Error('no fetch');
    const r = await req(apiBase + '/auth/guest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!r.ok) throw new Error('guest ' + r.status);
    const j = await r.json();
    token = j.token;
    if (storage) { try { storage.setItem(tokenKey, token); } catch(e){} }
    return token;
  }

  /** 拉取服务端存档；没有则返回 { empty: true } */
  async function pull(){
    await ensureToken();
    let r = await req(apiBase + '/save', { headers: headers() });
    if (r.status === 401 || r.status === 403){
      token = '';
      if (storage) { try { storage.removeItem(tokenKey); } catch(e){} }
      await ensureToken();
      r = await req(apiBase + '/save', { headers: headers() });
    }
    if (r.status === 404) return { empty: true };
    if (!r.ok) throw new Error('pull ' + r.status);
    const j = await r.json();
    version = j.version || 0;
    return { empty: false, version: version, data: j.data, updatedAt: j.updatedAt };
  }

  /** 推送一次；冲突返回 { conflict: true, serverVersion, serverData } */
  async function pushRaw(data){
    await ensureToken();
    const r = await req(apiBase + '/save', {
      method: 'PUT',
      headers: headers({ 'Content-Type': 'application/json', 'If-Match': String(version) }),
      body: JSON.stringify({ data })
    });
    if (r.status === 409){
      const j = await r.json();
      return { conflict: true, serverVersion: j.serverVersion, serverData: j.serverData };
    }
    if (!r.ok) throw new Error('push ' + r.status);
    const j = await r.json();
    version = j.version || version + 1;
    return { ok: true, version: version, cozyScore: j.cozyScore };
  }

  /** 推送存档（遇到冲突自动合并后重试一次） */
  async function push(data){
    if (!fetchImpl) { emit('local'); return { skipped: true }; }
    inflight = true;
    emit('syncing');
    try {
      let payload = data;
      let res = await pushRaw(payload);
      if (res.conflict){
        payload = mergeSaves(payload, res.serverData || {});
        version = res.serverVersion || version;
        payload.savedAt = now();
        res = await pushRaw(payload);
        if (res.conflict) throw new Error('conflict again');
        emit('merged');
        // 合并结果必须回灌到本地，否则下一次自动存档会把刚合并进来的家具又覆盖掉
        for (const fn of mergeListeners) { try { fn(payload); } catch(e){} }
      } else {
        emit('synced');
      }
      pending = null;
      return Object.assign({ ok: true, merged: !!res }, { version: version, data: payload });
    } catch (e){
      pending = data;
      emit('offline', e.message);
      return { ok: false, error: e.message };
    } finally {
      inflight = false;
    }
  }

  /** 标记有改动：防抖后推送（连续操作只推最后一次） */
  function markDirty(data){
    if (!fetchImpl) { emit('local'); return; }
    pending = data;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; if (pending) push(pending); }, debounceMs);
  }

  /**
   * 启动：本地已有存档时立即用本地（不阻塞首屏），再与远端对齐。
   * @returns {Promise<{source:'remote'|'local'|'none', data?:object}>}
   */
  async function boot(localData){
    if (!fetchImpl) { emit('local'); return { source: localData ? 'local' : 'none' }; }
    emit('syncing');
    try {
      const remote = await pull();
      if (remote.empty){
        if (localData) {
          const r = await push(Object.assign({}, localData, { savedAt: localData.savedAt || now() }));
          return { source: 'local', pushed: !!r.ok };
        }
        emit('synced');
        return { source: 'none' };
      }
      if (!localData){
        emit('synced');
        return { source: 'remote', data: remote.data };
      }
      const localAt = localData.savedAt || 0;
      const remoteAt = Date.parse(remote.updatedAt || '') || 0;
      if (remoteAt > localAt + 1500){
        const merged = mergeSaves(localData, remote.data || {});
        emit('synced');
        return { source: 'remote', data: merged };
      }
      const r = await push(localData);
      return { source: 'local', pushed: !!r.ok };
    } catch (e){
      emit('offline', e.message);
      return { source: localData ? 'local' : 'none' };
    }
  }

  /** 重新尝试推送积压（联网恢复时调用） */
  async function flush(){
    if (!pending || inflight) return { ok: false, skipped: true };
    return push(pending);
  }

  return {
    boot, push, flush, markDirty, pull,
    merge: mergeSaves,
    onStatus(fn){ listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    /** 订阅"冲突合并后的最终存档"，调用方应把它灌回游戏状态 */
    onMerge(fn){ mergeListeners.push(fn); return () => { const i = mergeListeners.indexOf(fn); if (i >= 0) mergeListeners.splice(i, 1); }; },
    get status(){ return status; },
    get version(){ return version; },
    get token(){ return token; },
    get error(){ return lastError; },
    get hasPending(){ return !!pending; },
    get apiBase(){ return apiBase; }
  };
}
