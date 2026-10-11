// 统计视图渲染：全部统计 DOM 渲染函数 + 趋势图 hover/resize 交互。
// 不持有页面状态——数据由 history.js 传入（filtered / allRecords / currentTrendDays）
import { escapeHtml, getDateKey, dwellTotalOf, formatDwellCompact } from '../../lib/utils.js';

const trendCanvas = document.getElementById('stat-trend');
const trendTooltip = document.getElementById('stat-trend-tooltip');

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

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-today').textContent = todayCount;
  document.getElementById('stat-domains').textContent = domainSet.size;
  document.getElementById('stat-days').textContent = daySet.size;
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

  const dow = now.getDay();
  const weekStart = todayStart - dow * 86400000;
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

// ==================== 统计：日历热力图 ====================
function getHeatLevel(count) {
  if (count === 0) return 0;
  if (count <= 5) return 1;
  if (count <= 15) return 2;
  if (count <= 30) return 3;
  return 4;
}

function renderCalendarHeatmap(records) {
  const container = document.getElementById('stat-heatmap');

  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  const startDow = start.getDay();
  start.setDate(start.getDate() - startDow);

  const dayCount = {};
  records.forEach(r => {
    const key = getDateKey(r.timestamp);
    dayCount[key] = (dayCount[key] || 0) + 1;
  });

  const totalDays = Math.floor((end - start) / 86400000) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);
  const todayKey = getDateKey(Date.now());

  let html = '';
  for (let w = 0; w < totalWeeks; w++) {
    html += '<div class="heatmap-week">';
    for (let d = 0; d < 7; d++) {
      const dayIndex = w * 7 + d;
      const date = new Date(start);
      date.setDate(date.getDate() + dayIndex);

      if (date > end) {
        html += '<div class="heatmap-day heatmap-empty"></div>';
        continue;
      }

      const key = getDateKey(date.getTime());
      const count = dayCount[key] || 0;
      const level = getHeatLevel(count);
      const isToday = key === todayKey;
      html += `<div class="heatmap-day level-${level}${isToday ? ' today' : ''}"
        data-date="${key}" data-count="${count}"
        title="${key} · ${count} 次访问"></div>`;
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

// ==================== 统计：趋势折线图 ====================
function renderTrendChart(records, days) {
  const dpr = window.devicePixelRatio || 1;
  const rect = trendCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  trendCanvas.width = rect.width * dpr;
  trendCanvas.height = rect.height * dpr;
  const ctx = trendCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;

  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);

  const dayMap = {};
  records.forEach(r => {
    const key = getDateKey(r.timestamp);
    dayMap[key] = (dayMap[key] || 0) + 1;
  });

  const dayData = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = getDateKey(d.getTime());
    dayData.push({ key, date: d, count: dayMap[key] || 0 });
  }

  const maxCount = Math.max(...dayData.map(x => x.count), 1);

  const padL = 32,
    padR = 12,
    padT = 16,
    padB = 28;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);

  // Y 轴网格 + 刻度
  const isDark =
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const textColor = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)';

  ctx.strokeStyle = gridColor;
  ctx.fillStyle = textColor;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  const ySteps = 3;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (chartH / ySteps) * i;
    const val = Math.round(maxCount * (1 - i / ySteps));
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();
    ctx.fillText(String(val), padL - 6, y);
  }

  // 数据点
  const points = dayData.map((d, i) => ({
    x: padL + (days === 1 ? chartW / 2 : (chartW / (days - 1)) * i),
    y: padT + chartH - (d.count / maxCount) * chartH,
    ...d,
  }));

  // 渐变填充
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  if (isDark) {
    grad.addColorStop(0, 'rgba(88, 166, 255, 0.4)');
    grad.addColorStop(1, 'rgba(88, 166, 255, 0)');
  } else {
    grad.addColorStop(0, 'rgba(9, 105, 218, 0.35)');
    grad.addColorStop(1, 'rgba(9, 105, 218, 0)');
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, padT + chartH);
  points.forEach((p, i) => {
    if (i === 0) {
      ctx.lineTo(p.x, p.y);
    } else {
      const prev = points[i - 1];
      const cx1 = prev.x + (p.x - prev.x) / 2;
      const cy1 = prev.y;
      const cx2 = prev.x + (p.x - prev.x) / 2;
      const cy2 = p.y;
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, p.x, p.y);
    }
  });
  ctx.lineTo(points[points.length - 1].x, padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      const prev = points[i - 1];
      const cx1 = prev.x + (p.x - prev.x) / 2;
      const cy1 = prev.y;
      const cx2 = prev.x + (p.x - prev.x) / 2;
      const cy2 = p.y;
      ctx.bezierCurveTo(cx1, cy1, cx2, cy2, p.x, p.y);
    }
  });
  ctx.strokeStyle = isDark ? '#58a6ff' : '#0969da';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // X 轴标签
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xStep = Math.max(1, Math.ceil(days / 6));
  for (let i = 0; i < points.length; i += xStep) {
    const d = points[i].date;
    ctx.fillText(
      `${d.getMonth() + 1}/${d.getDate()}`,
      points[i].x,
      padT + chartH + 6,
    );
  }

  // 保存元数据供 hover / resize 使用
  trendCanvas._points = points;
  trendCanvas._padL = padL;
  trendCanvas._padT = padT;
  trendCanvas._chartH = chartH;
  trendCanvas._lastRender = { records, days };
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

// ==================== 统计：Top 10 ====================
function renderTopDomains(records) {
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
  } else {
    topEl.innerHTML = topDomains
      .map(([domain, count]) => {
        const pct = ((count / maxDomainCount) * 100).toFixed(1);
        return `<div class="stat-bar-row">
        <div class="stat-bar-label" title="${escapeHtml(domain)}">${escapeHtml(domain)}</div>
        <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
        <div class="stat-bar-value">${count}</div>
      </div>`;
      })
      .join('');
  }
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

// ==================== 统计：停留时长 ====================
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

function renderTopDwell(records) {
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
      return `<div class="stat-bar-row">
      <div class="stat-bar-label" title="${escapeHtml(domain)}">${escapeHtml(domain)}</div>
      <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
      <div class="stat-bar-value">${formatDwellCompact(d)}</div>
    </div>`;
    })
    .join('');
}

// ==================== 统计：总入口 ====================
function renderStats(records, allRecords, trendDays) {
  renderStatsCards(records);
  renderComparison(records);
  // 热力图始终基于当前范围数据渲染，点格子过滤当天后仍保留全月/全年的颜色导航
  renderCalendarHeatmap(allRecords);
  renderTrendChart(records, trendDays);
  renderHourHeatmap(records);
  renderTopDomains(records);
  renderTopDwell(records);
  renderDwellCard(records);
  render24hAndWeekday(records);
}

// ==================== 趋势图 hover ====================
trendCanvas.addEventListener('mousemove', e => {
  const points = trendCanvas._points;
  if (!points) return;

  const rect = trendCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

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
    trendTooltip.hidden = false;
    trendTooltip.innerHTML = `<strong>${nearest.key}</strong><br>${nearest.count} 次访问`;
    trendTooltip.style.left = nearest.x + 'px';
    trendTooltip.style.top = nearest.y + 'px';
  } else {
    trendTooltip.hidden = true;
  }
});

trendCanvas.addEventListener('mouseleave', () => {
  trendTooltip.hidden = true;
});

// 窗口 resize 时按最近一次参数重绘趋势图
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const last = trendCanvas._lastRender;
    if (last) renderTrendChart(last.records, last.days);
  }, 200);
});

export { renderStats, renderTrendChart };
