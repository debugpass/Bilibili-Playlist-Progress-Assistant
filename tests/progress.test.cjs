const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'bilibili-playlist-progress-assistant.js'), 'utf8');
const storageKey = 'bili-playlist-position-refresh-interval';

// Minimal DOM doubles for event handlers, panel text and settings controls.
// Layout and browser rendering are intentionally left to browser verification.
class Element {
  constructor(tag = 'div', attributes = '') {
    this.tagName = tag.toUpperCase();
    this.className = attributes.match(/class="([^"]*)"/)?.[1] || '';
    this.classList = { contains: (name) => this.className.split(' ').includes(name) };
    this.hidden = /\bhidden\b/.test(attributes);
    this.style = {};
    this.listeners = {};
    this.nodes = [];
    this.textContent = '';
    this.isConnected = true;
  }
  set innerHTML(value) {
    this.html = value;
    this.nodes = [...value.matchAll(/<([a-z][\w-]*)([^>]*)>/g)]
      .map((match) => new Element(match[1], match[2]));
  }
  get innerHTML() { return this.html; }
  querySelectorAll(selector) {
    const last = selector.split(' > ').at(-1);
    const descendants = this.nodes.flatMap((node) => [node, ...node.querySelectorAll('*')]);
    if (selector === '*') return descendants;
    return descendants.filter((node) => last.startsWith('.')
      ? node.classList.contains(last.slice(1)) : node.tagName.toLowerCase() === last);
  }
  contains(node) { return node === this || this.nodes.some((child) => child.contains(node)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
  emit(name, details = {}) {
    const event = {
      target: this,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...details
    };
    this.listeners[name]?.(event);
    return event;
  }
  get previousElementSibling() {
    return this.parentElement?.nodes[this.parentElement.nodes.indexOf(this) - 1] || null;
  }
  get nextElementSibling() {
    return this.parentElement?.nodes[this.parentElement.nodes.indexOf(this) + 1] || null;
  }
  get firstElementChild() { return this.nodes[0] || null; }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.nodes;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  appendChild(element) {
    element.remove();
    this.nodes.push(element);
    element.parentElement = this;
  }
  prepend(element) {
    element.remove();
    this.nodes.unshift(element);
    element.parentElement = this;
  }
  insertAdjacentElement(position, element) {
    element.remove();
    const siblings = this.parentElement.nodes;
    siblings.splice(siblings.indexOf(this) + (position === 'afterend' ? 1 : 0), 0, element);
    element.parentElement = this.parentElement;
  }
}

function setup({ saved, storageFails = false, layout, vueMounted = true, readyState = 'complete' } = {}) {
  const elements = [];
  const intervals = new Map();
  const listeners = {};
  const observers = [];
  const timeouts = new Map();
  const container = new Element('div', 'class="right-container-inner scroll-sticky"');
  container.__vue__ = { _isMounted: vueMounted, _isDestroyed: false };
  const tab = new Element('div', 'class="rcmd-tab"');
  const recommendation = new Element('div', 'class="recommend-list-v1"');
  const pod = new Element('div', 'class="video-pod"');
  const header = new Element('div', 'class="sidebar-header"');
  container.appendChild(header);
  container.appendChild(tab);
  if (layout === 'playlist') tab.appendChild(pod);
  tab.appendChild(recommendation);
  const values = new Map(saved === undefined ? [] : [[storageKey, saved]]);
  let nextTimer = 1;
  let video = { currentTime: 12, duration: 60 };
  const items = [false, true].map((active) => {
    const item = new Element();
    item.className = active ? 'active' : '';
    item.querySelector = (selector) => selector === '.duration'
      ? { textContent: '01:00' } : null;
    return item;
  });
  const document = {
    readyState,
    body: {}, head: new Element(), fullscreenElement: null,
    getElementById: () => null,
    createElement(tag) { const element = new Element(tag); elements.push(element); return element; },
    querySelector(selector) {
      if (selector === 'video' || selector === '.bpx-player-container video, .bilibili-player video') return video;
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === '.video-pod__body .video-pod__item') return items;
      if (selector === '.right-container-inner.scroll-sticky') return [container];
      return [];
    },
    addEventListener(name, callback, capture) {
      (listeners[name] ||= []).push({ callback, capture });
    }
  };
  const window = {
    localStorage: {
      getItem(key) { if (storageFails) throw Error('blocked'); return values.get(key) ?? null; },
      setItem(key, value) { if (storageFails) throw Error('blocked'); values.set(key, value); }
    },
    setInterval(callback, delay) { const id = nextTimer++; intervals.set(id, { callback, delay }); return id; },
    clearInterval: (id) => intervals.delete(id),
    setTimeout(callback) { const id = nextTimer++; timeouts.set(id, callback); return id; },
    addEventListener() {}
  };
  vm.runInNewContext(source, {
    document, window, URL, location: { href: 'https://www.bilibili.com/video/test/?p=2' },
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {} disconnect() {}
    }
  });
  const panel = elements.find((element) => element.id === 'bili-playlist-position-panel');
  const select = panel?.querySelector('.bili-pp-interval');
  return {
    get panel() { return elements.find((element) => element.id === 'bili-playlist-position-panel'); },
    restore: elements.find((element) => element.id === 'bili-playlist-position-restore'),
    select, values, intervals, listeners, container, tab, recommendation, pod, header, document,
    pendingTimers: () => timeouts.size,
    runPendingTimers() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    },
    notifyDOMChange(records = [{ target: recommendation, type: 'childList' }]) {
      for (const callback of observers) callback(records);
      this.runPendingTimers();
    },
    change(value) { select.value = String(value); select.emit('change'); },
    tick() { for (const timer of intervals.values()) timer.callback(); },
    setVideo(value) { video = value; },
    emit(name, target = video) { for (const entry of listeners[name] || []) entry.callback({ target }); },
    current: () => panel.querySelector('.bili-pp-current').textContent
  };
}

test('defaults to five seconds and refreshes both current time and list position', () => {
  const app = setup();
  assert.equal(app.select.value, '5000');
  assert.deepEqual([...app.intervals.values()].map((timer) => timer.delay), [5000]);
  assert.equal(app.current(), '本集：00:12 / 01:00');
  app.setVideo({ currentTime: 27, duration: 60 });
  app.tick();
  assert.equal(app.current(), '本集：00:27 / 01:00');
  assert.match(app.panel.querySelector('.bili-pp-total').innerHTML, /01:27 \/ 02:00/);
});

test('changing each interval replaces the timer and survives a fresh script instance', () => {
  const app = setup();
  for (const delay of [10000, 30000, 60000, 0, 5000]) {
    app.change(delay);
    const expected = delay === 0 ? [] : [delay];
    assert.deepEqual([...app.intervals.values()].map((timer) => timer.delay), expected);
    assert.equal(app.values.get(storageKey), String(delay));
    const reloaded = setup({ saved: app.values.get(storageKey) });
    assert.equal(reloaded.select.value, String(delay));
    assert.deepEqual([...reloaded.intervals.values()].map((timer) => timer.delay), expected);
  }
});

test('seek and metadata events refresh even when the periodic timer is off', () => {
  const app = setup({ saved: '0' });
  assert.equal(app.intervals.size, 0);
  for (const name of ['seeked', 'loadedmetadata', 'durationchange', 'pause']) {
    assert.equal(app.listeners[name][0].capture, true);
    app.setVideo({ currentTime: 34, duration: 90 });
    app.emit(name);
    assert.equal(app.current(), '本集：00:34 / 01:30');
    app.setVideo({ currentTime: 12, duration: 60 });
    app.emit(name);
  }
  app.setVideo({ currentTime: 40, duration: 60 });
  app.emit('seeked', { currentTime: 99 });
  assert.equal(app.current(), '本集：00:12 / 01:00', 'ignore unrelated media');
  app.emit('seeked');
  assert.equal(app.current(), '本集：00:40 / 01:00', 'follow replacement video elements');
});

test('settings view remains open across timer refreshes and supports returning to progress', () => {
  const app = setup();
  const button = app.panel.querySelector('.bili-pp-open-settings');
  const settings = app.panel.querySelector('.bili-pp-settings');
  const content = app.panel.querySelector('.bili-pp-content');
  assert.equal(settings.hidden, true);
  button.emit('click');
  assert.equal(settings.hidden, false);
  assert.equal(content.hidden, true);
  assert.equal(button['aria-expanded'], 'true');
  app.change(10000);
  app.tick();
  assert.equal(settings.hidden, false);
  app.panel.querySelector('.bili-pp-back').emit('click');
  assert.equal(settings.hidden, true);
  assert.equal(content.hidden, false);
  assert.equal(button['aria-expanded'], 'false');
});

test('invalid stored values fall back to default; blocked storage does not break settings', () => {
  assert.equal(setup({ saved: 'invalid' }).select.value, '5000');
  assert.equal(setup({ saved: '2000' }).select.value, '5000');
  const app = setup({ storageFails: true });
  app.change(30000);
  assert.equal([...app.intervals.values()][0].delay, 30000);
  assert.match(app.panel.querySelector('.bili-pp-save-status').textContent, /未允许保存/);
  app.setVideo({ currentTime: 30, duration: 60 });
  app.emit('seeked');
  assert.equal(app.current(), '本集：00:30 / 01:00');
});

test('without a playlist, mount before rcmd-tab without changing its children', () => {
  const app = setup({ layout: 'no-playlist' });
  const restore = app.container.nodes[2];
  assert.equal(restore.id, 'bili-playlist-position-restore');
  assert.deepEqual(app.container.nodes, [app.header, app.panel, restore, app.tab]);
  assert.deepEqual(app.tab.nodes, [app.recommendation]);
  // Unrelated page mutations must not repeatedly move the mounted nodes.
  app.tab.insertAdjacentElement = () => assert.fail('unexpected remount');
  app.notifyDOMChange();
  assert.deepEqual(app.tab.nodes, [app.recommendation]);
});

test('with a playlist, keep the panel immediately after the playlist', () => {
  const app = setup({ layout: 'playlist' });
  assert.deepEqual(app.container.nodes, [app.header, app.tab]);
  assert.equal(app.panel.parentElement, app.tab);
  assert.equal(app.panel.previousElementSibling, app.pod);
  assert.equal(app.panel.nextElementSibling.id, 'bili-playlist-position-restore');
  assert.equal(app.panel.nextElementSibling.nextElementSibling, app.recommendation);
});

test('move between mounting locations when a playlist loads or disappears', () => {
  const app = setup({ layout: 'no-playlist' });
  const restore = app.container.nodes[2];
  app.tab.prepend(app.pod);
  app.notifyDOMChange();
  assert.deepEqual(app.container.nodes, [app.header, app.tab]);
  assert.deepEqual(app.tab.nodes, [app.pod, app.panel, restore, app.recommendation]);
  app.pod.remove();
  app.notifyDOMChange();
  assert.deepEqual(app.container.nodes, [app.header, app.panel, restore, app.tab]);
  assert.deepEqual(app.tab.nodes, [app.recommendation]);
});

test('span and div actions support keyboard settings, hide and restore', () => {
  for (const key of ['Enter', ' ']) {
    const app = setup();
    const settings = app.panel.querySelector('.bili-pp-settings');
    const open = app.panel.querySelector('.bili-pp-open-settings');
    const back = app.panel.querySelector('.bili-pp-back');
    const hide = app.panel.querySelector('.bili-pp-hide');
    for (const control of [open, back, hide, app.restore]) {
      assert.equal(control.role, 'button');
      assert.equal(control.tabindex, '0');
    }
    open.emit('keydown', { key: 'ArrowRight' });
    assert.equal(settings.hidden, true);
    const event = open.emit('keydown', { key });
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(settings.hidden, false);
    open.emit('keydown', { key, repeat: true });
    assert.equal(settings.hidden, false, 'holding a key must not repeatedly toggle');
    back.emit('keydown', { key });
    assert.equal(settings.hidden, true);
    hide.emit('keydown', { key });
    assert.equal(app.panel.style.display, 'none');
    assert.equal(app.restore.style.display, 'block');
    app.restore.emit('keydown', { key });
    assert.equal(app.panel.style.display, 'block');
    assert.equal(app.restore.style.display, 'none');
  }
});

test('does not insert any script elements before page load and Vue mounting finish', () => {
  const app = setup({ layout: 'no-playlist', vueMounted: false, readyState: 'interactive' });
  assert.equal(app.panel, undefined);
  assert.deepEqual(app.container.nodes, [app.header, app.tab]);
  app.document.readyState = 'complete';
  app.runPendingTimers();
  assert.equal(app.panel, undefined, 'load alone does not prove hydration is complete');
  app.container.__vue__._isMounted = true;
  app.runPendingTimers();
  assert.equal(app.panel.parentElement, app.container);
  assert.equal(app.pendingTimers(), 0);
  assert.equal(app.intervals.size, 1);
});

test('a missing or destroyed Vue instance cannot authorize mounting', () => {
  const app = setup({ vueMounted: false });
  delete app.container.__vue__;
  app.runPendingTimers();
  assert.equal(app.panel, undefined);
  app.container.__vue__ = { _isMounted: true, _isDestroyed: true };
  app.runPendingTimers();
  assert.equal(app.panel, undefined);
  app.container.__vue__._isDestroyed = false;
  app.runPendingTimers();
  assert.ok(app.panel);
});

test('script elements with page classes do not become mounting anchors or loop', () => {
  const app = setup({ layout: 'no-playlist' });
  app.panel.className = 'rcmd-tab right-container-inner scroll-sticky';
  app.panel.querySelector('.bili-pp-content').className += ' rcmd-tab video-pod';
  const expected = [...app.container.nodes];
  app.tab.insertAdjacentElement = () => assert.fail('stable panel must not be reinserted');
  for (let i = 0; i < 5; i++) {
    app.notifyDOMChange();
    assert.deepEqual(app.container.nodes, expected);
    assert.equal(app.pendingTimers(), 0);
  }
});

test('internal panel updates are ignored, but external panel removal is repaired', () => {
  const app = setup({ layout: 'no-playlist' });
  const restore = app.restore;
  app.panel.remove();
  app.notifyDOMChange([{ target: app.panel.querySelector('.bili-pp-title'), type: 'childList' }]);
  assert.equal(app.panel.parentElement, null, 'internal update must not run mounting checks');
  app.notifyDOMChange([{ target: app.container, type: 'childList', removedNodes: [app.panel] }]);
  assert.deepEqual(app.container.nodes, [app.header, app.panel, restore, app.tab]);
  assert.equal(app.pendingTimers(), 0);
});
