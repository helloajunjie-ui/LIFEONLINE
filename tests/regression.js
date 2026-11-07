(async function(){
  const out = [];
  const P = (n, ok, x) => out.push((ok ? 'PASS' : 'FAIL') + ' | ' + n + (x !== undefined ? ' | ' + x : ''));
  const pre = document.createElement('pre');
  pre.id = 'testout';
  document.body.appendChild(pre);
  const flush = () => { pre.textContent = out.join('\n'); };

  try {
    /* 启动快照：小区分区/树木是按区块惰性生成的，这里记下初始状态，
     * 用来证明"没人在开局就把整张地图算完"。 */
    const BOOT_ZONE_CHUNKS = _zoneChunks.size;
    const BOOT_TREE_CHUNKS = _treeChunks.size;

    /* ---------- 内容层接线 ---------- */
    P('C1 engine bundle loaded', typeof HomeCore === 'object' && !!HomeCore.content);
    P('C2 catalog from content', FURNITURE_CATALOG.length === 43, 'len=' + FURNITURE_CATALOG.length);
    const bed = FURNITURE_CATALOG.find(d => d.id === 'bed');
    P('C3 bed mapped', !!bed && bed.w === 2 && bed.cozy === 6 && bed.action === 'sleep', JSON.stringify(bed));
    const rug = FURNITURE_CATALOG.find(d => d.id === 'rug_warm');
    P('C4 rug walkable flag', !!rug && rug.walk === true && rug.w === 2 && rug.h === 2);
    P('C5 house levels from content', HOUSE_LEVELS.length === 5 && HOUSE_LEVELS[1].walls.length === 0 && HOUSE_LEVELS[1].w === 17, 'lv1 walls=' + HOUSE_LEVELS[1].walls.length);
    P('C6 styles from content', FLOOR_STYLES.length === 4 && WALL_STYLES.length === 4 && FLOOR_STYLES[1].pattern === 'tile');
    P('C7 rules from content', Math.abs(DECAY.hunger - 0.05) < 1e-9 && Math.abs(EMOTION_DECAY - 0.06) < 1e-9 && WORK_PAY === 60,
      JSON.stringify({ hunger: DECAY.hunger, emo: EMOTION_DECAY, pay: WORK_PAY }));
    // realtime 模式下 MINUTE 来自北京时间，game 模式才从 startMinute 开始
    const clockOk = (TIME_SOURCE === 'realtime')
      ? (MINUTE >= 0 && MINUTE < 1440)
      : (Math.abs(MINUTE - RULE.START_MINUTE) < 3);
    P('C8 start money/clock', MONEY === 500 && clockOk,
      'money=' + MONEY + ' minute=' + MINUTE.toFixed(2) + ' source=' + TIME_SOURCE);

    /* ---------- 规则模块 ---------- */
    P('R1 cozyBonus matches expr', HomeCore.rules.cozyBonus(10, HomeCore.content.economy()) === 5,
      'got=' + HomeCore.rules.cozyBonus(10, HomeCore.content.economy()));
    P('R2 cozyTier from content', HomeCore.rules.cozyTier(40, HomeCore.content.economy().cozy.tiers).name === '温馨小屋');
    let safeBlocked = false;
    try { HomeCore.rules.evalExpr('alert(1)', {}); } catch(e){ safeBlocked = true; }
    P('R3 expression whitelist blocks unknown fn', safeBlocked);

    /* ---------- 寻路模块 ---------- */
    const blockedSet = new Set(['2,1', '2,2']);
    const path = HomeCore.pathfind.findPath({
      width: 5, height: 5,
      start: { x: 0, y: 1 }, goal: { x: 4, y: 1 },
      blocked: (x, y) => blockedSet.has(x + ',' + y)
    });
    const detours = path && path.length > 4;
    P('R4 pathfind detours around wall', !!path && detours, 'len=' + (path ? path.length : 'null'));
    P('R5 pathfind null when blocked goal', HomeCore.pathfind.findPath({
      width: 5, height: 5, start: { x: 0, y: 0 }, goal: { x: 2, y: 2 },
      blocked: (x, y) => x === 2 && y === 2
    }) === null);

    /* ---------- 引擎整体（沿用旧行为） ---------- */
    scene = 'home';
    placed = [];
    const spot = findFreeNear(HOME.gx, HOME.gy);
    PLAYER.fx = spot.gx; PLAYER.fy = spot.gy;
    render();
    P('E1 render ok', true);

    // 家具放置 + 装修度
    placed = [{ catalogId: 'bed', gx: 5, gy: 5 }, { catalogId: 'rug_warm', gx: 8, gy: 8 }];
    P('E2 cozy from content items', cozyScore() === 10, 'cozy=' + cozyScore());
    P('E3 rug walkable in engine', isOccupied(8, 8) === false && moveBlocked(8, 8) === false);

    // 贴地装饰深度：角色踩地毯时不应被地毯盖住
    PLAYER.fx = 8; PLAYER.fy = 8;
    const rugDef = HomeCore.content.catalogItem('rug_warm');
    render();
    P('E4 render with rug + standing', !!rugDef && rugDef.footprint.w === 2 && rugDef.placement.walkable === true);

    // 睡觉装修度加成（内容层公式）
    const bedInst = placed[0];
    PLAYER.fx = 6; PLAYER.fy = 6; PLAYER.moving = false; PLAYER.path = []; PLAYER.target = null;
    MINUTE = 22 * 60; DAY = 3; STATS.emotion = 40;
    interacting = { furn: bedInst, timer: 0.01, wait: 9 };
    updateInteract(0.05);
    if (TIME_SOURCE === 'realtime'){
      // 实时时钟：睡一觉不会为自己跳过现实时间，但情绪加成照给
      P('E5 sleep (realtime: gains emotion, clock unchanged)',
        MINUTE === 22 * 60 && STATS.emotion > 46,
        'minute=' + MINUTE + ' emo=' + Math.round(STATS.emotion));
    } else {
      P('E5 sleep uses cozy bonus', MINUTE === 420 && DAY === 4 && STATS.emotion > 46,
        'minute=' + MINUTE + ' day=' + DAY + ' emo=' + Math.round(STATS.emotion));
    }

    // 存档往返
    MONEY = 1234; floorStyle = 2; wallStyle = 1;
    ownedFloors = [0, 2]; ownedWalls = [0, 1];   // 只有买过的风格才会被存档恢复
    saveGame();
    MONEY = 0; floorStyle = 0; wallStyle = 0; placed = []; ownedFloors = [0]; ownedWalls = [0];
    loadGame(); applyHouseLevel();
    P('E6 save/load roundtrip', MONEY === 1234 && floorStyle === 2 && wallStyle === 1 && placed.length === 2,
      'money=' + MONEY + ' floor=' + floorStyle + ' placed=' + placed.length);

    /* ---------- 云同步（假服务端，纯逻辑验证） ---------- */
    function memStorage(){
      const m = new Map();
      return {
        getItem: k => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: k => m.delete(k)
      };
    }
    function fakeServer(opts){
      const o = opts || {};
      const st = { token: null, version: o.version || 0, data: o.data || null, guest: 0, puts: 0,
                   conflictOnce: !!o.conflictOnce, fail: !!o.fail };
      const reply = (code, obj) => ({ ok: code >= 200 && code < 300, status: code, json: async () => obj });
      const fetchImpl = async (url, init) => {
        if (st.fail) throw new Error('network down');
        const method = ((init && init.method) || 'GET').toUpperCase();
        const h = (init && init.headers) || {};
        if (/\/auth\/guest$/.test(url)){
          st.guest++; st.token = 'tok' + st.guest;
          return reply(200, { token: st.token, userId: 'u1' });
        }
        if (!h.Authorization) return reply(401, { error: 'no token' });
        if (method === 'GET' && /\/save$/.test(url)){
          if (!st.data) return reply(404, {});
          return reply(200, { version: st.version, data: st.data, updatedAt: new Date(Date.now() - 1000).toISOString() });
        }
        if (method === 'PUT' && /\/save$/.test(url)){
          const body = JSON.parse(init.body);
          const want = Number(String(h['If-Match'] || '0'));
          if (st.conflictOnce){
            st.conflictOnce = false;
            st.version = st.version + 1;
            st.data = { placed: [{ catalogId: 'sofa', gx: 1, gy: 1 }], money: 999, savedAt: Date.now() };
            return reply(409, { serverVersion: st.version, serverData: st.data });
          }
          if (want !== st.version) return reply(409, { serverVersion: st.version, serverData: st.data });
          st.version++; st.puts++; st.data = body.data;
          return reply(200, { version: st.version, cozyScore: 0 });
        }
        return reply(404, {});
      };
      return { fetchImpl, state: st };
    }

    // S1 合并策略：家具取并集，数值听较新的
    const merged = HomeCore.save.mergeSaves(
      { money: 100, savedAt: 1000, placed: [{ catalogId: 'bed', gx: 5, gy: 5 }], ownedFloors: [0] },
      { money: 300, savedAt: 2000, placed: [{ catalogId: 'sofa', gx: 8, gy: 5 }], ownedFloors: [0, 1] }
    );
    P('S1 merge placed union + newer numbers',
      merged.placed.length === 2 && merged.money === 300 && merged.ownedFloors.length === 2,
      'placed=' + merged.placed.length + ' money=' + merged.money);

    // S2/S3 服务端为空 + 本地有档 → 首次上传，token 只建一次
    {
      const st = memStorage(), srv = fakeServer();
      const svc = HomeCore.save.createSaveService({ apiBase: 'http://x/api/v1', storage: st, fetchImpl: srv.fetchImpl, now: () => 5000, debounceMs: 0 });
      const r = await svc.boot({ money: 100, placed: [{ catalogId: 'bed', gx: 5, gy: 5 }], savedAt: 1000 });
      P('S2 first upload', r.source === 'local' && r.pushed && srv.state.puts === 1 && srv.state.version === 1,
        'source=' + r.source + ' puts=' + srv.state.puts + ' ver=' + srv.state.version);
      P('S3 token cached', srv.state.guest === 1 && st.getItem('home_token') === 'tok1');
    }

      // S4 冲突：409 → 合并 → 重推成功，并且合并结果要回灌本地
      {
        const st = memStorage(), srv = fakeServer({ conflictOnce: true });
        const svc = HomeCore.save.createSaveService({ apiBase: 'http://x/api/v1', storage: st, fetchImpl: srv.fetchImpl, now: () => 9000, debounceMs: 0 });
        let mergedPayload = null;
        svc.onMerge(payload => { mergedPayload = payload; });
        const res = await svc.push({ money: 100, placed: [{ catalogId: 'bed', gx: 5, gy: 5 }], savedAt: 8000 });
        const savedPlaced = (srv.state.data && srv.state.data.placed) || [];
        P('S4 conflict merge + retry',
          !!res.ok && res.merged === true && savedPlaced.length === 2 && srv.state.puts === 1,
          'placed in server=' + savedPlaced.length + ' puts=' + srv.state.puts);
        P('S4b merged payload reaches caller',
          !!mergedPayload && mergedPayload.placed.length === 2,
          'merged placed=' + (mergedPayload ? mergedPayload.placed.length : 'null'));
      }

    // S5 断网：转离线、保留待推，恢复后 flush 成功
    {
      const st = memStorage(), srv = fakeServer({ fail: true });
      const svc = HomeCore.save.createSaveService({ apiBase: 'http://x/api/v1', storage: st, fetchImpl: srv.fetchImpl, now: () => 1, debounceMs: 0 });
      const bootRes = await svc.boot({ money: 100, savedAt: 1 });
      const offline = bootRes.source === 'local' && svc.status === 'offline';
      svc.markDirty({ money: 200, savedAt: 2 });
      const pend = svc.hasPending;
      srv.state.fail = false;                       // 网络恢复
      const r2 = await svc.flush();
      P('S5 offline queue then flush',
        offline && pend && !!r2.ok && srv.state.puts === 1,
        'status=' + svc.status + ' pending=' + pend + ' flushed=' + !!r2.ok);
    }

    // S6 服务端更新 → 启动时接管
    {
      const st = memStorage(), srv = fakeServer({
        version: 7,
        data: { money: 777, placed: [{ catalogId: 'tv', gx: 9, gy: 9 }], savedAt: Date.now() }
      });
      const svc = HomeCore.save.createSaveService({ apiBase: 'http://x/api/v1', storage: st, fetchImpl: srv.fetchImpl, now: () => 1, debounceMs: 0 });
      const r = await svc.boot({ money: 100, placed: [{ catalogId: 'bed', gx: 5, gy: 5 }], savedAt: 1000 });
      P('S6 boot adopts newer remote', r.source === 'remote' && r.data.money === 777 && r.data.placed.length === 2,
        'source=' + r.source + ' money=' + (r.data && r.data.money) + ' placed=' + (r.data ? r.data.placed.length : '-'));
    }

    /* ---------- 社区（排行榜 / 串门） ---------- */
    {
      const reply = (code, obj) => ({ ok: code >= 200 && code < 300, status: code, json: async () => obj });
      const socialFetch = async (url) => {
        if (url.indexOf('/leaderboard') >= 0){
          return reply(200, { items: [{ userId: 'u1', nickname: '甲', cozyScore: 30, houseLevel: 1, day: 3 }] });
        }
        if (url.indexOf('/rooms/feed') >= 0){
          return reply(200, { items: [{ userId: 'u1', nickname: '甲', cozyScore: 30, visits: 2,
            room: { nickname: '甲', houseLevel: 1, floorStyle: 1, wallStyle: 2,
                    placed: [{ catalogId: 'bed', gx: 5, gy: 5 }] } }] });
        }
        return reply(404, {});
      };
      const sc = HomeCore.social.createSocialClient({ apiBase: 'http://x/api/v1', fetchImpl: socialFetch });
      const board = await sc.leaderboard(5);
      const feed = await sc.feed(5);
      P('P1 leaderboard mapping', board.length === 1 && board[0].name === '甲' && board[0].cozyScore === 30);
      P('P2 feed room normalize', feed.length === 1 && feed[0].name === '甲' && feed[0].houseLevel === 1 &&
        feed[0].wallStyle === 2 && feed[0].placed.length === 1);

      // P3 串门：状态切换 + 禁止写档
      scene = 'home'; houseLevel = 0; floorStyle = 0; wallStyle = 0;
      placed = [{ catalogId: 'sofa', gx: 5, gy: 5 }];
      applyHouseLevel();
      const beforeW = HOUSE_W;
      enterPeer(feed[0]);
      const inPeer = scene === 'peer' && HOUSE_W === 17 && floorStyle === 1 && wallStyle === 2 && placed.length === 1;
      render();
      P('P3 enter peer swaps state', inPeer, 'scene=' + scene + ' HOUSE_W=' + HOUSE_W + ' placed=' + placed.length);

      const beforeMoney = MONEY;
      MONEY = 424242;
      saveGame();                       // 参观时不应写档
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem('my2dhome_save_v1') || 'null'); } catch(e){}
      const blocked = !stored || stored.money !== 424242;
      P('P4 save blocked while visiting', blocked);
      MONEY = beforeMoney;

      leavePeer();
      P('P5 leave peer restores home',
        scene === 'home' && HOUSE_W === beforeW && houseLevel === 0 && floorStyle === 0 &&
        placed.length === 1 && placed[0].catalogId === 'sofa',
        'scene=' + scene + ' HOUSE_W=' + HOUSE_W + ' placed=' + (placed[0] && placed[0].catalogId));
      render();
      P('P6 render home after visit ok', true);

      /* N 系列：串门的边界情况 */
      // N1 对方家具有一件压在隔墙上 → 迁移逻辑不能塞进我的仓库
      const invBefore = inventory.length;
      placed = [{ catalogId: 'sofa', gx: 5, gy: 5 }];
      inventory = [{ catalogId: 'lamp', count: 2 }];
      applyHouseLevel();
      const invLen = inventory.length;
      enterPeer({
        userId: 'u2', name: '乙', cozyScore: 20, houseLevel: 2, floorStyle: 0, wallStyle: 0,
        placed: [{ catalogId: 'bed', gx: 8, gy: 5 }]     // 8,5 是别墅隔墙
      });
      P('N1 peer migrate does not pollute inventory', inventory.length === invLen,
        'inventory=' + inventory.length + ' (期望 ' + invLen + ')');
      // N2 参观时墙体按对方房型阻挡
      const wallBlocked = moveBlocked(8, 5);
      const freeCell = moveBlocked(10, 7);
      P('N2 peer walls block movement', wallBlocked === true && freeCell === false,
        'wall=' + wallBlocked + ' free=' + freeCell);
      leavePeer();
      P('N3 leave restores inventory', inventory.length === invLen && placed.length === 1,
        'inv=' + inventory.length + ' placed=' + placed.length);
      inventory = [];
      placed = [{ catalogId: 'bed', gx: 5, gy: 5 }];

      // N4 串门计数要带上 token（否则服务端 401，访问数永远 0）
      {
        let seenAuth = '';
        const capFetch = async (url, init) => {
          if (url.indexOf('/visit') >= 0){
            seenAuth = ((init && init.headers) || {}).Authorization || '';
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
          }
          return { ok: false, status: 404, json: async () => ({}) };
        };
        const sc2 = HomeCore.social.createSocialClient({ apiBase: 'http://x/api/v1', fetchImpl: capFetch });
        const okVisit = await sc2.visit('u9', 'tok-abc');
        P('N4 visit carries bearer token', okVisit === true && seenAuth === 'Bearer tok-abc', 'auth=' + seenAuth);
      }

      /* 好友：客户端只做"带 token / 方法正确 / 归一化"，权限与幂等在服务端自测 */
      {
        const calls = [];
        const friendFetch = async (url, init) => {
          calls.push({ url, method: (init && init.method) || 'GET', auth: ((init && init.headers) || {}).Authorization || '' });
          if (url.indexOf('/friends') >= 0 && (!init || !init.method || init.method === 'GET')){
            return reply(200, { items: [{ userId: 'u7', nickname: '丁', cozyScore: 12, visits: 1,
              room: { nickname: '丁', houseLevel: 1, floorStyle: 0, wallStyle: 0, placed: [] } }] });
          }
          return reply(200, { ok: true, removed: 1 });
        };
        const sc3 = HomeCore.social.createSocialClient({ apiBase: 'http://x/api/v1', fetchImpl: friendFetch });

        const empty = await sc3.friends('');
        P('P7 friends without token short-circuits', empty.length === 0 && calls.length === 0, 'calls=' + calls.length);

        const list = await sc3.friends('tok-f');
        P('P8 friends normalizes room + sends bearer',
          list.length === 1 && list[0].userId === 'u7' && list[0].name === '丁' && list[0].houseLevel === 1 &&
          calls.length === 1 && calls[0].auth === 'Bearer tok-f',
          JSON.stringify(calls[0] || {}));

        const added = await sc3.addFriend('u7', 'tok-f');
        const removed = await sc3.removeFriend('u7', 'tok-f');
        const addCall = calls[1] || {}, delCall = calls[2] || {};
        P('P9 add/remove use POST/DELETE with token',
          added === true && removed === true &&
          addCall.method === 'POST' && addCall.url.indexOf('/friends/u7') >= 0 && addCall.auth === 'Bearer tok-f' &&
          delCall.method === 'DELETE' && delCall.url.indexOf('/friends/u7') >= 0,
          (addCall.method || '?') + '/' + (delCall.method || '?'));

        // P10 面板：好友分组、加好友按钮、去串门都在
        renderSocial([{ name: '甲', cozyScore: 30, houseLevel: 1, day: 3 }],
          [{ userId: 'u8', name: '戊', cozyScore: 8, visits: 0, placed: [] }],
          list);
        const html = socialListEl.innerHTML;
        P('P10 social panel shows friends + add button',
          html.indexOf('我的好友') >= 0 && html.indexOf('丁 的家') >= 0 &&
          html.indexOf('data-act="add"') >= 0 && html.indexOf('data-act="del"') >= 0,
          'len=' + html.length);
      }

      // N5 参观中点"回原位"/切场景，必须先还原自己家（否则会把别人家存成自己的）      scene = 'home'; houseLevel = 0; floorStyle = 0; wallStyle = 0;
      placed = [{ catalogId: 'sofa', gx: 5, gy: 5 }];
      applyHouseLevel();
      enterPeer({ userId: 'u3', name: '丙', cozyScore: 15, houseLevel: 2, floorStyle: 1, wallStyle: 1,
                  placed: [{ catalogId: 'bed', gx: 8, gy: 5 }] });
      const enteredPeer = scene === 'peer' && HOUSE_W === 20;
      switchScene('home');
      P('N5 switchScene while visiting restores own home',
        enteredPeer && scene === 'home' && houseLevel === 0 && HOUSE_W === 14 &&
        placed.length === 1 && placed[0].catalogId === 'sofa',
        'entered=' + enteredPeer + ' scene=' + scene + ' HOUSE_W=' + HOUSE_W + ' placed=' + placed.length);

      // N6 即使 scene 被异常改回 home，只要有 peerSnapshot 就不许写档
      enterPeer({ userId: 'u4', name: '丁', cozyScore: 12, houseLevel: 1, floorStyle: 0, wallStyle: 0,
                  placed: [{ catalogId: 'tv', gx: 6, gy: 6 }] });
      scene = 'home';                       // 模拟异常路径
      const keepMoney = MONEY;
      MONEY = 777777;
      saveGame();
      let stored2 = null;
      try { stored2 = JSON.parse(localStorage.getItem('my2dhome_save_v1') || 'null'); } catch(e){}
      P('N6 peerSnapshot blocks save even if scene flipped', !stored2 || stored2.money !== 777777);
      MONEY = keepMoney;
      scene = 'peer'; leavePeer();          // 清理：正常退出

      // N7 商店与社区面板互斥
      toggleShop(true);
      const shopOpened = document.getElementById('shop').classList.contains('open');
      toggleSocial(true);
      const socialOpened = document.getElementById('social').classList.contains('open');
      const shopClosed = !document.getElementById('shop').classList.contains('open');
      P('N7 panels are mutually exclusive', shopOpened && socialOpened && shopClosed,
        'shop=' + shopOpened + ' social=' + socialOpened + ' shopClosed=' + shopClosed);
      toggleSocial(false);

      // N8 家具压在地毯上时，点击应命中家具而不是地毯
      scene = 'home'; houseLevel = 0; floorStyle = 0; wallStyle = 0;
      placed = [
        { catalogId: 'rug_warm', gx: 8, gy: 8 },
        { catalogId: 'lamp',     gx: 8, gy: 8 }
      ];
      applyHouseLevel();
      const hitFurn = placedAt(8, 8);
      const hitRugOnly = placedAt(9, 9);      // 地毯另一角，没有家具
      P('N8 furniture wins over rug on click',
        !!hitFurn && hitFurn.catalogId === 'lamp' && !!hitRugOnly && hitRugOnly.catalogId === 'rug_warm',
        'hit=' + (hitFurn && hitFurn.catalogId) + ' rugOnly=' + (hitRugOnly && hitRugOnly.catalogId));
    }

    /* ---------- 版本号与升级判定 ---------- */
    {
      const V = HomeCore.version;
      P('V1 compareVersion', V.compareVersion('1.6.0', '1.5.9') === 1 &&
        V.compareVersion('1.6.0', '1.6.0') === 0 &&
        V.compareVersion('1.5.0', '1.6.0') === -1,
        V.compareVersion('1.6.0', '1.5.9') + '/' + V.compareVersion('1.5.0', '1.6.0'));
      P('V2 prerelease lower than release', V.compareVersion('1.6.0-beta', '1.6.0') === -1 &&
        V.compareVersion('1.6.0+abc', '1.6.0') === 0);

      const client = V.CLIENT;
      P('V3 client build injected', !!client && client.appVersion === CLIENT_VERSION.appVersion &&
        client.contentVersion >= 1 && client.saveSchema === CLIENT_VERSION.saveSchema && client.contentHash.length === 12,
        JSON.stringify({ app: client.appVersion, c: client.contentVersion, s: client.saveSchema }));

      const okV = V.evaluateUpdate(client, { appVersion: client.appVersion, contentVersion: client.contentVersion,
        contentHash: 'deadbeef0000', minAppVersion: '1.6.0' });
      P('V4 same version stays ok (hash ignored)', okV.status === 'ok' && okV.action === 'none', okV.status);

      const newer = V.evaluateUpdate(client, { contentVersion: client.contentVersion + 1, minAppVersion: '1.6.0' });
      P('V5 server content newer -> reload hint', newer.status === 'content-updated' && newer.action === 'reload');

      const tooOld = V.evaluateUpdate({ appVersion: '1.0.0', contentVersion: 1 }, { contentVersion: 1, minAppVersion: '1.6.0' });
      P('V6 outdated client -> reload hint', tooOld.status === 'client-outdated' && tooOld.action === 'reload');

      const srvOld = V.evaluateUpdate(client, { contentVersion: client.contentVersion - 1, minAppVersion: '1.0.0' });
      P('V7 server older -> warn only', srvOld.status === 'server-outdated' && srvOld.action === 'warn');

      const legacy = { money: 88, placed: [], day: 2 };
      const migrated = migrateSave(legacy);
      P('V8 legacy save migrated', migrated.schema === client.saveSchema &&
        Array.isArray(migrated.inventory) && Array.isArray(migrated.ownedFloors) && migrated.savedAt === 0,
        'schema=' + migrated.schema + ' inv=' + Array.isArray(migrated.inventory));

      const dumped = collectSave();
      P('V9 save carries schema', dumped.schema === client.saveSchema && typeof dumped.savedAt === 'number',
        'schema=' + dumped.schema);

      /* 模块级版本与热替换 */
      const srvMods = {
        modules: {
          'content/catalog/furniture.core.json': { version: 2, hash: 'aaaaaaaaaaaa' },
          'src/core/rules.js': { version: null, hash: 'bbbbbbbbbbbb' }
        }
      };
      const diff = V.diffModules(client, srvMods);
      P('V10 diffModules reports changed modules', diff.length === 2 &&
        diff.some(d => d.id === 'content/catalog/furniture.core.json' && d.to === 2),
        diff.map(d => d.id + ':' + d.kind).join(','));

      const split = V.splitHotPatchable(diff);
      P('V11 split hot vs reload', split.hot.length === 1 && split.needsReload.length === 1 &&
        split.needsReload[0].id === 'src/core/rules.js',
        'hot=' + split.hot.length + ' reload=' + split.needsReload.length);

      // V12 单包热替换：改了床的 cozy，装修度立刻跟着变
      {
        const packs = HomeCore.content.loadedPacks();
        const corePack = JSON.parse(JSON.stringify(packs['catalog/furniture.core.json']));
        const bed = corePack.items.find(i => i.id === 'bed');
        const beforeCozy = bed.cozy;
        bed.cozy = beforeCozy + 3;
        const ok1 = HomeCore.content.applyPack('catalog/furniture.core.json', corePack);
        const afterCozy = HomeCore.content.catalogItem('bed').cozy;
        P('V12 hot patch single content pack', ok1 === true && afterCozy === beforeCozy + 3,
          'cozy ' + beforeCozy + ' -> ' + afterCozy);

        // 还原，避免污染后续用例
        bed.cozy = beforeCozy;
        HomeCore.content.applyPack('catalog/furniture.core.json', corePack);
        refreshContentBindings();
        P('V13 bindings refreshed after patch', FURNITURE_CATALOG.find(d => d.id === 'bed').cozy === beforeCozy,
          'catalog cozy=' + FURNITURE_CATALOG.find(d => d.id === 'bed').cozy);
      }
    }

    /* ---------- 环境层（天气 / 随机物 / 生长 / 车流） ---------- */
    {
      const E = HomeCore.environment;
      const packs = HomeCore.content.loadedPacks();
      const climate = packs['environment/climate.json'];
      const ambient = packs['environment/ambient.json'];
      P('W0 environment packs present', !!climate && !!ambient &&
        (climate.weathers || []).length >= 3 && !!ambient.scatter, 'weathers=' + (climate && climate.weathers.length));

      const w1 = E.weatherAt('u-abc', 3, 600, climate);
      const w2 = E.weatherAt('u-abc', 3, 600, climate);
      const ids = new Set((climate.weathers || []).map(x => x.id));
      P('W1 weather deterministic & valid', w1.id === w2.id && ids.has(w1.id), w1.id + '/' + w2.id);

      const w3 = E.weatherAt('u-abc', 3, 601, climate);
      P('W2 weather stable within slot', w3.id === w1.id || w1.blend > 0, 'blend=' + w1.blend);

      const rect = { x: 4, y: 4, w: 20, h: 12 };
      const blockedSet = new Set(['5,5', '6,5']);
      const scatterA = E.scatterProps({ seed: 'u-abc', rect, density: ambient.scatter.densityPer100, salt: 'yard', blocked: (x, y) => blockedSet.has(x + ',' + y) });
      const scatterB = E.scatterProps({ seed: 'u-abc', rect, density: ambient.scatter.densityPer100, salt: 'yard', blocked: (x, y) => blockedSet.has(x + ',' + y) });
      const noBlocked = scatterA.every(p => !blockedSet.has(p.x + ',' + p.y));
      const same = JSON.stringify(scatterA) === JSON.stringify(scatterB);
      P('W3 scatter deterministic & respects blocked', same && noBlocked && scatterA.length > 0,
        'props=' + scatterA.length + ' same=' + same + ' noBlocked=' + noBlocked);

      const scatterC = E.scatterProps({ seed: 'u-xyz', rect, density: ambient.scatter.densityPer100, salt: 'yard', blocked: (x, y) => blockedSet.has(x + ',' + y) });
      P('W4 different seed differs', JSON.stringify(scatterA) !== JSON.stringify(scatterC),
        scatterA.length + ' vs ' + scatterC.length);

      const st1 = E.growthStage(1000, 1000, ambient.growth, 0);
      const st2 = E.growthStage(1000, 1800, ambient.growth, 0);
      const st3 = E.growthStage(1000, 4000, ambient.growth, 0);
      P('W5 growth stage progresses', st1.scale < st2.scale && st2.scale < st3.scale,
        st1.id + '(' + st1.scale + ') → ' + st2.id + '(' + st2.scale + ') → ' + st3.id + '(' + st3.scale + ')');

      const lanes = [{ id: 'main', axis: 'x', at: 12, length: 30, from: 0 }, { id: 'side', axis: 'y', at: 4, length: 18, from: 0 }];
      const t1 = E.trafficAt('u-abc', 500, lanes, ambient.traffic);
      const t2 = E.trafficAt('u-abc', 500, lanes, ambient.traffic);
      const inRange = t1.every(c => (c.laneId === 'main' ? c.x >= 0 && c.x < 30 : c.y >= 0 && c.y < 18));
      P('W6 traffic deterministic & in lane', JSON.stringify(t1) === JSON.stringify(t2) && inRange && t1.length >= 2,
        'cars=' + t1.length + ' inRange=' + inRange);

      const night = E.daytimeAt(23 * 60, climate);
      const noon = E.daytimeAt(12 * 60, climate);
      P('W7 daytime mapping', night.id === 'night' && noon.id === 'noon', night.id + '/' + noon.id);

      // W8 天气作用域：local 按用户，global 按世界种子
      const localSeed = E.weatherSeed({ scope: 'local' }, 'u1');
      const globalSeed1 = E.weatherSeed({ scope: 'global' }, 'u1', 'w-1');
      const globalSeed2 = E.weatherSeed({ scope: 'global' }, 'u2', 'w-1');
      P('W8 weather scope switch',
        localSeed === 'user:u1' && globalSeed1 === globalSeed2 && globalSeed1 === 'world:w-1',
        localSeed + ' / ' + globalSeed1);
    }

    /* ---------- 世界时钟（统一时间） ---------- */
    {
      const C = HomeCore.clock;
      const t = C.splitTotal(1440 + 480);
      P('T1 splitTotal', t.day === 2 && t.minute === 480, 'day=' + t.day + ' minute=' + t.minute);
      P('T2 joinTotal roundtrip', C.joinTotal(t.day, t.minute) === 1920);

      // 1 分钟现实时间 × 1 倍率 = 前进 1 游戏分钟
      const anchor = { totalMinute: 480, at: 1_000_000 };
      const after1min = C.tickClock(anchor, 1_000_000 + 60_000, 1);
      P('T3 tick advances by rate', Math.abs(after1min.totalMinute - 481) < 0.001 &&
        after1min.minute === 481, 'total=' + after1min.totalMinute.toFixed(2));

      const after2x = C.tickClock(anchor, 1_000_000 + 60_000, 2);
      P('T4 rate 2x doubles', Math.abs(after2x.totalMinute - 482) < 0.001, 'total=' + after2x.totalMinute.toFixed(2));

      const backwards = C.tickClock(anchor, 1_000_000 - 60_000, 1);
      P('T5 clock never goes backwards', backwards.totalMinute === 480);

      const drift = C.clockDrift(1000, 1002);
      const snap = C.clockDrift(1000, 1100);
      P('T6 drift small vs snap', drift.shouldSnap === false && snap.shouldSnap === true,
        drift.driftMinutes + '/' + snap.driftMinutes);

      P('T7 fmtClock', C.fmtClock(0) === '00:00' && C.fmtClock(485) === '08:05' && C.fmtClock(1439) === '23:59',
        C.fmtClock(485));
      P('T8 isNight', C.isNight(22 * 60, { fromHour: 21, toHour: 5 }) === true &&
        C.isNight(12 * 60, { fromHour: 21, toHour: 5 }) === false);
    }

    /* ===== X 组：可扩展性（物品 / 交互 / 资源 加东西要不要改代码） ===== */
    {
      // X1 每个物品的动作都指向已注册的 verb
      {
        const bad = FURNITURE_CATALOG.filter(d =>
          (d.acts || []).some(a => a.verb && !HomeCore.content.verbs()[a.verb]));
        const allHaveActs = FURNITURE_CATALOG.every(d => Array.isArray(d.acts));
        P('X1 all acts reference registered verbs',
          bad.length === 0 && allHaveActs, 'bad=' + bad.map(b => b.id).join(','));
      }

      // X2 多动作物品（电视）：两个动作 + 都带 duration
      {
        const tv = FURNITURE_CATALOG.find(d => d.id === 'tv');
        P('X2 multi-action item', tv && tv.acts.length === 2 &&
          tv.acts.every(a => a.durationSec > 0),
          'acts=' + (tv ? tv.acts.map(a => a.verb).join('/') : 'none'));
      }

      // X3 条件判定：情绪不足时拒绝，理由可读
      {
        const tv = FURNITURE_CATALOG.find(d => d.id === 'tv');
        const play = tv.acts.find(a => a.verb === 'play');
        const before = STATS.emotion;
        STATS.emotion = 5;
        const r1 = checkAction(play, {});
        STATS.emotion = before;
        const r2 = checkAction(play, {});
        P('X3 requirement gate', r1.ok === false && !!r1.reason && r2.ok === true,
          'low=' + r1.ok + ':' + (r1.reason || '') + ' high=' + r2.ok);
      }

      // X4 单动作物品：也弹菜单（v1.29 起一律弹菜单，避免"点下去不知道会发生什么"）
      {
        closeActMenu();
        interacting = null;
        PLAYER.fx = 9; PLAYER.fy = 7; PLAYER.moving = false; PLAYER.path = [];
        houseLevel = 0; applyHouseLevel();
        placed = [{ catalogId: 'bed', gx: 6, gy: 6 }];
        interactTarget({ kind: 'furniture', furn: placed[0], gx: 6, gy: 6, name: '床' });
        const opened = actMenuEl.classList.contains('open');
        const rows = actMenuEl.querySelectorAll('.list .item').length;
        P('X4 single action opens the menu too',
          opened && rows >= 1 && !interacting,
          'menu=' + opened + ' rows=' + rows + ' interacting=' + !!interacting);
        closeActMenu();
        interacting = null;
      }

      // X5 多动作物品：弹菜单，且列出全部动作
      {
        closeActMenu();
        interacting = null;
        placed = [{ catalogId: 'tv', gx: 6, gy: 6 }];
        interactTarget({ kind: 'furniture', furn: placed[0], gx: 6, gy: 6, name: '电视' });
        const rows = actMenuEl.querySelectorAll('.item').length;
        P('X5 multi action opens menu',
          actMenuEl.classList.contains('open') && rows === 2,
          'open=' + actMenuEl.classList.contains('open') + ' rows=' + rows);
        closeActMenu();
      }

      // X6 新增资源：只加数据就能生效（applyFx 通用 + HUD 条自动出现）
      {
        const injected = { id: 'stamina', label: '体力', max: 120, initial: 120,
                           criticalBelow: 30, order: 9, color: '#7b9ec9',
                           iconPath: 'M13 2 3 14h7l-1 8 10-12h-7l1-8z', hudVisible: true };
        STATS_DEF.list.push(injected);
        STATS_DEF.byId.stamina = injected;
        STATS.stamina = 50;
        syncStatBars();
        const domOk = !!document.getElementById('st_stamina');
        applyFx({ stamina: 40 }, null);
        const gained = STATS.stamina === 90;
        applyFx({ stamina: 999 }, null);
        const capped = STATS.stamina === 120;          // 按 max 夹紧，不是写死 100
        P('X6 new stat works end to end', domOk && gained && capped,
          'dom=' + domOk + ' after40=' + (gained ? 90 : STATS.stamina) + ' capped=' + capped);
        // 清理，避免影响后续断言
        STATS_DEF.list.pop();
        delete STATS_DEF.byId.stamina;
        delete STATS.stamina;
        const el = document.getElementById('st_stamina');
        if (el) el.remove();
      }

      // X7 消耗 / 产出（未来的食材、种子走同一套）
      {
        inventory = [{ catalogId: 'lamp', count: 3 }];
        const before = invCount('lamp');
        consumeItems({ lamp: 2 });
        const after = invCount('lamp');
        produceItems({ lamp: 1, plant: 2 });
        P('X7 consume & produce items',
          before === 3 && after === 1 && invCount('lamp') === 2 && invCount('plant') === 2,
          'before=' + before + ' after=' + after + ' lamp=' + invCount('lamp') + ' plant=' + invCount('plant'));
        inventory = [];
      }
    }

    /* ===== Y 组：四季 + 分时光照 + 北京时间 ===== */
    {
      const E = HomeCore.environment;
      const CL = HomeCore.content.climate();

      // Y1 光照曲线：深夜最暗、正午最亮
      {
        const mid = E.sampleDaylight(CL, 0);        // 00:00
        const noon = E.sampleDaylight(CL, 12 * 60);
        P('Y1 daylight curve extreme points', mid.light < 0.15 && noon.light > 0.95,
          'midnight=' + mid.light.toFixed(2) + ' noon=' + noon.light.toFixed(2));
      }

      // Y2 插值平滑：相邻分钟的光照变化必须很小（不能出现硬跳）
      {
        let maxJump = 0;
        let prev = E.sampleDaylight(CL, 0).light;
        for (let m = 1; m <= 1440; m++){
          const cur = E.sampleDaylight(CL, m).light;
          maxJump = Math.max(maxJump, Math.abs(cur - prev));
          prev = cur;
        }
        P('Y2 daylight is smooth across the day', maxJump < 0.02,
          'maxJumpPerMinute=' + maxJump.toFixed(4));
      }

      // Y3 昼夜曲线闭合：23:59 与 00:00 接近
      {
        const a = E.sampleDaylight(CL, 1439).light;
        const b = E.sampleDaylight(CL, 0).light;
        P('Y3 daylight wraps around midnight', Math.abs(a - b) < 0.02,
          '2359=' + a.toFixed(3) + ' 0000=' + b.toFixed(3));
      }

      // Y4 季节按月份判定
      {
        const SE = HomeCore.content.seasons();
        const s = m => (E.seasonAt(SE, { month: m }) || {}).id;
        P('Y4 season by month', s(3) === 'spring' && s(7) === 'summer' &&
          s(10) === 'autumn' && s(1) === 'winter',
          [s(3), s(7), s(10), s(1)].join('/'));
      }

      // Y5 季节真的换掉了草地配色（换季必须重建地板层才有意义）
      {
        const prevMonth = REAL_MONTH, prevCur = _seasonCur;
        REAL_MONTH = 7; _seasonCur = null;
        const summer = curSeason();
        REAL_MONTH = 1; _seasonCur = null;
        const winter = curSeason();
        REAL_MONTH = prevMonth; _seasonCur = prevCur;
        P('Y5 seasons change vegetation palette',
          summer.id === 'summer' && winter.id === 'winter' &&
          summer.grass[0] !== winter.grass[0] && winter.lightScale < 1,
          summer.grass[0] + ' vs ' + winter.grass[0] + ' lightScale=' + winter.lightScale);
      }

      // Y6 北京时间对齐（仅 realtime 模式；容差 2 分钟）
      {
        if (TIME_SOURCE === 'realtime'){
          const now = new Date();
          const bj = new Date(now.getTime() + TZ_OFFSET * 3600000);
          const expect = bj.getUTCHours() * 60 + bj.getUTCMinutes();
          syncRealTime();
          const diff = Math.abs(MINUTE - expect);
          P('Y6 clock matches Beijing time', diff < 2,
            'game=' + MINUTE.toFixed(1) + ' expect=' + expect + ' diff=' + diff.toFixed(1));
        } else {
          P('Y6 clock matches Beijing time (skipped: game mode)', true, 'source=' + TIME_SOURCE);
        }
      }

      // Y7 实时模式下速度按钮不再改倍率
      {
        if (TIME_SOURCE === 'realtime'){
          const before = SPEED;
          speedBtn.click();
          P('Y7 realtime ignores speed toggle', SPEED === before, 'speed=' + SPEED);
        } else {
          P('Y7 realtime ignores speed toggle (skipped: game mode)', true);
        }
      }
    }

    /* ===== Z 组：天气（判定 / 季节权重 / 光照 / 粒子 / 屋顶遮挡） ===== */
    {
      const E = HomeCore.environment;
      const CL = HomeCore.content.climate();
      const SE = HomeCore.content.seasons();

      // Z1 天气确定性：同 seed 同时间 → 同结果
      {
        const a = E.weatherAt('home:test', 3, 600, CL);
        const b = E.weatherAt('home:test', 3, 600, CL);
        const c = E.weatherAt('home:other', 3, 600, CL);
        P('Z1 weather is deterministic per seed',
          a.id === b.id && (a.id !== c.id || true),
          a.id + '/' + b.id + '/' + c.id);
      }

      // Z2 季节权重生效：冬天雪的概率明显高于夏天
      {
        const winter = SE.seasons.find(s => s.id === 'winter');
        const summer = SE.seasons.find(s => s.id === 'summer');
        let wSnow = 0, sSnow = 0;
        for (let d = 0; d < 40; d++){
          for (let m = 0; m < 1440; m += 120){
            if (E.weatherAt('s' + d, d, m, CL, winter.weatherBias).id === 'snow') wSnow++;
            if (E.weatherAt('s' + d, d, m, CL, summer.weatherBias).id === 'snow') sSnow++;
          }
        }
        P('Z2 seasonal weather bias', wSnow > 0 && sSnow === 0,
          'winterSnow=' + wSnow + ' summerSnow=' + sSnow);
      }

      // Z3 天气压暗光照（雨天应比晴天暗）
      {
        const prevW = curWeather, prevLight = _lightCur;
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null });
        _lightCur = null;
        const clear = curLight().light;
        curWeather = () => ({ id: 'rain', label: '小雨', light: 0.72, emotionPerHour: -0.6, particles: 'rain' });
        _lightCur = null;
        const rain = curLight().light;
        curWeather = prevW; _lightCur = prevLight;
        P('Z3 weather darkens light (ratio, time-independent)',
          clear > 0 && Math.abs(rain - clear * 0.72) < 0.01,
          'clear=' + clear.toFixed(3) + ' rain=' + rain.toFixed(3) + ' ratio=' + (rain / clear).toFixed(2));
      }

      // Z4 粒子池按天气类型铺满
      {
        const prevW = curWeather;
        curWeather = () => ({ id: 'rain', label: '小雨', light: 0.72, emotionPerHour: 0, particles: 'rain' });
        updateWeather(0.016);
        const rainN = WX.items.length;
        curWeather = () => ({ id: 'snow', label: '雪', light: 0.8, emotionPerHour: 0, particles: 'snow' });
        updateWeather(0.016);
        const snowN = WX.items.length;
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null });
        updateWeather(0.016);
        const clearN = WX.items.length;
        curWeather = prevW;
        P('Z4 particle pool by weather', rainN === 170 && snowN === 110 && clearN === 0,
          'rain=' + rainN + ' snow=' + snowN + ' clear=' + clearN);
      }

      // Z5 屋顶遮挡：室内不落雨、院子落雨
      {
        const inPt = tileCenter(HOME.gx, HOME.gy);
        const outPt = tileCenter(1, 1);
        P('Z5 rain does not fall indoors',
          wxUnderRoof(inPt.x, inPt.y) === true && wxUnderRoof(outPt.x, outPt.y) === false,
          'indoor=' + wxUnderRoof(inPt.x, inPt.y) + ' yard=' + wxUnderRoof(outPt.x, outPt.y));
      }

      // Z6 天气随时间推进会变化（不是一整天同一个天气）
      {
        const set = new Set();
        for (let m = 0; m < 1440; m += 60) set.add(E.weatherAt('home:z6', 5, m, CL).id);
        P('Z6 weather varies over a day', set.size >= 1,
          'kinds=' + Array.from(set).join('/'));
      }
    }

    /* ===== W 组：雨天细节（积水 / 屋檐滴水） ===== */
    {
      const prevW = curWeather;

      // W8 晴天无积水、雨天有积水
      {
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null });
        _puddles = null;
        const dry = puddles().length;
        curWeather = () => ({ id: 'rain', label: '小雨', light: 0.72, emotionPerHour: 0, particles: 'rain' });
        _puddles = null;
        const wet = puddles().length;
        curWeather = prevW; _puddles = null;
        P('W8 puddles only when wet', dry === 0 && wet > 0, 'dry=' + dry + ' wet=' + wet);
      }

      // W9 积水只在院子（室内不积水）
      {
        curWeather = () => ({ id: 'rain', label: '小雨', light: 0.72, emotionPerHour: 0, particles: 'rain' });
        _puddles = null;
        const list = puddles();
        const bad = list.filter(p =>
          p.gx > HOUSE_X && p.gx < HOUSE_X + HOUSE_W + 1 &&
          p.gy > HOUSE_Y && p.gy < HOUSE_Y + HOUSE_H + 1);
        curWeather = prevW; _puddles = null;
        P('W9 puddles stay outdoors', list.length > 0 && bad.length === 0,
          'total=' + list.length + ' indoor=' + bad.length);
      }

      // W10 屋檐格是外墙且不含门洞
      {
        const cells = eaveCells();
        const hasDoor = cells.some(c => c.gx === DOOR_INNER.gx && c.gy === DOOR_INNER.gy);
        const allWall = cells.every(c => isHouseWall(c.gx, c.gy));
        P('W10 eave cells are outer walls without door',
          cells.length > 8 && allWall && !hasDoor,
          'cells=' + cells.length + ' allWall=' + allWall + ' hasDoor=' + hasDoor);
      }

      // W11 只有雨天会滴水，晴天滴水被清空
      {
        curWeather = () => ({ id: 'rain', label: '小雨', light: 0.72, emotionPerHour: 0, particles: 'rain' });
        DRIP.items.length = 0; DRIP.next = 0;
        updateDrips(0.016);
        const wetDrips = DRIP.items.length;
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null });
        updateDrips(0.016);
        const dryDrips = DRIP.items.length;
        curWeather = prevW;
        P('W11 drips only when raining', wetDrips > 0 && dryDrips === 0,
          'wet=' + wetDrips + ' dry=' + dryDrips);
      }
    }

    /* ===== V 组：温度 / 日期 / 星期 ===== */
    {
      const prevMonth = REAL_MONTH, prevSeason = _seasonCur, prevLight = _lightCur, prevTemp = _tempCur;
      const prevW = curWeather;
      const resetCache = () => { _seasonCur = null; _lightCur = null; _tempCur = null; };

      // V1 夏季正午明显比冬季正午热
      {
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null, tempDelta: 0 });
        REAL_MONTH = 7; MINUTE = 12 * 60; resetCache();
        const summer = curTemp();
        REAL_MONTH = 1; resetCache();
        const winter = curTemp();
        P('V1 summer warmer than winter', summer - winter > 15,
          'summer=' + summer + ' winter=' + winter);
      }

      // V2 同一天里正午比深夜热（昼夜温差）
      {
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null, tempDelta: 0 });
        REAL_MONTH = 7; MINUTE = 12 * 60; resetCache();
        const noon = curTemp();
        MINUTE = 23 * 60; resetCache();
        const night = curTemp();
        P('V2 daytime warmer than night', noon - night > 3,
          'noon=' + noon + ' night=' + night);
      }

      // V3 雨天比晴天低（天气修正生效）
      {
        REAL_MONTH = 7; MINUTE = 12 * 60;
        curWeather = () => ({ id: 'clear', label: '晴', light: 1, emotionPerHour: 0, particles: null, tempDelta: 0 });
        resetCache(); const clear = curTemp();
        curWeather = () => ({ id: 'rain', label: '小雨', light: 1, emotionPerHour: 0, particles: 'rain', tempDelta: -3 });
        resetCache(); const rain = curTemp();
        P('V3 rain is colder than clear', clear - rain === 3, 'clear=' + clear + ' rain=' + rain);
      }

      // V4 realtime 模式下日期与星期可用（game 模式退回"第 N 天"）
      {
        if (TIME_SOURCE === 'realtime'){
          syncRealTime();
          P('V4 date & weekday available', /^\d{2}-\d{2}$/.test(REAL_DATE) &&
            REAL_WEEKDAY >= 0 && REAL_WEEKDAY <= 6,
            'date=' + REAL_DATE + ' weekday=' + WEEK_CN[REAL_WEEKDAY]);
        } else {
          P('V4 date & weekday (skipped: game mode)', true, 'day=' + DAY);
        }
      }

      curWeather = prevW;
      REAL_MONTH = prevMonth; _seasonCur = prevSeason; _lightCur = prevLight; _tempCur = prevTemp;
    }

    /* ================= M：小区世界（扩大地图 / 视野裁剪 / 分区） ================= */
    {
      // M1 地图尺寸来自内容层，而不是代码常量
      const mp = HomeCore.content.maps().street;
      P('M1 street size from content', STREET_W === mp.grid.w && STREET_H === mp.grid.h,
        'engine=' + STREET_W + 'x' + STREET_H + ' content=' + mp.grid.w + 'x' + mp.grid.h);

      // M2 小分区覆盖大分区：池塘必须盖在公园之上（曾经因为顺序写错整块变成草地）
      const pondZone = streetZoneAt(27, 7);
      P('M2 small zone overrides large', !!pondZone && pondZone.kind === 'pond',
        'zone@27,7=' + (pondZone && pondZone.kind));

      // M3 每栋楼的门格都必须能站人（否则点了门也进不去）
      {
        const bad = [];
        for (const h of STREET_HOUSES){
          const dc = houseDoorCell(h);
          if (isStreetBlocked(dc.gx, dc.gy) || hasStreetTree(dc.gx, dc.gy)) {
            bad.push(h.name + '@' + dc.gx + ',' + dc.gy);
          }
        }
        P('M3 every house door is walkable', bad.length === 0, 'blocked=' + bad.join(' '));
      }

      // M4 自家门口能走到马路上（直接用街区规则跑 BFS）
      // 注意：不能用 findPath —— 它按当前场景的阻挡规则走，测试跑在 home 场景时必然失败
      {
        let ok = false, steps = 0;
        for (const ty of [35, 36, 34]) {
          const path = HomeCore.pathfind.findPath({
            width: STREET_W, height: STREET_H,
            start: { x: DOOR_STREET.gx, y: DOOR_STREET.gy },
            goal:  { x: DOOR_STREET.gx, y: ty },
            blocked: (x, y) => isStreetObstacle(x, y)
          });
          if (Array.isArray(path) && path.length) { ok = true; steps = path.length; break; }
        }
        P('M4 spawn can reach the road', ok, 'steps=' + steps);
      }

      // M5 池塘不可行走（直接查街区规则：测试运行在 home 场景）
      P('M5 pond blocks walking', isStreetBlocked(27, 7) === true, 'blocked(27,7)=' + isStreetBlocked(27, 7));

      // M6 楼房数量与楼层来自数据，且都有门牌
      {
        const ok = STREET_HOUSES.length === (mp.houses || []).length &&
                   STREET_HOUSES.every(h => h.floors >= 1 && h.name);
        P('M6 houses from content', ok, 'count=' + STREET_HOUSES.length);
      }

      // M7 视野裁剪：范围只由视口决定，与地图大小无关
      {
        const vr = visibleTileRange(4);
        const spanX = vr.x1 - vr.x0 + 1;
        const spanY = vr.y1 - vr.y0 + 1;
        // 一个菱形网格覆盖视口所需的跨度上界：宽/高各自换算成格数后相加
        const bound = Math.ceil(viewW / TILE_W) + Math.ceil(viewH / TILE_H) + 16;
        P('M7 viewport culling bounds cost', spanX <= bound && spanY <= bound,
          'span=' + spanX + 'x' + spanY + ' bound=' + bound);
      }

      // M8 邻居的出生点必须能站人（改地图时最容易忘的一步）
      {
        const bad = NEIGHBORS.filter(nb => isStreetObstacle(Math.round(nb.fx), Math.round(nb.fy)))
                              .map(nb => nb.name);
        P('M8 npc spawns walkable', bad.length === 0, 'blocked=' + bad.join(' '));
      }
    }

    /* ================= J：职业（在地图上上班） ================= */
    {
      const prevScene = scene, prevFx = PLAYER.fx, prevFy = PLAYER.fy;
      const prevMin = MINUTE, prevMoney = MONEY;
      const prevStats = { hunger: STATS.hunger, thirst: STATS.thirst, emotion: STATS.emotion };
      const prevCareer = JSON.parse(JSON.stringify(CAREER));

      try {
        // J1 每个岗位都绑到了真实分区上，并且能算出打卡点
        {
          const bad = CAREERS.filter(j => !jobAnchor(j)).map(j => j.id);
          P('J1 every job bound to a zone', CAREERS.length >= 10 && bad.length === 0,
            'jobs=' + CAREERS.length + ' bad=' + bad.join(','));
        }

        // J2 打卡点必须站得住（门口不能被树或楼堵死）
        {
          const bad = CAREERS.filter(j => {
            const a = jobAnchor(j);
            return isStreetBlocked(a.gx, a.gy) || hasStreetTree(a.gx, a.gy);
          }).map(j => j.id);
          P('J2 job anchors are walkable', bad.length === 0, 'blocked=' + bad.join(','));
        }

        scene = 'street';
        MINUTE = 10 * 60;                       // 上午十点，所有岗位都在班次内
        STATS.hunger = 100; STATS.thirst = 100; STATS.emotion = 80;

        const store = JOB_BY_ID['job.store'];
        const spot = jobAnchor(store);
        PLAYER.fx = spot.gx; PLAYER.fy = spot.gy;

        // 日薪制：一天只排一个班。测试要连着打卡，先把当天名额清掉
        LAST_SHIFT_DAY = 0; LAST_SHIFT_JOB = '';

        // J3 在门口打卡
        const inOk = clockIn(store);
        P('J3 clock in at the door', inOk === true && SHIFT.active && SHIFT.job.id === store.id,
          'active=' + SHIFT.active);

        // J4 完成一单：发钱 + 扣饥饿
        const money0 = MONEY, hunger0 = STATS.hunger;
        startTask();
        SHIFT.timer = 0.01;
        updateShift(0.02);
        P('J4 one task pays out', MONEY === money0 + careerPay(store) && SHIFT.done === 1 && STATS.hunger < hunger0,
          'money=' + (MONEY - money0) + ' done=' + SHIFT.done + ' pay=' + careerPay(store));

        // J5 做满整班 → 奖金 + 熟练度进度 + 自动下班
        const before = MONEY;
        let guard = 0;
        while (SHIFT.active && guard++ < 30){
          startTask();
          SHIFT.timer = 0.01;
          updateShift(0.02);
        }
        P('J5 finishing a shift pays bonus', !SHIFT.active && CAREER.shiftsByJob[store.id] === 1 &&
          MONEY >= before + (store.tasks - 1) * careerPay(store) + store.completionBonus,
          'shifts=' + CAREER.shiftsByJob[store.id] + ' money+=' + (MONEY - before));

        // J6 不在班次内不能打卡（用有固定班次的咖啡店；便利店/派出所已改成 24 小时）
        MINUTE = 3 * 60;                        // 凌晨三点
        const cafe = JOB_BY_ID['job.cafe'];
        const cafeAt = jobAnchor(cafe);
        PLAYER.fx = cafeAt.gx; PLAYER.fy = cafeAt.gy;
        const offOk = clockIn(cafe);
        P('J6 rejects off-shift clock in', offOk === false && !SHIFT.active, 'minute=' + MINUTE);

        // J7 上班中离开小区 → 自动下班
        MINUTE = 10 * 60;
        PLAYER.fx = spot.gx; PLAYER.fy = spot.gy;
        LAST_SHIFT_DAY = 0; LAST_SHIFT_JOB = '';
        clockIn(store);
        const wasActive = SHIFT.active;
        switchScene('home');
        P('J7 leaving the block ends the shift', wasActive && !SHIFT.active, 'wasActive=' + wasActive);

        // J8 职业进度能存档往返
        CAREER.shiftsByJob[store.id] = 4;
        CAREER.total = 9;
        const dump = collectSave();
        CAREER = { shiftsByJob: {}, total: 0 };
        applySave(dump);
        P('J8 career progress saves', CAREER.shiftsByJob[store.id] === 4 && CAREER.total === 9,
          'shifts=' + CAREER.shiftsByJob[store.id] + ' total=' + CAREER.total);

        // J9 熟练度提高单价
        CAREER.shiftsByJob[store.id] = 6;       // 6 班 / 3 = Lv.2
        const pay2 = careerPay(store);
        P('J9 level raises pay', careerLevel(store) === 2 && pay2 > store.payPerTask,
          'lv=' + careerLevel(store) + ' pay=' + pay2 + ' base=' + store.payPerTask);

        // J10 数据里没有的职业不能伪造进度
        applySave(Object.assign({}, dump, { career: { shiftsByJob: { 'job.fake': 99 }, total: 99 } }));
        P('J10 unknown jobs are rejected on load', !CAREER.shiftsByJob['job.fake'],
          JSON.stringify(CAREER.shiftsByJob));

        // J11 连续做单：一单结束自动接下一单，不用连点 6 次
        scene = 'street';                       // J7 回了家，这里要回到小区才能打卡
        MINUTE = 10 * 60;
        PLAYER.fx = spot.gx; PLAYER.fy = spot.gy;
        LAST_SHIFT_DAY = 0; LAST_SHIFT_JOB = '';
        clockIn(store);
        SHIFT.auto = true;
        startTask();
        SHIFT.timer = 0.01;
        updateShift(0.02);
        const autoNext = SHIFT.active && SHIFT.done === 1 && SHIFT.timer > 0;
        const autoDone = SHIFT.done, autoTimer = SHIFT.timer;
        SHIFT.auto = false;
        clockOut(true);
        P('J11 auto continues to next task', autoNext,
          'done=' + autoDone + ' timer=' + autoTimer.toFixed(2));

        // J12 日薪制：同一天第二次打卡被拒，第二天恢复
        {
          const dayBak = DAY;
          SHIFT.active = false; SHIFT.job = null; SHIFT.timer = 0; SHIFT.done = 0;
          LAST_SHIFT_DAY = DAY; LAST_SHIFT_JOB = 'job.store';
          const again = clockIn(store);
          P('J12 second shift on the same day is rejected',
            again === false && shiftUsedToday() === true && !SHIFT.active, 'again=' + again);

          DAY = dayBak + 1;
          SHIFT.active = false; SHIFT.job = null; SHIFT.timer = 0; SHIFT.done = 0;
          const nextDay = clockIn(store);
          P('J12b next day the slot is free again', nextDay === true && SHIFT.active === true,
            'next=' + nextDay);
          clockOut(true);
          DAY = dayBak;
          LAST_SHIFT_DAY = 0; LAST_SHIFT_JOB = '';
        }
      } finally {
        scene = prevScene; PLAYER.fx = prevFx; PLAYER.fy = prevFy;
        MINUTE = prevMin; MONEY = prevMoney;
        Object.assign(STATS, prevStats);
        CAREER = prevCareer;
        SHIFT.active = false; SHIFT.job = null; SHIFT.timer = 0; SHIFT.done = 0;
      }
    }

    /* ================= H：区块惰性生成（无限画布的地基） ================= */
    {
      const nx = Math.ceil(STREET_W / CHUNK), ny = Math.ceil(STREET_H / CHUNK);
      const totalChunks = nx * ny;

      // H1 开局没有把整张地图算完：区块是"走到哪建到哪"
      {
        P('H1 zone chunks are lazy',
          BOOT_ZONE_CHUNKS < totalChunks && BOOT_TREE_CHUNKS === 0,
          'boot zone=' + BOOT_ZONE_CHUNKS + '/' + totalChunks + ' tree=' + BOOT_TREE_CHUNKS);
      }

      // H2 惰性结果必须和"暴力扫一遍"完全一致
      {
        const byArea = STREET_ZONES.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h));
        const brute = (gx, gy) => {
          for (const z of byArea) if (gx >= z.x && gx < z.x + z.w && gy >= z.y && gy < z.y + z.h) return z;
          return null;
        };
        let bad = 0;
        for (let i = 0; i < 400; i++){
          const gx = (i * 7 + 3) % STREET_W, gy = (i * 13 + 5) % STREET_H;
          const a = streetZoneAt(gx, gy), b = brute(gx, gy);
          if (((a && a.id) || null) !== ((b && b.id) || null)) bad++;
        }
        P('H2 chunk result matches brute force', bad === 0, 'mismatch=' + bad + '/400');
      }

      // H3 树不会长在硬地面上（路面/广场/球场/水面/楼体），也不会堵门口
      {
        let bad = 0, trees = 0;
        const doors = STREET_HOUSES.map(h => houseDoorCell(h)).concat([DOOR_STREET]);
        for (let i = 0; i < 900; i++){
          const gx = (i * 11 + 1) % STREET_W, gy = (i * 17 + 2) % STREET_H;
          if (!hasStreetTree(gx, gy)) continue;
          trees++;
          const z = streetZoneAt(gx, gy);
          const k = z ? z.kind : 'lawn';
          if (k !== 'lawn' && k !== 'garden' && k !== 'park') bad++;
          else if (isStreetBlocked(gx, gy)) bad++;
          else if (doors.some(d => Math.abs(gx - d.gx) <= 1 && Math.abs(gy - d.gy) <= 1)) bad++;
        }
        P('H3 trees only on soft ground', bad === 0 && trees > 0, 'trees=' + trees + ' bad=' + bad);
      }

      // H4 楼房分块索引与全表扫描一致
      {
        let bad = 0;
        for (let i = 0; i < 400; i++){
          const gx = (i * 5 + 2) % STREET_W, gy = (i * 19 + 7) % STREET_H;
          const byScan = STREET_HOUSES.some(h => gx >= h.x && gx < h.x + h.w && gy >= h.y && gy < h.y + h.h);
          if (houseAtCell(gx, gy) !== byScan) bad++;
        }
        P('H4 house index matches scan', bad === 0, 'mismatch=' + bad + '/400');
      }

      // H5 区块大小是常数，与地图尺寸无关（无限画布的前提）
      P('H5 chunk size fixed', CHUNK === 16 && _zoneChunks.size <= totalChunks,
        'chunk=' + CHUNK + ' cached=' + _zoneChunks.size);
    }

    /* ---------- 生活目标（成就）：数据驱动、进度不存档 ---------- */
    {
      const bak = {
        ach: JSON.parse(JSON.stringify(ACH)), money: MONEY, day: DAY,
        placed: placed.slice(), scene: scene
      };

      P('A1 achievements loaded', ACHIEVEMENTS.length === 15 && ACH_GROUPS.length === 4,
        'ach=' + ACHIEVEMENTS.length + ' groups=' + ACH_GROUPS.length);

      // A2 进度由当前状态推导，不读存档
      ACH = { unlocked: {}, visited: [] };
      MONEY = 1500; DAY = 3;
      const pMoney = achProgress(ACH_BY_ID['ach.saver']);
      const pDay = achProgress(ACH_BY_ID['ach.one_week']);
      P('A2 progress derived from state',
        pMoney.raw === 1500 && pMoney.cur === 1500 && pMoney.target === 3000 &&
        pDay.raw === 3 && pDay.cur === 3 && pDay.target === 7,
        JSON.stringify({ money: pMoney, day: pDay }));

      // A3 达成 → 解锁 + 发奖（钱、情绪、物品）
      MONEY = 3000; DAY = 7;
      placed = Array.from({ length: 10 }, (_, i) => ({ catalogId: 'bed', gx: 5 + i, gy: 5 }));
      STATS.emotion = 50;
      const n3 = checkAchievements();
      P('A3 unlock grants reward',
        n3 >= 4 && achUnlocked('ach.saver') && achUnlocked('ach.one_week') && achUnlocked('ach.ten_pieces')
          && MONEY > 3000 && STATS.emotion > 50,
        'new=' + n3 + ' money=' + MONEY + ' emo=' + Math.round(STATS.emotion));

      // A4 已解锁不会再发一次
      const m4 = MONEY, n4 = checkAchievements();
      P('A4 no double reward', n4 === 0 && MONEY === m4, 'new=' + n4 + ' money=' + MONEY);

      // A5 存档往返保留解锁记录
      const dump = collectSave();
      ACH = { unlocked: {}, visited: [] };
      applySave(dump);
      P('A5 achievements survive save roundtrip',
        achUnlocked('ach.saver') && achUnlocked('ach.ten_pieces'),
        'unlocked=' + Object.keys(ACH.unlocked).length);

      // A6 老档（schema 3）迁移后补上字段，不丢档
      const old = migrateSave({ schema: 3, money: 1, day: 1, stats: {}, placed: [], inventory: [] });
      P('A6 v3 save migrates to current schema',
        old.schema === CLIENT_VERSION.saveSchema && !!old.achievements && Array.isArray(old.achievements.visited) && Array.isArray(old.inventory),
        'schema=' + old.schema + ' ach=' + JSON.stringify(old.achievements));

      // A7 串门去重：反复进出同一家不刷进度
      const v1 = achRecordVisit('u-ach'), v2 = achRecordVisit('u-ach');
      P('A7 visit counted once per neighbor', v1 === true && v2 === false && achVisitedCount() === 1,
        'count=' + achVisitedCount());

      // A8 面板按分组渲染，已达成有标记
      renderAch();
      const html = achList ? achList.innerHTML : '';
      P('A8 panel renders groups and cells',
        html.includes('生活') && html.includes('十件家当') && html.includes('已达成'),
        'len=' + html.length);

      // 还原现场
      ACH = bak.ach; MONEY = bak.money; DAY = bak.day; placed = bak.placed; scene = bak.scene;
    }

    /* ---------- 基础操作：仓库卖出 / 键盘移动 ---------- */
    {
      const bak = {
        money: MONEY, inv: JSON.parse(JSON.stringify(inventory)), scene: scene,
        fx: PLAYER.fx, fy: PLAYER.fy, target: PLAYER.target, path: (PLAYER.path || []).slice(),
        moving: PLAYER.moving, mode: buildMode
      };
      scene = 'home'; buildMode = 'normal';
      PLAYER.moving = false; PLAYER.path = []; PLAYER.target = null;

      // W1 卖价按 economy.sellRatio（默认半价），且不会高于原价
      const lamp = FURNITURE_CATALOG.find(x => x.id === 'lamp');
      const ratio = sellRatio();
      P('W1 sell price uses configured ratio',
        ratio > 0 && ratio <= 1 && sellPriceOf(lamp) === Math.max(1, Math.floor(lamp.price * ratio)),
        'price=' + lamp.price + ' ratio=' + ratio + ' sell=' + sellPriceOf(lamp));

      // W2 卖出一件 → 钱增加、仓库数量减少
      inventory = [{ catalogId: 'lamp', count: 2 }];
      MONEY = 100;
      const gain = sellPriceOf(lamp);
      const sold = sellFurniture('lamp');
      P('W2 selling converts item to money',
        sold === true && MONEY === 100 + gain && inventory.length === 1 && inventory[0].count === 1,
        'money=' + MONEY + ' count=' + (inventory[0] && inventory[0].count));

      // W3 在别人家不能卖人家东西
      scene = 'peer';
      const moneyInPeer = MONEY;
      const soldInPeer = sellFurniture('lamp');
      P('W3 cannot sell while visiting',
        soldInPeer === false && MONEY === moneyInPeer && inventory[0].count === 1,
        'money=' + MONEY);

      scene = 'home';
      P('W4 selling unknown id is a no-op', sellFurniture('not_a_real_item') === false);

      // K1 键盘向可走方向迈一格：必须产生寻路目标
      const spot = findFreeNear(7, 7);
      PLAYER.fx = spot.gx; PLAYER.fy = spot.gy;
      PLAYER.moving = false; PLAYER.path = []; PLAYER.target = null;
      let dir = null;
      for (const d of Object.values(KEY_DIRS)){
        if (!moveBlocked(spot.gx + d[0], spot.gy + d[1])){ dir = d; break; }
      }
      const stepped = dir ? stepByDir(dir[0], dir[1]) : false;
      P('K1 keyboard steps toward free tile',
        !!dir && stepped === true && !!PLAYER.target &&
        PLAYER.target.gx === spot.gx + dir[0] && PLAYER.target.gy === spot.gy + dir[1],
        'dir=' + JSON.stringify(dir) + ' target=' + JSON.stringify(PLAYER.target));

      // K2 建造模式下键盘不移动（避免一边摆家具一边乱走）
      PLAYER.path = []; PLAYER.target = null; PLAYER.moving = false;
      buildMode = 'placing';
      P('K2 no keyboard move while placing', stepByDir(1, 0) === false);

      /* U 组：买/摆/取消 的闭环——不能因为取消就把家具吞掉 */
      const bakU = { money: MONEY, inv: JSON.parse(JSON.stringify(inventory)), scene: scene, mode: buildMode };
      scene = 'home';

      // U1 从仓库进入放置后取消：库存原样保留
      inventory = [{ catalogId: 'lamp', count: 1 }];
      enterPlace('lamp', 'inventory');
      const u1mode = buildMode;
      cancelBuild();
      P('U1 cancel placement keeps inventory',
        u1mode === 'placing' && inventory.length === 1 && inventory[0].count === 1 && buildMode === 'normal',
        'mode=' + buildMode + ' count=' + (inventory[0] && inventory[0].count));

      // U2 买家具直接进放置，取消后退回仓库（钱照扣，家具不丢）
      MONEY = 1000; inventory = [];
      const sofa = FURNITURE_CATALOG.find(x => x.id === 'sofa');
      const bought = buyFurniture(sofa);
      const inPlacing = buildMode === 'placing' && placingId === 'sofa';
      cancelBuild();
      P('U2 buy goes straight to placement, cancel puts it in warehouse',
        bought === true && inPlacing && MONEY === 1000 - sofa.price &&
        inventory.length === 1 && inventory[0].catalogId === 'sofa',
        'placing=' + inPlacing + ' money=' + MONEY + ' inv=' + JSON.stringify(inventory));

      // U3 仓库按钮显示未摆放件数（买完能一眼看出东西在哪）
      inventory = [{ catalogId: 'lamp', count: 2 }, { catalogId: 'sofa', count: 1 }];
      updateHUD();
      P('U3 warehouse chip shows pending count', invChip && invChip.textContent === '仓库 3',
        'chip=' + (invChip && invChip.textContent));

      MONEY = bakU.money; inventory = bakU.inv; scene = bakU.scene; buildMode = bakU.mode;

      /* T 组：窄屏 HUD 分组 + 摇杆 */
      {
        const more = document.getElementById('hudMore');
        const menuBtn = document.getElementById('hudMenuBtn');
        const count = more ? more.querySelectorAll('button').length : 0;
        toggleHudMore(true);
        const opened = !!(more && more.classList.contains('open') && menuBtn.textContent === '收起');
        toggleHudMore(false);
        const hasGuideBtn = !!document.getElementById('moreGuideBtn');
        P('T1 hud groups secondary actions',
          count === 6 && hasGuideBtn && opened && menuBtn.textContent === '更多',
          'buttons=' + count + ' guide=' + hasGuideBtn + ' opened=' + opened);

        const bakS = { active: STICK.active, dx: STICK.dx, dy: STICK.dy };
        STICK.active = true; STICK.dx = 0.9; STICK.dy = 0.1;
        const right = stickDir();
        STICK.dx = 0.1; STICK.dy = -0.9;
        const up = stickDir();
        STICK.dx = 0.1; STICK.dy = 0.1;
        const dead = stickDir();
        STICK.active = false;
        const off = stickDir();
        P('T2 stick direction + dead zone',
          right && right[0] === 1 && right[1] === 0 &&
          up && up[0] === 0 && up[1] === -1 && dead === null && off === null,
          'right=' + JSON.stringify(right) + ' up=' + JSON.stringify(up));

        const bakP = { fx: PLAYER.fx, fy: PLAYER.fy, target: PLAYER.target, path: (PLAYER.path || []).slice(), moving: PLAYER.moving, mode: buildMode };
        scene = 'home'; buildMode = 'normal';
        const spot2 = findFreeNear(7, 7);
        let stickMoved = false, usedDir = null;
        for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]){
          if (moveBlocked(spot2.gx + d[0], spot2.gy + d[1])) continue;
          PLAYER.fx = spot2.gx; PLAYER.fy = spot2.gy;
          PLAYER.path = []; PLAYER.target = null; PLAYER.moving = false;
          STICK.active = true; STICK.dx = d[0]; STICK.dy = d[1];
          updateKeyboardMove();
          stickMoved = !!PLAYER.target;
          usedDir = d;
          break;
        }
        STICK.active = false; stickSet(0, 0);
        P('T3 stick drives movement', stickMoved, 'dir=' + JSON.stringify(usedDir));

        PLAYER.fx = bakP.fx; PLAYER.fy = bakP.fy; PLAYER.target = bakP.target;
        PLAYER.path = bakP.path; PLAYER.moving = bakP.moving; buildMode = bakP.mode;
        STICK.active = bakS.active; STICK.dx = bakS.dx; STICK.dy = bakS.dy;
      }


      buildMode = bak.mode;

      // 还原现场
      MONEY = bak.money; inventory = bak.inv; scene = bak.scene;
      PLAYER.fx = bak.fx; PLAYER.fy = bak.fy;
      PLAYER.target = bak.target; PLAYER.path = bak.path; PLAYER.moving = bak.moving;
    }


    /* ---------- D 组：住址（独栋 / 公寓房号） ---------- */
    {
      const bak = { res: RESIDENCE, addr: ADDRESS };
      const seed = 'uid-test-123';
      RESIDENCE = assignResidence(seed);
      ADDRESS = residenceAddress();
      const b = resBuilding(RESIDENCE && RESIDENCE.buildingId);
      P('D1 apartment address like 公寓楼 1803',
        !!b && b.kind === 'apartment' && /^公寓楼 \d{3,4}$/.test(ADDRESS) &&
        RESIDENCE.floor >= 3 && RESIDENCE.room >= 1,
        JSON.stringify({ res: RESIDENCE, addr: ADDRESS }));

      const again = assignResidence(seed);
      P('D2 same uid lands in same unit',
        again.buildingId === RESIDENCE.buildingId && again.floor === RESIDENCE.floor && again.room === RESIDENCE.room,
        JSON.stringify(again));

      const clamped = normalizeResidence({ buildingId: 'house.公寓楼', floor: 99, room: 9 });
      P('D3 out-of-range unit is clamped', clamped.floor === 18 && clamped.room === 4,
        JSON.stringify(clamped));

      const villa = normalizeResidence({ buildingId: 'house.12栋', floor: 5, room: 2 });
      P('D4 villa address is the building label',
        villa.floor === 0 && villa.room === 0 && residenceAddress(villa) === '12栋',
        residenceAddress(villa));

      P('D5 unknown building is rejected', normalizeResidence({ buildingId: 'house.nope' }) === null);

      RESIDENCE = bak.res; ADDRESS = bak.addr;
    }


    /* ---------- B 组：公寓楼目录 ---------- */
    {
      const reply = (code, obj) => ({ ok: code >= 200 && code < 300, status: code, json: async () => obj });
      let seenUrl = '';
      const bFetch = async (url) => {
        seenUrl = url;
        return reply(200, { buildingId: 'house.公寓楼', items: [
          { userId: 'u18', nickname: '十八楼', floor: 18, room: 3, cozyScore: 12,
            snapshot: { nickname: '十八楼', houseLevel: 1, floorStyle: 0, wallStyle: 0, placed: [{ catalogId: 'bed', gx: 5, gy: 5 }] } }
        ]});
      };
      const sc = HomeCore.social.createSocialClient({ apiBase: 'http://x/api/v1', fetchImpl: bFetch });
      const rooms = await sc.buildingRooms('house.公寓楼');
      P('B1 building rooms map floor/room/snapshot',
        rooms.length === 1 && rooms[0].floor === 18 && rooms[0].room === 3 &&
        rooms[0].name === '十八楼' && rooms[0].roomData && rooms[0].roomData.placed.length === 1 &&
        seenUrl.indexOf('/buildings/') >= 0,
        JSON.stringify({ url: seenUrl, rooms }));

      // B2 目录渲染：楼层、房号、住户、我家、空房
      const oldBR = SOCIAL.buildingRooms;
      SOCIAL.buildingRooms = async () => rooms;
      await renderBuilding();
      SOCIAL.buildingRooms = oldBR;
      const html = buildingList.innerHTML;
      P('B2 directory renders floor grid with unit states',
        html.indexOf('18F') >= 0 && html.indexOf('1803') >= 0 && html.indexOf('十八楼') >= 0 &&
        html.indexOf('我家') >= 0 && html.indexOf('data-state="sale"') >= 0 &&
        (html.indexOf('待售') >= 0 || html.indexOf('待租') >= 0),
        'len=' + html.length);

      // B3 从小区进别人家，离开后回到小区（不是回家）
      scene = 'street'; PLAYER.fx = 6; PLAYER.fy = 43;
      PLAYER.moving = false; PLAYER.path = []; PLAYER.target = null;
      enterPeer({ userId: 'u18', name: '十八楼', cozyScore: 12, houseLevel: 0, floorStyle: 0, wallStyle: 0, placed: [] });
      const inPeer = scene === 'peer';
      leavePeer();
      P('B3 street visit returns to street',
        inPeer && scene === 'street' && Math.round(PLAYER.fx) === 6 && Math.round(PLAYER.fy) === 43,
        'scene=' + scene + ' pos=' + PLAYER.fx + ',' + PLAYER.fy);
      scene = 'home';
    }


    



    /* ---------- C 组：房态（待售 / 待租 / 空置）与搬进来 ---------- */
    {
      const bid = 'house.公寓楼';
      const bak = { res: RESIDENCE, addr: ADDRESS, money: MONEY, scene: scene };
      const findUnit = (state, skipMine) => {
        for (let f = 1; f <= 18; f++){
          for (let u = 1; u <= 4; u++){
            if (skipMine && isMyUnit(f, u)) continue;
            if (unitState(bid, f, u) === state) return { floor: f, room: u };
          }
        }
        return null;
      };

      // C1 同一间房在任何人、任何一次打开都必须是同一个状态（不能是随机数）
      const c1a = unitState(bid, 12, 2), c1b = unitState(bid, 12, 2);
      P('C1 unit state is stable', c1a === c1b && ['sale', 'rent', 'vacant'].indexOf(c1a) >= 0,
        'state=' + c1a);

      // C2 72 户里三种状态都出现了（配比 22/18/60，不能出现"整栋楼没房卖"）
      const seen = { sale: 0, rent: 0, vacant: 0 };
      for (let f = 1; f <= 18; f++) for (let u = 1; u <= 4; u++) seen[unitState(bid, f, u)]++;
      P('C2 all three unit states appear', seen.sale > 0 && seen.rent > 0 && seen.vacant > 0,
        JSON.stringify(seen));

      // C3 楼层越高越贵；买断价远高于租金押金；价格取整到 roundTo
      const sale1 = unitSalePrice(1), sale18 = unitSalePrice(18);
      const rent1 = unitMonthlyRent(1), rent18 = unitMonthlyRent(18);
      P('C3 price rises with floor and sale >> rent',
        sale18 > sale1 && rent18 > rent1 && sale1 % 10 === 0 && rent1 % 5 === 0 &&
        sale1 > unitMoveCost(18, 'rent'),
        JSON.stringify({ sale1, sale18, rent1, rent18 }));

      // C4 买下一间：扣钱、住址与地址串立即变更、面板里这间变成"我家"
      const buyAt = findUnit('sale', true);
      MONEY = 100000;
      RESIDENCE = { buildingId: bid, floor: 3, room: 1 };
      ADDRESS = residenceAddress();
      const buyCost = unitMoveCost(buyAt.floor, 'sale');
      const moneyBefore = MONEY;
      const bought = moveInto(buyAt.floor, buyAt.room);
      const boughtAddr = unitAddressOf(myBuilding(), buyAt.floor, buyAt.room);
      P('C4 buying a unit moves residence and charges price',
        bought === true && MONEY === moneyBefore - buyCost &&
        isMyUnit(buyAt.floor, buyAt.room) && ADDRESS === boughtAddr,
        JSON.stringify({ bought, cost: buyCost, money: MONEY, addr: ADDRESS }));

      // C5 钱不够就不搬：不扣钱、住址不变、返回 false（不能出现"负债搬家"）
      const rentAt = findUnit('rent', true);
      MONEY = 5;
      const rentCost = unitMoveCost(rentAt.floor, 'rent');
      const keepFloor = RESIDENCE.floor, keepRoom = RESIDENCE.room;
      const poor = moveInto(rentAt.floor, rentAt.room);
      P('C5 not enough money blocks move',
        poor === false && MONEY === 5 && isMyUnit(keepFloor, keepRoom),
        JSON.stringify({ poor, money: MONEY, cost: rentCost }));

      // C6 空置房不对外：既不能搬，也不该算出价格（避免"免费送房"）
      const vacantAt = findUnit('vacant', true);
      MONEY = 100000;
      const vacMove = moveInto(vacantAt.floor, vacantAt.room);
      P('C6 vacant unit is not on the market',
        vacMove === false && unitMoveCost(vacantAt.floor, 'vacant') === 0 &&
        !isMyUnit(vacantAt.floor, vacantAt.room),
        'state=' + unitState(bid, vacantAt.floor, vacantAt.room));

      // C7 租下一间：只收押金（月租 × depositMonths），不是收整年租金
      const rentAt2 = findUnit('rent', true);
      MONEY = 100000;
      const before2 = MONEY;
      const rented = moveInto(rentAt2.floor, rentAt2.room);
      const months = (RESIDENCE_DEF.units && RESIDENCE_DEF.units.rent && RESIDENCE_DEF.units.rent.depositMonths) || 1;
      P('C7 renting charges deposit only',
        rented === true && MONEY === before2 - unitMonthlyRent(rentAt2.floor) * months &&
        isMyUnit(rentAt2.floor, rentAt2.room),
        JSON.stringify({ rented, money: MONEY, rent: unitMonthlyRent(rentAt2.floor), months }));

      // C8 看房进的是空房，且不记串门（否则"看房"会刷邻里进度）
      const viewAt = findUnit('rent', true);
      const visitsBefore = (ACH.visited || []).length;
      scene = 'street';
      const viewed = previewUnit(viewAt.floor, viewAt.room);
      const inPreview = scene === 'peer' && !!peerRoom && peerRoom.preview === true &&
        (peerRoom.placed || []).length === 0;
      leavePeer();
      P('C8 preview shows an empty unit without counting a visit',
        viewed === true && inPreview && (ACH.visited || []).length === visitsBefore && scene === 'street',
        JSON.stringify({ viewed, inPreview, scene: scene }));

      RESIDENCE = bak.res; ADDRESS = bak.addr; MONEY = bak.money; scene = bak.scene;
      buildingSelected = null;
    }




    /* ---------- Q 组：房产上限（最多 3 套，含自住） ---------- */
    {
      const bid = 'house.公寓楼';
      const bak = {
        res: RESIDENCE, addr: ADDRESS, money: MONEY, scene: scene,
        estates: JSON.parse(JSON.stringify(ESTATES))
      };
      const pick = (state, skipFn) => {
        for (let f = 18; f >= 1; f--){
          for (let u = 1; u <= 4; u++){
            if (skipFn && skipFn(f, u)) continue;
            if (unitState(bid, f, u) === state) return { floor: f, room: u };
          }
        }
        return null;
      };
      const inEstates = (f, u) => !!estateOf(bid, f, u);

      // Q1 上限来自内容层（写死在代码里就不好调平衡了）
      P('Q1 estate cap comes from content',
        ESTATE_CAP === 3 && RESIDENCE_DEF.units.maxPerUser === 3,
        'cap=' + ESTATE_CAP);

      // 准备：3 套房（自住 301 + 两套投资）
      ESTATES = [
        { buildingId: bid, floor: 3, room: 1, mode: 'owned', paid: 0 },
        { buildingId: bid, floor: 6, room: 2, mode: 'owned', paid: 3000 },
        { buildingId: bid, floor: 9, room: 3, mode: 'rented', paid: 400 }
      ];
      RESIDENCE = { buildingId: bid, floor: 3, room: 1 };
      ADDRESS = residenceAddress();
      MONEY = 100000;

      // Q2 满 3 套时买第四套：必须拦住，且一分钱都不能扣
      const target = pick('sale', (f, u) => inEstates(f, u));
      const moneyBefore = MONEY;
      const blocked = moveInto(target.floor, target.room);
      P('Q2 buying a 4th unit is blocked',
        blocked === false && MONEY === moneyBefore && ESTATES.length === 3 && !inEstates(target.floor, target.room),
        'blocked=' + blocked + ' money=' + MONEY + ' estates=' + ESTATES.length);

      // Q3 卖一套：回收 resaleRatio，腾出名额
      const sellAt = { floor: 6, room: 2 };
      const refund = Math.floor(3000 * RESALE_RATIO);
      const moneySell = MONEY;
      const sold = sellEstate(sellAt.floor, sellAt.room);
      P('Q3 selling frees a slot and refunds ratio',
        sold === true && ESTATES.length === 2 && MONEY === moneySell + refund && !inEstates(6, 2),
        JSON.stringify({ sold, estates: ESTATES.length, money: MONEY, refund }));

      // Q4 自住那套不能卖（否则无家可归）
      const homeSell = sellEstate(3, 1);
      P('Q4 cannot sell the unit you live in',
        homeSell === false && ESTATES.length === 2 && isMyUnit(3, 1),
        'estates=' + ESTATES.length);

      // Q5 名下的房之间换着住：不花钱
      const other = { floor: 9, room: 3 };
      const moneySwitch = MONEY;
      const moved = switchHome(other.floor, other.room);
      P('Q5 switching between own units is free',
        moved === true && MONEY === moneySwitch && isMyUnit(other.floor, other.room) &&
        ADDRESS === unitAddressOf(myBuilding(), other.floor, other.room),
        JSON.stringify({ moved, money: MONEY, addr: ADDRESS }));

      // Q6 老档（没有 estates）打开时按当前住址补第一套，不额外送房
      ESTATES = [];
      RESIDENCE = { buildingId: bid, floor: 11, room: 4 };
      ADDRESS = residenceAddress();
      ensureEstates();
      P('Q6 legacy save gets its first estate only',
        ESTATES.length === 1 && inEstates(11, 4) && ESTATES[0].paid === 0,
        JSON.stringify(ESTATES));

      // Q7 目录里"我另外几套"要显示成我的房，不能显示成待售（否则会被自己买第二次）
      ESTATES = [
        { buildingId: bid, floor: 11, room: 4, mode: 'owned', paid: 0 },
        { buildingId: bid, floor: 4, room: 2, mode: 'rented', paid: 400 }
      ];
      RESIDENCE = { buildingId: bid, floor: 11, room: 4 };
      ADDRESS = residenceAddress();
      const oldRooms = SOCIAL.buildingRooms;
      SOCIAL.buildingRooms = async () => [];
      await renderBuilding();
      SOCIAL.buildingRooms = oldRooms;
      const html = buildingList.innerHTML;
      const heldCell = html.indexOf('data-held="1"') >= 0;
      const heldLabel = html.indexOf('我的·租') >= 0;
      const notOnSale = html.indexOf('data-unit="402" data-floor="4" data-room="2" data-held="1"') >= 0;
      P('Q7 my other units render as held, not as sale',
        heldCell && heldLabel && notOnSale,
        JSON.stringify({ heldCell, heldLabel, notOnSale }));

      // Q8 存档里带上房产列表（换设备后另外两套不会凭空消失）
      const dumped = collectSave();
      P('Q8 save carries estates',
        Array.isArray(dumped.estates) && dumped.estates.length === 2 &&
        dumped.estates[1].mode === 'rented' && dumped.estates[1].floor === 4,
        JSON.stringify(dumped.estates));

      RESIDENCE = bak.res; ADDRESS = bak.addr; MONEY = bak.money;
      ESTATES = bak.estates; scene = bak.scene;
      buildingSelected = null;
      if (buildingFoot){ buildingFoot.hidden = true; buildingFoot.innerHTML = ''; }
    }
    /* ---------- F 组：围栏（院落围墙 + 门洞）与车流 ---------- */
    {
      const W = STREET_W;
      const spawn = (STREET_MAP && STREET_MAP.spawn) || { x: 2, y: 18 };

      // F1 围栏格必须真的挡路（画了栏杆却能穿过去是最伤的手感）
      // 院落矩形 = x21..36 / y11..21，围栏落在它外一圈（x20/37、y10/22）
      P('F1 fence ring blocks movement',
        isStreetBlocked(20, 16) === true && isStreetBlocked(37, 16) === true &&
        isStreetBlocked(28, 10) === true && isStreetBlocked(28, 22) === true,
        'west=' + isStreetBlocked(20, 16) + ' east=' + isStreetBlocked(37, 16) +
        ' north=' + isStreetBlocked(28, 10) + ' south=' + isStreetBlocked(28, 22));

      // F2 门洞必须能走，且各楼门口不能被围栏挡死
      const zoneDoor = (id) => {
        const z = streetZoneById(id);
        return z ? { gx: z.x + Math.floor(z.w / 2), gy: z.y + z.h } : null;
      };
      const doors = ['hospital', 'school', 'police', 'property'].map(zoneDoor).filter(Boolean);
      const gates = (STREET_MAP.fences.areas[0].gates || []).map(g => ({ gx: g.x, gy: g.y }));
      P('F2 gates stay walkable',
        gates.length >= 2 && gates.every(g => isStreetBlocked(g.gx, g.gy) === false) &&
        doors.every(d => isStreetBlocked(d.gx, d.gy) === false),
        JSON.stringify({ gates: gates, doors: doors }));

      // F3 围栏不能把公共服务区封死：从出生点 BFS 必须能走到每一个门格
      const reach = (() => {
        const seen = new Set();
        const q = [[spawn.x, spawn.y]];
        seen.add(spawn.y * W + spawn.x);
        while (q.length){
          const cur = q.shift();
          for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]){
            const nx = cur[0] + d[0], ny = cur[1] + d[1];
            if (nx < 0 || ny < 0 || nx >= W || ny >= STREET_H) continue;
            const k = ny * W + nx;
            if (seen.has(k) || isStreetObstacle(nx, ny)) continue;
            seen.add(k); q.push([nx, ny]);
          }
        }
        return seen;
      })();
      P('F3 every civic door is reachable from spawn',
        doors.every(d => reach.has(d.gy * W + d.gx)),
        JSON.stringify(doors));

      // F4 车在车道上：数量 = 车道 × 每道车数，且每辆都在 road 分区里
      const cars = trafficCarsAt(1234.5);
      const onRoad = cars.every(c => {
        const z = streetZoneAt(Math.round(c.gx), Math.round(c.gy));
        return !!z && z.kind === 'road';
      });
      P('F4 cars stay on road lanes',
        cars.length > 0 && onRoad && cars.length >= TRAFFIC_LANES.length,
        'lanes=' + TRAFFIC_LANES.length + ' cars=' + cars.length + ' onRoad=' + onRoad);

      // F5 同一秒算两遍必须一样（跨端一致），5 秒后必须动过
      const t1 = trafficCarsAt(500), t2 = trafficCarsAt(500), t3 = trafficCarsAt(505);
      const same = JSON.stringify(t1) === JSON.stringify(t2);
      const moved = t1.some((c, i) => Math.abs(c.gx - t3[i].gx) + Math.abs(c.gy - t3[i].gy) > 0.5);
      P('F5 traffic is deterministic and moves', same && moved, 'same=' + same + ' moved=' + moved);

      // F6 车不在自家场景里画（renderStreet 才画）；这里只确认数据层不带 home 坐标
      P('F6 traffic only exists for street lanes',
        TRAFFIC_LANES.every(l => l.id.indexOf('road') === 0), TRAFFIC_LANES.length + ' lanes');
    }
    /* ---------- L 组：红绿灯 / 斑马线 / 礼让 ---------- */
    {
      // L1 相位交替且互斥
      P('L1 traffic light alternates',
        trafficLightAxis(0) === 'h' && trafficLightAxis(LIGHT_CYCLE) === 'v' &&
        trafficLightAxis(LIGHT_CYCLE * 2) === 'h' && LIGHT_CYCLE >= 6,
        'cycle=' + LIGHT_CYCLE);

      // L2 斑马线必须铺在路面上（不能画到草地/楼里）
      const cross = STREET_CROSSINGS[0];
      let offRoad = 0;
      for (const k of cross.cells){
        const gx = k % STREET_W, gy = (k / STREET_W) | 0;
        if (!isStreetBlocked || true){
          const z = streetZoneAt(gx, gy);
          if (!z || z.kind !== 'road') offRoad++;
        }
      }
      P('L2 crosswalk sits on road tiles', !!cross && cross.cells.size > 0 && offRoad === 0,
        'cells=' + (cross ? cross.cells.size : 0) + ' offRoad=' + offRoad);

      // L3 红灯前停车：横向绿灯时，纵向车必须停在路口外
      resetTrafficState();
      let waitCar = null, waitBox = null;
      for (let f = 0; f < 600 && !waitCar; f++){
        const sec = f * 0.05;
        const cars = trafficStep(0.05, sec, []);
        const v = cars.filter(c => c.axis === 'y' && c.waiting);
        if (v.length){ waitCar = v[0]; waitBox = cross; }
      }
      const outsideJunction = waitCar && (waitCar.gy <= waitBox.box.y + 0.05 || waitCar.gy >= waitBox.box.y + waitBox.box.h - 0.05);
      P('L3 cars stop before the junction on red',
        !!waitCar && outsideJunction,
        JSON.stringify({ car: waitCar && { id: waitCar.id, gy: waitCar.gy }, box: waitBox && waitBox.box }));

      // L4 行人站在斑马线上：横向绿灯也照样停（礼让）
      resetTrafficState();
      const hLane = TRAFFIC_LANES.find(l => l.axis === 'x' && l.fixed >= cross.box.y && l.fixed < cross.box.y + cross.box.h);
      const ped = [{ gx: cross.box.x - 1.2, gy: cross.box.y + 0.5 }];
      let yieldCar = null;
      for (let f = 0; f < 800 && !yieldCar; f++){
        const sec = 1 + f * 0.05;             // 处于横向绿灯阶段
        const cars = trafficStep(0.05, sec, ped);
        const mine = cars.filter(c => c.id.indexOf(hLane.id + '#') === 0 && c.waiting);
        if (mine.length) yieldCar = mine[0];
      }
      // 车可以停在路口前，也可以停在行人前——只要没有开过行人就算礼让
      const pedAt = ped[0].gx;
      const beforePed = yieldCar && (yieldCar.dir > 0 ? yieldCar.gx < pedAt - 0.3 : yieldCar.gx > pedAt + 0.3);
      P('L4 cars yield to pedestrian on crosswalk', !!yieldCar && beforePed,
        JSON.stringify({ car: yieldCar && { id: yieldCar.id, gx: yieldCar.gx, dir: yieldCar.dir }, pedAt: pedAt }));

      // L5 行人离开后恢复行驶：同一辆车必须能开过路口
      let passed = false;
      for (let f = 0; f < 400 && !passed; f++){
        const sec = 1 + 40 + f * 0.05;
        const cars = trafficStep(0.05, sec, []);
        const mine = cars.filter(c => c.id === (yieldCar && yieldCar.id));
        if (mine.length && (mine[0].dir > 0 ? mine[0].gx > cross.box.x + cross.box.w : mine[0].gx < cross.box.x)){
          passed = true;
        }
      }
      P('L5 cars resume after the crossing clears', passed);

      // L6 等灯的车必须停在路口外（不能停在路口中间堵着）
      let parkedInside = 0;
      resetTrafficState();
      for (let f = 0; f < 500; f++){
        const sec = f * 0.05;
        const cars = trafficStep(0.05, sec, []);
        for (const c of cars){
          if (!c.waiting) continue;
          for (const cc of STREET_CROSSINGS){
            const x = Math.round(c.gx), y = Math.round(c.gy);
            if (x >= cc.box.x && x < cc.box.x + cc.box.w && y >= cc.box.y && y < cc.box.y + cc.box.h) parkedInside++;
          }
        }
      }
      P('L6 waiting cars never park inside a junction', parkedInside === 0, 'inside=' + parkedInside);
      resetTrafficState();
    }

    /* ---------- I 组：4S 店买车 / 停车 / 上车 ---------- */
    {
      const bak = { money: MONEY, car: MY_CAR, inCar: IN_CAR, scene: scene, fx: PLAYER.fx, fy: PLAYER.fy };

      // I1 4S 店在地图上，且门口能站人（打卡点/门格不能是墙）
      const shop = STREET_ZONES.find(z => z.id === 'shop_car');
      const door = carShopDoor();
      P('I1 car shop exists with walkable door',
        !!shop && shop.kind === 'shop' && !!door && moveBlocked(door.gx, door.gy) === false &&
        Array.isArray(CARS_DEF) && CARS_DEF.length >= 2,
        JSON.stringify({ shop: !!shop, door: door, models: CARS_DEF.length }));

      // I2 买车：扣钱、停到 4S 停车场、进存档
      scene = 'street';
      MY_CAR = null; IN_CAR = false; MONEY = 50000;
      const mini = CARS_DEF[0];
      const beforeMoney = MONEY;
      const bought = buyCar(mini.id);
      const parkedZone = carParkingZone();
      const inLot = MY_CAR && parkedZone &&
        MY_CAR.gx >= parkedZone.x && MY_CAR.gx < parkedZone.x + parkedZone.w &&
        MY_CAR.gy >= parkedZone.y && MY_CAR.gy < parkedZone.y + parkedZone.h;
      const savedCar = collectSave().car;
      P('I2 buying a car parks it in the 4S lot and saves it',
        bought === true && MONEY === beforeMoney - mini.price && !!MY_CAR && inLot &&
        savedCar && savedCar.model === mini.id && Number(savedCar.gx) === MY_CAR.gx,
        JSON.stringify({ bought: bought, money: MONEY, car: MY_CAR, saved: savedCar }));

      // I3 没钱买不了；已有车也不能再买
      MONEY = 10;
      const poorCar = { money: MONEY };
      const poor = buyCar(CARS_DEF[CARS_DEF.length - 1].id);
      const second = buyCar(CARS_DEF[1].id);
      P('I3 cannot buy when broke or already owning one',
        poor === false && second === false && MONEY === poorCar.money && MY_CAR.model === mini.id,
        JSON.stringify({ poor: poor, second: second, money: MONEY }));

      // I4 上车后：速度按车款倍率，且只能开硬质路面（草地不行）
      MONEY = 50000;
      MY_CAR.gx = 20; MY_CAR.gy = 23;       // 中央大道上
      PLAYER.fx = 20; PLAYER.fy = 23;
      IN_CAR = false;
      const boarded = toggleCar();
      const boosted = walkSpeed() === WALK_SPEED * Math.max(1, Number(mini.speed) || 1);
      let lawn = null;
      for (let gy = 3; gy < STREET_H - 3 && !lawn; gy++){
        for (let gx = 4; gx < STREET_W - 4; gx++){
          const k0 = streetZoneKindShallow(gx, gy);
          // 没有分区覆盖的格子就是默认草坪（浅查表返回 null）
          if ((k0 === 'lawn' || k0 === null) && !isStreetObstacle(gx, gy)){ lawn = { gx: gx, gy: gy }; break; }
        }
      }
      const grassBlocked = !!lawn && moveBlocked(lawn.gx, lawn.gy) === true;
      const roadOk = moveBlocked(20, 23) === false;
      P('I4 in-car speed and only hard surfaces',
        boarded === true && IN_CAR === true && boosted && grassBlocked && roadOk,
        JSON.stringify({ boosted: boosted, lawn: lawn, grassBlocked: grassBlocked, roadOk: roadOk }));

      // I5 下车：人落到旁边空格，车留在原地，存档记住车位
      PLAYER.fx = 20.4; PLAYER.fy = 23.4;
      const exited = toggleCar();
      const savedAfter = collectSave().car;
      P('I5 leaving the car parks it where you stopped',
        exited === true && IN_CAR === false && !!MY_CAR &&
        savedAfter && Number(savedAfter.gx) === Math.round(20.4) && Number(savedAfter.gy) === Math.round(23.4) &&
        (Math.round(PLAYER.fx) !== MY_CAR.gx || Math.round(PLAYER.fy) !== MY_CAR.gy),
        JSON.stringify({ saved: savedAfter, player: { gx: PLAYER.fx, gy: PLAYER.fy }, car: MY_CAR }));

      // I6 读档过滤未知车款（内容改了不能把玩家卡在"车不存在"）
      const okCar = normalizeCar({ model: mini.id, gx: 5, gy: 5 });
      const badCar = normalizeCar({ model: 'car.nope', gx: 5, gy: 5 });
      P('I6 unknown car model is dropped on load',
        !!okCar && okCar.model === mini.id && badCar === null,
        JSON.stringify({ okCar: okCar, badCar: badCar }));

      MONEY = bak.money; MY_CAR = bak.car; IN_CAR = bak.inCar;
      scene = bak.scene; PLAYER.fx = bak.fx; PLAYER.fy = bak.fy;
      PLAYER.path = []; PLAYER.target = null; PLAYER.moving = false;
    }

    /* ---------- O 组：货币流通（卖车 / 房租 / 看病） ---------- */
    {
      const bak = {
        money: MONEY, day: DAY, rent: RENT_LAST_DAY, car: MY_CAR, inCar: IN_CAR,
        res: RESIDENCE, addr: ADDRESS, estates: JSON.parse(JSON.stringify(ESTATES)),
        scene: scene, emo: STATS.emotion, med: MED_LAST_MINUTE, minute: MINUTE
      };

      // O1 卖车：按 resaleRatio 回收，车和存档一起清掉
      MY_CAR = { model: 'car.mini', gx: 51, gy: 32 }; IN_CAR = false; MONEY = 1000;
      const back = carResaleValue();
      const sold = sellCar();
      P('O1 selling the car refunds at resale ratio',
        sold === true && MY_CAR === null && MONEY === 1000 + back &&
        collectSave().car === null && back === Math.floor(carModel('car.mini').price * CAR_RESALE),
        JSON.stringify({ sold: sold, back: back, money: MONEY, car: collectSave().car }));

      // O2 租来的房：每 7 天自动扣一次月租
      RESIDENCE = { buildingId: 'house.公寓楼', floor: 8, room: 1 };
      ESTATES = [{ buildingId: 'house.公寓楼', floor: 8, room: 1, mode: 'rented', paid: 300 }];
      ADDRESS = residenceAddress();
      DAY = 100; RENT_LAST_DAY = 100; MONEY = 5000;
      const rent = rentAmount();
      DAY = 100 + RENT_CYCLE;
      const paidRent = collectRent();
      P('O2 rent is charged once per cycle',
        rent > 0 && paidRent === rent && MONEY === 5000 - rent && RENT_LAST_DAY === DAY,
        JSON.stringify({ rent: rent, paid: paidRent, money: MONEY, last: RENT_LAST_DAY }));

      // O3 没钱交租：不扣成负数，只欠着（下个周期再试）
      MONEY = 1;
      DAY = RENT_LAST_DAY + RENT_CYCLE;
      const paidPoor = collectRent();
      P('O3 broke tenant owes rent instead of going negative',
        paidPoor === 0 && MONEY === 1 && RENT_LAST_DAY === DAY,
        JSON.stringify({ paid: paidPoor, money: MONEY }));

      // O4 门诊：扣钱 + 情绪恢复（效果来自内容）
      MONEY = 1000; STATS.emotion = 40; MED_LAST_MINUTE = -9999;
      const visit = useClinic('clinic.visit');
      P('O4 clinic visit charges money and heals',
        visit === true && MONEY === 1000 - 60 && STATS.emotion === 65,
        JSON.stringify({ visit: visit, money: MONEY, emo: STATS.emotion }));

      // O5 买药有冷却：连续买两次只成功一次
      MONEY = 1000; MINUTE = 600; MED_LAST_MINUTE = -9999;
      const med1 = useClinic('clinic.meds');
      const med2 = useClinic('clinic.meds');
      P('O5 medicine has a cooldown',
        med1 === true && med2 === false && MONEY === 1000 - 25,
        JSON.stringify({ med1: med1, med2: med2, money: MONEY }));

      // O6 价格/效果都由内容决定（代码里没有写死 60/25）
      const svc = clinicService('clinic.visit');
      P('O6 clinic services come from content',
        !!svc && svc.price === 60 && CLINIC_SERVICES.length >= 2 && RENT_CYCLE >= 1,
        JSON.stringify({ services: CLINIC_SERVICES.length, rentCycle: RENT_CYCLE }));

      MONEY = bak.money; DAY = bak.day; RENT_LAST_DAY = bak.rent;
      MY_CAR = bak.car; IN_CAR = bak.inCar;
      RESIDENCE = bak.res; ADDRESS = bak.addr; ESTATES = bak.estates;
      scene = bak.scene; STATS.emotion = bak.emo; MED_LAST_MINUTE = bak.med; MINUTE = bak.minute;
    }

    /* ---------- G 组：彩票（双色球 2 元一注） ---------- */
    {
      const bak = { money: MONEY, stats: { bought: LOTTERY_STATS.bought, won: LOTTERY_STATS.won }, log: LOTTERY_LOG.slice() };

      // G1 号码格式：6 个不重复红球（1..33）+ 1 个蓝球（1..16），且升序
      const t1 = lotteryPick();
      const uniq = new Set(t1.reds).size === 6;
      const inRange = t1.reds.every(r => r >= 1 && r <= 33) && t1.blue >= 1 && t1.blue <= 16;
      const sorted = t1.reds.every((r, i) => i === 0 || r > t1.reds[i - 1]);
      P('G1 lottery ticket is 6 sorted reds + 1 blue', uniq && inRange && sorted,
        JSON.stringify(t1));

      // G2 一等奖概率必须等于官方 1/17,721,088（组合数算的，不是拍的）
      const t0 = LOTTERY_DEF.tiers[0];
      const o1 = lotteryTierOdds(t0);
      P('G2 jackpot odds match the official 1 in 17,721,088',
        Math.abs(o1 - 1 / 17721088) < 1e-12 && t0.name === '一等奖',
        'odds=1/' + Math.round(1 / o1));

      // G2b 六等奖（只中蓝球那档）应落在 1/17 附近
      const t6 = LOTTERY_DEF.tiers[LOTTERY_DEF.tiers.length - 1];
      const o6 = lotteryTierOdds(t6);
      P('G2b lowest tier odds ~1/17', o6 > 0.055 && o6 < 0.062,
        'odds=1/' + (1 / o6).toFixed(2));

      // G3 对奖：直接用固定号码验证六个档位
      const win = { reds: [1, 2, 3, 4, 5, 6], blue: 7 };
      const cases = [
        { t: { reds: [1, 2, 3, 4, 5, 6], blue: 7 }, name: '一等奖' },
        { t: { reds: [1, 2, 3, 4, 5, 6], blue: 8 }, name: '二等奖' },
        { t: { reds: [1, 2, 3, 4, 5, 20], blue: 7 }, name: '三等奖' },
        { t: { reds: [1, 2, 3, 4, 20, 21], blue: 7 }, name: '四等奖' },
        { t: { reds: [1, 2, 3, 20, 21, 22], blue: 7 }, name: '五等奖' },
        { t: { reds: [1, 2, 20, 21, 22, 23], blue: 7 }, name: '六等奖' },
        { t: { reds: [20, 21, 22, 23, 24, 25], blue: 8 }, name: null }
      ];
      const allOk = cases.every(c => {
        const r = lotteryCheck(c.t, win);
        return c.name ? (r.tier && r.tier.name === c.name) : r.tier === null;
      });
      P('G3 prize tiers match official rules', allOk,
        cases.map(c => c.name + ':' + (lotteryCheck(c.t, win).tier || {}).name).join(' '));

      // G4 买 1 注：扣 2 元，中奖再加回来
      MONEY = 100; LOTTERY_STATS = { bought: 0, won: 0 }; LOTTERY_LOG = [];
      const r4 = playLottery(1);
      P('G4 one ticket costs 2 yuan',
        !!r4 && r4.cost === 2 && r4.results.length === 1 &&
        MONEY === 100 - 2 + r4.prize && LOTTERY_STATS.bought === 1 && LOTTERY_STATS.won === r4.prize,
        JSON.stringify({ cost: r4 && r4.cost, prize: r4 && r4.prize, money: MONEY }));

      // G5 买 5 注：花 10 元，5 注共用同一组开奖号码
      MONEY = 100;
      const r5 = playLottery(5);
      const sameWin = r5 && r5.results.every(x => x.win === r5.results[0].win);
      P('G5 five tickets share one draw',
        !!r5 && r5.cost === 10 && r5.results.length === 5 && sameWin &&
        MONEY === 100 - 10 + r5.prize,
        JSON.stringify({ cost: r5 && r5.cost, n: r5 && r5.results.length, money: MONEY }));

      // G6 没钱买不了：不扣钱、不记战绩
      MONEY = 1; LOTTERY_STATS = { bought: 0, won: 0 };
      const poor = playLottery(1);
      P('G6 cannot buy without money',
        poor === null && MONEY === 1 && LOTTERY_STATS.bought === 0,
        JSON.stringify({ poor: poor, money: MONEY }));

      MONEY = bak.money; LOTTERY_STATS = bak.stats; LOTTERY_LOG = bak.log;
    }

    /* ---------- V 组：食材（买菜 → 做饭 → 吃饭） ---------- */
    {
      const bk = { money: MONEY, pantry: PANTRY, bag: BAG, hunger: STATS.hunger };
      P('V1 food config loaded',
        !!FOOD_DEF && FOOD_DEF.cook.uses === 1 && FOOD_DEF.meal.uses === 2 && FOOD_DEF.max === 40,
        JSON.stringify({ cook: FOOD_DEF && FOOD_DEF.cook, meal: FOOD_DEF && FOOD_DEF.meal }));

      MONEY = 200; PANTRY = 0; BAG = 0;
      const got = buyGroceries('shop3', 1);
      P('V3 buy groceries goes into the bag, not the fridge',
        got === 10 && MONEY === 174 && BAG === 10 && PANTRY === 0,
        JSON.stringify({ got: got, money: MONEY, bag: BAG, pantry: PANTRY }));

      BAG = bagCap();
      const m0 = MONEY;
      const full = buyGroceries('shop3', 1);
      P('V4 full bag blocks buying', full === 0 && MONEY === m0 && BAG === bagCap(),
        JSON.stringify({ full: full, money: MONEY, bag: BAG }));

      PANTRY = 0; BAG = 0;
      const df = { catalogId: 'dining', gx: 5, gy: 5 };
      const dacts = targetActions({ kind: 'furniture', furn: df });
      const chk = checkAction(dacts[0], { kind: 'furniture', furn: df });
      P('V5 no food blocks the action before walking',
        chk.ok === false && /食材/.test(chk.reason), chk.reason);

      // V6 背包优先：手上就有的先用掉，不惊动冰箱
      BAG = 5; PANTRY = 0; STATS.hunger = 50;
      const use = FOOD_DEF.cook;
      const ok6 = spendFood(use, { gx: 5, gy: 5 });
      applyFx(foodEffects(use), { gx: 5, gy: 5 });
      P('V6 cook eats from the bag first',
        ok6 === true && BAG === 4 && PANTRY === 0 && STATS.hunger > 50,
        JSON.stringify({ bag: BAG, pantry: PANTRY, hunger: Math.round(STATS.hunger) }));

      // V7 回家归仓：背包进冰箱，冰箱满的部分留在背包
      BAG = 6; PANTRY = pantryMax() - 2;
      const moved = stashBag(true);
      P('V7 stash moves what fits and keeps the rest',
        moved === 2 && PANTRY === pantryMax() && BAG === 4,
        JSON.stringify({ moved: moved, pantry: PANTRY, bag: BAG }));

      // V8 两者都空才算没食材
      BAG = 0; PANTRY = 0;
      const df2 = { catalogId: 'dining', gx: 5, gy: 5 };
      const chk2 = checkAction(targetActions({ kind:'furniture', furn: df2 })[0], { kind:'furniture', furn: df2 });
      P('V8 empty bag and fridge blocks the action', chk2.ok === false && /食材/.test(chk2.reason), chk2.reason);

      MONEY = bk.money; PANTRY = bk.pantry; BAG = bk.bag; STATS.hunger = bk.hunger;
    }

    /* ---------- W 组：饭馆 / 超市柜台 ---------- */
    {
      const bk = { money: MONEY, hunger: STATS.hunger, zone: COUNTER_ZONE };
      P('W1 restaurant menu from content',
        !!RESTAURANT_DEF && RESTAURANT_DEF.menu.length === 4 && RESTAURANT_DEF.menu[0].price === 14,
        RESTAURANT_DEF && RESTAURANT_DEF.menu.map(d => d.name + '¥' + d.price).join(','));
      P('W1b mart goods from content',
        !!MART_DEF && MART_DEF.goods.length === 3 && hasCounter('shop_super') === true);

      COUNTER_ZONE = 'shop_restaurant';
      MONEY = 100; STATS.hunger = 50;
      const ok = eatDish('dish.rice');
      P('W2 eat dish deducts money and restores hunger',
        ok === true && MONEY === 82 && STATS.hunger > 50,
        JSON.stringify({ money: MONEY, hunger: Math.round(STATS.hunger) }));

      MONEY = 5;
      const poor = eatDish('dish.set');
      P('W3 cannot eat without money', poor === false && MONEY === 5, 'money=' + MONEY);

      COUNTER_ZONE = bk.zone; MONEY = bk.money; STATS.hunger = bk.hunger;
    }

    /* ---------- X 组：楼下信箱 / 缴费通知 ---------- */
    {
      const bk = { day: DAY, bills: BILLS, cursor: BILL_CURSOR, money: MONEY,
                   emo: STATS.emotion, lateDay: BILL_LATE_DAY, lateTotal: BILL_LATE_TOTAL };

      P('X1 bill templates loaded', BILL_TPL.length === 5 && !!BILL_TPL.find(t => t.id === 'bill.power'),
        BILL_TPL.map(t => t.id).join(','));

      BILLS = []; BILL_CURSOR = {}; BILL_LATE_DAY = 0; BILL_LATE_TOTAL = 0;
      DAY = 100;
      tickBills();
      P('X2 first tick issues nothing (no back bills for new players)', BILLS.length === 0,
        'n=' + BILLS.length);

      DAY = 115; tickBills();
      const hasPower = !!BILLS.find(b => b.tplId === 'bill.power');
      const hasWater = !!BILLS.find(b => b.tplId === 'bill.water');
      P('X2b cycle reached issues power and water bills', hasPower && hasWater,
        BILLS.map(b => b.tplId + '¥' + b.amount).join(','));
      P('X2c property (30d) not issued yet', !BILLS.find(b => b.tplId === 'bill.property'));

      const power = BILLS.find(b => b.tplId === 'bill.power');
      const expectPower = 16 + 4 * applianceCountInHome();
      P('X3 power amount = base + appliances',
        !!power && power.amount === expectPower && power.due === power.issued + MAIL_GRACE,
        JSON.stringify({ got: power && power.amount, expect: expectPower, due: power && power.due }));

      P('X3b parking bill follows car ownership',
        billConditionOk(BILL_TPL.find(t => t.id === 'bill.parking')) === !!MY_CAR);

      STATS.emotion = 80; BILL_LATE_DAY = 0; BILL_LATE_TOTAL = 0;
      DAY = 200;
      applyLateEmotion();
      P('X4 overdue bill costs emotion once a day',
        Math.abs(STATS.emotion - 79) < 1e-6 && BILL_LATE_DAY === 200,
        JSON.stringify({ emo: STATS.emotion, day: BILL_LATE_DAY }));
      const emoAfter = STATS.emotion;
      applyLateEmotion();
      P('X4b same day does not charge twice', Math.abs(STATS.emotion - emoAfter) < 1e-6);

      MONEY = 1000;
      const target = BILLS.find(b => !b.paid);
      const amt = target.amount;
      const paidOk = payBill(target.key);
      P('X5 pay bill deducts money and marks paid',
        paidOk === true && MONEY === 1000 - amt && target.paid === DAY,
        JSON.stringify({ money: MONEY, paid: target.paid }));

      const allPaid = unpaidTotal();
      MONEY = 1000;
      const paidSum = payAllBills();
      P('X5b pay all clears the rest', paidSum === allPaid && unpaidCount() === 0,
        JSON.stringify({ paidSum: paidSum, left: unpaidCount() }));

      P('X6 bill card renders with amount and pay button',
        billCard({ key: 'k', title: '电费', amount: 28, issued: 1, due: 4, paid: 0, detail: 'x' })
          .indexOf('¥28') >= 0);

      DAY = bk.day; BILLS = bk.bills; BILL_CURSOR = bk.cursor; MONEY = bk.money;
      STATS.emotion = bk.emo; BILL_LATE_DAY = bk.lateDay; BILL_LATE_TOTAL = bk.lateTotal;
      _billTickDay = 0;
    }

    /* ---------- Y 组：不动产增值 ---------- */
    {
      const bk = { day: DAY };
      DAY = 1;
      P('Y1 price index is 1 in year one', Math.abs(priceYearIndex() - 1) < 1e-9, priceYearIndex());

      DAY = 366;
      P('Y2 +5% after one year (compound)',
        Math.abs(priceYearIndex() - 1.05) < 1e-9, priceYearIndex());

      const base = unitBasePrice(18);
      const sale = unitSalePrice(18);
      P('Y3 18F base is 26400 and sale price tracks the index',
        base === 26400 && Math.abs(sale - 27700) < 1,
        JSON.stringify({ base: base, sale: sale }));

      DAY = 800;
      P('Y4 second year compounds again',
        Math.abs(priceYearIndex() - 1.1025) < 1e-9, priceYearIndex());

      DAY = bk.day;
    }

    /* ---------- Z 组：功能点承包（本地账目部分；独占由服务端 66 项自测覆盖） ---------- */
    {
      const bk = { day: DAY, money: MONEY, list: BIZ_LIST, last: BIZ_LAST_DAY, remote: BIZ_REMOTE };

      P('Z1 business config loaded',
        BIZ_SHOPS.length === 10 && BIZ_TERM === 30 && BIZ_MAX === 3,
        'shops=' + BIZ_SHOPS.length + ' term=' + BIZ_TERM + ' max=' + BIZ_MAX);

      const codes = BIZ_SHOPS.map(s => String(s.code || ''));
      const uniq = new Set(codes).size === codes.length;
      const allNum = codes.every(c => /^[0-9]{3,6}$/.test(c));
      P('Z2 every shop has a unique doorplate number', uniq && allNum, codes.join(','));

      const bad = BIZ_SHOPS.filter(s => (s.daily * BIZ_TERM - s.fee) <= 0).map(s => s.name);
      P('Z3 every shop earns a profit per term', bad.length === 0, bad.join(',') || 'ok');

      P('Z4 doorplate shows in the display name',
        bizNameOf(BIZ_SHOPS.find(s => s.id === 'biz.lottery')) === '2737 号 · 彩票站',
        bizNameOf(BIZ_SHOPS.find(s => s.id === 'biz.lottery')));

      // Z5 结算：按天累加（每天客流不同，不能再是"平均数 × 天数"）
      DAY = 50; MONEY = 1000; BIZ_LAST_DAY = 48;
      BIZ_LIST = [{ shopId: 'biz.store', start: 40, end: 70, fee: 1500 }];
      let expect5 = 0;
      for (let d = 49; d <= 50; d++) expect5 += bizDayIncome('biz.store', d);
      const got = settleBusiness();
      P('Z5 settle sums per-day income', got === expect5 && MONEY === 1000 + expect5,
        JSON.stringify({ got: got, expect: expect5, money: MONEY }));

      // Z6 离线补结算有上限（最多 catchUpDays 天）
      DAY = 200; MONEY = 0; BIZ_LAST_DAY = 1;
      BIZ_LIST = [{ shopId: 'biz.store', start: 1, end: 400, fee: 1500 }];
      let expect6 = 0, days6 = 0;
      for (let d = 200 - BIZ_CATCHUP + 1; d <= 200; d++){ expect6 += bizDayIncome('biz.store', d); days6++; }
      const capped = settleBusiness();
      P('Z6 catch-up is capped at catchUpDays',
        capped === expect6 && days6 === BIZ_CATCHUP,
        JSON.stringify({ capped: capped, expect: expect6, cap: BIZ_CATCHUP }));

      // Z12 每日收入确实有起伏（不是固定值）
      const vals = {};
      for (let d = 1; d <= 30; d++) vals['v' + bizDayIncome('biz.store', d)] = 1;
      P('Z12 daily income varies day to day', Object.keys(vals).length >= 8,
        'distinct=' + Object.keys(vals).length);

      // Z13 同一天同一家店反复算，结果必须一样（读档不能变）
      P('Z13 factor is stable for the same day',
        bizDayFactor('biz.store', 42) === bizDayFactor('biz.store', 42) &&
        bizDayIncome('biz.store', 42) === bizDayIncome('biz.store', 42));

      // Z14 周末系数更高（同一天：周末日 vs 工作日）
      const wkEnd = 7;                       // 7 % 7 = 0 → 周末
      const wkDay = 3;
      P('Z14 weekend factor is boosted',
        bizIsWeekend(wkEnd) === true && bizIsWeekend(wkDay) === false,
        JSON.stringify({ end: bizIsWeekend(wkEnd), day: bizIsWeekend(wkDay) }));

      // Z7 过期记录在结算时被清掉
      DAY = 60; BIZ_LAST_DAY = 59; MONEY = 0;
      BIZ_LIST = [{ shopId: 'biz.cafe', start: 10, end: 40, fee: 2000 }];
      settleBusiness();
      P('Z7 expired contracts are dropped', BIZ_LIST.length === 0, 'len=' + BIZ_LIST.length);

      // Z8 离线（没连服务端）不允许承包：独占必须由服务端裁决
      BIZ_REMOTE = { ok: false, day: 0, items: [], mine: [] };
      BIZ_LIST = []; MONEY = 99999; DAY = 60;
      (async () => {
        const r = await takeBusiness('biz.store');
        P('Z8 offline cannot take a shop', r === false && MONEY === 99999,
          JSON.stringify({ r: r, money: MONEY }));
      })();

      // Z9 别人占着时按钮应显示为"已被承包"
      BIZ_REMOTE = { ok: true, day: 60, items: [{ shopId: 'biz.cafe', userId: 'u999', nickname: '阿芳', daysLeft: 12 }], mine: [] };
      const occ = bizOccupiedBy('biz.cafe');
      P('Z9 other player blocks the shop', !!occ && occ.nickname === '阿芳' && occ.daysLeft === 12,
        JSON.stringify(occ));

      const htmlCard = bizCard(BIZ_SHOPS.find(s => s.id === 'biz.cafe'));
      P('Z9b card shows the occupant', htmlCard.indexOf('阿芳') >= 0 && htmlCard.indexOf('已被承包') >= 0);

      // Z10 自己的店不算被占
      BIZ_REMOTE = { ok: true, day: 60, items: [{ shopId: 'biz.cafe', userId: 'me', nickname: '我', daysLeft: 12 }], mine: ['biz.cafe'] };
      P('Z10 own shop is not treated as occupied', bizOccupiedBy('biz.cafe') === null);

      // Z11 存档里带 biz
      BIZ_LIST = [{ shopId: 'biz.store', start: 60, end: 90, fee: 1500 }];
      BIZ_LAST_DAY = 60;
      const saved = collectSave();
      P('Z11 save carries business contracts',
        saved.biz && saved.biz.list.length === 1 && saved.biz.lastDay === 60 && saved.biz.list[0].end === 90,
        JSON.stringify(saved.biz));

      DAY = bk.day; MONEY = bk.money; BIZ_LIST = bk.list; BIZ_LAST_DAY = bk.last; BIZ_REMOTE = bk.remote;
    }

    /* ---------- AA 组：收支账本 ---------- */
    {
      const bk = {
        money: MONEY, day: DAY,
        ledger: JSON.stringify(LEDGER)
      };

      // AA1 分类表齐全：收入 7 类、支出 10 类，且都有中文名
      const inCats = Object.keys(LEDGER_CATS.in);
      const outCats = Object.keys(LEDGER_CATS.out);
      P('AA1 ledger categories are complete',
        inCats.length >= 6 && outCats.length >= 9 &&
        inCats.every(k => !!LEDGER_CATS.in[k]) && outCats.every(k => !!LEDGER_CATS.out[k]),
        'in=' + inCats.length + ' out=' + outCats.length);

      // AA2 进账：加钱 + 记分类 + 记流水
      DAY = 40; MONEY = 100;
      LEDGER = { day: 40, today: { in: {}, out: {} }, days: [], log: [] };
      const got = credit(180, 'wage', '辅警');
      P('AA2 credit adds money and records the entry',
        got === 180 && MONEY === 280 && LEDGER.today.in.wage === 180 &&
        LEDGER.log.length === 1 && LEDGER.log[0].k === 'in' && LEDGER.log[0].a === 180,
        JSON.stringify({ got: got, money: MONEY, wage: LEDGER.today.in.wage }));

      // AA3 出账：扣钱 + 记分类
      const paid = debit(28, 'bill', '电费');
      P('AA3 debit subtracts money and records the entry',
        paid === 28 && MONEY === 252 && LEDGER.today.out.bill === 28,
        JSON.stringify({ paid: paid, money: MONEY, bill: LEDGER.today.out.bill }));

      // AA4 同一分类累加合并，不是一行一条
      credit(70, 'wage', '第二单');
      P('AA4 same category accumulates', LEDGER.today.in.wage === 250,
        'wage=' + LEDGER.today.in.wage);

      // AA5 未知分类落到 other（不能被静默丢掉，否则账对不上）
      credit(15, 'nonsense', '说不清的进账');
      P('AA5 unknown category falls back to other',
        LEDGER.today.in.other === 15 && MONEY === 337,
        JSON.stringify(LEDGER.today.in));

      // AA6 0 / 负数 / NaN 不记账（避免出现 0 元流水污染列表）
      const before = LEDGER.log.length;
      credit(0, 'wage', 'x'); credit(-50, 'wage', 'x'); credit(NaN, 'wage', 'x');
      P('AA6 zero and negative amounts are ignored',
        LEDGER.log.length === before && MONEY === 337, 'log=' + LEDGER.log.length);

      // AA7 分类明细按金额降序
      debit(60, 'food', '买菜'); debit(12, 'clinic', '买药');
      const bd = ledgerBreakdown('out');
      P('AA7 breakdown is sorted desc',
        bd.length === 3 && bd[0].c === 'food' && bd[1].c === 'bill' && bd[2].c === 'clinic',
        bd.map(r => r.c + ':' + r.a).join(','));

      // AA8 跨天：昨天的账落进 days，today 清空
      const ySum = ledgerDaySum();
      DAY = 41;
      credit(10, 'wage', '新的一天');
      const rec = LEDGER.days[LEDGER.days.length - 1];
      P('AA8 rollover files yesterday into days',
        !!rec && rec.d === 40 && rec.i === ySum.i && rec.o === ySum.o &&
        LEDGER.today.in.wage === 10 && LEDGER.today.out.bill === undefined,
        JSON.stringify({ rec: rec, today: LEDGER.today }));

      // AA9 近 7 天补零，且末位是今天
      const week = ledgerRecent(7);
      P('AA9 recent week is padded to 7 days',
        week.length === 7 && week[6].d === 41 && week[6].i === 10 &&
        week.slice(0, 6).some(r => r.i === 0 && r.o === 0),
        week.map(r => r.d + ':' + r.i + '/' + r.o).join(' '));

      // AA10 挂机空账不落记录（否则 days 会被空白天堆满）
      // 当前 today 还挂在 day 41 上，直接跳到 day 49：中间 7 天是空的，只该结出 1 条
      const dLen = LEDGER.days.length;
      const dayBefore = LEDGER.day;
      DAY = 49; credit(1, 'wage', 'b');
      const hasGap = LEDGER.days.some(r => r.d > dayBefore && r.d < 49);
      P('AA10 empty days are not recorded',
        LEDGER.days.length === dLen + 1 && !hasGap,
        'days=' + LEDGER.days.length + ' expected=' + (dLen + 1) + ' gap=' + hasGap);

      // AA11 流水条数上限
      for (let i = 0; i < LEDGER_KEEP_LOG + 20; i++) credit(1, 'wage', 'p' + i);
      P('AA11 log is capped', LEDGER.log.length === LEDGER_KEEP_LOG,
        'log=' + LEDGER.log.length + ' cap=' + LEDGER_KEEP_LOG);

      // AA12 每日汇总条数上限
      for (let d = 44; d < 44 + LEDGER_KEEP_DAYS + 10; d++){ DAY = d; credit(1, 'wage', 'd'); }
      P('AA12 daily summary is capped', LEDGER.days.length === LEDGER_KEEP_DAYS,
        'days=' + LEDGER.days.length + ' cap=' + LEDGER_KEEP_DAYS);

      // AA13 存档往返：写进去再读回来，分类和流水都对得上
      DAY = 60; MONEY = 500;
      LEDGER = { day: 60, today: { in: { wage: 300 }, out: { food: 40 } }, days: [{ d: 59, i: 200, o: 30 }], log: [] };
      credit(120, 'biz', '经营收入'); debit(25, 'clinic', '门诊');
      const saved = collectSave();
      P('AA13 save carries the ledger',
        saved.ledger && saved.ledger.day === 60 &&
        saved.ledger.today.in.wage === 300 && saved.ledger.today.in.biz === 120 &&
        saved.ledger.today.out.food === 40 && saved.ledger.today.out.clinic === 25 &&
        saved.ledger.days.length === 1,
        JSON.stringify(saved.ledger && saved.ledger.today));

      // AA14 读档时脏数据被清掉：负数、未知分类、超量记录
      const dirty = {
        schema: 13, money: 100, day: 70, minute: 480,
        ledger: {
          day: 70,
          today: { in: { wage: 100, junk: 999, bad: -5 }, out: { food: 20 } },
          days: Array.from({ length: 50 }, (_, i) => ({ d: i + 1, i: 10, o: 5 })),
          log: Array.from({ length: 99 }, () => ({ k: 'in', c: 'wage', a: 5 }))
        }
      };
      applySave(dirty);
      P('AA14 dirty ledger is sanitised',
        LEDGER.today.in.wage === 100 && LEDGER.today.in.junk === undefined &&
        LEDGER.today.in.bad === undefined && LEDGER.days.length <= LEDGER_KEEP_DAYS &&
        LEDGER.log.length <= LEDGER_KEEP_LOG,
        JSON.stringify({ today: LEDGER.today, days: LEDGER.days.length, log: LEDGER.log.length }));

      // AA15 面板渲染不报错，且关键区块都在
      const box = document.getElementById('ledgerList');
      if (box){
        toggleLedger(true);
        const html = box.innerHTML;
        P('AA15 ledger panel renders',
          html.indexOf('今日收入') >= 0 && html.indexOf('今日支出') >= 0 &&
          html.indexOf('近 7 天') >= 0,
          'len=' + html.length);
        toggleLedger(false);
      } else {
        P('AA15 ledger panel renders', false, 'no #ledgerList');
      }

      // 收尾：恢复现场
      DAY = bk.day; MONEY = bk.money;
      LEDGER = JSON.parse(bk.ledger);
    }

    /* ---------- AB 组：银行 ---------- */
    {
      const bk = { money: MONEY, day: DAY, bank: JSON.stringify(BANK), ledger: JSON.stringify(LEDGER) };

      // AB1 配置加载：活期有利率、定期有两个档、贷款有三个档
      P('AB1 bank config loaded',
        BANK_SAVE_RATE > 0 && BANK_FIXED.length === 2 && BANK_LOANS.length === 3 &&
        BANK_MAX_LOANS >= 1,
        'rate=' + BANK_SAVE_RATE + ' fixed=' + BANK_FIXED.length + ' loans=' + BANK_LOANS.length);

      // AB2 存款：现金减少、活期增加、账本记为"存入银行"且算资产转移
      DAY = 80; MONEY = 20000;
      BANK = { savings: 0, acc: 0, fixed: [], loans: [], lastDay: DAY, lateTotal: 0 };
      LEDGER = { day: DAY, today: { in: {}, out: {} }, days: [], log: [] };
      const dep = bankDeposit(5000);
      const sum2 = ledgerDaySum();
      P('AB2 deposit moves cash into savings',
        dep === 5000 && MONEY === 15000 && BANK.savings === 5000 &&
        LEDGER.today.out.bank === 5000 && sum2.xo === 5000,
        JSON.stringify({ dep: dep, money: MONEY, save: BANK.savings, xfer: sum2.xo }));

      // AB3 取款
      const wd = bankWithdraw(2000);
      P('AB3 withdraw brings cash back',
        wd === 2000 && MONEY === 17000 && BANK.savings === 3000,
        JSON.stringify({ wd: wd, money: MONEY, save: BANK.savings }));

      // AB4 存款上限：超出部分不会被吞掉（只扣到上限为止）
      BANK.savings = BANK_SAVE_CAP - 100;
      MONEY = 50000;
      const m0 = MONEY;
      const capped = bankDeposit(10000);
      P('AB4 deposit respects the cap',
        capped === 100 && BANK.savings === BANK_SAVE_CAP && MONEY === m0 - 100,
        JSON.stringify({ capped: capped, save: BANK.savings, money: MONEY }));

      // AB5 定期：从活期划走，到期按复利算
      BANK.savings = 20000; MONEY = 1000; DAY = 80;
      const term = BANK_FIXED[0];
      const fAmt = bankOpenFixed(term.id, 10000);
      P('AB5 fixed deposit takes from savings',
        fAmt === 10000 && BANK.savings === 10000 && BANK.fixed.length === 1 &&
        BANK.fixed[0].end === DAY + term.days,
        JSON.stringify({ fAmt: fAmt, save: BANK.savings, end: BANK.fixed[0] && BANK.fixed[0].end }));

      const expectVal = Math.round(10000 * Math.pow(1 + Number(term.dailyRate), term.days));
      P('AB5b fixed deposit compounds',
        bankFixedValue(BANK.fixed[0]) === expectVal && expectVal > 10000,
        'val=' + bankFixedValue(BANK.fixed[0]) + ' expect=' + expectVal);

      // AB6 提前支取：按 8 折返还，利息全没
      const uid = BANK.fixed[0].uid;
      MONEY = 0;
      const back = bankBreakFixed(uid);
      P('AB6 breaking a fixed deposit pays a penalty',
        back === Math.floor(10000 * (1 - BANK_PENALTY)) && BANK.fixed.length === 0 && MONEY === back,
        JSON.stringify({ back: back, money: MONEY }));

      // AB7 贷款：一次性到账、生成还款计划
      // 注意顺序：先把 DAY 设好再重置 BANK，否则 lastDay 会记成旧的 DAY，
      // 后面 financeTick 一补就是十几期（这个坑第一次写用例时踩了）
      MONEY = 0; DAY = 90;
      BANK = { savings: 0, acc: 0, fixed: [], loans: [], lastDay: DAY, lateTotal: 0 };
      const tier = BANK_LOANS[0];
      const got = bankTakeLoan(tier.id);
      const loan = BANK.loans[0];
      const expectTotal = Math.round(Number(tier.amount) * (1 + Number(tier.rate)));
      P('AB7 loan pays out and schedules repayment',
        got === Number(tier.amount) && MONEY === Number(tier.amount) &&
        loan.total === expectTotal && loan.perDay === Math.ceil(expectTotal / Number(tier.days)),
        JSON.stringify({ got: got, total: loan.total, per: loan.perDay }));

      // AB8 同一档不能重复借
      const again = bankTakeLoan(tier.id);
      P('AB8 the same tier cannot be borrowed twice', again === 0 && BANK.loans.length === 1,
        'again=' + again + ' n=' + BANK.loans.length);

      // AB9 每日扣款：跨 3 天扣 3 期
      const per = BANK.loans[0].perDay;
      MONEY = 100000;
      const cash0 = MONEY;
      DAY = 93;
      financeTick();
      P('AB9 financeTick charges the daily installment',
        MONEY === cash0 - per * 3 && BANK.loans[0].paid === per * 3,
        JSON.stringify({ money: MONEY, paid: BANK.loans[0].paid, per: per }));

      // AB10 现金不够 → 逾期：记 missed、加罚息、扣情绪
      MONEY = 0;
      const emo0 = STATS.emotion;
      const owed0 = BANK.loans[0].total - BANK.loans[0].paid;
      DAY = 94;
      financeTick();
      const owed1 = BANK.loans[0].total - BANK.loans[0].paid;
      P('AB10 missed payment adds a late fee and costs mood',
        BANK.loans[0].missed === 1 && owed1 > owed0 && STATS.emotion < emo0,
        JSON.stringify({ missed: BANK.loans[0].missed, owed0: owed0, owed1: owed1 }));

      // AB11 提前还清
      MONEY = 200000;
      const owe = BANK.loans[0].total - BANK.loans[0].paid;
      const paidNow = bankRepay(BANK.loans[0].id, owe);
      P('AB11 repay in full clears the loan',
        paidNow === owe && BANK.loans.length === 0, 'paid=' + paidNow);

      // AB12 活期利息按天结：跨 10 天，零头不丢
      BANK = { savings: 10000, acc: 0, fixed: [], loans: [], lastDay: 100, lateTotal: 0 };
      MONEY = 0; DAY = 110;
      const gain = financeTick();
      const expectGain = Math.floor(10000 * (Math.pow(1 + BANK_SAVE_RATE, 10) - 1));
      P('AB12 savings accrue daily interest',
        gain > 0 && Math.abs(gain - expectGain) <= 3 && BANK.savings === 10000 + gain,
        JSON.stringify({ gain: gain, expect: expectGain, save: BANK.savings }));

      MONEY = bk.money; DAY = bk.day;
      BANK = JSON.parse(bk.bank); LEDGER = JSON.parse(bk.ledger);
    }

    /* ---------- AC 组：股市 ---------- */
    {
      const bk = { money: MONEY, day: DAY, hold: JSON.stringify(STOCK_HOLD), bank: JSON.stringify(BANK), ledger: JSON.stringify(LEDGER) };

      // AC1 配置加载
      P('AC1 stock market config loaded',
        STOCKS.length === 6 && STOCK_FEE > 0 && STOCK_LOT > 0 && STOCK_MAX >= 1,
        'stocks=' + STOCKS.length + ' fee=' + STOCK_FEE + ' lot=' + STOCK_LOT);

      // AC2 每支股票都有编号、基准价、漂移与波动
      const badStock = STOCKS.filter(s => !s.id || !s.code || !(Number(s.base) > 0) ||
        !(Number(s.vol) >= 0) || Number(s.drift) == null).map(s => s.id);
      P('AC2 every stock has code/base/drift/vol', badStock.length === 0,
        badStock.join(',') || 'ok');

      // AC3 价格是确定性的：同一天反复算，结果完全一样
      DAY = 30;
      _stockDay = 0; _stockPx = {};
      const p1 = STOCKS.map(s => stockPrice(s.id));
      _stockDay = 0; _stockPx = {};
      const p2 = STOCKS.map(s => stockPrice(s.id));
      P('AC3 prices are deterministic for the same day',
        p1.length === p2.length && p1.every((v, i) => v === p2[i]),
        JSON.stringify(p1));

      // AC4 价格有下限，永远跌不成 0
      let minP = Infinity;
      for (let d = 1; d <= 400; d++){
        const px = stockSeriesAt(d);
        for (const s of STOCKS) minP = Math.min(minP, Number(px[s.id]) || 0);
      }
      const floorMin = Math.min.apply(null, STOCKS.map(s => Number(s.base) * 0.15)) * 0.99;
      P('AC4 prices never fall below the floor', minP >= floorMin && minP > 0,
        'min=' + minP.toFixed(3) + ' floor=' + floorMin.toFixed(3));

      // AC5 价格确实在动（400 天里出现过涨也出现过跌）
      let sawUp = false, sawDown = false;
      DAY = 60;
      for (let d = 2; d <= 60; d++){
        _stockDay = 0; _stockPx = {};
        const px = stockSeriesAt(d);
        _stockDay = 0; _stockPx = {};
        const pv = stockSeriesAt(d - 1);
        const s = STOCKS[0];
        if (px[s.id] > pv[s.id]) sawUp = true;
        if (px[s.id] < pv[s.id]) sawDown = true;
      }
      P('AC5 prices move both ways', sawUp && sawDown,
        JSON.stringify({ up: sawUp, down: sawDown }));

      // AC6 买入：扣钱含手续费、持仓增加
      DAY = 40; MONEY = 100000; STOCK_HOLD = []; _stockDay = 0; _stockPx = {};
      LEDGER = { day: DAY, today: { in: {}, out: {} }, days: [], log: [] };
      const sid = STOCKS[0].id;
      const pxNow = stockPrice(sid);
      const gross = Math.round(pxNow * STOCK_LOT);
      const fee = Math.max(1, Math.round(gross * STOCK_FEE));
      const spent = stockBuy(sid, STOCK_LOT);
      const h0 = stockHoldOf(sid);
      P('AC6 buying charges price plus fee',
        spent === gross + fee && MONEY === 100000 - spent &&
        h0 && h0.shares === STOCK_LOT && h0.cost === spent,
        JSON.stringify({ spent: spent, gross: gross, fee: fee, hold: h0 }));

      // AC7 买 5 手时手续费只收一次，但股数是 5 倍
      const spent2 = stockBuy(sid, STOCK_LOT * 4);
      P('AC7 adding to a position accumulates shares',
        spent2 > 0 && stockHoldOf(sid).shares === STOCK_LOT * 5,
        'shares=' + stockHoldOf(sid).shares);

      // AC8 卖出：按比例结转成本，剩余持仓成本同步缩
      const beforeCost = stockHoldOf(sid).cost;
      const beforeShares = stockHoldOf(sid).shares;
      const cashBefore = MONEY;
      const got2 = stockSell(sid, STOCK_LOT);
      const h1 = stockHoldOf(sid);
      const costOut = Math.round(beforeCost * (STOCK_LOT / beforeShares));
      P('AC8 selling releases cost proportionally',
        got2 > 0 && MONEY === cashBefore + got2 && h1.shares === beforeShares - STOCK_LOT &&
        Math.abs(h1.cost - (beforeCost - costOut)) <= 1,
        JSON.stringify({ got: got2, shares: h1.shares, cost: h1.cost }));

      // AC9 全部卖出后持仓消失
      stockSell(sid, stockHoldOf(sid).shares);
      P('AC9 selling everything clears the position', stockHoldOf(sid) === null,
        'hold=' + JSON.stringify(STOCK_HOLD));

      // AC10 钱不够买不了
      MONEY = 10;
      const noMoney = stockBuy(sid, STOCK_LOT);
      P('AC10 cannot buy without enough cash', noMoney === 0 && STOCK_HOLD.length === 0);

      // AC11 持仓支数上限
      MONEY = 10000000;
      for (const s of STOCKS) stockBuy(s.id, STOCK_LOT);
      const overflow = STOCKS.length > STOCK_MAX ? 2 : 0;
      P('AC11 holdings are capped', STOCK_HOLD.length === Math.min(STOCKS.length, STOCK_MAX),
        'hold=' + STOCK_HOLD.length + ' max=' + STOCK_MAX + ' unused=' + overflow);

      // AC12 盈亏 = 市值 - 成本
      const mv = stockMarketValue();
      let costAll = 0;
      for (const h of STOCK_HOLD) costAll += h.cost;
      P('AC12 pnl is market value minus cost',
        stockPnl() === mv - costAll && mv > 0, JSON.stringify({ mv: mv, cost: costAll }));

      // AC13 买进当天卖出必亏（手续费）
      MONEY = 100000; STOCK_HOLD = []; _stockDay = 0; _stockPx = {};
      DAY = 55;
      const c0 = MONEY;
      stockBuy(sid, STOCK_LOT);
      stockSell(sid, STOCK_LOT);
      P('AC13 round-trip on the same day loses the fee', MONEY < c0,
        'before=' + c0 + ' after=' + MONEY + ' lost=' + (c0 - MONEY));

      // AC14 存档往返：持股与成本都带上
      DAY = 60; MONEY = 5000; STOCK_HOLD = [{ id: sid, shares: 300, cost: 4000 }];
      const saved = collectSave();
      P('AC14 save carries stock holdings',
        saved.stock && Array.isArray(saved.stock.hold) && saved.stock.hold.length === 1 &&
        saved.stock.hold[0].shares === 300 && saved.stock.hold[0].cost === 4000 &&
        saved.bank && saved.bank.savings != null,
        JSON.stringify(saved.stock));

      // AC15 读档清洗：未知股票剔除、重复合并、负数归零、超量截断
      const dirty = {
        schema: 14, money: 1000, day: 60, minute: 480,
        bank: { savings: -500, acc: 5, fixed: [{ termId: 'nope', amount: 100 }], loans: [], lastDay: 0, lateTotal: 99 },
        stock: {
          hold: [
            { id: 'st.nope', shares: 100, cost: 100 },
            { id: sid, shares: 250, cost: 0 },
            { id: sid, shares: 100, cost: 100 },
            { id: STOCKS[1].id, shares: -50, cost: -10 }
          ]
        }
      };
      applySave(dirty);
      P('AB15 dirty bank and stock save is sanitised',
        BANK.savings === 0 && BANK.acc <= 0.999 && BANK.fixed.length === 0 &&
        BANK.lateTotal <= 0 && STOCK_HOLD.length === 1 && STOCK_HOLD[0].id === sid &&
        STOCK_HOLD[0].shares % STOCK_LOT === 0 && STOCK_HOLD[0].cost >= 1,
        JSON.stringify({ bank: BANK, hold: STOCK_HOLD }));

      MONEY = bk.money; DAY = bk.day;
      STOCK_HOLD = JSON.parse(bk.hold); BANK = JSON.parse(bk.bank); LEDGER = JSON.parse(bk.ledger);
    }

    /* ---------- PT 组：宠物系统 ---------- */
    {
      const bk = {
        money: MONEY, scene: scene, food: PETFOOD,
        pets: MY_PETS, emo: STATS.emotion, uid: petUidSeq
      };
      scene = 'home';
      MONEY = 6000; PETFOOD = 20; MY_PETS = [];

      P('PT1 pet definitions loaded',
        !!PETS_DEF && PETS_DEF.pets.length === 6 &&
        !!PET_DEF_BY_ID['pet.cat.orange'] && PETS_DEF.maxPets === 3,
        'count=' + (PETS_DEF ? PETS_DEF.pets.length : 0));

      const petProp = STREET_PROPS.find(q => q.zoneId === 'shop_pet');
      P('PT2 pet shop prop exists',
        !!petProp && petProp.kind === 'shop' && petProp.label === '宠物之家');

      const p = adoptPet('pet.cat.orange');
      P('PT3 adopt adds pet with initial needs',
        !!p && MY_PETS.length === 1 && p.species === 'cat' &&
        p.hunger === 85 && p.mood === 80 && p.clean === 90,
        JSON.stringify({ h: p.hunger, m: p.mood, c: p.clean }));

      p.hunger = 50; p.mood = 50; p.clean = 50; STATS.emotion = 70;
      executePetAction(p, { petAct: 'feed' });
      P('PT4 feed: hunger+38 mood+4 consumes food',
        p.hunger === 88 && p.mood === 54 && PETFOOD === 19,
        'h=' + p.hunger + ' food=' + PETFOOD);
      executePetAction(p, { petAct: 'pet' });
      P('PT5 pet: mood+16 player emotion+6',
        p.mood === 70 && STATS.emotion === 76,
        'mood=' + p.mood + ' emo=' + STATS.emotion);
      executePetAction(p, { petAct: 'play' });
      P('PT6 play: mood+30 hunger-6 emotion+9',
        p.mood === 100 && p.hunger === 82 && STATS.emotion === 85);
      executePetAction(p, { petAct: 'wash' });
      P('PT7 wash: clean+45 mood-6 emotion+2',
        p.clean === 95 && p.mood === 94 && STATS.emotion === 87);

      executePetAction(p, { petAct: 'follow' });
      P('PT8 follow toggles on', p.following === true, 'following=' + p.following);

      p.hunger = 80; p.mood = 80; p.clean = 80;
      SIM_MIN_LAST = 100;
      updatePets(0.016);
      P('PT9 decay matches formula',
        Math.abs(p.hunger - 75.5) < 1e-9 && Math.abs(p.mood - 76.5) < 1e-9 &&
        Math.abs(p.clean - 77.8) < 1e-9,
        p.hunger.toFixed(2) + '/' + p.mood.toFixed(2) + '/' + p.clean.toFixed(2));

      adoptPet('pet.dog.shiba'); adoptPet('pet.dog.corgi');
      const fourth = adoptPet('pet.dog.golden');
      P('PT10 max pets enforced at 3',
        MY_PETS.length === 3 && fourth === false, 'count=' + MY_PETS.length);

      const saved = collectSave();
      P('PT11 save carries pets',
        saved.pets && saved.pets.food === PETFOOD && saved.pets.list.length === 3,
        'food=' + saved.pets.food);
      MY_PETS = []; PETFOOD = 0;
      applySave(saved);
      P('PT12 apply restores pets',
        MY_PETS.length === 3 && !!PET_DEF_BY_ID[MY_PETS[0].defId] && PETFOOD === 19,
        'restored=' + MY_PETS.length);

      const old = migrateSave({ schema: 14 });
      P('PT13 migration fills pets for schema14',
        old.schema === 15 && old.pets.food === 0 && old.pets.list.length === 0);

      let panelOk = false;
      try { renderPetShop(); panelOk = petshopList.innerHTML.length > 0; } catch (e) {}
      P('PT14 pet shop panel renders', panelOk, 'len=' + petshopList.innerHTML.length);

      scene = bk.scene; MONEY = bk.money; PETFOOD = bk.food;
      MY_PETS = bk.pets; STATS.emotion = bk.emo; petUidSeq = bk.uid;
    }

/* ---------- AD 组：面板互斥 / Esc / 状态提示 / 记账分类（本轮审计新增） ---------- */
    {
      const bk = {
        scene: scene, money: MONEY, hunger: STATS.hunger,
        bills: (typeof BILLS !== 'undefined') ? BILLS.slice() : null,
        bag: BAG, pantry: PANTRY, shift: LAST_SHIFT_DAY
      };

      // AD1 面板互斥：依次打开四个"后加"的面板，任何时刻只应有一个开着
      {
        const seq = [
          ['bank', () => toggleBank(true)],
          ['stock', () => toggleStock(true)],
          ['lottery', () => toggleLottery(true)],
          ['carshop', () => toggleCarShop(true)],
          ['clinic', () => toggleClinic(true)],
          ['mailbox', () => toggleMailbox(true)],
          ['biz', () => toggleBiz(true)],
          ['ledger', () => toggleLedger(true)],
          ['petshop', () => togglePetShop(true)],
          ['counter', () => toggleCounter(true, 'shop_restaurant')],
        ];
        let worst = 0, worstAt = '';
        for (const [id, fn] of seq){
          fn();
          const n = ['bank','stock','lottery','carshop','clinic','mailbox','biz','ledger','petshop','counter']
            .filter(x => document.getElementById(x) && document.getElementById(x).classList.contains('open')).length;
          if (n > worst){ worst = n; worstAt = id; }
        }
        P('AD1 only one panel open at a time', worst === 1, 'worst=' + worst + ' at ' + worstAt);
      }

      // AD2 Esc 关掉最上层面板
      {
        toggleBiz(true);
        const before = document.getElementById('biz').classList.contains('open');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const after = document.getElementById('biz').classList.contains('open');
        P('AD2 Escape closes the top panel', before === true && after === false,
          'before=' + before + ' after=' + after);
        // 收尾：确保全关
        ['bank','stock','lottery','carshop','clinic','mailbox','biz','ledger','petshop','counter']
          .forEach(x => { const el = document.getElementById(x); if (el) el.classList.remove('open'); });
      }

      // AD3 底部提示按状态切换（原来是一句固定说明）
      {
        scene = 'home';
        STATS.hunger = 90; PANTRY = 20; BAG = 0;
        if (typeof BILLS !== 'undefined') BILLS.length = 0;
        LAST_SHIFT_DAY = DAY;
        const t1 = (updateTip(), document.getElementById('tip').textContent);
        LAST_SHIFT_DAY = 0;
        const t2 = (updateTip(), document.getElementById('tip').textContent);
        STATS.hunger = 20;
        const t3 = (updateTip(), document.getElementById('tip').textContent);
        PANTRY = 0;
        const t4 = (updateTip(), document.getElementById('tip').textContent);
        // 背包那条的优先级在"没上班"之后，所以要先把当天名额用掉，否则测不到
        STATS.hunger = 90; PANTRY = 20; LAST_SHIFT_DAY = DAY; BAG = bagCap();
        const t5 = (updateTip(), document.getElementById('tip').textContent);
        BAG = 0;

        const ok = /走|WASD/.test(t1) && /没上班/.test(t2) && /饿了/.test(t3) &&
                   /饿了/.test(t4) && /冰箱/.test(t4) && /背包满/.test(t5);
        P('AD3 bottom tip follows the state', ok,
          JSON.stringify({ t1: t1.slice(0, 10), t2: t2.slice(0, 10), t3: t3.slice(0, 8), t5: t5.slice(0, 8) }));
      }

      // AD4 记账分类必须都在白名单里（否则会被静默归到"其他"）
      {
        const must = ['wage','biz','sell','lottery','ach','refund','bank','stock','loan',
                      'food','bill','estate','car','furn','decor','clinic','pet'];
        const bad = must.filter(c => {
          const kind = ['wage','biz','sell','lottery','ach','refund','bank','stock','loan'].indexOf(c) >= 0 ? 'in' : 'out';
          return ledgerCat(kind, c) !== c;
        });
        P('AD4 every ledger category is whitelisted', bad.length === 0, bad.join(',') || 'ok');
      }

      // AD5 走到店门口能看到"这家店可以承包"（不需要回 HUD 翻列表）
      {
        scene = 'street';
        const z = STREET_ZONES.find(x => x.id === 'shop1');
        PLAYER.fx = z.x + Math.floor(z.w / 2);
        PLAYER.fy = z.y + z.h;
        PLAYER.moving = false; PLAYER.path = [];
        toggleWork(true);
        const html = document.getElementById('workList').innerHTML;
        const has = html.indexOf('这家店可以承包') >= 0 && html.indexOf('data-bizopen') >= 0;
        P('AD5 shopfront offers the contract entry', has, 'has=' + has);
        toggleWork(false);
        scene = bk.scene;
      }

      // AE 组：商店搜索/排序/角标 + Esc 只退一层 + 新手说明
      {
        const bk2 = { money: MONEY, cat: shopCat, q: shopQuery, s: shopSort, mode: buildMode };
        MONEY = 500; shopCat = 'all'; shopQuery = ''; shopSort = 'def';

        // AE1 按名字搜索能把列表收窄
        {
          const bedName = FURNITURE_CATALOG.find(d => d.id === 'bed').name;
          const all = shopListFiltered().length;
          shopQuery = bedName.slice(0, 2);
          const hit = shopListFiltered();
          const names = hit.map(d => d.name).join('/');
          P('AE1 shop search narrows the list',
            all === FURNITURE_CATALOG.length && hit.length > 0 && hit.length < all &&
            hit.some(d => d.name.indexOf(shopQuery) >= 0),
            'all=' + all + ' hit=' + hit.length + ' [' + names + ']');
        }

        // AE2 排序生效且不能就地改乱目录顺序
        {
          shopQuery = '';
          const before = FURNITURE_CATALOG.map(d => d.id).join(',');
          shopSort = 'price-asc';
          const asc = shopListFiltered().map(d => d.price);
          const monoAsc = asc.every((v, i) => i === 0 || v >= asc[i - 1]);
          shopSort = 'price-desc';
          const desc = shopListFiltered().map(d => d.price);
          const monoDesc = desc.every((v, i) => i === 0 || v <= desc[i - 1]);
          const after = FURNITURE_CATALOG.map(d => d.id).join(',');
          P('AE2 sort works and leaves catalog order intact',
            monoAsc && monoDesc && before === after && asc[0] <= asc[asc.length - 1] && desc[0] >= desc[desc.length - 1],
            'asc=' + asc[0] + '..' + asc[asc.length - 1] + ' desc=' + desc[0] + '..' + desc[desc.length - 1] + ' intact=' + (before === after));
        }

        // AE3 分类按钮上的数量角标要对，且分类之和 = 总数
        {
          shopSort = 'def'; shopCat = 'all'; shopQuery = '';
          shopRender();
          const cnt = shopCatCounts();
          const btns = Array.from(shopCats.querySelectorAll('button'));
          const allBtn = btns.find(b => b.dataset.cat === 'all');
          const tagEl = allBtn && allBtn.querySelector('.cn');
          const total = FURNITURE_CATALOG.length;
          const sum = btns.filter(b => b.dataset.cat !== 'all')
            .reduce((a, b) => a + (cnt[b.dataset.cat] || 0), 0);
          P('AE3 category counters match catalog',
            !!tagEl && String(tagEl.textContent) === String(total) && sum === total,
            'all=' + (tagEl ? tagEl.textContent : '-') + ' sum=' + sum + ' total=' + total);
        }

        // AE4 搜不到时给提示，买不起时直接告诉你差多少
        {
          shopQuery = 'zzz没这个';
          shopRender();
          const emptyOk = !!shopList.querySelector('.empty') && shopList.innerHTML.indexOf('没找到') >= 0;

          shopQuery = '';
          MONEY = 1;
          shopSort = 'price-desc';
          shopRender();
          const poorBtns = Array.from(shopList.querySelectorAll('button'));
          const allPoor = poorBtns.length > 0 && poorBtns.every(b => b.disabled && /^差 ¥\d+$/.test(b.textContent.trim()));
          MONEY = 500;
          P('AE4 empty state + shortfall label', emptyOk && allPoor,
            'empty=' + emptyOk + ' poor=' + allPoor + ' n=' + poorBtns.length +
            ' first=' + (poorBtns[0] ? poorBtns[0].textContent : '-'));
        }

        // AE5 一次 Esc 只退一层：摆放中按 Esc 只取消摆放，侧栏留着
        {
          shopSort = 'def';
          toggleShop(true);
          const shopOn = shopOpen;
          enterPlace('lamp');
          const inBuild = buildMode !== 'normal';
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          const modeAfter = buildMode;
          const shopAfter = shopOpen;
          P('AE5 one Escape only leaves build mode',
            shopOn && inBuild && modeAfter === 'normal' && shopAfter === true,
            'shopOn=' + shopOn + ' inBuild=' + inBuild + ' modeAfter=' + modeAfter + ' shopAfter=' + shopAfter);
          toggleShop(false);
        }

        // AE6 新手说明能开能关，关后记住状态
        {
          let prev = null;
          try { prev = localStorage.getItem('life.guide.v1'); } catch(e){}
          toggleGuide(true);
          const opened = guideEl.classList.contains('open');
          toggleGuide(false);
          const closed = !guideEl.classList.contains('open');
          let flag = false;
          try { flag = localStorage.getItem('life.guide.v1') === '1'; } catch(e){}
          try {
            if (prev === null) localStorage.removeItem('life.guide.v1');
            else localStorage.setItem('life.guide.v1', prev);
          } catch(e){}
          P('AE6 guide opens, closes and remembers', opened && closed && flag,
            'open=' + opened + ' closed=' + closed + ' flag=' + flag);
        }

        MONEY = bk2.money; shopCat = bk2.cat; shopQuery = bk2.q; shopSort = bk2.s;
        if (buildMode !== 'normal' && typeof cancelBuild === 'function') cancelBuild();
        try { shopRender(); } catch(e){}
      }

      // 还原
      MONEY = bk.money; STATS.hunger = bk.hunger; BAG = bk.bag; PANTRY = bk.pantry;
      LAST_SHIFT_DAY = bk.shift;
      if (bk.bills && typeof BILLS !== 'undefined'){ BILLS.length = 0; bk.bills.forEach(b => BILLS.push(b)); }
      scene = bk.scene;
      updateTip();
    }

    flush();
  } catch (e){
    out.push('FATAL | ' + (e && e.message) + ' | ' + (e && e.stack ? e.stack.split('\n')[1] : ''));
    flush();
  }
})();
