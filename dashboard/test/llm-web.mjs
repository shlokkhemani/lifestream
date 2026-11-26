import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DESCRIBED, LLM_REPORT, LONGEST, LONGEST_VALUE, MODELS, MODELS_BARE, RANGE_STEP, SHAPED, SUBSCRIBED, TRANSCRIBED,
} from '../public/kit-gallery-llm.js';
import { HOST_STATE } from '../public/kit-gallery-report.js';
import { NOTES } from '../public/ui/connectors/settings.js';
import { AI_PAGE } from '../public/ui/connectors/dialog.js';
import { openDoor } from '../lib/door.mjs';
import { createViewer } from '../server.mjs';
import { atExit, openChrome } from '../tools/chrome.mjs';
import { hostScript } from './stand-ins/onboarding-home.mjs';
import { until } from './until.mjs';

/** @typedef {Extract<import('../public/pages.js').ModelConnection, { kind: 'runner' }>} Runner */
/** @param {import('../public/lib/model-menu.js').Models} models */
const runnersOf = models => /** @type {Runner[]} */ (models.connections.filter(each => each.kind === 'runner'));
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'llm-web');
const HASH = `sha256:${'a'.repeat(64)}`;
const SCREEN_NEEDS = /** @type {string} */ (LLM_REPORT.connectors.find(each => each.id === 'screen')?.processing?.rows
  .find(row => row.shape === 'needs')?.line);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const KEEP_INFO = `if (location.protocol === 'http:') localStorage.setItem('viewer.info', 'open');`;
const seen = { shots: /** @type {object[]} */ ([]), acts: /** @type {unknown[]} */ ([]), heights: /** @type {Record<string, number>} */ ({}),
  drawn: /** @type {Record<string, any>} */ ({}),
  thrown: /** @type {string[]} */ ([]) };

/**
 * @param {import('../public/types.js').Made} described
 * @param {string} [caption]
 */
const factsOf = (described, caption = 'A table by the window, the street lit behind it.') => ({ hash: HASH, kind: 'photograph',
  at_ms: Date.UTC(2026, 10, 9, 8, 0), zone: 'Europe/Lisbon', date: '2026-11-09', day: '2026-11-09', unit: null,
  caption: described.state === 'done' ? caption : null,
  described, people: [], size: { width: 1, height: 1 }, place: null, area: null, camera: null, from: 'phone', chat: null });

const VOICE_AT = Date.UTC(2026, 10, 9, 18, 0);
const VOICE_RECORD = { source: 'whatsapp:synthetic', kind: 'msg', key: 'v1' };
const VOICE_CHAT = 'whatsapp:chat-1';
const VOICE_UNIT = 'whatsapp:synthetic/chat-1';

/**
 * @param {string} said
 * @param {import('../public/types.js').Made} transcribed
 */
function voiceSaid(said, transcribed) {
  return { chat: VOICE_CHAT, day: '2026-11-09', zone: 'Europe/Lisbon', title: 'Person A',
    atoms: [{ n: 1, family: 'messages', unit: VOICE_UNIT, start_ms: VOICE_AT, end_ms: null, local_start: null, local_end: null,
      flags: [], record: VOICE_RECORD, block: { key: VOICE_CHAT, title: 'Person A' },
      text: `Person A: [voice note, 12 s${said ? `: "${said}"` : ''}]` }],
    messages: [{ source: VOICE_RECORD.source, key: VOICE_RECORD.key, at: VOICE_AT, from: { id: '+15550000001', kind: 'phone' },
      parts: [{ what: 'voice note', seconds: 12, transcribed }] }],
    thread: { chat: VOICE_CHAT, day: '2026-11-09', title: 'Person A', messages: [{ key: VOICE_RECORD.key, who: 'phone:+15550000001',
      name: 'Person A', text: '', at_ms: VOICE_AT, mine: false, forwarded: false, edited: false, gone: false, event: null,
      voice: { audio: null, seconds: 12, length: '0:12', transcript: said }, pictures: [], video: null, sticker: null, missing: [],
      attachments: [], link: null, location: null, quote: null, reactions: [] }] } };
}

/** @param {import('../public/types.js').Made} transcribed */
const recordOf = transcribed => ({ source: 'voice-memos:synthetic', kind: 'memo', key: 'm1', blobs: [], text: null, transcribed });

async function standInDoor() {
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  const door = { report: LLM_REPORT, models: MODELS, down: false, photo: factsOf(DESCRIBED.done),
    conversation: voiceSaid('', TRANSCRIBED.done), record: recordOf(TRANSCRIBED.done),
    holding: false, held: /** @type {(() => void)[]} */ ([]),
    release: () => {
      for (const answer of door.held.splice(0)) answer();
    },
    asked: /** @type {string[]} */ ([]), url: '', seq: 1,
    /** @param {string} day */
    tell: (day, kind = 'day') => {
      door.seq += 1;
      for (const feed of feeds) feed.write(`id: ${door.seq}\ndata: ${JSON.stringify({ seq: door.seq, kind, key: day })}\n\n`);
    },
    /** @param {string} path */
    reads: path => door.asked.filter(each => each === path).length };
  const server = createServer((request, response) => {
    const address = new URL(request.url ?? '/', 'http://door');
    const path = address.pathname;
    door.asked.push(path);
    /** @param {number} status @param {unknown} body */
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === '/v1/connectors') return json(200, { position: `${door.seq}:0`, ...door.report });
    if (path === '/v1/page/models/defaults' || path === '/v1/page/models/providers') return door.down ? json(503, { error: 'NOT_NOW', message: 'Lifestream is busy.' })
      : json(200, { ...door.models, position: `${door.seq}:0` });
    if (path === '/v1/processing/range') {
      return json(200, { position: `${door.seq}:0`, ...RANGE_STEP, value: address.searchParams.get('value') });
    }
    if (path === `/v1/photos/${HASH}`) {
      const answer = { position: `${door.seq}:0`, photo: door.photo };
      if (!door.holding) return json(200, answer);
      door.held.push(() => json(200, answer));
      return undefined;
    }
    if (path === '/v1/extracts') {
      return json(200, { position: `${door.seq}:0`, extracts: [{ family: 'messages', unit: VOICE_UNIT, reading: 'messages@1',
        content: { messages: [{ ...door.conversation.messages[0], parts: [{ what: 'voice note', seconds: 12 }] }] },
        start_ms: VOICE_AT, end_ms: null, days: ['2026-11-09'], items: [] }] });
    }
    if (path === '/v1/conversation') return json(200, { position: `${door.seq}:0`, ...door.conversation });
    if (path === '/v1/page/thread') return json(200, { position: `${door.seq}:0`, today: '2026-11-09', ...door.conversation.thread });
    if (path === '/v1/record') return json(200, { position: `${door.seq}:0`, ...door.record });
    if (path === `/v1/pictures/${HASH}`) return response.writeHead(200, { 'content-type': 'image/png' }).end(PIXEL);
    if (path === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': open\n\n');
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      return undefined;
    }
    return json(404, { error: 'not here' });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  door.url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { door, close: async () => {
    for (const feed of feeds) feed.end();
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  } };
}

let dir = '';
/** @type {import('node:http').Server | undefined} */
let viewer;
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;
/** @type {Awaited<ReturnType<typeof standInDoor>> | undefined} */
let home;
/** @type {ReturnType<typeof openDoor> | undefined} */
let client;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-llm-web-'));
  home = await standInDoor();
  client = openDoor({ url: home.door.url, token: () => 'stub-token' });
  const served = await createViewer({ door: client });
  viewer = served;
  await new Promise(done => served.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (served.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await chrome.size(1180, 860, 1);
  await chrome.theme('dark');
  await rm(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
});

function keep() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'llm-web.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`);
}
const kept = atExit(keep);

after(async () => {
  kept();
  keep();
  await chrome?.close();
  if (viewer) {
    const served = viewer;
    served.closeAllConnections();
    await new Promise(done => served.close(() => done(undefined)));
  }
  client?.close();
  await home?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const page = () => /** @type {NonNullable<typeof chrome>} */ (chrome);
const thrown = () => {
  const now = page().thrown.splice(0);
  seen.thrown.push(...now);
  return now;
};
const DIALOG = `document.querySelector('.ck-dialog')`;
/** @returns {Promise<any[]>} */
const acts = async () => {
  const posted = (await page().evaluate('window.hostActs.splice(0)')).map((/** @type {any} */ { type: _, ...act }) => act)
    .filter((/** @type {any} */ act) => !['ready', 'window', 'at', 'look'].includes(act.act));
  seen.acts.push(...posted);
  return posted;
};
const sent = async () => {
  await page().until('window.hostActs.some(act => !["ready", "window", "at", "look"].includes(act.act))', 'an act sent');
  return acts();
};
let shots = 0;
/** @param {string} name */
const shot = async name => {
  shots += 1;
  const file = `${String(shots).padStart(2, '0')}-${name}`;
  await page().shoot(join(OUT, `${file}.png`));
  seen.shots.push({ shot: file });
};
/** @param {string} selector */
async function press(selector) {
  const [x, y] = await page().evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length);
    found[0].scrollIntoView({ block: 'nearest' });
    const box = found[0].getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
  await page().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await page().send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await page().send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
/** @param {string} words */
const BUTTON = words => `[...${DIALOG}.querySelectorAll('button')].find(each => each.textContent.trim() === ${JSON.stringify(words)})`;
/** @param {string} label */
const ROW = label => `[...${DIALOG}.querySelectorAll('.ck-srow')].find(each => each.querySelector('.ck-srow__label')?.textContent.trim() === ${JSON.stringify(label)})`;
const DRAWN = `(() => { const dialog = ${DIALOG};
  const cut = [...dialog.querySelectorAll('.ck-menubtn__words')].filter(each => each.scrollWidth > Math.ceil(each.getBoundingClientRect().width))
    .map(each => each.textContent);
  const values = [...dialog.querySelectorAll('.ck-menubtn__words')].map(each => each.textContent);
  return { cut, values }; })()`;
/** @param {string} key */
const WORK = key => `[data-part="dialog"] [data-cn-do="${JSON.stringify({ page: `${AI_PAGE}${key}` }).replaceAll('"', '\\"')}"]`;
const TITLE = `${DIALOG}?.querySelector('.ck-dialog__title')?.textContent`;
/**
 * @param {string} key
 * @param {string} title
 */
const pushWork = async (key, title) => {
  await page().until(`Boolean(document.querySelector(${JSON.stringify(WORK(key))}))`, `the ${title} row`);
  await press(WORK(key));
  await page().until(`${TITLE} === ${JSON.stringify(title)} && Boolean(${DIALOG}.querySelector('.ck-dialog__back'))`, `${title} pushed`);
};
/** @param {string} title */
const backTo = async title => {
  await page().key('Escape');
  await page().until(`${TITLE} === ${JSON.stringify(title)} && !${DIALOG}.querySelector('.ck-dialog__back')`, `back on ${title}`);
};
/** @param {string} id */
const rangeOf = id => /** @type {string} */ (LLM_REPORT.connectors.find(each => each.id === id)?.members.find(member => member.key === 'llm.range')?.label);
/** @param {string} id */
const worksOf = id => (LLM_REPORT.connectors.find(each => each.id === id)?.processing?.rows ?? []).filter(row => row.shape !== null)
  .map(row => ({ key: row.member, title: /** @type {string} */ (LLM_REPORT.connectors.find(each => each.id === id)?.members
    .find(member => member.key === row.member)?.label) }));
/** @param {string} expression */
const click = expression => page().evaluate(`(${expression}).click()`);
/**
 * @param {string} id
 * @param {number} at
 */
const pick = async (id, at) => {
  const key = `ck-mb-${id.replace(/[^\w-]+/gu, '-')}`;
  await press(`[aria-controls="${key}-menu"]`);
  await page().until(`!document.getElementById('${key}-menu').hidden`, `${id} open`);
  await press(`#${key}-${at}`);
};

test('W1–W3: each connector\'s AI section in the window, each work\'s page pushed, a step and Range sent as settings, a needs line opening Providers', async () => {
  const host = hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } });
  for (const id of SHAPED) {
    await page().load(`#view=connectors&dialog=${id}`, host);
    await page().until(`Boolean(${ROW(rangeOf(id))}) && [...${DIALOG}.querySelectorAll('.ck-ssection__heading')].some(each => each.textContent === 'AI')`, id);
    const name = await page().evaluate(TITLE);
    const box = await page().evaluate(`(() => { const box = ${DIALOG}.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; })()`);
    seen.heights[id] = Math.round(box.bottom - box.top);
    assert.ok(box.top >= 0 && box.bottom <= 860, `${id}: the dialog in the 860-tall window`);
    const reached = await page().evaluate(`(() => { const range = ${ROW(rangeOf(id))}; range.scrollIntoView({ block: 'nearest' });
      const at = range.getBoundingClientRect(); const box = ${DIALOG}.getBoundingClientRect();
      return at.top >= box.top && at.bottom <= box.bottom; })()`);
    assert.ok(reached, `${id}: Range reached by the dialog's scroll`);
    const drawn = await page().evaluate(DRAWN);
    assert.deepEqual(drawn.cut, [], `${id}: every value whole`);
    seen.drawn[id] = drawn;
    await shot(`stream-${id}`);
    for (const work of worksOf(id)) {
      await pushWork(work.key, work.title);
      const inside = await page().evaluate(DRAWN);
      assert.deepEqual(inside.cut, [], `${id} ${work.title}: every value whole`);
      seen.drawn[id] = { cut: [...seen.drawn[id].cut, ...inside.cut], values: [...seen.drawn[id].values, ...inside.values] };
      await shot(`stream-${id}-${work.key.replace(/\W+/gu, '-')}`);
      await backTo(name);
    }
  }
  assert.ok(seen.heights[LONGEST] <= 860);
  assert.ok(seen.drawn.claude.values.includes(LONGEST_VALUE), 'the longest value drawn, whole');

  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  await page().load(`#view=connectors&dialog=whatsapp`, host);
  await page().until(`Boolean(${ROW(rangeOf('whatsapp'))})`);
  await acts();
  const RANGE = '[aria-controls="ck-mb-whatsapp-llm-range-menu"]';
  const PHOTOS = '[aria-controls="ck-mb-whatsapp-llm-photos-menu"]';
  await press(RANGE);
  await page().until(`!document.getElementById('ck-mb-whatsapp-llm-range-menu').hidden`, 'Range open');
  await page().evaluate(`(() => { const field = document.querySelector('#ck-mb-whatsapp-llm-range-menu input[type="date"]');
    field.value = ${JSON.stringify(RANGE_STEP.value)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const READ_BACK = `[...document.querySelectorAll('#ck-mb-whatsapp-llm-range-menu .ck-fmenu__said button')].find(each => each.textContent.trim() === ${JSON.stringify(RANGE_STEP.words)})`;
  await page().until(`Boolean(${READ_BACK}) && document.querySelector('#ck-mb-whatsapp-llm-range-menu .ck-fmenu__said').textContent.includes(${JSON.stringify(RANGE_STEP.note)})`,
    'the date\'s note');
  assert.equal(door.reads('/v1/processing/range'), 1, 'the date asked of the home once');
  assert.deepEqual(await acts(), [], 'nothing sent by the date alone');
  await shot('stream-whatsapp-date-said');
  await click(READ_BACK);
  assert.deepEqual(await sent(), [{ act: 'setting', connector: 'whatsapp', member: 'llm.range', value: RANGE_STEP.value, label: RANGE_STEP.words }]);
  await pushWork('llm.photos', 'Photo descriptions');
  await pick('whatsapp.llm.photos', 2);
  const whatsapp = /** @type {import('../public/types.js').ConnectorReport} */ (LLM_REPORT.connectors.find(each => each.id === 'whatsapp'));
  const menu = /** @type {import('../public/pages.js').ModelMenu} */ (whatsapp.members.find(each => each.key === 'llm.photos')?.menu);
  const row = /** @type {import('../public/pages.js').ModelRow} */ ([menu.default, ...menu.rows, ...menu.local?.rows ?? []][2]);
  assert.deepEqual(await sent(), [{ act: 'setting', connector: 'whatsapp', member: 'llm.photos', value: row.value }]);
  await page().until(`document.querySelector('${PHOTOS}').getAttribute('aria-busy') === 'true'`, 'Photo descriptions waits');
  await shot('stream-whatsapp-sent');
  /**
   * @param {string} key
   * @param {string} value
   * @param {string} words
   */
  const changed = (key, value, words) => ({ ...door.report, connectors: door.report.connectors.map(each => each.id !== 'whatsapp' ? each
    : { ...each, members: each.members.map(member => member.key === key ? { ...member, value, words } : member) }) });
  door.report = changed('llm.photos', row.value, row.name);
  await page().evaluate(`window.dispatchEvent(new Event('focus'))`);
  await page().until(`!document.querySelector('${PHOTOS}').hasAttribute('aria-busy')
    && document.querySelector('${PHOTOS}').textContent.includes(${JSON.stringify(row.name)})`, 'Photo descriptions said');
  await backTo('WhatsApp');
  assert.equal(await page().evaluate(`document.querySelector('${RANGE}').getAttribute('aria-busy')`), 'true', 'Range waits on its own');
  door.report = changed('llm.range', RANGE_STEP.value, '3 Mar 2024');
  await page().evaluate(`window.dispatchEvent(new Event('focus'))`);
  await page().until(`!document.querySelector('${RANGE}').hasAttribute('aria-busy')
    && document.querySelector('${RANGE}').textContent.includes('3 Mar 2024')`, 'Range said');
  door.report = LLM_REPORT;

  await page().load(`#view=connectors&dialog=screen`, host);
  await pushWork('llm.screen', 'Screen summaries');
  await page().until(`Boolean(${DIALOG}?.querySelector('.ck-srow__act'))`);
  const entries = await page().evaluate('history.length');
  await press('.ck-dialog .ck-srow__act');
  await page().until(`decodeURIComponent(location.hash).includes('dialog=settings/providers') && ${DIALOG}?.querySelector('.cn-set__title')?.textContent === 'Providers'`);
  assert.equal(await page().evaluate('history.length'), entries, 'the dialog replaced in place');
  assert.ok(await page().evaluate(`location.hash.includes('view=connectors')`), 'over the page shown');
  await shot('needs-opens-ai-models');
  assert.deepEqual(thrown(), []);
});

test('W4: Settings: every act of Default models and Providers, This Mac and Updates as typed, each held until its read says it', async () => {
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  const host = hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } });
  /**
   * @param {string} label
   * @param {string} words
   */
  const rowButton = (label, words) => `[...${ROW(label)}.querySelectorAll('button')].find(each => each.textContent.trim() === ${JSON.stringify(words)})`;
  /** @param {string} label */
  const rowLine = label => `${ROW(label)}.querySelector('.ck-srow__line')?.textContent ?? ''`;

  const UNIT = 'runner-macbook-pro-0001';
  const QWEN = runnersOf(MODELS_BARE)[0].files[0];
  /**
   * @param {'fetching' | 'ready'} state
   * @param {string} line
   * @returns {import('../public/lib/model-menu.js').Models}
   */
  const qwen = (state, line) => ({ ...MODELS_BARE, connections: MODELS_BARE.connections.map(each => each.kind !== 'runner' ? each
    : { ...each, files: each.files.map(file => file.id !== QWEN.id ? file
      : { ...file, state, line, working: state === 'fetching', words: state === 'ready' ? 'Downloaded' : null,
        acts: [state === 'ready' ? { act: /** @type {const} */ ('remove'), words: 'Remove' } : { act: /** @type {const} */ ('cancel'), words: 'Cancel' }] }) }) });
  door.models = MODELS_BARE;
  await page().load('#view=connectors&dialog=settings/providers', host);
  await page().until(`Boolean(${ROW(QWEN.name)}) && Boolean(${rowButton(QWEN.name, 'Download')})`);
  assert.equal(await page().evaluate(rowLine(QWEN.name)), QWEN.line ?? '', 'its line the home\'s');
  await acts();
  await shot('settings-first-download');
  const first = door.reads('/v1/page/models/providers');
  await click(rowButton(QWEN.name, 'Download'));
  assert.deepEqual(await sent(), [{ act: 'models', do: 'file', runner: UNIT, id: QWEN.id, to: 'fetch', label: 'Download' }]);
  await until('the models read after the act', () => door.reads('/v1/page/models/providers') > first);
  assert.equal(await page().evaluate(`${rowButton(QWEN.name, 'Download')}.getAttribute('aria-busy')`), 'true',
    'the home took it and the read still says absent: Download waits');
  const waited = door.reads('/v1/page/models/providers');
  door.models = qwen('fetching', 'Downloading · 3 min left');
  door.tell('models', 'models');
  await page().until(`Boolean(${rowButton(QWEN.name, 'Cancel')}) && !${rowButton(QWEN.name, 'Cancel')}.disabled`,
    'the file downloading, read again on the feed\'s models event');
  assert.equal(await page().evaluate(rowLine(QWEN.name)), 'Downloading · 3 min left');
  assert.equal(await page().evaluate(`Boolean(${ROW(QWEN.name)}.querySelector('.ck-srow__line .ck-shimmer'))`), true, 'the working line shimmers');
  assert.equal(door.reads('/v1/page/models/providers'), waited + 1, 'one read for one event, none on a timer');
  await shot('settings-first-download-moving');
  door.models = qwen('ready', QWEN.line);
  door.tell('models', 'models');
  await page().until(`Boolean(${rowButton(QWEN.name, 'Remove')})`, 'the file downloaded, read again on the feed\'s models event');
  await shot('settings-first-download-ready');
  assert.deepEqual(await acts(), [], 'read again with no act');
  const settled = door.reads('/v1/page/models/providers');
  door.models = { ...door.models, connections: [...door.models.connections, { kind: 'runner', id: 'runner:runner-mac-mini-bb17',
    unit: 'runner-mac-mini-bb17', place: 'Local models on Mac mini', name: 'Mac mini', line: null, none: 'No models on this machine yet.', run: null,
    files: [], found: [], battery: null, paused: false }] };
  door.tell('models', 'models');
  await until('the models read again on the feed\'s models event', () => door.reads('/v1/page/models/providers') > settled);
  await page().until(`${DIALOG}.textContent.includes('Local models on Mac mini')`, 'the runner come drawn');

  door.models = MODELS;
  await page().load('#view=connectors&dialog=settings/defaults', host);
  await page().until(`${DIALOG}.textContent.includes(${JSON.stringify(MODELS.uses[0].words)})`);
  await acts();
  await shot('settings-defaults');
  const defaults = await page().evaluate(DRAWN);
  seen.drawn.settings = defaults;
  assert.deepEqual(defaults.cut, [], 'Default models: every value whole');
  assert.ok(MODELS.uses.every(use => defaults.values.includes(use.words)), 'each use in the home’s words');
  const useOf = (/** @type {string} */ use) => /** @type {import('../public/pages.js').ModelUse} */ (MODELS.uses.find(each => each.use === use));
  await pick('settings.use.text', 1);
  assert.deepEqual(await sent(), [{ act: 'models', do: 'default', use: 'text', model: useOf('text').menu.rows[1].value }]);
  await pick('settings.use.pictures', 0);
  assert.deepEqual(await sent(), [{ act: 'models', do: 'default', use: 'pictures', model: useOf('pictures').menu.rows[0].value }]);
  const PICTURES_BUSY = `document.querySelector('[aria-controls="ck-mb-settings-use-pictures-menu"]').getAttribute('aria-busy')`;
  await page().until(`${PICTURES_BUSY} === 'true'`, 'the Photos pick waits for the read that says it');
  door.models = { ...MODELS, uses: MODELS.uses.map(use => use.use !== 'pictures' ? use : { ...use, value: useOf('pictures').menu.rows[0].value }) };
  door.tell('models', 'models');
  await page().until(`${PICTURES_BUSY} === null`, 'the Photos pick landed, read again on the feed\'s models event');
  await pick('settings.use.pictures', 4);
  assert.deepEqual(await sent(), [{ act: 'models', do: 'default', use: 'pictures', model: 'none' }], 'the home’s Off last, writing none');
  await page().load('#view=connectors&dialog=settings/providers', host);
  await page().until(`Boolean(${ROW(runnersOf(MODELS)[0].files[2].name)})`);
  await acts();
  await shot('settings-ai-models');
  const [mac, mini, imac] = runnersOf(MODELS);
  const [ready, fetching, absent] = mac.files;
  const unitOf = (/** @type {Runner} */ runner) => runner.id.slice('runner:'.length);
  await page().evaluate(`(() => { ${rowButton(absent.name, 'Download')}.click(); ${rowButton(absent.name, 'Download')}.click(); })()`);
  assert.deepEqual(await sent(), [{ act: 'models', do: 'file', runner: unitOf(mac), id: absent.id, to: 'fetch', label: 'Download' }],
    'two presses, one act');
  for (const [file, words] of /** @type {const} */ ([[fetching, 'Cancel'], [ready, 'Remove']])) {
    await click(rowButton(file.name, words));
    assert.deepEqual(await sent(), [{ act: 'models', do: 'file', runner: unitOf(mac), id: file.id, to: 'remove', label: words }], file.name);
  }
  await click(BUTTON('Try again'));
  assert.deepEqual(await sent(), [{ act: 'models', do: 'file', runner: unitOf(mini), id: mini.files[0].id, to: 'fetch', label: 'Try again' }]);
  assert.equal(await page().evaluate(`${DIALOG}.textContent.includes(${JSON.stringify(imac.line)})`), true);
  await click(rowButton('OpenRouter', 'Remove'));
  assert.deepEqual(await sent(), [{ act: 'seal', secret: 'openrouter', value: null, label: 'Remove' }]);
  await click(rowButton('http://127.0.0.1:11434/v1', 'Remove'));
  assert.deepEqual(await sent(), [{ act: 'models', do: 'address', none: true, label: 'Remove' }]);
  await click(`[...${DIALOG}.querySelectorAll('[data-flow="connect:claude"]')][0]`);
  assert.deepEqual(await sent(), [{ act: 'ask-login', do: 'start', of: 'claude' }]);
  assert.deepEqual(await page().evaluate(`[...${DIALOG}.querySelectorAll('[data-item] .ck-srow__label')].map(each => each.textContent.trim())`),
    ['ChatGPT', 'Claude'], 'the flow\'s two items, no OpenRouter');
  for (const [name, login] of /** @type {const} */ ([['mixed', SUBSCRIBED.mixed], ['signing', SUBSCRIBED.signing]])) {
    await page().evaluate(`window.setHostState(${JSON.stringify({ ...HOST_STATE, setup: { state: 'done', error: null }, ask_login: login })})`);
    await page().until(`${DIALOG}.textContent.includes(${JSON.stringify(name === 'mixed' ? 'Getting Codex to sign in, 120 of 347 MB.' : 'Enter this code on OpenAI’s page.')})`,
      `Subscriptions ${name}`);
    await page().evaluate(`${DIALOG}.querySelector('.ck-dialog__body').scrollTop = 0`);
    await shot(`settings-subscriptions-${name}`);
  }
  await page().evaluate(`window.setHostState(${JSON.stringify({ ...HOST_STATE, setup: { state: 'done', error: null } })})`);
  await page().until(`${DIALOG}.textContent.includes('Use your Claude plan.')`, 'Subscriptions as they were');
  const read = door.reads('/v1/page/models/providers');
  door.tell('models', 'models');
  await until('a models read on the feed\'s event', () => door.reads('/v1/page/models/providers') > read);
  assert.equal(await page().evaluate(`${rowButton(absent.name, 'Download')}.getAttribute('aria-busy')`), 'true', 'Download waits');
  door.models = { ...MODELS, connections: MODELS.connections.map(each => each.kind !== 'runner' || each.id !== mac.id ? each : { ...each,
    files: each.files.map(file => file.id === absent.id ? { ...file, state: /** @type {const} */ ('fetching'), words: null,
      acts: [{ act: /** @type {const} */ ('cancel'), words: 'Cancel' }] } : file) }) };
  door.tell('models', 'models');
  await page().until(`Boolean(${rowButton(absent.name, 'Cancel')}) && !${rowButton(absent.name, 'Cancel')}.disabled`,
    'the file downloading, read again on the feed\'s models event');
  assert.deepEqual(await acts(), [], 'read again with no act');
  door.down = true;
  door.tell('models', 'models');
  await page().until(`Boolean(${DIALOG}.querySelector('.ck-lack [data-cn-do]'))`, 'the failed read said');
  assert.ok(await page().evaluate(`Boolean(${ROW(absent.name)})`), 'what was shown kept');
  assert.equal(await page().evaluate(`${DIALOG}.querySelectorAll('.ck-dialog__body .ck-srow:not([data-item]) button:not(.ck-tip):not([data-ck-tip]), .ck-dialog__body .ck-srow:not([data-item]) input').length`),
    0, 'no control acting on what may have changed');
  await page().evaluate(`${DIALOG}.querySelector('.ck-dialog__body').scrollTop = 0`);
  await shot('settings-read-failed');
  door.down = false;
  door.tell('models', 'models');
  await page().until(`!${DIALOG}.querySelector('.ck-lack')`, 'read again');

  door.models = MODELS_BARE;
  await page().load('#view=connectors&dialog=settings/providers', host);
  await page().until(`Boolean(${ROW('OpenRouter')}?.querySelector('input'))`);
  await acts();
  await shot('settings-nothing-connected');
  await page().evaluate(`window.hostAnswers.seal = { refused: 'Can’t reach Lifestream.', said: 'not-sent' }`);
  await page().type('.ck-dialog .ck-srow input[type="password"]', 'sk-or-synthetic-0002');
  await page().until(`${BUTTON('Add key')} && !${BUTTON('Add key')}.disabled`);
  await page().key('Enter');
  assert.deepEqual(await sent(), [{ act: 'seal', secret: 'openrouter', value: 'sk-or-synthetic-0002', label: 'Add key' }]);
  await page().until(`${DIALOG}.querySelector('.ck-in-place')?.textContent.startsWith('Not sent')`, 'the Save said not sent');
  assert.equal(await page().evaluate(`Boolean(${DIALOG}.querySelector('.ck-in-place button'))`), false, 'a Try again that sends no key');
  await page().until(`(() => { const field = ${ROW('OpenRouter')}?.querySelector('input[type="password"]');
    return field?.value === '' && !field.disabled; })()`, 'the key field empty and ready');
  await page().evaluate('delete window.hostAnswers.seal; true');
  await page().evaluate('window.hostHolds.seal = true');
  await page().type('.ck-dialog .ck-srow input[type="password"]', 'sk-or-synthetic-0001');
  await page().until(`${BUTTON('Add key')} && !${BUTTON('Add key')}.disabled`);
  await page().key('Enter');
  assert.deepEqual(await sent(), [{ act: 'seal', secret: 'openrouter', value: 'sk-or-synthetic-0001', label: 'Add key' }]);
  await page().until(`${ROW('OpenRouter')}.querySelector('input')?.value === ''`, 'the key field emptied');
  assert.equal(await page().evaluate(`document.documentElement.outerHTML.includes('sk-or-synthetic-0001')
    || [...document.querySelectorAll('input')].some(each => each.value.includes('sk-or-synthetic-0001'))`), false,
  'the key nowhere on the page while the host has not answered');
  await page().evaluate('window.hostHolds.seal = false; window.hostRelease()');
  await page().evaluate(`window.setHostState(${JSON.stringify({ ...HOST_STATE, setup: { state: 'done', error: null }, ask_login: SUBSCRIBED.mixed })})`);
  await page().until(`${DIALOG}.textContent.includes('Getting Codex to sign in, 120 of 347 MB.')`, 'ChatGPT downloading');
  await acts();
  await click(BUTTON('Add server'));
  await page().until(`${DIALOG}.querySelector('.cn-set__back')?.textContent.trim() === 'Providers'`, 'the other server\'s page');
  assert.deepEqual(await sent(), [{ act: 'ask-login', do: 'cancel', of: 'chatgpt' }], 'the download hidden is cancelled');
  assert.equal(await page().evaluate(`${DIALOG}.querySelectorAll('[data-item] .ck-srow__label').length`), 0, 'no Subscriptions on the address page');
  assert.equal(await page().evaluate(`${DIALOG}.querySelectorAll('.cn-set__main input').length`), 1, 'its URL alone');
  await page().type('.ck-dialog input[placeholder="http://localhost:11434/v1"]', 'http://127.0.0.1:11434/v1');
  await page().until(`${BUTTON('Save')} && !${BUTTON('Save')}.disabled`);
  await shot('settings-custom-address');
  await click(BUTTON('Save'));
  assert.deepEqual(await sent(), [{ act: 'models', do: 'address', url: 'http://127.0.0.1:11434/v1', label: 'Save' }]);
  await page().until(`${DIALOG}.querySelector('.cn-set__title')?.textContent === 'Providers'`, 'back from the server\'s page');

  await page().evaluate(`window.setHostState(${JSON.stringify({ ...HOST_STATE, setup: { state: 'done', error: null }, ask_login: SUBSCRIBED.mixed })})`);
  await page().until(`${DIALOG}.textContent.includes('Getting Codex to sign in, 120 of 347 MB.')`, 'ChatGPT downloading');
  await acts();
  const entries = await page().evaluate('history.length');
  await click(`${DIALOG}.querySelector('[data-cn-set-page="mac"]')`);
  await page().until(`Boolean(${DIALOG}.querySelector('[data-cn-set-page="mac"].is-on'))`, 'This Mac');
  assert.equal(await page().evaluate('decodeURIComponent(location.hash).includes("dialog=settings/mac")'), true);
  assert.equal(await page().evaluate('history.length'), entries, 'a page of Settings in place');
  await shot('settings-this-mac');
  assert.deepEqual(await sent(), [{ act: 'ask-login', do: 'cancel', of: 'chatgpt' }], 'the download left is cancelled');
  const SWITCH = /** @param {string} label */ label => `${ROW(label)}.querySelector('[role="switch"], input[type="checkbox"], button')`;
  await page().evaluate(`(() => { ${SWITCH('Open at login')}.click(); ${SWITCH('Open at login')}.click(); })()`);
  assert.deepEqual(await sent(), [{ act: 'general-login', on: false }], 'two presses, one act');
  await click(BUTTON('Uninstall…'));
  assert.deepEqual(await sent(), [{ act: 'uninstall', label: 'Uninstall…' }]);
  await click(`${DIALOG}.querySelector('[data-cn-set-page="updates"]')`);
  await page().until(`${DIALOG}.querySelector('.cn-set__title')?.textContent === 'Updates'`);
  await click(SWITCH('Install updates automatically'));
  assert.deepEqual(await sent(), [{ act: 'general-auto-update', on: false }]);
  await click(BUTTON('Check for Updates…'));
  assert.deepEqual(await sent(), [{ act: 'general-check', label: 'Check for Updates…' }]);
  assert.deepEqual(thrown(), []);
});

test('W5: in a browser, Settings from the person\'s row: Home first, the browser\'s pages, Providers words alone, where it is done said once', async () => {
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  door.models = MODELS;
  await page().load('#view=connectors', '');
  await page().until(`Boolean(document.querySelector('#sidebar-you .ck-account__btn'))`);
  await press('#sidebar-you .ck-account__btn');
  await page().until(`document.querySelector('#ck-account-menu')?.hidden === false`, 'the person\'s menu');
  await press('#ck-account-settings');
  await page().until(`${DIALOG}?.querySelector('.cn-set__title')?.textContent === 'General'`, 'Settings at General');
  assert.deepEqual(await page().evaluate(`[...${DIALOG}.querySelectorAll('[data-cn-set-page]')].map(each => each.dataset.cnSetPage)`),
    ['home', 'storage', 'time', 'mac', 'iphone', 'chrome', 'defaults', 'providers', 'privacy', 'meaning', 'appearance', 'advanced'],
    'the Mac\'s own pages not listed; Agents is its own page, not Settings\'');
  await click(`${DIALOG}.querySelector('[data-cn-set-page="providers"]')`);
  await page().until(`Boolean(${ROW('Qwen 3.5 4B')})`);
  assert.equal(await page().evaluate(`${DIALOG}.querySelectorAll('.cn-set__main button:not(.ck-tip):not([data-ck-tip]):not(:disabled), .cn-set__main input:not(:disabled)').length`), 0,
    'no control acting in a browser: Subscriptions\' acts at rest, where they are taken their title');
  assert.equal(await page().evaluate(`${DIALOG}.textContent.split(${JSON.stringify(NOTES.browser)}).length - 1`), 1, 'where it is done, once');
  await shot('settings-browser');
  await page().load(`#view=connectors&dialog=${encodeURIComponent(`screen/${AI_PAGE}llm.screen`)}`, '');
  await page().until(`${TITLE} === 'Screen summaries' && ${DIALOG}.textContent.includes(${JSON.stringify(SCREEN_NEEDS)})`);
  assert.equal(await page().evaluate(`${DIALOG}.querySelectorAll('.ck-srow__act').length`), 0, 'the needs line is words');
  assert.deepEqual(thrown(), []);
});

test('W6: the photo viewer: Describe now says its model and where the photo goes; each act read again until the home answers', async () => {
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  const host = `${KEEP_INFO}${hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } })}`;
  const open = () => page().evaluate(`import('/ui/kit/photo-viewer.js').then(kit => kit.openPhotoViewer([${JSON.stringify(HASH)}], 0))`);
  const facts = () => door.reads(`/v1/photos/${HASH}`);
  const ASK = /** @type {NonNullable<import('../public/types.js').Made['ask']>} */ (DESCRIBED.again.ask);
  const TAKEN = { ...DESCRIBED.queued, choose: [] };
  const MADE = `document.querySelector('.ck-viewer__described .ck-made')`;
  const CAPSULE = `${MADE}.querySelector('.ck-menubtn')`;
  const NOW = `document.querySelector('button[data-ck-viewer="describe"]')`;
  const CAPTION = `document.querySelector('.ck-viewer__described').textContent`;
  const BUTTONS = `document.querySelectorAll('.ck-viewer__described button').length`;
  const close = async () => {
    await page().press('Escape');
    await page().press('Escape');
    await page().until(`!document.querySelector('.ck-viewer')`);
  };

  door.photo = factsOf(DESCRIBED.again);
  await page().load('#view=connectors', host);
  await page().until(`Boolean(document.querySelector('.sidebar'))`);
  await open();
  await page().until(`${MADE}?.textContent.includes(${JSON.stringify(DESCRIBED.again.line)})`);
  await acts();
  await shot('photo-described');
  door.photo = factsOf(TAKEN);
  door.holding = true;
  await pick(`made-${HASH}`, 0);
  assert.deepEqual(await sent(), [{ act: 'process', ...ASK, route: DESCRIBED.again.choose[0].value }]);
  await until('the facts read again, held', () => door.held.length === 1);
  door.holding = false;
  assert.equal(await page().evaluate(`${CAPSULE}?.getAttribute('aria-busy')`), 'true', 'the act waits for the read after it');
  door.photo = factsOf({ ...DESCRIBED.done, line: 'Qwen 3.5 · 10 Nov', choose: [] }, 'Two cups on a table by a window at dusk.');
  await page().evaluate(`import('/ui/live.js').then(live => { window.told = 0; live.onHomeChange(() => { window.told += 1; }); })`);
  door.tell('2026-11-09');
  await page().until('window.told >= 1', 'the change told while the read is held');
  const during = facts();
  door.release();
  await page().until(`${MADE}?.textContent.includes('Qwen 3.5 · 10 Nov')`, 'the new answer drawn');
  assert.ok(facts() > during, 'read once more after the held read');
  assert.deepEqual(await page().evaluate(`[${CAPTION}.includes('Two cups on a table'), ${CAPTION}.includes('A table by the window'),
    ${BUTTONS}]`), [true, false, 0], 'the caption and who wrote it from one read; no step offered, no control');
  await close();

  door.photo = factsOf(DESCRIBED.off);
  await page().evaluate(`localStorage.setItem('viewer.info', 'open')`);
  await open();
  await page().until(`Boolean(${NOW})`);
  const [now] = DESCRIBED.off.choose;
  assert.deepEqual(await page().evaluate(`[${NOW}.textContent.trim(),
    document.querySelector('.ck-viewer__described .ck-made__to')?.textContent]`), ['Describe now', `${now.words} · ${now.note}`]);
  await shot('photo-not-described');
  door.photo = factsOf(DESCRIBED.resting);
  await page().evaluate(`(() => { ${NOW}.click(); ${NOW}.click(); })()`);
  assert.deepEqual(await sent(), [{ act: 'process', ...ASK, route: now.value }], 'two presses, one act');
  await page().until(`${CAPTION}.includes(${JSON.stringify(DESCRIBED.resting.line)})`, 'the home\'s line drawn');
  assert.equal(await page().evaluate(BUTTONS), 0, 'waiting with no step: no control');
  await shot('photo-resting');
  const asked = facts();
  door.photo = factsOf(DESCRIBED.done);
  door.tell('2026-11-09');
  await until('the answer read', () => facts() > asked);
  await page().until(`${MADE}?.textContent.includes(${JSON.stringify(DESCRIBED.done.line)})`, 'answered');
  assert.deepEqual(await acts(), [], 'nothing sent again');
  await close();

  door.photo = factsOf(DESCRIBED.again);
  await page().load('#view=connectors', `${KEEP_INFO}`);
  await page().until(`Boolean(document.querySelector('.sidebar'))`);
  await open();
  await page().until(`${MADE}?.textContent.includes(${JSON.stringify(DESCRIBED.again.line)})`);
  assert.equal(await page().evaluate(BUTTONS), 0);
  await shot('photo-browser');
  assert.deepEqual(thrown(), []);
});

test('W7: a voice note: what transcribed it from the read the home answers, read again while the home waits on the answer', async () => {
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  const ASK = /** @type {NonNullable<import('../public/types.js').Made['ask']>} */ (TRANSCRIBED.off.ask);
  const WORDS = 'Meeting at the corner at six.';
  const OFF = { ...TRANSCRIBED.off, line: 'Voice notes from this stream aren’t transcribed' };
  const TAKEN = { ...TRANSCRIBED.queued, choose: [] };
  /** @param {'conversation' | 'voice_note'} kind */
  const open = kind => page().evaluate(`Promise.all([import('/ui/days/viewers.js'), import('/lib/api.js')]).then(([viewers, api]) => {
    document.querySelector('#voice-test')?.remove();
    const at = ${VOICE_AT};
    const chat = ${JSON.stringify(VOICE_CHAT)};
    const view = ${JSON.stringify(kind)} === 'conversation' ? { view: 'thread', chat, group: false }
      : { view: 'voice', timed: false, notes: [{ at_ms: at, words: '', seconds: 12, record: { source: 'voice-memos:synthetic', kind: 'memo', key: 'm1' } }] };
    const moment = { key: 'e1', row: 'e1', kind: ${JSON.stringify(kind)}, icon: 'voice-note', title: '', name: '', near: null, start_ms: at, end_ms: null,
      untimed: null, length_ms: null, products: [], people: [], place: null, out: null, record: null, letter: null, marks: [], pictures: [],
      source: { records: [], more: 0, units: [], atoms: 1, start_ms: at, end_ms: null }, view };
    const reads = { record: api.fetchLifeRecord, conversation: api.fetchLifeConversation,
      thread: (chat, day) => api.fetchPage('thread', { chat, day }), places: async () => ({ places: [] }), placed: async () => ({}) };
    const root = Object.assign(document.createElement('div'), { id: 'voice-test', className: 'dy-v' });
    root.style.cssText = 'position:fixed;inset:80px auto auto 300px;width:420px;padding:16px;background:var(--canvas);z-index:50';
    root.innerHTML = viewers.viewerOf(moment, {});
    document.body.append(root);
    return viewers.fillViewer(root, '2026-11-09', moment, reads, () => true, {});
  })`);
  const VOICE = `document.querySelector('#voice-test')`;
  const NOW = `${VOICE}.querySelector('button[data-ck-transcribe]')`;
  const CAPSULE = `${VOICE}.querySelector('.ck-made .ck-menubtn')`;
  const BUTTONS = `${VOICE}.querySelectorAll('.ck-made button').length`;
  const host = hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } });
  /**
   * @param {string} path
   * @param {string} name
   */
  const toldAndRead = async (path, name) => {
    const was = door.reads(path);
    door.tell('2026-11-09');
    await until(name, () => door.reads(path) > was);
  };

  door.conversation = voiceSaid('', OFF);
  await page().load('#view=connectors', host);
  await page().until(`Boolean(document.querySelector('.sidebar'))`);
  await open('conversation');
  await page().until(`Boolean(${NOW})`, 'Transcribe now');
  const [now] = OFF.choose;
  assert.deepEqual(await page().evaluate(`[${NOW}.textContent.trim(), ${VOICE}.querySelector('.ck-made__to')?.textContent,
    ${VOICE}.textContent.includes(${JSON.stringify(OFF.line)}), ${VOICE}.textContent.includes('Not transcribed yet.')]`),
  ['Transcribe now', `${now.words} · ${now.note}`, true, false]);
  assert.ok(door.reads('/v1/conversation') >= 1, 'the conversation read');
  await acts();
  await shot('voice-not-transcribed');
  door.conversation = voiceSaid('', TAKEN);
  await page().evaluate(`(() => { ${NOW}.click(); ${NOW}.click(); })()`);
  assert.deepEqual(await sent(), [{ act: 'process', ...ASK, route: now.value }], 'two presses, one act');
  await page().until(`${VOICE}.textContent.includes(${JSON.stringify(TAKEN.line)})`, 'waiting drawn');
  assert.equal(await page().evaluate(BUTTONS), 0, 'waiting with no step: no control');
  await shot('voice-waiting');
  door.conversation = voiceSaid(WORDS, TRANSCRIBED.again);
  await toldAndRead('/v1/conversation', 'the conversation read again as the feed tells');
  await page().until(`${VOICE}.querySelector('.ck-made')?.textContent.includes(${JSON.stringify(TRANSCRIBED.again.line)})`, 'transcribed');
  assert.deepEqual(await page().evaluate(`[${VOICE}.textContent.includes(${JSON.stringify(WORDS)}), ${CAPSULE}.hasAttribute('aria-busy')]`),
    [true, false], 'the words and who made them from one read');
  await shot('voice-transcribed');
  door.conversation = voiceSaid(WORDS, TRANSCRIBED.resting);
  await pick(`made-${ASK.item}`, 0);
  assert.deepEqual(await sent(), [{ act: 'process', ...ASK, route: TRANSCRIBED.again.choose[0].value }]);
  await page().until(`${VOICE}.textContent.includes(${JSON.stringify(TRANSCRIBED.resting.line)})`, 'resting drawn');
  assert.equal(await page().evaluate(BUTTONS), 0, 'resting: no control');
  await toldAndRead('/v1/conversation', 'read again while the home waits');

  door.record = recordOf(OFF);
  await page().load('#view=connectors', host);
  await page().until(`Boolean(document.querySelector('.sidebar'))`);
  await open('voice_note');
  await page().until(`Boolean(${NOW})`, 'the recording\'s Transcribe now');
  assert.ok(door.reads('/v1/record') >= 1, 'the record read');
  await acts();
  door.record = recordOf(TAKEN);
  await click(NOW);
  assert.deepEqual(await sent(), [{ act: 'process', ...ASK, route: now.value }]);
  await page().until(`${VOICE}.textContent.includes(${JSON.stringify(TAKEN.line)})`, 'the recording waiting drawn');
  door.record = recordOf(TRANSCRIBED.done);
  await toldAndRead('/v1/record', 'the record read again as the feed tells');
  await page().until(`${VOICE}.querySelector('.ck-made')?.textContent.includes(${JSON.stringify(TRANSCRIBED.done.line)})`,
    'the recording transcribed');
  await shot('voice-recording-transcribed');

  door.conversation = voiceSaid(WORDS, TRANSCRIBED.again);
  await page().load('#view=connectors', '');
  await page().until(`Boolean(document.querySelector('.sidebar'))`);
  await open('conversation');
  await page().until(`Boolean(${VOICE}?.querySelector('.ck-made'))`);
  assert.equal(await page().evaluate(BUTTONS), 0);
  assert.deepEqual(thrown(), []);
});

test('W9: the kit gallery\'s LLM processing groups drawn whole, each shot', async () => {
  const GROUPS = /** @type {const} */ ([
    ['Streams · LLM processing', ['Photo descriptions', 'Voice note transcripts', 'Email summaries', 'Chat summaries',
      'Screen summaries', SCREEN_NEEDS, 'AI', 'History']],
    ['Settings · Default models and Providers', ['Qwen 3.5 4B', 'Parakeet', 'Nemotron Speech', runnersOf(MODELS)[2].none ?? '',
      'Your models couldn’t be read.', 'Other server', 'Thinking']],
    ['Made · ', [TRANSCRIBED.again.line, 'Transcribe now', `${TRANSCRIBED.queued.choose[0].words} · ${TRANSCRIBED.queued.choose[0].note}`,
      TRANSCRIBED.resting.line ?? '']],
  ]);
  await page().size(1440, 1000, 1);
  await page().load(`kit-gallery.html#group=${encodeURIComponent('Streams · LLM processing')}&group=${encodeURIComponent('Settings · Default models and Providers')}&group=${encodeURIComponent('Made · ')}`, '');
  const names = JSON.stringify(GROUPS.map(([name]) => name));
  const named = `[...document.querySelectorAll('.gallery__group')].filter(group => ${names}
    .some(name => group.querySelector('.ck-section__label')?.textContent.startsWith(name)))`;
  await page().until(`${named}.length === ${GROUPS.length}`);
  await page().evaluate(`(() => { const kept = ${named}; for (const group of document.querySelectorAll('.gallery__group'))
    if (!kept.includes(group)) group.remove(); })()`);
  for (const [at, [name, words]] of GROUPS.entries()) {
    const drawn = await page().evaluate(`(() => { const group = ${named}[${at}];
      return { specimens: group.querySelectorAll('.gallery__specimen, .gallery__dialog, .gallery__window').length, text: group.textContent,
        made: group.querySelectorAll('.ck-made').length }; })()`);
    assert.ok(drawn.specimens > 0, `${name}: its specimens`);
    for (const each of words) assert.ok(drawn.text.includes(each), `${name}: ${each}`);
    if (name === 'Made · ') assert.equal(drawn.made, 5, 'each Made specimen drawn');
    const box = await page().evaluate(`(() => { const each = ${named}[${at}]; each.scrollIntoView(); const box = each.getBoundingClientRect();
      return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height }; })()`);
    const picture = await page().send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: true, clip: { ...box, scale: 1 } });
    shots += 1;
    const file = `${String(shots).padStart(2, '0')}-gallery-${name.toLowerCase().replace(/[^a-z]+/gu, '-').replace(/-$/u, '')}`;
    await writeFile(join(OUT, `${file}.png`), Buffer.from(picture.data, 'base64'));
    seen.shots.push({ shot: file });
  }
  await page().size(1180, 860, 1);
  assert.deepEqual(thrown(), []);
});

test('W10: two Returns in a field send its act once: the second reaches the act under way and does nothing', async () => {
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  door.report = LLM_REPORT;
  const OTHER = /** @type {import('../public/types.js').DeviceRow} */ (LLM_REPORT.devices
    .find(each => each.kind === 'mac' && each.unit !== HOST_STATE.unit));
  const FIELD = '.ck-dialog .cn-set__page input[data-cn-field="mac.name"]';
  await page().load(`#view=connectors&dialog=settings/mac/${OTHER.unit}`, hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } }));
  await page().until(`Boolean(${DIALOG}?.querySelector('[data-set-at="${OTHER.unit}"] button'))`, `${OTHER.name}'s part`);
  await click(`${DIALOG}.querySelector('[data-set-at="${OTHER.unit}"]').querySelector('button')`);
  await page().until(`Boolean(document.querySelector(${JSON.stringify(FIELD)}))`, 'the Rename… page');
  await acts();
  await page().evaluate(`window.hostHolds['device-name'] = true`);
  await page().type(FIELD, 'Desk Mac');
  await page().until(`document.querySelector(${JSON.stringify(FIELD)}).value === 'Desk Mac' && ${BUTTON('Save')} && !${BUTTON('Save')}.disabled`);
  await page().key('Enter');
  await page().until(`window.hostActs.some(act => act.act === 'device-name')
    && document.activeElement?.matches(${JSON.stringify(`${FIELD}:not(:disabled)`)})
    && document.activeElement.value === 'Desk Mac'`, 'the first Return sent, the field still focused, holding the name');
  await page().key('Enter');
  assert.deepEqual(await sent(), [{ act: 'device-name', unit: OTHER.unit, name: 'Desk Mac', label: 'Save' }]);
  await page().evaluate('window.hostHolds[\'device-name\'] = false; window.hostRelease()');
  await page().until(`!document.querySelector(${JSON.stringify(FIELD)})`, 'answered, back on Macs');
  assert.deepEqual(await acts(), [], 'one act for two Returns');
  assert.deepEqual(thrown(), []);
});

test('W11: Settings in the window: an id nothing answers closes, a part named scrolled to once the report lands, a refusal on its page, Recovery key opens the app\'s window', async () => {
  const { door } = /** @type {NonNullable<typeof home>} */ (home);
  door.report = LLM_REPORT;
  const shown = { ...HOST_STATE, setup: { state: 'done', error: null } };
  for (const old of ['settings/general', 'home']) {
    await page().load(`#view=connectors&dialog=${old}`, hostScript(shown));
    await page().until(`!new URLSearchParams(location.hash.slice(1)).has('dialog') && !document.querySelector('.ck-dialog')`,
      `${old} closed`);
  }
  assert.deepEqual(await page().evaluate('window.hostThemes.map(({ act, theme }) => ({ act, theme }))'), [{ act: 'appearance', theme: 'system' }]);
  const OTHER = /** @type {import('../public/types.js').DeviceRow} */ (LLM_REPORT.devices
    .find(each => each.kind === 'mac' && each.unit !== HOST_STATE.unit));
  await page().load(`#view=connectors&dialog=settings/mac/${OTHER.unit}`, hostScript(shown));
  const PLACED = `(() => { const main = document.querySelector('.cn-set__main');
    const part = main?.querySelector('[data-set-at="${OTHER.unit}"]');
    if (!main || !part) return false;
    const box = part.getBoundingClientRect(), view = main.getBoundingClientRect();
    const end = main.scrollTop + main.clientHeight >= main.scrollHeight - 1;
    return main.scrollTop > 0 && box.top >= view.top - 1 && (box.top < view.top + 120 || end); })()`;
  await page().until(PLACED, `${OTHER.name}'s part scrolled to the page's top, or as near as the page goes`);
  await shot('settings-macs-other');
  await page().evaluate(`window.hostReplies['device-name'] = 'Lifestream renames only a Mac it holds.'`);
  await click(`${DIALOG}.querySelector('[data-set-at="${OTHER.unit}"]').querySelector('button')`);
  await page().until(`${DIALOG}.querySelector('.cn-set__back')?.textContent.trim() === 'This Mac'`, 'the Rename… page');
  assert.equal(await page().evaluate(`${DIALOG}.querySelector('.cn-set__page input').value`), OTHER.name, 'it starts from the name');
  await page().type('.ck-dialog .cn-set__page input', 'Desk Mac');
  await page().until(`${BUTTON('Save')} && !${BUTTON('Save')}.disabled`);
  await acts();
  await click(BUTTON('Save'));
  assert.deepEqual(await sent(), [{ act: 'device-name', unit: OTHER.unit, name: 'Desk Mac', label: 'Save' }]);
  await page().until(`(() => { const line = document.querySelector('.cn-set__page > [data-layer-said]');
    const view = document.querySelector('.cn-set__main').getBoundingClientRect();
    return Boolean(line?.textContent.includes('renames only a Mac')) && line.getBoundingClientRect().top >= view.top - 1; })()`,
  'the refusal on the page, in view');
  await shot('settings-rename-refused');
  await page().evaluate('window.hostReplies = {}');
  await page().load('#view=connectors&dialog=settings/recovery', hostScript({ ...shown, vault: { state: 'unsaved', saved_ms: null } }));
  await page().until(`Boolean(${BUTTON('Show a new key…')})`, 'Recovery key');
  await acts();
  await click(BUTTON('Show a new key…'));
  assert.deepEqual((await sent()).map(({ act, do: does }) => ({ act, do: does })), [{ act: 'vault', do: 'open' }]);
  assert.equal(await page().evaluate('decodeURIComponent(location.hash).includes("dialog=settings/recovery") && !location.hash.includes("flow=")'),
    true, 'Show a new key… opened a flow in the page instead of the app\'s window');
  assert.doesNotMatch(await page().evaluate(`${DIALOG}.textContent`), /Save as file|I’ve saved it/u, 'the key shown in the page');
  assert.deepEqual(thrown(), []);
});
