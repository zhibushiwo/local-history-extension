// popup：快速入口 + 计数概览 + 暂停开关（与 background 的 recordingPaused 联动）
import * as MyHistoryDB from '../lib/db.js';
import { getDateKey, formatDwellCompact } from '../lib/utils.js';

const $ = (id) => document.getElementById(id);

async function loadCounts() {
  try {
    const total = await MyHistoryDB.countAll();
    $('total').textContent = total.toLocaleString();

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const todays = await MyHistoryDB.getHistoryByRange(todayStart, now.getTime());
    $('today').textContent = todays.length.toLocaleString();

    // 今日停留：当天记录的 dwellByDay[todayKey] 求和（与统计页同口径）
    const todayKey = getDateKey(Date.now());
    let dwell = 0;
    for (const r of todays) {
      if (r.dwellByDay && typeof r.dwellByDay === 'object') {
        dwell += r.dwellByDay[todayKey] || 0;
      }
    }
    $('dwell').textContent = formatDwellCompact(dwell);
  } catch (e) {
    console.error(e);
    $('total').textContent = '—';
    $('today').textContent = '—';
    $('dwell').textContent = '—';
  }
}

async function refreshPauseBtn() {
  try {
    const { recordingPaused } = await chrome.storage.local.get('recordingPaused');
    $('btn-pause').textContent = recordingPaused ? '▶ 恢复记录' : '⏸ 暂停记录';
    $('btn-pause').classList.toggle('is-paused', !!recordingPaused);
  } catch (e) {}
}

$('btn-pause').addEventListener('click', async () => {
  try {
    const { recordingPaused } = await chrome.storage.local.get('recordingPaused');
    await chrome.storage.local.set({ recordingPaused: !recordingPaused });
    await refreshPauseBtn();
  } catch (e) {
    console.error(e);
  }
});

$('btn-open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/history/history.html') });
  window.close();
});

$('btn-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings/settings.html') });
  window.close();
});

loadCounts();
refreshPauseBtn();
