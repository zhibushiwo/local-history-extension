// 搜索行为解析单测：node tests/search-behavior.test.mjs
import {
  cleanQuery,
  parseSearchUrl,
  createSearchAccumulator,
  SEARCH_GAP_MS,
} from '../lib/search-behavior.js';

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) console.log('  ok -', msg);
  else {
    failed++;
    console.error('  FAIL -', msg, '\n    expected:', b, '\n    actual:  ', a);
  }
}

console.log('cleanQuery:');
eq(cleanQuery('react -site:csdn.net'), 'react', '剥离 -site:');
eq(cleanQuery('vue -csdn'), 'vue', '剥离否定词');
eq(cleanQuery('covid-19 新闻'), 'covid-19 新闻', '连字符词不受影响');
eq(cleanQuery('教程 site:bilibili.com'), '教程', '剥离 site:');
eq(cleanQuery('c++ 教程'), 'c++ 教程', '加号不被破坏');

console.log('parseSearchUrl:');
eq(parseSearchUrl('https://www.bing.com/search?q=react+hooks'), { engine: 'Bing', query: 'react hooks' }, 'Bing');
eq(parseSearchUrl('https://cn.bing.com/search?q=%E5%89%8D%E7%AB%AF'), { engine: 'Bing', query: '前端' }, 'Bing 中国站 + URL 编码');
eq(parseSearchUrl('https://www.baidu.com/s?wd=nodejs'), { engine: '百度', query: 'nodejs' }, '百度');
eq(parseSearchUrl('https://www.google.com/search?q=css&num=10'), { engine: 'Google', query: 'css' }, 'Google');
eq(parseSearchUrl('https://search.bilibili.com/all?keyword=react%20hooks'), { engine: 'B站', query: 'react hooks' }, 'B站 全部频道');
eq(parseSearchUrl('https://search.bilibili.com/live?keyword=%E7%9B%B4%E6%92%AD'), { engine: 'B站', query: '直播' }, 'B站 直播频道');
eq(parseSearchUrl('https://juejin.cn/search?query=vue3'), { engine: '掘金', query: 'vue3' }, '掘金');
eq(parseSearchUrl('https://github.com/search?q=css+grid&type=repositories'), { engine: 'GitHub', query: 'css grid' }, 'GitHub');
eq(parseSearchUrl('https://github.com/topics/css'), null, 'GitHub 非搜索页不匹配');
eq(parseSearchUrl('https://www.bing.com/maps?q=xx'), null, '非搜索路径不匹配');
eq(parseSearchUrl('https://example.com/search?q=x'), null, '未知域名不匹配');
eq(parseSearchUrl('https://www.bing.com/search?q=-site:a.com'), null, '纯语法关键词视为空');

console.log('createSearchAccumulator:');
{
  const acc = createSearchAccumulator();
  const t0 = Date.now();
  acc.add({ url: 'https://www.bing.com/search?q=react', timestamp: t0 });
  acc.add({ url: 'https://www.bing.com/search?q=react&first=11', timestamp: t0 + 60000 }); // 翻页
  acc.add({ url: 'https://www.baidu.com/s?wd=vue3', timestamp: t0 + SEARCH_GAP_MS + 2000 });
  acc.add({ url: 'https://example.com/', timestamp: t0 });
  const r = acc.result();
  eq(r.total, 2, '翻页去重 + 不同关键词各计一次');
  eq(r.topKeywords, [
    { query: 'react', count: 1, engines: [['Bing', 1]] },
    { query: 'vue3', count: 1, engines: [['百度', 1]] },
  ], '关键词排行带引擎构成');
}
{
  // 滑动窗口语义（原算法）：同一关键词只要相邻间隔都在窗口内就持续合并
  const acc = createSearchAccumulator();
  const t0 = Date.now();
  acc.add({ url: 'https://www.bing.com/search?q=react', timestamp: t0 });
  acc.add({ url: 'https://www.bing.com/search?q=react', timestamp: t0 + SEARCH_GAP_MS + 1000 });
  eq(acc.result().total, 2, '无翻页时超窗重搜计新一次');
}
{
  // 跨引擎：同关键词在两个引擎各计一次，engines 分别标注
  const acc = createSearchAccumulator();
  const t0 = Date.now();
  acc.add({ url: 'https://www.bing.com/search?q=react', timestamp: t0 });
  acc.add({ url: 'https://search.bilibili.com/all?keyword=react', timestamp: t0 + 610000 });
  acc.add({ url: 'https://www.bing.com/search?q=react&first=11', timestamp: t0 + 620000 }); // 翻页归 B站那次? 不——相邻去重按 query
  const r = acc.result();
  const kw = r.topKeywords.find((k) => k.query === 'react');
  eq(kw.count, 2, '同关键词跨引擎总计');
  eq(kw.engines, [['Bing', 1], ['B站', 1]], '引擎构成分别标注');
  eq(r.engineTotals.includes(1) || r.engineTotals.length === 2, true, '引擎总量含两个来源');
}
{
  // 聚合记录口径：同 URL visitCount>1 只有一条时间戳，按一次计
  const acc = createSearchAccumulator();
  acc.add({ url: 'https://www.bing.com/search?q=css', timestamp: 1000, visitCount: 5 });
  eq(acc.result().total, 1, '聚合记录按时间戳计一次');
}

console.log(failed === 0 ? '全部通过' : `${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
