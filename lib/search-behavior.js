// 搜索行为分析：从搜索结果页 URL 解析关键词（纯函数，供统计页使用）
// 你主要用 Bing —— 它是 GET ?q= 明文传参，抓取最稳
const ENGINES = [
  { name: 'Bing', hosts: ['www.bing.com', 'cn.bing.com', 'bing.com'], path: '/search', param: 'q' },
  { name: 'Google', hosts: ['www.google.com', 'www.google.com.hk'], path: '/search', param: 'q' },
  { name: '百度', hosts: ['www.baidu.com'], path: '/s', param: 'wd' },
  { name: '搜狗', hosts: ['www.sogou.com'], path: '/web', param: 'query' },
  { name: 'DuckDuckGo', hosts: ['duckduckgo.com'], path: '/', param: 'q' },
];

// 同一关键词在该窗口内的翻页 / 二次筛选只算一次
export const SEARCH_GAP_MS = 10 * 60000;

// 去掉常见搜索语法，只保留内容关键词
// 例："react -site:csdn.net" → "react"；"vue -csdn" → "vue"
export function cleanQuery(raw) {
  // 注意：不要手动把 "+" 换成空格 —— URLSearchParams 已按表单规则解码过，
  // 手动替换会把正确编码的加号（如 c++ 的 %2B%2B）也一起破坏。
  let q = String(raw || '');
  // 站点排除/限定类操作符：site: inurl: intitle: filetype: after: before: related: link:
  q = q.replace(/(^|\s)-?(site|inurl|intitle|filetype|after|before|related|link):\S+/gi, ' ');
  // 单独的否定词（前面必须是空格或串首，因此 "covid-19" 这类连字符不受影响）
  q = q.replace(/(^|\s)-\S+/g, ' ');
  return q.replace(/\s+/g, ' ').trim();
}

// 从 URL 解析出 { engine, query }，非搜索结果页返回 null
export function parseSearchUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  for (const e of ENGINES) {
    if (!e.hosts.includes(host)) continue;
    if (e.path && !u.pathname.startsWith(e.path)) continue;
    const raw = u.searchParams.get(e.param);
    if (!raw) continue;
    const query = cleanQuery(raw);
    if (query) return { engine: e.name, query };
  }
  return null;
}

// 关键词累加器：逐条 add(记录)，result() 汇总。
// 时间序上相邻的同一关键词、且间隔在窗口内 → 视为同一次搜索（翻页/二次筛选去重）。
// 适配本扩展的聚合记录：时间取 r.timestamp（同 URL 间隔超 1 分钟即为独立记录，
// 恰好对应"两次搜索"的口径，与逐次访问模型的去重效果一致）。
export function createSearchAccumulator() {
  const hits = [];

  function add(rec) {
    const hit = parseSearchUrl(rec.url);
    if (!hit) return;
    hits.push({ t: rec.timestamp || 0, query: hit.query });
  }

  function result() {
    hits.sort((a, b) => a.t - b.t);

    const keywords = new Map();
    let total = 0;
    let lastQuery = null;
    let lastT = 0;

    for (const h of hits) {
      if (h.query === lastQuery && h.t - lastT <= SEARCH_GAP_MS) {
        lastT = h.t;
        continue;
      }
      lastQuery = h.query;
      lastT = h.t;
      total += 1;
      keywords.set(h.query, (keywords.get(h.query) || 0) + 1);
    }

    return {
      total,
      topKeywords: [...keywords.entries()]
        .map(([query, count]) => ({ query, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  return { add, result };
}
