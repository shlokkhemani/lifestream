import assert from 'node:assert/strict';
import { createServer, request as ask } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHATGPT_SIGNED_IN, hostScript, onboardingHome, SENSES } from './onboarding-home.mjs';
import { state } from './onboarding-page.mjs';
import { pageHarness } from './page-harness.mjs';
import { QUESTION, SEE, WORDS } from '../../public/ui/tour.js';
import { askReady, askSignedOut } from './ask-ready.mjs';
import { SPOTS, spotRow } from './places-home.mjs';

export const WINDOW = { width: 1440, height: 900 };

const GUIDES = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'homelink', 'Tests', 'Fixtures', 'pages',
  'agentGuides.mac.json'), 'utf8');
export const BESIDE = 1800;

export { QUESTION, SEE, WORDS } from '../../public/ui/tour.js';
export const CHAT = '1790000000000-abc123';
const OLD_CHAT = '1780000000000-def456';
/** @typedef {'ask' | 'answer' | 'more' | 'devices' | 'agents' | 'people'} StepId */
/** @type {[StepId, string][]} */
export const MAC_WALK = [['ask', 'ask'], ['answer', 'ask'], ['more', 'connectors'], ['devices', 'connectors'], ['agents', 'agents'],
  ['people', 'people']];
/** @type {[StepId, string][]} */
export const NO_AI_WALK = MAC_WALK.filter(([id]) => id !== 'answer');
/** @type {[StepId, string][]} */
export const BROWSER_WALK = MAC_WALK.filter(([id]) => id !== 'agents');

const MODEL = { id: 'synthetic-model', name: 'Synthetic Model', thinking: ['low', 'high'], default: 'low', group: 'ChatGPT' };
const READY = askReady([MODEL]);
const SIGNED_OUT = askSignedOut([MODEL], 'Chat needs your ChatGPT sign-in on your Mac.');

/** @param {{ url: string, tokens: Record<string, string>, day: string }} home */
async function tourHome(home) {
  const inner = await onboardingHome({ door: { url: home.url, token: home.tokens.reader }, day: home.day });
  const behind = new URL(inner.url);
  let signedIn = true;
  let tidy = false;
  let stall = false;
  let bare = false;
  /** @type {Set<import('node:http').ServerResponse>} */
  const stalled = new Set();
  /** @type {string[]} */
  const asked = [];
  /** @type {{ question: string, chat?: string }[]} */
  const questions = [];
  /** @type {string[]} */
  const posted = [];
  let chatted = false;
  /** @type {Set<() => void>} */
  const reads = new Set();
  let heldReads = false;
  let refusing = /** @type {'' | 'down' | 'login'} */ ('');
  /** @type {(() => void) | null} */
  let refusal = null;
  let holdRefusal = false;
  let down = false;
  /** @type {import('node:http').ServerResponse | null} */
  let turn = null;
  /** @type {Record<string, unknown> | null} */
  let kept = null;
  const list = () => ({ chats: [
    ...questions.length ? [{ chat: CHAT, title: questions[0].question, first_ms: 1790000000000, last_ms: 1790000000000, messages: 2 }] : [],
    ...chatted ? [{ chat: OLD_CHAT, title: 'An older question', first_ms: 1780000000000, last_ms: 1780000000000, messages: 2 }] : [],
  ] });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '', 'http://door');
    /** @param {unknown} body */
    const send = body => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/v1/ask')) {
      asked.push(`${request.method} ${url.pathname}`);
      if (down) {
        response.writeHead(503, { 'content-type': 'application/json' });
        return void response.end('{"code":"ASK_DOWN","error":"down"}');
      }
      if (url.pathname === '/v1/ask' && request.method === 'POST') {
        /** @type {Buffer[]} */
        const body = [];
        request.on('data', part => body.push(part));
        request.on('end', () => {
          const { submission, ...question } = JSON.parse(Buffer.concat(body).toString('utf8'));
          posted.push(submission);
          const refuse = () => {
            if (refusing === 'down') {
              response.writeHead(503, { 'content-type': 'application/json' });
              return void response.end('{"code":"ASK_DOWN","error":"down"}');
            }
            signedIn = false;
            response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
            response.end(`${JSON.stringify({ type: 'error', error: 'login', message: SIGNED_OUT.said })}\n`);
          };
          if (refusing && holdRefusal) return void (refusal = refuse);
          if (refusing) return refuse();
          assert.match(submission, /^[0-9a-f]{32}$/u);
          questions.push(question);
          response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
          response.write(`${JSON.stringify({ type: 'chat', chat: CHAT, n: 2 })}\n`);
          turn = response;
        });
        return;
      }
      if (url.pathname === '/v1/ask' && heldReads) return void reads.add(() => send(signedIn ? READY : SIGNED_OUT));
      if (url.pathname === '/v1/ask') return send(signedIn ? READY : SIGNED_OUT);
      if (url.pathname === '/v1/ask/chats') {
        if (heldReads) return void reads.add(() => send(list()));
        return send(list());
      }
      if (url.pathname === `/v1/ask/chats/${CHAT}`) {
        return send({ chat: CHAT, title: questions[0]?.question ?? '', messages: [
          { chat: CHAT, n: 1, at_ms: 1790000000000, role: 'user', text: questions[0]?.question ?? '' },
          ...kept ? [kept] : []], ...kept ? {} : { running: { n: 2 } } });
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      return void response.end('{"code":"NOT_FOUND"}');
    }
    if (stall && url.pathname === '/v1/page/people') {
      stalled.add(response);
      return;
    }
    const named = !bare && url.pathname === '/v1/places';
    const toName = !bare && url.pathname === '/v1/page/places';
    const headers = { ...request.headers, host: behind.host };
    if (named || toName) delete headers['if-none-match'];
    const passed = ask({ host: behind.hostname, port: behind.port, path: request.url, method: request.method, headers },
      answer => {
        const rewritten = answer.statusCode === 200 && (named || toName || (tidy && url.pathname === '/v1/page/people'));
        if (!rewritten) {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
          return;
        }
        /** @type {Buffer[]} */
        const parts = [];
        answer.on('data', part => parts.push(part));
        answer.on('end', () => {
          const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
          if (named) body.spots = [...SPOTS(Date.now()), ...(body.spots ?? [])];
          else if (toName) body.to_name = [...SPOTS(Date.now()).map(spotRow), ...(body.to_name ?? [])];
          else Object.assign(body, { organise: { ...body.organise, count: 0, line: null, queue: [], often: 0 }, new: [] });
          send(body);
        });
      });
    passed.on('error', () => response.destroy());
    request.pipe(passed);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    ...inner,
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    asked,
    questions,
    posted,
    day: home.day,
    /** @param {boolean} now */
    chatted: now => { chatted = now; },
    /** @param {boolean} now */
    holdReads: now => {
      heldReads = now;
      if (now) return;
      for (const answer of reads) answer();
      reads.clear();
    },
    /**
     * @param {'' | 'down' | 'login'} how
     * @param {boolean} [held]
     */
    refuse(how, held = false) {
      refusing = how;
      holdRefusal = held;
    },
    letRefuse() {
      refusal?.();
      refusal = null;
    },
    /** @param {boolean} now */
    down: now => { down = now; },
    /**
     * @param {string} text
     * @param {Record<string, unknown>} [refs]
     * @param {Record<string, unknown>} [more]
     */
    answer(text, refs = {}, more = {}) {
      kept = { chat: CHAT, n: 2, at_ms: 1790000000001, role: 'assistant', text, refs, end: 'done', ms: 9, ...more };
      turn?.write(`${JSON.stringify({ type: 'text', delta: text })}\n`);
      turn?.end(`${JSON.stringify({ type: 'done', message: kept })}\n`);
      turn = null;
    },
    /** @param {boolean} now */
    signedIn: now => { signedIn = now; },
    /** @param {boolean} now */
    tidy: now => { tidy = now; },
    /** @param {boolean} now */
    stall: now => { stall = now; },
    /** @param {boolean} now */
    placeless: now => {
      bare = now;
      inner.placeless(now);
    },
    reset() {
      inner.reset();
      bare = false;
      signedIn = true;
      tidy = false;
      stall = false;
      chatted = false;
      heldReads = false;
      refusing = '';
      holdRefusal = false;
      refusal = null;
      down = false;
      kept = null;
      questions.length = 0;
      posted.length = 0;
      turn?.destroy();
      turn = null;
      for (const held of stalled) held.destroy();
      stalled.clear();
      reads.clear();
    },
    async close() {
      turn?.destroy();
      for (const held of stalled) held.destroy();
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
      await inner.close();
    },
  };
}

export const MAC = { ...state(['fullDiskAccess', ...SENSES, 'photos'], { ask_login: CHATGPT_SIGNED_IN }),
vault: { state: 'saved', saved_ms: null } };

/** @param {string} name */
export const act = name => `.ck-spot__card:not(.ck-spot__card--twin) [data-spot="${name}"]`;

const KEYS = /** @type {Record<string, [number, string]>} */ ({ Escape: [27, ''], ArrowLeft: [37, ''], ArrowRight: [39, ''],
  Tab: [9, ''], Enter: [13, '\r'], ' ': [32, ' '] });

const RING = '.ck-spot__clip:not([hidden]) .ck-spot__ring';

const CARD = '.ck-spot__card:not(.ck-spot__card--twin)';

/**
 * @param {number} n
 * @param {number} of
 */
export const heard = (n, of) => `[...document.querySelectorAll('[aria-live="polite"]')].some(each => each.textContent.endsWith(', ${n} of ${of}'))`;

/**
 * @param {number} n
 * @param {number} of
 * @param {boolean} lit
 */
export const resting = (n, of, lit) => `location.hash.includes('tour=${n}') && document.querySelector('.ck-spot[data-still]')
  && ${heard(n, of)} && ${lit ? '' : '!'}document.querySelector(${JSON.stringify(RING)})`;

/** @param {number} of */
export const offering = of => `${resting(1, of, true)} && document.querySelector('.ck-spot__title')?.textContent === ${JSON.stringify(WORDS.ask.title)}
  && document.querySelector('[data-tour="ask"] textarea').value === ${JSON.stringify(QUESTION)}`;

/** @param {number} of */
export const chatting = of => `${resting(1, of, true)} && document.querySelector('.ck-spot__title')?.textContent === ${JSON.stringify(WORDS.chat.title)}`;

/** @param {'failed' | 'answered'} face */
export const dockedRest = face => `document.querySelector('.ck-spot--docked[data-still]') && !document.querySelector(${JSON.stringify(RING)})
  && !document.querySelector(${JSON.stringify(CARD)}).hidden
  && document.querySelector('.ck-spot__title')?.textContent === ${JSON.stringify(WORDS[face].title)}
  && document.querySelector('.ck-spot__line')?.textContent === ${JSON.stringify(WORDS[face].line)}`;

export const answering = `location.hash.includes('tour=2') && document.querySelector('.ck-spot[data-still]')
  && document.querySelector(${JSON.stringify(CARD)}).hidden && !document.querySelector(${JSON.stringify(RING)})`;

export const seeing = `${resting(2, 6, true)} && document.querySelector('.ck-spot__title')?.textContent === ${JSON.stringify(WORDS.seen.title)}
  && document.querySelector('[data-ck-seen-eye]')`;

export const FIELD = '[data-tour="ask"] textarea';

/** @param {string} view */
export const leftOn = view => `!document.querySelector('.ck-spot') && location.hash.startsWith('#view=${view}')
  && !location.hash.includes('tour=')`;

/** @param {{ file: string }} options */
export function tourPage({ file }) {
  /** @type {{ shots: string[], waiting: string, steps: unknown[] }} */
  const seen = { shots: [], waiting: '', steps: [] };
  const page = pageHarness({ file, seen, size: WINDOW, scrollbars: true, front: tourHome });
  /** @type {Awaited<ReturnType<typeof page.journey>>['chrome']} */
  let chrome;

  let reduced = false;

  /** @param {'dark' | 'light'} theme */
  const media = theme => chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });

  /**
   * @param {string} hash
   * @param {unknown} host
   */
  async function load(hash, host) {
    await media('dark');
    await chrome.load(hash, host === null ? '' : `${hostScript(host)};window.hostAnswers['agent-guides'] = { answer: ${GUIDES} };`);
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  async function pressAt(x, y) {
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {number} [scale]
   */
  async function resize(width, height, scale = 1) {
    const seen = chrome.evaluate(`new Promise(done => addEventListener('resize',
      () => requestAnimationFrame(() => done(true)), { once: true }))`);
    await chrome.size(width, height, scale);
    await seen;
  }

  /** @param {string} selector */
  async function pressOn(selector) {
    const [x, y] = await chrome.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
      if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length);
      for (let at = found[0]; at; at = at.parentElement) {
        const travels = at.getAnimations().some(each => each.playState === 'running'
          && each.effect?.getKeyframes().some(frame => frame.transform && frame.transform !== 'none'));
        const named = at.tagName.toLowerCase() + (at.getAttribute('class') ?? '').trim().split(/\\s+/).filter(Boolean)
          .map(each => '.' + each).join('');
        if (travels) throw new Error(${JSON.stringify(selector)} + ' pressed while it travels (' + named + ' moves): wait for it to stand');
      }
      const box = found[0].getBoundingClientRect();
      if (!box.width || !box.height) throw new Error(${JSON.stringify(selector)} + ' has no box to press');
      window.pressedOn = null;
      window.pressing = found[0];
      addEventListener('pointerdown', event => { window.pressedOn = window.pressing.contains(event.target) ? found[0] : event.target; },
        { capture: true, once: true });
      return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
    await pressAt(x, y);
    const landed = await chrome.evaluate(`(() => { const on = window.pressedOn;
      if (!on || window.pressing?.contains(on)) return '';
      return on.tagName.toLowerCase() + (on.getAttribute('class') ?? '').trim().split(/\\s+/).filter(Boolean).map(each => '.' + each).join(''); })()`);
    assert.equal(landed, '', `the press on ${selector} landed on ${landed}`);
  }

  /** @param {string} key */
  async function key(key) {
    const [code, text] = KEYS[key];
    const name = key === ' ' ? 'Space' : key;
    await chrome.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: name,
      windowsVirtualKeyCode: code, text, unmodifiedText: text });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: name, windowsVirtualKeyCode: code });
  }

  /**
   * @param {string} id
   * @param {boolean} [ai]
   */
  const now = (id, ai = true) => chrome.evaluate(`(() => {
    const at = n => Math.round(n * 10) / 10;
    const box = each => { if (!each) return null; const r = each.getBoundingClientRect();
      return r.width && r.height ? [r.left, r.top, r.width, r.height].map(at) : null; };
    const spot = document.querySelector('.ck-spot');
    const ring = spot?.querySelector(${JSON.stringify(RING)});
    const shown = document.querySelector('#main > .main__section:not([hidden])');
    const union = list => { const boxes = list.filter(Boolean).map(each => each.getBoundingClientRect()).filter(each => each.width && each.height);
      if (!boxes.length) return null; const l = Math.min(...boxes.map(b => b.left)), t = Math.min(...boxes.map(b => b.top));
      return [l, t, Math.max(...boxes.map(b => b.right)) - l, Math.max(...boxes.map(b => b.bottom)) - t].map(at); };
    const id = ${JSON.stringify(id)};
    const notice = box(shown?.querySelector('[data-part="notice"]'));
    const hooked = id === 'ask' && !${ai} ? union([shown?.querySelector('[data-tour="ask"]'), shown?.querySelector('[data-part="notice"]')])
      : id === 'people' ? null
      : id === 'answer' ? box([...shown?.querySelectorAll('[data-ck-seen-eye]') ?? []].at(-1))
      : id === 'agents' ? box(shown?.querySelector('[data-tour="agents"] [data-ag-guides] .ck-ssection--card'))
      : id === 'devices' ? union([...shown?.querySelectorAll('[data-tour="devices"] .cn-device--wanted') ?? []])
        : box(shown?.querySelector('[data-tour="' + id + '"]'));
    const card = spot?.querySelector(${JSON.stringify(CARD)});
    const said = name => card?.querySelector(name)?.textContent ?? null;
    const inset = window.lifestreamHost?.state?.inset;
    return {
      hash: location.hash, hook: hooked, notice,
      seg: shown?.querySelector('[data-cn-seg][aria-selected="true"]')?.dataset.cnSeg ?? null,
      hole: box(ring),
      corner: Boolean(spot?.classList.contains('ck-spot--docked')),
      devices: [...shown?.querySelectorAll('[data-tour="devices"] .cn-device') ?? []].map(each => each.classList.contains('cn-device--wanted')),
      card: box(card), counter: card?.querySelector('.ck-spot__counter') ? 'drawn' : null, title: said('.ck-spot__title'), line: said('.ck-spot__line'),
      buttons: card ? [...card.querySelectorAll('button')].filter(each => !each.hidden).map(each => each.textContent) : [],
      focus: document.activeElement?.closest('.ck-spot__card') ? document.activeElement.textContent : document.activeElement?.tagName,
      labelled: card ? [card.getAttribute('role'), card.getAttribute('aria-modal'),
        document.getElementById(card.getAttribute('aria-labelledby'))?.textContent,
        document.getElementById(card.getAttribute('aria-describedby'))?.textContent] : null,
      said: [...document.querySelectorAll('[aria-live="polite"]')].map(each => each.textContent).find(each => / of \\d/.test(each)) ?? '',
      bounds: (column => [column.left, Math.max(column.top, inset ? 2 * inset.centre : 0), column.right, column.bottom])(
        document.querySelector('.column').getBoundingClientRect()),
    };
  })()`);

  /** @param {string} words */
  const edit = words => chrome.evaluate(`(() => { const each = document.querySelector(${JSON.stringify(FIELD)}); each.value = ${JSON.stringify(words)};
    each.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  const field = () => chrome.evaluate(`document.querySelector(${JSON.stringify(FIELD)}).value`);

  /**
   * @param {StepId} id
   * @param {number} n
   * @param {number} of
   * @param {{ lit?: boolean, ai?: boolean, focus?: string }} [options]
   */
  async function holds(id, n, of, { lit = true, ai = true, focus = '' } = {}) {
    const read = await now(id, ai);
    const words = id === 'ask' ? ai ? WORDS.ask : WORDS.chat : id === 'answer' ? WORDS.seen : WORDS[id];
    assert.equal(read.counter, null, 'the card counts no steps: the sidebar’s Finish setting up is the one count');
    assert.equal(read.title, words.title);
    assert.equal(read.line, words.line);
    const last = n === of;
    const buttons = id === 'ask' && ai ? ['Skip tour', 'Not now', 'Send'] : id === 'answer' ? ['Skip tour', SEE, 'Next']
      : [...last ? [] : ['Skip tour'], last ? 'Done' : 'Next'];
    assert.deepEqual(read.buttons, buttons, `step ${n}'s buttons`);
    assert.equal(read.focus, focus || buttons.at(-1), `step ${n}'s focus`);
    assert.deepEqual(read.labelled, ['dialog', 'false', words.title, words.line]);
    assert.equal(read.said, `${words.title}, ${n} of ${of}`);
    const [left, top, right, bottom] = read.bounds;
    const [x, y, w, h] = /** @type {number[]} */ (read.card);
    assert.ok(x >= left + 15 && y >= top + 15 && x + w <= right - 15 && y + h <= bottom - 15,
      `step ${n}'s card ${read.card} outside the bounds ${read.bounds}`);
    if (lit) {
      assert.ok(read.hook, `step ${n}'s hook has no box`);
      if (id === 'ask' && !ai) assert.ok(read.notice, 'Chat’s sign-in line is drawn to be lit');
      if (id === 'more') assert.equal(read.seg, 'not', 'Connectors shows what is not connected');
      if (id === 'devices') assert.deepEqual(read.devices, [false, true, true], 'the iPhone and Chrome rows lit, never the Mac');
      const pad = id === 'devices' ? 0 : 4;
      const grown = [read.hook[0] - pad, read.hook[1] - pad, read.hook[2] + 2 * pad, read.hook[3] + 2 * pad];
      assert.ok(read.hole && read.hole.every((each, at) => Math.abs(each - grown[at]) <= 1),
        `step ${n}'s hole ${read.hole} is not its hook ${read.hook} grown by ${pad} on every side`);
      const [hx, hy, hw, hh] = /** @type {number[]} */ (read.hole);
      assert.ok(x >= hx + hw || x + w <= hx || y >= hy + hh || y + h <= hy, `step ${n}'s card over its hole`);
    } else {
      assert.equal(read.hole, null, `step ${n} rings nothing`);
    }
    return read;
  }

  /**
   * @param {string} name
   * @param {string} ready
   */
  async function snap(name, ready) {
    const base = `${String(seen.shots.length + 1).padStart(2, '0')}-${name}`;
    for (const theme of /** @type {const} */ (['dark', 'light'])) {
      await media(theme);
      await chrome.until(ready);
      await chrome.shoot(join(page.out, `${base}-${theme}.png`));
    }
    await media('dark');
    seen.shots.push(base);
  }

  /**
   * @param {[StepId, string][]} walk
   * @param {{ from?: number, shots?: string, ai?: boolean, unlit?: readonly StepId[] }} [options]
   */
  async function walkThrough(walk, { from = 1, shots = '', ai = true, unlit = ['people'] } = {}) {
    for (let n = from; n <= walk.length; n += 1) {
      const [id, view] = walk[n - 1];
      if (id === 'answer') continue;
      const lit = !unlit.includes(id);
      const ready = n === 1 ? ai ? offering(walk.length) : chatting(walk.length) : resting(n, walk.length, lit);
      await chrome.until(ready);
      const read = await holds(id, n, walk.length, { ai, lit });
      assert.ok(read.hash.startsWith(`#view=${view}`) && read.hash.endsWith(`tour=${n}`), `step ${n} on ${read.hash}`);
      seen.steps.push({ run: shots || (reduced ? 'reduced' : 'motion'), step: n, id, view, ...read });
      if (shots) await snap(`${shots}-${n}-${id}`, ready);
      if (n < walk.length) await pressOn(act(n === 1 && ai ? 'pass' : 'lead'));
    }
  }

  /** @param {unknown} [host] */
  async function offered(host = MAC) {
    await load('#view=ask&tour=1', host);
    await chrome.until(offering(host === null ? 5 : 6));
  }

  /** @param {'failed' | 'answered'} face */
  async function docks(face) {
    await chrome.until(`${dockedRest(face)} && !document.querySelector('[data-tour="ask"]').getAnimations()
      .some(each => each.playState === 'running')`);
    const read = await now('answer');
    assert.deepEqual(read.buttons, ['Skip tour', 'Next']);
    assert.equal(read.hole, null, 'a hole while docked');
    assert.match(read.said, new RegExp(`^${WORDS[face].title}, 2 of 6$`, 'u'));
    const measured = await chrome.evaluate(`(() => { const r = document.querySelector('[data-tour="ask"]').getBoundingClientRect();
      const stage = document.querySelector('.ak-stage').getBoundingClientRect();
      const column = document.querySelector('.column').getBoundingClientRect();
      const on = document.elementFromPoint(stage.left + stage.width / 2, stage.top + stage.height / 2);
      return { dock: [r.left, r.top, r.right, r.bottom], scrim: Boolean(on?.closest('.ck-spot')), right: column.right }; })()`);
    assert.equal(measured.scrim, false, 'the scrim still takes presses');
    const [x, y, w, h] = /** @type {number[]} */ (read.card);
    assert.ok(Math.abs(x + w - (measured.right - 16)) <= 1, `the card ${read.card} not at the column's right`);
    const [, top] = measured.dock;
    assert.ok(y + h <= top - 13, `the card ${read.card} over the composer ${measured.dock}`);
  }

  return {
    open: page.open,
    close: page.close,
    get out() {
      return page.out;
    },
    /** @param {string} name */
    async journey(name) {
      const opened = await page.journey(name);
      chrome = opened.chrome;
      return opened;
    },
    /** @param {boolean} still */
    reduce: still => { reduced = still; },
    media, load, pressAt, resize, pressOn, key, now, edit, field, holds, snap, walkThrough, offered, docks,
  };
}
