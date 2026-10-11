// 媒体播放状态上报（content script，注入视频站点白名单，all_frames）
// 检测本 frame 内 <video>/<audio> 是否在播放，变化即报、播放中定期心跳。
// 这是 tab.audible 的可靠替代：直接读媒体元素状态，静音播放也能覆盖。
(function () {
  'use strict';

  let lastSent = null;
  let tick = 0;

  function anyPlaying() {
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused && !m.ended && m.readyState > 2) return true;
    }
    return false;
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
    } else if (playing && tick % 6 === 0) {
      send(true); // 播放中每 ~30s 心跳：SW 被回收重启后状态能自愈
    }
  }

  // 媒体事件不冒泡，capture 监听可捕获；轮询兜底（SPA 动态创建的播放器）
  ['play', 'pause', 'ended', 'emptied', 'loadeddata'].forEach(ev =>
    document.addEventListener(ev, report, true),
  );
  setInterval(report, 5000);
  report();
})();
