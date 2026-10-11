// 停留时长纯逻辑单测：node tests/dwell.test.mjs（或 node tests/run-all.mjs 全跑）
import {
  splitAcrossMidnight,
  shouldCount,
  createDwellController,
  DWELL_MAX_DELTA_MS,
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
  eq(parts[0].day, '2026-10-11', '前段归当天');
  eq(parts[0].ms, 10000, '前段 10s');
  eq(parts[1].day, '2026-10-12', '后段归次日');
  eq(parts[1].ms, 20000, '后段 20s');
}
{
  const from = new Date(2026, 9, 11, 23, 0, 0).getTime();
  const to = new Date(2026, 9, 13, 1, 0, 0).getTime();
  const parts = splitAcrossMidnight(from, to);
  eq(parts.map((p) => p.day), ['2026-10-11', '2026-10-12', '2026-10-13'], '跨多天拆三段');
  eq(parts.reduce((a, p) => a + p.ms, 0), 26 * 3600000, '总 ms 守恒');
}

// ── shouldCount ──
console.log('shouldCount:');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'maximized', idleState: 'active' }), true, '最大化算正常观看');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'fullscreen', idleState: 'active' }), true, '全屏算正常观看');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'minimized', idleState: 'active' }), false, '最小化不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'locked-fullscreen', idleState: 'active' }), false, '锁定全屏不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: false, windowState: 'normal', idleState: 'active' }), false, '失焦不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'normal', idleState: 'idle' }), false, '系统空闲不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'normal', idleState: 'idle', audible: true }), true, '系统空闲但标签出声（看视频）照样计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: false, windowState: 'normal', idleState: 'idle', audible: true }), false, '出声但失焦仍不计时');
eq(shouldCount({ url: 'https://a.com', windowFocused: true, windowState: 'minimized', idleState: 'idle', audible: true }), false, '出声但最小化仍不计时');
eq(shouldCount({ url: 'chrome://version', windowFocused: true, windowState: 'normal', idleState: 'active' }), false, 'chrome 页不计时');

// ── 控制器 ──
function makeDeps(env) {
  const session = new Map();
  const dwellWrites = [];
  let alarmOn = false;
  return {
    env,
    dwellWrites,
    deps: {
      session: {
        async get(k) { return session.has(k) ? { [k]: session.get(k) } : {}; },
        async set(obj) { for (const [k, v] of Object.entries(obj)) session.set(k, v); },
        async remove(k) { session.delete(k); },
      },
      async getSettings() { return env.settings; },
      setIdleThreshold() {},
      async addDwellTime(storeName, recordId, seconds, dayKey) {
        dwellWrites.push({ storeName, recordId, seconds, dayKey });
      },
      async locateRecord(normalized) {
        return env.records[normalized] || null;
      },
      async syncAlarm(active) { alarmOn = active; },
      async getActiveContext() { return env.context; },
      async getIdleState() { return env.idleState; },
    },
    get alarmOn() { return alarmOn; },
    get seg() { return session.get('dwellSegment') || null; },
  };
}

const REC = { storeName: 'history_2026', recordId: 42 };
const CTX = {
  tabId: 1,
  url: 'https://a.com/x',
  normalized: 'a.com/x',
  incognito: false,
  windowFocused: true,
  windowState: 'normal',
};

console.log('controller:');
{
  const { deps, dwellWrites } = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: CTX,
    idleState: 'active',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  eq(!!(await deps.session.get('dwellSegment') && true), true, '开段');
  await c.refresh(t0 + 60000); // 心跳：结算 60s 并续段
  eq(dwellWrites.length, 1, '心跳结算一次');
  eq(dwellWrites[0], { storeName: 'history_2026', recordId: 42, seconds: 60, dayKey: '2026-10-11' }, '60s 归当天该记录');
  await c.refresh(t0 + 90000);
  eq(dwellWrites.length, 2, '再次结算');
  eq(dwellWrites[1].seconds, 30, '增量 30s');
}
{
  // 睡眠截断：8 小时后只记 90s
  const { deps, dwellWrites } = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: CTX,
    idleState: 'active',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  await c.refresh(t0 + 8 * 3600000);
  eq(dwellWrites.length, 1, '超长区间只结算一次');
  eq(dwellWrites[0].seconds, DWELL_MAX_DELTA_MS / 1000, '封顶 90s');
}
{
  // 跨零点：23:59:50 开段，00:00:20 结算
  const { deps, dwellWrites } = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: CTX,
    idleState: 'active',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 23, 59, 50).getTime();
  await c.refresh(t0);
  await c.refresh(t0 + 30000);
  eq(dwellWrites.length, 2, '跨零点写两行');
  eq(dwellWrites.map((w) => [w.dayKey, w.seconds]), [['2026-10-11', 10], ['2026-10-12', 20]], '10s 归当天 / 20s 归次日');
}
{
  // 短段丢弃：3s 后切走
  const { deps, dwellWrites, env } = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: CTX,
    idleState: 'active',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  env.context = null; // 切到不可计时状态
  await c.refresh(t0 + 3000);
  eq(dwellWrites.length, 0, '<5s 段丢弃');
}
{
  // recordDwell=false：不计时、不开 alarm
  const { deps, dwellWrites } = makeDeps({
    settings: { recordDwell: false, idleThresholdSec: 60 },
    context: CTX,
    idleState: 'active',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(dwellWrites.length, 0, '关闭后不写时长');
  eq((await deps.session.get('dwellSegment')).dwellSegment || null, null, '无段');
}
{
  // 记录晚于开段创建：结算时兜底定位
  const { deps, dwellWrites, env } = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: { ...CTX, url: 'https://b.com/y', normalized: 'b.com/y' },
    idleState: 'active',
    records: {},
  });
  const c = createDwellController(deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0);
  env.records['b.com/y'] = { storeName: 'history_2026', recordId: 7 }; // 页面加载完，记录出现
  await c.refresh(t0 + 30000);
  eq(dwellWrites.length, 1, '结算时兜底定位成功');
  eq(dwellWrites[0].recordId, 7, '定位到新记录');
}
{
  // 看门狗：空闲停表时 alarm 保留，声音恢复可自动续计
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: { ...CTX, audible: false },
    idleState: 'idle',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(m.alarmOn, true, '空闲停表但 alarm 保留（看门狗）');
  eq(m.dwellWrites.length, 0, '无出声不计时长');
}
{
  // recordDwell=false：不计时且 alarm 撤掉（不留看门狗空转）
  const m = makeDeps({
    settings: { recordDwell: false, idleThresholdSec: 60 },
    context: { ...CTX, audible: false },
    idleState: 'idle',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  await c.refresh(Date.now());
  eq(m.alarmOn, false, '功能关闭时 alarm 撤掉');
}
{
  // audible 去抖：开段时出声，随后静音+idle 落在 120s 宽限内 → 不断表
  const m = makeDeps({
    settings: { recordDwell: true, idleThresholdSec: 60 },
    context: { ...CTX, audible: true },
    idleState: 'active',
    records: { 'a.com/x': REC },
  });
  const c = createDwellController(m.deps);
  await c.loadSettings();
  const t0 = new Date(2026, 9, 11, 10, 0, 0).getTime();
  await c.refresh(t0); // audible → lastAudibleAt = t0
  m.env.idleState = 'idle';
  m.env.context = { ...CTX, audible: false };
  await c.refresh(t0 + 60000); // 60s < 120s 宽限
  eq(m.dwellWrites[0].seconds, 60, '静音间隙（<120s 宽限）不断表');
  await c.refresh(t0 + 200000); // 超过宽限 → 停表
  const last = m.dwellWrites[m.dwellWrites.length - 1];
  eq(last.seconds, 90, '超过宽限后停表（本次结算封顶 90s）');
  eq(m.alarmOn, true, '停表后 alarm 保留（看门狗）');
}

console.log(failed === 0 ? '全部通过' : `${failed} 个用例失败`);
process.exit(failed === 0 ? 0 : 1);
