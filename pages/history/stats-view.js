// 统计视图渲染：全部统计 DOM/Canvas 渲染函数 + 图表交互。
// 不持有页面状态——数据由 history.js 传入（filtered / allRecords / currentTrendDays / siteNames）
import {
  escapeHtml,
  getDateKey,
  dwellTotalOf,
  formatDwellCompact,
  formatDwell,
} from '../../lib/utils.js';
import { createSearchAccumulator } from '../../lib/search-behavior.js';
import { deriveSiteNameMap, siteLabel } from '../../lib/site-name.js';
import { saveSettings } from '../../lib/settings.js';

const trendCanvas = document.getElementById('stat-trend');
const trendTooltip = document.getElementById('stat-trend-tooltip');
const dwellCanvas = document.getElementById('stat-dwell-trend');
const dwellTooltip = document.getElementById('stat-dwell-trend-tooltip');

// 图表配色：与 styles/base.css 的设计变量保持一致（暖色系）
function chartPalette() {
  const isDark =
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return isDark
    ? {
        grid: 'rgba(236, 231, 222, 0.09)',
        text: '#857f72',
        series: '#e08b6d',
        fillTop: 'rgba(224, 139, 109, 0.4)',
        fillBottom: 'rgba(224, 139, 109, 0)',
        green: '#a3b884',
        greenFillTop: 'rgba(163, 184, 132, 0.4)',
        greenFillBottom: 'rgba(163, 184, 132, 0)',
      }
    : {
        grid: 'rgba(20, 20, 19, 0.07)',
        text: '#9d9a90',
        series: '#d97757',
        fillTop: 'rgba(217, 119, 87, 0.32)',
        fillBottom: 'rgba(217, 119, 87, 0)',
        green: '#788c5d',
        greenFillTop: 'rgba(120, 140, 93, 0.32)',
        greenFillBottom: 'rgba(120, 140, 93, 0)',
      };
}

// ==================== 统计：基础卡片 ====================
function renderStatsCards(records) {
  const total = records.length;
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const todayCount = records.filter(r => r.timestamp >= todayStart).length;

  const domainSet = new Set();
  const daySet = new Set();
  records.forEach(r => {
    if (r.domain) domainSet.add(r.domain);
    daySet.add(getDateKey(r.timestamp));
  });

  // 总停留 / 日均停留（口径：当前筛选范围内，有停留记录的天数为分母）
  let totalDwell = 0;
  const dwellDays = new Set();
  records.forEach(r => {
    if (r.dwellByDay && typeof r.dwellByDay === 'object') {
      for (const k in r.dwellByDay) {
        const v = r.dwellByDay[k] || 0;
        if (v > 0) {
          totalDwell += v;
          dwellDays.add(k);
        }
      }
    }
  });

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-today').textContent = todayCount;
  document.getElementById('stat-domains').textContent = domainSet.size;
  document.getElementById('stat-days').textContent = daySet.size;
  document.getElementById('stat-dwell-total').textContent =
    formatDwellCompact(totalDwell);
  document.getElementById('stat-dwell-avg').textContent = formatDwellCompact(
    dwellDays.size ? totalDwell / dwellDays.size : 0,
  );
}

// ==================== 统计：对比指标 ====================
function renderComparison(records) {
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterdayStart = todayStart - 86400000;

  const todayCount = records.filter(r => r.timestamp >= todayStart).length;
  const yesterdayCount = records.filter(
    r => r.timestamp >= yesterdayStart && r.timestamp < todayStart,
  ).length;

  const dow = now.getDay(); // 0=周日
  // 一周从周一开始算（国内习惯）：周一=1 ... 周日=7
  const dowMon = dow === 0 ? 7 : dow;
  const weekStart = todayStart - (dowMon - 1) * 86400000;
  const lastWeekStart = weekStart - 7 * 86400000;

  const thisWeekCount = records.filter(r => r.timestamp >= weekStart).length;
  const lastWeekCount = records.filter(
    r => r.timestamp >= lastWeekStart && r.timestamp < weekStart,
  ).length;

  function delta(current, previous) {
    if (previous === 0 && current === 0) return { type: 'flat', text: '—' };
    if (previous === 0) return { type: 'up', text: '新增' };
    const pct = ((current - previous) / previous) * 100;
    if (pct > 0) return { type: 'up', text: `↑ ${pct.toFixed(0)}%` };
    if (pct < 0)
      return { type: 'down', text: `↓ ${Math.abs(pct).toFixed(0)}%` };
    return { type: 'flat', text: '—' };
  }

  const todayDelta = delta(todayCount, yesterdayCount);
  const weekDelta = delta(thisWeekCount, lastWeekCount);

  document.getElementById('stat-comparison').innerHTML = `
    <div class="comparison-item">
      <span class="comparison-label">今日 vs 昨日</span>
      <span class="comparison-value ${todayDelta.type}">${todayDelta.text}</span>
      <span class="comparison-detail">${todayCount} / ${yesterdayCount}</span>
    </div>
    <div class="comparison-item">
      <span class="comparison-label">本周 vs 上周</span>
      <span class="comparison-value ${weekDelta.type}">${weekDelta.text}</span>
      <span class="comparison-detail">${thisWeekCount} / ${lastWeekCount}</span>
    </div>
  `;
}

// ==================== 通用折线图（面积 + 贝塞尔平滑） ====================
// series: [{ key: 'YYYY-MM-DD', date: Date, value: number }]
// opts: { color, fillTop, fillBottom, formatValue, tooltipText }
function drawLineChart(canvas, tooltipEl, series, opts = {}) {
  const pal = chartPalette();
  const color = opts.color || pal.series;
  const fillTop = opts.fillTop || pal.fillTop;
  const fillBottom = opts.fillBottom || pal.fillBottom;
  const fmt = opts.formatValue || (v => String(Math.round(v)));

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width;
  const h = rect.height;

  canvas._lastSeries = series;
  canvas._lastOpts = opts;

  ctx.clearRect(0, 0, w, h);

  if (!series || series.length === 0) {
    ctx.fillStyle = pal.text;
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('暂无数据', w / 2, h / 2);
    return;
  }

  const max = Math.max(1, ...series.map(d => d.value));

  // 左侧留白按实际刻度文本宽度决定（时长刻度可能较宽）
  ctx.font = '11px -apple-system, sans-serif';
  const yLabels = [0, 1, 2, 3].map(i => fmt((max * (3 - i)) / 3));
  const padL = Math.max(32, Math.ceil(Math.max(...yLabels.map(t => ctx.measureText(t).width))) + 10);
  const padR = 12,
    padT = 16,
    padB = 28;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  // Y 轴网格 + 刻度
  ctx.strokeStyle = pal.grid;
  ctx.fillStyle = pal.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padT + (chartH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();
    ctx.fillText(yLabels[i], padL - 6, y);
  }

  const n = series.length;
  const xAt = i => (n === 1 ? padL + chartW / 2 : padL + (chartW / (n - 1)) * i);
  const yAt = v => padT + chartH - (v / max) * chartH;

  // 渐变填充
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, fillBottom);
  ctx.beginPath();
  ctx.moveTo(xAt(0), padT + chartH);
  series.forEach((d, i) => ctx.lineTo(xAt(i), yAt(d.value)));
  ctx.lineTo(xAt(n - 1), padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  series.forEach((d, i) => {
    const x = xAt(i);
    const y = yAt(d.value);
    if (i === 0) ctx.moveTo(x, y);
    else {
      const prev = series[i - 1];
      const cx1 = xAt(i - 1) + (x - xAt(i - 1)) / 2;
      const cy1 = yAt(prev.value);
      const cx2 = xAt(i - 1) + (x - xAt(i - 1)) / 2;
      const cy2 = y;
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x, y);
    }
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // X 轴标签
  ctx.fillStyle = pal.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xStep = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += xStep) {
    const d = series[i].date;
    ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, xAt(i), padT + chartH + 6);
  }

  // 保存元数据供 hover / resize 使用
  canvas._points = series.map((d, i) => ({ x: xAt(i), y: yAt(d.value), key: d.key, value: d.value }));
}

function bindTrendHover(canvas, tooltipEl, tooltipText) {
  canvas.addEventListener('mousemove', e => {
    const points = canvas._points;
    if (!points) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    let nearest = null;
    let minDist = Infinity;
    points.forEach(p => {
      const d = Math.abs(p.x - mx);
      if (d < minDist) {
        minDist = d;
        nearest = p;
      }
    });

    if (nearest && minDist < 40) {
      tooltipEl.hidden = false;
      tooltipEl.innerHTML = `<strong>${nearest.key}</strong><br>${tooltipText(nearest.value)}`;
      tooltipEl.style.left = nearest.x + 'px';
      tooltipEl.style.top = nearest.y + 'px';
    } else {
      tooltipEl.hidden = true;
    }
  });
  canvas.addEventListener('mouseleave', () => {
    tooltipEl.hidden = true;
  });
}

// ==================== 统计：访问趋势 ====================
function renderTrendChart(records, days) {
  const pal = chartPalette();
  const { series } = buildDailySeries(records, days, (r, dayMap) => {
    const key = getDateKey(r.timestamp);
    dayMap[key] = (dayMap[key] || 0) + 1;
  });
  drawLineChart(trendCanvas, trendTooltip, series, {
    color: pal.series,
    fillTop: pal.fillTop,
    fillBottom: pal.fillBottom,
    formatValue: v => String(Math.round(v)),
    tooltipText: v => `${v} 次访问`,
  });
}

// ==================== 统计：每日停留时长趋势 ====================
function renderDwellTrend(records, days) {
  const pal = chartPalette();
  const { series } = buildDailySeries(records, days, (r, dayMap) => {
    if (!r.dwellByDay || typeof r.dwellByDay !== 'object') return;
    // 单趟遍历：每条记录的 dwellByDay 只有其访问过的少量日期
    for (const k in r.dwellByDay) {
      dayMap[k] = (dayMap[k] || 0) + (r.dwellByDay[k] || 0);
    }
  });
  drawLineChart(dwellCanvas, dwellTooltip, series, {
    color: pal.green,
    fillTop: pal.greenFillTop,
    fillBottom: pal.greenFillBottom,
    formatValue: formatDwellCompact,
    tooltipText: v => `停留 ${formatDwell(v) || '0 秒'}`,
  });
}

// 构建 [今天-days+1, 今天] 的逐日序列；collect(rec, dayMap) 累加每日值
function buildDailySeries(records, days, collect) {
  const dayMap = {};
  records.forEach(r => collect(r, dayMap));

  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);

  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = getDateKey(d.getTime());
    series.push({ key, date: d, value: dayMap[key] || 0 });
  }
  return { series, dayMap };
}

// ==================== 统计：日历热力图（升级版） ====================
// 绝对分档阈值（不随窗口浮动）；数值按个人量级设定，属可调常量
const HEATMAP_THRESHOLDS = {
  count: [30, 80, 150, 300], // 次/天
  dwell: [30 * 60, 60 * 60, 120 * 60, 240 * 60], // 秒/天：30m / 1h / 2h / 4h
};
let heatmapMetric = 'count'; // 'count' | 'dwell'
let heatmapDays = 365; // 90 / 180 / 365 / 0(当前数据全量)
let lastHeatRecords = null;

function heatLevel(v, thresholds) {
  if (!v) return 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (v <= thresholds[i]) return i + 1;
  }
  return thresholds.length;
}

// 单趟遍历：每天 { count, dwell(秒) }
function buildHeatSeries(records) {
  const map = new Map();
  records.forEach(r => {
    const key = getDateKey(r.timestamp);
    let item = map.get(key);
    if (!item) {
      item = { day: key, count: 0, dwell: 0 };
      map.set(key, item);
    }
    item.count += 1;
    if (r.dwellByDay && typeof r.dwellByDay === 'object') {
      item.dwell += r.dwellByDay[key] || 0;
    }
  });
  return [...map.values()];
}

function renderCalendarHeatmap(records) {
  const container = document.getElementById('stat-heatmap');
  lastHeatRecords = records;

  let series = records ? buildHeatSeries(records) : [];
  if (heatmapDays > 0) {
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (heatmapDays - 1));
    const cutoffKey = getDateKey(cutoff.getTime());
    series = series.filter(d => d.day >= cutoffKey);
  }

  if (series.length === 0) {
    container.innerHTML = '<div class="hm-empty">暂无数据</div>';
    return;
  }
  series.sort((a, b) => a.day.localeCompare(b.day));

  const thresholds = HEATMAP_THRESHOLDS[heatmapMetric];
  const valueOf = d => (heatmapMetric === 'dwell' ? d.dwell : d.count);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const parse = s => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const keyOf = dt =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

  const firstData = parse(series[0].day);
  const lastData = parse(series[series.length - 1].day);
  const end = today > lastData ? today : lastData;
  const endAligned = new Date(end);
  endAligned.setDate(endAligned.getDate() + (6 - endAligned.getDay()));
  const start = new Date(firstData);
  start.setDate(start.getDate() - start.getDay());

  const MAX_WEEKS = 53;
  let weeks = Math.floor((endAligned - start) / (7 * 86400000)) + 1;
  if (weeks > MAX_WEEKS) {
    weeks = MAX_WEEKS;
    start.setTime(endAligned.getTime());
    start.setDate(start.getDate() - (MAX_WEEKS * 7 - 1));
  }

  // 格子尺寸自适应容器宽度，尽量铺满
  const gap = 4;
  const labelCol = 26;
  const avail = Math.max(260, container.clientWidth || 640);
  const rawCell = Math.floor((avail - labelCol - (weeks - 1) * gap) / weeks);
  const cell = Math.max(9, Math.min(24, rawCell));
  container.style.setProperty('--gap', gap + 'px');
  container.style.setProperty('--cell', cell + 'px');

  const dataMap = new Map(series.map(d => [d.day, d]));
  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;
  let lastLabelWeek = -99;
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    let label = '';
    if (cursor <= today && cursor.getMonth() !== lastMonth) {
      lastMonth = cursor.getMonth();
      if (w - lastLabelWeek >= 3) {
        label = `${cursor.getMonth() + 1}月`;
        lastLabelWeek = w;
      }
    }
    monthLabels.push(`<span class="hm-month">${label}</span>`);

    for (let d = 0; d < 7; d++) {
      const dt = new Date(cursor);
      dt.setDate(dt.getDate() + d);
      const dayKey = keyOf(dt);
      const future = dt > today;
      const item = dataMap.get(dayKey);
      const count = item ? item.count : 0;
      const dwell = item ? item.dwell : 0;
      const level = future ? 0 : heatLevel(valueOf(item || { count: 0, dwell: 0 }), thresholds);
      cells.push(
        `<i class="hm-cell lv-${level}${future ? ' is-future' : ''}"` +
          (future ? '' : ` data-date="${dayKey}"`) +
          ` title="${dayKey} · ${count} 次 · ${formatDwellCompact(dwell)}"></i>`,
      );
    }
    cursor.setDate(cursor.getDate() + 7);
  }

  // 说明当前窗口（数据受顶部筛选范围约束）
  const windowStart = new Date(end);
  if (heatmapDays > 0) windowStart.setDate(windowStart.getDate() - (heatmapDays - 1));
  const caption =
    heatmapDays > 0
      ? `近 ${heatmapDays} 天 · ${keyOf(windowStart)} ~ ${keyOf(end)}`
      : `全部（受当前筛选范围约束） · ${keyOf(start)} ~ ${keyOf(end)}`;

  const scale = [0, 1, 2, 3, 4]
    .map(l => `<i class="hm-cell lv-${l}"></i>`)
    .join('');
  container.innerHTML = `
    <div class="hm-top">
      <div class="hm-corner"></div>
      <div class="hm-months">${monthLabels.join('')}</div>
    </div>
    <div class="hm-main">
      <div class="hm-weekdays"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span></span></div>
      <div class="hm-grid">${cells.join('')}</div>
    </div>
    <div class="hm-legend">
      <span class="hm-range">${caption}</span>
      <span class="hm-scale">少 ${scale} 多</span>
    </div>`;
}

// ==================== 统计：时段热力图 ====================
function renderHourHeatmap(records) {
  const container = document.getElementById('stat-hour-heatmap');
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));

  records.forEach(r => {
    const d = new Date(r.timestamp);
    grid[d.getDay()][d.getHours()]++;
  });

  const max = Math.max(...grid.flat(), 1);

  let html = '<div class="hour-heatmap-inner">';

  // 表头
  html += '<div class="hour-heatmap-row">';
  html += '<div class="hour-heatmap-cell-label"></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="hour-heatmap-col-label">${h % 3 === 0 ? h : ''}</div>`;
  }
  html += '</div>';

  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  for (let d = 0; d < 7; d++) {
    html += '<div class="hour-heatmap-row">';
    html += `<div class="hour-heatmap-row-label">${weekdays[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const count = grid[d][h];
      const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
      html += `<div class="hour-heatmap-cell level-${level}"
        title="周${weekdays[d]} ${h}:00 · ${count} 次"></div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ==================== 统计：访问最多的页面 Top 10 ====================
function renderTopPages(records) {
  const byUrl = new Map();
  records.forEach(r => {
    let u = byUrl.get(r.url);
    if (!u) {
      u = { url: r.url, title: r.title || r.url, domain: r.domain || '', count: 0 };
      byUrl.set(r.url, u);
    }
    u.count += r.visitCount || 1;
    if (r.title && u.title === u.url) u.title = r.title;
  });

  const top = [...byUrl.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  const el = document.getElementById('stat-top-pages');
  if (top.length === 0) {
    el.innerHTML = '<div class="stat-empty">暂无数据</div>';
    return;
  }
  const max = top[0].count;
  el.innerHTML = top
    .map(u => {
      const pct = ((u.count / max) * 100).toFixed(1);
      const label = escapeHtml(u.title.length > 60 ? u.title.slice(0, 60) + '…' : u.title);
      return `<div class="stat-bar-row">
        <div class="stat-bar-label" title="${escapeHtml(u.title)} — ${escapeHtml(u.domain)}">${label}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <div class="stat-bar-value">${u.count}</div>
      </div>`;
    })
    .join('');
}

// ==================== 统计：访问最多的网站 Top 10 ====================
function renderTopDomains(records, derived, siteAliases) {
  const domainCounts = {};
  records.forEach(r => {
    if (!r.domain) return;
    domainCounts[r.domain] = (domainCounts[r.domain] || 0) + 1;
  });
  const topDomains = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const maxDomainCount = topDomains.length > 0 ? topDomains[0][1] : 1;

  const topEl = document.getElementById('stat-top-domains');
  if (topDomains.length === 0) {
    topEl.innerHTML = '<div class="stat-empty">暂无数据</div>';
    return;
  }
  topEl.innerHTML = topDomains
    .map(([domain, count]) => {
      const pct = ((count / maxDomainCount) * 100).toFixed(1);
      const name = siteLabel(domain, derived[domain], siteAliases);
      const label = name
        ? `${escapeHtml(name)}<span class="bar-sub">（${escapeHtml(domain)}）</span>`
        : escapeHtml(domain);
      return `<div class="stat-bar-row">
        <div class="stat-bar-label" data-domain="${escapeHtml(domain)}" title="右键修改显示名 · ${escapeHtml(domain)}">${label}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <div class="stat-bar-value">${count}</div>
      </div>`;
    })
    .join('');
}

// ==================== 统计：页面平均停留 Top 10 ====================
function renderPageDwell(records) {
  const merged = new Map(); // title\0domain -> { title, domain, dwell, visits }
  records.forEach(r => {
    const d = dwellTotalOf(r);
    if (d <= 0) return;
    const title = r.title || r.url;
    const key = title + '\u0000' + (r.domain || '');
    let cur = merged.get(key);
    if (!cur) {
      cur = { title, domain: r.domain || '', dwell: 0, visits: 0 };
      merged.set(key, cur);
    }
    cur.dwell += d;
    cur.visits += r.visitCount || 1;
  });

  const top = [...merged.values()].sort((a, b) => b.dwell - a.dwell).slice(0, 10);
  const el = document.getElementById('stat-page-dwell');
  if (top.length === 0) {
    el.innerHTML = '<div class="stat-empty">暂无停留时长数据</div>';
    return;
  }
  el.innerHTML =
    '<div class="dwell-head"><span>页面</span><span>总时长</span><span>平均每次</span></div>' +
    top
      .map(r => {
        const avg = r.visits > 0 ? r.dwell / r.visits : 0;
        return `<div class="dwell-row">
          <div class="dwell-name" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}<span class="dwell-sub"> · ${escapeHtml(r.domain)}</span></div>
          <div class="dwell-total">${formatDwellCompact(r.dwell)}</div>
          <div class="dwell-avg">${r.visits > 0 ? formatDwellCompact(avg) : '—'}</div>
        </div>`;
      })
      .join('');
}

// ==================== 统计：停留时间最长的网站 Top 10 ====================
function renderTopDwell(records, derived, siteAliases) {
  const totals = {};
  records.forEach(r => {
    const d = dwellTotalOf(r);
    if (d > 0 && r.domain) totals[r.domain] = (totals[r.domain] || 0) + d;
  });
  const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const el = document.getElementById('stat-top-dwell');
  if (top.length === 0) {
    el.innerHTML = '<div class="stat-empty">暂无数据</div>';
    return;
  }
  const max = top[0][1];
  el.innerHTML = top
    .map(([domain, d]) => {
      const pct = ((d / max) * 100).toFixed(1);
      const name = siteLabel(domain, derived[domain], siteAliases);
      const label = name
        ? `${escapeHtml(name)}<span class="bar-sub">（${escapeHtml(domain)}）</span>`
        : escapeHtml(domain);
      return `<div class="stat-bar-row">
        <div class="stat-bar-label" data-domain="${escapeHtml(domain)}" title="右键修改显示名 · ${escapeHtml(domain)}">${label}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <div class="stat-bar-value">${formatDwellCompact(d)}</div>
      </div>`;
    })
    .join('');
}

// ==================== 统计：24 小时 & 星期 ====================
function render24hAndWeekday(records) {
  const hourCounts = new Array(24).fill(0);
  records.forEach(r => {
    hourCounts[new Date(r.timestamp).getHours()]++;
  });
  const maxHour = Math.max(...hourCounts, 1);
  document.getElementById('stat-hours').innerHTML = hourCounts
    .map((count, h) => {
      const height = count > 0 ? Math.max(4, (count / maxHour) * 62) : 2;
      const label = h % 3 === 0 ? String(h) : '';
      return `<div class="stat-hour-col" title="${h}:00 — ${count} 次">
      <div class="stat-hour-bar" style="height:${height}px"></div>
      <div class="stat-hour-label">${label}</div>
    </div>`;
    })
    .join('');

  const weekdayCounts = new Array(7).fill(0);
  records.forEach(r => {
    weekdayCounts[new Date(r.timestamp).getDay()]++;
  });
  const maxWeekday = Math.max(...weekdayCounts, 1);
  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
  document.getElementById('stat-weekdays').innerHTML = weekdayCounts
    .map((count, i) => {
      const height = count > 0 ? Math.max(4, (count / maxWeekday) * 66) : 2;
      return `<div class="stat-weekday-col" title="星期${weekdayNames[i]} — ${count} 次">
      <div class="stat-weekday-bar" style="height:${height}px"></div>
      <div class="stat-weekday-label">${weekdayNames[i]}</div>
    </div>`;
    })
    .join('');
}

// ==================== 统计：今日停留卡片 ====================
function renderDwellCard(records) {
  const todayKey = getDateKey(Date.now());
  let t = 0;
  records.forEach(r => {
    if (r.dwellByDay && typeof r.dwellByDay === 'object') {
      t += r.dwellByDay[todayKey] || 0;
    }
  });
  document.getElementById('stat-dwell-today').textContent =
    formatDwellCompact(t);
}

// ==================== 统计：搜索行为 ====================
function renderSearchBehavior(records) {
  const acc = createSearchAccumulator();
  records.forEach(r => acc.add(r));
  const { total, engineTotals, topKeywords } = acc.result();

  // 日均分母：当前范围内首尾记录的跨度天数
  let first = Infinity;
  let last = -Infinity;
  records.forEach(r => {
    if (r.timestamp < first) first = r.timestamp;
    if (r.timestamp > last) last = r.timestamp;
  });
  const days =
    records.length > 0 && last >= first
      ? Math.max(1, Math.floor((last - first) / 86400000) + 1)
      : 1;

  document.getElementById('kpi-search-total').textContent =
    total.toLocaleString();
  document.getElementById('kpi-search-avg').textContent = (total / days).toFixed(1);

  // 引擎分布 chips
  const chipBox = document.getElementById('stat-search-engines');
  chipBox.hidden = engineTotals.length === 0;
  chipBox.innerHTML = engineTotals
    .map(([engine, count]) => `<span class="engine-chip">${escapeHtml(engine)} ${count}</span>`)
    .join('');

  const box = document.getElementById('stat-search-kw');
  const rows = topKeywords.slice(0, 12);
  if (rows.length === 0) {
    box.innerHTML = '<div class="stat-empty">暂无搜索记录</div>';
    return;
  }
  box.innerHTML = rows
    .map(
      (r, i) => `
      <div class="kw-row" data-q="${escapeHtml(r.query)}" title="点击查看该关键词的搜索历史">
        <span class="kw-rank">${i + 1}</span>
        <span class="kw-text"><span class="kw-q" title="${escapeHtml(r.query)}">${escapeHtml(r.query)}</span><span class="kw-engines">${r.engines
            .map(([engine, count]) => `<i title="${escapeHtml(engine)} ${count} 次">${escapeHtml(engine)}${count > 1 ? ' ' + count : ''}</i>`)
            .join('')}</span></span>
        <span class="kw-count">${r.count}</span>
      </div>`,
    )
    .join('');
}

// ==================== 站点别名（右键 Top 榜站点行修改显示名） ====================
const aliasPop = document.getElementById('alias-pop');
const aliasPopDomain = document.getElementById('alias-pop-domain');
const aliasPopInput = document.getElementById('alias-pop-input');
let aliasTargetDomain = null;
let siteAliases = {}; // 与页面共享同一对象引用（来自 settings.siteNames）
let lastStats = null; // 保存后重绘用

function openAliasPop(domain, current, clientX, clientY) {
  aliasTargetDomain = domain;
  aliasPopDomain.textContent = domain;
  aliasPopInput.value = current || '';
  aliasPopInput.placeholder = '站点名称';
  aliasPop.hidden = false;
  const rect = aliasPop.getBoundingClientRect();
  aliasPop.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
  aliasPop.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;
  aliasPopInput.focus();
  aliasPopInput.select();
}

function closeAliasPop() {
  aliasTargetDomain = null;
  aliasPop.hidden = true;
}

async function saveAlias() {
  if (!aliasTargetDomain) return;
  const name = aliasPopInput.value.trim();
  if (name) siteAliases[aliasTargetDomain] = name;
  else delete siteAliases[aliasTargetDomain];
  closeAliasPop();
  try {
    await saveSettings({ siteNames: siteAliases });
    if (lastStats) {
      renderStats(lastStats.records, lastStats.allRecords, lastStats.trendDays, lastStats.siteNames);
    }
  } catch (err) {
    console.error(err);
  }
}

// 统计 → 列表联动筛选的桥接：由 history.js 注册回调（type: 'site'|'url', value）
let onStatsFilter = null;
export function initStatsFilterBridge(cb) {
  onStatsFilter = cb;
}

function bindAlias(container) {
  const open = e => {
    const label = e.target.closest('.stat-bar-label[data-domain]');
    if (!label) return;
    const domain = label.dataset.domain;
    openAliasPop(domain, siteAliases[domain] || '', e.clientX, e.clientY);
  };
  container.addEventListener('contextmenu', e => {
    if (!e.target.closest('.stat-bar-label[data-domain]')) return;
    e.preventDefault();
    e.stopPropagation();
    open(e);
  });
  // 左键：跳到列表按该网站筛选（site:，范围跟随当前 tag）；改名走右键
  container.addEventListener('click', e => {
    const label = e.target.closest('.stat-bar-label[data-domain]');
    if (!label || !onStatsFilter) return;
    onStatsFilter('site', label.dataset.domain);
  });
  container.addEventListener('mousemove', e => {
    container.style.cursor = e.target.closest('.stat-bar-label[data-domain]')
      ? 'pointer'
      : 'default';
  });
}

aliasPop.addEventListener('click', e => {
  if (e.target.closest('#alias-pop-save')) saveAlias();
  else if (e.target.closest('#alias-pop-close')) closeAliasPop();
});
aliasPopInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveAlias();
  else if (e.key === 'Escape') closeAliasPop();
});
document.addEventListener('click', e => {
  if (!aliasPop.hidden && !aliasPop.contains(e.target)) closeAliasPop();
});
window.addEventListener('resize', closeAliasPop);

// ==================== 统计：分组 Tab（趋势 / Top 榜 / 分布） ====================
// 记忆到 sessionStorage：同页面会话内刷新不重置
let statsTab = 'trend';
try {
  statsTab = sessionStorage.getItem('mh_stats_tab') || 'trend';
} catch (e) {}

function applyStatsTab() {
  for (const key of ['trend', 'top', 'dist']) {
    const el = document.getElementById('stats-tab-' + key);
    if (el) el.hidden = key !== statsTab;
  }
  document
    .querySelectorAll('#stats-tabs button[data-tab]')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === statsTab));
}

function setStatsTab(tab) {
  statsTab = tab;
  try {
    sessionStorage.setItem('mh_stats_tab', tab);
  } catch (e) {}
  applyStatsTab();
  // 切回趋势 tab 时重绘画布图（隐藏的 canvas 无尺寸，绘制会被跳过）
  if (tab === 'trend' && lastStats) {
    renderCalendarHeatmap(lastStats.allRecords);
    renderTrendChart(lastStats.records, lastStats.trendDays);
    renderDwellTrend(lastStats.records, lastStats.trendDays);
  }
}

document.getElementById('stats-tabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) setStatsTab(btn.dataset.tab);
});

// ==================== 统计：总入口 ====================
function renderStats(records, allRecords, trendDays, siteNames) {
  lastStats = { records, allRecords, trendDays, siteNames };
  siteAliases = siteNames || siteAliases;
  const derived = deriveSiteNameMap(allRecords || records);
  renderStatsCards(records);
  renderComparison(records);
  // 热力图始终基于当前范围数据渲染，点格子过滤当天后仍保留全月/全年的颜色导航
  renderCalendarHeatmap(allRecords);
  renderTrendChart(records, trendDays);
  renderDwellTrend(records, trendDays);
  renderHourHeatmap(records);
  renderTopPages(records);
  renderTopDomains(records, derived, siteAliases);
  renderPageDwell(records);
  renderTopDwell(records, derived, siteAliases);
  renderDwellCard(records);
  render24hAndWeekday(records);
  renderSearchBehavior(records);
  applyStatsTab();
}

// ==================== 交互绑定 ====================
bindTrendHover(
  trendCanvas,
  trendTooltip,
  v => `${v} 次访问`,
);
bindTrendHover(
  dwellCanvas,
  dwellTooltip,
  v => `停留 ${formatDwell(v) || '0 秒'}`,
);

bindAlias(document.getElementById('stat-top-domains'));
bindAlias(document.getElementById('stat-top-dwell'));

// 关键词行 → 跳到列表按该关键词筛选（url:；含空格的词退化为普通全文搜索）
document.getElementById('stat-search-kw').addEventListener('click', e => {
  const row = e.target.closest('.kw-row[data-q]');
  if (!row || !onStatsFilter) return;
  onStatsFilter('url', row.dataset.q);
});

// 热力图 指标/范围 切换
document.getElementById('heatmap-metric').addEventListener('click', e => {
  const btn = e.target.closest('button[data-metric]');
  if (!btn) return;
  document
    .querySelectorAll('#heatmap-metric button')
    .forEach(b => b.classList.toggle('active', b === btn));
  heatmapMetric = btn.dataset.metric;
  if (lastHeatRecords) renderCalendarHeatmap(lastHeatRecords);
});

document.getElementById('heatmap-range').addEventListener('click', e => {
  const btn = e.target.closest('button[data-days]');
  if (!btn) return;
  document
    .querySelectorAll('#heatmap-range button')
    .forEach(b => b.classList.toggle('active', b === btn));
  heatmapDays = Number(btn.dataset.days);
  if (lastHeatRecords) renderCalendarHeatmap(lastHeatRecords);
});

// 窗口 resize 时按最近一次参数重绘趋势图
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [canvas, tooltipEl] of [
      [trendCanvas, trendTooltip],
      [dwellCanvas, dwellTooltip],
    ]) {
      if (canvas._lastSeries) {
        drawLineChart(canvas, tooltipEl, canvas._lastSeries, canvas._lastOpts);
      }
    }
  }, 200);
});

export { renderStats, renderTrendChart, renderDwellTrend };
