// ==================== 模块导入 ====================
import * as MyHistoryDB from '../../lib/db.js';
import {
  escapeHtml,
  getDateKey,
  formatDateTitle,
  formatDateTime,
  dwellTotalOf,
  formatDwell,
  formatDwellCompact,
} from '../../lib/utils.js';
import { getSettings, DEFAULT_SETTINGS } from '../../lib/settings.js';
import { parseSearch, matchesSearch } from '../../lib/search.js';
import { buildMarkdown, buildCsv, buildHtml, downloadFile } from '../../lib/export.js';
import { renderStats, renderTrendChart } from './stats-view.js';

// ==================== DOM ====================
const listEl = document.getElementById('list');
const totalEl = document.getElementById('total');
const searchEl = document.getElementById('search');
const btnExport = document.getElementById('btn-export');
const exportMenu = document.getElementById('export-menu');
const fileInput = document.getElementById('file-input');
const chips = document.querySelectorAll('.chip[data-range]');
const toastEl = document.getElementById('toast');
const statsPanel = document.getElementById('stats-panel');
const btnHelp = document.getElementById('btn-help');
const helpPopover = document.getElementById('help-popover');
const sentinel = document.getElementById('sentinel');
const loadHint = document.getElementById('load-hint');

const dateRangeBtn = document.getElementById('date-range-btn');
const dateRangePopover = document.getElementById('date-range-popover');
const dateLabel = document.getElementById('date-label');
const customStartInput = document.getElementById('custom-start');
const customEndInput = document.getElementById('custom-end');
const dateApplyBtn = document.getElementById('date-apply');
const dateClearBtn = document.getElementById('date-clear');

const noteEditor = document.getElementById('note-editor');
const noteEditorTitle = document.getElementById('note-editor-title');
const noteEditorRec = document.getElementById('note-editor-rec');
const noteTextarea = document.getElementById('note-textarea');
const noteSaveBtn = document.getElementById('note-save');
const noteCancelBtn = document.getElementById('note-cancel');

const backupBanner = document.getElementById('backup-banner');
const backupText = document.getElementById('backup-text');
const btnBackupExport = document.getElementById('btn-backup-export');
const btnBackupLater = document.getElementById('btn-backup-later');

const batchBar = document.getElementById('batch-bar');
const batchCount = document.getElementById('batch-count');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDeleteSelected = document.getElementById('btn-delete-selected');
const btnCancelSelect = document.getElementById('btn-cancel-select');
const chipStarred = document.getElementById('chip-starred');
const chipSelect = document.getElementById('chip-select');
const chipDay = document.getElementById('chip-day');
const chipDayLabel = document.getElementById('chip-day-label');
const tabList = document.getElementById('tab-list');
const tabStats = document.getElementById('tab-stats');
const listView = document.getElementById('list-view');

const btnMore = document.getElementById('btn-more');
const moreMenu = document.getElementById('more-menu');
const moreIncognito = document.getElementById('more-incognito');
const moreImport = document.getElementById('more-import');
const moreSyncAll = document.getElementById('more-sync-all');
const moreSyncMonth = document.getElementById('more-sync-month');
const moreMerge = document.getElementById('more-merge');
const morePause = document.getElementById('more-pause');
const moreClear = document.getElementById('more-clear');
const moreSettings = document.getElementById('more-settings');

const btnSearches = document.getElementById('btn-searches');
const searchesMenu = document.getElementById('searches-menu');
const recentPop = document.getElementById('recent-pop');
const searchWrap = document.querySelector('.search-wrap');

const incognitoBanner = document.getElementById('incognito-banner');
const btnIncClear = document.getElementById('btn-inc-clear');
const btnIncExit = document.getElementById('btn-inc-exit');
const pwModal = document.getElementById('pw-modal');
const pwTitle = document.getElementById('pw-title');
const pwSub = document.getElementById('pw-sub');
const pwInput = document.getElementById('pw-input');
const pwError = document.getElementById('pw-error');
const pwOk = document.getElementById('pw-ok');
const pwCancel = document.getElementById('pw-cancel');

// ==================== 状态 ====================
let PAGE_SIZE = DEFAULT_SETTINGS.pageSize; // 实际值从设置读取（见底部初始化）

let allRecords = [];
let filtered = [];
let renderedCount = 0;
let currentRange = 'year';
let customStart = '';
let customEnd = '';
let searchQuery = '';
let parsedSearch = null;
let currentTrendDays = 30;
let starredOnly = false;
let selectMode = false;
let currentView = 'list';
let dayFilter = null; // 「仅看某天」覆盖层（dateKey），不影响时间范围
let lastRecordedSearch = null;
let incognitoView = false;
const INC_STORE = MyHistoryDB.INCOGNITO_STORE;
const selectedKeys = new Set(); // 批量选择，key = id|timestamp
const collapsedDays = new Set(); // 折叠的日期（dateKey），重渲染后保持

function recKey(r) {
  return r.id + '|' + r.timestamp;
}

// 当前视图的记录所在 store（无痕视图固定单库，普通视图按年分库）
function storeNameFor(ts) {
  return incognitoView ? INC_STORE : MyHistoryDB.storeNameForTimestamp(ts);
}

// ==================== 工具 ====================
// escapeHtml / getDateKey / formatDateTitle / formatDateTime / dwellTotalOf /
// formatDwell / formatDwellCompact 来自 lib/utils.js

function getFaviconUrl(record) {
  // 1) 优先用记录里保存的原始图标（http/https/data URI）
  const fav = record.favicon || '';
  if (fav && /^https?:|^data:/.test(fav)) return fav;

  // 2) 回退到 Chrome 本地图标缓存（不发网络请求）
  if (record.url) {
    return chrome.runtime.getURL(
      '/_favicon/?pageUrl=' + encodeURIComponent(record.url) + '&size=32',
    );
  }
  return '';
}

// ==================== 时间范围 ====================
function getRangeBounds(range, customStart, customEnd) {
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const todayEnd = todayStart + 86400000 - 1;
  const MAX = Date.now() + 86400000;

  switch (range) {
    case 'year':
      return [
        new Date(now.getFullYear(), 0, 1).getTime(),
        todayEnd,
      ];
    case 'today':
      return [todayStart, todayEnd];
    case 'month':
      return [todayStart - 29 * 86400000, todayEnd];
    case 'custom': {
      let start = 0,
        end = MAX;
      if (customStart) {
        const d = new Date(customStart + 'T00:00:00');
        if (!isNaN(d.getTime())) start = d.getTime();
      }
      if (customEnd) {
        const d = new Date(customEnd + 'T23:59:59.999');
        if (!isNaN(d.getTime())) end = d.getTime();
      }
      return [start, end];
    }
    default:
      return [0, MAX];
  }
}

// ==================== 范围切换 ====================
function setRange(range) {
  chips.forEach(c => c.classList.remove('active'));
  const chip = document.querySelector(`.chip[data-range="${range}"]`);
  if (chip) chip.classList.add('active');
  currentRange = range;
  customStart = '';
  customEnd = '';
  customStartInput.value = '';
  customEndInput.value = '';
  dateLabel.textContent = '选择日期范围';
  dateRangeBtn.classList.remove('active');
  dateRangePopover.hidden = true;
  // 切换时间范围时清除「仅看某天」覆盖层
  dayFilter = null;
  chipDay.hidden = true;
  loadRecords();
}

// ==================== 热力图点击 → 仅看某天（不改时间范围） ====================
document.getElementById('stat-heatmap').addEventListener('click', e => {
  const cell = e.target.closest('.heatmap-day[data-date]');
  if (!cell) return;
  dayFilter = cell.dataset.date;
  chipDayLabel.textContent = dayFilter;
  chipDay.hidden = false;
  setView('list');
  renderedCount = PAGE_SIZE;
  render();
});

// ==================== 渲染列表 ====================
function updateLoadHint() {
  const total = filtered.length;
  if (total === 0) {
    loadHint.textContent = '';
    return;
  }
  if (renderedCount >= total) {
    loadHint.textContent = `已加载全部 ${total} 条`;
  } else {
    loadHint.textContent = `已显示 ${renderedCount} / 共 ${total} 条，继续下滑加载更多…`;
  }
}

function render() {
  filtered = allRecords.filter(r => matchesSearch(r, parsedSearch));
  if (starredOnly) filtered = filtered.filter(r => r.starred);
  if (dayFilter) filtered = filtered.filter(r => getDateKey(r.timestamp) === dayFilter);
  totalEl.textContent = `共 ${allRecords.length} 条，筛选后 ${filtered.length} 条`;

  if (currentView === 'stats') renderStats(filtered, allRecords, currentTrendDays);

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无记录</div>';
    updateLoadHint();
    updateBatchBar();
    return;
  }

  const visible = filtered.slice(0, renderedCount);

  const groups = {};
  visible.forEach(r => {
    const key = getDateKey(r.timestamp);
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const todayKey = getDateKey(Date.now());
  const thisYearPrefix = new Date().getFullYear() + '-';
  let html = '';

  sortedDates.forEach(dateKey => {
    const records = groups[dateKey];
    const isCollapsed = collapsedDays.has(dateKey);
    html += `<section class="day-group${isCollapsed ? ' collapsed' : ''}" data-date="${dateKey}">
      <h2 class="day-title" title="点击折叠/展开">
        <span class="day-toggle">${isCollapsed ? '▶' : '▼'}</span>${formatDateTitle(dateKey)} <span class="day-count">${records.length} 条</span></h2>
      <div class="day-list">`;

    records.forEach(r => {
      const t = new Date(r.timestamp).toLocaleTimeString('zh-CN', {
        hour12: false,
      });
      // 当天只显示时间；当年显示月日+时间；往年显示年月日+时间
      let time;
      if (dateKey === todayKey) time = t;
      else if (dateKey.startsWith(thisYearPrefix)) time = dateKey.slice(5) + ' ' + t;
      else time = dateKey + ' ' + t;
      const title = escapeHtml(r.title || r.url);
      const url = escapeHtml(r.url);
      const domain = escapeHtml(r.domain || '');
      const favUrl = getFaviconUrl(r);
      const initial = (r.domain || r.title || '?').charAt(0).toUpperCase();
      const countTag =
        r.visitCount > 1
          ? `<span class="visit-count">访问 ${r.visitCount} 次</span>`
          : '';
      const dwell = dwellTotalOf(r);
      const dwellTag =
        dwell > 0 ? `<span class="time">⏱ ${formatDwell(dwell)}</span>` : '';

      html += `<article class="item" data-id="${r.id}" data-timestamp="${r.timestamp}">
        ${selectMode ? `<input type="checkbox" class="item-check" data-key="${recKey(r)}" title="选择此记录"${selectedKeys.has(recKey(r)) ? ' checked' : ''}>` : ''}
        <div class="item-favicon" data-initial="${escapeHtml(initial)}">
          ${favUrl ? `<img src="${escapeHtml(favUrl)}" alt="" loading="lazy">` : ''}
        </div>
        <div class="item-main">
          <a class="item-title" href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>
          ${r.note ? `<div class="item-note">📝 ${escapeHtml(r.note)}</div>` : ''}
          <div class="item-url">${url}</div>
          <div class="item-meta">
            <span class="domain">${domain}</span>
            <span class="time">${time}</span>
            ${countTag}
            ${dwellTag}
          </div>
        </div>
        <div class="item-actions">
          <button class="item-action item-star${r.starred ? ' starred' : ''}" title="${r.starred ? '取消收藏' : '收藏'}" data-id="${r.id}">${r.starred ? '★' : '☆'}</button>
          <button class="item-action item-note-btn" title="${r.note ? '编辑备注' : '添加备注'}" data-id="${r.id}">📝</button>
          ${r.domain ? `<button class="item-action item-site" title="查看该网站历史" data-domain="${domain}">📋</button>` : ''}
          <button class="item-action item-open-inc" title="用无痕窗口打开" data-url="${url}">🕶️</button>
          <button class="item-action item-delete" title="删除这条记录" data-id="${r.id}">✕</button>
        </div>
      </article>`;
    });

    html += `</div></section>`;
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('.item-favicon img').forEach(img => {
    // 加载成功：隐藏底下的首字母
    if (img.complete && img.naturalWidth > 0) {
      img.parentElement.classList.add('has-icon');
    } else {
      img.addEventListener(
        'load',
        () => {
          img.parentElement.classList.add('has-icon');
        },
        { once: true },
      );
    }
    // 加载失败：移除图片，露出首字母
    img.addEventListener('error', () => img.remove(), { once: true });
  });

  updateLoadHint();
  updateBatchBar();
}

// ==================== 数据加载 ====================
async function loadRecords() {
  try {
    const [start, end] = getRangeBounds(currentRange, customStart, customEnd);
    allRecords = incognitoView
      ? await MyHistoryDB.getIncognitoHistory(start, end)
      : await MyHistoryDB.getHistoryByRange(start, end);
    allRecords.sort((a, b) => b.timestamp - a.timestamp);
    // 修剪批量选择：只保留当前范围内的记录，保证确认条数 = 实际删除条数
    if (selectedKeys.size > 0) {
      const valid = new Set(allRecords.map(recKey));
      for (const k of [...selectedKeys]) {
        if (!valid.has(k)) selectedKeys.delete(k);
      }
    }
    renderedCount = PAGE_SIZE;
    render();
  } catch (e) {
    console.error('加载历史失败:', e);
    showToast('加载历史失败');
  }
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// 应用一条搜索（保持当前时间范围不变）
function applySearch(q) {
  searchEl.value = q;
  searchQuery = q;
  parsedSearch = parseSearch(q);
  lastRecordedSearch = q;
  renderedCount = PAGE_SIZE;
  render();
}

// ==================== 无限滚动 ====================
const observer = new IntersectionObserver(
  entries => {
    if (entries[0].isIntersecting) {
      if (renderedCount < filtered.length) {
        renderedCount += PAGE_SIZE;
        render();
      }
    }
  },
  { rootMargin: '300px' },
);

observer.observe(sentinel);

// 趋势图 tab 切换
document.querySelectorAll('.trend-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document
      .querySelectorAll('.trend-tab')
      .forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTrendDays = Number(tab.dataset.days);
    if (currentView === 'stats') renderTrendChart(filtered, currentTrendDays);
  });
});

// 导出（构建函数在 lib/export.js）
function doExport(format) {
  const toExport = filtered.length > 0 ? filtered : allRecords;
  if (toExport.length === 0) {
    showToast('没有可导出的记录');
    return;
  }
  const stamp = formatDateTime(Date.now()).replace(/[-: ]/g, '').slice(0, 14);
  const base = `我的历史记录_${stamp}`;

  if (format === 'json') {
    downloadFile(
      base + '.json',
      JSON.stringify(toExport, null, 2),
      'application/json',
    );
  } else if (format === 'markdown') {
    downloadFile(
      base + '.md',
      buildMarkdown(toExport),
      'text/markdown;charset=utf-8',
    );
  } else if (format === 'csv') {
    downloadFile(base + '.csv', buildCsv(toExport), 'text/csv;charset=utf-8');
  } else if (format === 'html') {
    downloadFile(
      base + '.html',
      buildHtml(toExport),
      'text/html;charset=utf-8',
    );
  }
  showToast(`已导出 ${toExport.length} 条（${format}）`);
}

// ==================== 全局点击 ====================
document.addEventListener('click', e => {
  if (
    !helpPopover.hidden &&
    !helpPopover.contains(e.target) &&
    e.target !== btnHelp
  ) {
    helpPopover.hidden = true;
  }
  if (
    !exportMenu.hidden &&
    !exportMenu.contains(e.target) &&
    !btnExport.contains(e.target)
  ) {
    exportMenu.hidden = true;
  }
  if (!dateRangePopover.hidden && !dateRangeBtn.contains(e.target)) {
    dateRangePopover.hidden = true;
  }
  if (
    !moreMenu.hidden &&
    !moreMenu.contains(e.target) &&
    !btnMore.contains(e.target)
  ) {
    moreMenu.hidden = true;
  }
  if (
    !searchesMenu.hidden &&
    !searchesMenu.contains(e.target) &&
    !btnSearches.contains(e.target)
  ) {
    searchesMenu.hidden = true;
  }
  if (!recentPop.hidden && !searchWrap.contains(e.target)) {
    recentPop.hidden = true;
  }
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!pwModal.hidden) closePwModal();
  if (!noteEditor.hidden) closeNoteEditor();
  if (!recentPop.hidden) recentPop.hidden = true;
  if (!searchesMenu.hidden) searchesMenu.hidden = true;
});

// ==================== 帮助浮层 ====================
btnHelp.addEventListener('click', e => {
  e.stopPropagation();
  helpPopover.hidden = !helpPopover.hidden;
});

// ==================== 导出下拉 ====================
btnExport.addEventListener('click', e => {
  e.stopPropagation();
  searchesMenu.hidden = true;
  moreMenu.hidden = true;
  exportMenu.hidden = !exportMenu.hidden;
});

exportMenu.addEventListener('click', e => {
  const btn = e.target.closest('button[data-format]');
  if (!btn) return;
  exportMenu.hidden = true;
  doExport(btn.dataset.format);
});

// ==================== 日期范围面板 ====================
dateRangeBtn.addEventListener('click', e => {
  if (dateRangePopover.contains(e.target)) return;
  e.stopPropagation();
  dateRangePopover.hidden = !dateRangePopover.hidden;
});

dateApplyBtn.addEventListener('click', e => {
  e.stopPropagation();
  customStart = customStartInput.value;
  customEnd = customEndInput.value;

  if (!customStart && !customEnd) {
    showToast('请至少选择一个日期');
    return;
  }
  if (customStart && customEnd && customStart > customEnd) {
    showToast('起始日期不能晚于结束日期');
    return;
  }

  currentRange = 'custom';
  chips.forEach(c => c.classList.remove('active'));
  dateRangeBtn.classList.add('active');
  // 自定义范围覆盖「仅看某天」
  dayFilter = null;
  chipDay.hidden = true;

  if (customStart && customEnd) {
    dateLabel.textContent =
      customStart === customEnd ? customStart : `${customStart} ~ ${customEnd}`;
  } else if (customStart) {
    dateLabel.textContent = `${customStart} 起`;
  } else {
    dateLabel.textContent = `截止 ${customEnd}`;
  }

  dateRangePopover.hidden = true;
  loadRecords();
});

dateClearBtn.addEventListener('click', e => {
  e.stopPropagation();
  setRange('all');
});

// ==================== 导入 ====================
moreImport.addEventListener('click', () => {
  moreMenu.hidden = true;
  fileInput.click();
});

fileInput.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      showToast('JSON 解析失败：' + err.message);
      return;
    }
    if (!Array.isArray(data)) {
      showToast('格式错误：JSON 根节点应为数组');
      return;
    }
    showToast(`正在导入 ${data.length} 条，请稍候…`);
    const result = await MyHistoryDB.importRecords(data);
    showToast(
      `导入成功 ${result.imported} 条，跳过重复 ${result.skipped} 条，格式错误 ${result.invalid} 条`,
    );
    await loadRecords();
  } catch (err) {
    console.error(err);
    showToast('导入失败：' + err.message);
  }
  fileInput.value = '';
});

// ==================== 统计面板开关 ====================
function setView(view) {
  currentView = view;
  tabList.classList.toggle('active', view === 'list');
  tabStats.classList.toggle('active', view === 'stats');
  statsPanel.hidden = view !== 'stats';
  listView.hidden = view !== 'list';
  if (view === 'stats') {
    renderStats(filtered, allRecords, currentTrendDays);
    updateStorageUsage();
  }
}

tabList.addEventListener('click', () => setView('list'));
tabStats.addEventListener('click', () => setView('stats'));

// 「仅看某天」覆盖层：只过滤列表，不改时间范围
chipDay.addEventListener('click', () => {
  dayFilter = null;
  chipDay.hidden = true;
  renderedCount = PAGE_SIZE;
  render();
});

// ==================== 批量选择 / 删除 ====================
function updateBatchBar() {
  btnSelectAll.textContent = `全选筛选结果 (${filtered.length})`;
  batchCount.textContent = selectedKeys.size;
  batchBar.hidden = !selectMode || selectedKeys.size === 0;
}

listEl.addEventListener('change', e => {
  const cb = e.target.closest('.item-check');
  if (!cb) return;
  if (cb.checked) selectedKeys.add(cb.dataset.key);
  else selectedKeys.delete(cb.dataset.key);
  updateBatchBar();
});

btnSelectAll.addEventListener('click', () => {
  filtered.forEach(r => selectedKeys.add(recKey(r)));
  listEl.querySelectorAll('.item-check').forEach(cb => {
    cb.checked = true;
  });
  updateBatchBar();
});

btnCancelSelect.addEventListener('click', () => {
  selectedKeys.clear();
  listEl.querySelectorAll('.item-check').forEach(cb => {
    cb.checked = false;
  });
  updateBatchBar();
});

btnDeleteSelected.addEventListener('click', async () => {
  if (selectedKeys.size === 0) return;
  if (!confirm(`将删除 ${selectedKeys.size} 条记录，不可恢复。确定继续吗？`))
    return;
  const targets = allRecords
    .filter(r => selectedKeys.has(recKey(r)))
    .map(r => ({ id: r.id, timestamp: r.timestamp }));
  if (targets.length === 0) return;
  try {
    if (incognitoView) await MyHistoryDB.deleteIncognitoRecords(targets);
    else await MyHistoryDB.deleteRecords(targets);
    const killed = new Set(targets.map(r => recKey(r)));
    allRecords = allRecords.filter(r => !killed.has(recKey(r)));
    killed.forEach(k => selectedKeys.delete(k));
    renderedCount = Math.max(
      PAGE_SIZE,
      Math.min(renderedCount, allRecords.length),
    );
    render();
    showToast(`已删除 ${targets.length} 条记录`);
  } catch (err) {
    console.error(err);
    showToast('批量删除失败');
  }
});

// ==================== 删除 / 清空 ====================
listEl.addEventListener('click', async e => {
  // 折叠 / 展开某一天
  const titleEl = e.target.closest('.day-title');
  if (titleEl) {
    const group = titleEl.closest('.day-group');
    const key = group.dataset.date;
    const nowCollapsed = !collapsedDays.has(key);
    if (nowCollapsed) collapsedDays.add(key);
    else collapsedDays.delete(key);
    group.classList.toggle('collapsed', nowCollapsed);
    titleEl.querySelector('.day-toggle').textContent = nowCollapsed ? '▶' : '▼';
    return;
  }

  // 🕶️ 用无痕窗口打开
  const openIncBtn = e.target.closest('.item-open-inc');
  if (openIncBtn) {
    const u = openIncBtn.dataset.url;
    if (u) chrome.windows.create({ url: u, incognito: true });
    return;
  }

  // ★ 收藏 / 取消收藏
  const starBtn = e.target.closest('.item-star');
  if (starBtn) {
    const id = Number(starBtn.dataset.id);
    const ts = Number(starBtn.closest('.item').dataset.timestamp);
    const rec = allRecords.find(r => r.id === id && r.timestamp === ts);
    if (!rec) return;
    const starred = !rec.starred;
    try {
      await MyHistoryDB.patchRecord(storeNameFor(ts), id, { starred });
      rec.starred = starred;
      render();
      showToast(starred ? '已收藏' : '已取消收藏');
    } catch (err) {
      console.error(err);
      showToast('操作失败');
    }
    return;
  }

  // 📋 查看该网站历史（范围跟随当前 tag）
  const siteBtn = e.target.closest('.item-site');
  if (siteBtn) {
    const domain = siteBtn.dataset.domain;
    if (!domain) return;
    applySearch('site:' + domain);
    return;
  }

  // 📝 编辑备注
  const noteBtn = e.target.closest('.item-note-btn');
  if (noteBtn) {
    const id = Number(noteBtn.dataset.id);
    const ts = Number(noteBtn.closest('.item').dataset.timestamp);
    const rec = allRecords.find(r => r.id === id && r.timestamp === ts);
    if (rec) openNoteEditor(rec);
    return;
  }

  const btn = e.target.closest('.item-delete');
  if (!btn) return;
  const item = btn.closest('.item');
  const id = Number(btn.dataset.id);
  const timestamp = Number(item.dataset.timestamp);
  if (!id || !timestamp) return;
  if (!confirm('确定删除这条历史记录吗？')) return;
  try {
    if (incognitoView) await MyHistoryDB.deleteIncognitoHistory(id);
    else await MyHistoryDB.deleteHistory(id, timestamp);
    selectedKeys.delete(id + '|' + timestamp);
    allRecords = allRecords.filter(
      r => !(r.id === id && r.timestamp === timestamp),
    );
    renderedCount = Math.max(
      PAGE_SIZE,
      Math.min(renderedCount, allRecords.length),
    );
    render();
    showToast('已删除');
  } catch (err) {
    console.error(err);
    showToast('删除失败');
  }
});

// ==================== 清空全部（更多菜单） ====================
async function clearAllRecords() {
  if (incognitoView) return; // 无痕库只能从无痕视图的「清空无痕记录」清
  if (allRecords.length === 0) {
    showToast('没有可清空的记录');
    return;
  }
  if (!confirm('确定清空全部历史记录吗？此操作不可恢复。')) return;
  try {
    await MyHistoryDB.clearAllHistory();
    selectedKeys.clear();
    allRecords = [];
    filtered = [];
    renderedCount = 0;
    render();
    showToast('已清空全部记录');
  } catch (err) {
    console.error(err);
    showToast('清空失败');
  }
}

// ==================== 备注编辑 ====================
let noteTarget = null; // { id, timestamp }

function openNoteEditor(record) {
  noteTarget = { id: record.id, timestamp: record.timestamp };
  noteTextarea.value = record.note || '';
  noteEditorTitle.textContent = record.note ? '编辑备注' : '添加备注';
  noteEditorRec.textContent = record.title || record.url;
  noteEditor.hidden = false;
  noteTextarea.focus();
}

function closeNoteEditor() {
  noteEditor.hidden = true;
  noteTarget = null;
}

noteCancelBtn.addEventListener('click', closeNoteEditor);

noteEditor.addEventListener('click', e => {
  if (e.target === noteEditor) closeNoteEditor();
});

noteTextarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) noteSaveBtn.click();
});

noteSaveBtn.addEventListener('click', async () => {
  if (!noteTarget) return;
  const note = noteTextarea.value.trim();
  const storeName = storeNameFor(noteTarget.timestamp);
  try {
    await MyHistoryDB.patchRecord(storeName, noteTarget.id, { note });
    const rec = allRecords.find(
      r => r.id === noteTarget.id && r.timestamp === noteTarget.timestamp,
    );
    if (rec) rec.note = note;
    render();
    closeNoteEditor();
    showToast(note ? '备注已保存' : '备注已清除');
  } catch (err) {
    console.error(err);
    showToast('备注保存失败');
  }
});

// ==================== 搜索 ====================
let searchTimer;
searchEl.addEventListener('input', () => {
  recentPop.hidden = true;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchEl.value;
    parsedSearch = parseSearch(searchQuery);
    renderedCount = PAGE_SIZE;
    render();
  }, 200);
});

// ==================== 预设范围 ====================
chips.forEach(chip => {
  chip.addEventListener('click', () => setRange(chip.dataset.range));
});

// ⭐ 已收藏筛选（与范围 chip 互相独立）
chipStarred.addEventListener('click', () => {
  starredOnly = !starredOnly;
  chipStarred.classList.toggle('active', starredOnly);
  renderedCount = PAGE_SIZE;
  render();
});

// ☑ 选择模式：开关勾选框与批量工具条
chipSelect.addEventListener('click', () => {
  selectMode = !selectMode;
  chipSelect.classList.toggle('active', selectMode);
  if (!selectMode) selectedKeys.clear();
  render();
});

// ==================== 备份提醒 / 存储用量 ====================
let backupStep = DEFAULT_SETTINGS.backupStep; // 实际值从设置读取

function formatStorageSize(bytes) {
  const mb = bytes / 1024 / 1024;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

async function updateStorageUsage() {
  const el = document.getElementById('stat-storage');
  try {
    const est = await navigator.storage.estimate();
    el.textContent = formatStorageSize(est.usage || 0);
    return est.usage || 0;
  } catch (e) {
    el.textContent = '—';
    return 0;
  }
}

async function checkBackupReminder() {
  try {
    const stored = await chrome.storage.local.get('lastRemindedThreshold');
    const lastReminded = stored.lastRemindedThreshold || 0;
    const count = await MyHistoryDB.countAll();
    const threshold = Math.floor(count / backupStep) * backupStep;
    if (threshold < backupStep || threshold <= lastReminded) return;

    const usage = await updateStorageUsage();
    const sizeText = usage > 0 ? `（占用 ${formatStorageSize(usage)}）` : '';
    backupText.textContent =
      `已累计 ${count} 条记录${sizeText}，建议导出 JSON 备份`;
    backupBanner.hidden = false;

    const dismiss = async () => {
      backupBanner.hidden = true;
      try {
        await chrome.storage.local.set({ lastRemindedThreshold: threshold });
      } catch (e) {
        console.error(e);
      }
    };

    btnBackupExport.onclick = () => {
      doExport('json');
      dismiss();
    };
    btnBackupLater.onclick = dismiss;
  } catch (e) {
    console.error('备份提醒检查失败:', e);
  }
}

// ==================== 暂停记录开关 ====================
async function refreshPauseBtn() {
  try {
    const { recordingPaused } = await chrome.storage.local.get('recordingPaused');
    morePause.textContent = recordingPaused ? '▶ 恢复记录' : '⏸ 暂停记录';
  } catch (e) {
    console.error(e);
  }
}

async function togglePause() {
  try {
    const { recordingPaused } = await chrome.storage.local.get('recordingPaused');
    const next = !recordingPaused;
    await chrome.storage.local.set({ recordingPaused: next });
    await refreshPauseBtn();
    showToast(next ? '已暂停记录浏览历史' : '已恢复记录浏览历史');
  } catch (err) {
    console.error(err);
    showToast('操作失败');
  }
}

refreshPauseBtn();

// ==================== 保存的搜索 ====================
async function getSavedSearches() {
  const { savedSearches = [] } = await chrome.storage.local.get('savedSearches');
  return savedSearches;
}

function renderSearchesMenu(list) {
  let html = list
    .map(
      (q, i) => `
    <div class="search-item">
      <button type="button" class="search-apply" data-i="${i}" title="${escapeHtml(q)}">${escapeHtml(q)}</button>
      <button type="button" class="search-del" data-i="${i}" title="删除这条保存的搜索">✕</button>
    </div>`,
    )
    .join('');
  html +=
    '<div class="dropdown-divider"></div>' +
    '<button type="button" data-action="save-current">➕ 保存当前搜索</button>';
  searchesMenu.innerHTML = html;
}

async function saveCurrentSearch() {
  const q = searchEl.value.trim();
  if (!q) {
    showToast('搜索框为空，没有可保存的搜索');
    return;
  }
  try {
    const list = await getSavedSearches();
    if (list.includes(q)) {
      showToast('该搜索已经保存过了');
      return;
    }
    list.unshift(q);
    await chrome.storage.local.set({ savedSearches: list });
    renderSearchesMenu(list);
    showToast('已保存当前搜索');
  } catch (err) {
    console.error(err);
    showToast('保存失败');
  }
}

btnSearches.addEventListener('click', async e => {
  e.stopPropagation();
  exportMenu.hidden = true;
  moreMenu.hidden = true;
  if (!searchesMenu.hidden) {
    searchesMenu.hidden = true;
    return;
  }
  try {
    const list = await getSavedSearches();
    renderSearchesMenu(list);
    searchesMenu.hidden = false;
  } catch (err) {
    console.error(err);
  }
});

searchesMenu.addEventListener('click', async e => {
  const del = e.target.closest('.search-del');
  if (del) {
    try {
      const list = await getSavedSearches();
      list.splice(Number(del.dataset.i), 1);
      await chrome.storage.local.set({ savedSearches: list });
      renderSearchesMenu(list);
    } catch (err) {
      console.error(err);
    }
    return;
  }
  const apply = e.target.closest('.search-apply');
  if (apply) {
    try {
      const list = await getSavedSearches();
      searchesMenu.hidden = true;
      applySearch(list[Number(apply.dataset.i)] || '');
    } catch (err) {
      console.error(err);
    }
    return;
  }
  if (e.target.closest('[data-action="save-current"]')) {
    await saveCurrentSearch();
  }
});

// ==================== 搜索框最近记录 ====================
async function getRecentSearches() {
  const { recentSearches = [] } = await chrome.storage.local.get('recentSearches');
  return recentSearches;
}

async function maybeRecordSearch() {
  const q = searchEl.value.trim();
  if (!q || q === lastRecordedSearch) return;
  lastRecordedSearch = q;
  try {
    let list = await getRecentSearches();
    list = [q, ...list.filter(x => x !== q)].slice(0, 10);
    await chrome.storage.local.set({ recentSearches: list });
  } catch (err) {
    console.error(err);
  }
}

async function showRecentPop() {
  try {
    const list = await getRecentSearches();
    if (list.length === 0) return;
    recentPop.innerHTML = list
      .map(
        q =>
          `<button type="button" class="recent-item" data-q="${escapeHtml(q)}" title="${escapeHtml(q)}">🕘 ${escapeHtml(q)}</button>`,
      )
      .join('');
    recentPop.hidden = false;
  } catch (err) {
    console.error(err);
  }
}

searchEl.addEventListener('focus', showRecentPop);

searchEl.addEventListener('blur', () => {
  setTimeout(() => {
    recentPop.hidden = true;
  }, 150);
  maybeRecordSearch();
});

searchEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') maybeRecordSearch();
});

recentPop.addEventListener('mousedown', e => {
  const item = e.target.closest('.recent-item');
  if (!item) return;
  e.preventDefault();
  recentPop.hidden = true;
  applySearch(item.dataset.q);
});

// ==================== Chrome 历史同步 / 查重 ====================
let syncing = false;

async function fetchChromeHistory(startTime) {
  const PAGE = 1000;
  const items = [];
  let endTime = Date.now() + 86400000;
  let pages = 0;
  while (true) {
    const batch = await chrome.history.search({
      text: '',
      startTime,
      endTime,
      maxResults: PAGE,
    });
    pages++;
    if (pages % 5 === 1) {
      showToast(`正在读取 Chrome 历史… 已读 ${items.length} 条`);
    }
    if (!batch || batch.length === 0) break;
    for (const it of batch) {
      if (!it.url || typeof it.lastVisitTime !== 'number') continue;
      if (!/^https?:|^file:/.test(it.url)) continue;
      items.push(it);
    }
    if (batch.length < PAGE) break;
    const last = batch[batch.length - 1].lastVisitTime;
    if (typeof last !== 'number' || last <= 0) break;
    endTime = last - 1;
    await new Promise(r => setTimeout(r, 0));
  }
  return items;
}

async function syncChromeHistory(range) {
  if (syncing) return;
  if (!chrome.history || !chrome.history.search) {
    showToast('缺少 history 权限，请在 chrome://extensions 重新加载扩展');
    return;
  }
  syncing = true;
  moreMenu.hidden = true;
  try {
    const startTime =
      range === 'month' ? Date.now() - 30 * 86400000 : 0;
    showToast('正在读取 Chrome 历史…');
    const raw = await fetchChromeHistory(startTime);

    const records = [];
    for (const it of raw) {
      let domain = '';
      try {
        domain = new URL(it.url).hostname;
      } catch (e) {}
      records.push({
        url: it.url,
        title: it.title || it.url,
        domain,
        timestamp: it.lastVisitTime,
        visitCount: it.visitCount || 1,
        lastVisit: it.lastVisitTime,
      });
    }
    if (records.length === 0) {
      showToast('没有找到可导入的记录');
      return;
    }

    if (
      !confirm(
        `已读取 ${records.length} 条 Chrome 历史记录。\n` +
          `将去重后导入（与现有记录按 URL + 时间去重），可能耗时较长。继续吗？`,
      )
    )
      return;

    // 按年份 store 分组导入，逐库推进以便显示进度
    const byStore = {};
    for (const rec of records) {
      const s = MyHistoryDB.storeNameForTimestamp(rec.timestamp);
      (byStore[s] = byStore[s] || []).push(rec);
    }
    let imported = 0,
      skipped = 0,
      invalid = 0,
      done = 0;
    for (const [storeName, recs] of Object.entries(byStore)) {
      const res = await MyHistoryDB.importRecords(recs);
      imported += res.imported;
      skipped += res.skipped;
      invalid += res.invalid;
      done += recs.length;
      showToast(`正在导入… ${done} / ${records.length}`);
      await new Promise(r => setTimeout(r, 0));
    }
    showToast(
      `同步完成：导入 ${imported} 条，跳过重复 ${skipped} 条` +
        (invalid > 0 ? `，无效 ${invalid} 条` : ''),
    );
    await loadRecords();
  } catch (err) {
    console.error(err);
    showToast('同步失败：' + err.message);
  } finally {
    syncing = false;
  }
}

async function runMergeDuplicates() {
  if (syncing) return;
  if (
    !confirm(
      '将扫描全部记录，把同 URL 且时间间隔小于 2 分钟的重复条目合并' +
        '（访问次数累加，备注/星标保留）。继续吗？',
    )
  )
    return;
  syncing = true;
  moreMenu.hidden = true;
  try {
    showToast('正在扫描重复记录…');
    const removed = await MyHistoryDB.mergeDuplicates();
    showToast(
      removed > 0
        ? `合并完成：移除 ${removed} 条重复记录`
        : '未发现重复记录',
    );
    await loadRecords();
  } catch (err) {
    console.error(err);
    showToast('查重失败：' + err.message);
  } finally {
    syncing = false;
  }
}

// ==================== 更多菜单 ====================
function updateIncognitoItem() {
  moreIncognito.textContent = incognitoView ? '🚪 退出无痕视图' : '👻 无痕视图';
}

btnMore.addEventListener('click', e => {
  e.stopPropagation();
  exportMenu.hidden = true;
  searchesMenu.hidden = true;
  if (!moreMenu.hidden) {
    moreMenu.hidden = true;
    return;
  }
  refreshPauseBtn();
  updateIncognitoItem();
  moreMenu.hidden = false;
});

moreIncognito.addEventListener('click', () => {
  moreMenu.hidden = true;
  handleIncognitoClick();
});

moreSyncAll.addEventListener('click', () => syncChromeHistory('all'));
moreSyncMonth.addEventListener('click', () => syncChromeHistory('month'));
moreMerge.addEventListener('click', () => runMergeDuplicates());

morePause.addEventListener('click', () => {
  moreMenu.hidden = true;
  togglePause();
});

moreClear.addEventListener('click', () => {
  moreMenu.hidden = true;
  clearAllRecords();
});

moreSettings.addEventListener('click', () => {
  moreMenu.hidden = true;
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings/settings.html') });
});

// ==================== 无痕视图 ====================
let pwMode = null; // 'verify' | 'set' | 'set-confirm'
let pwFirstValue = '';

function openPwModal(mode, sub) {
  pwMode = mode;
  pwTitle.textContent = '👻 无痕视图';
  pwSub.textContent = sub;
  pwInput.value = '';
  pwError.hidden = true;
  pwModal.hidden = false;
  pwInput.focus();
}

function closePwModal() {
  pwModal.hidden = true;
  pwMode = null;
}

function showPwError(msg) {
  pwError.textContent = msg;
  pwError.hidden = false;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

pwCancel.addEventListener('click', closePwModal);

pwModal.addEventListener('click', e => {
  if (e.target === pwModal) closePwModal();
});

pwInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') pwOk.click();
});

pwOk.addEventListener('click', async () => {
  if (!pwMode) return;
  const v = pwInput.value;
  if (!v) {
    showPwError('请输入密码');
    return;
  }
  try {
    if (pwMode === 'verify') {
      const { incognitoPasswordHash } = await chrome.storage.local.get(
        'incognitoPasswordHash',
      );
      if ((await sha256Hex(v)) === incognitoPasswordHash) {
        closePwModal();
        enterIncognitoView();
      } else {
        showPwError('密码错误');
        pwInput.select();
      }
    } else if (pwMode === 'set') {
      pwFirstValue = v;
      pwMode = 'set-confirm';
      pwSub.textContent = '再输入一次以确认';
      pwInput.value = '';
      pwError.hidden = true;
      pwInput.focus();
    } else {
      if (v === pwFirstValue) {
        await chrome.storage.local.set({
          incognitoPasswordHash: await sha256Hex(v),
        });
        closePwModal();
        enterIncognitoView();
      } else {
        pwMode = 'set';
        pwSub.textContent = '两次输入不一致，请重新设置密码';
        pwInput.value = '';
        pwError.hidden = true;
        pwInput.focus();
      }
    }
  } catch (err) {
    console.error(err);
    showPwError('发生错误，请重试');
  }
});

function enterIncognitoView() {
  incognitoView = true;
  selectedKeys.clear();
  document.body.classList.add('incognito-mode');
  // 强制回到列表视图（统计面板仅普通视图可用）
  setView('list');
  backupBanner.hidden = true;
  incognitoBanner.hidden = false;
  moreIncognito.textContent = '🚪 退出无痕视图';
  loadRecords();
}

function exitIncognitoView() {
  incognitoView = false;
  selectedKeys.clear();
  document.body.classList.remove('incognito-mode');
  incognitoBanner.hidden = true;
  moreIncognito.textContent = '👻 无痕视图';
  loadRecords();
}

async function handleIncognitoClick() {
  if (incognitoView) {
    exitIncognitoView();
    return;
  }
  try {
    const { incognitoPasswordHash } = await chrome.storage.local.get(
      'incognitoPasswordHash',
    );
    if (incognitoPasswordHash) {
      openPwModal('verify', '输入密码进入无痕视图');
    } else {
      openPwModal('set', '首次使用，请设置无痕视图密码（仅防偷瞄，非加密保护）');
    }
  } catch (err) {
    console.error(err);
    showToast('无法读取密码设置');
  }
}

btnIncExit.addEventListener('click', exitIncognitoView);

btnIncClear.addEventListener('click', async () => {
  if (!confirm('将清空全部无痕记录，不可恢复。确定继续吗？')) return;
  try {
    await MyHistoryDB.clearIncognitoHistory();
    selectedKeys.clear();
    loadRecords();
    showToast('已清空无痕记录');
  } catch (err) {
    console.error(err);
    showToast('清空失败');
  }
});

// ==================== 回到顶部 ====================
const btnTop = document.getElementById('btn-top');

let topBtnTimer;
window.addEventListener(
  'scroll',
  () => {
    if (topBtnTimer) return;
    topBtnTimer = setTimeout(() => {
      topBtnTimer = null;
      btnTop.classList.toggle('show', window.scrollY > 600);
    }, 100);
  },
  { passive: true },
);

btnTop.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ==================== 初始化 ====================
parsedSearch = parseSearch('');

(async () => {
  // 先读设置再首渲染：pageSize / 备份档位运行时可调
  try {
    const s = await getSettings();
    PAGE_SIZE = Number(s.pageSize) || DEFAULT_SETTINGS.pageSize;
    backupStep = Number(s.backupStep) || DEFAULT_SETTINGS.backupStep;
  } catch (e) {}
  loadRecords();
  checkBackupReminder();
  updateStorageUsage();
})();
