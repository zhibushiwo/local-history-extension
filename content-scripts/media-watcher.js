// 媒体播放状态上报（content script，<all_urls> 注入，all_frames）
//
// 自限式设计：无常驻轮询——只挂 capture 事件监听（廉价），媒体开始播放
// 或页面加载时已有在播媒体才进入 5s 轮询；无媒体元素或连续 ~30s 无有效播放
// 即退出轮询回到零消息状态。99% 的普通页面全程零消息。
//
// "有效播放" = 未静音 + 未暂停 + 播放位置在前进：
// - 未静音：页面里自动播放的静音预览视频（搜索结果卡片等）不是用户在看的内容，
//   计入会违反"有声音才算时间"的语义，且其缓冲抖动会造成消息风暴（已发生过）
// - currentTime 在前进：排除 readyState 反复横跳导致的假播放
(function () {
  'use strict';

  let lastSent = null;
  let pollTimer = null;
  let tick = 0;
  let quiet = 0;
  const lastTime = new Map(); // 媒体元素 -> 上次 currentTime

  function anyPlaying() {
    let playing = false;
    for (const m of document.querySelectorAll('video, audio')) {
      const t = m.currentTime;
      const prev = lastTime.get(m);
      if (!m.muted && !m.paused && !m.ended && t !== prev) playing = true;
      lastTime.set(m, t);
    }
    return playing;
  }

  function send(playing) {
    try {
      chrome.runtime.sendMessage({ type: 'MEDIA_STATE', playing }).catch(() => {});
    } catch (e) {
      // 扩展上下文失效（刚重载过）——忽略
    }
  }

  function tickFn() {
    const hasMedia = document.querySelectorAll('video, audio').length > 0;
    const playing = anyPlaying();
    tick++;
    if (playing) quiet = 0;
    else quiet++;
    if (playing !== lastSent) {
      const first = lastSent === null;
      lastSent = playing;
      // 抑制初始 false：从未上报过且当前没在播 → 不发（普通页面零消息）
      if (!(first && playing === false)) send(playing);
    } else if (playing && tick % 4 === 0) {
      send(true); // 播放中 ~20s 心跳：持续唤醒 SW，结算增量远小于 90s 截断线
    }
    // 自限：无媒体元素、或连续 ~30s 无有效播放 → 停轮询，回到纯事件监听
    if (!hasMedia || quiet >= 6) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function schedule() {
    if (!pollTimer) {
      pollTimer = setInterval(tickFn, 5000);
      tick = 0;
      quiet = 0;
    }
    tickFn();
  }

  // 媒体事件不冒泡，capture 监听可捕获；事件只负责唤醒轮询
  ['play', 'playing', 'pause', 'ended', 'emptied', 'loadeddata', 'volumechange'].forEach(
    ev => document.addEventListener(ev, schedule, true),
  );
  // 页面加载时已有在播媒体（恢复标签/刷新）→ 直接进入轮询
  if (anyPlaying()) schedule();
  console.debug('[media-watcher] loaded');
})();
