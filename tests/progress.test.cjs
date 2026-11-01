const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'bili-part-process-tampermonkey.js'), 'utf8');
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
    return this.nodes.filter((node) => last.startsWith('.')
      ? node.classList.contains(last.slice(1)) : node.tagName.toLowerCase() === last);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
  emit(name) { this.listeners[name]?.({ target: this }); }
  appendChild() {}
}

function setup({ saved, storageFails = false } = {}) {
  const elements = [];
  const intervals = new Map();
  const listeners = {};
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
    body: {}, head: new Element(), fullscreenElement: null,
    getElementById: () => null,
    createElement(tag) { const element = new Element(tag); elements.push(element); return element; },
    querySelector(selector) {
      if (selector === 'video' || selector === '.bpx-player-container video, .bilibili-player video') return video;
      return null;
    },
    querySelectorAll: (selector) => selector === '.video-pod__body .video-pod__item' ? items : [],
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
    setTimeout: () => nextTimer++,
    addEventListener() {}
  };
  vm.runInNewContext(source, {
    document, window, URL, location: { href: 'https://www.bilibili.com/video/test/?p=2' },
    MutationObserver: class { observe() {} disconnect() {} }
  });
  const panel = elements.find((element) => element.id === 'bili-playlist-position-panel');
  const select = panel.querySelector('.bili-pp-interval');
  return {
    panel, select, values, intervals, listeners,
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
