// Service Worker：只做 chrome 事件接线。
// 记录逻辑在 lib/recorder.js，停留时长在 lib/dwell.js，数据层在 lib/db.js
import * as MyHistoryDB from '../lib/db.js';
import {
  handleTabUpdated,
  clearTabState,
  normalizeUrl,
  locateRecord,
} from '../lib/recorder.js';
import { getSettings } from '../lib/settings.js';
import { createDwellController } from '../lib/dwell.js';

// ─────────────────────────────────────────────────────────────
// 停留时长采集
// MV3 的 SW 静默约 30s 被回收 → 计时期间挂 1 分钟心跳 alarm（alarm 能唤醒 SW），
// 长会话按分钟增量落库不丢失；合盖睡眠产生的超长区间按增量上限截断丢弃，
// 绝不按墙钟时间补算（否则合盖 8 小时会被记成 2 小时浏览）。
// 设计细节见 lib/dwell.js 头注释。
// ─────────────────────────────────────────────────────────────
const DWELL_ALARM = 'dwell-flush';

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
  async syncAlarm(active) {
    // 心跳只在计时期间存在；alarm 在 SW 终止后依然存活，自愈式增删
    try {
      const exists = await new Promise((resolve) => {
        try {
          chrome.alarms.get(DWELL_ALARM, (a) => resolve(!!a));
        } catch (e) {
          resolve(false);
        }
      });
      if (active && !exists) chrome.alarms.create(DWELL_ALARM, { periodInMinutes: 1 });
      else if (!active && exists) chrome.alarms.clear(DWELL_ALARM);
    } catch (e) {}
  },
  async getActiveContext() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (!tab || !tab.url) return null;
      let windowState = 'normal';
      let windowFocused = false;
      try {
        const win = await chrome.windows.get(tab.windowId);
        windowState = win.state;
        windowFocused = !!win.focused;
      } catch (e) {}
      return {
        tabId: tab.id,
        url: tab.url,
        normalized: normalizeUrl(tab.url),
        incognito: !!tab.incognito,
        windowFocused,
        windowState,
        audible: !!tab.audible, // 正在出声（视频/音频）：空闲判定豁免
      };
    } catch (e) {
      return null;
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

// 冷启动初始化：重设空闲阈值 + 以当前时间重建基线（不按历史时间戳补算）
dwell
  .loadSettings()
  .then(() => dwell.refresh(Date.now()))
  .catch(() => {});

chrome.tabs.onActivated.addListener(() => dwell.refresh(Date.now()));

chrome.windows.onFocusChanged.addListener(() => dwell.refresh(Date.now()));

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabState(tabId);
  dwell.refresh(Date.now());
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 活跃标签 URL 变化（SPA 路由）：停留段切到新 URL
  if (changeInfo.url && tab && tab.active) dwell.refresh(Date.now());
  handleTabUpdated(tabId, changeInfo, tab);
});

chrome.idle.onStateChanged.addListener(() => dwell.refresh(Date.now()));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DWELL_ALARM) dwell.refresh(Date.now());
});

// 设置变化（关闭/开启停留记录、改空闲阈值）热生效
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    dwell
      .loadSettings()
      .then(() => dwell.refresh(Date.now()))
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
  console.log('我的历史记录 v2.1 已安装/更新（模块化 · 暖色 UI · 统计增强）');
});
