/**
 * 版本与升级判定（纯函数，可单测）。
 *
 * 四套版本号各管一件事，不要混用：
 *   appVersion    客户端构建版本（改了游戏代码就 +1）——决定"你的客户端是不是旧的"
 *   contentVersion 内容结构版本（改了 content/ 的结构就 +1）——决定"服务端有没有新内容"
 *   contentHash   内容指纹（构建产物指纹）——只用于日志/人工核对，参与自动判定会让两边天天"不一致"
 *   saveSchema    存档结构版本（改了存档字段就 +1）——驱动迁移函数
 */
import { BUILD } from '../version.generated.js';

/** 本次构建的版本信息（构建时注入） */
export const CLIENT = BUILD;

/** 解析 "1.6.0" / "1.6.0+ab12cd34" / "1.6.0-beta.1" */
export function parseVersion(v){
  const s = String(v || '').trim().split('+')[0];
  const [core, pre] = s.split('-');
  const nums = core.split('.').map(n => {
    const x = parseInt(n, 10);
    return isNaN(x) ? 0 : x;
  });
  while (nums.length < 3) nums.push(0);
  return { major: nums[0], minor: nums[1], patch: nums[2], pre: pre || '' };
}

/**
 * 比较两个版本号：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * 规则：主次修订依次比较；正式版 > 预发布版；构建元数据（+xxx）不参与比较。
 */
export function compareVersion(a, b){
  const A = parseVersion(a), B = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']){
    if (A[k] !== B[k]) return A[k] > B[k] ? 1 : -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;          // 1.6.0 > 1.6.0-beta
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

/**
 * 判定客户端与服务端的版本关系。
 * @param {{appVersion:string, contentVersion:number, contentHash:string}} client
 * @param {{appVersion?:string, contentVersion:number, contentHash:string, minAppVersion?:string}} server
 * @returns {{status:'ok'|'content-updated'|'client-outdated'|'server-outdated', message:string, action:string}}
 *   ok              版本一致，什么都不用做
 *   content-updated 服务端内容更新（客户端内联的是旧内容）→ 提示刷新
 *   client-outdated 客户端太旧，服务端已不接受 → 强制刷新
 *   server-outdated 服务端内容比客户端旧（服务端没重启/没 bundle）→ 提示运维
 */
export function evaluateUpdate(client, server){
  const c = client || {};
  const s = server || {};

  if (s.minAppVersion && compareVersion(c.appVersion || '0.0.0', s.minAppVersion) < 0){
    return {
      status: 'client-outdated',
      message: '客户端版本过旧（' + (c.appVersion || '?') + ' < ' + s.minAppVersion + '），请刷新页面',
      action: 'reload'
    };
  }
  const scv = Number(s.contentVersion || 0);
  const ccv = Number(c.contentVersion || 0);
  if (scv > ccv){
    return {
      status: 'content-updated',
      message: '服务端内容已更新（内容 ' + scv + ' > 本地 ' + ccv + '），刷新后可获得新家具/新规则',
      action: 'reload'
    };
  }
  if (scv < ccv){
    return {
      status: 'server-outdated',
      message: '服务端内容较旧（内容 ' + scv + ' < 本地 ' + ccv + '），请重启服务端或重新 bundle',
      action: 'warn'
    };
  }
  // 注意：contentHash 不参与判定。客户端指纹取自 generated.js、服务端取自 content.json，
  // 两者输入不同，直接比较必然不等 → 会天天误报"需要刷新"。
  // 指纹只用于日志与人工核对（构建产物是否一致）。
  return { status: 'ok', message: '版本一致（客户端 ' + (c.appVersion || '?') + ' · 内容 ' + ccv + '）', action: 'none' };
}

/** 存档是否需要迁移 */
export function needsSaveMigration(save, targetSchema){
  const cur = (save && save.schema) || 1;      // 老存档没有 schema 字段 → 视为 1
  return targetSchema > cur;
}

/**
 * 模块级差异：客户端与服务端逐个模块比对指纹，返回变化的模块清单。
 * @param {{modules:Object}} client
 * @param {{modules:Object}} server
 * @returns {Array<{id:string, from:number|null, to:number|null, kind:'new'|'content'|'code'}>}
 */
export function diffModules(client, server){
  const c = (client && client.modules) || {};
  const s = (server && server.modules) || {};
  const changed = [];
  for (const id of Object.keys(s)){
    const sv = s[id] || {};
    const cv = c[id];
    if (!cv){
      changed.push({ id, from: null, to: sv.version, kind: 'new' });
      continue;
    }
    if (cv.hash !== sv.hash){
      changed.push({ id, from: cv.version, to: sv.version, kind: sv.version == null ? 'code' : 'content' });
    }
  }
  return changed;
}

/** 只有内容包能热替换；代码模块变化必须重新加载页面 */
export function splitHotPatchable(changed){
  const hot = [];
  const needsReload = [];
  for (const m of changed){
    if (m.id.startsWith('content/')) hot.push(m);
    else needsReload.push(m);
  }
  return { hot, needsReload };
}
