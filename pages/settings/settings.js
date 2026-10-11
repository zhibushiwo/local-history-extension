// 设置页：读写 chrome.storage.local 的 settings（局部合并），变更即时生效
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../../lib/settings.js';

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function fillForm(s) {
  $('recordDwell').checked = s.recordDwell !== false;
  $('idleThresholdSec').value = String(s.idleThresholdSec || DEFAULT_SETTINGS.idleThresholdSec);
  $('pageSize').value = String(s.pageSize || DEFAULT_SETTINGS.pageSize);
  $('backupStep').value = String(s.backupStep || DEFAULT_SETTINGS.backupStep);
}

function readForm() {
  return {
    recordDwell: $('recordDwell').checked,
    // 空闲阈值下限 15s：setDetectionInterval 的合理下限，防止误填过小值
    idleThresholdSec: Math.min(3600, Math.max(15, Number($('idleThresholdSec').value) || DEFAULT_SETTINGS.idleThresholdSec)),
    pageSize: Number($('pageSize').value) || DEFAULT_SETTINGS.pageSize,
    backupStep: Number($('backupStep').value) || DEFAULT_SETTINGS.backupStep,
  };
}

$('saveBtn').addEventListener('click', async () => {
  try {
    await saveSettings(readForm());
    toast('设置已保存，立即生效');
  } catch (err) {
    console.error(err);
    toast('保存失败');
  }
});

$('resetBtn').addEventListener('click', async () => {
  try {
    await saveSettings({ ...DEFAULT_SETTINGS });
    fillForm(DEFAULT_SETTINGS);
    toast('已恢复默认设置');
  } catch (err) {
    console.error(err);
    toast('操作失败');
  }
});

$('nav-history').addEventListener('click', () => {
  location.assign(chrome.runtime.getURL('pages/history/history.html'));
});

(async () => {
  try {
    fillForm(await getSettings());
  } catch (err) {
    console.error(err);
    fillForm(DEFAULT_SETTINGS);
  }
})();
