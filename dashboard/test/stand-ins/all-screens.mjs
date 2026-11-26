// @ts-check
import { hostState, SENSES } from './onboarding-home.mjs';
import { askReady } from './ask-ready.mjs';

/** @typedef {{ url: string, method?: string, status?: number, json?: unknown, hold?: boolean, refuse?: boolean, lines?: unknown[], open?: boolean }} Stub */
/**
 * @typedef {object} Screen
 * @property {string} section
 * @property {string} name
 * @property {string} title
 * @property {string} hash
 * @property {'full' | 'home' | 'onboarding'} [base]
 * @property {unknown} [host]
 * @property {Stub[]} [stub]
 * @property {Record<string, string>} [storage]
 * @property {string} [run]
 * @property {number} [now]
 * @property {number} [width]
 * @property {number} [height]
 * @property {boolean} [optional]
 * @property {boolean} [raw]
 * @property {boolean} [whole]
 * @property {() => void} [arm]
 * @property {() => void} [disarm]
 * @property {string} [note]
 */

/** @param {Screen} screen */
export const screenPrelude = ({ stub = [], storage = {}, now = 0 }) => `(() => {
  if (${now}) { const real = Date.now; const by = ${now} - real(); Date.now = () => real() + by; }
  try {
    localStorage.clear();
    for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value);
  } catch {}
  const rules = ${JSON.stringify(stub)}.map(rule => ({ ...rule, pattern: new RegExp(rule.url) }));
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const rule = rules.find(each => each.pattern.test(url) && (!each.method || each.method === method));
    if (!rule) return real(input, init);
    if (rule.hold) return new Promise(() => {});
    if (rule.refuse) return Promise.reject(new TypeError('Failed to fetch'));
    if (rule.lines) {
      const text = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(stream) {
        for (const line of rule.lines) stream.enqueue(text.encode(JSON.stringify(line) + '\\n'));
        if (!rule.open) stream.close();
      } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
    }
    const status = rule.status ?? 200;
    return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(rule.json ?? {}), { status, headers: { 'content-type': 'application/json' } }));
  };
  const shown = element => element.getClientRects().length > 0 && !element.closest('.main__section[hidden]');
  const find = what => [...document.querySelectorAll(what)].find(shown) ?? null;
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  const until = async (what, ms = 9000) => {
    const asked = typeof what === 'string' ? () => find(what) : what;
    for (const end = performance.now() + ms; performance.now() < end; await sleep(60)) {
      const met = asked();
      if (met) return met;
    }
    throw new Error('never came: ' + what);
  };
  /** The control whose words are these, in what \`within\` names. */
  const named = (words, within = 'body') => [...document.querySelectorAll(within + ' button, ' + within + ' a, ' + within + ' [role=menuitem], ' + within + ' [role=option], ' + within + ' [role=radio], ' + within + ' [role=switch]')]
    .filter(shown).find(each => (each.getAttribute('aria-label') ?? '').trim() === words || each.textContent.trim().startsWith(words)) ?? null;
  const fire = element => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) element.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    element.click();
  };
  window.S = {
    find, sleep, until, named,
    async click(what) { fire(await until(what)); await sleep(250); },
    async press(words, within) { fire(await until(() => named(words, within))); await sleep(250); },
    async type(what, words) {
      const field = await until(what);
      field.focus();
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, words);
      field.dispatchEvent(new InputEvent('input', { bubbles: true, data: words, inputType: 'insertText' }));
      await sleep(300);
    },
    key(key, more = {}) {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...more }));
      return sleep(250);
    },
    hover(what) {
      const element = typeof what === 'string' ? find(what) : what;
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) element.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
      return sleep(300);
    },
    /** The photo viewer's bar kept shown, as a pointer moving over it keeps it. */
    awake() {
      setInterval(() => document.querySelector('.ck-viewer')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })), 400);
      return sleep(500);
    },
    scroll(what, top) {
      const box = find(what);
      if (box) box.scrollTop = top;
      return sleep(300);
    },
  };
})();`;

const GRANTED = ['fullDiskAccess', 'photos', ...SENSES, 'contacts', 'calendars', 'reminders'];
/** @param {Record<string, unknown>} [more] */
export const mac = (more = {}) => hostState({ granted: GRANTED, more: { setup: { state: 'done' },
  vault: { state: 'saved', saved_ms: null },
  ...more } });

const ago = (/** @type {number} */ days, hours = 0) => Date.now() - days * 86_400_000 - hours * 3_600_000;
const JSON_ASK_READY = askReady([{ id: 'synthetic-terra', name: 'Synthetic Terra', thinking: ['low', 'medium', 'high'], default: 'high', group: 'ChatGPT' },
  { id: 'synthetic-luna', name: 'Synthetic Luna', thinking: ['low', 'high'], default: 'high', group: 'ChatGPT' },
  { id: 'runner:macbook-pro-0001/qwen', name: 'Synthetic Qwen', thinking: [], default: '', group: 'This Mac', input: ['text'], leaves: null },
  { id: 'claude/synthetic-opus', name: 'Synthetic Opus', thinking: ['low', 'high'], default: 'low', group: 'Claude',
    leaves: 'Anthropic', state: 'unavailable' }]);

import { chatScreens } from './all-screens-chat.mjs';
import { peopleScreens } from './all-screens-people.mjs';
import { daysScreens, placesScreens, searchScreens } from './all-screens-life.mjs';
import { streamsScreens } from './all-screens-streams.mjs';
import { onboardingScreens } from './all-screens-onboarding.mjs';

/**
 * @param {{ bases: Record<string, string>, home: { day: string }, front: any, onboarding: any, FULL_DAY: string, FULL_PERSON: string, day: { atoms: any[] } }} context
 * @returns {Promise<Screen[]>}
 */
export async function allScreens(context) {
  const shared = { ...context, ago, ready: JSON_ASK_READY };
  return [...chatScreens(shared), ...await daysScreens(shared), ...await peopleScreens(shared), ...placesScreens(shared), ...searchScreens(shared),
    ...streamsScreens(), ...onboardingScreens(shared)].map(screen => ({ host: mac(), ...screen }));
}

