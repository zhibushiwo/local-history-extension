// 通用工具：HTML 转义、日期/时长格式化（纯函数，页面与 Service Worker 皆可用）

export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(
    /[&<>"']/g,
    m =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[m],
  );
}

// 本地时区的 YYYY-MM-DD（与 db.js 的 localDateKey 口径一致）
export function getDateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatDateTitle(dateKey) {
  const todayKey = getDateKey(Date.now());
  const yesterdayKey = getDateKey(Date.now() - 86400000);
  if (dateKey === todayKey) return '今天';
  if (dateKey === yesterdayKey) return '昨天';
  const [y, m, d] = dateKey.split('-');
  return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

export function formatDateTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ==================== 停留时长 ====================

export function dwellTotalOf(r) {
  if (r.dwellByDay && typeof r.dwellByDay === 'object') {
    let t = 0;
    for (const k in r.dwellByDay) t += r.dwellByDay[k] || 0;
    return t;
  }
  return r.dwellTime || 0;
}

export function formatDwell(s) {
  if (!s || s <= 0) return '';
  if (s < 60) return s + ' 秒';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m ? `${h} 时 ${m} 分` : `${h} 时`;
  return `${m} 分 ${s % 60} 秒`;
}

export function formatDwellCompact(s) {
  if (!s || s <= 0) return '0';
  const h = s / 3600;
  if (h >= 1) return h.toFixed(1) + ' 时';
  return Math.round(s / 60) + ' 分';
}
