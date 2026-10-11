// 停留时长采集：纯逻辑 + 控制器工厂，chrome API 一律由 service-worker 注入
//
// 三条硬约束决定了实现方式：
// 1) MV3 的 SW 静默约 30s 后被回收 → 计时期间挂 1 分钟心跳 alarm（alarm 能唤醒 SW），
//    长时间停留同一页面的会话按分钟增量落库，不会整段丢失；
//    段状态存 chrome.storage.session（注入），SW 被杀后不丢段
// 2) 合盖睡眠/强杀会产生超长"假在看"区间 → 单次结算增量封顶 MAX_DELTA_MS，
//    截断的剩余部分主动丢弃，绝不按墙钟时间补算
// 3) 跨本地午夜的段按天拆分落库，不整段归到结算那天
import { getDateKey } from './utils.js';
import { isRecordableUrl } from './recorder.js';
import { DEFAULT_SETTINGS } from './settings.js';

export const DWELL_MIN_SEG_MS = 5 * 1000; // <5s 的段丢弃（切标签抖动）
export const DWELL_MAX_DELTA_MS = 90 * 1000; // 单次结算增量上限（睡眠截断）

// 按本地午夜切分 [from, to) → [{ day: 'YYYY-MM-DD', ms }]
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

// 是否应计入停留：可记录地址 + 窗口聚焦可见 + （系统非空闲 或 正在出声）。
// 注意：
// - 最大化/全屏属于正常观看状态，只有 minimized / locked-fullscreen 不计时
//   （不能要求 state === 'normal'，否则绝大多数用户都不计时）
// - 系统空闲只看键鼠输入，会把"挂机"和"看视频"混为一谈；tab.audible
//   （标签页正在出声）可区分二者：看视频无键鼠输入也照样计时（实测 2 分钟
//   视频只记 61s 的根因即此）。盲区：静音播放不置 audible
export function shouldCount({ url, windowFocused, windowState, idleState, audible }) {
  if (!url || !isRecordableUrl(url)) return false;
  if (!windowFocused) return false;
  if (windowState === 'minimized' || windowState === 'locked-fullscreen') return false;
  if (idleState && idleState !== 'active' && !audible) return false;
  return true;
}

// 控制器工厂。deps 全部由 service-worker 注入：
//   session               chrome.storage.session
//   getSettings()         -> { recordDwell, idleThresholdSec, ... }
//   setIdleThreshold(sec) 冷启动与改设置时都要重设（只对当前 SW 实例生效）
//   addDwellTime(storeName, recordId, seconds, dayKey)
//   locateRecord(normalized, incognito, now) -> { storeName, recordId } | null
//   syncAlarm(active)     心跳 alarm 自愈式增删
//   getActiveContext()    -> { tabId, url, normalized, incognito, windowFocused, windowState } | null
//   getIdleState(sec)     -> 'active' | 'idle' | 'locked' | ...
export function createDwellController(deps) {
  const SESS_KEY = 'dwellSegment';
  const AUDIBLE_GRACE_MS = 120 * 1000; // 出声去抖：静音间隙/缓冲导致 audible 短暂为 false 时不断表
  let settings = { ...DEFAULT_SETTINGS };
  let chain = Promise.resolve(); // 串行化结算：并发的 alarm 心跳与标签切换不会双计同一区间
  let lastAudibleAt = 0; // 最近一次检测到标签出声的时间（内存态；SW 重启后变严格，可接受）

  async function getSeg() {
    try {
      const res = await deps.session.get(SESS_KEY);
      return res.dwellSegment || null;
    } catch (e) {
      return null;
    }
  }

  async function setSeg(seg) {
    try {
      if (seg) await deps.session.set({ [SESS_KEY]: seg });
      else await deps.session.remove(SESS_KEY);
    } catch (e) {}
  }

  // 结算当前段：增量封顶 + 跨零点拆分 + <5s 丢弃，结算后清除旧段
  // （调用方 refresh 随后会按当前上下文决定是否开新段）
  async function settleNow(now) {
    const seg = await getSeg();
    if (!seg) return;
    await setSeg(null);
    const delta = now - seg.startedAt;
    if (delta <= 0) return;
    const committed = Math.min(delta, DWELL_MAX_DELTA_MS);

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

  // 唯一入口：结算上一个目标，再按"当前该不该计时"重开或清除段。
  // 所有事件（切标签/窗口焦点/idle/URL 变化/心跳 alarm/设置变更）都汇到这里，
  // 一律以"现在"为新基线，绝不按历史时间戳补算。
  function refresh(now) {
    chain = chain.then(async () => {
      await settleNow(now);
      const ctx = await deps.getActiveContext();
      const idleState = await deps.getIdleState(settings.idleThresholdSec);
      if (ctx && ctx.audible) lastAudibleAt = now;
      // audible 去抖：刚出过声（<120s）的标签即使此刻静音也视为出声
      const audible = !!(ctx && (ctx.audible || now - lastAudibleAt < AUDIBLE_GRACE_MS));
      const ok =
        settings.recordDwell &&
        ctx &&
        shouldCount({
          url: ctx.url,
          windowFocused: ctx.windowFocused,
          windowState: ctx.windowState,
          idleState,
          audible,
        });
      if (ok) {
        const loc = await deps.locateRecord(ctx.normalized, ctx.incognito, now);
        await setSeg({
          tabId: ctx.tabId,
          normalized: ctx.normalized,
          incognito: ctx.incognito,
          storeName: loc ? loc.storeName : null,
          recordId: loc ? loc.recordId : null,
          startedAt: now,
        });
        await deps.syncAlarm(true);
      } else {
        await setSeg(null);
        // 看门狗：仅因"系统空闲且前台标签无出声"停表时保留 alarm，
        // 每分钟重查一次——声音恢复（视频续播）无需用户输入即可自动恢复计时。
        // 失焦/最小化/无前台标签/锁屏/功能关闭等情形照旧撤掉 alarm（重查也不会恢复）。
        const idlePaused =
          settings.recordDwell &&
          ctx &&
          idleState !== 'locked' &&
          ctx.windowFocused &&
          ctx.windowState !== 'minimized' &&
          ctx.windowState !== 'locked-fullscreen';
        await deps.syncAlarm(!!idlePaused);
      }
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
