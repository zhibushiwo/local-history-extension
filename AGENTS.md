# 我的历史记录扩展 — 功能清单（全部已实现）

Chrome MV3 扩展，个人私用（单机、单用户），独立 IndexedDB 存储浏览历史。
**2026-10-11 完成模块化架构重构**（功能与数据模型零变化）：`lib/`（db / recorder / dwell / search / export / settings / utils）、`background/service-worker.js`（事件接线）、`pages/history/`（主页面，单页双 Tab）、`pages/settings/`（设置页）、`popup/`（快捷入口）、`styles/base.css`（公共样式）。

**实现状态：17 项待办全部完成（2026-10-06）**，本文档转为功能/设计参考。Backlog 2 项未实现。

## 架构（2026-10-11 重构后）

ES modules，无构建步骤。DB schema（v3）与数据模型不变，旧数据零迁移。

- `lib/db.js`：IndexedDB 层 named exports（API 签名同旧 `MyHistoryDB` 全局），页面 / SW / popup 都 `import * as MyHistoryDB` 直连 IndexedDB，**不经 SW 消息协议**
- `lib/recorder.js`：URL 归一化、访问去重状态机、`recordTab`/无痕分流、`handleTabUpdated` debounce、`locateRecord`（供 dwell 定位记录）
- `lib/dwell.js`：停留时长纯逻辑 + 控制器工厂（chrome API 全部依赖注入，可在 Node 里单测）
- `lib/settings.js`：设置中心，`settings` 键存 `chrome.storage.local`，`saveSettings(patch)` 局部合并；已参数化 `recordDwell` / `idleThresholdSec` / `pageSize` / `backupStep`
- `lib/search.js` / `lib/export.js` / `lib/utils.js`：搜索解析匹配 / 导出构建 / 通用纯函数
- `pages/history/`：`history.js`（状态+绑定+列表渲染，~1440 行）+ `stats-view.js`（统计渲染，数据显式传参）
- `popup/`：总记录 / 今日访问 / 今日停留 + 暂停记录开关（与 `recordingPaused` 联动）

## 实现状态总览

| 项 | 功能 | 状态 |
|---|---|---|
| #3 | favicon 改回 18px | ✅ 2026-10-06 |
| #8 | 右下角回到顶部火箭 | ✅ 2026-10-06 |
| #5 | 默认筛选"今年" | ✅ 2026-10-06 |
| #4 | 查看某网站的历史记录（📋） | ✅ 2026-10-06 |
| #N | 记录备注（可搜索，`note:` 语法） | ✅ 2026-10-06 |
| #C | 热力图点击过滤当天 | ✅ 2026-10-06 |
| #2 | 导出备份提醒 | ✅ 2026-10-06 |
| #D | 存储用量显示 | ✅ 2026-10-06 |
| #1 | 批量删除 | ✅ 2026-10-06 |
| #A | 收藏/星标 | ✅ 2026-10-06 |
| #G | 按域名一键删除（经 📋+批量删除） | ✅ 2026-10-06 |
| #7 | 从 Chrome 历史同步 | ✅ 2026-10-06 |
| #H | 重复记录合并 | ✅ 2026-10-06 |
| #B | 暂停记录开关（⏸） | ✅ 2026-10-06 |
| #E | 保存的搜索 | ✅ 2026-10-06 |
| #F | 搜索框最近记录 | ✅ 2026-10-06 |
| #6 | 无痕记录支持（👻） | ✅ 2026-10-06 |
| #I | 页面停留时长（⏱） | ✅ 2026-10-07 |

---

## 已确认的关键设计决策（实现时遵循，勿推翻）

1. **网站历史搜索的范围跟随当前 tag**：点 📋 只把 `site:domain` 填入搜索框，不改当前时间范围。
2. **批量删除全选范围 = 当前筛选后的全部结果**（`filtered` 数组）；确认弹窗用原生 `confirm()`，文案含条数和"不可恢复"警告。**勾选框仅在「☑ 选择」模式下显示**（2026-10-07 精简：原条目上的 🗑️ 按域名删除按钮已移除，用 📋 → 全选筛选结果 → 删除选中 替代）。选中集合跨筛选切换时修剪为当前加载范围内的记录，保证确认条数 = 实际删除条数。
3. **无痕记录用 spanning 模式 + 独立 store**：manifest 不写 `incognito` 字段，`lib/recorder.js` 判断 `tab.incognito` 写入 `history_incognito`（单库 + timestamp 索引，不按年拆）。**数据永久保留，只有用户手动删除才清除**。
4. **无痕视图**：👻 入口，密码 SHA-256 哈希存 `chrome.storage.local`，每次进入都验证。视图内隐藏统计/导出/导入/同步/暂停/清空全部（`body.incognito-mode .normal-only` CSS 隔离）；提供「清空无痕记录」；普通「清空全部」不碰无痕库。
5. **范围切换收敛**为 `setRange(range)` 公共函数。
6. **性能红线**：数条数用 `store.count()`（`countAll()`），禁止用 `getAllHistory()` 数数。

---

## 阶段一：快速改进 ✅

### #3 favicon 改回 18px ✅
- `.item-favicon`：18px，margin-top 2px，首字母 11px

### #8 右下角回到顶部火箭 ✅
- 右下角 44px 圆形按钮，滚动 >600px 淡入（opacity 0.65），悬停变不透明 + 上移
- scroll 监听节流 100ms（passive）；z-index 90（toast 在底部居中、z-100，互不重叠）

### #5 默认筛选"今年" ✅
- 筛选栏顺序（2026-10-07 精简）：`[今年] [今天] [最近 30 天] [选择日期范围] [全部]`（已移除「昨天」「最近 7 天」chip 及对应的 `getRangeBounds` case）
- `getRangeBounds` `case 'year'`：当年 1/1 → 今天 23:59:59.999

---

## 阶段二：搜索与列表体验 ✅

### #4 查看某网站的历史记录 ✅
- 📋 按钮 → `applySearch('site:' + domain)`，范围跟随当前 tag
- `site:` 是 includes 匹配，子域不互通

### #N 记录备注 ✅
- 📝 按钮弹窗编辑（Ctrl+Enter 保存 / Esc 关闭），标题下绿色文本展示
- 全字段搜索覆盖 note；`note:关键词` 只搜备注
- **`patchRecord(storeName, id, patch)`**：纯 patch 不动 visitCount，`updateRecord` 内部复用它

### #C 热力图点击过滤当天 ✅
- 2026-10-07 重做：列表/统计改为双 Tab（共享筛选 chips），热力图点击**不再修改时间范围**，而是设置可移除的「仅看某天 ✕」覆盖层（只过滤列表），点击后自动切到列表 Tab；统计始终基于共享范围数据渲染，热力图不会因点选变空白

---

## 阶段三：数据安全 ✅

### #2 导出备份提醒 ✅
- `countAll()`（各 store count 求和）+ `lastRemindedThreshold`（chrome.storage.local）
- 档位（向下取整到万）> 上次提醒档位时显示横条；稍后再说/立即导出都写回档位

### #D 存储用量显示 ✅
- 统计面板第 5 张卡「已用空间」（KB/MB/GB 自适应）；横条文案带占用

---

## 阶段四：记录管理 ✅

### #1 批量删除 ✅
- 复选框 + 批量工具条；全选 = filtered；`deleteRecords(items)` 按年分 store 事务
- 单条/批量/清空都会同步清理 `selectedKeys`

### #A 收藏/星标 ✅
- ☆/★（金色常显）+ 「⭐ 已收藏」chip（与范围 chip 独立叠加）；`starred` 字段走 `patchRecord`
- 导出覆盖：MD 行首 ⭐、CSV「收藏」列、HTML ⭐、JSON 原生

### #G 按域名一键删除 ✅
- 2026-10-07 起条目上不再有独立 🗑️ 按钮，功能路径改为：📋（填入 `site:domain`）→ ☑ 选择 → 全选筛选结果 → 删除选中（复用批量删除 API，且可预览）

---

## 阶段五：Chrome 历史同步 ✅

### #7 从 Chrome 历史同步 ✅
- 「更多」菜单内：同步 Chrome 全部历史 / 最近 30 天；`history` 权限
- `chrome.history.search` maxResults 1000 + endTime 向前翻页；过滤非 http(s)/file
- 先读后确认条数，按年分 store 逐库导入（复用 `importRecords` 去重），进度 toast 动态更新

### #H 重复记录合并 ✅
- 「检测重复记录」：同 URL 且时间差 < 2 分钟 → 合并进最早一条，visitCount 累加，note/starred/title 空缺补齐

---

## 阶段六：便利功能 ✅

### #B 暂停记录开关 ✅
- 「更多」菜单内 ⏸ 项 → `chrome.storage.local.recordingPaused`；background `recordTab` 入口检查（对无痕记录同样生效）
- 暂停中菜单项变「▶ 恢复记录」（每次打开菜单时刷新状态）

### #E 保存的搜索 ✅
- 「常用搜索 ▾」菜单：条目点击应用 / ✕ 删除 / ➕ 保存当前搜索

### #F 搜索框最近记录 ✅
- 最近 10 条（去重），聚焦下拉展示点击回填；回车或失焦且词有变化时记录

---

## 阶段七：无痕记录支持 ✅

### #6 无痕记录 ✅
- DB v3：新增 `history_incognito` store；background 无痕分流 + 独立内存去重（SW 被杀仅影响去重精度）
- 👻 入口：首次设密码（两次确认），之后每次验证；SHA-256（`crypto.subtle`）哈希存储
- 无痕视图：紫色横条（清空无痕记录/退出）、普通控件 CSS 隔离；搜索/范围/星标/备注/批量/按域名删除全部可用且路由到无痕库
- 🕶️「用无痕窗口打开」两个视图都有
- 前提：chrome://extensions 开「在无痕模式下启用」；密码仅防偷瞄，帮助浮层已如实说明

### #I 页面停留时长 ✅（2026-10-07）

- **数据模型**：`dwellByDay`（对象，key=本地日期 dateKey，value=秒），按天累计不存明细段；旧数据无此字段=0，自然兼容
- **追踪控制器**（`lib/dwell.js`，SW 注入 chrome API）：所有事件（切标签/窗口焦点/idle/URL 变化/心跳/设置变更）收敛为单一 `refresh()` 入口 = 结算旧段 + 按"当前该不该计时"重开或清除，一律以"现在"为新基线，绝不按历史时间戳补算
  - 活跃段 `{tabId, normalized, incognito, storeName, recordId, startedAt}` 存 `chrome.storage.session`（**SW 被杀不丢段**）；`recordId` 开段时经 `recorder.locateRecord` 预解析（内存 `urlState` 优先，回退查最近 24h），结算时若为空再兜底定位一次
  - **心跳 alarm（2026-10-11 升级）**：计时期间挂 1 分钟 `dwell-flush` alarm（自愈式增删），SW 静默被回收后长会话按分钟增量落库不丢失（旧版会被 2h 封顶砍掉超出部分）
  - **精度约定（2026-10-11 升级）**：单次结算增量封顶 90s——合盖睡眠 8 小时只记 90s，截断部分有意丢弃；跨本地午夜按天拆分落库（`addDwellTime` 第 4 参 `dayKey`）；<5s 段丢弃；idle 阈值可设置（默认 60s，冷启动必须重设 `setDetectionInterval`）；窗口 minimized/locked-fullscreen 不计时；**后台标签不计时**（听歌/画中画不计入，有意设计）；暂停记录（recordingPaused）不停表（与旧版一致）
- **UI**：条目 meta「⏱ 3 分 12 秒」（dwellTotalOf 汇总 dwellByDay）；统计卡片「今日停留」（当天的 dwellByDay 求和）；「停留时间最长的网站 Top 10」榜
- **导出**：MD/HTML 显示格式化时长，CSV 加「停留(秒)」列，JSON 含 dwellByDay；导入保留
- 权限：`idle` / `alarms`；`chrome.storage.session` 无需权限
- **注意**：db.js `addDwellTime` 的日期 key 必须用**本地日期**（与 `getDateKey` 一致），勿用 UTC（曾埋过跨零点错位的坑）

---

## Backlog（未实现）

- **#J 手动暗色模式三态切换**（跟随/亮/暗）
- **#K 快捷键打开历史页**：`commands` API，如 Alt+H

---

## 列表体验调整（2026-10-07）

- **条目时间显示三层规则**：当天只显示时间（`14:30:05`）；当年非当天显示月日+时间（`10-05 14:30:05`）；往年显示完整年月日+时间
- **日期分组折叠/展开**：点击日期标题切换，指示符 ▼/▶；状态存内存 `collapsedDays` Set，翻页加载/改筛选/搜索后保持，不持久化（刷新重置）
- **访问趋势档位**：30 天 / 半年（180）/ 一年（365），默认 30 天；数据来自当前筛选范围（默认「今年」时一年图只画到 1/1 起）
- **关于"虚拟滚动"**：实现是分页渲染（触底经 IntersectionObserver 每次多画一页，已渲染的留在 DOM），不是 DOM 窗口化的虚拟滚动。每页条数可在设置页调（100/200/500，默认 200）。已知交互细节：大量折叠日期会使页面变短、可能连锁触发加载直至全部渲染；数据量大时如有卡顿可考虑加"折叠时暂停自动加载"保护，暂未做

---

## 维护注意事项

- manifest 权限：`tabs` / `history` / `storage` / `unlimitedStorage` / `favicon` / `idle` / `alarms`（2026-10-11 新增 alarms 供停留时长心跳）。**2026-10-06 曾发现缺 `"storage"` 导致 chrome.storage.local 全部静默失败（被 try/catch 掩盖）**，新增 storage 依赖时先核对权限
- db.js（现 `lib/db.js`，ES module named exports）API 全集：`patchRecord`（不动 visitCount）、`countAll`、`deleteRecords`、`mergeDuplicates`、无痕五件套（add/get/delete/deleteBatch/clear）；页面/SW/popup 均 `import * as MyHistoryDB` 直连
- 设置键 `settings`（chrome.storage.local，`lib/settings.js` 局部合并）：`recordDwell` / `idleThresholdSec` / `pageSize` / `backupStep`；SW 监听 `storage.onChanged` 热生效，history.js 启动时读取。与既有键（`recordingPaused` / `savedSearches` / `recentSearches` / `lastRemindedThreshold` / `incognitoPasswordHash`）互不干扰
- 所有 UI 文案中文；暗色模式跟随系统（`prefers-color-scheme`，变量在 `styles/base.css`）
- 导出四格式覆盖 note/starred/dwell；导入 `normalizeRecord` 保留 note/starred/dwellByDay
- 已知无害问题（不处理）：删除后 background `urlState` 脏引用（update 静默 null）；`updateRecord` 读-写两事务的理论竞态（丢一次 visitCount）；`doExport` 在筛选结果为 0 时兜底导出全部
- **visitCount 虚增修复（2026-10-07）**：SPA（DeepSeek/B站/GitHub 等）频繁改 `document.title` 曾被当作访问累加（78 次的来源）。现在只有 `changeInfo.status === 'complete'`（真实加载/刷新）才 `visitCount++`，仅标题/图标变化走 `patchVisitContent`（只更新标题/时间戳/图标）；debounce 窗口内任一 complete 事件即记为真实加载（`pendingLoads`）。历史虚高的旧数据无法还原，未处理
- 顶栏布局（2026-10-07 精简）：仅保留 [导出 ▾] [常用搜索 ▾] [更多 ▾]，其余功能（无痕/导入/同步/查重/暂停/清空全部/⚙ 设置）全部收入「更多」菜单；列表/统计为双 Tab 共享筛选栏
- 代码审查遗留记录（2026-10-06）：批量选择在 `loadRecords` 时修剪；热力图固定基于 `allRecords` 渲染；导入的 JSON 未过滤 `javascript:` URL（个人工具，点击才会触发，暂接受）
- **修改停留时长逻辑**：`lib/dwell.js` 是依赖注入设计（chrome API 全部由 SW 传入），纯逻辑部分（`splitAcrossMidnight` / `shouldCount` / 控制器）可在 Node 直接 import 写临时单测验证
