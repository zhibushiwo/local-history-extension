// 打包脚本：node pack.mjs
// 只打运行所需文件（manifest / background / lib / pages / popup / styles / icons），
// 排除 AGENTS.md、README.md、tests/、dist/ 等开发文件。
// 产物：dist/local-history-extension-v<版本>.zip，解压后把里面的文件夹拖进
// chrome://extensions（开发者模式）即可使用。
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);

const INCLUDE = ['manifest.json', 'background', 'lib', 'pages', 'popup', 'styles', 'icons'];
const stageName = 'local-history-extension';
const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));

const dist = path.join(root, 'dist');
const stage = path.join(dist, stageName);
const zipPath = path.join(dist, `${stageName}-v${version}.zip`);

for (const item of INCLUDE) {
  if (!existsSync(item)) throw new Error('打包缺少运行文件: ' + item);
}

rmSync(stage, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stage, { recursive: true });
for (const item of INCLUDE) {
  cpSync(item, path.join(stage, item), { recursive: true });
}

// Windows 自带 PowerShell 的 Compress-Archive（保留相对目录结构）
execSync(
  `powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force"`,
  { stdio: 'inherit' },
);
rmSync(stage, { recursive: true, force: true });

console.log('打包完成 →', zipPath);
