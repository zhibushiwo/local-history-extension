// Service Worker：只做 chrome 事件接线。
// 记录逻辑在 lib/recorder.js，停留时长在 lib/dwell.js，数据层在 lib/db.js
import * as MyHistoryDB from '../lib/db.js';
import {
  handleTabUpdated,
  clearTabState,
  locateRecord,
} from '../lib/recorder.js';
import { getSettings } from '../lib/settings.js';
import {
  createDwellController,
  collectDwellTargets,
  MEDIA_PLAYING_TTL_MS,
} from '../lib/dwell.js';

// ─────────────────────────────────────────────────────────────
// 停留时长采集（多目标）：每个普通窗口的活动标签都是候选，
// 控制器按 shouldCount 逐个决定是否计时——分屏/副屏多个视频并发计时。
// 媒体播放信号由 content script 按帧上报（tabId:frameId 隔离，
// 广告 iframe 的 false 不会清掉主播放器状态）。
// 设计细节见 lib/dwell.js 头注释。
// ─────────────────────────────────────────────────────────────
const DWELL_ALARM = 'dwell-flush';

// 按帧媒体状态：`${tabId}:${frameId}` -> 最近一次"正在播放"的时间。
// 内存态即可：SW 重启后 content script 的心跳会自动补上。
const mediaPlayingAt = new Map();

const dwell = createDwellController({
  session: chrome.storage.session,
  getSettings,
  setIdleThreshold(sec) {
    // setDetectionInterval 只对当前 SW 实例生效，每次冷启动/改设置都必须重设
    try {
      chrome.idle.setDetectionInterval(sec);
    } catch (e) {}
  },
  addDwellTime: (storeName, recordId, seconds, dayKey) =>
    MyHistoryDB.addDwellTime(storeName, recordId, seconds, dayKey),
  locateRecord,
  log: (...args) => console.warn('[dwell]', ...args),
  async getDwellTargets(now) {
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      const playing = new Set();
      for (const [k, ts] of mediaPlayingAt) {
        if (now - ts < MEDIA_PLAYING_TTL_MS) playing.add(Number(k.split(':')[0]));
      }
      return collectDwellTargets(wins, playing);
    } catch (e) {
      return []; // 枚举失败退化为不计时
    }
  },
  getIdleState(thresholdSec) {
    // idle.queryState 的 Promise 形式需要 Chrome 116+，统一走回调形式
    return new Promise((resolve) => {
      try {
        chrome.idle.queryState(thresholdSec, (state) => resolve(state || 'active'));
      } catch (e) {
        resolve('active');
      }
    });
  },
});

// 冷启动初始化：重设空闲阈值 + settle-all 后按当前 targets 重建（不按历史补算）
dwell
  .loadSettings()
  .then(() => dwell.refresh(Date.now(), 'startup'))
  .catch(() => {});

// 媒体消息监听放在 dwell 创建之后（消息可能早于模块求值完成到达，避免 TDZ）
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'MEDIA_STATE' && sender.tab) {
    const key = sender.tab.id + ':' + sender.frameId;
    const had = mediaPlayingAt.has(key);
    if (msg.playing) {
      mediaPlayingAt.set(key, Date.now());
      if (!had) console.debug('[dwell] media playing start', key);
    } else {
      mediaPlayingAt.delete(key);
      if (had) console.debug('[dwell] media playing stop', key);
    }
    dwell.refresh(Date.now(), 'media-state');
  }
});

chrome.tabs.onActivated.addListener(() => dwell.refresh(Date.now(), 'tab-activated'));

chrome.windows.onFocusChanged.addListener(() => dwell.refresh(Date.now(), 'window-focus'));

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
  for (const k of [...mediaPlayingAt.keys()]) {
    if (Number(k.split(':')[0]) === tabId) mediaPlayingAt.delete(k);
  }
  dwell.refresh(Date.now(), 'tab-removed');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 活动标签 URL 变化（SPA 路由）：停留目标切到新 URL
  if (changeInfo.url && tab && tab.active) dwell.refresh(Date.now(), 'url-change');
  handleTabUpdated(tabId, changeInfo, tab);
});

chrome.idle.onStateChanged.addListener(() => dwell.refresh(Date.now(), 'idle-change'));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DWELL_ALARM) dwell.refresh(Date.now(), 'alarm');
});

// 设置变化（关闭/开启停留记录、改空闲阈值）热生效
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    dwell
      .loadSettings()
      .then(() => dwell.refresh(Date.now(), 'settings-change'))
      .catch(() => {});
  }
});

// 快捷键：Ctrl+Shift+H 打开历史记录页
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-history') {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/history/history.html') });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('我的历史记录 v2.2 已安装/更新（暖色 UI · 统计增强 · 多窗口视频计时）');
});
