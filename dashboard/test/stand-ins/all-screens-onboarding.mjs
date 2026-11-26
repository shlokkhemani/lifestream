// @ts-check
import { CHATGPT_CODE, CHATGPT_SIGNED_IN, hostState, SENSES } from './onboarding-home.mjs';
import { askReady, askSignedOut } from './ask-ready.mjs';

const TERRA = { id: 'synthetic-terra', name: 'Synthetic Terra', thinking: ['high'], default: 'high', group: 'ChatGPT' };
const TOUR_READY = askReady([TERRA]);
const TOUR_OUT = askSignedOut([TERRA], 'Chat needs your ChatGPT sign-in on your Mac.');

/** @param {any} shared */
export function onboardingScreens({ onboarding }) {
  const O = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ screen, /** @type {string} */ scene, /** @type {any} */ state, more = {}) => ({ section: 'Onboarding', name, title, hash: `#view=onboarding&seg=${screen}`, base: /** @type {const} */ ('onboarding'), host: state,
    arm: () => onboarding.quietly(scene), ...more });
  const before = hostState({ more: { setup: { state: 'idle' }, unit: null } });
  const made = (/** @type {any} */ options = {}) => hostState({ ...options, more: { setup: { state: 'done' }, ...options.more } });
  const all = ['fullDiskAccess', 'photos', ...SENSES];
  const key = { state: 'key', key: { number: 1, made_ms: Date.UTC(2026, 10, 23), used: null, said: null } };
  const answerKey = `window.hostAnswers['setup-key'] = { key: 'MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA' }; `
    + `window.setHostState(window.lifestreamHost.state); await S.sleep(600);`;
  const dialog = `await S.sleep(500); await S.click('[data-ob="never"]'); await S.sleep(600);`;
  const T = (/** @type {string} */ name, /** @type {string} */ title, /** @type {number} */ step, more = {}) => ({ section: 'Tour', name, title, hash: `#view=ask&tour=${step}`, base: /** @type {const} */ ('home'), ...more });
  return [
    O('ob-place', 'Move to Applications', 'place', 'empty', hostState({ more: { setup: { state: 'idle' }, unit: null, placement: { moving: false, error: null } } })),
    O('ob-place-failed', 'Move to Applications, the move failed', 'place', 'empty', hostState({ more: { setup: { state: 'idle' }, unit: null, placement: { moving: false, error: 'Lifestream couldn’t copy itself to Applications.' } } })),
    O('ob-welcome', 'Welcome', 'welcome', 'empty', before),
    O('ob-where', 'Where should Lifestream keep your data?', 'where', 'empty', before),
    O('ob-where-working', 'Where, creating', 'where', 'empty', hostState({ more: { setup: { state: 'working' }, unit: null } })),
    O('ob-where-failed', 'Where, creating failed', 'where', 'empty', hostState({ more: { setup: { state: 'failed', error: 'The folder can’t be written.' }, unit: null } })),
    O('ob-key', 'Save your recovery key', 'key', 'empty', hostState({ more: { setup: key, unit: null } }), { run: answerKey }),
    O('ob-login', 'Allow Lifestream in the background', 'login', 'empty', hostState({ more: { setup: { state: 'login-items' }, unit: null } })),
    O('ob-name', 'What’s your name?', 'name', 'empty', made()),
    O('ob-mac', 'From this Mac, before Full Disk Access', 'mac', 'found', made()),
    O('ob-mac-allowed', 'From this Mac, allowed', 'mac', 'counting', made({ granted: ['fullDiskAccess', 'photos'] })),
    O('ob-range', 'How far back should Lifestream go?', 'range', 'counting', made({ granted: ['fullDiskAccess', 'photos'] })),
    O('ob-record', 'Record what you do, every sense to allow', 'record', 'counting', made({ granted: ['fullDiskAccess', 'photos'] })),
    O('ob-record-done', 'Record what you do, every sense given', 'record', 'counting', made({ granted: all })),
    O('ob-record-never', 'Record what you do, Never recorded dialog', 'record', 'counting', made({ granted: all }), { run: dialog }),
    O('ob-ai', 'Connect your AI', 'ai', 'settled', made({ granted: all })),
    O('ob-ai-code', 'Connect your AI, the sign-in code', 'ai', 'settled', made({ granted: all, more: { ask_login: CHATGPT_CODE } })),
    O('ob-ai-done', 'Connect your AI, signed in', 'ai', 'settled', made({ granted: all, more: { ask_login: CHATGPT_SIGNED_IN } })),
    O('ob-ai-how', 'How hiding works', 'ai', 'settled', made({ granted: all }), { run: `await S.sleep(500); await S.click('[data-ob="how"]'); await S.sleep(600);` }),
    O('ob-media', 'Make your pictures and audio searchable', 'media', 'many', made({ granted: all, more: { ask_login: CHATGPT_SIGNED_IN } })),
    O('ob-set', 'You’re all set', 'set', 'many', made({ granted: all, more: { ask_login: CHATGPT_SIGNED_IN } })),
    O('ob-reading', 'A step, before the report is read', 'mac', 'empty', made(), { arm: () => { onboarding.quietly('empty'); onboarding.holdReports(true); }, disarm: () => onboarding.holdReports(false), raw: true, run: `await S.sleep(1500);`, whole: false }),
    T('tour-1', 'Tour step 1: Ask anything', 1, { stub: [{ url: 'api/ask$', method: 'GET', json: TOUR_OUT }, { url: 'api/ask/chats', json: { chats: [] } }] }),
    T('tour-1-offer', 'Tour step 1: the first question offered', 1, { stub: [{ url: 'api/ask$', method: 'GET', json: TOUR_READY }, { url: 'api/ask/chats', json: { chats: [] } }], run: `await S.sleep(1500);` }),
    T('tour-1-answered', 'Tour step 1: docked over the first answer', 1, { stub: [{ url: 'api/ask$', method: 'GET', json: TOUR_READY }, { url: 'api/ask/chats', json: { chats: [] } },
      { url: 'api/ask$', method: 'POST', lines: [{ type: 'chat', chat: '1792396847000-aaa009', n: 2 }, { type: 'done', message: { chat: '1792396847000-aaa009', n: 2, at_ms: Date.now(), role: 'assistant', text: 'You spent most of your week at River Flat and the Climbing Hall.', refs: {}, steps: [], end: 'done', ms: 8000, model: 'synthetic-terra', thinking: 'high' } }] }], run: `await S.sleep(1500); await S.press('Ask'); await S.sleep(1500);`, optional: true }),
    T('tour-2', 'Tour step 2: Quick search', 2, { stub: [{ url: 'api/ask$', method: 'GET', json: TOUR_OUT }] }),
    T('tour-3', 'Tour step 3: Your people', 3),
    T('tour-4', 'Tour step 4: Your places', 4),
    T('tour-5', 'Tour step 5: Add more of your life', 5),
    T('tour-6', 'Tour step 6: Connect an agent', 6),
    T('tour-absent', 'Tour, a step whose control comes later', 3, { stub: [{ url: 'api/life/people$', json: { position: '0:0', people: [], chats: [], organise: { queue: [], organised: 0, often: 0 }, others: 0 } }], run: `await S.sleep(1500);` }),
  ];
}
