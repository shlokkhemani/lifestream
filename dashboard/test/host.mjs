import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readHost, STATE_EVENT } from '../public/lib/host.js';
import SIGN_IN from '../../homelink/Tests/Fixtures/agents-host/waiting-sign-in.json' with { type: 'json' };
import ASKS from '../../homelink/Tests/Fixtures/agents-host/waiting.json' with { type: 'json' };
import SIGN_IN_WRONG from '../../homelink/Tests/Fixtures/agents-host/answer-sign-in-wrong.json' with { type: 'json' };
import ANSWERED from '../../homelink/Tests/Fixtures/agents-host/answer-once.json' with { type: 'json' };
import WIDENED from '../../homelink/Tests/Fixtures/agents-host/access-widened.json' with { type: 'json' };
import { actOf } from '../public/ui/connectors/page.js';
import { actButton, AT_REST } from '../public/ui/connectors/view.js';
import { startRouter } from '../public/ui/route.js';
import { installWindowBands, onBand } from '../public/ui/window.js';
import { homeStrip } from '../public/ui/kit/index.js';

/**
 * @param {unknown} host
 * @param {{ reply?: (message: any) => unknown, hash?: string }} [options]
 */
function fakeWindow(host, { reply = () => ({}), hash = '' } = {}) {
  /** @type {Record<string, Set<(event: unknown) => void>>} */
  const listeners = {};
  /** @type {unknown[]} */
  const posted = [];
  const win = {
    lifestreamHost: host,
    location: { hash },
    document: { title: '' },
    history: {
      /** @param {unknown} _ @param {string} __ @param {string} next */
      pushState: (_, __, next) => { win.location.hash = next; },
      /** @param {unknown} _ @param {string} __ @param {string} next */
      replaceState: (_, __, next) => { win.location.hash = next; },
    },
    /** @param {string} type @param {(event: unknown) => void} listener */
    addEventListener: (type, listener) => { (listeners[type] ??= new Set()).add(listener); },
    /** @param {string} type @param {(event: unknown) => void} listener */
    removeEventListener: (type, listener) => { listeners[type]?.delete(listener); },
    /** @param {string} type @param {unknown} [detail] */
    dispatch: (type, detail) => { for (const listener of listeners[type] ?? []) listener({ detail }); },
    webkit: { messageHandlers: { lifestream: { postMessage: (/** @type {any} */ message) => {
      posted.push(message);
      return reply(message);
    } } } },
    posted,
  };
  return win;
}

const REACH = JSON.parse(await readFile(new URL('./fixtures/host-reach.json', import.meta.url), 'utf8'));

const STATE = { inset: { left: 78, centre: 20 }, grants: [], needs: [], folder: null, recorder: null, reach: null, sending: null };
const ABSENT = { state: 'absent', bytes: null, total: null, attempt: null, url: null, code: null, account: null, plan: null,
  why: null };

test('H1: a host believed that is not kind mac, version 6', () => {
  for (const other of [{ kind: 'mac', version: 2, chrome: 'native' }, { kind: 'mac', version: 5, state: STATE },
    { kind: 'mac', version: 7, state: STATE }, { kind: 'ipad', version: 6, state: STATE },
    { kind: 'mac', version: '6', state: STATE }, 'mac', null, undefined]) {
    assert.equal(readHost(/** @type {any} */ (fakeWindow(other))), null, JSON.stringify(other));
  }
  const throwing = { ...fakeWindow(null), get lifestreamHost() { throw new Error('denied'); } };
  assert.equal(readHost(/** @type {any} */ (throwing)), null);
  const host = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: STATE })));
  assert.ok(host);
  assert.deepEqual(host.state.inset, { left: 78, centre: 20 });
  const sparse = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { grants: 'none', inset: { left: 'x' } } })));
  assert.deepEqual(sparse?.state, { inset: null, recorder: null, reach: null, sending: null, grants: [], needs: [], update: null,
    folder: null, unit: null, signins: [], browsers: null,
    pairing: null, phone_app: null, ask_login: { chatgpt: ABSENT, claude: ABSENT },
    connect_requests: null, placement: null, machine: null, account_name: null, setup: null, vault: null,
    apps: null, agent_requests: [], agent_asks: [], general: null, backups: null });
  const early = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
    placement: { moving: 'yes', error: 'Couldn’t move it.' }, machine: { name: 'Studio Mac', folder: '~/Lifestream',
      free_bytes: null, days_of_room: -3 }, account_name: 'Person A Example', setup: { state: 'working', error: 'stale' } } })))?.state;
  assert.deepEqual(early?.placement, { moving: false, error: 'Couldn’t move it.' });
  assert.deepEqual(early?.machine, { name: 'Studio Mac', folder: '~/Lifestream', free_bytes: null, days_of_room: null, home: null,
    disk: null });
  const disk = { name: 'Macintosh HD', total_bytes: 994e9, used_bytes: 582e9, free_bytes: 412e9 };
  for (const [given, read] of [[{ home: 'encrypted', disk }, { home: 'encrypted', disk }], [{ home: 'locked', disk: { ...disk, used_bytes: -1 } },
    { home: null, disk: null }], [{ home: 'plain', disk: { ...disk, name: '' } }, { home: 'plain', disk: null }]]) {
    const machine = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
      machine: { name: 'Studio Mac', folder: '~/Lifestream', free_bytes: 412e9, days_of_room: 410, ...given } } })))?.state.machine;
    assert.deepEqual({ home: machine?.home, disk: machine?.disk }, read, JSON.stringify(given));
  }
  assert.equal(early?.account_name, 'Person A Example');
  for (const [given, read] of [['', ''], [7, null], [null, null]]) {
    assert.equal(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, account_name: given } })))
      ?.state.account_name, read, JSON.stringify(given));
  }
  assert.deepEqual(early?.setup, { state: 'working', error: null, waiting: null, key: null });
  const starting = 'Lifestream is starting: it answers in a moment.';
  const key = { number: 1, made_ms: 1795392000000, used: 'copied', said: 'Copied. Paste it into your password manager within 90 seconds.' };
  for (const [setup, read] of [[{ state: 'login-items', error: 'x', waiting: starting }, { state: 'login-items', error: null, waiting: null, key: null }],
    [{ state: 'working', error: null, waiting: starting }, { state: 'working', error: null, waiting: starting, key: null }],
    [{ state: 'working', waiting: 7 }, { state: 'working', error: null, waiting: null, key: null }],
    [{ state: 'done' }, { state: 'done', error: null, waiting: null, key: null }], [{ state: 'failed', error: 'Lifestream didn’t start.' },
      { state: 'failed', error: 'Lifestream didn’t start.', waiting: null, key: null }], [{ state: 'running' }, { state: 'idle', error: null, waiting: null, key: null }],
    [{ state: 'key', key }, { state: 'key', error: null, waiting: null, key }],
    [{ state: 'key', key: { ...key, used: 'lost', said: 7 } }, { state: 'key', error: null, waiting: null, key: { ...key, used: null, said: null } }],
    [{ state: 'working', key }, { state: 'working', error: null, waiting: null, key: null }]]) {
    assert.deepEqual(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, setup } })))?.state.setup,
      read, JSON.stringify(setup));
  }
  const onboarding = { ...STATE, unit: 'macbook-pro-0001',
    sheets: ['mail'], signins: ['device', 'oauth', 7, 'key', 'client'],
    browsers: [{ id: 'chrome', name: 'Google Chrome', profiles: [{ id: 'Default', name: 'Person A' }, { name: 'no id' }] },
      { name: 'no id' }],
    pairing: { link: 'lifestream://pair?code=ABCD2345', code: 'ABCD2345', qr: 'data:image/png;base64,iVBORw0KGgo=', match: 'K7Q2',
      expires_ms: 1_000 },
    phone_app: { link: 'https://testflight.apple.com/join/example', qr: 'data:image/png;base64,iVBORw0KGgo=' },
    ask_login: { chatgpt: { state: 'signed_in', account: 'person-a@example.com', plan: 'plus' } },
    connect_requests: [{ id: 'r1', browser: 'Google Chrome' }, { browser: 'no id' }],
    vault: { state: 'saved', saved_ms: 1_700_000_000_000, key: 'HC7M 4LKI', error: 'no', locked: true, elsewhere: ['macbook-air-bb07'] },
    apps: { offered: [{ id: 'com.example.vault', name: 'Vault', icon: 'https://example.com/vault.png', suggested: true }, { id: 'com.example.bank', name: 'Bank', icon: 'lifestream-app://icon/com.example.bank' }, { id: 'com.example.notes', icon: 'data:image/png;base64,AAAA' }, { name: 'no id' }],
      private_windows: true },
    grants: [{ id: 'bluetooth', title: 'Bluetooth', why: '', granted: false, optional: true },
      { id: 'microphone', title: 'Microphone', why: '', granted: false, optional: 'yes', asking: true },
      { id: 'accessibility', title: 'Accessibility', why: '', granted: false, optional: false, asking: 'yes' },
      { id: 'screenRecording', title: 'Screen Recording', why: '', granted: false, optional: false,
        denied: true },
      { id: 'systemAudio', title: 'System Audio Recording', why: '', granted: false, optional: false,
        asking: true, denied: true }] };
  const v5 = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: onboarding })))?.state;
  assert.equal(v5?.unit, 'macbook-pro-0001');
  assert.equal(/** @type {any} */ (v5)?.sheets, undefined);
  assert.deepEqual(v5?.signins, ['device', 'key', 'client']);
  assert.deepEqual(v5?.browsers, [{ id: 'chrome', name: 'Google Chrome', profiles: [{ id: 'Default', name: 'Person A' }] }]);
  assert.deepEqual(v5?.pairing, { link: 'lifestream://pair?code=ABCD2345', code: 'ABCD2345', qr: 'data:image/png;base64,iVBORw0KGgo=', why: null,
    match: 'K7Q2', expires_ms: 1_000 });
  assert.deepEqual(v5?.phone_app, { link: 'https://testflight.apple.com/join/example', qr: 'data:image/png;base64,iVBORw0KGgo=' });
  const why = 'Lifestream can’t open its Wi-Fi connection. Quit what uses port 4682, or restart Lifestream.';
  const unlinked = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
    pairing: { link: null, code: 'ABCD2345', why, match: 'K7Q2', expires_ms: 1_000 } } })))?.state;
  assert.deepEqual(unlinked?.pairing, { link: null, code: null, qr: null, why, match: 'K7Q2', expires_ms: 1_000 });
  const both = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
    pairing: { link: 'lifestream://pair?code=ABCD2345', why, match: 'K7Q2', expires_ms: 1_000 } } })))?.state;
  assert.equal(both?.pairing?.why, null);
  assert.deepEqual(v5?.ask_login, { chatgpt: { ...ABSENT, state: 'signed_in', account: 'person-a@example.com', plan: 'plus' },
    claude: ABSENT });
  assert.deepEqual(v5?.connect_requests, [{ id: 'r1', browser: 'Google Chrome' }]);
  const said = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, ask_login: {
    chatgpt: { state: 'signing_in', attempt: 'login-1', code: 'QX4F-7KD2', url: 'https://auth.example.com/codex/device' },
    claude: { state: 'fetching', bytes: 120_000_000, total: 324_000_000 } } } })))?.state;
  assert.deepEqual(said?.ask_login.chatgpt, { ...ABSENT, state: 'signing_in', attempt: 'login-1', code: 'QX4F-7KD2',
    url: 'https://auth.example.com/codex/device' });
  assert.deepEqual(said?.ask_login.claude, { ...ABSENT, state: 'fetching', bytes: 120_000_000, total: 324_000_000 });
  const claude = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, ask_login: {
    chatgpt: { state: 'failed', why: 'Chat needs a paid ChatGPT plan.' },
    claude: { state: 'signing_in', attempt: '0f3a9c2e7b1d4a60', url: 'https://claude.example.com/oauth' } } } })))?.state;
  assert.equal(claude?.ask_login.chatgpt.why, 'Chat needs a paid ChatGPT plan.');
  assert.deepEqual([claude?.ask_login.claude.attempt, claude?.ask_login.claude.code], ['0f3a9c2e7b1d4a60', null]);
  assert.deepEqual(v5?.vault, { state: 'saved', saved_ms: 1_700_000_000_000 }, 'a member beside state and saved_ms was kept');
  /** @param {unknown} vault */
  const vaultRead = vault => readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, vault } })))?.state.vault;
  for (const state of ['none', 'unsaved', 'saved', 'locked', 'lost']) {
    assert.deepEqual(vaultRead({ state, saved_ms: null, key: 'HC7M 4LKI' }), { state, saved_ms: null }, state);
  }
  assert.deepEqual(vaultRead({ state: 'saved', saved_ms: null, keyed: true }), { state: 'saved', saved_ms: null, keyed: true }, 'an encrypted Lifestream read as not encrypted');
  assert.deepEqual(vaultRead({ state: 'saved', saved_ms: null, keyed: 'yes' }), { state: 'saved', saved_ms: null }, 'a keyed that is not true was read');
  for (const state of ['making', 'shown', 'failed', 7]) assert.equal(vaultRead({ state, key: 'HC7M 4LKI' }), null, `a vault ${state} was read`);
  for (const saved of ['1700000000000', -1, Number.NaN]) {
    assert.equal(vaultRead({ state: 'saved', saved_ms: saved })?.saved_ms, null, `saved_ms ${saved} was read`);
  }
  assert.deepEqual(v5?.apps, { offered: [{ id: 'com.example.vault', name: 'Vault', icon: '', suggested: true }, { id: 'com.example.bank', name: 'Bank', icon: 'lifestream-app://icon/com.example.bank', suggested: false }],
    private_windows: true });
  assert.deepEqual(v5?.grants.map(grant => grant.optional), [true, false, false, false, false]);
  assert.deepEqual(v5?.grants.map(grant => grant.asking), [false, true, false, false, true]);
  assert.deepEqual(v5?.grants.map(grant => grant.denied), [false, false, false, true, false]);
  const restart = { id: 'do', label: 'Restart to Update', tone: 'caution' };
  const held = { id: 'update:ready', line: 'Lifestream 1900 is ready', detail: null, acts: [restart], home: false };
  assert.deepEqual(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
    update: { ...held, acts: [{ ...restart, tone: 'loud' }] } } })))?.state.update, held);
  for (const update of [{ ...held, acts: [] }, { ...held, id: '' }, { ...held, line: 7 }, 'update:ready']) {
    assert.equal(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, update } })))?.state.update,
      null, JSON.stringify(update));
  }
  const odd = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
    unit: 7, signins: 'key', browsers: 'all', pairing: { link: 'x' },
    phone_app: { qr: 'data:image/png;base64,iVBORw0KGgo=' }, ask_login: { state: 'dancing' }, connect_requests: 'none' } })))?.state;
  assert.equal(odd?.unit, null);
  assert.equal(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, unit: '' } })))?.state.unit, '');
  assert.deepEqual(odd?.signins, [], 'no way of signing in the app does not name');
  assert.equal(odd?.browsers, null);
  assert.equal(odd?.pairing, null);
  assert.equal(odd?.phone_app, null);
  assert.deepEqual(odd?.ask_login, { chatgpt: ABSENT, claude: ABSENT }, 'a state of the old shape, or none, is absent');
  assert.equal(odd?.connect_requests, null);
  const request = SIGN_IN.state.agent_requests[0];
  const agents = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, agent_requests: [
    request, { ...request, checked: 'yes' },
    { ...request, id: '' }, { ...request, name: '' }, { ...request, choices: [47, 12] }, { ...request, choices: [47, 12, 830] },
    { ...request, choices: [47, 12, 83, 55] }, { ...request, choices: [47, 12, '83'] }, { ...request, sentence: 7 },
    { ...request, access: null }, 'request-d'] } })))?.state;
  assert.deepEqual(agents?.agent_requests, [request]);
  assert.equal(agents?.agent_requests[0], request, 'the same object, never reshaped');
  const unknown = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE,
    agent_requests: 'none' } })))?.state;
  assert.deepEqual(unknown?.agent_requests, []);
  const ask = ASKS.state.agent_asks[1];
  const asks = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, agent_asks: [...ASKS.state.agent_asks,
    { ...ask, id: '' }, { ...ask, choices: [{ answer: 'maybe', words: 'Maybe' }] }, { ...ask, version: '1' }, { ...ask, proposed: null },
    { ...ask, state: 'dancing' }, 'ask-4'] } })))?.state.agent_asks;
  assert.deepEqual(asks, ASKS.state.agent_asks);
  assert.ok(asks?.every((each, at) => each === ASKS.state.agent_asks[at]), 'each the same object');
});

test('H2: an act that resolves other than { notice?, added? } or rejects without the bridge\'s words', async () => {
  const win = fakeWindow({ kind: 'mac', version: 6, state: STATE }, {
    reply: message => {
      if (message.act === 'turn') return { notice: 'iMessage is off.', secret: 'never passed on' };
      if (message.act === 'open') return Promise.reject(new Error('Chrome is not on this Mac.'));
      if (message.act === 'retire-phone') return Promise.reject('refused');
      if (message.act === 'sheet') return { notice: 'Tracker is connected.', connected: true };
      if (message.act === 'connect-answer') return { refused: 'Not sent', said: 'not-sent' };
      if (message.act === 'faces') return { refused: 'Faces could not be turned on.', said: 'yes' };
      if (message.act === 'home') return { ...REACH.probe.reply, notice: '', kept: 'never passed on' };
      if (message.act === 'agent-answer') return message.id === 'request-a' && !message.access
        ? { ...SIGN_IN_WRONG.reply, pass: { url: 'https://home.example.com/mcp' }, notice: 'Not the number.' } : ANSWERED.reply;
      if (message.act === 'agent-access') return WIDENED.reply;
      if (message.act === 'setup-key') return message.do === 'show' ? { key: ' MZXW 6YTB ', kept: 'never passed on' } : { key: 7 };
      return null;
    },
  });
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  assert.deepEqual(await host.act({ act: 'turn', sources: ['imessage:macbook-pro-0001'], on: false }), { notice: 'iMessage is off.' });
  assert.deepEqual(await host.act({ act: 'allow', grants: ['fullDiskAccess'] }), {});
  assert.deepEqual(await host.act({ act: 'setup-key', do: 'show' }), { key: 'MZXW 6YTB' }, 'the key’s text, and nothing else');
  assert.deepEqual(await host.act({ act: 'setup-key', do: 'copy' }), {});
  assert.deepEqual(await host.act({ act: 'sheet', connector: 'tracker', route: 'tracker' }),
    { notice: 'Tracker is connected.' });
  await assert.rejects(host.act({ act: 'open', what: 'browser-store', browser: 'chrome' }),
    { message: 'Chrome is not on this Mac.' });
  await assert.rejects(host.act({ act: 'retire-phone', unit: 'iphone-0042' }), { message: 'refused', said: 'refused' });
  await assert.rejects(host.act({ act: 'connect-answer', id: 'req-1', allow: true }), { message: 'Not sent', said: 'not-sent' });
  await assert.rejects(host.act({ act: 'faces', do: 'on' }), { message: 'Faces could not be turned on.', said: 'refused' });
  assert.deepEqual(await host.act({ act: 'home', do: 'probe' }), REACH.probe.reply);
  assert.deepEqual(await host.act({ act: 'agent-answer', id: 'request-a', answer: 47 }), { answer: SIGN_IN_WRONG.reply.answer });
  assert.deepEqual(win.posted[0], { type: 'act', act: 'turn', sources: ['imessage:macbook-pro-0001'], on: false });
  const access = { allow: [{ reach: { all: true, but: ['health'] }, window: null, until_ms: null }], items: [], not: [], only: [],
    window: null, hide: /** @type {const} */ ('names'), shown: [] };
  await host.act({ act: 'agent-answer', id: 'request-a', answer: 47, access });
  await host.act({ act: 'agent-answer', id: 'rq-0000000000000001', answer: 'once', expect: 1 });
  assert.deepEqual(await host.act({ act: 'agent-access', id: 'p-00000001', access, expect: 4 }), { answer: WIDENED.reply.answer });
  assert.deepEqual(win.posted.slice(-4), [{ type: 'act', act: 'agent-answer', id: 'request-a', answer: 47 },
    { type: 'act', act: 'agent-answer', id: 'request-a', answer: 47, access },
    { type: 'act', act: 'agent-answer', id: 'rq-0000000000000001', answer: 'once', expect: 1 },
    { type: 'act', act: 'agent-access', id: 'p-00000001', access, expect: 4 }]);
  assert.equal(win.posted.length, 14);
  assert.deepEqual(win.posted[9], REACH.probe.request);
  const answers = [{ notice: 'Example Notes added.', added: true }, { notice: 'Example Notes is already listed.' },
    { notice: 'Example Chosen added.', added: 'yes' }, {}, { refused: 'Lifestream itself is not recorded.' }];
  const choosing = fakeWindow({ kind: 'mac', version: 6, state: STATE }, { reply: () => answers.shift() });
  const chooser = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (choosing)));
  assert.deepEqual(await chooser.act({ act: 'choose-app' }), { notice: 'Example Notes added.', added: true });
  assert.deepEqual(await chooser.act({ act: 'choose-app' }), { notice: 'Example Notes is already listed.' });
  assert.deepEqual(await chooser.act({ act: 'choose-app' }), { notice: 'Example Chosen added.' });
  assert.deepEqual(await chooser.act({ act: 'choose-app' }), {});
  await assert.rejects(chooser.act({ act: 'choose-app' }), { message: 'Lifestream itself is not recorded.', said: 'refused' });
  assert.deepEqual(choosing.posted, Array.from({ length: 5 }, () => ({ type: 'act', act: 'choose-app' })));
  const bare = { ...fakeWindow({ kind: 'mac', version: 6, state: STATE }), webkit: undefined };
  await assert.rejects(/** @type {any} */ (readHost(/** @type {any} */ (bare))).act({ act: 'window', do: 'zoom' }), /did not answer/u);
});

test('H3: a state read once and kept: follow reads the one state at once and at each event, until it stops', () => {
  const presence = { kind: 'mac', version: 6, state: STATE };
  const win = fakeWindow(presence);
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  /** @type {(number | null)[]} */
  const heard = [];
  const stop = host.follow(state => heard.push(state.inset?.centre ?? null));
  assert.deepEqual(heard, [20]);
  presence.state = { ...STATE, inset: null };
  assert.equal(host.state.inset, null);
  win.dispatch(STATE_EVENT);
  presence.state = { ...STATE, inset: { left: 70, centre: 14 } };
  win.dispatch(STATE_EVENT);
  assert.deepEqual(heard, [20, null, 14]);
  stop();
  win.dispatch(STATE_EVENT);
  assert.deepEqual(heard, [20, null, 14]);
});

test('H4: a router that still bends to a host: Connectors is the page\'s own, nothing is posted, Search is the router\'s', () => {
  const win = fakeWindow({ kind: 'mac', version: 6, state: STATE }, { hash: '#view=connectors&dialog=settings' });
  /** @type {string[]} */
  const mounted = [];
  /** @param {string} view */
  const page = view => (/** @type {any} */ _container, /** @type {any} */ context) => {
    mounted.push(`${view}:${context.route.focus || context.route.q}`);
    context.title(view);
    return {
      update: (/** @type {any} */ route) => mounted.push(`update:${route.q}`),
      focus: () => mounted.push('focus'),
    };
  };
  const pages = Object.fromEntries(['days', 'people', 'places', 'connectors', 'search'].map(view => [view, page(view)]));
  /** @type {any[]} */
  const sections = [];
  Object.assign(win.document, { createElement: () => ({ className: '', hidden: false }) });
  const container = { append: (/** @type {any} */ element) => sections.push(element) };
  const router = startRouter({ win: /** @type {any} */ (win), container: /** @type {any} */ (container), pages });
  assert.deepEqual(mounted, ['connectors:']);
  assert.equal(win.document.title, 'connectors · Lifestream');
  win.dispatch('lifestream:search', { q: 'lunch' });
  assert.equal(win.location.hash, '#view=connectors&dialog=settings');
  router.openSearch();
  assert.equal(win.location.hash, '#view=search');
  router.openSearch();
  router.leaveSearch();
  assert.equal(win.location.hash, '#view=connectors');
  assert.deepEqual(mounted, ['connectors:', 'search:', 'focus', 'focus']);
  assert.deepEqual(sections.map(section => section.hidden), [false, true]);
  assert.deepEqual(win.posted, []);
});

/** @param {{ band?: boolean, control?: boolean }} where */
const element = ({ band = true, control = false }) => ({
  /** @param {string} selector */
  closest: selector => selector === '[data-window-drag]' ? (band ? {} : null) : (control ? {} : null),
});

/**
 * @param {object} target
 * @param {Partial<Record<'button' | 'buttons' | 'x' | 'y', number> & Record<'metaKey' | 'shiftKey', boolean>>} [more]
 */
const mouse = (target, { button = 0, buttons = 1, x = 10, y = 10, metaKey = false, shiftKey = false } = {}) => ({
  target, button, buttons, clientX: x, clientY: y, metaKey, ctrlKey: false, altKey: false, shiftKey,
});

test('H5: a drag asked from a control, a modifier, another button, outside a band, a still click, twice, or after the button is up', () => {
  /** @type {Record<string, (event: any) => void>} */
  const on = {};
  /** @type {unknown[]} */
  const asked = [];
  installWindowBands({ addEventListener: (type, listener) => { on[type] = listener; } },
    { act: message => { asked.push(message); return Promise.resolve({}); } });
  const band = element({});
  const press = (/** @type {object} */ down, /** @type {object[]} */ moves) => {
    on.mousedown(down);
    for (const move of moves) on.mousemove(move);
    on.mouseup({});
  };
  assert.equal(onBand(mouse(band)), true);
  for (const down of [mouse(element({ control: true })), mouse(band, { metaKey: true }), mouse(band, { shiftKey: true }),
    mouse(band, { button: 2, buttons: 2 }), mouse(element({ band: false }))]) {
    press(down, [mouse(band, { x: 40, y: 40 })]);
  }
  press(mouse(band), [mouse(band, { x: 12, y: 12 })]);
  on.mousedown(mouse(band));
  on.mousemove(mouse(band, { x: 40, buttons: 0 }));
  on.mousemove(mouse(band, { x: 60 }));
  assert.deepEqual(asked, []);
  press(mouse(band), [mouse(band, { x: 14 }), mouse(band, { x: 30 }), mouse(band, { x: 80 })]);
  assert.deepEqual(asked, [{ act: 'window', do: 'drag' }]);
  /**
   * @param {string} tag
   * @param {string} role
   */
  const marked = (tag, role) => ({
    /** @param {string} selector */
    closest: selector => selector === '[data-window-drag]' ? {} : selector.split(/,\s*/u).some(one => one === tag
      || one === `[role=${role}]` || (one.startsWith('[role^=') && role.startsWith(one.slice(7, -1)))) ? {} : null,
  });
  for (const [tag, role] of [['div', 'menuitemradio'], ['div', 'menu'], ['button', 'switch'], ['div', 'option']]) {
    assert.equal(onBand(mouse(marked(tag, role))), false, role);
    press(mouse(marked(tag, role)), [mouse(band, { x: 40, y: 40 })]);
  }
  assert.equal(onBand(mouse(marked('div', 'group'))), true);
  assert.deepEqual(asked, [{ act: 'window', do: 'drag' }]);
  on.dblclick(mouse(element({ control: true })));
  on.dblclick(mouse(band));
  assert.deepEqual(asked, [{ act: 'window', do: 'drag' }, { act: 'window', do: 'zoom' }]);
});

test('H6: the window\'s status strip is reach\'s alone: its acts each the `home` act with its `do`, busy while pressed, a refusal said in place', () => {
  const held = { ...REACH.states.held.reach, acts: [...REACH.states.held.reach.acts, { do: '', label: 'No do' }] };
  const win = fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, reach: held, sending: 'Waiting for space on Lifestream\'s disk' } });
  const host = readHost(/** @type {any} */ (win));
  assert.ok(host);
  const state = host.state;
  const reach = /** @type {any} */ (state.reach);
  assert.deepEqual(reach?.acts, [{ do: 'verify', label: 'Check again' }], 'an act with no do was kept');
  const markup = homeStrip(reach);
  assert.match(markup, /Lifestream is held/u);
  assert.match(markup, /The drive holding it went away\.<span class="ck-strip__meta"> · since 14:02/u);
  assert.match(markup, /data-home-act="verify"[^>]*>[^<]*(<[^>]*>)*\s*Check again/u);
  assert.ok(!markup.includes('View details'), 'the strip\'s own acts alone');
  assert.ok(!markup.includes('disk'), 'what this Mac\'s last send met is no strip\'s');
  assert.ok(!markup.includes('data-home-details'), 'held states no path, so no Details');
  assert.match(homeStrip(reach, { busy: 'verify' }), /ck-btn--sm is-busy[^"]*ck-strip__act"[^>]*data-home-act="verify"/u, 'busy while the host answers');
  assert.match(homeStrip(reach, { said: 'Lifestream is not held.' }), /<div class="ck-in-place" role="alert">[^]*Lifestream is not held\./u,
    'the door\'s words, in place');
  const notRunning = REACH.states['unreachable, Lifestream not running'].reach;
  assert.match(homeStrip(notRunning), /Lifestream isn&#39;t running[^]*data-home-act="open"[^>]*>[^<]*(<[^>]*>)*\s*Start Lifestream/u);
  assert.ok(!homeStrip(notRunning, { open: true }).includes('data-home-details'), 'one button, no ›');
  const silent = REACH.states.unreachable.reach;
  assert.ok(!homeStrip(silent).includes('ck-path'), 'the checklist shut until the ›');
  const open = homeStrip(silent, { open: true });
  assert.match(open, /class="ck-popover ck-path"[^]*data-home-act="probe"[^>]*>[^<]*(<[^>]*>)*\s*Try again/u);
  assert.match(open, /Last reached 14:02/u, 'the head says when it last answered');
  assert.equal(open.match(/class="ck-path__row"/gu)?.length, 3, 'a row per link');
  assert.match(open, /Lifestream on this Mac[^]*Lifestream&#39;s drive[^]*Lifestream asks it again on its own/u);
  assert.doesNotMatch(open, /is-busy/u);
  const two = homeStrip(REACH.states["update, this Mac's"].reach, { others: [{ tone: 'warning', title: 'Lifestream’s disk is full',
    line: 'Nothing new is saved', meta: 'since 12:55', act: { label: 'Free up space', attrs: { 'data-banner-act': 'disk:full' } } }] });
  assert.match(two, /^<div class="ck-strip ck-strip--window ck-strip--warning"[^]*Lifestream’s disk is full[^]*data-home-more[^]*\+1[^]*Free up space/u,
    'the worst first, +1 before its button');
  assert.match(homeStrip(REACH.states["update, this Mac's"].reach, { listing: true, others: [{ tone: 'warning', title: 'Lifestream’s disk is full' }] }),
    /ck-banners[^]*Lifestream’s disk is full[^]*Update Lifestream on this Mac/u, '+1 lists both');
  assert.match(homeStrip(REACH.states.answering.reach, { others: [{ tone: 'done', title: 'Lifestream is back', line: '64 GB free' }] }),
    /ck-strip--done[^]*Lifestream is back[^]*64 GB free/u, 'the disk fixed: back, with its room');
  const checking = homeStrip(REACH.states['unreachable, checking again'].reach, { open: true });
  assert.match(checking, /is-busy[^"]*"[^>]*data-home-act="probe"/u, 'Try again busy while Check again runs');
  const starting = homeStrip(REACH.states.starting.reach);
  assert.match(starting, /ck-strip--waiting[^]*Lifestream is starting[^]*It answers in a moment/u);
  assert.doesNotMatch(starting, /data-home-act|data-home-details/u);
  assert.match(homeStrip(REACH.states['answering, just reached again'].reach), /ck-strip--done[^]*Lifestream is back/u);
  for (const quiet of ['answering', 'waiting', 'answering, its last send held']) {
    assert.equal(homeStrip(/** @type {any} */ (REACH.states[quiet].reach)), '', quiet);
  }
});

test('H10: reach, sending, an act\'s reply and the probe read as test/fixtures/host-reach.json holds them', async () => {
  assert.equal(REACH.version, 6);
  for (const [name, stated] of Object.entries(REACH.states)) {
    const host = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: REACH.version, state: { ...STATE, ...stated } })));
    assert.deepEqual({ reach: host?.state.reach, sending: host?.state.sending }, stated, name);
  }
  for (const odd of [{ state: 'gone', revision: 1 }, { state: 'answering' }, { state: 'held', revision: '7' }, 'answering']) {
    const host = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, reach: odd } })));
    assert.equal(host?.state.reach, null, JSON.stringify(odd));
  }
  const toneless = { ...REACH.states.unreachable.reach, tone: 'loud' };
  assert.deepEqual(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, reach: toneless } })))?.state.reach,
    { ...toneless, tone: null, title: null, line: null, meta: null, acts: [] });
  const notRunning = REACH.states['unreachable, Lifestream not running'].reach;
  const odd = { ...notRunning, path: notRunning.path.map((/** @type {any} */ link) => ({ ...link, act: link.act ? 'open' : null })) };
  assert.deepEqual(readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: { ...STATE, reach: odd } })))?.state.reach?.path
    .map(link => link.act), [null, null, null]);
  for (const { reply } of REACH.acts) {
    const host = readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6, state: STATE }, { reply: () => reply })));
    await assert.rejects(/** @type {any} */ (host).act({ act: 'pause', target: 'home' }), { message: reply.refused, said: reply.said });
  }
  const win = fakeWindow({ kind: 'mac', version: 6, state: STATE }, { reply: () => REACH.probe.reply });
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  assert.deepEqual(await host.act({ act: 'home', do: 'probe' }), REACH.probe.reply);
  assert.deepEqual(win.posted, [REACH.probe.request]);
});

test('H7: Settings\' acts post the shapes the Mac reads, and a refusal is said in its words', async () => {
  const win = fakeWindow({ kind: 'mac', version: 6, state: STATE }, {
    reply: message => {
      if (message.act === 'device-name' && message.unit.startsWith('iphone-')) {
        return { refused: 'Lifestream renames only a Mac it holds.', said: 'refused' };
      }
      if (message.act === 'pause') return { refused: 'Not sent', said: 'not-sent' };
      return {};
    },
  });
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  /** @type {import('../public/lib/host.js').HostAct[]} */
  const acts = [
    { act: 'resume', target: 'pause:gmail:history' },
    { act: 'home-setting', key: 'model.cap', value: 16 },
    { act: 'home-setting', settings: { 'privacy.level': 'all' } },
    { act: 'home-setting', settings: { 'privacy.chat': null } },
    { act: 'home-setting', settings: { 'search.meaning.power': 'plugged-idle' } },
    { act: 'models', do: 'default', use: 'search', model: 'none' },
    { act: 'models', do: 'default', use: 'chat', model: 'claude:plan-chat-1', thinking: 'high' },
    { act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1' },
    { act: 'device-name', unit: 'macbook-pro-0001', name: 'Studio Mac' },
    { act: 'device-name', unit: 'macbook-air-bb07', name: 'Desk Mac' },
    { act: 'open', what: 'home-folder' },
    { act: 'appearance', theme: 'system' },
    { act: 'appearance', theme: 'dark' },
  ];
  for (const each of acts) assert.deepEqual(await host.act(each), {});
  await assert.rejects(host.act({ act: 'pause', target: 'home' }), { message: 'Not sent', said: 'not-sent' });
  await assert.rejects(host.act({ act: 'device-name', unit: 'iphone-17-pro-aa01', name: 'Phone' }),
    { message: 'Lifestream renames only a Mac it holds.', said: 'refused' });
  assert.deepEqual(win.posted, [
    { type: 'act', act: 'resume', target: 'pause:gmail:history' },
    { type: 'act', act: 'home-setting', key: 'model.cap', value: 16 },
    { type: 'act', act: 'home-setting', settings: { 'privacy.level': 'all' } },
    { type: 'act', act: 'home-setting', settings: { 'privacy.chat': null } },
    { type: 'act', act: 'home-setting', settings: { 'search.meaning.power': 'plugged-idle' } },
    { type: 'act', act: 'models', do: 'default', use: 'search', model: 'none' },
    { type: 'act', act: 'models', do: 'default', use: 'chat', model: 'claude:plan-chat-1', thinking: 'high' },
    { type: 'act', act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1' },
    { type: 'act', act: 'device-name', unit: 'macbook-pro-0001', name: 'Studio Mac' },
    { type: 'act', act: 'device-name', unit: 'macbook-air-bb07', name: 'Desk Mac' },
    { type: 'act', act: 'open', what: 'home-folder' },
    { type: 'act', act: 'appearance', theme: 'system' },
    { type: 'act', act: 'appearance', theme: 'dark' },
    { type: 'act', act: 'pause', target: 'home' },
    { type: 'act', act: 'device-name', unit: 'iphone-17-pro-aa01', name: 'Phone' },
  ]);
});

test('H8: a store need\'s Allow posts `allow` of its store with its button\'s label, beside what it does', async () => {
  const win = fakeWindow({ kind: 'mac', version: 6, state: STATE }, { reply: () => ({}) });
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  const state = /** @type {any} */ ({ ...host.state, unit: 'macbook-pro-0001' });
  const allow = actOf({ do: 'grant', label: 'Allow', unit: 'macbook-pro-0001', grant: 'store:browser-a' }, null, state);
  assert.ok(allow);
  const markup = actButton(allow, AT_REST);
  /** @param {string} name */
  const attr = name => (new RegExp(`${name}="([^"]*)"`, 'u').exec(markup)?.[1] ?? '')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const doing = JSON.parse(attr('data-cn-do'));
  assert.deepEqual(doing, { host: { act: 'allow', grants: ['store:browser-a'] } }, 'the label is no part of what it does');
  assert.equal(attr('data-cn-label'), 'Allow');
  await host.act(doing.host, attr('data-cn-label'));
  assert.deepEqual(win.posted, [{ type: 'act', act: 'allow', grants: ['store:browser-a'], label: 'Allow' }]);
  await host.act({ act: 'window', do: 'drag' });
  assert.deepEqual(win.posted.at(-1), { type: 'act', act: 'window', do: 'drag' });
});

test('H9: the Command line row is read as the Mac states it, and its acts post the shapes the Mac reads', async () => {
  const general = { login: true, auto_update: false, version: '2026.11.14', update: null, by_hand: null };
  const prompt = 'Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for ___; type each lifestream command it names as ~/.local/bin/lifestream.';
  /** @param {unknown} command */
  const read = command => readHost(/** @type {any} */ (fakeWindow({ kind: 'mac', version: 6,
    state: { ...STATE, general: { ...general, command } } })))?.state.general?.command;
  assert.deepEqual(read({ state: 'installed', words: 'lifestream works in new terminal windows.', link: '~/.local/bin/lifestream', prompt, did: ['linked'] }),
    { state: 'installed', words: 'lifestream works in new terminal windows.', prompt });
  for (const bad of [null, 'installed', { state: 'linked', words: 'w', prompt }, { state: 'absent', words: '', prompt },
    { state: 'absent', words: 'Not installed.' }]) {
    assert.equal(read(bad), null, JSON.stringify(bad));
  }
  const win = fakeWindow({ kind: 'mac', version: 6, state: STATE }, { reply: () => ({}) });
  const host = /** @type {NonNullable<ReturnType<typeof readHost>>} */ (readHost(/** @type {any} */ (win)));
  for (const act of /** @type {const} */ (['install', 'remove'])) assert.deepEqual(await host.act({ act: 'general-command', do: act }), {});
  assert.deepEqual(win.posted, [{ type: 'act', act: 'general-command', do: 'install' }, { type: 'act', act: 'general-command', do: 'remove' }]);
});
