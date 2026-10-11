// 停留时长采集：纯逻辑 + 控制器工厂，chrome API 一律由 service-worker 注入
//
// 多目标模型：候选来自所有普通窗口的活动标签（collectDwellTargets），
// 控制器对每个候选用 shouldCount 决定是否计入——收集阶段不做纳入判断，
// 否则缓冲期 playing:false 会让目标从候选中消失、120s 去抖失效，每次缓冲断一段。
// 段状态存 chrome.storage.session（注入），SW 被杀不丢段。
// 三条硬约束：
// 1) MV3 SW 静默 ~30s 回收 → 播放期间 content script 20s 心跳 + 计时期间 1 分钟
//    心跳 alarm（alarm 能唤醒 SW），长会话按增量落库不丢失
// 2) 合盖睡眠/强杀的超长区间 → 单段结算封顶 MAX_DELTA，截断部分主动丢弃
// 3) 跨本地午夜按天拆分落库
import { getDateKey } from './utils.js';
import { isRecordableUrl, normalizeUrl } from './recorder.js';
import { DEFAULT_SETTINGS } from './settings.js';

export const DWELL_MIN_SEG_MS = 5 * 1000; // <5s 的段丢弃（切标签抖动）
export const DWELL_MAX_DELTA_MS = 90 * 1000; // 单次结算增量上限（睡眠截断）
export const MEDIA_PLAYING_TTL_MS = 45 * 1000; // 帧心跳有效期（SW 派生 playingTabIds 用）
export const MEDIA_GRACE_MS = 120 * 1000; // 播放迹象去抖（控制器按目标隔离）

// 收集计时候选：只做结构性过滤（普通窗口/可见状态/活动标签/可记录地址），
// 不做"是否在播/是否聚焦"的纳入判断——那是控制器的 shouldCount 职责。
export function collectDwellTargets(windows, playingTabIds) {
  const playing = playingTabIds instanceof Set ? playingTabIds : new Set();
  const out = [];
  for (const win of windows || []) {
    if (!win || win.type !== 'normal') continue;
    if (win.state === 'minimized' || win.state === 'locked-fullscreen') continue;
    const tab = (win.tabs || []).find(t => t.active);
    if (!tab || !tab.url || !isRecordableUrl(tab.url)) continue;
    out.push({
      key: 'tab:' + tab.id,
      tabId: tab.id,
      url: tab.url,
      normalized: normalizeUrl(tab.url),
      incognito: !!tab.incognito,
      windowFocused: !!win.focused,
      windowState: win.state,
      audible: !!tab.audible,
      mediaPlaying: playing.has(tab.id),
    });
  }
  return out;
}

// 是否应计入停留：可记录地址 + （窗口聚焦 或 媒体在播）+ 窗口可见 + （系统非空闲 或 媒体在播）。
// 注意：
// - 最大化/全屏属于正常观看状态，只有 minimized / locked-fullscreen 不计时
//   （不能要求 state === 'normal'，否则绝大多数用户都不计时）
// - 失焦（分屏/副屏看视频、切到其他应用）时，媒体在播即继续计时——
//   "有声音就算时间"；无声音的窗口失焦即停
// - 系统空闲只看键鼠输入，会把"挂机"和"看视频"混为一谈；媒体在播可区分二者
export function shouldCount({ url, windowFocused, windowState, idleState, audible }) {
  if (!url || !isRecordableUrl(url)) return false;
  if (!windowFocused && !audible) return false;
  if (windowState === 'minimized' || windowState === 'locked-fullscreen') return false;
  if (idleState && idleState !== 'active' && !audible) return false;
  return true;
}

// 按本地午夜切分 [from, to)，避免跨午夜的那一段整块归到结算日
export function splitAcrossMidnight(fromTs, toTs) {
  const out = [];
  let cursor = fromTs;
  while (cursor < toTs) {
    const next = new Date(cursor);
    next.setHours(24, 0, 0, 0); // 次日 00:00（本地时区）
    const end = Math.min(toTs, next.getTime());
    out.push({ day: getDateKey(cursor), ms: end - cursor });
    cursor = end;
  }
  return out;
}

// 控制器工厂。deps 全部由 service-worker 注入：
//   session               chrome.storage.session
//   getSettings()         -> { recordDwell, idleThresholdSec, ... }
//   setIdleThreshold(sec) 冷启动与改设置时都要重设（只对当前 SW 实例生效）
//   addDwellTime(storeName, recordId, seconds, dayKey)
//   locateRecord(normalized, incognito, now) -> { storeName, recordId } | null
//   syncAlarm(active)     心跳 alarm 自愈式增删
//   getDwellTargets(now)  -> collectDwellTargets 的结果（候选目标数组）
//   getIdleState(sec)     -> 'active' | 'idle' | 'locked' | ...
//   log(...)              可选；只打开段（计时目标变化）与异常结算（丢弃/截断）
export function createDwellController(deps) {
  const SESS_KEY = 'dwellSegments';
  const LEGACY_SESS_KEY = 'dwellSegment'; // 旧单段键：首次读取时清除
  let settings = { ...DEFAULT_SETTINGS };
  let chain = Promise.resolve(); // 串行化结算：并发的 alarm 心跳与标签切换不会双计同一区间
  let lastMediaAt = new Map(); // 目标 key -> 最近播放迹象时间（按目标隔离去抖）
  let lastLogged = new Map(); // 目标 key -> 上次打日志的 normalized（降噪）

  async function getSegments() {
    try {
      const res = await deps.session.get([SESS_KEY, LEGACY_SESS_KEY]);
      if (res && res[LEGACY_SESS_KEY] !== undefined) {
        try {
          await deps.session.remove(LEGACY_SESS_KEY);
        } catch (e) {}
      }
      const obj = res && res[SESS_KEY];
      if (obj && typeof obj === 'object') return new Map(Object.entries(obj));
    } catch (e) {}
    return new Map();
  }

  async function setSegments(segs) {
    try {
      if (segs && segs.size > 0)
        await deps.session.set({ [SESS_KEY]: Object.fromEntries(segs) });
      else await deps.session.remove(SESS_KEY);
    } catch (e) {}
  }

  // 结算全部旧段：增量封顶 + 跨零点拆分 + <5s 丢弃，结束后清空
  // （refresh 随后按当前 targets 重开，一律以"现在"为新基线）
  async function settleAll(now, reason) {
    const segs = await getSegments();
    for (const seg of segs.values()) {
      const delta = now - seg.startedAt;
      if (delta <= 0) continue;
      const committed = Math.min(delta, DWELL_MAX_DELTA_MS);
      const truncated = committed < delta;
      const dropped = committed < DWELL_MIN_SEG_MS || seg.recordId == null;
      // 日志降噪：例行结算不打，只留异常（丢弃/截断）
      if (deps.log && (dropped || truncated)) {
        deps.log('结算（异常）', {
          reason,
          tabId: seg.tabId,
          url: seg.normalized,
          deltaSec: Math.round(delta / 1000),
          committedSec: Math.round(committed / 1000),
          dropped,
          truncated,
        });
      }
      let { storeName, recordId } = seg;
      if (recordId == null) {
        // 开段时记录可能尚未创建（页面还在加载），结算时再定位一次
        const loc = await deps.locateRecord(seg.normalized, seg.incognito, now);
        if (loc) {
          storeName = loc.storeName;
          recordId = loc.recordId;
        }
      }
      if (committed >= DWELL_MIN_SEG_MS && storeName != null && recordId != null) {
        for (const p of splitAcrossMidnight(seg.startedAt, seg.startedAt + committed)) {
          const secs = Math.round(p.ms / 1000);
          if (secs > 0) await deps.addDwellTime(storeName, recordId, secs, p.day);
        }
      }
      // committed < delta 的部分（睡眠/强杀导致的超时）有意丢弃
    }
    await setSegments(new Map());
  }

  // 唯一入口：结算全部旧段，再按"当前谁该计时"重开或清除对应段。
  // 所有事件（切标签/窗口焦点/idle/URL 变化/心跳 alarm/设置变更/媒体消息）都汇到这里，
  // 一律以"现在"为新基线，绝不按历史时间戳补算。
  function refresh(now, reason = 'event') {
    chain = chain.then(async () => {
      await settleAll(now, reason);
      const targets = await deps.getDwellTargets(now);
      const idleState = await deps.getIdleState(settings.idleThresholdSec);

      // 更新各目标的播放迹象时间，并剪枝已过宽限期的键
      for (const t of targets) {
        if (t.audible || t.mediaPlaying) lastMediaAt.set(t.key, now);
      }
      for (const [k, ts] of lastMediaAt) {
        if (now - ts > MEDIA_GRACE_MS) lastMediaAt.delete(k);
      }

      const segments = new Map();
      if (settings.recordDwell) {
        for (const t of targets) {
          // 播放迹象去抖：刚出过声/刚在播（<120s）的目标即使此刻信号中断也视为在播
          const audible = !!(
            t.audible ||
            t.mediaPlaying ||
            now - (lastMediaAt.get(t.key) || 0) < MEDIA_GRACE_MS
          );
          if (
            !shouldCount({
              url: t.url,
              windowFocused: t.windowFocused,
              windowState: t.windowState,
              idleState,
              audible,
            })
          )
            continue;
          const loc = await deps.locateRecord(t.normalized, t.incognito, now);
          segments.set(t.key, {
            key: t.key,
            tabId: t.tabId,
            normalized: t.normalized,
            incognito: t.incognito,
            storeName: loc ? loc.storeName : null,
            recordId: loc ? loc.recordId : null,
            startedAt: now,
          });
          // 日志降噪：只有计时目标变化（换了页面/标签）才打"开段"
          if (deps.log && lastLogged.get(t.key) !== t.normalized) {
            lastLogged.set(t.key, t.normalized);
            deps.log('开段', {
              reason,
              tabId: t.tabId,
              url: t.normalized,
              audible: t.audible,
              mediaPlaying: t.mediaPlaying,
              idleState,
            });
          }
        }
      }
      await setSegments(segments);
      for (const k of [...lastLogged.keys()]) {
        if (!segments.has(k)) lastLogged.delete(k);
      }

      // 看门狗：用户在场（有聚焦窗口）时保留 alarm 兜底重查——
      // 因空闲停表的场景，播放恢复/重新活跃无需用户输入即可自动续计；
      // 人离开（全部失焦）且无段时撤掉，避免 alarm 空转。
      const watchdog =
        settings.recordDwell &&
        idleState !== 'locked' &&
        targets.some(t => t.windowFocused);
      await deps.syncAlarm(segments.size > 0 || watchdog);
    }).catch(() => {});
    return chain;
  }

  async function loadSettings() {
    try {
      const s = await deps.getSettings();
      settings = {
        recordDwell: s.recordDwell !== false,
        idleThresholdSec: Number(s.idleThresholdSec) || DEFAULT_SETTINGS.idleThresholdSec,
      };
    } catch (e) {}
    deps.setIdleThreshold(settings.idleThresholdSec);
    return settings;
  }

  return { refresh, loadSettings };
}
