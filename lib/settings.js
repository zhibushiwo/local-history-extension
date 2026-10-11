// 设置中心：持久化于 chrome.storage.local 的 'settings' 键
// saveSettings 做局部合并：改一处设置不会重置其它设置
export const DEFAULT_SETTINGS = {
  recordDwell: true, // 是否记录页面停留时长
  idleThresholdSec: 60, // 系统空闲判定阈值（秒）：超过该时长无键鼠输入即停止计时
  pageSize: 200, // 历史列表每次渲染的条数（触底续载步长）
  backupStep: 10000, // 备份提醒档位（条）：向下取整到该档位才提醒
  siteNames: {}, // 自定义站点名称：domain -> 名称（统计页 Top 榜右键修改；留空用自动推导）
};

const KEY = 'settings';

export async function getSettings() {
  try {
    const obj = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...(obj[KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// 局部更新：与已存设置合并后再写入
export async function saveSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ [KEY]: { ...current, ...patch } });
}
