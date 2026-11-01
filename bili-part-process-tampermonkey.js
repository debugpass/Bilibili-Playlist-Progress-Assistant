// ==UserScript==
// @name         Bilibili 播放列表总时长定位
// @namespace    local.bilibili.playlist-position
// @version      1.2.0
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
  const INTERVAL_KEY = 'bili-playlist-position-refresh-interval';
  const INTERVAL_OPTIONS = [0, 5000, 10000, 30000, 60000];
  const DEFAULT_INTERVAL = 5000;
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
  let refreshTimer = 0;
  let refreshInterval = loadRefreshInterval();

  function loadRefreshInterval() {
    try {
      const saved = window.localStorage.getItem(INTERVAL_KEY);
      const value = saved === null ? DEFAULT_INTERVAL : Number(saved);
      return INTERVAL_OPTIONS.includes(value) ? value : DEFAULT_INTERVAL;
    } catch {
      return DEFAULT_INTERVAL;
    }
  }

  function restartRefreshTimer() {
    if (refreshTimer) window.clearInterval(refreshTimer);
    refreshTimer = refreshInterval > 0 ? window.setInterval(update, refreshInterval) : 0;
  }

  function getPlaybackVideo() {
    return document.querySelector('.bpx-player-container video, .bilibili-player video') ||
      document.querySelector('video');
  }

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
      #${PANEL_ID} [hidden] { display: none !important; }
      #${PANEL_ID} .bili-pp-actions {
        position: absolute;
        top: 6px;
        right: 8px;
        display: flex;
        align-items: flex-start;
        gap: 2px;
      }
      #${PANEL_ID} .bili-pp-action {
        padding: 0 4px;
        color: var(--text3, #9499a0);
        background: transparent;
        border: 0;
        cursor: pointer;
        font: 13px/24px ${FONT_FAMILY};
      }
      #${PANEL_ID} .bili-pp-hide { font-size: 18px; }
      #${PANEL_ID} .bili-pp-action:hover { color: var(--text1, #18191c); }
      #${PANEL_ID} .bili-pp-settings label { display: block; margin: 10px 0 6px; }
      #${PANEL_ID} .bili-pp-interval {
        width: 100%;
        padding: 6px 8px;
        box-sizing: border-box;
        color: var(--text1, #18191c);
        background: var(--bg1, #fff);
        border: 1px solid var(--line_regular, #e3e5e7);
        border-radius: 4px;
        font: 14px/1.4 ${FONT_FAMILY};
      }
      #${PANEL_ID} .bili-pp-settings-note {
        margin: 8px 0;
        color: var(--text2, #61666d);
        font: 12px/1.5 ${FONT_FAMILY};
      }
      #${PANEL_ID} .bili-pp-back {
        padding: 5px 10px;
        border: 1px solid var(--line_regular, #e3e5e7);
        border-radius: 4px;
        background: var(--bg1, #fff);
        color: var(--brand_blue, #00aeec);
        cursor: pointer;
        font: 13px/1.4 ${FONT_FAMILY};
      }
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
        padding-right: 85px;
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
    panel.innerHTML = '<div class="bili-pp-actions">' +
      '<button class="bili-pp-action bili-pp-open-settings" type="button" title="设置刷新间隔" aria-expanded="false" aria-controls="bili-pp-settings-view"><svg t="1793528976479" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="9654" width="20" height="20"><path d="M509.387755 666.122449c-83.591837 0-151.510204-67.918367-151.510204-151.510204s67.918367-151.510204 151.510204-151.510204 151.510204 67.918367 151.510204 151.510204-67.918367 151.510204-151.510204 151.510204z m0-261.22449c-60.604082 0-109.714286 49.110204-109.714286 109.714286s49.110204 109.714286 109.714286 109.714286 109.714286-49.110204 109.714286-109.714286-49.110204-109.714286-109.714286-109.714286z" fill="#707070" p-id="9655"></path><path d="M556.408163 929.959184h-83.591836c-47.542857 0-86.204082-38.661224-86.204082-86.204082v-22.987755c0-1.044898-0.522449-2.089796-1.567347-2.612245h-0.522449c-1.044898-0.522449-2.089796 0-3.134694 0.522449l-14.628571 15.15102c-16.195918 16.195918-37.093878 25.077551-59.559184 25.077551-22.465306 0-43.363265-8.881633-59.036735-24.555102l-59.036734-59.036734c-32.391837-32.391837-32.391837-85.159184 0-118.07347l15.673469-15.15102c1.044898-1.044898 1.044898-2.089796 0.522449-3.134694v-0.522449c-0.522449-1.044898-1.567347-1.567347-2.612245-1.567347h-22.987755c-47.542857 0-86.204082-38.661224-86.204082-86.204082v-78.367346c0.522449-47.020408 39.183673-85.681633 86.726531-85.681633h21.420408c1.044898 0 2.089796-0.522449 2.612245-2.089796 0.522449-1.044898 1.044898-2.612245 1.567347-3.657143 0.522449-1.044898 0-2.089796-0.522449-3.134694l-16.195918-16.718367C156.734694 329.142857 156.734694 275.853061 189.126531 243.461224l59.036734-59.036734c15.673469-15.673469 36.571429-24.555102 59.036735-24.555102 22.465306 0 43.363265 8.881633 59.036735 24.555102l15.15102 15.673469c0.522449 1.044898 2.089796 1.044898 3.134694 0.522449h0.522449c1.044898-0.522449 1.567347-1.567347 1.567347-2.612245v-17.763265C386.612245 132.702041 425.273469 94.040816 472.816327 94.040816h83.591836c44.408163 0 80.979592 36.571429 80.979592 80.979592v21.420408c0 1.044898 0.522449 2.089796 2.089796 2.612245 1.567347 0.522449 2.612245 1.044898 3.657143 1.567347 1.044898 0.522449 2.089796 0 3.134694-0.522449l16.718367-16.195918c32.391837-32.391837 85.159184-32.391837 118.073469 0.522449l59.036735 59.036734c15.673469 15.673469 24.555102 36.571429 24.555102 59.036735 0 22.465306-8.881633 43.363265-24.555102 59.036735l-15.673469 16.195918c-0.522449 0.522449-1.044898 2.089796-0.522449 2.612245 0.522449 1.044898 1.044898 2.612245 1.567347 3.657143 0.522449 1.044898 1.567347 2.089796 2.612245 2.089796h21.420408c44.408163 0 80.979592 36.571429 80.979592 80.979592v88.816326c0 44.408163-36.571429 80.979592-80.979592 80.979592h-22.987755c-1.044898 0-2.089796 0.522449-2.612245 1.567347-0.522449 1.567347-0.522449 2.612245 0.522449 3.657143l15.15102 14.628571c16.195918 16.195918 25.077551 37.093878 24.555102 59.559184 0 22.465306-8.881633 43.363265-24.555102 59.036735l-59.036734 59.036734c-15.673469 15.673469-36.571429 24.555102-59.036735 24.555102s-43.363265-8.881633-59.036735-24.555102l-16.195918-15.673469c-0.522449-0.522449-2.089796-1.044898-2.612245-0.522449-1.044898 0.522449-2.612245 1.044898-3.657143 1.567347-1.044898 0.522449-2.089796 1.567347-2.089796 2.612245v26.644898C637.387755 893.387755 600.816327 929.959184 556.408163 929.959184zM402.285714 780.538776c16.195918 7.314286 26.122449 22.987755 26.122449 40.75102v22.987755c0 24.555102 19.853061 44.408163 44.408164 44.408163h83.591836c21.420408 0 39.183673-17.763265 39.183674-39.183673v-26.644898c0-18.285714 10.971429-34.481633 28.212245-41.27347 1.044898-0.522449 1.567347-0.522449 2.612245-1.044897 16.718367-7.314286 35.526531-3.657143 48.587755 8.881632l16.195918 15.67347c16.718367 16.718367 43.363265 16.718367 59.559184 0l59.036734-59.036735c7.836735-7.836735 12.016327-18.285714 12.016327-29.779592 0-10.971429-4.179592-21.420408-12.016327-29.779592l-14.628571-14.106122c-13.583673-13.061224-17.763265-32.914286-9.926531-50.155102v-0.522449c6.791837-15.673469 22.987755-26.122449 40.751021-26.122449h22.987755c21.420408 0 39.183673-17.763265 39.183673-39.183674v-88.816326c0-21.420408-17.763265-39.183673-39.183673-39.183674h-21.420408c-18.285714 0-34.481633-10.971429-41.27347-28.212245-0.522449-1.044898-0.522449-1.567347-1.044898-2.612245-7.314286-16.718367-3.657143-35.526531 8.881633-48.587755l15.673469-16.195918c7.836735-7.836735 12.538776-18.808163 12.538776-29.779592 0-11.493878-4.179592-21.942857-12.016327-29.779592L751.281633 214.204082c-16.195918-16.195918-42.840816-16.195918-59.036735 0l-17.240816 16.195918c-13.061224 12.538776-32.391837 15.673469-48.587755 8.881633-0.522449-0.522449-1.567347-0.522449-2.612245-1.044898-17.240816-6.791837-28.212245-22.987755-28.212245-41.27347v-21.420408c0-21.420408-17.763265-39.183673-39.183674-39.183673h-83.591836c-24.555102 0-44.408163 19.853061-44.408164 44.408163V198.530612c0 17.763265-10.44898 33.436735-26.644898 40.751021-17.240816 7.836735-37.093878 3.657143-50.155102-9.404082l-15.15102-15.673469c-7.836735-7.836735-18.285714-12.016327-29.257143-12.016327-10.971429 0-21.420408 4.179592-29.257143 12.016327L218.906122 272.718367c-16.195918 16.195918-16.195918 42.840816 0 59.036735l16.195919 17.240816c12.538776 13.061224 16.195918 32.391837 8.881632 48.587755-0.522449 0.522449-0.522449 1.567347-1.044897 2.612245-6.791837 17.240816-22.987755 28.212245-41.27347 28.212245h-21.420408c-24.555102 0-44.408163 19.853061-44.408163 44.408164v78.367346c0 24.555102 19.853061 44.408163 44.408163 44.408164h22.987755c17.763265 0 33.436735 10.44898 40.75102 26.644898v0.522449c7.314286 16.718367 3.657143 37.093878-9.404081 49.632653l-15.67347 15.15102c-16.195918 16.195918-16.195918 42.318367 0 58.514286l59.036735 59.036735c7.836735 7.836735 18.285714 12.016327 29.257143 12.016326 10.971429 0 21.420408-4.179592 29.779592-12.538775l14.106122-14.628572c13.061224-13.583673 32.914286-17.763265 50.155102-9.92653l1.044898 0.522449z" fill="#707070" p-id="9656"></path></svg></button>' +
      '<button class="bili-pp-action bili-pp-hide" type="button" title="隐藏进度面板"><svg t="1793528955214" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="8599" width="16" height="16"><path d="M915.846465 923.410101c-20.169697 20.169697-52.880808 20.169697-73.179798 0L93.026263 173.769697c-20.169697-20.169697-20.169697-52.880808 0-73.179798 20.169697-20.169697 53.010101-20.169697 73.179798 0l749.640404 749.640404c20.169697 20.169697 20.169697 53.010101 0 73.179798z" p-id="8600" fill="#707070"></path><path d="M93.026263 923.410101c-20.169697-20.169697-20.169697-52.880808 0-73.179798L842.666667 100.589899c20.169697-20.169697 52.880808-20.169697 73.179798 0 20.169697 20.169697 20.169697 52.880808 0 73.179798L166.206061 923.410101c-20.169697 20.169697-53.010101 20.169697-73.179798 0z" p-id="8601" fill="#707070"></path></svg></button></div>' +
      '<div class="bili-pp-content"><div class="bili-pp-title">正在读取选集…</div>' +
      '<div class="bili-pp-line bili-pp-episode"></div>' +
      '<div class="bili-pp-line bili-pp-current"></div>' +
      '<div class="bili-pp-line bili-pp-total"></div>' +
      '<div class="bili-pp-line bili-pp-range"></div>' +
      '<div class="bili-pp-bar"><i></i></div></div>' +
      '<div class="bili-pp-settings" id="bili-pp-settings-view" hidden>' +
      '<div class="bili-pp-title">进度设置</div>' +
      '<label for="bili-pp-refresh-interval">自动刷新间隔</label>' +
      '<select class="bili-pp-interval" id="bili-pp-refresh-interval">' +
      '<option value="0">关闭</option><option value="5000">5 秒</option>' +
      '<option value="10000">10 秒</option><option value="30000">30 秒</option>' +
      '<option value="60000">1 分钟</option></select>' +
      '<p class="bili-pp-settings-note">修改后立即生效并自动记忆。关闭仅停止定时刷新，拖动进度条后仍会更新。</p>' +
      '<p class="bili-pp-settings-note bili-pp-save-status" role="status"></p>' +
      '<button class="bili-pp-back" type="button">返回进度</button></div>';

    const settingsButton = panel.querySelector('.bili-pp-open-settings');
    const settingsView = panel.querySelector('.bili-pp-settings');
    const contentView = panel.querySelector('.bili-pp-content');
    const intervalSelect = panel.querySelector('.bili-pp-interval');
    const showSettings = (visible) => {
      settingsView.hidden = !visible;
      contentView.hidden = visible;
      settingsButton.setAttribute('aria-expanded', String(visible));
      if (visible) intervalSelect.focus();
      else settingsButton.focus();
    };
    settingsButton.addEventListener('click', () => showSettings(settingsView.hidden));
    panel.querySelector('.bili-pp-back').addEventListener('click', () => {
      showSettings(false);
      update();
    });
    intervalSelect.value = String(refreshInterval);
    intervalSelect.addEventListener('change', () => {
      const value = Number(intervalSelect.value);
      if (!INTERVAL_OPTIONS.includes(value)) return;
      refreshInterval = value;
      restartRefreshTimer();
      const status = panel.querySelector('.bili-pp-save-status');
      try {
        window.localStorage.setItem(INTERVAL_KEY, String(value));
        status.textContent = '已保存';
      } catch {
        status.textContent = '当前页面已生效，但浏览器未允许保存设置。';
      }
      update();
    });

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
      update();
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
    const video = getPlaybackVideo();
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
    restartRefreshTimer();

    // 使用捕获监听，兼容不冒泡的媒体事件及切集时替换 video 元素。
    // seeked 在进度拖动完成或历史位置恢复后刷新，独立于定时刷新开关。
    for (const eventName of ['seeked', 'loadedmetadata', 'durationchange', 'pause']) {
      document.addEventListener(eventName, (event) => {
        if (event.target === getPlaybackVideo()) update();
      }, true);
    }

    // 一集结束后等待 B 站切换 active 集数，再更新一次。
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
