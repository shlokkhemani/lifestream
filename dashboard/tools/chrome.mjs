// @ts-check
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { googleChrome } from '../../testing/files.mts';

/** @typedef {import('node:child_process').ChildProcess} ChildProcess */

const CHROME = googleChrome();
const WAIT_MS = 30_000;
const READ_MS = 5_000;

export const CHROME_ARGS = [
  '--headless=new',
  '--mute-audio',
  '--no-first-run',
  '--disable-features=MacAppCodeSignClone',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-ipc-flooding-protection',
  '--disable-extensions',
  '--disable-component-update',
  '--disable-sync',
  '--metrics-recording-only',
];

export const OPEN_ARGS = [
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
];

const FEED_OPENS = `window.feedOpens = 0;
window.EventSource = class extends window.EventSource {
  constructor(...given) {
    super(...given);
    this.addEventListener('open', () => { window.feedOpens += 1; });
  }
};`;

const CLASSIC = `{
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('::-webkit-scrollbar { width: 15px; height: 15px; background: rgb(128 128 128 / 0.08); }'
    + '::-webkit-scrollbar-thumb { border: 4px solid transparent; border-radius: 8px; background: rgb(128 128 128 / 0.5) padding-box; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}`;

const HIDE_SCROLLBARS = `{
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('::-webkit-scrollbar { display: none; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}`;

const RESOURCES = 'performance.setResourceTimingBufferSize(100000);';

/** @type {Set<() => void>} */
const owed = new Set();
const killOwed = () => { for (const kill of owed) kill(); };
process.on('exit', killOwed);
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.once(signal, () => {
    killOwed();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}

/** @param {string} expression */
export function conjuncts(expression) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let at = 0; at < expression.length; at += 1) {
    const char = expression[at];
    if (quote) {
      if (char === '\\') at += 1;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === '&' && expression[at + 1] === '&' && depth === 0) {
      parts.push(expression.slice(start, at).trim());
      start = at + 2;
      at += 1;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts;
}

/** @param {ChildProcess} child */
export const running = child => child.exitCode === null && child.signalCode === null;

/** @param {() => void} act */
export function atExit(act) {
  owed.add(act);
  return () => {
    owed.delete(act);
  };
}

/** @param {ChildProcess} child */
export function killedAtExit(child) {
  child.once('exit', atExit(() => {
    if (running(child)) child.kill('SIGKILL');
  }));
}

/** @param {{ profile: string, args?: string[], scrollbars?: boolean }} options */
export async function launchChrome({ profile, args = [], scrollbars = false }) {
  const onNewDocument = scrollbars ? `${RESOURCES}\n${CLASSIC}` : RESOURCES;
  await mkdir(profile, { recursive: true });
  const log = join(profile, 'chrome.log');
  const stderr = openSync(log, 'w');
  const browser = spawn(CHROME, [...CHROME_ARGS, ...scrollbars ? [] : ['--hide-scrollbars'],
    '--remote-debugging-pipe', ...args, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', stderr, 'pipe', 'pipe'],
    detached: true });
  closeSync(stderr);
  const [, , , toChrome, fromChrome] = /** @type {[null, null, null, import('node:stream').Writable, import('node:stream').Readable]} */
    (/** @type {unknown} */ (browser.stdio));
  toChrome.on('error', () => undefined);
  fromChrome.on('error', () => undefined);
  const kill = () => {
    try {
      if (running(browser) && browser.pid) process.kill(-browser.pid, 'SIGKILL');
    } catch {
    }
    let holders = '';
    try {
      holders = execFileSync('lsof', ['-t', log], { encoding: 'utf8' });
    } catch {
    }
    for (const pid of holders.split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
      }
    }
  };
  owed.add(kill);
  const stop = async () => {
    const exited = running(browser) ? once(browser, 'exit') : null;
    kill();
    await exited;
    toChrome.destroy();
    fromChrome.destroy();
    owed.delete(kill);
  };
  let id = 0;
  let session = '';
  /** @type {Error | null} */
  let ended = null;
  /** @type {Map<number, { method: string, done: (message: any) => void, fail: (error: Error) => void }>} */
  const asked = new Map();
  /** @type {Map<string, Set<(params: any) => void>>} */
  const heard = new Map();
  /** @param {Error} error */
  const failAll = error => {
    for (const each of asked.values()) each.fail(error);
    asked.clear();
  };
  /** @param {any} message */
  const hear = message => {
    if (message.method && message.sessionId === session) {
      for (const listener of heard.get(message.method) ?? []) listener(message.params);
      if (message.method === 'Inspector.targetCrashed') failAll(new Error('the page crashed'));
    }
    const question = asked.get(message.id);
    if (!question) return;
    asked.delete(message.id);
    if (message.error) question.fail(new Error(`${question.method}: ${message.error.message}`));
    else question.done(message.result ?? {});
  };
  let partial = '';
  fromChrome.setEncoding('utf8');
  fromChrome.on('data', chunk => {
    const messages = `${partial}${chunk}`.split('\0');
    partial = messages.pop() ?? '';
    for (const message of messages) hear(JSON.parse(message));
  });
  /** @type {Promise<void>} */
  const closed = new Promise(done => fromChrome.once('close', () => {
    ended = new Error(running(browser) ? 'Chrome closed' : `Chrome exited (${browser.exitCode ?? browser.signalCode})`);
    failAll(ended);
    done();
  }));
  /**
   * @param {string} sessionId
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const call = (sessionId, method, params = {}) => new Promise((done, fail) => {
    if (ended) return fail(ended);
    id += 1;
    asked.set(id, { method, done, fail });
    toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) => call(session, method, params);
  let target = '';
  let context = '';
  const fresh = async () => {
    const [before, beforeContext] = [target, context];
    context = (await call('', 'Target.createBrowserContext')).browserContextId;
    target = (await call('', 'Target.createTarget', { url: 'about:blank', browserContextId: context })).targetId;
    session = (await call('', 'Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
    await Promise.all([
      send('Page.addScriptToEvaluateOnNewDocument', { source: onNewDocument }),
      ...(beforeContext
        ? [call('', 'Target.disposeBrowserContext', { browserContextId: beforeContext })]
        : before ? [call('', 'Target.closeTarget', { targetId: before })] : []),
    ]);
  };
  try {
    target = (await call('', 'Target.createTarget', { url: 'about:blank' })).targetId;
    session = (await call('', 'Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: onNewDocument });
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    /**
     * @param {string} method
     * @param {object} [params]
     * @returns {Promise<any>}
     */
    send,
    fresh,
    /**
     * @param {string} method
     * @param {(params: any) => void} listener
     */
    on(method, listener) {
      heard.set(method, (heard.get(method) ?? new Set()).add(listener));
    },
    closed,
    close: stop,
  };
}

/** @param {{ poolUrl: string, scrollbars: boolean }} options */
async function connectPooledChrome({ poolUrl, scrollbars }) {
  const onNewDocument = scrollbars ? `${RESOURCES}\n${CLASSIC}` : `${RESOURCES}\n${HIDE_SCROLLBARS}`;
  const response = await fetch(`${poolUrl}/chrome/acquire?pid=${process.pid}`, { method: 'POST' });
  if (!response.ok) throw new Error(`pooled Chrome acquire refused: ${response.status}`);
  const leased = /** @type {{ id: number, wsUrl: string }} */ (await response.json());
  const ws = new WebSocket(leased.wsUrl);
  let id = 0;
  let session = '';
  let target = '';
  let context = '';
  let broken = false;
  let closing = false;
  /** @type {Error | null} */
  let ended = null;
  /** @type {Map<number, { method: string, done: (message: any) => void, fail: (error: Error) => void }>} */
  const asked = new Map();
  /** @type {Map<string, Set<(params: any) => void>>} */
  const heard = new Map();
  /** @param {Error} error */
  const failAll = error => {
    for (const each of asked.values()) each.fail(error);
    asked.clear();
  };
  /** @param {any} message */
  const hear = message => {
    if (message.method && message.sessionId === session) {
      for (const listener of heard.get(message.method) ?? []) listener(message.params);
      if (message.method === 'Inspector.targetCrashed') {
        broken = true;
        failAll(new Error('the page crashed'));
      }
    }
    const question = asked.get(message.id);
    if (!question) return;
    asked.delete(message.id);
    if (message.error) question.fail(new Error(`${question.method}: ${message.error.message}`));
    else question.done(message.result ?? {});
  };
  ws.addEventListener('message', event => {
    hear(JSON.parse(String(event.data)));
  });
  /** @type {Promise<void>} */
  const closed = new Promise(done => {
    ws.addEventListener('close', () => {
      if (!closing) broken = true;
      ended = new Error('Chrome closed');
      failAll(ended);
      done();
    });
  });
  const unowed = atExit(() => {
    closing = true;
    try {
      ws.close();
    } catch {
    }
  });
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    closing = true;
    unowed();
    if (context && !ended) {
      await call('', 'Target.disposeBrowserContext', { browserContextId: context }).catch(() => { broken = true; });
      context = '';
      target = '';
      session = '';
    }
    try {
      ws.close();
    } catch {
    }
    await fetch(`${poolUrl}/chrome/release?id=${leased.id}&broken=${broken ? '1' : '0'}`, { method: 'POST' }).catch(() => undefined);
  };
  /**
   * @param {string} sessionId
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const call = (sessionId, method, params = {}) => new Promise((done, fail) => {
    if (ended) return fail(ended);
    id += 1;
    asked.set(id, { method, done, fail });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) => call(session, method, params);
  const fresh = async () => {
    const beforeContext = context;
    context = (await call('', 'Target.createBrowserContext')).browserContextId;
    target = (await call('', 'Target.createTarget', { url: 'about:blank', browserContextId: context })).targetId;
    session = (await call('', 'Target.attachToTarget', { targetId: target, flatten: true })).sessionId;
    await Promise.all([
      send('Page.addScriptToEvaluateOnNewDocument', { source: onNewDocument }),
      ...(beforeContext ? [call('', 'Target.disposeBrowserContext', { browserContextId: beforeContext })] : []),
    ]);
  };
  try {
    await new Promise((done, fail) => {
      if (ws.readyState === WebSocket.OPEN) return done(undefined);
      ws.addEventListener('open', () => done(undefined), { once: true });
      ws.addEventListener('error', () => fail(new Error('pooled Chrome socket failed')), { once: true });
      ws.addEventListener('close', () => fail(new Error('pooled Chrome socket closed before open')), { once: true });
    });
    await fresh();
  } catch (error) {
    broken = true;
    await release();
    throw error;
  }
  return {
    send,
    fresh,
    /**
     * @param {string} method
     * @param {(params: any) => void} listener
     */
    on(method, listener) {
      heard.set(method, (heard.get(method) ?? new Set()).add(listener));
    },
    closed,
    close: release,
  };
}

/** @param {{ profile: string, origin: string | (() => string), scrollbars?: boolean }} options */
export async function openChrome({ profile, origin, scrollbars = false }) {
  const resolveOrigin = typeof origin === 'function' ? origin : () => origin;
  const poolUrl = process.env.LIFESTREAM_DASHBOARD_POOL;
  const chrome = poolUrl
    ? await connectPooledChrome({ poolUrl, scrollbars })
    : await launchChrome({ profile, args: OPEN_ARGS, scrollbars });
  /** @type {'dark' | 'light' | ''} */
  let currentTheme = '';
  let atBlank = true;
  /** @type {{ width: number, height: number, scale: number } | null} */
  let metrics = null;
  /** @type {Set<Promise<void>>} */
  const writes = new Set();
  const flushWrites = async () => {
    await Promise.all([...writes]);
  };
  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) => {
    if (method === 'Emulation.setEmulatedMedia') currentTheme = '';
    else if (method === 'Emulation.setDeviceMetricsOverride') metrics = null;
    else if (method === 'Page.navigate') atBlank = /** @type {{ url?: string }} */ (params).url === 'about:blank';
    return chrome.send(method, params);
  };
  /** @type {string[]} */
  const thrown = [];
  chrome.on('Runtime.exceptionThrown', ({ exceptionDetails: details }) => {
    thrown.push(`${details?.exception?.description ?? details?.text ?? ''} (${details?.url ?? ''}:${details?.lineNumber ?? ''})`);
  });
  let contexts = 0;
  /** @type {{ wake: () => void, fail: (error: Error) => void }[]} */
  const nextContext = [];
  chrome.on('Runtime.executionContextCreated', () => {
    contexts += 1;
    for (const { wake } of nextContext.splice(0)) wake();
  });
  void chrome.closed.then(() => {
    for (const { fail } of nextContext.splice(0)) fail(new Error('Chrome closed'));
  });
  /** @param {any} result @param {string} expression */
  const thrownBy = (result, expression) => new Error(`${expression}: ${result.exceptionDetails.exception?.description
    ?? result.exceptionDetails.text}`);
  /** @param {string} expression */
  const evaluate = async expression => {
    const result = await chrome.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw thrownBy(result, expression);
    return result.result?.value;
  };
  /** @param {string} expression */
  const reading = async expression => {
    const parts = conjuncts(expression);
    const values = await evaluate(`[${parts.map(part => `(() => { try { const value = (${part});
      return value === null || typeof value !== 'object' ? String(value).slice(0, 80)
        : value instanceof Element ? '<' + value.tagName.toLowerCase() + '>' : typeof value; }
      catch (error) { return 'threw ' + error.message; } })()`).join(',')}]`).catch(() => null);
    return values ? parts.map((part, at) => `\n  [${values[at]}] ${part.replace(/\s+/gu, ' ')}`).join('') : '';
  };
  /**
   * @param {string} selector
   * @returns {Promise<[number, number]>}
   */
  const centre = selector => evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)})
    .getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()`);
  /**
   * @param {string} expression
   * @param {boolean} [settle]
   */
  const holds = async (expression, settle = false) => {
    const finish = settle
      ? `document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 10000; });
        requestAnimationFrame(() => done(true));`
      : 'done(true);';
    const asked = `new Promise(done => {
      const check = () => {
        let held = false;
        try { held = Boolean(${expression}); } catch {}
        if (held) { ${finish} }
        else requestAnimationFrame(check);
      };
      check();
    })`;
    for (;;) {
      const before = contexts;
      try {
        const result = await chrome.send('Runtime.evaluate', { expression: asked, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw thrownBy(result, expression);
        if (result.result?.value === true) return;
      } catch (error) {
        if (!(error instanceof Error) || !/destroyed|navigated|context/iu.test(error.message)) throw error;
      }
      if (contexts === before) await new Promise((wake, fail) => nextContext.push({ wake: () => wake(undefined), fail }));
    }
  };
  /** @param {string} path */
  const capture = async path => {
    const shot = await chrome.send('Page.captureScreenshot', {
      format: 'png',
      optimizeForSpeed: true,
      ...(metrics && metrics.scale === 1 ? { clip: { x: 0, y: 0, width: metrics.width, height: metrics.height, scale: 1 } } : {}),
    });
    const pending = writeFile(path, Buffer.from(shot.data, 'base64')).finally(() => {
      writes.delete(pending);
    });
    writes.add(pending);
  };
  await Promise.all([chrome.send('Runtime.enable'), chrome.send('Page.enable')]);
  let script = '';
  let waiting = '';
  return {
    send,
    on: chrome.on,
    async fresh() {
      await flushWrites();
      await chrome.fresh();
      script = '';
      currentTheme = '';
      atBlank = true;
      metrics = null;
      thrown.length = 0;
      await Promise.all([chrome.send('Runtime.enable'), chrome.send('Page.enable')]);
    },
    evaluate,
    thrown,
    get waiting() {
      return waiting;
    },
    /** @param {number} width @param {number} height @param {number} [scale] */
    async size(width, height, scale = 1) {
      if (metrics && metrics.width === width && metrics.height === height && metrics.scale === scale) return;
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
      metrics = { width, height, scale };
    },
    /**
     * @param {string} expression
     * @param {string} [what]
     * @param {boolean} [settle]
     */
    async until(expression, what = '', settle = false) {
      waiting = what ? `${what}: ${expression}` : expression;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const gaveUp = new Promise((_, fail) => {
        timer = setTimeout(() => void Promise.race([reading(expression),
          new Promise(done => setTimeout(() => done('\n  (the page did not say what its parts read)'), READ_MS))])
          .then(read => fail(new Error(`never came in ${WAIT_MS / 1000} s: ${waiting}${read}`))), WAIT_MS);
      });
      try {
        await Promise.race([holds(expression, settle), gaveUp]);
      } finally {
        clearTimeout(timer);
      }
      waiting = '';
    },
    /**
     * @param {string} hash
     * @param {string} before
     */
    async load(hash, before) {
      const [added] = await Promise.all([
        chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: `${FEED_OPENS}\n${before ?? ''}` }),
        ...(script ? [chrome.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script })] : []),
      ]);
      script = added.identifier;
      if (!atBlank) await chrome.send('Page.navigate', { url: 'about:blank' });
      atBlank = false;
      await chrome.send('Page.navigate', { url: `${resolveOrigin()}/${hash}` });
    },
    async following() {
      await this.until('window.feedOpens > 0', 'the page\u2019s feed open at the dashboard');
    },
    /** @param {string} selector */
    async hover(selector) {
      const [x, y] = selector ? await centre(selector) : [0, 0];
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },
    /**
     * @param {string} selector
     * @param {number} by
     * @param {() => Promise<void>} [held]
     */
    async drag(selector, by, held) {
      const [x, y] = await centre(selector);
      await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + by, y, button: 'left', buttons: 1 });
      await held?.();
      await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + by, y, button: 'left', buttons: 0, clickCount: 1 });
    },
    /** @param {string} key */
    async key(key) {
      const code = { Tab: 9, Shift: 16 }[key] ?? 0;
      for (const type of ['rawKeyDown', 'keyUp']) {
        await chrome.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
      }
    },
    /** @param {string} key */
    async press(key) {
      await evaluate('document.activeElement instanceof HTMLElement && document.activeElement.blur()');
      const codes = /** @type {Record<string, [string, number, string]>} */ ({ Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27, ''] });
      const [code, virtual, text] = codes[key] ?? [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key];
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: /^\d$/u.test(key) ? `Digit${key}` : code,
        windowsVirtualKeyCode: virtual, text, unmodifiedText: text });
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual });
    },
    /**
     * @param {string} selector
     * @param {string} words
     */
    async type(selector, words) {
      await evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.select(); })()`);
      await chrome.send('Input.insertText', { text: words });
    },
    /** @param {'dark' | 'light'} theme */
    async theme(theme) {
      if (currentTheme === theme) return;
      await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' }] });
      currentTheme = theme;
    },
    capture,
    /** @param {string} path */
    async shoot(path) {
      await evaluate(`document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 10000; });
        new Promise(done => requestAnimationFrame(() => done()))`);
      await capture(path);
      await evaluate(`document.getAnimations().forEach(animation => {
        if (animation.effect.getComputedTiming().endTime === Infinity) animation.play(); else animation.finish(); })`);
    },
    async close() {
      await flushWrites();
      await chrome.close();
    },
  };
}
