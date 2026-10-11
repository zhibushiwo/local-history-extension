// 站点名称推导单测：node tests/site-name.test.mjs
import {
  cleanSiteName,
  deriveSiteNameMap,
  siteLabel,
} from '../lib/site-name.js';

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

console.log('cleanSiteName:');
eq(cleanSiteName('哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', 'https://x.com'), '', '无空格连字符不切分，整串超长弃用（B站实际推不出名）');
eq(cleanSiteName('哔哩哔哩 - 干杯', 'https://x.com'), '哔哩哔哩', '按 - 截断');
eq(cleanSiteName('GitHub - Where the world builds software', 'https://github.com'), 'GitHub', '按 - 截断');
eq(cleanSiteName('知乎 - 有问题，就会有答案', 'https://zhihu.com'), '知乎', '中文分隔符');
eq(cleanSiteName('https://example.com', 'https://example.com'), '', '标题等于 URL 视为无');
eq(cleanSiteName('', 'https://x.com'), '', '空标题');
eq(cleanSiteName('一个特别特别特别特别特别特别特别特别特别长的标题超过二十个字了', 'https://x.com'), '', '超 20 字弃用');

console.log('deriveSiteNameMap:');
{
  const recs = [
    { domain: 'github.com', title: 'GitHub', url: 'https://github.com' },
    { domain: 'github.com', title: '某仓库 - GitHub', url: 'https://github.com/a/b/very/long/path' },
    { domain: 'www.zhihu.com', title: '知乎 - 有问题，就会有答案', url: 'https://www.zhihu.com/question/1' },
    { domain: 'v2ex.com', title: '知乎', url: 'https://v2ex.com/t/1' }, // 同名"知乎"出现在两个域名 → 双双弃用
  ];
  const m = deriveSiteNameMap(recs);
  eq(m['github.com'], 'GitHub', '取 URL 最短的标题');
  eq('www.zhihu.com' in m, false, '同名多域名弃用');
  eq('v2ex.com' in m, false, '同名多域名弃用');
}
eq(siteLabel('github.com', 'GitHub', { 'github.com': '[Github]' }), '[Github]', '别名优先');
eq(siteLabel('github.com', '', {}), '', '无推导无别名为空');

console.log(failed === 0 ? '全部通过' : `${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
