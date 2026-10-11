// 全量单测入口：node tests/run-all.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = ['dwell.test.mjs', 'search-behavior.test.mjs', 'site-name.test.mjs'];

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? '\n✓ 全部测试通过' : `\n✗ ${failed} 个测试文件失败`);
process.exit(failed === 0 ? 0 : 1);
