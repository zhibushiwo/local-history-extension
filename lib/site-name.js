// 站点名称：从标题自动推导 + 用户自定义别名（纯函数，供统计页 Top 榜使用）

// 从页面标题里提取相对干净的站点名：
// 页面标题常写成「站点名 - 一句话描述」，这里截掉分隔符后的描述部分
export function cleanSiteName(title, url) {
  let t = String(title || '').trim();
  if (!t || t === url) return '';
  const cut = t.split(/\s+[-–—|·]\s+/)[0].trim();
  if (cut) t = cut;
  if (!t || t.length > 20) return '';
  return t;
}

// 从记录集合推导 domain -> 站点名。
// 取该域名下 URL 最短（最接近首页）的那条标题；同名出现在多个不同域名
// （忽略 www. 前缀）时弃用，避免图表里出现多行同名、域名却不同的混乱观感。
export function deriveSiteNameMap(records) {
  const domainName = new Map(); // domain -> { urlLen, name }

  for (const r of records) {
    const d = r.domain;
    if (!d) continue;
    const name = cleanSiteName(r.title, r.url);
    if (!name) continue;
    const urlLen = (r.url || '').length;
    const cur = domainName.get(d);
    if (!cur || urlLen < cur.urlLen) domainName.set(d, { urlLen, name });
  }

  const nameDomains = new Map();
  for (const [domain, info] of domainName) {
    const base = domain.replace(/^www\./, '');
    if (!nameDomains.has(info.name)) nameDomains.set(info.name, new Set());
    nameDomains.get(info.name).add(base);
  }

  const out = {};
  for (const [domain, info] of domainName) {
    if (nameDomains.get(info.name).size === 1) out[domain] = info.name;
  }
  return out;
}

// 站点显示名：用户别名 > 自动推导 > 空（调用方回退为域名）
export function siteLabel(domain, derived, aliases) {
  return (aliases && aliases[domain]) || derived || '';
}
