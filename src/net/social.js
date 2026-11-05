/**
 * 社区客户端：排行榜 / 串门房间 / 访问计数。
 * 只做"取数据 + 归一化"，不碰渲染；失败一律抛出，由调用方决定降级。
 */

export const DEFAULT_API = 'http://127.0.0.1:8787/api/v1';

/** 服务端 room 载荷 → 引擎可直接使用的房间描述 */
export function normalizeRoom(item){
  const r = (item && item.room) || {};
  return {
    userId: item.userId,
    name: r.nickname || item.nickname || '邻居',
    cozyScore: item.cozyScore || 0,
    visits: item.visits || 0,
    address: r.address || '',
    houseLevel: Math.max(0, r.houseLevel | 0),
    floorStyle: Math.max(0, r.floorStyle | 0),
    wallStyle: Math.max(0, r.wallStyle | 0),
    placed: Array.isArray(r.placed) ? r.placed.filter(p => p && p.catalogId) : []
  };
}

/**
 * @param {object} o
 * @param {string}   [o.apiBase]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.now]
 */
export function createSocialClient(o){
  const opt = o || {};
  const apiBase = (opt.apiBase || DEFAULT_API).replace(/\/$/, '');
  const fetchImpl = opt.fetchImpl || (typeof fetch === 'function' ? fetch.bind(window) : null);
  const timeoutMs = opt.timeoutMs ?? 5000;

  function req(url, init){
    if (!fetchImpl) return Promise.reject(new Error('no fetch'));
    if (typeof AbortController === 'undefined') return fetchImpl(url, init);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    return fetchImpl(url, Object.assign({}, init, { signal: ctl.signal }))
      .finally(() => clearTimeout(timer));
  }

  async function getJSON(path, token){
    const r = await req(apiBase + path, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
    if (!r.ok) throw new Error(path + ' -> ' + r.status);
    return r.json();
  }

  return {
    /** 服务端版本元信息（客户端据此判断是否需要刷新） */
    async meta(){
      return getJSON('/meta');
    },

    /** 单独拉一个内容包（模块级热更新用） */
    async pack(packId){
      const path = String(packId).split('/').map(encodeURIComponent).join('/');
      return getJSON('/content/pack/' + path);
    },

    /** 装修度排行榜 */
    async leaderboard(limit){
      const j = await getJSON('/leaderboard?limit=' + (limit || 20));
      return (j.items || []).map(it => ({
        userId: it.userId,
        name: it.nickname,
        cozyScore: it.cozyScore || 0,
        houseLevel: it.houseLevel || 0,
        day: it.day || 1
      }));
    },

    /** 可参观的房间（随机） */
    async feed(limit){
      const j = await getJSON('/rooms/feed?limit=' + (limit || 12));
      return (j.items || []).map(normalizeRoom);
    },

    /** 记录一次串门（不阻塞界面，失败忽略） */
    async visit(userId, token){
      if (!userId) return false;
      const r = await req(apiBase + '/rooms/' + encodeURIComponent(userId) + '/visit', {
        method: 'POST',
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      return r.ok;
    },

    /** 公寓楼房间目录：某栋楼里已入住的房间（含房间快照） */
    async buildingRooms(buildingId){
      if (!buildingId) return [];
      const j = await getJSON('/buildings/' + encodeURIComponent(buildingId) + '/rooms');
      return (j.items || []).map(it => {
        const snap = it.snapshot || null;
        return {
          userId: it.userId,
          name: it.nickname || '邻居',
          floor: it.floor || 0,
          room: it.room || 0,
          cozyScore: it.cozyScore || 0,
          roomData: snap ? normalizeRoom({
            userId: it.userId, nickname: it.nickname, cozyScore: it.cozyScore, visits: 0, room: snap
          }) : null
        };
      });
    },

    /** 好友列表（需要 token）：与 feed 同构，直接能拿去 enterPeer */
    async friends(token){
      if (!token) return [];
      const j = await getJSON('/friends', token);
      return (j.items || []).map(normalizeRoom);
    },

    /** 加好友：幂等；失败抛出由调用方提示 */
    async addFriend(userId, token){
      if (!userId || !token) return false;
      const r = await req(apiBase + '/friends/' + encodeURIComponent(userId), {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      });
      return r.ok;
    },

    async removeFriend(userId, token){
      if (!userId || !token) return false;
      const r = await req(apiBase + '/friends/' + encodeURIComponent(userId), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token }
      });
      return r.ok;
    },

    get apiBase(){ return apiBase; }
  };
}
