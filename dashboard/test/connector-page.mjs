import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_REPORT, MODELS } from '../public/kit-gallery-llm.js';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { AI_PAGE, detailOf, OPENED } from '../public/ui/connectors/dialog.js';
import { detailMarkup } from '../public/ui/connectors/detail.js';
import { SETTINGS_PROVIDERS } from '../public/ui/connectors/settings.js';
import { AT_REST } from '../public/ui/connectors/view.js';
import { openDoor } from '../lib/door.mjs';
import { createViewer } from '../server.mjs';
import { atExit, openChrome } from '../tools/chrome.mjs';
import { hostScript } from './stand-ins/onboarding-home.mjs';

/** @typedef {import('../public/ui/connectors/dialog.js').Detail} Detail */
/** @typedef {import('../public/types.js').StreamsReport} StreamsReport */
/** @typedef {import('../public/types.js').ConnectorReport} ConnectorReport */

/**
 * @param {StreamsReport} report
 * @param {any} state
 * @param {string} id
 * @param {Partial<import('../public/ui/connectors/dialog.js').Opened>} [opened]
 */
const open = (report, state, id, opened = {}) => /** @type {Detail} */ (detailOf(report, state, id, { ...OPENED, ...opened }));
/** @param {Detail} detail */
const labels = detail => detail.panels.map(panel => panel.label);
/**
 * @param {StreamsReport} report
 * @param {string} id
 * @param {(connector: ConnectorReport) => ConnectorReport} change
 * @returns {StreamsReport}
 */
const changing = (report, id, change) => ({ ...report, connectors: report.connectors.map(each => each.id === id ? change(each) : each) });
/** @param {StreamsReport} report */
const streamsOf = report => report.connectors.filter(each => each.shown === 'stream' || each.shown === 'home');
const ORDER = ['Comes from', 'Settings', 'AI', 'History'];

test('P1: one page, no tabs; its sections in one fixed order, an empty one left out; groups under Settings; what it reads last', () => {
  let drawn = 0;
  for (const report of [REPORT, LLM_REPORT]) {
    for (const state of [HOST_STATE, null]) {
      for (const connector of streamsOf(report)) {
        const detail = open(report, state, connector.id);
        assert.equal('tabs' in detail, false, connector.id);
        const named = labels(detail);
        assert.deepEqual(named, ORDER.filter(label => named.includes(label)), `${connector.id}: ${named.join(', ')}`);
        assert.ok(detail.panels.every(panel => panel.rows.length > 0), `${connector.id}: no empty section`);
        const markup = detailMarkup(detail, AT_REST);
        assert.ok(!markup.includes('role="tablist"') && !markup.includes('role="tabpanel"') && !markup.includes('ck-tabs__dot'), connector.id);
        const headings = [...markup.matchAll(/ck-ssection__heading">([^<]+)</gu)].map(match => match[1]);
        assert.deepEqual(headings.filter(heading => ORDER.includes(heading)), named, `${connector.id}: drawn in its order`);
        if (detail.reads && detail.panels.length) {
          assert.ok(markup.lastIndexOf('ck-ssection--card') < markup.indexOf('cn-prose--reads'), `${connector.id}: what it reads under the sections`);
          drawn += 1;
        }
      }
    }
  }
  assert.ok(drawn >= 8, 'the fixtures draw what a connector reads under its sections');
  assert.deepEqual(labels(open(LLM_REPORT, HOST_STATE, 'whatsapp')), ORDER);
  assert.deepEqual(labels(open(LLM_REPORT, HOST_STATE, 'gmail')), ['Comes from', 'Settings', 'AI']);
  assert.deepEqual(labels(open(LLM_REPORT, HOST_STATE, 'location')), ['Comes from', 'History']);
  assert.deepEqual(labels(open(LLM_REPORT, HOST_STATE, 'github')), ['Comes from', 'Settings']);
  const settings = open(LLM_REPORT, HOST_STATE, 'whatsapp').panels.find(panel => panel.label === 'Settings');
  assert.equal(settings?.rows.at(-1)?.label, 'Quiet groups', 'the groups\' rows close Settings');
  const bare = changing(REPORT, 'github', connector => ({ ...connector, members: connector.members.filter(each => each.panel !== 'settings') }));
  assert.deepEqual(labels(open(bare, HOST_STATE, 'github')), ['Comes from'], 'no setting, no Settings');
});

test('P2: History says its sentence under its heading; the week before the sections', () => {
  const about = /** @type {string} */ (LLM_REPORT.connectors.find(each => each.id === 'whatsapp')?.backfill_about);
  assert.ok(about);
  const markup = detailMarkup(open(LLM_REPORT, HOST_STATE, 'whatsapp'), AT_REST);
  const history = markup.slice(markup.indexOf('ck-ssection__heading">History<'));
  assert.ok(history.startsWith(`ck-ssection__heading">History</h3></span><p class="ck-ssection__line">${about}</p>`), 'the sentence under History');
  assert.ok(markup.indexOf('ck-week') >= 0 && markup.indexOf('ck-week') < markup.indexOf('ck-ssection__heading">Comes from<'), 'the week first');
});

test('P3: each AI row pushes its own page: the model, the hiding, a mark when it needs a model, back to the connector', () => {
  let pushed = 0;
  let needs = 0;
  for (const report of [REPORT, LLM_REPORT]) {
    for (const state of [HOST_STATE, null]) {
      for (const connector of streamsOf(report)) {
        const detail = open(report, state, connector.id);
        const ai = detail.panels.find(panel => panel.label === 'AI');
        for (const row of ai?.rows ?? []) {
          if (!row.go) continue;
          const page = /** @type {{ page: string }} */ (row.go.do).page;
          assert.ok(page.startsWith(AI_PAGE), `${connector.id} ${row.label}`);
          const inside = open(report, state, connector.id, { pages: [page] });
          assert.deepEqual([inside.name, inside.back, inside.page, inside.figure, inside.callout, inside.state],
            [row.label, { label: `Back to ${connector.name}` }, true, null, null, null], `${connector.id} ${page}`);
          assert.equal(inside.panels.length, 1);
          assert.equal(inside.panels[0].rows[0].label, 'Model');
          const shape = connector.processing?.rows.find(each => `${AI_PAGE}${each.member}` === page)?.shape;
          if (shape === 'needs') {
            assert.deepEqual(inside.panels[0].rows[0].mark, { look: 'needs-you' }, `${connector.id} ${page}: marked`);
            if (state) assert.deepEqual(inside.panels[0].rows[0].act, { open: SETTINGS_PROVIDERS }, `${connector.id} ${page}: to Providers`);
            needs += 1;
          }
          const markup = detailMarkup(inside, AT_REST);
          assert.match(markup, new RegExp(`class="ck-dialog__mark ck-dialog__back"[^>]*aria-label="Back to ${connector.name}"`, 'u'));
          assert.match(markup, /class="ck-dialog ck-dialog--page"/u);
          pushed += 1;
        }
      }
    }
  }
  assert.ok(pushed >= 12 && needs >= 4, `the fixtures push AI pages (${pushed}) and mark the ones needing a model (${needs})`);
  assert.equal(open(LLM_REPORT, HOST_STATE, 'whatsapp', { pages: [`${AI_PAGE}nothing`] }).name, 'WhatsApp', 'a page gone gives way to the connector');
  const calendar = changing(LLM_REPORT, 'google-calendar', connector => ({ ...connector, set_up: true }));
  const calendars = open(calendar, HOST_STATE, 'google-calendar', { pages: ['list:calendars'] });
  assert.deepEqual([calendars.name, calendars.back, calendars.page], ['Calendars', { label: 'Back to Google Calendar' }, true]);
});

test('P4: the callout under the head, above the body, on the connector and on a pushed form', () => {
  const gmail = detailMarkup(open(LLM_REPORT, HOST_STATE, 'gmail'), AT_REST);
  const above = gmail.slice(gmail.indexOf('ck-dialog__above'), gmail.indexOf('ck-dialog__body'));
  assert.ok(above.includes('ck-callout') && above.includes('Gmail allows more tomorrow'));
  const refused = detailMarkup(open(REPORT, HOST_STATE, 'whoop', { pages: ['form'], refused: 'The vault refused it' }), AT_REST);
  assert.ok(refused.includes('The vault refused it'), 'the refusal said on the form');
  assert.ok(!refused.includes('role="tablist"'));
});


const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.build', 'e2e', 'connector-page');
const seen = { shots: /** @type {string[]} */ ([]), thrown: /** @type {string[]} */ ([]) };

async function standInDoor() {
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  const door = { url: '', report: /** @type {StreamsReport} */ (LLM_REPORT) };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://door').pathname;
    /** @param {number} status @param {unknown} body */
    const json = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === '/v1/connectors') return json(200, { position: '1:0', ...door.report });
    if (path === '/v1/page/models/defaults' || path === '/v1/page/models/providers') return json(200, { ...MODELS, position: '1:0' });
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
  dir = await mkdtemp(join(tmpdir(), 'dashboard-connector-page-'));
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
  writeFileSync(join(OUT, 'connector-page.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`);
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
const DIALOG = `document.querySelector('[data-part="dialog"] .ck-dialog')`;
const TITLE = `${DIALOG}?.querySelector('.ck-dialog__title')?.textContent`;
const AT = `new URLSearchParams(location.hash.slice(1)).get('dialog')`;
const BOX = `(() => { const box = ${DIALOG}.getBoundingClientRect(); return [box.top, box.left, box.width, box.height, innerWidth, innerHeight].map(Math.round); })()`;
const HEAD = `(() => { const box = ${DIALOG}.querySelector('.ck-dialog__head').getBoundingClientRect(); return [box.top, box.height].map(Math.round); })()`;
const BODY = `${DIALOG}.querySelector('.ck-dialog__body')`;
const UNCUT = `[...${DIALOG}.querySelectorAll('.ck-srow__value, .ck-svalue')].filter(each => each.scrollWidth > each.clientWidth + 0.5).map(each => each.textContent)`;
/** @param {number[]} box */
const sized = ([top, left, width, height, wide, tall]) => {
  assert.equal(height, Math.min(640, tall - 80), 'the dialog 640 tall, or the window less the inset');
  assert.ok(Math.abs(top - (tall - height) / 2) <= 1 && Math.abs(left - (wide - width) / 2) <= 1, `centred: ${top},${left} in ${wide}×${tall}`);
};
let shots = 0;
/** @param {string} name */
const shot = async name => {
  shots += 1;
  const file = `${String(shots).padStart(2, '0')}-${name}`;
  await page().shoot(join(OUT, `${file}.png`));
  seen.shots.push(file);
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
/** @param {object} doing */
const DOES = doing => `[data-part="dialog"] [data-cn-do="${JSON.stringify(doing).replaceAll('"', '\\"')}"]`;
/** @returns {Promise<any[]>} */
const acts = async () => (await page().evaluate('window.hostActs.splice(0)')).map((/** @type {any} */ { type: _, ...act }) => act)
  .filter((/** @type {any} */ act) => !['ready', 'window', 'at', 'look'].includes(act.act));
const host = hostScript({ ...HOST_STATE, setup: { state: 'done', error: null } });
const READS = `performance.getEntriesByType('resource').filter(each => new URL(each.name).pathname === '/api/page/connectors').length`;
/**
 * @param {StreamsReport} report
 * @param {string} what
 */
async function serve(report, what) {
  /** @type {NonNullable<typeof home>} */ (home).door.report = report;
  const reads = await page().evaluate(READS);
  await page().evaluate(`window.dispatchEvent(new Event('focus'))`);
  await page().until(`${READS} > ${reads}`, what);
}

test('P5: one frame; ↓ walks the rows; a pushed page keeps the frame and the head, the URL holds it, ⌘[ and Esc come back to the row and its scroll', async () => {
  /** @type {NonNullable<typeof home>} */ (home).door.report = LLM_REPORT;
  await page().load('#view=connectors&dialog=whatsapp', host);
  await page().until(`${TITLE} === 'WhatsApp' && ${DIALOG}.querySelectorAll('.ck-ssection__heading').length >= 4`, 'WhatsApp, one page');
  assert.deepEqual(await page().evaluate(`[...${DIALOG}.querySelectorAll('.ck-ssection__heading')].map(each => each.textContent)`), ORDER);
  assert.equal(await page().evaluate(`${DIALOG}.querySelectorAll('[role="tab"], [role="tablist"]').length`), 0, 'no pills');
  const box = await page().evaluate(BOX);
  sized(box);
  const head = await page().evaluate(HEAD);
  assert.deepEqual(await page().evaluate(UNCUT), [], 'no value cut');
  await shot('whatsapp');

  const ROWS = `[...${DIALOG}.querySelectorAll('.ck-dialog__body :is(.ck-srow__hit, .ck-srow__end button, .ck-numbered .ck-btn)')].filter(each => !each.disabled)`;
  await page().evaluate(`document.activeElement?.blur?.()`);
  await page().key('ArrowDown');
  await page().until(`${ROWS}.indexOf(document.activeElement) === 0`, '↓ to the first row');
  await page().key('ArrowDown');
  await page().until(`${ROWS}.indexOf(document.activeElement) === 1`, '↓ to the second');
  await page().key('ArrowUp');
  await page().until(`${ROWS}.indexOf(document.activeElement) === 0`, '↑ back to the first');

  await page().size(1180, 420, 1);
  const PHOTOS = DOES({ page: `${AI_PAGE}llm.photos` });
  await page().until(`${BODY}.scrollHeight > ${BODY}.clientHeight`, 'WhatsApp taller than the window');
  await page().evaluate(`document.querySelector(${JSON.stringify(PHOTOS)}).scrollIntoView({ block: 'end' })`);
  const scrolled = await page().evaluate(`${BODY}.scrollTop`);
  assert.ok(scrolled > 0, 'scrolled down to AI');
  const shortHead = await page().evaluate(HEAD);
  await press(PHOTOS);
  await page().until(`${TITLE} === 'Photo descriptions' && ${AT} === 'whatsapp/${AI_PAGE}llm.photos'`, 'Photo descriptions pushed, the URL holds it');
  assert.deepEqual(await page().evaluate(HEAD), shortHead, 'the head never moves');
  assert.equal(await page().evaluate(`${BODY}.scrollTop`), 0, 'a pushed page starts at its top');
  assert.ok(await page().evaluate(`document.activeElement === ${DIALOG}.querySelector('.ck-dialog__back')`), 'the focus on back');
  assert.ok(await page().evaluate(`${DIALOG}.querySelector('.ck-dialog__body').textContent.includes('Model')`));
  await shot('whatsapp-photo-descriptions');
  for (const type of ['rawKeyDown', 'keyUp']) {
    await page().send('Input.dispatchKeyEvent', { type, key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, modifiers: 4 });
  }
  await page().until(`${TITLE} === 'WhatsApp' && ${AT} === 'whatsapp' && document.activeElement?.matches(${JSON.stringify(PHOTOS)})`,
    '⌘[ back on WhatsApp, the focus on the row that pushed');
  assert.equal(await page().evaluate(`${BODY}.scrollTop`), scrolled, 'its scroll kept');
  await press(PHOTOS);
  await page().until(`${TITLE} === 'Photo descriptions'`, 'pushed again');
  await page().key('Escape');
  await page().until(`${TITLE} === 'WhatsApp' && document.activeElement?.matches(${JSON.stringify(PHOTOS)})`, 'Esc back on WhatsApp');
  await page().size(1180, 860, 1);
  sized(await page().evaluate(BOX));
  assert.deepEqual(await page().evaluate(HEAD), head, 'the head where it was');
  await page().key('Escape');
  await page().until(`!${DIALOG}`, 'Esc again closes');

  await page().load(`#view=connectors&dialog=${encodeURIComponent(`whatsapp/${AI_PAGE}llm.voice`)}`, host);
  await page().until(`${TITLE} === 'Voice note transcripts' && Boolean(${DIALOG}.querySelector('.ck-dialog__back'))`, 'a URL opens the page it holds');
  assert.deepEqual(await page().evaluate(BOX), box, 'the same frame');
  assert.deepEqual(page().thrown.splice(0), []);
});

test('P6: a setting keeps the page, its place and the focus while the home answers', async () => {
  /** @type {NonNullable<typeof home>} */ (home).door.report = LLM_REPORT;
  await page().load('#view=connectors&dialog=gmail', host);
  await page().until(`${TITLE} === 'Gmail' && ${DIALOG}.querySelector('.ck-dialog__above .ck-callout')`, 'Gmail, its callout under the head');
  await shot('gmail');
  await acts();
  const MENU = '[aria-controls="ck-mb-gmail-refresh-menu"]';
  await page().evaluate(`document.querySelector('${MENU}').focus()`);
  await page().key('Enter');
  await page().until(`!document.getElementById('ck-mb-gmail-refresh-menu').hidden`, 'Check every open');
  await page().key('ArrowDown');
  await page().key('Enter');
  await page().until(`window.hostActs.some(act => act.act === 'setting')`, 'the setting sent');
  const [sent] = await acts();
  assert.deepEqual([sent.act, sent.connector, sent.member], ['setting', 'gmail', 'refresh']);
  await page().until(`document.querySelector('${MENU}').getAttribute('aria-busy') === 'true' && document.activeElement?.matches('${MENU}')`,
    'the change under way, the focus on its capsule');
  await serve(LLM_REPORT, 'a read that does not say it yet');
  assert.equal(await page().evaluate(`document.querySelector('${MENU}').getAttribute('aria-busy')`), 'true', 'still waiting across a read');
  await serve(changing(LLM_REPORT, 'gmail', connector => ({ ...connector,
    members: connector.members.map(each => each.key === 'refresh' ? { ...each, value: sent.value } : each) })), 'the change said');
  await page().until(`${TITLE} === 'Gmail' && !document.querySelector('${MENU}').hasAttribute('aria-busy') && document.activeElement?.matches('${MENU}')`,
    'the capsule free, the page and the focus kept');
  await page().key('Escape');
  await page().until(`!${DIALOG}`, 'closed');
  await page().evaluate(`location.hash = '#view=connectors&dialog=gmail'`);
  await page().until(`${TITLE} === 'Gmail' && !${DIALOG}.querySelector('.ck-dialog__back')`, 'opened again on its own page');
  assert.deepEqual(page().thrown.splice(0), []);
});
