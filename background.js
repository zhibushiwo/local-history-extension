importScripts('db.js');

// 1 分钟内的相同 URL 视为同一次访问，累加 visitCount
const VISIT_DEDUPE_WINDOW = 1 * 60 * 1000;

// 1 秒内的相同 URL 直接忽略（防止页面加载抖动造成假计数）
const IGNORE_WINDOW = 1.5 * 1000;

// URL 比对时忽略的追踪参数
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'spm_id_from', 'vd_source', 'from_spmid', 'from_source',
  'share_source', 'share_medium', 'share_plat', 'share_session_id', 'share_tag',
  'trackid', 'unique_k', 'from', 'buvid', 'seid', 'bbid', 'ts', '_t'
];

// normalizedUrl -> { recordId, storeName, lastTime }
const urlState = new Map();

// tabId -> timer（用于 debounce）
const pendingTimers = new Map();

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));
    u.searchParams.sort();
    return (u.origin + u.pathname + (u.search || '')).replace(/[?&]$/, '');
  } catch (e) {
    return rawUrl;
  }
}

function isRecordableUrl(url) {
  if (!url) return false;
  if (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://')
  ) {
    return false;
  }
  return /^https?:|^file:/.test(url);
}

// 标题/图标变化：只更新内容与时间戳，不计访问次数
async function patchVisitContent(storeName, id, tab, now) {
  const patch = { timestamp: now };
  if (tab.title) patch.title = tab.title;
  if (tab.favIconUrl) patch.favicon = tab.favIconUrl;
  return MyHistoryDB.patchRecord(storeName, id, patch);
}

// 尝试在已有记录上更新，成功返回 true
// isLoad = 本次事件里包含真实的页面加载（status === 'complete'）
async function tryUpdateExisting(normalized, tab, now, isLoad) {
  // 1. 内存命中
  const state = urlState.get(normalized);
  if (state) {
    const delta = now - state.lastTime;

    if (delta < IGNORE_WINDOW) {
      // 太近，直接忽略
      return true;
    }

    if (delta < VISIT_DEDUPE_WINDOW) {
      state.lastTime = now;
      try {
        if (isLoad) {
          // 真实页面加载/刷新：累加访问次数
          await MyHistoryDB.updateRecord(state.storeName, state.recordId, {
            timestamp: now,
            title: tab.title,
            favicon: tab.favIconUrl
          });
        } else {
          // 仅标题/图标变化（SPA 常见）：不累加次数
          await patchVisitContent(state.storeName, state.recordId, tab, now);
        }
      } catch (e) {
        console.error('更新记录失败:', e);
      }
      return true;
    }
  }

  // 2. 内存没命中，查 DB（防止 Service Worker 重启丢失内存状态）
  try {
    const recent = await MyHistoryDB.getHistoryByRange(now - VISIT_DEDUPE_WINDOW, now);
    const match = recent.find((r) => normalizeUrl(r.url) === normalized);
    if (match) {
      const lastTime = match.lastVisit || match.timestamp;
      const delta = now - lastTime;

      if (delta < IGNORE_WINDOW) {
        // 太近，直接忽略
        return true;
      }

      const storeName = MyHistoryDB.storeNameForTimestamp(match.timestamp);
      if (isLoad) {
        await MyHistoryDB.updateRecord(storeName, match.id, {
          timestamp: now,
          title: tab.title,
          favicon: tab.favIconUrl
        });
      } else {
        await patchVisitContent(storeName, match.id, tab, now);
      }
      urlState.set(normalized, {
        recordId: match.id,
        storeName,
        lastTime: now
      });
      return true;
    }
  } catch (e) {
    console.error('查询近期记录失败:', e);
  }

  return false;
}

async function recordTab(tab, isLoad) {
  if (!tab || !tab.url || !isRecordableUrl(tab.url)) return;

  // 暂停记录开关：跳过所有记录
  try {
    const { recordingPaused } = await chrome.storage.local.get('recordingPaused');
    if (recordingPaused) return;
  } catch (e) {
    console.error('读取暂停标记失败:', e);
  }

  // 无痕窗口：写入独立的无痕 store，与普通历史完全隔离
  if (tab.incognito) {
    await recordIncognitoTab(tab, isLoad);
    return;
  }

  const now = Date.now();
  const normalized = normalizeUrl(tab.url);

  if (await tryUpdateExisting(normalized, tab, now, isLoad)) {
    return;
  }

  // 新建记录
  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch (e) { domain = ''; }

  const record = {
    url: tab.url,
    title: tab.title || tab.url,
    domain: domain,
    timestamp: now,
    favicon: tab.favIconUrl || '',
    visitCount: 1,
    lastVisit: now
  };

  try {
    const { id, storeName } = await MyHistoryDB.addHistory(record);
    urlState.set(normalized, { recordId: id, storeName, lastTime: now });
    console.log('已记录:', record.title);
  } catch (e) {
    console.error('记录历史失败:', e);
  }
}

// 无痕访问的内存去重状态（SW 被杀后重建，仅影响去重精度，不影响数据）
const incognitoState = new Map();

async function recordIncognitoTab(tab, isLoad) {
  const now = Date.now();
  const normalized = normalizeUrl(tab.url);

  const state = incognitoState.get(normalized);
  if (state) {
    const delta = now - state.lastTime;
    if (delta < IGNORE_WINDOW) return;
    if (delta < VISIT_DEDUPE_WINDOW) {
      state.lastTime = now;
      try {
        if (isLoad) {
          await MyHistoryDB.updateRecord(MyHistoryDB.INCOGNITO_STORE, state.recordId, {
            timestamp: now,
            title: tab.title,
            favicon: tab.favIconUrl,
          });
        } else {
          await patchVisitContent(MyHistoryDB.INCOGNITO_STORE, state.recordId, tab, now);
        }
      } catch (e) {
        console.error('更新无痕记录失败:', e);
      }
      return;
    }
  }

  let domain = '';
  try { domain = new URL(tab.url).hostname; } catch (e) {}

  const record = {
    url: tab.url,
    title: tab.title || tab.url,
    domain,
    timestamp: now,
    favicon: tab.favIconUrl || '',
    visitCount: 1,
    lastVisit: now,
    note: '',
    starred: false,
  };

  try {
    const { id } = await MyHistoryDB.addIncognitoHistory(record);
    incognitoState.set(normalized, { recordId: id, lastTime: now });
  } catch (e) {
    console.error('记录无痕历史失败:', e);
  }
}

// debounce 窗口内只要有任一 complete 事件，就算一次真实加载
const pendingLoads = new Set();

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
  const isLoad = changeInfo.status === 'complete';
  if (!isLoad && !changeInfo.title && !changeInfo.url) return;

  // 活跃标签 URL 变化（SPA 路由）：停留段切到新 URL
  if (changeInfo.url && tab && tab.active) {
    dwellStop(Date.now()).then(() => dwellStart(tab, Date.now()));
  }

  if (isLoad) pendingLoads.add(tabId);

  clearTimeout(pendingTimers.get(tabId));
  pendingTimers.set(tabId, setTimeout(() => {
    pendingTimers.delete(tabId);
    const wasLoad = pendingLoads.has(tabId);
    pendingLoads.delete(tabId);
    recordTab(tab, wasLoad);
  }, 500));
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  clearTimeout(pendingTimers.get(tabId));
  pendingTimers.delete(tabId);
  pendingLoads.delete(tabId);
  // 关闭的是正在计时的标签：结算
  const seg = await dwellGetSeg();
  if (seg && seg.tabId === tabId) await dwellStop(Date.now());
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('我的历史记录扩展已安装 v2（按年分库 + 抖动过滤）');
});