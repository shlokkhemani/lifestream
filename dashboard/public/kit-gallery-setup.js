// @ts-check
/** @import { HostState } from './lib/host.js' */
/** @import { StartCost, StreamsReport } from './types.js' */
/** @import { Screen, Seen } from './ui/onboarding/model.js' */
/** @import { Session } from './ui/onboarding/view.js' */
/** @import { ModelPlace, ModelUse } from './pages.js' */
/** @import { Models } from './lib/model-menu.js' */
import { subscriptionOf } from './lib/host.js';
import { esc } from './lib/html.js';
import { sectionLabel, setupBand, setupFoot, setupFrame } from './ui/kit/index.js';
import { flowOf, sessionOf } from './ui/flows/model.js';
import { DOTS, stepOf } from './ui/onboarding/model.js';
import { NO_CHANGES, partsOf } from './ui/onboarding/view.js';
import { AT, HOST_STATE, REPORT } from './kit-gallery-report.js';
import { MODELS } from './kit-gallery-llm.js';
import { PRIVACY } from './kit-gallery-privacy.js';

const GB = 1e9;

const DISK = { name: 'Macintosh HD', total_bytes: 494 * GB, used_bytes: 352 * GB, free_bytes: 142 * GB };

/** @param {string[]} granted @returns {HostState['grants']} */
const grantsOf = granted => HOST_STATE.grants.map(grant => ({ ...grant, granted: granted.includes(grant.id), asking: false }));

const PHOTOS_GRANT = { id: 'photos', title: 'Photos', why: 'Every photo and video in Photos.', granted: false, optional: false,
  asking: false, denied: false };

/** @type {HostState} */
const MADE = { ...HOST_STATE, needs: [], grants: [...grantsOf([]), PHOTOS_GRANT], browsers: [],
  machine: { name: 'MacBook Pro', folder: '~/Lifestream', free_bytes: 142 * GB, days_of_room: 900, home: 'new', disk: DISK },
  account_name: 'Alex Morgan', setup: { state: 'done', error: null, waiting: null, key: null },
  ask_login: { chatgpt: subscriptionOf({ state: 'absent' }), claude: subscriptionOf({ state: 'absent' }) } };

/** @type {HostState} */
const FRESH = { ...MADE, setup: { state: 'idle', error: null, waiting: null, key: null }, unit: null };

/** @param {Partial<HostState>} state @param {StreamsReport | null} [report] @returns {Seen} */
const seenOf = (state, report = REPORT) => ({ state: { ...MADE, ...state }, report });

/** @param {string[]} granted */
const allowed = granted => ({ grants: [...grantsOf(granted), { ...PHOTOS_GRANT, granted: granted.includes('photos') }] });

const ALL = ['fullDiskAccess', 'photos', 'screenRecording', 'accessibility', 'microphone', 'systemAudio'];

/** @type {StartCost} */
const COST = { start: null, first: '2015-02-01', disk: { free_bytes: 142 * GB, keep_bytes: 10 * GB }, held_bytes: 0.2 * GB,
  settled: true, stops: [[1, 1.1], [3, 2.6], [6, 4.8], [12, 9.4], [24, 18.2], [60, 41], [120, 88], [null, 136]].map(([months, gb]) => ({
    day: months === null ? null : `2026-${String(Math.max(1, 11 - Number(months) % 12)).padStart(2, '0')}-23`,
    months: /** @type {number | null} */ (months), bytes: Number(gb) * GB, more: false, streams: {} })) };


/** @param {Partial<Session>} [more] @returns {Session} */
const sessionWith = (more = {}) => ({ ...sessionOf(true, 'dialog'), picked: new Map(), dialog: null, how: false,
  changes: NO_CHANGES, nameTyped: null, span: null, cost: { read: COST, failed: '', settled: true }, saved: false, recovery: null, drafted: null,
  redrafted: false, ...more });

/**
 * @param {Screen} screen
 * @param {Seen} seen
 * @param {Session} session
 */
function page(screen, seen, session) {
  const flow = screen === 'ai' ? flowOf('model', seen, session, AT) : null;
  const parts = partsOf(screen, seen, session, flow);
  const looks = ['ck-onb', parts.look ? `ck-onb--${parts.look}` : ''].filter(Boolean);
  return `<div class="gallery__page gallery__setup ob">${setupFrame({ className: looks.slice(1).join(' '),
    band: setupBand({ brand: parts.brand !== false, at: stepOf(screen).dot, of: DOTS }), head: parts.head, body: parts.body ?? '',
    foot: setupFoot(parts.foot) })}${parts.dialog ?? ''}</div>`;
}

/**
 * @param {string} label
 * @param {Screen} screen
 * @param {Seen} seen
 * @param {Partial<Session>} [more]
 */
const shot = (label, screen, seen, more = {}) => `<div class="gallery__specimen" data-setup="${esc(label)}">`
  + `<p class="gallery__label mac-mono-label">${esc(label)}</p>${page(screen, seen, sessionWith(more))}</div>`;

/** @param {Record<string, unknown>} changed @returns {Session['changes']} */
const changesOf = changed => /** @type {Session['changes']} */ ({ ...NO_CHANGES, ...changed });

const SCREEN_STATE = /** @type {import('./ui/connectors/settings-search.js').ScreenState} */ ({
  power: 'plugged-idle', words_indexed_through: null, bytes: 0, vectors_bytes: 0, queued: 0,
  waits: null, waits_line: null, embedded: 0, named: 0, skipped: 0 });

const RUNNER = 'runner-macbook-pro-0001';
const QWEN = `runner:${RUNNER}/qwen3.5-4b`;
const PARAKEET = `runner:${RUNNER}/parakeet-unified-en-0.6b`;
const PLAN_ONE = 'claude:plan-model-1';
const PLAN_TWO = 'codex:plan-model-2';
const THIS_MAC = 'On this Mac';

const NAMES = /** @type {Record<string, string>} */ ({ [QWEN]: 'Qwen 3.5 4B', [PARAKEET]: 'Parakeet', [PLAN_ONE]: 'Plan Model One',
  [PLAN_TWO]: 'Plan Model Two' });

const SIGNED = subscriptionOf({ state: 'signed_in', account: 'person-a@example.com', plan: 'max' });

/**
 * @param {string} place
 * @param {string} value
 * @param {Partial<ModelPlace>} [said]
 * @returns {ModelPlace}
 */
const placeOf = (place, value, said = {}) => ({ place, value, line: null, working: false, ready: true, leaves: place !== THIS_MAC, ...said });

/**
 * @param {ModelUse['use']} use
 * @param {ModelPlace[]} places
 * @param {string | null} value
 * @param {string | null} [line]
 * @returns {ModelUse}
 */
const mediaUse = (use, places, value, line = null) => {
  const base = /** @type {ModelUse} */ (MODELS.uses.find(each => each.use === use));
  /** @param {ModelPlace} place */
  const rowOf = place => ({ value: place.value ?? '', name: NAMES[place.value ?? ''], account: null, chosen: place.value === value });
  const local = places.filter(place => place.ready && !place.leaves).map(rowOf);
  return { ...base, line, words: value === null ? 'Off' : NAMES[value], value, places,
    menu: { ...base.menu, rows: places.filter(place => place.ready && place.leaves).map(rowOf), local: local.length ? { label: 'Local', rows: local } : null,
      off: base.menu.off && { ...base.menu.off, chosen: value === null } } };
};

/**
 * @param {ModelUse} pictures
 * @param {ModelUse} audio
 * @returns {Models}
 */
const mediaModels = (pictures, audio) => ({ ...MODELS, uses: MODELS.uses.map(each => each.use === 'pictures' ? pictures
  : each.use === 'audio' ? audio : each) });

const ON_MAC_QWEN = placeOf(THIS_MAC, QWEN, { line: 'Download Qwen 3.5 4B · 4.0 GB' });
const ON_MAC_PARAKEET = placeOf(THIS_MAC, PARAKEET, { line: 'Download Parakeet · 0.7 GB' });
const CLAUDE = placeOf('Claude', PLAN_ONE);
const CHATGPT = placeOf('ChatGPT', PLAN_TWO, { line: 'Connect ChatGPT first', ready: false });

const NOTHING = mediaModels(mediaUse('pictures', [ON_MAC_QWEN, CLAUDE, CHATGPT], null), mediaUse('audio', [ON_MAC_PARAKEET], null));
const PICKED = mediaModels(mediaUse('pictures', [ON_MAC_QWEN, CLAUDE, CHATGPT], PLAN_ONE),
  mediaUse('audio', [{ ...ON_MAC_PARAKEET, line: null }], PARAKEET, 'Downloading, 0.3 of 0.7 GB'));
const READY = mediaModels(mediaUse('pictures', [{ ...ON_MAC_QWEN, line: null }, { ...CLAUDE, line: 'Connect Claude first', ready: false },
  { ...CHATGPT, line: null, ready: true }], PLAN_TWO), mediaUse('audio', [{ ...ON_MAC_PARAKEET, line: null }], PARAKEET));
const SMALL = mediaModels(mediaUse('pictures', [{ ...CLAUDE, line: 'Connect Claude first', ready: false }, CHATGPT], null),
  mediaUse('audio', [ON_MAC_PARAKEET], null));

const UNIT = 'macbook-pro-0001';

const WHATSAPP = /** @type {StreamsReport['connectors'][number]} */ (REPORT.connectors.find(connector => connector.id === 'whatsapp'));

const ON_MAC = [['imessage', 'Messages', 'message'], ['apple-mail', 'Mail', 'mail'], ['apple-notes', 'Notes', 'note'],
  ['apple-calendar', 'Calendar', 'calendar-event'], ['whatsapp', 'WhatsApp', 'message'], ['voice-memos', 'Voice Memos', 'recording'],
  ['safari', 'Safari history', 'web']];

const SCREEN = /** @type {StreamsReport['connectors'][number]} */ (REPORT.connectors.find(connector => connector.id === 'screen'));

const SENSORS = [['screen', 'Screen', 'screen', ['screenRecording'], 'What’s on your screen, as video and text, so you can find '
    + 'anything you saw.'],
  ['input', 'Keyboard and mouse', 'input', ['accessibility'], 'Your keys, clicks and scrolls, and which app they went to. '
    + 'Password fields are never recorded.'],
  ['audio', 'Audio', 'audio', ['microphone', 'systemAudio'], 'Both sides of calls, voice notes and dictation, only while an app '
    + 'uses the mic.']];

/** @param {boolean} met @returns {StreamsReport} */
const sensing = met => ({ ...REPORT, connectors: [...REPORT.connectors.filter(connector => connector.id !== 'screen'),
  ...SENSORS.map(([id, name, icon, grants, records]) => /** @type {StreamsReport['connectors'][number]} */ (/** @type {unknown} */ ({ ...SCREEN, id: String(id), product: String(id), name: String(name),
    icon: String(icon), records: String(records), mac_grants: [...grants],
    members: id === 'screen' ? SCREEN.members.map(member => member.items === 'modes' ? { ...member, panel: 'settings',
      value: [{ app: 'com.apple.keychainaccess', mode: 'exclude' },
        { app: 'com.example.chat', mode: 'exclude' }] } : member) : [],
    ways: [{ road: 'mac', ready: met, requirements: [{ kind: 'app', met: true, act: null, words: 'Found on your Mac', line: null },
      ...[...grants].map(grant => ({ kind: 'grant', met, words: `${grant} is ${met ? 'allowed' : 'not allowed'}`, line: null,
        act: met ? null : { do: 'grant', label: 'Allow', unit: UNIT, grant } }))] }] })))] });

/** @type {StreamsReport} */
const MAC_REPORT = { ...REPORT,
  connectors: [...REPORT.connectors.filter(connector => connector.id !== 'whatsapp'), ...ON_MAC.map(([id, name, icon]) => ({
    ...WHATSAPP, id, name, icon, product: id, on: id !== 'safari' }))],
  devices: REPORT.devices.map(device => device.unit === UNIT ? { ...device, found: ON_MAC.map(([id]) => id) } : device) };

const MADE_MACHINE = /** @type {NonNullable<HostState['machine']>} */ (MADE.machine);

const RECOVERY = 'MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA';

const SAVED_AS = 'Saved to Lifestream recovery key 1 (23 Nov 2026).txt.';

/** @param {'copied' | 'saved' | null} used @param {string | null} said @returns {HostState['setup']} */
const keyWaiting = (used, said) => ({ state: 'key', error: null, waiting: null,
  key: { number: 1, made_ms: Date.UTC(2026, 10, 23), used, said } });

export const SETUP_SHOTS = () => [
  shot('place', 'place', seenOf({ ...FRESH, placement: { moving: false, error: null } })),
  shot('place~Failed', 'place', seenOf({ ...FRESH, placement: { moving: false, error: 'Lifestream couldn’t move itself. Drag it '
    + 'to Applications in Finder.' } })),
  shot('welcome', 'welcome', seenOf(FRESH, null)),
  shot('where', 'where', seenOf(FRESH, null)),
  shot('where~Low space', 'where', seenOf({ ...FRESH, machine: { name: 'MacBook Pro', folder: '~/Lifestream', free_bytes: 18 * GB,
    days_of_room: 30, home: 'new', disk: null } }, null)),
  shot('where~External drive', 'where', seenOf({ ...FRESH, machine: { name: 'MacBook Pro', folder: '/Volumes/T7 Shield/Lifestream',
    free_bytes: 1.6e12, days_of_room: 3000, home: 'new', disk: null } }, null)),
  shot('where~Creating', 'where', seenOf({ ...FRESH, setup: { state: 'working', error: null,
    waiting: 'Lifestream is starting: it answers in a moment.', key: null } }, null)),
  shot('where~Failed', 'where', seenOf({ ...FRESH, setup: { state: 'failed', error: 'The folder can’t be written.', waiting: null, key: null } }, null)),
  shot('login', 'login', seenOf({ ...FRESH, setup: { state: 'login-items', error: null, waiting: null, key: null } }, null)),
  shot('login~Failed', 'login', seenOf({ ...FRESH, setup: { state: 'failed', error: 'Lifestream didn’t answer after it was allowed.',
    waiting: null, key: null } }, null)),
  shot('key', 'key', seenOf({ ...FRESH, setup: keyWaiting(null, null) }, null), { recovery: RECOVERY }),
  shot('key~New key', 'key', seenOf({ ...FRESH, setup: keyWaiting(null, null) }, null), { recovery: RECOVERY, redrafted: true }),
  shot('key~Copied', 'key', seenOf({ ...FRESH, setup: keyWaiting('copied', 'Copied. Paste it into your password manager within 90 seconds.') }, null),
    { recovery: RECOVERY }),
  shot('key~Saved', 'key', seenOf({ ...FRESH, setup: keyWaiting('saved', SAVED_AS) }, null), { recovery: RECOVERY, saved: true }),
  shot('key~Creating', 'key', seenOf({ ...FRESH, setup: { state: 'working', error: null, waiting: null, key: null } }, null),
    { recovery: RECOVERY, saved: true }),
  shot('where~Existing Lifestream', 'where', seenOf({ ...FRESH, machine: { ...MADE_MACHINE, folder: '/Volumes/T7/Lifestream',
    home: 'encrypted' } }, null)),
  shot('name', 'name', seenOf({})),
  shot('mac~Reading', 'mac', seenOf({ unit: 'macbook-pro-0099' })),
  shot('mac', 'mac', seenOf({ unit: UNIT }, MAC_REPORT)),
  shot('mac~Allowed', 'mac', seenOf({ unit: UNIT, ...allowed(['fullDiskAccess', 'photos']) }, MAC_REPORT),
    { picked: new Map([['safari', false]]) }),
  shot('range', 'range', seenOf({ unit: UNIT })),
  shot('range~Estimating', 'range', seenOf({ unit: UNIT }), { cost: { read: COST, failed: '', settled: false } }),
  shot('range~Not enough space', 'range', seenOf({ unit: UNIT }), { span: { months: null } }),
  shot('range~Reading', 'range', seenOf({ unit: UNIT }), { cost: { read: null, failed: '', settled: false } }),
  shot('record', 'record', seenOf({ unit: UNIT, ...allowed(['fullDiskAccess', 'photos']) }, sensing(false))),
  shot('record~Allowed', 'record', seenOf({ unit: UNIT, ...allowed(ALL) }, sensing(true)), { changes: changesOf({ screen: { read: SCREEN_STATE,
    drawn: null, failed: '' } }) }),
  shot('record~Never recorded', 'record', seenOf({ unit: UNIT, ...allowed(ALL) }, sensing(true)), { dialog: { app: '', lit: 0, site: '', error: '' },
    changes: changesOf({ screen: { read: SCREEN_STATE, drawn: null, failed: '' } }) }),
  shot('ai', 'ai', seenOf({ unit: UNIT }), { changes: changesOf({ privacy: { read: PRIVACY.fresh, drawn: null, failed: '' } }) }),
  shot('ai~Claude connected', 'ai', seenOf({ unit: UNIT, ask_login: { chatgpt: subscriptionOf({ state: 'absent' }), claude: SIGNED } }),
    { changes: changesOf({ privacy: { read: PRIVACY.fresh, drawn: null, failed: '' } }) }),
  shot('ai~Signing in', 'ai', seenOf({ unit: UNIT, ask_login: { claude: SIGNED, chatgpt: subscriptionOf({ state: 'signing_in',
    attempt: 'login-1', code: 'QX4F-7KD2', url: 'https://auth.example.com/device' }) } }),
  { changes: changesOf({ privacy: { read: PRIVACY.fresh, drawn: null, failed: '' } }) }),
  shot('ai~Scrambling off', 'ai', seenOf({ unit: UNIT }), { changes: changesOf({ privacy: { read: PRIVACY.none, drawn: null,
    failed: '' } }) }),
  shot('ai~How it works', 'ai', seenOf({ unit: UNIT }), { how: true, changes: changesOf({ privacy: { read: PRIVACY.fresh,
    drawn: null, failed: '' } }) }),
  shot('media', 'media', seenOf({ unit: UNIT, ask_login: { chatgpt: subscriptionOf({ state: 'absent' }), claude: SIGNED } }),
    { changes: changesOf({ models: { read: NOTHING, drawn: null, failed: '' } }) }),
  shot('media~Picked', 'media', seenOf({ unit: UNIT, ask_login: { chatgpt: subscriptionOf({ state: 'absent' }), claude: SIGNED } }),
    { changes: changesOf({ models: { read: PICKED, drawn: null, failed: '' } }) }),
  shot('media~Mac under 16 GB', 'media', seenOf({ unit: UNIT }), { changes: changesOf({ models: { read: SMALL, drawn: null,
    failed: '' } }) }),
  shot('media~Ready', 'media', seenOf({ unit: UNIT, ask_login: { chatgpt: SIGNED, claude: subscriptionOf({ state: 'absent' }) } }),
    { changes: changesOf({ models: { read: READY, drawn: null, failed: '' } }) }),
  shot('set', 'set', seenOf({ unit: UNIT })),
];

export const setupGallery = () => `<section class="gallery__group">${sectionLabel('Setup · every screen')}`
  + `<div class="gallery__stack">${SETUP_SHOTS().join('')}</div></section>`;
