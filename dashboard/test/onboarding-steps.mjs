import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { MODELS } from '../public/kit-gallery-llm.js';
import { subscriptionOf } from '../public/lib/host.js';
import { sessionOf } from '../public/ui/flows/model.js';
import { backOf, heldSpan, keepSpan, keptSpan, landing, leftAs, owed, resume, SCREENS } from '../public/ui/onboarding/model.js';
import { MEDIA_MORE, mediaListed, mediaPick, MOVING_LINE, NO_CHANGES, partsOf, rangeOf, SCRAMBLE_CAUGHT_PERCENT } from '../public/ui/onboarding/view.js';
import { menuLines } from '../public/lib/model-menu.js';

/** @typedef {import('../public/lib/host.js').HostState} HostState */
/** @typedef {import('../public/types.js').StartCost} StartCost */

const GB = 1e9;
const DISK = { name: 'Macintosh HD', total_bytes: 494 * GB, used_bytes: 352 * GB, free_bytes: 142 * GB };

/** @param {Partial<HostState>} more @returns {HostState} */
const hostOf = more => ({ ...HOST_STATE, machine: { name: 'MacBook Pro', folder: '~/Lifestream', free_bytes: 142 * GB,
  days_of_room: 900, home: 'new', disk: DISK }, ...more });

/** @param {Partial<HostState>} more @param {any} [report] */
const seenOf = (more, report = REPORT) => /** @type {any} */ ({ state: hostOf(more), report });

/** @param {Record<string, unknown>} [more] */
const sessionWith = (more = {}) => /** @type {any} */ ({ ...sessionOf(true, 'dialog'), picked: new Map(), dialog: null,
  how: false, changes: NO_CHANGES, nameTyped: null, span: null, cost: { read: null, failed: '', settled: false }, saved: false, recovery: null,
  drafted: null, redrafted: false, failure: null, ...more });

/** @param {'copied' | 'saved' | null} used */
const keyWaits = used => ({ state: /** @type {const} */ ('key'), error: null, waiting: null,
  key: { number: 1, made_ms: Date.UTC(2026, 10, 23), used, said: used ? 'Copied. Paste it into your password manager within 90 seconds.' : null } });

/** @param {string} markup @param {string} key */
const control = (markup, key) => new RegExp(`<button([^>]*data-ob="${key}"[^>]*)>`, 'u').exec(markup)?.[1] ?? null;

test('S1: the screens in their order, and where a launch resumes from the host’s state', () => {
  assert.deepEqual(SCREENS, ['place', 'welcome', 'where', 'key', 'login', 'name', 'mac', 'range', 'record', 'ai', 'media', 'set']);
  const idle = { setup: { state: /** @type {const} */ ('idle'), error: null, waiting: null, key: null }, unit: null };
  assert.equal(resume(seenOf({ ...idle, placement: { moving: false, error: null } }, null)), 'place');
  assert.equal(resume(seenOf(idle, null)), 'welcome');
  assert.equal(resume(seenOf({ ...idle, setup: { state: 'working', error: null, waiting: null, key: null } }, null)), 'where');
  assert.equal(resume(seenOf({ ...idle, setup: keyWaits(null) }, null)), 'key');
  assert.equal(resume(seenOf({ ...idle, setup: { state: 'login-items', error: null, waiting: null, key: null } }, null)), 'login');
  const made = { setup: { state: /** @type {const} */ ('done'), error: null, waiting: null, key: null } };
  assert.equal(resume(seenOf(made, { ...REPORT, setup: { skipped: [], at: null, you: false } })), 'name');
  assert.equal(resume(seenOf(made, { ...REPORT, setup: { skipped: [], at: null, you: true } })), 'mac');
  assert.equal(resume(seenOf(made, { ...REPORT, setup: { skipped: [], at: 'range', you: true } })), 'range');
});

test('S2: Back goes to the screen before, never into the steps that made the home', () => {
  const made = seenOf({ setup: { state: 'done', error: null, waiting: null, key: null } },
    { ...REPORT, setup: { skipped: [], at: 'record', you: true } });
  assert.equal(backOf('where', made), 'welcome');
  assert.equal(backOf('key', made), null, 'its own Back drops the drafted key instead');
  assert.equal(backOf('name', made), null);
  assert.equal(backOf('mac', made), 'name');
  assert.equal(backOf('range', made), 'mac');
});

test('S3: the recovery key: its groups as the host gave them, Continue only once it is copied or saved and ticked', () => {
  const recovery = 'MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA';
  const parts = (/** @type {'copied' | 'saved' | null} */ used, /** @type {boolean} */ saved) => partsOf('key',
    seenOf({ setup: keyWaits(used), unit: null }, null), sessionWith({ recovery, saved }), null);
  const fresh = parts(null, false);
  assert.equal([...(fresh.body ?? '').matchAll(/class="ob-key__group"/gu)].length, 13);
  assert.match(control(fresh.foot.end ?? '', 'key-done') ?? '', /disabled/u);
  assert.equal(fresh.foot.note ?? '', '', 'a disabled Continue says it on its own');
  assert.match(control(fresh.body ?? '', 'saved') ?? '', /disabled/u, 'the tick waits for Copy or Save');
  assert.doesNotMatch(control(parts('copied', false).body ?? '', 'saved') ?? 'missing', /disabled/u);
  assert.equal(parts('copied', false).foot.note ?? '', '');
  assert.doesNotMatch(parts('saved', true).foot.note ?? '', /Settings/u, 'no promise of a place to see the key again');
  assert.match(control(parts('copied', false).foot.end ?? '', 'key-done') ?? '', /disabled/u, 'the tick still owed');
  assert.match(control(parts(null, true).foot.end ?? '', 'key-done') ?? '', /disabled/u, 'the key never copied or saved');
  assert.doesNotMatch(control(parts('saved', true).foot.end ?? '', 'key-done') ?? 'missing', /disabled/u);
  assert.match(parts('copied', false).body ?? '', /Copied\. Paste it into your password manager within 90 seconds\./u, 'the host’s words under the key');
  assert.match(fresh.foot.back ?? '', /data-ob="key-back"/u);
  const unread = partsOf('key', seenOf({ setup: keyWaits(null), unit: null }, null), sessionWith(), null);
  assert.equal([...(unread.body ?? '').matchAll(/class="ob-key__group"/gu)].length, 0, 'nothing shown before the host answers');
  assert.match(control(unread.body ?? '', 'key-copy') ?? '', /disabled/u);
});

test('S4: Where says encrypted unless the folder holds an older plain Lifestream, and opens one that exists', () => {
  const where = (/** @type {'new' | 'plain' | 'encrypted'} */ home) => partsOf('where', seenOf({ unit: null,
    setup: { state: 'idle', error: null, waiting: null, key: null },
    machine: { name: 'MacBook Pro', folder: '~/Lifestream', free_bytes: 142 * GB, days_of_room: 900, home, disk: DISK } }, null),
  sessionWith(), null);
  assert.match(where('new').body ?? '', /Encrypted/u);
  assert.match(where('new').foot.end ?? '', /Create Lifestream/u);
  assert.match(where('encrypted').body ?? '', /Encrypted/u);
  assert.match(where('encrypted').foot.end ?? '', /Open this Lifestream/u);
  assert.doesNotMatch(where('plain').body ?? '', /Encrypted/u);
  assert.match(where('plain').foot.end ?? '', /Open this Lifestream/u);
  assert.match(where('new').body ?? '', /Macintosh HD · 142 GB free/u, 'the volume the host names');
});

test('S0: moving to Applications says macOS may ask for the Downloads folder while it moves, not before the person presses Move', () => {
  const head = (/** @type {boolean} */ moving) => partsOf('place', seenOf({ placement: { moving, error: null } }), sessionWith(), null).head;
  assert.ok(head(true).includes(MOVING_LINE));
  assert.match(MOVING_LINE, /Downloads/u);
  assert.doesNotMatch(head(false), /Downloads/u);
});

test('S5: how far back: a pick outlives a quit for the same home folder and Mac, and is forgotten once setup ends', () => {
  /** @type {Map<string, string>} */
  const kept = new Map();
  const store = { getItem: (/** @type {string} */ key) => kept.get(key) ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ value) => void kept.set(key, value),
    removeItem: (/** @type {string} */ key) => void kept.delete(key) };
  const here = seenOf({ unit: 'macbook-pro-0001' });
  assert.equal(keptSpan(store, here), null);
  keepSpan(store, here, { months: 1 });
  assert.deepEqual(keptSpan(store, seenOf({ unit: 'macbook-pro-0001' })), { months: 1 });
  keepSpan(store, here, { months: null });
  assert.deepEqual(keptSpan(store, here), { months: null }, 'Everything is a pick of its own, not no pick');
  assert.equal(keptSpan(store, seenOf({ unit: 'macbook-pro-0002' })), null, 'another Mac’s pick');
  assert.equal(keptSpan(store, seenOf({ unit: 'macbook-pro-0001', machine: { name: 'MacBook Pro', folder: '/Volumes/T7/Lifestream', free_bytes: 142 * GB,
    days_of_room: 900, home: 'new', disk: DISK } })), null, 'another home folder’s pick');
  keepSpan(store, here, null);
  assert.equal(keptSpan(store, here), null);
  kept.set('lifestream.setup.span', '{not json');
  assert.equal(keptSpan(store, here), null);
});

test('S5: how far back: a kept pick comes back after a relaunch whenever the host\'s state lands, before or after the sizes, while they are estimating', () => {
  /** @type {Map<string, string>} */
  const kept = new Map();
  const store = { getItem: (/** @type {string} */ key) => kept.get(key) ?? null, setItem: (/** @type {string} */ key, /** @type {string} */ value) => void kept.set(key, value),
    removeItem: (/** @type {string} */ key) => void kept.delete(key) };
  const here = seenOf({ unit: 'macbook-pro-0001' });
  keepSpan(store, here, { months: 1 });
  const unread = /** @type {any} */ ({ state: null, report: null });
  const starting = seenOf({ unit: null });
  let span = heldSpan(null, store, unread);
  assert.equal(span, null, 'no state yet: nothing to match the pick against');
  span = heldSpan(span, store, starting);
  assert.equal(span, null, 'the Mac not named yet');
  span = heldSpan(span, store, here);
  assert.deepEqual(span, { months: 1 }, 'restored with the state, no sizes read');
  /** @type {StartCost} */
  const cost = { start: null, first: '2015-02-01', disk: { free_bytes: 142 * GB, keep_bytes: 10 * GB }, held_bytes: 0, settled: false,
    stops: [[1, 1], [6, 5], [12, 9], [null, 136]].map(([months, gb]) => ({ months, day: months === null ? null : `2026-0${months === 12
      ? 1 : 9}-23`, bytes: Number(gb) * GB, more: false, streams: {} })) };
  assert.equal(rangeOf(here, sessionWith({ span, cost: { read: cost, failed: '', settled: false } })).stop?.months, 1,
    'the sizes still estimating draw the kept pick, not six months');
  assert.deepEqual(heldSpan({ months: 12 }, store, here), { months: 12 }, 'a pick made since the relaunch is never replaced');
  assert.deepEqual(heldSpan({ months: null }, store, here), { months: null }, 'Everything held is a pick, not no pick');
});

test('S5: how far back: six months unless a start is kept, the disk bar the host’s, too little room said', () => {
  /** @type {StartCost} */
  const cost = { start: null, first: '2015-02-01', disk: { free_bytes: 142 * GB, keep_bytes: 10 * GB }, held_bytes: 0, settled: true,
    stops: [[1, 1], [6, 5], [12, 9], [null, 136]].map(([months, gb]) => ({ months, day: months === null ? null : `2026-0${months === 12
      ? 1 : 9}-23`, bytes: Number(gb) * GB, more: false, streams: {} })) };
  const seen = seenOf({});
  const read = (/** @type {StartCost} */ each) => ({ cost: { read: each, failed: '', settled: true } });
  assert.equal(rangeOf(seen, sessionWith(read(cost))).stop?.months, 6);
  assert.equal(rangeOf(seen, sessionWith(read({ ...cost, start: '2026-01-23' }))).stop?.months, 12);
  assert.equal(rangeOf(seen, sessionWith(read(cost))).disk?.name, 'Macintosh HD');
  const body = (/** @type {number | null} */ months) => partsOf('range', seen, sessionWith({ span: { months }, ...read(cost) }), null).body ?? '';
  assert.doesNotMatch(body(6), /too little for macOS/u);
  assert.match(body(null), /too little for macOS to run well/u);
  assert.match(body(6), /Lifestream will store<\/span><b>about 5\sGB/u);
  assert.equal(rangeOf(seen, sessionWith({ span: { months: 1 }, ...read({ ...cost, start: '2026-01-23' }) })).stop?.months, 1, 'a pick outranks the kept start');
  assert.equal(rangeOf(seen, sessionWith({ span: { months: 3 }, ...read(cost) })).stop?.months, 6, 'a pick no stop holds falls back');
  const estimating = partsOf('range', seen, sessionWith({ span: { months: null }, cost: { read: cost, failed: '', settled: false } }), null);
  assert.match(estimating.body ?? '', /Estimating/u, 'a first settled read from the home is not yet the page’s');
  assert.match(estimating.foot.note ?? '', /Sizes are ready in a minute or two\./u);
  assert.equal(partsOf('range', seen, sessionWith(read(cost)), null).foot.note, '');
  assert.doesNotMatch(estimating.body ?? '', /too little for macOS|data-part="lifestream"/u, 'no size claimed while estimating');
  assert.doesNotMatch(control(estimating.foot.end ?? '', 'range') ?? 'missing', /disabled/u, 'an estimate never holds Continue');
});

test('S11: a key or Login Items the Mac waits on is where every move before the home lands, never Where saying Creating', () => {
  const idle = { setup: { state: /** @type {const} */ ('idle'), error: null, waiting: null, key: null }, unit: null };
  const drafted = seenOf({ ...idle, setup: keyWaits(null) }, null);
  const login = seenOf({ ...idle, setup: { state: 'login-items', error: null, waiting: null, key: null } }, null);
  assert.equal(owed(drafted), 'key');
  assert.equal(owed(login), 'login');
  assert.equal(owed(seenOf(idle, null)), null);
  assert.equal(owed(seenOf({ ...idle, setup: { state: 'working', error: null, waiting: null, key: null } }, null)), null);
  assert.equal(landing('where', drafted), 'key', 'Get started from Welcome lands on the key');
  assert.equal(landing('welcome', drafted), 'key', 'Welcome moves on to the key the host resumed');
  assert.equal(landing('key', login), 'login');
  assert.equal(landing('where', login), 'login');
  assert.equal(landing('where', seenOf(idle, null)), 'where');
  assert.equal(landing('place', drafted), 'place');
  const foot = (/** @type {any} */ setup) => partsOf('where', seenOf({ unit: null, setup }, null), sessionWith(), null).foot.end ?? '';
  assert.doesNotMatch(foot(keyWaits(null)), />Creating</u, 'a key waits on the person, not on the Mac');
  assert.doesNotMatch(foot({ state: 'login-items', error: null, waiting: null, key: null }), />Creating</u);
  assert.doesNotMatch(control(foot(keyWaits(null)), 'setup') ?? 'missing', /aria-busy="true"/u);
  assert.match(foot({ state: 'working', error: null, waiting: null, key: null }), />Creating</u, 'only while the Mac works');
});

test('S8: leaving From this Mac always marks found, the mark the home waits on before this Mac sends', () => {
  assert.equal(leftAs('mac'), 'found');
  assert.equal(leftAs('record'), 'record');
  assert.equal(leftAs('ai'), 'ai');
});

test('S9: Never recorded names password managers as one, then what the person added', () => {
  const screen = REPORT.connectors.find(connector => connector.id === 'screen');
  const report = { ...REPORT, connectors: REPORT.connectors.map(connector => connector !== screen ? connector : { ...connector,
    members: connector.members.map(member => member.items !== 'modes' ? member : { ...member, panel: 'settings',
      value: [{ app: 'com.apple.keychainaccess', mode: 'exclude' }, { app: 'com.example.chat', mode: 'exclude' }] }) }) };
  const body = partsOf('record', seenOf({ unit: 'macbook-pro-0001' }, report), sessionWith(), null).body ?? '';
  assert.match(body, /Password managers/u);
  assert.match(body, /Password fields/u);
  assert.match(body, /Chat App/u);
  assert.doesNotMatch(body, /Keychain Access/u, 'a password manager is under Password managers, not by its name');
});

test('S10: a set up that fails after Login Items says the host’s words, with Back and Try again', () => {
  const login = partsOf('login', seenOf({ unit: null,
    setup: { state: 'failed', error: 'Lifestream didn’t answer.', waiting: null, key: null } }, null), sessionWith(), null);
  assert.match(login.body ?? '', /Lifestream didn’t answer\./u);
  assert.match(login.foot.back ?? '', /data-ob="login-back"/u);
  assert.match(login.foot.end ?? '', /Try again/u);
  assert.doesNotMatch(login.foot.note ?? '', /Waiting for you/u);
});

test('S6: images and audio draw the menu Default models draws: the home\'s rows, the Local header, More, Off last; its line, shimmering while it downloads; the footer only beside a download', () => {
  const QWEN = 'runner:runner-macbook-pro-0001/qwen3.5-4b';
  const PLAN = 'claude:plan-model-1';
  /** @param {string | null} value @param {Partial<import('../public/pages.js').ModelUse>} [said] */
  const modelsOf = (value, said = {}) => ({ ...MODELS, uses: MODELS.uses.map(use => use.use !== 'pictures' ? use : { ...use, value,
    line: null, working: false, leaves: false,
    words: value === null ? 'Off' : [...use.menu.rows, ...use.menu.local?.rows ?? []].find(each => each.value === value)?.name ?? '', ...said }) });
  const pictures = /** @type {import('../public/pages.js').ModelUse} */ (MODELS.uses.find(use => use.use === 'pictures'));
  const off = mediaPick(modelsOf(null), 'pictures');
  assert.deepEqual(off.lines, menuLines(pictures.menu), 'the use\'s own menu');
  assert.deepEqual([off.words, off.line, off.working, off.leaves], ['Off', '', false, false]);
  assert.equal(mediaListed(off, MEDIA_MORE), true);
  assert.equal(mediaListed(off, QWEN), true);
  assert.equal(mediaListed(off, 'none'), true);
  assert.equal(mediaListed(off, 'runner:runner-macbook-pro-0001/other'), false, 'nothing the menu does not list');
  assert.deepEqual(mediaPick(null, 'audio'), { lines: [], words: 'Off', line: '', working: false, leaves: false });
  const absent = { chatgpt: subscriptionOf({ state: 'absent' }), claude: subscriptionOf({ state: 'absent' }) };
  /** @param {any} models */
  const media = models => partsOf('media', seenOf({ ask_login: absent }), sessionWith({ changes: { ...NO_CHANGES,
    models: { read: models, drawn: null, failed: '' } } }), null);
  const drawn = media(modelsOf(null));
  assert.match(drawn.body ?? '', /Describe photos and screenshots/u);
  assert.match(drawn.body ?? '', /data-value="more"/u);
  assert.doesNotMatch(drawn.body ?? '', /On this Mac|Connect \w+ first|Download /u, 'no places, no greyed rows, no download in a name');
  assert.equal(drawn.foot.note, undefined, 'no download line: no footer');
  assert.doesNotMatch(drawn.body ?? '', /Faces and personal details/u, 'nothing leaves: no covered faces');
  const fetching = media(modelsOf(QWEN, { line: 'Downloading · 3 min left', working: true }));
  assert.match(fetching.body ?? '', /<span class="ck-shimmer">Downloading · 3 min left<\/span>/u);
  assert.match(fetching.foot.note ?? '', /Models download in the background\./u);
  assert.match(media(modelsOf(PLAN, { leaves: true, words: 'Plan Model One' })).body ?? '', /Sent to Plan Model One/u,
    'a model that sends the photo shows its faces covered');
});

test('S7: the ai screen says its caught share from the one constant', () => {
  assert.equal(SCRAMBLE_CAUGHT_PERCENT, 74);
});
