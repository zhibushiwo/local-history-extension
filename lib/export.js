// 导出构建：Markdown / CSV / HTML（JSON 在调用侧直接 JSON.stringify）
// 覆盖 note / starred / dwellByDay 字段
import {
  escapeHtml,
  getDateKey,
  formatDateTitle,
  formatDateTime,
  dwellTotalOf,
  formatDwell,
} from './utils.js';

export function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function mdEscape(str) {
  return String(str || '').replace(/([\[\]])/g, '\\$1');
}

export function buildMarkdown(records) {
  const lines = ['# 我的浏览历史', ''];
  lines.push(
    `> 导出时间：${formatDateTime(Date.now())} · 共 ${records.length} 条`,
    '',
  );

  const groups = {};
  records.forEach(r => {
    const key = getDateKey(r.timestamp);
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  Object.keys(groups)
    .sort((a, b) => b.localeCompare(a))
    .forEach(dateKey => {
      lines.push(`## ${dateKey}`, '');
      groups[dateKey].forEach(r => {
        const time = formatDateTime(r.timestamp).slice(11);
        const title = mdEscape(r.title || r.url);
        const star = r.starred ? '⭐ ' : '';
        const visit = r.visitCount > 1 ? ` · 访问 ${r.visitCount} 次` : '';
        const d = dwellTotalOf(r);
        const dwellTxt = d > 0 ? ` · 停留 ${formatDwell(d)}` : '';
        lines.push(
          `- ${star}**${time}** [${title}](${r.url}) — \`${r.domain || ''}\`${visit}${dwellTxt}`,
        );
        if (r.note) lines.push(`  > 📝 ${mdEscape(r.note)}`);
      });
      lines.push('');
    });

  return lines.join('\n');
}

export function buildCsv(records) {
  const rows = ['时间,标题,网址,域名,访问次数,备注,收藏,停留(秒)'];
  records.forEach(r => {
    rows.push(
      [
        formatDateTime(r.timestamp),
        csvEscape(r.title || ''),
        csvEscape(r.url || ''),
        csvEscape(r.domain || ''),
        r.visitCount || 1,
        csvEscape(r.note || ''),
        r.starred ? '是' : '',
        dwellTotalOf(r),
      ].join(','),
    );
  });
  return '\uFEFF' + rows.join('\n');
}

export function buildHtml(records) {
  const groups = {};
  records.forEach(r => {
    const key = getDateKey(r.timestamp);
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });
  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  const style = `
    body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2328; margin: 0; padding: 40px 20px; }
    .wrap { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .meta { color: #656d76; font-size: 13px; margin-bottom: 32px; }
    .day-title { font-size: 15px; font-weight: 600; margin: 28px 0 8px; padding-bottom: 6px; border-bottom: 1px solid #d0d7de; }
    .item { display: block; padding: 10px 12px; margin: 2px 0; border-radius: 6px; text-decoration: none; color: inherit; }
    .item:hover { background: #fff; }
    .item .title { color: #0969da; font-size: 14px; font-weight: 500; }
    .item .url { color: #656d76; font-size: 12px; margin-top: 2px; word-break: break-all; }
    .item .meta2 { color: #8b949e; font-size: 12px; margin-top: 4px; }
    .item .meta2 span { margin-right: 12px; }
    .item .note { color: #1a7f37; font-size: 12px; margin-top: 3px; white-space: pre-wrap; word-break: break-word; }
  `;

  let body = `<div class="wrap">
    <h1>我的浏览历史</h1>
    <div class="meta">导出时间：${formatDateTime(Date.now())} · 共 ${records.length} 条</div>`;

  sortedDates.forEach(dateKey => {
    body += `<h2 class="day-title">${formatDateTitle(dateKey)} · ${dateKey} · ${groups[dateKey].length} 条</h2>`;
    groups[dateKey].forEach(r => {
      const time = formatDateTime(r.timestamp).slice(11);
      const visit =
        r.visitCount > 1 ? `<span>访问 ${r.visitCount} 次</span>` : '';
      const d = dwellTotalOf(r);
      const dwell =
        d > 0 ? `<span>⏱ 停留 ${formatDwell(d)}</span>` : '';
      const note = r.note
        ? `<div class="note">📝 ${escapeHtml(r.note)}</div>`
        : '';
      body += `<a class="item" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">
        <div class="title">${r.starred ? '⭐ ' : ''}${escapeHtml(r.title || r.url)}</div>
        <div class="url">${escapeHtml(r.url)}</div>
        <div class="meta2"><span>${time}</span><span>${escapeHtml(r.domain || '')}</span>${visit}${dwell}</div>
        ${note}
      </a>`;
    });
  });

  body += `</div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>我的浏览历史</title>
<style>${style}</style>
</head>
<body>${body}</body>
</html>`;
}

// 触发浏览器下载
export function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
