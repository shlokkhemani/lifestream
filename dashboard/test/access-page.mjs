// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';
import { openChrome } from '../tools/chrome.mjs';
import { HOST_STATE, REPORT } from '../public/kit-gallery-report.js';
import { STORAGE_YEAR } from '../public/kit-gallery-settings.js';
import { SETTINGS } from '../public/ui/connectors/settings.js';
import { hostScript } from './stand-ins/onboarding-home.mjs';
import { until } from './until.mjs';

/** @typedef {{ route: string, request: any, status: number, answer: any }} Contract */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '.build', 'e2e', 'access-page');
const FIXTURES = resolve(HERE, '..', '..', 'homelink', 'Tests', 'Fixtures');
/**
 * @param {string} folder
 * @returns {Record<string, any>}
 */
const filesOf = folder => Object.fromEntries(readdirSync(join(FIXTURES, folder)).filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(join(FIXTURES, folder, name), 'utf8'))]));
/** @type {Record<string, Contract>} */
const FILES = filesOf('agents/door');
const HOST = filesOf('agents-host');
const STATE = { ...HOST_STATE, setup: { state: 'done', error: null } };
const READER = FILES['reader-agent'].answer;
const BUSY = 'p-0000aa01';
/**
 * @param {unknown} value
 * @returns {unknown}
 */
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, each]) => [key, sorted(each)])) : value;

const seen = { shots: /** @type {string[]} */ ([]), acts: /** @type {unknown[]} */ ([]), door: /** @type {unknown[]} */ ([]) };
let askRead = 'ask-open';
let dir = '';
/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {Awaited<ReturnType<typeof openChrome>> | undefined} */
let chrome;

/**
 * @param {string} method
 * @param {URL} url
 * @param {any} body
 * @returns {Contract | null}
 */
function answerOf(method, url, body) {
  const path = url.pathname;
  if (method === 'GET' && path === '/v1/agents') return FILES.list;
  if (method === 'GET' && path === '/v1/agents/ask') return FILES['reader-chat'];
  if (method === 'GET' && path === `/v1/agents/${BUSY}`) {
    return { ...FILES['reader-reads'], answer: { ...FILES['reader-reads'].answer, id: BUSY, ask: FILES['reader-ask'].answer.ask } };
  }
  if (method === 'GET' && /^\/v1\/agents\/p-[0-9a-f]{8}$/u.test(path)) return FILES['reader-agent'];
  if (method === 'GET' && path.endsWith('/history')) return url.searchParams.has('before') ? FILES['history-earlier'] : FILES.history;
  if (method === 'GET' && path.startsWith('/v1/agents/asks/')) return FILES[askRead];
  if (method === 'POST' && path === '/v1/agents/edit') {
    return Object.entries(FILES).find(([name, each]) => name.startsWith('edit-')
      && JSON.stringify(sorted(each.request)) === JSON.stringify(sorted(body)))?.[1] ?? null;
  }
  if (method === 'POST' && /^\/v1\/agents\/p-[0-9a-f]{8}\/access$/u.test(path)) {
    return { route: '', request: body, status: 200, answer: { access: body.access, expect: body.expect + 1,
      view: FILES['edit-hide'].answer.view } };
  }
  return null;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-access-page-'));
  const door = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const url = new URL(request.url ?? '/', 'http://door');
    const body = text ? JSON.parse(text) : null;
    if (url.pathname === '/v1/page/storage') return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(STORAGE_YEAR));
    if (url.pathname === '/v1/connectors') return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ position: '1:0', ...REPORT }));
    const contract = url.pathname.startsWith('/v1/agents') ? answerOf(request.method ?? '', url, body) : null;
    if (url.pathname.startsWith('/v1/agents')) seen.door.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
    if (!contract) return void response.writeHead(404, { 'content-type': 'application/json' }).end('{"code":"NOT_FOUND"}');
    response.writeHead(contract.status, { 'content-type': 'application/json' }).end(JSON.stringify(contract.answer));
  });
  servers.push(door);
  await new Promise(done => door.listen(0, '127.0.0.1', () => done(undefined)));
  const doorUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (door.address()).port}`;
  const viewer = await createViewer({ door: openDoor({ url: doorUrl, token: () => 'stand-in-token' }) });
  servers.push(viewer);
  await new Promise(done => viewer.listen(0, '127.0.0.1', () => done(undefined)));
  const origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (viewer.address()).port}`;
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin });
  await chrome.size(1180, 860, 1);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'access-page.json'), `${JSON.stringify({ ...seen, waiting: chrome?.waiting ?? '' }, null, 2)}\n`)
    .catch(() => undefined);
  await chrome?.close();
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('P1–P6 in the window: an ask’s card, its answer once, a lost reply read again, the Agents page, an agent and its Access', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  /** @returns {Promise<any[]>} */
  const acts = async () => {
    const posted = await page.evaluate('window.hostActs.splice(0)');
    seen.acts.push(...posted);
    return posted.map((/** @type {any} */ { type: _, ...act }) => act);
  };
  /** @param {string} selector @returns {Promise<string[]>} */
  const text = selector => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .map(each => each.textContent.trim().replace(/\\s+/g, ' '))`);
  /** @param {string} selector */
  const click = selector => page.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length); found[0].click(); })()`);
  /** @param {string} name */
  const shot = async name => {
    await page.shoot(join(OUT, `${name}.png`));
    seen.shots.push(name);
  };
  /**
   * @param {string} id
   * @param {string} answer
   */
  const pick = (id, answer) => `#agent-layer [data-agent-pick='${JSON.stringify({ id, answer })}']`;
  /** @param {unknown} does */
  const control = does => `[data-cn-do='${JSON.stringify(does)}']`;
  const doorAsked = () => /** @type {any[]} */ (seen.door.splice(0)).map(each => ({ ...each }));
  for (const name of ['waiting', 'waiting-sign-in', 'answer-sign-in']) assert.ok(FILES[name], `the door's ${name}.json`);
  const ASKS = FILES.waiting.answer.asks;
  const [chatAsk, claude, calendar] = ASKS;
  const CARD = `document.querySelector('#agent-layer .ck-agent')`;
  const ANSWERS = '#agent-layer .ck-agent__answers .ck-btn__label';
  /** @param {any} ask */
  const pageOrder = ask => [...ask.choices].sort((one, two) => (one.answer === 'no' ? 0 : one.answer === ask.default ? 2 : 1)
    - (two.answer === 'no' ? 0 : two.answer === ask.default ? 2 : 1)).map(each => each.words);
  /** @param {string} which */
  const leftWords = async which => {
    await page.until(`document.querySelector('#agent-layer [data-agent-ok]') !== null
      && document.querySelector('#agent-layer')?.textContent.includes(${JSON.stringify(FILES['ask-unknown'].answer.message)})`, `${which}: the home’s words before the next card`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#agent-layer [data-agent-pick]').length`), 0, `${which}: no next card yet`);
    await click('#agent-layer [data-agent-ok]');
  };

  await page.load('#view=connectors', hostScript({ ...STATE, agent_asks: ASKS }));
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(claude.head)})`, 'the first agent’s ask');
  assert.ok(!(await text('#agent-layer')).join(' ').includes(chatAsk.head), 'Chat’s ask is not over the window');
  assert.deepEqual(await text(ANSWERS), pageOrder(claude), 'the ask page’s order');
  assert.deepEqual(await text('#agent-layer .ck-said'), [claude.today.map((/** @type {any} */ run) => run.text).join('')], 'today, as the ask page says it');
  assert.deepEqual(await text('#agent-layer .ck-agent__count'), [`1 of ${ASKS.length - 1} asks`]);
  assert.equal(await page.evaluate(`[...document.querySelectorAll('#agent-layer [data-agent-change]')].map(each => each.textContent.trim()).join()`),
    'Review', 'Review opens the whole ask');
  await shot('ask-card');

  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(HOST['answer-once'].reply)};
    window.hostHolds['agent-answer'] = true`);
  await click(pick(claude.id, claude.default));
  await page.until(`[...document.querySelectorAll('#agent-layer button')].every(button => button.disabled)`, 'the card held');
  await click(pick(claude.id, 'no')).catch(() => undefined);
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: claude.id, answer: claude.default, expect: claude.version }]);
  await shot('ask-card-busy');
  await page.evaluate(`window.hostHolds = {}; window.hostRelease()`);
  await page.until(`document.querySelectorAll('#agent-layer .ck-agent__answers button').length === 0`, 'no button once answered');
  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_asks: [chatAsk, calendar] })})`);
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(calendar.head)})`, 'the next ask');
  await shot('ask-card-next');

  const stale = HOST['answer-stale'].reply.refused;
  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(HOST['answer-stale'].reply)}`);
  doorAsked();
  await click(pick(calendar.id, calendar.default));
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(stale.message)})
    && document.querySelectorAll('#agent-layer .ck-agent__answers button').length > 0`, 'the door’s words, then the buttons again');
  assert.deepEqual(doorAsked().map(each => each.path), [`/v1/agents/asks/${calendar.id}`]);
  await shot('ask-card-refused');
  askRead = 'ask-unknown';
  await click(pick(calendar.id, calendar.default));
  await page.until(`document.querySelector('#agent-layer')?.textContent.includes(${JSON.stringify(FILES['ask-unknown'].answer.message)})`, 'the ask read as gone, in the home’s words');
  assert.equal(await page.evaluate(`document.querySelectorAll('#agent-layer [data-agent-pick]').length`), 0);
  await shot('ask-gone');
  await acts();

  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_asks: [] })})`);
  await page.evaluate(`document.querySelector('#agent-layer [data-agent-ok]')?.click()`);
  await page.until(`document.querySelector('#agent-layer')?.hidden === true`, 'no card');

  const erased = FILES['ask-erased'].answer;
  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_asks: [erased] })})`);
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(erased.head)})`, 'the erased ask');
  assert.deepEqual(await text(ANSWERS), erased.choices.map((/** @type {any} */ each) => each.words));
  assert.equal(await page.evaluate(`[...document.querySelectorAll('#agent-layer button')].some(each => each.textContent.trim() === 'Edit')`),
    false, 'no Edit');
  await shot('ask-erased');
  const refusedErased = HOST['answer-erased'].reply.refused;
  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify(HOST['answer-erased'].reply)};
    window.setHostState(${JSON.stringify({ ...STATE, agent_asks: [calendar] })})`);
  await leftWords('the erased ask, gone unanswered here');
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(calendar.head)})`, 'an ask to allow');
  await click(pick(calendar.id, calendar.default));
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(refusedErased.message)})`, 'the door’s words of an erased want');
  assert.deepEqual(await text(ANSWERS), calendar.choices.filter((/** @type {any} */ each) => each.answer === 'no')
    .map((/** @type {any} */ each) => each.words));
  assert.equal(await page.evaluate(`[...document.querySelectorAll('#agent-layer button')].some(each => each.textContent.trim() === 'Edit')`),
    false, 'no Edit');
  await shot('ask-erased-refused');
  await acts();

  const signIn = FILES['waiting-sign-in'].answer.requests[0];
  const approved = FILES['answer-sign-in'].answer;
  await page.evaluate(`window.hostAnswers['agent-answer'] = ${JSON.stringify({ answer: approved })};
    window.setHostState(${JSON.stringify({ ...STATE, agent_requests: [signIn], agent_asks: [] })})`);
  await leftWords('the calendar ask, gone unanswered here');
  const signInView = signIn.view;
  const signInReads = signInView.reads;
  await page.until(`${CARD}?.textContent.includes(${JSON.stringify(signInReads)})
    && ${CARD}?.textContent.includes(${JSON.stringify(signInView.window.words)})`, 'the sign-in, its rows the home’s own view for it');
  await click(pick(signIn.id, signIn.choices[1]));
  await page.until('window.hostActs.length > 0', 'the sign-in’s answer sent');
  await page.evaluate(`window.setHostState(${JSON.stringify({ ...STATE, agent_requests: [], agent_asks: [] })})`);
  const outcome = approved.outcome?.find(part => part.kind === 'words')?.words ?? '';
  if (outcome) {
    await page.until(`${CARD}?.textContent.includes(${JSON.stringify(outcome)})`, 'the home’s outcome');
    await shot('sign-in-outcome');
    await click('#agent-layer [data-agent-ok]');
  }
  await page.until(`document.querySelector('#agent-layer')?.hidden === true`, outcome ? 'no card' : 'no words of the page’s own');
  assert.deepEqual(await acts(), [{ act: 'agent-answer', id: signIn.id, answer: signIn.choices[1] }]);
  await page.evaluate(`window.hostAnswers = {}`);

  doorAsked();
  await page.evaluate(`window.location.hash = '#view=agents'`);
  const names = FILES.list.answer.readers.map((/** @type {any} */ each) => each.name);
  await page.until(`(() => { const text = document.querySelector('[data-part="body"][data-tour="agents"] .ck-clines')?.textContent ?? '';
    return ${JSON.stringify(names)}.every(name => text.includes(name)); })()`, 'every reader listed on the Agents page');
  await shot('agents-page');
  const dialogOf = `agent%3A${READER.id}`;
  await page.evaluate(`window.location.hash = '#view=agents&dialog=${dialogOf}'`);
  const FAR = '.ck-dialog .ck-srow--menu .ck-fmenu__btn[aria-label^="How far back:"]';
  const HIDES = '.ck-dialog .ck-srow--menu .ck-fmenu__btn[aria-label^="Hides:"]';
  await page.until(`document.querySelector(${JSON.stringify(FAR)})?.textContent.includes(${JSON.stringify(READER.view.window.words)})
    && Boolean(document.querySelector(${JSON.stringify(HIDES)}))`, 'the agent: How far back and Hides on their rows');
  const read = doorAsked().map(each => each.path);
  assert.ok(read.includes(`/v1/agents/${READER.id}`) && read.includes(`/v1/agents/${READER.id}/history`), read.join(', '));
  await shot('agent-dialog');

  /** @param {string} capsule */
  const openMenu = async capsule => {
    await page.until(`document.querySelector('.ck-dialog')?.getAnimations().length === 0`, 'the dialog settled, its menus fixed to the window');
    await page.evaluate(`(() => {
      const capsule = document.querySelector(${JSON.stringify(capsule)});
      const was = capsule.getBoundingClientRect().top;
      window.capsuleScrolled = false;
      const heard = () => { window.capsuleScrolled = true; };
      document.addEventListener('scroll', heard, { capture: true, once: true });
      capsule.scrollIntoView({ block: 'center', behavior: 'instant' });
      if (capsule.getBoundingClientRect().top !== was) return;
      document.removeEventListener('scroll', heard, { capture: true });
      window.capsuleScrolled = true;
    })()`);
    await page.until('window.capsuleScrolled === true', `the scroll to ${capsule} heard`);
    await click(capsule);
  };
  const OPEN = '.ck-dialog .ck-fmenu__panel:not([hidden])';
  const times = READER.view.times.map((/** @type {any} */ each) => each.words);
  await openMenu(FAR);
  await page.until(`document.querySelector(${JSON.stringify(OPEN)}) !== null`, 'How far back open');
  assert.deepEqual(await text(`${OPEN} .ck-fmenu__item .ck-flist__label`), times);
  assert.ok(await page.evaluate(`(() => { const menu = document.querySelector(${JSON.stringify(OPEN)}).getBoundingClientRect();
    const frame = document.querySelector('.ck-dialog').getBoundingClientRect();
    return menu.left >= frame.left && menu.right <= frame.right && menu.width <= 320; })()`), 'the menu inside the dialog');
  await shot('time-menu');
  await click(FAR);
  await page.until(`document.querySelector(${JSON.stringify(OPEN)}) === null`, 'How far back closed');
  await openMenu(HIDES);
  await page.until(`document.querySelector(${JSON.stringify(OPEN)}) !== null`, 'Hides open');
  assert.deepEqual(await text(`${OPEN} .ck-fmenu__item .ck-flist__label`),
    READER.view.hide.choices.map((/** @type {any} */ each) => each.words));
  assert.deepEqual(await text(`${OPEN} .ck-fmenu__item .ck-flist__note`),
    READER.view.hide.choices.filter((/** @type {any} */ each) => each.line).map((/** @type {any} */ each) => each.line), 'each choice says what it does');
  await shot('hides-menu');
  await click(HIDES);
  await page.until(`document.querySelector(${JSON.stringify(OPEN)}) === null`, 'Hides closed');

  doorAsked();
  const month = FILES['edit-window'];
  const monthWords = READER.view.times.find((/** @type {any} */ each) => each.window?.past_ms === month.request.edit.window.past_ms).words;
  await openMenu(FAR);
  await page.until(`document.querySelector(${JSON.stringify(OPEN)}) !== null`, 'How far back open again');
  await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${OPEN} .ck-fmenu__item`)})]
    .find(each => each.querySelector('.ck-flist__label')?.textContent.trim() === ${JSON.stringify(monthWords)}).click()`);
  const saved = month.answer;
  const savedWords = saved.narrowed.words.map((/** @type {any} */ run) => run.text).join('');
  await page.until(`document.querySelector('.ck-dialog [data-cn-do]:disabled') === null
    && (document.querySelector('.ck-dialog .ck-afoot__said')?.textContent ?? '').includes(${JSON.stringify(savedWords)})`,
    'the narrowing saved by its edit, its words in the foot of the agent’s page');
  assert.deepEqual(await text('.ck-dialog .ck-afoot__said b'), saved.narrowed.words.filter((/** @type {any} */ run) => run.bold)
    .map((/** @type {any} */ run) => run.text), 'its bold parts bold');
  const narrowed = doorAsked();
  assert.deepEqual(narrowed.map(each => [each.method, each.path]), [['POST', '/v1/agents/edit']], 'saved by its edit, nothing sent again');
  assert.deepEqual(sorted(narrowed[0].body), sorted(month.request));
  assert.equal(await page.evaluate(`document.querySelector('.ck-dialog .ck-afoot [data-cn-do*="save"]')`), null, 'a narrowing waits for nothing');
  assert.deepEqual(await text('.ck-dialog .ck-afoot [data-cn-keys="⌘Z"] .ck-btn__label'), ['Undo']);
  await shot('agent-narrowed');
  await page.evaluate(`window.hostAnswers['agent-access'] = ${JSON.stringify(HOST['access-widened'].reply)}`);
  await acts();
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }))`);
  await page.until('window.hostActs.length > 0', 'Undo, by ⌘Z, through the host');
  assert.deepEqual(await acts(), [{ act: 'agent-access', id: READER.id, ...saved.narrowed.undo }]);
  await page.until(`document.querySelector('.ck-dialog [data-cn-keys]') === null`, 'undone: no Undo');
  await page.evaluate(`window.hostAnswers = {}`);
  await page.evaluate(`window.location.hash = '#view=agents'`);
  await page.until(`!document.querySelector('.ck-dialog')`, 'the page alone');
  await page.evaluate(`document.querySelector('[data-ag-open="agent:${READER.id}"]').click()`);
  await page.until(`document.querySelector(${JSON.stringify(FAR)})?.textContent.includes(${JSON.stringify(READER.view.window.words)})`,
    'the agent again');
  assert.ok(doorAsked().some(each => each.method === 'GET' && each.path === `/v1/agents/${READER.id}`), 'the reader read again');

  /** @param {unknown} does */
  const first = does => page.evaluate(`document.querySelector(${JSON.stringify(`.ck-dialog ${control(does)}`)}).click()`);
  await first({ page: 'access' });
  const sentence = READER.view.sentence.map((/** @type {any} */ run) => run.text).join('');
  await page.until(`document.querySelector('.ck-dialog')?.textContent.includes(${JSON.stringify(sentence)})
    && Boolean(document.querySelector('.ck-dialog .ck-srow--check'))`, 'Access: its sentence and its one list');
  assert.deepEqual(await text('.ck-dialog .ck-dialog__backlink'), [READER.name]);
  assert.deepEqual(await text('.ck-dialog .ck-seg__item'), ['Everything but', 'Only these']);
  await shot('agent-access');
});

test('W1 in the window: an agent with an ask and its reads keeps the 640 page frame, its body scrolls under a fixed head', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  const ask = FILES['reader-ask'].answer.ask;
  await page.load(`#view=agents&dialog=agent%3A${BUSY}`, hostScript({ ...STATE, agent_asks: [ask] }));
  await page.until(`(document.querySelector('.ck-dialog .ck-callout')?.textContent ?? '').includes(${JSON.stringify(ask.head)})
    && document.querySelectorAll('.ck-dialog .ck-week__day').length === 7
    && document.querySelector('.ck-dialog').getAnimations().length === 0`, 'the ask over the page, the week under it, the dialog settled');
  const frame = await page.evaluate(`(() => { const dialog = document.querySelector('.ck-dialog');
    const body = dialog.querySelector('.ck-dialog__body');
    return { height: Math.round(dialog.getBoundingClientRect().height), page: dialog.classList.contains('ck-dialog--page'),
      scrolls: body.scrollHeight > body.clientHeight }; })()`);
  assert.deepEqual(frame, { height: 640, page: true, scrolls: true });
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.ck-dialog .ck-callout button')].map(each => each.textContent.trim())`),
    ['Review']);
  assert.equal(await page.evaluate(`document.querySelector('.ck-dialog .ck-callout [data-cn-do]')?.dataset.cnDo`),
    JSON.stringify({ open: `ask:${ask.id}` }), 'Review opens the ask');
});

test('P7 in the window: a reader\'s Earlier and Storage\'s Show more, each reaching its own', async () => {
  const page = /** @type {NonNullable<typeof chrome>} */ (chrome);
  /** @param {string} selector */
  const click = selector => page.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length); found[0].click(); })()`);
  /** @param {unknown} does */
  const control = does => `.ck-dialog [data-cn-do='${JSON.stringify(does)}']`;
  /** @param {string} selector @returns {string} */
  const counted = selector => `document.querySelectorAll(${JSON.stringify(selector)}).length`;
  /** @param {string} words @returns {string} */
  const says = words => `(document.querySelector('.ck-dialog')?.textContent ?? '').includes(${JSON.stringify(words)})`;
  /** @param {any} history @returns {number} */
  const lines = history => history.sessions.reduce((/** @type {number} */ sum, /** @type {any} */ each) => sum + each.lines.length, 0);
  seen.door.splice(0);

  await page.load(`#view=agents&dialog=agent%3A${READER.id}%2Fhistory`, hostScript(STATE));
  const ROWS = '.ck-dialog .ck-ssection--card .ck-srow';
  await page.until(`${says(READER.name)} && ${says('History')} && ${counted(ROWS)} === ${lines(FILES.history.answer) + 1}`,
    'the reader’s page and its history’s first page');
  const split = FILES.history.answer.sessions.at(-1);
  const goesOn = FILES['history-earlier'].answer.sessions[0];
  const [held, more] = [split.lines.at(-1), goesOn.lines[0]];
  assert.ok(goesOn.key === split.key && held.kind === 'fold' && more.kind === 'fold' && more.continues, 'Earlier continues the session’s fold');
  await click(control({ earlier: READER.id }));
  await page.until(`${counted(ROWS)} === ${lines(FILES.history.answer) + lines(FILES['history-earlier'].answer) - 1}
    && ${says(more.words)} && !${says(held.words)}
    && document.querySelector(${JSON.stringify(control({ earlier: READER.id }))}) === null`,
  'the history’s next page drawn, its fold one with the fold it continues, saying the whole session, no Earlier past it');
  assert.ok(seen.door.some(each => {
    const asked = new URL(/** @type {any} */ (each).path, 'http://door');
    return asked.pathname === `/v1/agents/${READER.id}/history` && asked.searchParams.get('before') === FILES.history.answer.next.before;
  }), 'Earlier asked with its cursor');

  const streams = STORAGE_YEAR.uses.length - 1;
  await page.evaluate(`window.location.hash = '#view=connectors&dialog=${SETTINGS}/storage'`);
  await page.until(`document.querySelector('.cn-storage__more')?.textContent.trim() === ${JSON.stringify(STORAGE_YEAR.more)}
    && ${counted('.cn-storage .ck-urow')} === 6`, 'Storage’s five largest and Index and AI, the rest behind Show more');
  await click('.cn-storage__more');
  await page.until(`${counted('.cn-storage .ck-urow')} === ${streams + 1}
    && document.querySelector('.cn-storage__more')?.getAttribute('aria-expanded') === 'true'`, 'every stream drawn, Show fewer');
  await click('.cn-storage__more');
  await page.until(`${counted('.cn-storage .ck-urow')} === 6
    && document.querySelector('.cn-storage__more')?.getAttribute('aria-expanded') === 'false'`, 'the rest folded again');
});
