// 媒体播放状态上报（content script，注入视频站点白名单，all_frames）
// "有效播放" = 未静音 + 未暂停 + 播放位置在前进。
// 必须未静音：页面里自动播放的静音预览视频（如搜索结果卡片）不是用户在看的
// 内容，若计入会违反"有声音才算时间"的语义，且其缓冲抖动会造成消息风暴。
// currentTime 在前进：排除 readyState 反复横跳导致的假播放。
(function () {
  'use strict';

  let lastSent = null;
  let tick = 0;
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

  function report() {
    tick++;
    const playing = anyPlaying();
    if (playing !== lastSent) {
      lastSent = playing;
      send(playing);
    } else if (playing && tick % 4 === 0) {
      send(true); // 播放中 ~20s 心跳：持续唤醒 SW，结算增量远小于 90s 截断线
    }
  }

  // 媒体事件不冒泡，capture 监听可捕获；5s 轮询负责变化检测（SPA 动态创建的播放器）
  ['play', 'pause', 'ended', 'emptied', 'loadeddata'].forEach(ev =>
    document.addEventListener(ev, report, true),
  );
  setInterval(report, 5000);
  report();
  console.debug('[media-watcher] loaded, playing =', anyPlaying());
})();
