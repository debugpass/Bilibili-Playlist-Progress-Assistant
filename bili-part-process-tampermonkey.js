// ==UserScript==
// @name         Bilibili 播放列表总时长定位
// @namespace    local.bilibili.playlist-position
// @version      1.1.0
// @description  在 B 站视频页面右栏精选区显示当前视频在整个选集列表总时长中的位置
// @match        https://www.bilibili.com/video/*
// @run-at       document-idle
// @license      MIT
// @grant        none
// @downloadURL https://update.greasyfork.org/scripts/594182/Bilibili%20%E6%92%AD%E6%94%BE%E5%88%97%E8%A1%A8%E6%80%BB%E6%97%B6%E9%95%BF%E5%AE%9A%E4%BD%8D.user.js
// @updateURL https://update.greasyfork.org/scripts/594182/Bilibili%20%E6%92%AD%E6%94%BE%E5%88%97%E8%A1%A8%E6%80%BB%E6%97%B6%E9%95%BF%E5%AE%9A%E4%BD%8D.meta.js
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_ID = 'bili-playlist-position-panel';
  const RESTORE_ID = 'bili-playlist-position-restore';
  const RESTORE_TEXT = '显示播放列表进度';
  const STYLE_ID = 'bili-playlist-position-style';
  const ITEM_SELECTOR = '.video-pod__body .video-pod__item';
  const ANCHOR_SELECTOR = '.rcmd-tab';
  const FALLBACK_ANCHOR_SELECTOR = '.video-pod';
  const CONTAINER_SELECTORS = [
    '.right-container-inner.scroll-sticky',
    '.right-container-inner',
    '.scroll-sticky'
  ];
  const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
  // null 表示遵循默认状态；用户操作后保留其展开/收起选择。
  let manuallyHidden = null;
  let panelRef = null;
  let restoreRef = null;
  let mountTimer = 0;

  function parseDuration(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
    if (!match) return NaN;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const third = match[3] == null ? 0 : Number(match[3]);
    return match[3] == null ? first * 60 + second : first * 3600 + second * 60 + third;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function getItemDuration(item) {
    const durationNode = item.querySelector('.duration');
    const durationText = durationNode ? durationNode.textContent : '';
    const direct = parseDuration(durationText);
    if (Number.isFinite(direct)) return direct;

    // 兼容 B 站 DOM 变化：从该集文本中寻找最后一个时间串。
    const matches = (item.textContent || '').match(/\b\d+:\d{2}(?::\d{2})?\b/g) || [];
    return parseDuration(matches.length ? matches[matches.length - 1] : '');
  }

  function getCurrentIndex(items) {
    const activeIndex = items.findIndex((item) =>
      item.classList.contains('active') || item.classList.contains('on') || item.querySelector('.active, .on') !== null
    );
    if (activeIndex >= 0) return activeIndex;

    // active 类尚未刷新时，用 URL 中的 p 参数兜底。
    const p = Number(new URL(location.href).searchParams.get('p'));
    return Number.isInteger(p) && p > 0 && p <= items.length ? p - 1 : 0;
  }

  function getContainers() {
    for (const selector of CONTAINER_SELECTORS) {
      const containers = [...document.querySelectorAll(selector)];
      if (containers.length) return containers;
    }
    return [];
  }

  function getMountPoint() {
    const containers = getContainers();
    for (const container of containers) {
      const tab = container.querySelector(ANCHOR_SELECTOR);
      if (tab) {
        let anchor = tab.querySelector(FALLBACK_ANCHOR_SELECTOR);
        // 即使选集被额外包裹，也把面板放在 rcmd-tab 的直接子级。
        while (anchor && anchor.parentElement !== tab) anchor = anchor.parentElement;
        return { container: tab, anchor };
      }
    }
    if (!containers.length) return null;
    const container = containers[0];
    return { container, anchor: container.querySelector(FALLBACK_ANCHOR_SELECTOR) };
  }

  function isMountedAt(mount) {
    const panel = panelRef;
    const restore = restoreRef;
    if (!panel || !panel.isConnected || !restore || !restore.isConnected) return false;
    if (!mount) return false;
    if (mount.anchor) {
      return panel.parentElement === mount.anchor.parentElement &&
        panel.previousElementSibling === mount.anchor &&
        restore.parentElement === panel.parentElement &&
        restore.previousElementSibling === panel;
    }
    return panel.parentElement === mount.container &&
      mount.container.firstElementChild === panel &&
      restore.parentElement === panel.parentElement &&
      restore.previousElementSibling === panel;
  }

  function mountPanel() {
    const panel = panelRef;
    const restore = restoreRef;
    if (!panel || !restore) return false;
    const mount = getMountPoint();
    if (!mount) return false;
    if (isMountedAt(mount)) return true;

    if (mount.anchor) {
      mount.anchor.insertAdjacentElement('afterend', panel);
    } else {
      mount.container.prepend(panel);
    }
    panel.insertAdjacentElement('afterend', restore);
    return true;
  }

  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = window.setTimeout(() => {
      mountTimer = 0;
      mountPanel();
      syncVisibility();
    }, 300);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      /* 右栏可能禁用鼠标命中，显式恢复脚本面板及按钮的交互。 */
      #${PANEL_ID},
      #${PANEL_ID} .bili-pp-hide,
      #${RESTORE_ID} {
        pointer-events: auto;
      }
      #${PANEL_ID} {
        position: relative;
        width: 100%;
        box-sizing: border-box;
        margin: 12px 0;
        padding: 12px 14px;
        color: var(--text1, #18191c);
        background: var(--bg2, #f6f7f8);
        border: 1px solid var(--line_regular, #e3e5e7);
        border-radius: 8px;
        clear: both;
        font: 16px/1.55 ${FONT_FAMILY};
        overflow: hidden;
      }
      #${PANEL_ID} .bili-pp-hide {
        position: absolute;
        top: 6px;
        right: 8px;
        padding: 0 4px;
        color: var(--text3, #9499a0);
        background: transparent;
        border: 0;
        cursor: pointer;
        font-size: 16px;
        line-height: 20px;
      }
      #${PANEL_ID} .bili-pp-hide:hover { color: var(--text1, #18191c); }
      #${RESTORE_ID} {
        display: none;
        width: 100%;
        box-sizing: border-box;
        margin: 12px 0;
        padding: 9px 12px;
        color: var(--text1, #18191c);
        background: var(--bg2, #f6f7f8);
        border: 1px solid var(--line_regular, #e3e5e7);
        border-radius: 8px;
        clear: both;
        cursor: pointer;
        font: 13px/1.4 ${FONT_FAMILY};
        text-align: center;
      }
      #${RESTORE_ID}:hover {
        color: var(--brand_blue, #00aeec);
        border-color: var(--brand_blue, #00aeec);
      }
      #${PANEL_ID} .bili-pp-title {
        margin-bottom: 5px;
        padding-right: 20px;
        color: var(--text1, #18191c);
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .bili-pp-line { margin: 2px 0; color: var(--text2, #61666d); }
      #${PANEL_ID} .bili-pp-percent { color: var(--brand_blue, #00aeec); font-weight: 700; }
      #${PANEL_ID} .bili-pp-bar {
        height: 5px;
        margin-top: 8px;
        overflow: hidden;
        background: var(--line_regular, #e3e5e7);
        border-radius: 99px;
      }
      #${PANEL_ID} .bili-pp-bar > i {
        display: block;
        width: 0;
        height: 100%;
        background: var(--brand_blue, #00aeec);
        border-radius: inherit;
        transition: width .2s linear;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildPanel() {
    injectStyle();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = '<button class="bili-pp-hide" type="button" title="隐藏进度面板">×</button>' +
      '<div class="bili-pp-title">正在读取选集…</div>' +
      '<div class="bili-pp-line bili-pp-episode"></div>' +
      '<div class="bili-pp-line bili-pp-current"></div>' +
      '<div class="bili-pp-line bili-pp-total"></div>' +
      '<div class="bili-pp-line bili-pp-range"></div>' +
      '<div class="bili-pp-bar"><i></i></div>';

    const restore = document.createElement('button');
    restore.id = RESTORE_ID;
    restore.type = 'button';
    restore.textContent = RESTORE_TEXT;
    restore.title = RESTORE_TEXT;

    panel.querySelector('.bili-pp-hide').addEventListener('click', () => {
      manuallyHidden = true;
      syncVisibility();
    });
    restore.addEventListener('click', () => {
      manuallyHidden = false;
      syncVisibility();
    });

    panelRef = panel;
    restoreRef = restore;
    mountPanel();
    syncVisibility();
    return panel;
  }

  function ensurePanel() {
    if (!panelRef) return buildPanel();
    if (!panelRef.isConnected) mountPanel();
    return panelRef;
  }

  function isWebFullscreen() {
    return !!document.fullscreenElement || !!document.querySelector(
      '.bpx-player-container-web-fullscreen,' +
      '.bpx-player-web-fullscreen,' +
      '.player-mode-web-fullscreen,' +
      '.bilibili-player-video-web-fullscreen,' +
      '[class*="web-fullscreen"],' +
      '[class*="web_fullscreen"]'
    );
  }

  function syncVisibility() {
    const panel = panelRef;
    const restore = restoreRef;
    if (!panel || !restore) return;
    // rcmd-tab 的动态渲染可能清空插入按钮的文字；仅在丢失时恢复，避免观察器循环。
    if (restore.textContent !== RESTORE_TEXT) restore.textContent = RESTORE_TEXT;
    if (!panel.isConnected) {
      panel.style.display = 'none';
      restore.style.display = 'none';
      return;
    }
    const fullscreen = isWebFullscreen();
    // 列表异步加载时先收起，检测到多集后自动展开；手动选择优先。
    const hidden = manuallyHidden ?? (document.querySelectorAll(ITEM_SELECTOR).length <= 1);
    panel.style.display = fullscreen || hidden ? 'none' : 'block';
    restore.style.display = !fullscreen && hidden ? 'block' : 'none';
  }

  function update() {
    const panel = ensurePanel();
    const items = [...document.querySelectorAll(ITEM_SELECTOR)];
    syncVisibility();
    if (!items.length) {
      panel.querySelector('.bili-pp-title').textContent = '未检测到视频选集';
      for (const line of panel.querySelectorAll('.bili-pp-line')) line.textContent = '';
      panel.querySelector('.bili-pp-bar > i').style.width = '0%';
      return;
    }

    const durations = items.map(getItemDuration);
    const knownDurations = durations.filter(Number.isFinite);
    const total = knownDurations.reduce((sum, value) => sum + value, 0);
    const index = Math.min(Math.max(getCurrentIndex(items), 0), items.length - 1);
    const video = document.querySelector('video');
    const listedDuration = durations[index];
    const videoDuration = video && Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : listedDuration;
    const currentTime = video && Number.isFinite(video.currentTime) ? Math.max(video.currentTime, 0) : 0;
    const before = durations.slice(0, index).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    const elapsed = Math.min(before + currentTime, total || before + (videoDuration || 0));
    const percent = total > 0 ? Math.min(100, Math.max(0, elapsed / total * 100)) : 0;
    const titleNode = items[index].querySelector('.title-txt, .title');
    const title = titleNode && titleNode.textContent
      ? titleNode.textContent.trim()
      : `第 ${index + 1} 集`;
    const episodeEnd = before + (Number.isFinite(videoDuration) ? videoDuration : (listedDuration || 0));

    panel.querySelector('.bili-pp-title').textContent = title;
    panel.querySelector('.bili-pp-episode').textContent = `选集：第 ${index + 1} / ${items.length} 集`;
    panel.querySelector('.bili-pp-current').textContent = `本集：${formatDuration(currentTime)} / ${formatDuration(videoDuration)}`;
    panel.querySelector('.bili-pp-total').innerHTML = `列表位置：${formatDuration(elapsed)} / ${formatDuration(total)}（<span class="bili-pp-percent">${percent.toFixed(2)}%</span>）`;
    panel.querySelector('.bili-pp-range').textContent = `本集范围：${formatDuration(before)} — ${formatDuration(episodeEnd)}`;
    panel.querySelector('.bili-pp-bar > i').style.width = `${percent}%`;
  }

  function start() {
    ensurePanel();
    update();

    // 不监听播放过程；一集结束后等待 B 站切换 active 集数，再更新一次。
    document.addEventListener('ended', () => {
      // 自动下一集的 active 类和 URL 更新可能有延迟，分两次轻量刷新。
      window.setTimeout(update, 800);
      window.setTimeout(update, 1800);
    }, true);

    // 手动点击选集后，等待 B 站完成 active 类切换再刷新。
    document.addEventListener('click', (event) => {
      const item = event.target && event.target.closest
        ? event.target.closest('.video-pod__body .video-pod__item')
        : null;
      if (!item) return;
      window.setTimeout(update, 300);
      window.setTimeout(update, 1000);
    }, true);

    document.addEventListener('fullscreenchange', syncVisibility, true);
    document.addEventListener('webkitfullscreenchange', syncVisibility, true);

    // 选集列表是异步加载的，仅在列表 DOM 发生增删时刷新。
    let observedPlaylist = null;
    let observedItemCount = -1;
    let observedPlayer = null;
    const visibilityObserver = new MutationObserver(syncVisibility);
    visibilityObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const watchPlayer = () => {
      const player = document.querySelector('.bpx-player-container, .bilibili-player');
      if (player && player !== observedPlayer) {
        observedPlayer = player;
        visibilityObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
      }
      syncVisibility();
    };
    watchPlayer();

    const playlistObserver = new MutationObserver((records) => {
      if (records.some((record) => {
        const target = record.target && record.target.nodeType === 1
          ? record.target
          : record.target && record.target.parentElement;
        return target && target.closest && target.closest('.video-pod__item');
      })) update();
    });
    const attachPlaylistObserver = (playlist) => {
      playlistObserver.disconnect();
      if (playlist) playlistObserver.observe(playlist, { attributes: true, attributeFilter: ['class'], subtree: true });
    };

    const observer = new MutationObserver((records) => {
      const playlist = document.querySelector('.video-pod__body');
      const itemCount = playlist ? playlist.querySelectorAll('.video-pod__item').length : 0;
      const activeChanged = records.some((record) => {
        const target = record.target && record.target.nodeType === 1
          ? record.target
          : record.target && record.target.parentElement;
        return target && target.closest && target.closest('.video-pod__item');
      });
      if (playlist !== observedPlaylist || itemCount !== observedItemCount || activeChanged) {
        observedPlaylist = playlist;
        observedItemCount = itemCount;
        attachPlaylistObserver(playlist);
        update();
      }
      if (!isMountedAt(getMountPoint())) scheduleMount();
      watchPlayer();
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  if (document.body) start();
  else window.addEventListener('DOMContentLoaded', start, { once: true });
})();
