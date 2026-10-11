// 搜索语法解析与匹配（纯函数）
// 语法：site: after: before: title: url: note: /正则/flags，普通文字全字段 AND 匹配

export function parseSearch(query) {
  const result = {
    text: [],
    sites: [],
    after: null,
    before: null,
    titles: [],
    urls: [],
    notes: [],
    regexes: [],
  };
  if (!query || !query.trim()) return result;

  let rest = query.replace(/\/(.+?)\/([gimsuy]*)/g, (m, pattern, flags) => {
    try {
      result.regexes.push(new RegExp(pattern, flags || 'i'));
    } catch (e) {}
    return ' ';
  });

  const tokens = rest.split(/\s+/).filter(Boolean);
  tokens.forEach(tok => {
    const m = tok.match(/^(site|after|before|title|url|note):(.+)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2];
      if (key === 'site') result.sites.push(val.toLowerCase());
      else if (key === 'after') {
        const d = new Date(val + 'T00:00:00');
        if (!isNaN(d.getTime())) result.after = d.getTime();
      } else if (key === 'before') {
        const d = new Date(val + 'T23:59:59');
        if (!isNaN(d.getTime())) result.before = d.getTime();
      } else if (key === 'title') result.titles.push(val.toLowerCase());
      else if (key === 'url') result.urls.push(val.toLowerCase());
      else if (key === 'note') result.notes.push(val.toLowerCase());
    } else {
      result.text.push(tok.toLowerCase());
    }
  });

  return result;
}

export function matchesSearch(record, p) {
  if (!p) return true;

  if (p.sites.length > 0) {
    const dom = (record.domain || '').toLowerCase();
    if (!p.sites.some(s => dom.includes(s))) return false;
  }
  if (p.after && record.timestamp < p.after) return false;
  if (p.before && record.timestamp > p.before) return false;
  if (p.titles.length > 0) {
    const t = (record.title || '').toLowerCase();
    if (!p.titles.every(x => t.includes(x))) return false;
  }
  if (p.urls.length > 0) {
    const u = (record.url || '').toLowerCase();
    if (!p.urls.every(x => u.includes(x))) return false;
  }
  if (p.notes.length > 0) {
    const n = (record.note || '').toLowerCase();
    if (!p.notes.every(x => n.includes(x))) return false;
  }
  if (p.regexes.length > 0) {
    const target = (record.title || '') + ' ' + (record.url || '');
    if (
      !p.regexes.every(re => {
        re.lastIndex = 0;
        return re.test(target);
      })
    )
      return false;
  }
  if (p.text.length > 0) {
    const hay = (
      (record.title || '') +
      ' ' +
      (record.url || '') +
      ' ' +
      (record.domain || '') +
      ' ' +
      (record.note || '')
    ).toLowerCase();
    if (!p.text.every(x => hay.includes(x))) return false;
  }
  return true;
}
