# 我的历史记录

Chrome MV3 扩展：把浏览历史存进**扩展自己的 IndexedDB**，突破浏览器约 90 天的历史保留限制——个人私用，单机单用户，全部数据只留本机。

## 功能

- **长期留存**：按年分库存储（2024–2040），支持跨年查询，数据永久保留直至手动删除
- **智能记录**：URL 归一化去追踪参数、1 分钟访问合并、SPA 标题变化不虚增访问次数
- **停留时长**：前台聚焦或媒体播放中即计时（分屏/副屏看视频也计入），系统空闲自动豁免有声媒体，心跳增量落库（睡眠截断、跨零点拆分），列表/统计/popup 三处展示
- **高级搜索**：`site:` `note:` `after:` `before:` `title:` `url:` `/正则/` 组合，保存的搜索 + 搜索框最近记录
- **统计面板**（趋势 / Top 榜 / 分布 三个分组）：访问与停留双指标热力图、趋势图、页面/网站/关键词排行、搜索行为分析（Bing/Google/百度/搜狗/DDG + B站/掘金/GitHub 站内搜索）
- **站点别名**：统计图上自动推导站点名，右键可改
- **管理**：备注（可搜索）、收藏、批量删除、按域名筛选删除、重复记录合并
- **无痕记录**：独立加密视图（密码仅防偷瞄），数据与普通历史完全隔离
- **数据安全**：条数档位备份提醒、上次导出时间展示、四格式导出（JSON / Markdown / CSV / HTML）、JSON 导入、从 Chrome 历史同步
- **入口**：工具栏 popup（计数概览 + 暂停开关）、快捷键 `Ctrl+Shift+H`（Mac `Command+Shift+H`）打开历史页

## 安装

1. 下载并解压（或 `git clone`）
2. 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本目录；或直接把文件夹拖进该页面
4. 建议在扩展详情里开启「在无痕模式下启用」（如需无痕记录功能）

## 隐私

- 全部记录保存在扩展自己的 IndexedDB，**不上传、不请求任何网络接口**（站点图标也来自浏览器本地缓存）
- 在视频站点白名单（B站、YouTube 等）内注入一个轻量脚本，仅用于读取播放器的播放状态以统计停留时长，不采集、不上传任何页面数据
- 同步、导出、清空都由手动触发

## 开发

纯原生 ES Modules，无构建步骤、无运行时依赖。

```
background/service-worker.js   事件接线（记录 / 停留时长）
lib/                           数据层与纯逻辑（db / recorder / dwell / search / search-behavior / site-name / export / settings / utils）
pages/history/                 主页面（列表 + 统计，单页双 Tab）
popup/                         工具栏弹窗
tests/                         纯逻辑单测（node tests/run-all.mjs）
pack.mjs                       打包脚本：node pack.mjs → dist/*.zip
```

跑测试：`node tests/run-all.mjs`
打包：`node pack.mjs`（输出 `dist/local-history-extension-vX.Y.Z.zip`，仅含运行所需文件）
