// 停留时长单测：node tests/dwell.test.mjs（或 node tests/run-all.mjs 全跑）
// 覆盖：collectDwellTargets 纯函数 + 多段控制器（并发/去抖隔离/看门狗/迁移/边界）
import {
  splitAcrossMidnight,
  shouldCount,
  collectDwellTargets,
  createDwellController,
  DWELL_MAX_DELTA_MS,
  MEDIA_GRACE_MS,
  MEDIA_PLAYING_TTL_MS,
} from '../lib/dwell.js';

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

// ── splitAcrossMidnight ──
console.log('splitAcrossMidnight:');
{
  const from = new Date(2026, 9, 11, 10, 0, 0).getTime();
  const to = new Date(2026, 9, 11, 11, 0, 0).getTime();
  const parts = splitAcrossMidnight(from, to);
  eq(parts.length, 1, '同一天不拆分');
  eq(parts[0].day, '2026-10-11', 'day 正确');
  eq(parts[0].ms, 3600000, 'ms 正确');
}
{
  const from = new Date(2026, 9, 11, 23, 59, 50).getTime();
  const to = new Date(2026, 9, 12, 0, 0, 20).getTime();
  const parts = splitAcrossMidnight(from, to);
  eq(parts.length, 2, '跨零点拆成两段');
  eq(parts.map(p => p.day), ['2026-10-11', '2026-10-12'], '前段归当天/后段归次日');
  eq(parts.reduce((a, p) => a + p.ms, 0), 30000, '总 ms 守恒');
}

// ── shouldCount ──
console.log('shouldCount:');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'maximized', idleState: 'active' }), true, '最大化算正常观看');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'fullscreen', idleState: 'active' }), true, '全屏算正常观看');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'normal', idleState: 'idle' }), false, '系统空闲不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'normal', idleState: 'idle', audible: true }), true, '系统空闲但媒体在播照样计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: false, windowState: 'normal', idleState: 'active' }), false, '失焦且无声不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: false, windowState: 'normal', idleState: 'active', audible: true }), true, '分屏/副屏：失焦但媒体在播照常计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: false, windowState: 'normal', idleState: 'idle', audible: true }), true, '失焦 + 有声 + 系统空闲照常计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'minimized', idleState: 'active', audible: true }), false, '最小化不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: false, windowState: 'minimized', idleState: 'active', audible: true }), false, '最小化即不可见，有声也不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'locked-fullscreen', idleState: 'active' }), false, '锁定全屏不计时');
eq(shouldCount({ url: 'chrome://version', windowFocused: true, windowState: 'normal', idleState: 'active' }), false, 'chrome 页不计时');

// ── collectDwellTargets ──
console.log('collectDwellTargets:');
function mkTab(over = {}) {
  return { id: 1, url: 'https://a.com/x', active: true, incognito: false, audible: false, ...over };
}
function mkWin(over = {}) {
  return { id: 100, focused: true, state: 'normal', type: 'normal', tabs: [mkTab()], ...over };
}
{
  const targets = collectDwellTargets([mkWin()], new Set());
  eq(targets.length, 1, '单窗口单候选');
  eq(targets[0].key, 'tab:1', 'key = tab:tabId');
  eq(targets[0].normalized, 'https://a.com/x', 'normalized 归一化');
  eq(targets[0].windowFocused, true, 'windowFocused 透传');
  eq(targets[0].windowState, 'normal', 'windowState 透传');
  eq(targets[0].incognito, false, 'incognito 默认 false');
  eq(targets[0].mediaPlaying, false, '不在 playingTabIds → false');
}
{
  const targets = collectDwellTargets(
    [mkWin({ id: 100 }), mkWin({ id: 200, focused: false, tabs: [mkTab({ id: 2, url: 'https://b.com/' })] })],
    new Set([2]),
  );
  eq(targets.length, 2, '双窗口双候选');
  eq(targets[1].mediaPlaying, true, 'playingTabIds 命中 → mediaPlaying true');
  eq(targets[1].windowFocused, false, '未聚焦窗口透传 false');
}
{
  const targets = collectDwellTargets(
    [
      mkWin({ state: 'minimized' }),
      mkWin({ id: 201, state: 'locked-fullscreen' }),
      mkWin({ id: 202, type: 'popup' }),
      mkWin({ id: 203, type: 'devtools' }),
      mkWin({ id: 204 }),
    ],
    new Set(),
  );
  eq(targets.length, 1, 'minimized/locked-fullscreen/popup/devtools 全部排除');
}
{
  const targets = collectDwellTargets([mkWin({ tabs: [mkTab({ url: 'chrome://version' })] })], new Set());
  eq(targets.length, 0, 'chrome:// 排除');
}
{
  const targets = collectDwellTargets(
    [mkWin({ tabs: [mkTab({ active: false }), mkTab({ id: 9, active: true, url: 'https://b.com/' })] })],
    new Set(),
  );
  eq(targets.length, 1, '多标签只取活动标签');
  eq(targets[0].key, 'tab:9', '取的是活动标签');
}
{
  const targets = collectDwellTargets([mkWin({ tabs: [] }), mkWin({ id: 205, tabs: [mkTab({ active: false })] })], new Set());
  eq(targets.length, 0, '空 tabs / 无活动标签不抛且跳过');
}
{
  const targets = collectDwellTargets([mkWin({ tabs: [mkTab({ incognito: true })] })], new Set());
  eq(targets[0].incognito, true, '无痕透传');
}
eq(MEDIA_GRACE_MS, 120000, 'MEDIA_GRACE_MS = 120s');
eq(MEDIA_PLAYING_TTL_MS, 45000, 'MEDIA_PLAYING_TTL_MS = 45s');

// ── 控制器（多段） ──
console.log('controller:');

// 依赖构造：session（支持数组 get）+ getDwellTargets 直出 targets
function makeDeps(env) {
  const session = new Map();
  const dwellWrites = [];
  let alarmOn = false;
  return {
    env,
    dwellWrites,
    deps: {
      session: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (session.has(k)) out[k] = session.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) session.set(k, v);
        },
        async remove(keys) {
          for (const k of [].concat(keys)) session.delete(k);
        },
      },
      async getSettings() {
        return env.settings;
      },
      setIdleThreshold() {},
      async addDwellTime(storeName, recordId, seconds, dayKey) {
        dwellWrites.push({ storeName, recordId, seconds, dayKey });
      },
      async locateRecord(normalized) {
        return env.records[normalized] || null;
      },
      async syncAlarm(active) {
        alarmOn = active;
      },
      async getDwellTargets() {
        return typeof env.targets === 'function' ? env.targets() : env.targets;
      },
      async getIdleState() {
        return env.idleState;
      },
    },
    get rawSession() {
      return session;
    },
    get alarmOn() {
      return alarmOn;
    },
    get segs() {
      return session.get('dwellSegments') || {};
    },
  };
}

const REC_A = { storeName: 'history_2026', recordId: 42 };
const REC_B = { storeName: 'history_2026', recordId: 7 };
const T_A = { key: 'tab:1', tabId: 1, url: 'https://a.com/x', normalized: 'a.com/x', incognito: false, windowFocused: true, windowState: 'normal', audible: true, mediaPlaying: false };
const T_B = { key: 'tab:2', tabId: 2, url: 'https://b.com/y', normalized: 'b.com/y', incognito: false, windowFocused: false, windowState: 'normal', audible: true, mediaPlaying: false };

{
  // 两目标并发：各写各记录
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A, T_B],
    idleState: 'active',
    records: { 'a.com/x': REC_A, 'b.com/y': REC_B },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  eq(Object.keys(m.segs).length, 2, '两段并发');
  await c.refresh(t0 + 60000);
  const a = m.dwellWrites.filter(w => w.recordId === 42);
  const b = m.dwellWrites.filter(w => w.recordId === 7);
  eq(a.length, 1, 'A 落库一次');
  eq(b.length, 1, 'B 落库一次');
  eq(a[0].seconds, 60, 'A 记 60s');
  eq(b[0].seconds, 60, 'B 记 60s');
}
{
  // 同 URL 两标签：命中同一记录，时间相加
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A, { ...T_B, url: 'https://a.com/x', normalized: 'a.com/x' }],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  await c.refresh(t0 + 60000);
  const writes = m.dwellWrites.filter(w => w.recordId === 42);
  eq(writes.length, 2, '两段分别落库');
  eq(writes.reduce((a, w) => a + w.seconds, 0), 120, '同记录时间相加 120s');
}
{
  // 目标消失 → 仅该段结算清除，其余保留
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A, T_B],
    idleState: 'active',
    records: { 'a.com/x': REC_A, 'b.com/y': REC_B },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  m.env.targets = [T_A]; // B 关闭
  await c.refresh(t0 + 60000);
  eq(Object.keys(m.segs), ['tab:1'], 'B 段清除、A 段保留');
  const b = m.dwellWrites.filter(w => w.recordId === 7);
  eq(b.length, 1, 'B 结算一次');
  eq(b[0].seconds, 60, 'B 结算 60s');
  await c.refresh(t0 + 120000);
  const a = m.dwellWrites.filter(w => w.recordId === 42);
  eq(a.length, 2, 'A 继续计时');
}
{
  // grace：目标出声后静音失焦，120s 内续计、超时停
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0); // audible → lastMediaAt = t0
  m.env.idleState = 'idle';
  m.env.targets = [{ ...T_A, audible: false, windowFocused: false }];
  await c.refresh(t0 + 60000); // 60s < 120s 宽限
  eq(m.dwellWrites.filter(w => w.recordId === 42).length, 1, '宽限期内续计');
  await c.refresh(t0 + 200000); // 超过宽限
  const writes = m.dwellWrites.filter(w => w.recordId === 42);
  eq(writes.length, 2, '两次结算');
  eq(writes[1].seconds, 90, '超宽限停表（本次结算封顶 90s）');
  eq(Object.keys(m.segs).length, 0, '段已清除');
}
{
  // grace 按目标隔离：A 的出声不使静音 B 续计
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A, { ...T_B, audible: false, windowFocused: false }],
    idleState: 'active',
    records: { 'a.com/x': REC_A, 'b.com/y': REC_B },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0); // A rawOn、B 无信号
  m.env.idleState = 'idle';
  m.env.targets = [
    { ...T_A, audible: false, windowFocused: false },
    { ...T_B, audible: false, windowFocused: false },
  ];
  await c.refresh(t0 + 60000);
  eq(m.dwellWrites.some(w => w.recordId === 42), true, 'A 走宽限续计');
  eq(m.dwellWrites.some(w => w.recordId === 7), false, 'B 无信号不沾 A 的宽限');
}
{
  // 看门狗：聚焦目标因 idle 停表 → alarm 保留、无写入
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [{ ...T_A, audible: false }],
    idleState: 'idle',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(m.dwellWrites.length, 0, '空闲停表无写入');
  eq(m.alarmOn, true, 'alarm 保留（看门狗）');
}
{
  // 人离开（全部失焦）且无段 → alarm 撤掉
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [{ ...T_A, audible: false, windowFocused: false }],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(m.alarmOn, false, '全部失焦无段 → alarm 撤掉');
}
{
  // recordDwell=false：无段无 alarm
  const m = makeDeps({
    settings: { recordDwell: false, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(Object.keys(m.segs).length, 0, '无段');
  eq(m.alarmOn, false, 'alarm 撤掉');
  eq(m.dwellWrites.length, 0, '无写入');
}
{
  // 睡眠截断：8h 只记 90s
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  await c.refresh(t0 + 8 * 3600000);
  const a = m.dwellWrites.filter(w => w.recordId === 42);
  eq(a.length, 1, '一次结算');
  eq(a[0].seconds, DWELL_MAX_DELTA_MS / 1000, '超长区间封顶 90s');
}
{
  // 跨午夜：两条 dayKey
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 23, 59, 50).getTime();
  await c.refresh(t0);
  await c.refresh(t0 + 30000);
  eq(m.dwellWrites.map(w => [w.dayKey, w.seconds]), [['2026-10-11', 10], ['2026-10-12', 20]], '跨零点拆分落库');
}
{
  // <5s 丢弃：目标消失后 3s 才结算
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  m.env.targets = [];
  await c.refresh(t0 + 3000);
  eq(m.dwellWrites.length, 0, '<5s 段丢弃');
}
{
  // 兜底 locate：开段时记录未创建，结算时定位成功
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [{ ...T_A, url: 'https://b.com/y', normalized: 'b.com/y' }],
    idleState: 'active',
    records: {},
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  m.env.records['b.com/y'] = { storeName: 'history_2026', recordId: 7 };
  await c.refresh(t0 + 30000);
  eq(m.dwellWrites.length, 1, '写入一次');
  eq(m.dwellWrites[0].recordId, 7, '结算时兜底定位成功');
}
{
  // SW 重启：session 保留的段被新控制器 settle-all
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  const c1 = createDwellController(m.deps);
  await c1.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c1.refresh(t0);
  const c2 = createDwellController(m.deps); // 模拟 SW 重启（session 同一份）
  await c2.loadSettings();
  await c2.refresh(t0 + 60000);
  eq(m.dwellWrites.length, 1, '写入一次');
  eq(m.dwellWrites[0].seconds, 60, '重启后沿用 session 结算 60s');
}
{
  // 旧键 dwellSegment：首次读取被忽略并清除
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    targets: [T_A],
    idleState: 'active',
    records: { 'a.com/x': REC_A },
  });
  m.deps.session.set({ dwellSegment: { tabId: 99, startedAt: 0 } });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(m.rawSession.has('dwellSegment'), false, '旧键已清除');
  eq(m.dwellWrites.length, 0, '旧键内容未参与结算');
}

console.log(failed === 0 ? '全部通过' : `${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
