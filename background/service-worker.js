// Service Worker：只做 chrome 事件接线。
// 记录逻辑在 lib/recorder.js，数据层在 lib/db.js，停留时长见下方 dwell 区块。
import * as MyHistoryDB from '../lib/db.js';
import {
  recordTab,
  handleTabUpdated,
  clearTabState,
  urlState,
  normalizeUrl,
  isRecordableUrl,
} from '../lib/recorder.js';

// ==================== 停留时长追踪 ====================
// 活跃段存 chrome.storage.session（SW 被杀不丢段），离开时结算累加到记录
const DWELL_IDLE_SEC = 60;        // 空闲判定：60s 无输入停表
const DWELL_MIN_SEG = 5;          // <5s 的段丢弃（切标签抖动）
const DWELL_MAX_SEG = 2 * 3600;   // 单段封顶 2 小时（崩溃等极端情况）

try {
  chrome.idle.setDetectionInterval(DWELL_IDLE_SEC);
} catch (e) {
  console.error('idle API 不可用:', e);
}

async function dwellGetSeg() {
  try {
    const res = await chrome.storage.session.get('dwellSegment');
    return res.dwellSegment || null;
  } catch (e) {
    return null;
  }
}

async function dwellSetSeg(seg) {
  try {
    if (seg) await chrome.storage.session.set({ dwellSegment: seg });
    else await chrome.storage.session.remove('dwellSegment');
  } catch (e) {}
}

// 开段：tab 成为前台活跃标签
async function dwellStart(tab, now) {
  if (!tab || !tab.url || !isRecordableUrl(tab.url)) return;
  await dwellSetSeg({
    tabId: tab.id,
    normalized: normalizeUrl(tab.url),
    startedAt: now,
    incognito: !!tab.incognito,
  });
}

// 结算：把当前段累加到对应记录（按归一化 URL 定位，查不到则丢弃）
async function dwellStop(now) {
  const seg = await dwellGetSeg();
  if (!seg) return;
  await dwellSetSeg(null);
  let seconds = Math.floor((now - seg.startedAt) / 1000);
  if (seconds < DWELL_MIN_SEG) return;
  if (seconds > DWELL_MAX_SEG) seconds = DWELL_MAX_SEG;

  try {
    let storeName = null;
    let recordId = null;
    if (seg.incognito) {
      const recs = await MyHistoryDB.getIncognitoHistory(now - 86400000, now);
      const rec = recs.find((r) => normalizeUrl(r.url) === seg.normalized);
      if (rec) {
        storeName = MyHistoryDB.INCOGNITO_STORE;
        recordId = rec.id;
      }
    } else {
      const st = urlState.get(seg.normalized);
      if (st) {
        storeName = st.storeName;
        recordId = st.recordId;
      } else {
        const recs = await MyHistoryDB.getHistoryByRange(now - 86400000, now);
        const rec = recs.find((r) => normalizeUrl(r.url) === seg.normalized);
        if (rec) {
          storeName = MyHistoryDB.storeNameForTimestamp(rec.timestamp);
          recordId = rec.id;
        }
      }
    }
    if (!storeName || recordId == null) return;
    await MyHistoryDB.addDwellTime(storeName, recordId, seconds);
  } catch (e) {
    console.error('结算停留时长失败:', e);
  }
}

// 恢复活跃：给焦点窗口的活跃 tab 开新段
async function dwellResumeActive() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab) await dwellStart(tab, Date.now());
  } catch (e) {}
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await dwellStop(Date.now());
  try {
    const tab = await chrome.tabs.get(tabId);
    await dwellStart(tab, Date.now());
  } catch (e) {
    // 标签可能已被关闭
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  await dwellStop(Date.now());
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // 失焦：停表
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await dwellStart(tab, Date.now());
  } catch (e) {}
});

chrome.idle.onStateChanged.addListener(async (state) => {
  await dwellStop(Date.now());
  if (state === 'active') await dwellResumeActive();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // 活跃标签 URL 变化（SPA 路由）：停留段切到新 URL
  if (changeInfo.url && tab && tab.active) {
    dwellStop(Date.now()).then(() => dwellStart(tab, Date.now()));
  }

  handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTabState(tabId);
  // 关闭的是正在计时的标签：结算
  const seg = await dwellGetSeg();
  if (seg && seg.tabId === tabId) await dwellStop(Date.now());
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/history/history.html') });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('我的历史记录扩展已安装 v2（按年分库 + 抖动过滤）');
});
