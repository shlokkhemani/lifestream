import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';
import { parseRoute, routeHash } from '../public/lib/hash.js';
import { SECTIONS } from '../public/ui/sections.js';
import { asking, chatGroups, citedSources, failedSentence, momentOf, seenOf, shownRefs, turnStamp, turnsOf, withEvent } from '../public/ui/ask/turns.js';
import { menuLines } from '../public/lib/model-menu.js';
import { askAnswer, askQuestion, askTurn, setIcons } from '../public/ui/kit/index.js';
import { esc } from '../public/lib/html.js';
import { Marked } from 'marked';
import { openingOf } from '../public/lib/opening.js';
import { installClock } from '../public/lib/home-clock.js';
import * as media from '../public/lib/ask-media.js';
import { bodyOf, OUTCOMES, outcome } from '../public/lib/ask-outbox.js';
import { clockFor } from './stand-ins/clock.mjs';

installClock(clockFor('UTC', 4));
setIcons(JSON.parse(readFileSync(new URL('../../design/icons.json', import.meta.url), 'utf8')));
const TOKEN = 'synthetic-dashboard-token';
const CHAT = '1792396847000-3fa9c2';

/**
 * @param {import('node:test').TestContext} t
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: string) => void} respond
 */
async function standInDoor(t, respond) {
  /** @type {{ method: string | undefined, url: string | undefined, authorization: string | undefined, body: string }[]} */
  const asked = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':\n\n');
      return;
    }
    if (!request.url?.startsWith('/v1/ask') && !request.url?.startsWith('/v1/privacy/chat/') && !request.url?.startsWith('/v1/describe') && !request.url?.startsWith('/v1/read?')) return void response.writeHead(404, { 'content-type': 'application/json' }).end('{"code":"NOT_FOUND"}');
    let body = '';
    for await (const chunk of request) body += chunk;
    asked.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    respond(request, response, body);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return { url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, asked };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {string} url
 */
async function dashboard(t, url) {
  const dir = await mkdtemp(join(tmpdir(), 'dashboard-ask-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = await createViewer({ door: openDoor({ url, token: () => TOKEN }) });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

const PAGE = { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' };

/**
 * @param {string} at
 * @param {string} path
 * @param {unknown} body
 * @param {{ headers?: Record<string, string>, signal?: AbortSignal }} [options]
 */
const post = (at, path, body, { headers = PAGE, signal } = {}) => fetch(`${at}${path}`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers, signal,
});

/** @param {Response} response */
function events(response) {
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return JSON.parse(line);
      }
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

/** @param {unknown} event */
const line = event => `${JSON.stringify(event)}\n`;
const NDJSON = { 'content-type': 'application/x-ndjson; charset=utf-8' };
const DONE = { type: 'done', message: { chat: CHAT, n: 2, at_ms: 2, role: 'assistant', text: 'In March.', end: 'done', ms: 9 } };

test('A1, A2: each event reaches the page as the door passes it, asked with the dashboard\'s pass and the page\'s body', async t => {
  let release = () => undefined;
  const gate = new Promise(done => { release = () => done(undefined); });
  const door = await standInDoor(t, async (_, response) => {
    response.writeHead(200, NDJSON);
    response.write(line({ type: 'chat', chat: CHAT, n: 2 }));
    response.write(line({ type: 'step', call: 1, name: 'search', words: 'Searching messages for “beach”' }));
    await gate;
    response.end(line(DONE));
  });
  const at = await dashboard(t, door.url);
  const response = await post(at, '/api/ask', { question: 'When was the beach trip?' });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /^application\/x-ndjson/u);
  const next = events(response);
  assert.deepEqual(await next(), { type: 'chat', chat: CHAT, n: 2 });
  assert.equal((await next()).words, 'Searching messages for “beach”');
  release();
  assert.deepEqual(await next(), DONE);
  assert.equal(await next(), null);
  assert.deepEqual(door.asked, [{ method: 'POST', url: '/v1/ask', authorization: `Bearer ${TOKEN}`,
    body: JSON.stringify({ question: 'When was the beach trip?' }) }]);
});

test('A2, A3, A5, A7: stop, what a pick asks, the list, a conversation and its events reach the door\'s route of the same name; a POST not from the page and a path that is no conversation reach nothing', async t => {
  const door = await standInDoor(t, (request, response) => {
    if (request.url?.endsWith('/events')) return void response.writeHead(204).end();
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/v1/ask/stop') return void response.end(JSON.stringify({ stopped: true }));
    if (request.url?.startsWith('/v1/ask?') || request.url === '/v1/ask') return void response.end(JSON.stringify({ default: { model: 'synthetic-terra', thinking: 'low' } }));
    if (request.url?.startsWith('/v1/ask/chats?')) {
      return void response.end(JSON.stringify({ chats: [{ chat: CHAT, title: 'The beach', first_ms: 1, last_ms: 2, messages: 2 }] }));
    }
    response.end(JSON.stringify({ chat: CHAT, title: 'The beach', messages: [] }));
  });
  const at = await dashboard(t, door.url);
  assert.deepEqual(await (await post(at, '/api/ask/stop', { chat: CHAT })).json(), { stopped: true });
  assert.deepEqual((await (await fetch(`${at}/api/ask?model=synthetic-luna&thinking=low`)).json()).default, { model: 'synthetic-terra', thinking: 'low' });
  assert.equal((await fetch(`${at}/api/ask`)).status, 200);
  assert.equal((await (await fetch(`${at}/api/ask/chats?after=next-page`)).json()).chats[0].title, 'The beach');
  assert.equal((await (await fetch(`${at}/api/ask/chat?chat=${CHAT}`)).json()).chat, CHAT);
  const none = await fetch(`${at}/api/ask/events?chat=${CHAT}`);
  assert.equal(none.status, 204);
  assert.equal(await none.text(), '');
  assert.equal((await post(at, '/api/ask', { question: 'x' }, { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await post(at, '/api/ask/stop', 'chat=x', { headers: { 'Content-Type': 'text/plain', 'X-Viewer-Request': '1' } })).status, 403);
  assert.equal((await fetch(`${at}/api/ask/chat?chat=..%2F..%2Fsources`)).status, 404);
  assert.equal((await fetch(`${at}/api/ask/events?chat=not-a-chat`)).status, 404);
  assert.equal((await fetch(`${at}/api/ask/chat`)).status, 404);
  assert.deepEqual(door.asked.map(each => [each.method, each.url, each.authorization, each.body]), [
    ['POST', '/v1/ask/stop', `Bearer ${TOKEN}`, JSON.stringify({ chat: CHAT })],
    ['GET', '/v1/ask?model=synthetic-luna&thinking=low', `Bearer ${TOKEN}`, ''],
    ['GET', '/v1/ask', `Bearer ${TOKEN}`, ''],
    ['GET', '/v1/ask/chats?after=next-page', `Bearer ${TOKEN}`, ''],
    ['GET', `/v1/ask/chats/${CHAT}`, `Bearer ${TOKEN}`, ''],
    ['GET', `/v1/ask/chats/${CHAT}/events`, `Bearer ${TOKEN}`, ''],
  ]);
});

test('A20: a conversation\'s level is read on the door\'s route with the dashboard\'s pass; the person\'s pick rides the question to the door as the page sent it; no route of its own picks one', async t => {
  const door = await standInDoor(t, (request, response) => {
    if (request.url === '/v1/ask') return void response.writeHead(200, NDJSON).end(line(DONE));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ chat: CHAT, level: 'all', epoch: 0 }));
  });
  const at = await dashboard(t, door.url);
  assert.deepEqual(await (await fetch(`${at}/api/ask/privacy?chat=${CHAT}`)).json(), { chat: CHAT, level: 'all', epoch: 0 });
  assert.equal((await post(at, '/api/ask', { question: 'When was the beach trip?', level: 'none' })).status, 200);
  assert.equal((await post(at, '/api/ask', { question: 'And after?', chat: CHAT, level: 'names' })).status, 200);
  assert.equal((await post(at, '/api/ask/privacy', { chat: CHAT, level: 'none' })).status, 404);
  assert.equal((await post(at, '/api/ask/chats', {})).status, 404);
  assert.equal((await fetch(`${at}/api/ask/privacy?chat=not-a-chat`)).status, 404);
  assert.deepEqual(door.asked.map(each => [each.method, each.url, each.authorization, each.body]), [
    ['GET', `/v1/privacy/chat/${CHAT}`, `Bearer ${TOKEN}`, ''],
    ['POST', '/v1/ask', `Bearer ${TOKEN}`, JSON.stringify({ question: 'When was the beach trip?', level: 'none' })],
    ['POST', '/v1/ask', `Bearer ${TOKEN}`, JSON.stringify({ question: 'And after?', chat: CHAT, level: 'names' })],
  ]);
});

test('A4: the page leaving mid-answer stops nothing: no stop is sent, and the page that comes back follows the turn to its end', async t => {
  const turn = [line({ type: 'chat', chat: CHAT, n: 2 }), line({ type: 'text', delta: 'The beach' })];
  /** @type {Set<import('node:http').ServerResponse>} */
  const followers = new Set();
  let left = () => undefined;
  const leaving = new Promise(done => { left = () => done(undefined); });
  const door = await standInDoor(t, (request, response) => {
    response.writeHead(200, NDJSON);
    for (const event of turn) response.write(event);
    followers.add(response);
    response.on('close', () => {
      followers.delete(response);
      if (request.method === 'POST') left();
    });
  });
  const at = await dashboard(t, door.url);
  const page = new AbortController();
  const asked = await post(at, '/api/ask', { question: 'When was the beach trip?' }, { signal: page.signal });
  const first = events(asked);
  assert.deepEqual(await first(), { type: 'chat', chat: CHAT, n: 2 });
  assert.deepEqual(await first(), { type: 'text', delta: 'The beach' });
  page.abort();
  await leaving;
  turn.push(line({ type: 'text', delta: ' in March.' }));
  const back = events(await fetch(`${at}/api/ask/events?chat=${CHAT}`));
  assert.deepEqual(await back(), { type: 'chat', chat: CHAT, n: 2 });
  assert.deepEqual(await back(), { type: 'text', delta: 'The beach' });
  assert.deepEqual(await back(), { type: 'text', delta: ' in March.' });
  for (const follower of followers) follower.end(line(DONE));
  assert.deepEqual(await back(), DONE);
  assert.equal(await back(), null);
  assert.deepEqual(door.asked.map(each => `${each.method} ${each.url}`), ['POST /v1/ask', `GET /v1/ask/chats/${CHAT}/events`]);
});

test('A6: refusals in the person\'s words: Ask not answering the door with its code, the home not answering, the door\'s message never, the Ask server\'s own kept, an erasure and an unknown conversation with their statuses', async t => {
  /** @type {[number, unknown][]} */
  const answers = [
    [503, { code: 'ASK_DOWN', message: 'connect ECONNREFUSED 127.0.0.1:4681 at /Users/someone/lifestream' }],
    [503, { code: 'HOME_STOPPED', message: 'the home is not running: try again in a minute' }],
    [503, { code: 'NOT_NOW', wait: 'needs', message: 'Lifestream is held', title: 'Lifestream is held', line: 'The drive holding it went away.', acts: [] }],
    [401, { code: 'PASS_UNKNOWN', message: 'no such pass' }],
    [409, { error: 'This conversation is still answering its last question: stop it, or wait for its answer.' }],
    [500, { error: 'TypeError: cannot read /Users/someone/x' }],
    [410, { error: 'erased' }],
    [404, { error: `No conversation ${CHAT}.` }],
  ];
  const door = await standInDoor(t, (_, response) => {
    const [status, body] = /** @type {[number, unknown]} */ (answers.shift());
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  const at = await dashboard(t, door.url);
  const said = [];
  for (let index = 0; index < 8; index += 1) {
    const response = await post(at, '/api/ask', { question: 'x', chat: CHAT });
    said.push([response.status, await response.json()]);
  }
  assert.deepEqual(said, [
    [503, { error: 'Chat isn\'t answering on your Mac', code: 'ASK_DOWN' }],
    [503, { error: 'Lifestream cannot answer now. Try again in a moment.', code: 'HOME_STOPPED' }],
    [503, { error: 'Lifestream is held', code: 'NOT_NOW', wait: 'needs' }],
    [503, { error: 'Lifestream refused the dashboard\'s read token.' }],
    [409, { error: 'This conversation is still answering its last question: stop it, or wait for its answer.' }],
    [500, { error: 'Chat could not answer.' }],
    [410, { error: 'erased' }],
    [404, { error: `No conversation ${CHAT}.` }],
  ]);
});

test('A8, A9: the dashboard opens on Ask, first in the sidebar, a conversation kept in the address; Search\'s reply is gone', async t => {
  assert.equal(parseRoute('').view, 'ask');
  assert.equal(parseRoute('#view=nothing').view, 'ask');
  assert.equal(parseRoute(`#view=ask&chat=${CHAT}`).chat, CHAT);
  assert.equal(routeHash({ view: 'ask', on: '', focus: '', seg: '', q: '', chat: CHAT }), `#view=ask&chat=${CHAT}`);
  assert.deepEqual(SECTIONS.map(section => section.view), ['ask', 'days', 'people', 'places', 'connectors', 'agents']);
  assert.equal(SECTIONS[0].label, 'Chat');
  const door = await standInDoor(t, (_, response) => void response.writeHead(404).end());
  const at = await dashboard(t, door.url);
  assert.equal((await fetch(`${at}/pages/ask.js`)).status, 200);
  assert.equal((await fetch(`${at}/ui/search/ask-panel.js`)).status, 404);
});

test('A10: a turn folds its events; a conversation reads into turns; citations number and open as cited; the list groups by when', () => {
  let turn = asking('Who got the tickets?', Date.UTC(2026, 9, 19, 9));
  for (const event of /** @type {import('../public/ui/ask/turns.js').AskEvent[]} */ ([
    { type: 'chat', chat: CHAT, n: 2 },
    { type: 'text', delta: 'Let me look. ' },
    { type: 'step', call: 1, name: 'search', words: 'Searching messages for “tickets”' },
    { type: 'step', call: 2, name: 'fetch', words: 'Opening example.com' },
    { type: 'step', call: 2, words: 'Opened example.com', ms: 12, error: 'not found' },
    { type: 'text', delta: 'Person A [r2]' },
  ])) turn = withEvent(turn, event);
  assert.equal(turn.text, 'Let me look. Person A [r2]', 'a step starting takes back no words: what was narration is the work line’s to say');
  assert.deepEqual(turn.steps, [{ call: 1, words: 'Searching messages for “tickets”', failed: false },
    { call: 2, words: 'Opened example.com', failed: true }]);
  assert.equal(turn.end, 'running');
  const clock = (/** @type {string} */ minute) => `2026-10-17T${minute}+00:00`;
  /** @param {string} day @param {string} [focus] */
  const days = (day, focus) => ({ page: /** @type {const} */ ('days'), day, ...(focus === undefined ? {} : { focus }) });
  const refs = {
    r1: { ref: 'line.c3luLTE', kind: /** @type {const} */ ('line'), day: '2026-10-18', title: 'Sun 18 Oct, a walk', opens: days('2026-10-18') },
    r2: { ref: 'record.c3luLTI', kind: /** @type {const} */ ('message'), day: '2026-10-17', at: clock('09:15'), title: 'Chat with Person A',
      opens: days('2026-10-17', 'rec:sms:local:phone-a message m2') },
    r3: { ref: 'record.c3luLTM', kind: /** @type {const} */ ('photo'), day: '2026-10-16', at: '2026-10-16T12:30+00:00', title: 'Photo at the cafe',
      image: `sha256:${'a'.repeat(64)}`, opens: days('2026-10-16', 'rec:photos:local:phone-a photo p3') },
  };
  const kept = { chat: CHAT, n: 2, at_ms: 1, role: /** @type {const} */ ('assistant'), refs, end: /** @type {const} */ ('done'), ms: 900, thought_ms: 600,
    text: 'Person A got two [r2], seen [r3, r1] and again [r2]; [r9] is no source.',
    steps: [{ name: 'search', words: 'Searched messages for “tickets”', ms: 300 }] };
  turn = withEvent(turn, { type: 'done', message: kept });
  assert.equal(turn.text, kept.text);
  assert.equal(turn.end, 'done');
  assert.deepEqual(turn.steps, [{ call: 1, words: 'Searched messages for “tickets”', failed: false }]);
  assert.equal(turn.thought, 600, 'the line says how long it thought before its first word');
  assert.equal(withEvent(asking('x', 0), { type: 'done', message: { ...kept, thought_ms: undefined } }).thought, 900, 'an older answer: its whole time');
  assert.deepEqual(citedSources(turn).map(each => each.handle), ['r2', 'r3', 'r1']);
  assert.deepEqual(momentOf([refs.r2], '2026'), { on: '2026-10-17', focus: 'rec:sms:local:phone-a message m2',
    head: { icon: 'days', title: 'Chat with Person A', meta: 'Sat 17 Oct' } });
  assert.deepEqual(openingOf(refs.r2), { panel: true });
  assert.deepEqual(openingOf(refs.r1), { go: 'days', patch: { on: '2026-10-18' } });
  const inChat = { kind: /** @type {const} */ ('message'), day: '2026-10-17', title: 'Person A', chat: 'chat.c3luLWE', chat_title: 'Person A' };
  const ofChat = (/** @type {number} */ n) => ({ ...inChat, ref: `record.k${n}`, at: clock(`09:0${n}`), opens: days('2026-10-17', `rec:whatsapp:local:phone-a message k${n}`) });
  assert.deepEqual(citedSources({ ...turn, text: 'Cited as `[r8]` in code, [r7] first, then [r9].', refs: { r7: refs.r1, r8: ofChat(8), r9: ofChat(9) } }),
    [{ handle: 'r7', handles: ['r7'] }, { handle: 'r9', handles: ['r9'] }]);
  assert.deepEqual(citedSources({ ...turn, text: 'Said [r8], and [r7], and again [r9].', refs: { r7: refs.r1, r8: ofChat(8), r9: ofChat(9) } }),
    [{ handle: 'r8', handles: ['r8', 'r9'] }, { handle: 'r7', handles: ['r7'] }]);
  const inA = (/** @type {number} */ n) => `rec:whatsapp:local:phone-a message k${n}`;
  assert.deepEqual(momentOf([ofChat(8), ofChat(9)], '2026'), { on: '2026-10-17', focus: inA(8), whole: true,
    marks: [inA(8), inA(9)], head: { icon: 'days', title: 'Person A', meta: 'Sat 17 Oct' } });
  assert.equal(momentOf([refs.r3], '2026').head?.icon, 'photo');
  const offline = 'ChatGPT didn’t answer: you’re offline.';
  const failed = withEvent(withEvent(asking('x', 0), { type: 'error', error: 'model', message: offline }),
    { type: 'done', message: { ...kept, text: 'Part', end: 'failed', error: offline } });
  assert.equal(failedSentence(failed), offline);
  assert.equal(failedSentence({ ...failed, error: '' }), 'The model didn’t answer.');
  assert.equal(failedSentence({ ...failed, error: '', failed: 'login' }), 'The model didn’t answer.');
  const claudeOut = 'Chat needs your Claude sign-in on your Mac.';
  assert.equal(failedSentence({ ...failed, error: claudeOut, failed: 'login' }), claudeOut);
  assert.equal(failedSentence({ ...failed, failed: 'other' }), 'Lost the connection to Chat.');
  const row = (/** @type {string} */ value, /** @type {string} */ name, account = /** @type {string | null} */ (null), chosen = false) => ({ value, name, account, chosen });
  const menu = { default: null, rows: [row('claude:opus', 'Opus', 'Claude', true), row('openrouter:opus', 'Opus', 'OpenRouter')],
    local: { label: 'Local', rows: [row('runner:mac/qwen', 'Qwen')] }, more: { words: 'More', use: /** @type {const} */ ('chat'), work: null }, off: null };
  /** @param {import('../public/lib/model-menu.js').MenuLine[]} lines */
  const drawn = lines => lines.map(line => 'more' in line ? ['more', line.more, line.parted] : [line.row.value, line.head, line.parted]);
  assert.deepEqual(drawn(menuLines(menu)), [['claude:opus', '', false], ['openrouter:opus', '', false], ['runner:mac/qwen', 'Local', true], ['more', 'More', false]]);
  assert.deepEqual(drawn(menuLines({ ...menu, local: null, default: row('default', 'Default · Opus', null, true), off: row('off', 'Off') })),
    [['default', '', false], ['claude:opus', '', false], ['openrouter:opus', '', true], ['more', 'More', false], ['off', '', false]]);
  assert.deepEqual(drawn(menuLines({ rows: [row('claude:opus', 'Opus')], local: null })), [['claude:opus', '', false]]);
  const [restarted] = turnsOf({ chat: CHAT, title: 'Tickets', messages: [
    { chat: CHAT, n: 1, at_ms: 1, role: 'user', text: 'Who got the tickets?' },
    { ...kept, n: 2, text: 'Part', end: 'failed', error: 'Chat restarted before this answer finished.', failed: 'restart' },
  ] });
  assert.equal(failedSentence(restarted), 'Chat restarted before it finished.');
  const turns = turnsOf({ chat: CHAT, title: 'Tickets', running: { n: 4 }, messages: [
    { chat: CHAT, n: 1, at_ms: 1, role: 'user', text: 'Who got the tickets?' },
    { ...kept, n: 2 },
    { chat: CHAT, n: 3, at_ms: 3, role: 'user', text: 'And when?' },
  ] });
  assert.deepEqual(turns.map(each => [each.question, each.end, each.text]),
    [['Who got the tickets?', 'done', kept.text], ['And when?', 'running', '']]);
  const at = (/** @type {string} */ day, hour = 12) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
  const chat = (/** @type {string} */ id, /** @type {number} */ last_ms) => ({ chat: id, title: id, first_ms: last_ms, last_ms, messages: 2 });
  const groups = chatGroups([chat('august', at('2026-08-02')), chat('today', at('2026-10-19')), chat('late', at('2026-10-19', 2)),
    chat('monday', at('2026-10-12'))], '2026-10-19');
  assert.deepEqual(groups.map(group => [group.label, group.chats.map(each => each.chat)]),
    [['Today', ['today']], ['Yesterday', ['late']], ['Previous 7 days', ['monday']], ['August', ['august']]]);
  const asked = [at('2026-10-12', 9), at('2026-10-18', 21), at('2026-10-18', 21) + 59 * 60_000, at('2026-10-19', 8),
    at('2026-10-19', 8) + 60 * 60_000].map(ms => asking('Q?', ms));
  assert.deepEqual(asked.map((_, n) => turnStamp(asked, n, '2026-10-19')),
    ['12 Oct 09:00', 'Yesterday 21:00', '', 'Today 08:00', 'Today 09:00']);
});

test('A19: a kept answer citing one thing of each kind, as the door described them, is drawn by their words and opens each where the door said; `gone` opens nothing', () => {
  const citations = JSON.parse(readFileSync(new URL('../../packages/home/test/contract/citations.json', import.meta.url), 'utf8'));
  /** @type {Record<string, import('../public/ui/ask/turns.js').AskCited>} */
  const refs = { ...citations, r13: { ref: 'record.alone' } };
  const turn = { ...asking('What happened?', Date.UTC(2026, 9, 19, 9)), end: /** @type {const} */ ('done'), refs,
    text: `Each ${Object.keys(refs).map(handle => `[${handle}]`).join(' ')}.` };
  assert.deepEqual(citedSources(turn).map(each => each.handle), Object.keys(refs));
  assert.deepEqual(Object.fromEntries(Object.entries(shownRefs(refs)).map(([handle, each]) => [handle, [each.title, each.day, each.block ?? null, each.image ?? null]])), {
    r3: ['Person A', '2026-10-04', citations.r3.chat, null], r4: ['Example review', '2026-10-01', null, null], r5: ['Example review', '2026-10-01', null, null],
    r6: ['A cafe table with two cups', '2026-10-04', null, citations.r6.image], r7: ['Example Air: your trip', '2026-11-02', null, null],
    r8: ['sum of amount over payments, by item', null, null, null], r9: ['Person A', null, null, null], r10: ['Example Group', null, null, null],
    r11: ['Example Cafe', null, null, null], r12: [citations.r12.why, null, null, null], r13: ['', null, null, null],
  });
  assert.deepEqual(Object.fromEntries(Object.entries(refs).map(([handle, each]) => [handle, openingOf(each)])), {
    r3: { panel: true }, r4: { panel: true }, r5: { panel: true }, r6: { panel: true }, r7: { panel: true }, r8: { panel: true },
    r9: { go: 'people', patch: { focus: citations.r9.opens.id } }, r10: { go: 'people', patch: { focus: `chat:${citations.r10.opens.group}` } },
    r11: { go: 'places', patch: { focus: 'example-cafe' } }, r12: null, r13: null,
  });
  const oneToOne = { ...citations.r10, opens: { page: 'people', id: 'whatsapp:15550000001@s.whatsapp.net', person: 'phone:+15550000001' } };
  assert.deepEqual(openingOf(oneToOne), { go: 'people', patch: { focus: 'phone:+15550000001' } }, 'a chat with no page of its own opens the home\'s person');
  assert.deepEqual(momentOf([refs.r3], '2026'), { on: '2026-10-04', focus: citations.r3.opens.focus, whole: true, marks: [citations.r3.opens.focus],
    head: { icon: 'days', title: 'Person A', meta: 'Sun 4 Oct' } });
  assert.equal(momentOf([refs.r6], '2026').head?.icon, 'photo');
  assert.deepEqual(momentOf([refs.r7], '2026'), { on: '2026-11-02', focus: citations.r7.opens.focus, head: { icon: 'days', title: 'Example Air: your trip', meta: 'Mon 2 Nov' } });
  assert.deepEqual(momentOf([refs.r8], '2026'), { on: '', focus: '', facts: { token: citations.r8.ref, asked: citations.r8.asked },
    head: { icon: 'info', title: citations.r8.asked, meta: '' } });
  assert.equal(openingOf({ ref: 'record.nodate', kind: 'record', title: 'Undated', opens: { page: 'read' } }), null);
});

test('A19: a cited count row opens as the facts behind its number through the person\'s `/v1/read` of its ref, with the dashboard\'s pass', async t => {
  const row = JSON.parse(readFileSync(new URL('../../packages/home/test/contract/read-row.json', import.meta.url), 'utf8'));
  const door = await standInDoor(t, (_request, response) => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(row)));
  const at = await dashboard(t, door.url);
  const answer = await fetch(`${at}/api/life/read?${new URLSearchParams({ ref: row.ref })}`);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), row);
  assert.deepEqual(door.asked.map(each => [each.method, each.url, each.authorization]), [['GET', `/v1/read?${new URLSearchParams({ ref: row.ref })}`, `Bearer ${TOKEN}`]]);
  assert.equal((await fetch(`${at}/api/life/read`)).status, 400);
});

test('A19: refs a kept answer holds alone are described by the door\'s `/v1/describe`, each ref repeated, with the dashboard\'s pass', async t => {
  const described = JSON.parse(readFileSync(new URL('../../packages/home/test/contract/describe.json', import.meta.url), 'utf8'));
  const door = await standInDoor(t, (_request, response) => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(described)));
  const at = await dashboard(t, door.url);
  const refs = described.described.map((/** @type {{ ref: string }} */ each) => each.ref);
  const answer = await fetch(`${at}/api/life/describe?${new URLSearchParams(refs.map((/** @type {string} */ ref) => ['ref', ref]))}`);
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), described);
  assert.deepEqual(door.asked.map(each => [each.method, each.url, each.authorization]),
    [['GET', `/v1/describe?${new URLSearchParams(refs.map((/** @type {string} */ ref) => ['ref', ref]))}`, `Bearer ${TOKEN}`]]);
  assert.equal((await fetch(`${at}/api/life/describe`)).status, 400);
});

test('A11: the home holding a turn until hiding is ready is said in its words, in any step’s place, until the turn moves on', () => {
  const people = 'Waiting for People to list the names of your people';
  let turn = withEvent(asking('Who called?', 0), { type: 'waiting', words: people });
  assert.equal(turn.waiting, people, 'the home’s own reason');
  const stepped = withEvent(turn, { type: 'step', call: 1, name: 'search', words: 'Searching calls' });
  assert.equal(stepped.waiting, '', 'a step takes the line’s place');
  turn = withEvent(stepped, { type: 'waiting', words: people });
  assert.equal(turn.waiting, people, 'a hold during a step says its reason');
  assert.equal(withEvent(turn, { type: 'step', call: 1, words: 'Searched calls', ms: 9 }).waiting, '', 'the step ending takes its place');
  assert.equal(withEvent(turn, { type: 'text', delta: 'Person A' }).waiting, '');
  assert.equal(withEvent(turn, { type: 'error', error: 'door', message: 'x' }).waiting, '');
});

/**
 * @param {import('node:test').TestContext} t
 * @param {(request: import('node:http').IncomingMessage) => [number, unknown]} respond
 */
async function fileDoor(t, respond) {
  /** @type {{ method: string | undefined, url: string | undefined, authorization: string | undefined, type: string | undefined,
   *   length: string | undefined, bytes: Buffer }[]} */
  const asked = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(':\n\n');
      return;
    }
    if (!request.url?.startsWith('/v1/ask')) return void response.writeHead(404, { 'content-type': 'application/json' }).end('{"code":"NOT_FOUND"}');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    asked.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      type: request.headers['content-type'], length: request.headers['content-length'], bytes: Buffer.concat(chunks) });
    const [status, body] = respond(request);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }));
  return { url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, asked };
}

const NOTE = '0123456789abcdef0123456789abcdef';
const FILE = `sha256:${'a'.repeat(64)}`;
const { barsOf, downsampler, levelOf, mint, noteMs, photoKind, photosToTake, seconds, SECOND_BYTES, tooLarge, wavOf } = media;
const LIMITS = { photos: 10, photo_bytes: 26_214_400, voice_ms: 600_000 };

test('A12: a photo, a note opened, its seconds and its cancel reach the door\'s stage as the page sent them; nothing else does', async t => {
  const door = await fileDoor(t, request => request.url === '/v1/ask/files'
    ? [200, { file: FILE, kind: 'photo', width: 4, height: 3 }] : [200, { ok: true }]);
  const at = await dashboard(t, door.url);
  const photo = Buffer.alloc(300_000, 0);
  for (let at = 0; at < photo.length; at += 1) photo[at] = (at * 7) % 256;
  photo.set([0xFF, 0xD8, 0xFF], 0);
  const sent = await fetch(`${at}/api/ask/files`, { method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg', 'X-Viewer-Request': '1' } });
  assert.equal(sent.status, 200);
  assert.deepEqual(await sent.json(), { file: FILE, kind: 'photo', width: 4, height: 3 });
  const second = Buffer.alloc(32_000, 1);
  const PCM = { 'Content-Type': 'application/octet-stream', 'X-Viewer-Request': '1' };
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}`, { method: 'POST', headers: { 'X-Viewer-Request': '1' } })).status, 200);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}&k=0`, { method: 'PUT', body: second, headers: PCM })).status, 200);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}&k=1`, { method: 'PUT', body: second.subarray(0, 2), headers: PCM })).status, 200);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}`, { method: 'DELETE', headers: { 'X-Viewer-Request': '1' } })).status, 200);
  assert.equal((await fetch(`${at}/api/ask/files`, { method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg' } })).status, 403);
  assert.equal((await fetch(`${at}/api/ask/notes?note=..%2F..%2Fsecrets`, { method: 'POST', headers: { 'X-Viewer-Request': '1' } })).status, 404);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}&k=..`, { method: 'PUT', body: second, headers: PCM })).status, 404);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}`, { method: 'DELETE' })).status, 403);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}&k=2`, { method: 'PUT', body: Buffer.alloc(32_001), headers: PCM })).status, 200);
  assert.equal((await fetch(`${at}/api/ask/notes?note=${NOTE}&k=600`, { method: 'PUT', body: second, headers: PCM })).status, 200);
  assert.deepEqual(door.asked.map(each => [each.method, each.url, each.authorization, each.type, each.bytes.length]), [
    ['POST', '/v1/ask/files', `Bearer ${TOKEN}`, 'image/jpeg', photo.length],
    ['POST', `/v1/ask/notes/${NOTE}`, `Bearer ${TOKEN}`, undefined, 0],
    ['PUT', `/v1/ask/notes/${NOTE}/0`, `Bearer ${TOKEN}`, 'application/octet-stream', 32_000],
    ['PUT', `/v1/ask/notes/${NOTE}/1`, `Bearer ${TOKEN}`, 'application/octet-stream', 2],
    ['DELETE', `/v1/ask/notes/${NOTE}`, `Bearer ${TOKEN}`, undefined, 0],
    ['PUT', `/v1/ask/notes/${NOTE}/2`, `Bearer ${TOKEN}`, 'application/octet-stream', 32_001],
    ['PUT', `/v1/ask/notes/${NOTE}/600`, `Bearer ${TOKEN}`, 'application/octet-stream', 32_000],
  ]);
  assert.deepEqual([door.asked[0].length, door.asked[2].length, door.asked[3].length], [String(photo.length), '32000', '2']);
  assert.ok(door.asked[0].bytes.equals(photo), 'the photo\'s bytes changed on the way');
  assert.ok(door.asked[2].bytes.equals(second));
});

test('A13: the stage\'s refusals in the door\'s own words with their codes, no path in them, and the seal\'s missing files passed on', async t => {
  /** @type {[number, unknown][]} */
  const answers = [
    [422, { code: 'PICTURE_UNREADABLE', message: 'Lifestream can\'t read this picture: /Users/someone/x.heic' }],
    [415, { code: 'FILE_KIND', message: 'Lifestream takes a photo here: a JPEG, PNG, HEIC or WebP.' }],
    [507, { code: 'STAGE_FULL', message: 'Lifestream has too many unsent photos: send or remove some.' }],
    [409, { code: 'NOTE_CLOSED', message: 'This voice note was sent or cancelled.' }],
  ];
  const door = await fileDoor(t, () => /** @type {[number, unknown]} */ (answers.shift()));
  const at = await dashboard(t, door.url);
  const said = [];
  for (let index = 0; index < 3; index += 1) {
    const response = await fetch(`${at}/api/ask/files`, { method: 'POST', body: Buffer.from([0xFF, 0xD8, 0xFF, 0]),
      headers: { 'Content-Type': 'image/jpeg', 'X-Viewer-Request': '1' } });
    said.push([response.status, await response.json()]);
  }
  const closed = await fetch(`${at}/api/ask/notes?note=${NOTE}&k=3`, { method: 'PUT', body: Buffer.alloc(2),
    headers: { 'Content-Type': 'application/octet-stream', 'X-Viewer-Request': '1' } });
  said.push([closed.status, await closed.json()]);
  assert.deepEqual(said, [
    [422, { error: 'Lifestream can\'t read this picture: …', code: 'PICTURE_UNREADABLE' }],
    [415, { error: 'Lifestream takes a photo here: a JPEG, PNG, HEIC or WebP.', code: 'FILE_KIND' }],
    [507, { error: 'Lifestream has too many unsent photos: send or remove some.', code: 'STAGE_FULL' }],
    [409, { error: 'This voice note was sent or cancelled.', code: 'NOTE_CLOSED' }],
  ]);
  const missing = { photos: [FILE], seconds: [4, 5], audio: [FILE] };
  const asks = await standInDoor(t, (_, response) => {
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Some files are missing.', missing }));
  });
  const page = await dashboard(t, asks.url);
  const refused = await post(page, '/api/ask', { submission: NOTE, question: 'Where?', photos: [FILE] });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: 'Some files are missing.', missing });
});

test('A14: a note is 16 kHz 16-bit in seconds of 32,000 bytes, its last part even, its WAV canonical; photos taken within the limits', () => {
  for (const rate of [48_000, 44_100]) {
    const down = downsampler(rate);
    const cut = seconds(Number.MAX_SAFE_INTEGER);
    /** @type {Uint8Array[]} */
    const done = [];
    let made = 0;
    const total = rate * 3 + rate / 4;
    for (let at = 0; at < total; at += 2048) {
      const block = Float32Array.from({ length: Math.min(2048, total - at) }, (_, k) => 0.5 * Math.sin(2 * Math.PI * 440 * (at + k) / rate));
      const samples = down(block);
      made += samples.length;
      done.push(...cut.push(samples));
    }
    assert.ok(Math.abs(made - 16_000 * 3.25) <= 1, `${rate}: ${made} samples`);
    assert.equal(done.length, 3, `${rate}: whole seconds`);
    assert.ok(done.every(second => second.length === SECOND_BYTES));
    const rest = cut.rest();
    assert.equal(rest.length % 2, 0);
    assert.ok(Math.abs(rest.length - 8_000) <= 2, `${rate}: the last quarter second, ${rest.length} bytes`);
    const view = new DataView(done[1].buffer);
    const peak = Math.max(...Array.from({ length: 16_000 }, (_, k) => Math.abs(view.getInt16(k * 2, true))));
    assert.ok(peak > 14_000 && peak <= 16_384, `${rate}: peak ${peak}`);
  }
  const wav = wavOf([new Uint8Array(32_000), new Uint8Array(4)]);
  const view = new DataView(wav.buffer);
  assert.equal(wav.length, 44 + 32_004);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)) + new TextDecoder().decode(wav.subarray(8, 16)), 'RIFFWAVEfmt ');
  assert.deepEqual([view.getUint32(4, true), view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true),
    view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true), view.getUint32(40, true)],
  [36 + 32_004, 1, 1, 16_000, 32_000, 2, 16, 32_004]);
  assert.equal(noteMs(32_000 * 7 + 3_200), 7_100);
  assert.equal(barsOf([0.1, 0.9, 0.2, 0.3], 2).join(), '0.9,0.3');
  assert.match(mint(), /^[0-9a-f]{32}$/u);

  /** @param {string} name @param {string} type @param {number} size */
  const file = (name, type, size, lastModified = 1) => ({ name, type, size, lastModified });
  const photo = file('a.jpg', 'image/jpeg', 1000);
  assert.equal(photoKind(file('b.HEIC', '', 5)), 'HEIC');
  assert.equal(photoKind(file('c.pdf', 'application/pdf', 5)), '');
  const taken = photosToTake([photo, photo, file('big.png', 'image/png', LIMITS.photo_bytes + 1), file('d.pdf', 'application/pdf', 5),
    file('e.webp', 'image/webp', 5)], { attached: [], limits: LIMITS });
  assert.deepEqual(taken.take.map(each => each.name), ['a.jpg', 'e.webp']);
  assert.equal(taken.said, 'Too large to send: over 25 MB.');
  assert.deepEqual(photosToTake([photo], { attached: [photo], limits: LIMITS }).take, []);
  const nine = Array.from({ length: 9 }, (_, at) => file(`${at}.jpg`, 'image/jpeg', 5));
  assert.deepEqual(photosToTake([file('x.jpg', 'image/jpeg', 5), file('y.jpg', 'image/jpeg', 5)], { attached: nine, limits: LIMITS }),
    { take: [file('x.jpg', 'image/jpeg', 5)], said: '' });
  assert.equal('LIMITS' in media, false, 'the page holds limits of its own');
  const smaller = { photos: 3, photo_bytes: 10 * 1024 * 1024, voice_ms: 60_000 };
  const held = photosToTake([file('m.png', 'image/png', smaller.photo_bytes + 1), ...nine.slice(0, 4)], { attached: [], limits: smaller });
  assert.deepEqual([held.take.length, held.said], [3, 'Too large to send: over 10 MB.']);
  assert.equal(tooLarge(LIMITS.photo_bytes), 'Too large to send: over 25 MB.');
});

test('A15: a voice question shows its words when they come, none after a failure; a kept question keeps its photos and note', () => {
  const photos = [{ hash: `sha256:${'b'.repeat(64)}`, local: 'blob:x', kind: '' }];
  const sent = asking('', 1, { voice: { ms: 7_000, audio: '', local: 'blob:y', levels: [0.5], words: null }, photos });
  const named = withEvent(sent, { type: 'chat', chat: CHAT, n: 2 });
  assert.equal(named.voice?.words, null, 'the words came before `words`');
  assert.equal(withEvent(named, { type: 'words', words: 'How far did I walk?' }).voice?.words, 'How far did I walk?');
  const failed = withEvent(named, { type: 'error', error: 'model', message: 'Couldn’t write out your voice note: synthetic.' });
  assert.equal(failed.voice?.words, '', '"Writing it out…" kept after the note failed');
  assert.equal(failedSentence({ ...failed, end: 'failed' }), 'Couldn’t write out your voice note: synthetic.');
  const done = withEvent(named, { type: 'done', message: { chat: CHAT, n: 2, at_ms: 2, role: 'assistant', text: '', end: 'failed', failed: 'model',
    error: 'Your voice note had no words in it.' } });
  assert.deepEqual([done.end, done.voice?.words, done.photos], ['failed', '', photos]);
  const audio = `sha256:${'c'.repeat(64)}`;
  const [kept, writing] = turnsOf({ chat: CHAT, title: 'Voice note', running: { n: 4 }, messages: [
    { chat: CHAT, n: 1, at_ms: 1, role: 'user', text: '', photos: [photos[0].hash], voice: { audio, ms: 7_000, words: 'Where was this?' } },
    { chat: CHAT, n: 2, at_ms: 2, role: 'assistant', text: 'At the synthetic beach.', end: 'done' },
    { chat: CHAT, n: 3, at_ms: 3, role: 'user', text: '', voice: { audio, ms: 3_000, writing: true } },
  ] });
  assert.deepEqual([kept.n, kept.photos, kept.voice], [1, [{ hash: photos[0].hash, local: '', kind: '' }],
    { ms: 7_000, audio, local: '', levels: [], words: 'Where was this?' }]);
  assert.deepEqual([writing.end, writing.voice?.words], ['running', null]);
});

test('A16: every answer to a question is decided as ask-outcomes.json says, only a 410 or the erased line an erasure, and a replay posts the first body', async () => {
  const table = JSON.parse(await readFile(new URL('../../homelink/Tests/Fixtures/ask-outcomes.json', import.meta.url), 'utf8'));
  assert.ok(table.cases.length >= 19);
  for (const each of table.cases) {
    const { name, phase, copies, turn, again } = each;
    assert.deepEqual(outcome(phase, each.answer), { name, phase, copies, turn, again }, name);
  }
  assert.deepEqual(table.cases.map((/** @type {{ name: string }} */ each) => each.name).sort(), OUTCOMES.map(each => each.name).sort());
  for (const phase of /** @type {const} */ (['sending', 'named'])) {
    for (const status of [404, 503]) assert.notEqual(outcome(phase, { status }).copies, 'purge', `${phase} ${status}`);
    assert.equal(outcome(phase, { status: 410 }).copies, 'purge', `${phase} 410`);
  }
  assert.equal(outcome('sending', { status: 409, missing: ['photos', 'audio'] }).name, 'voice note gone');
  const question = { submission: NOTE, chat: CHAT, pick: { model: 'synthetic-terra' }, words: 'Where?', photos: [FILE], note: null, audio: '' };
  assert.deepEqual(bodyOf(question), { submission: NOTE, chat: CHAT, model: 'synthetic-terra', photos: [FILE], question: 'Where?' });
  assert.deepEqual(bodyOf({ ...question, chat: '', photos: [], note: { id: NOTE, seconds: 3 } }),
    { submission: NOTE, model: 'synthetic-terra', voice: { note: NOTE, seconds: 3 } });
  assert.deepEqual(bodyOf({ ...question, audio: FILE }), { submission: NOTE, chat: CHAT, model: 'synthetic-terra', photos: [FILE],
    voice: { audio: FILE } });
});

test('A17: a note is cut within its budget: a block crossing the home\'s voice_ms is taken up to it, nothing after', () => {
  const most = 600 * 16_000;
  const down = downsampler(48_000);
  const cut = seconds(most);
  /** @type {Uint8Array[]} */
  const done = [];
  const block = new Float32Array(2048).fill(0.25);
  let full = false;
  for (let at = 0; !full && at < 700 * 48_000; at += block.length) {
    done.push(...cut.push(down(block)));
    full = cut.full;
  }
  assert.equal(full, true);
  assert.deepEqual(cut.push(down(block)), [], 'samples taken past the budget');
  const rest = cut.rest();
  const samples = (done.reduce((sum, part) => sum + part.length, 0) + rest.length) / 2;
  assert.deepEqual([done.length, rest.length, samples], [600, 0, most]);
});

test('A18: a level is the phone\'s, on a 50 dB scale: -25 dBFS draws half, -60 none, full scale all', () => {
  const at = (/** @type {number} */ db) => levelOf(new Int16Array(1_600).fill(Math.round(32_768 * 10 ** (db / 20))));
  assert.ok(Math.abs(at(-25) - 0.5) < 0.001, `-25 dBFS draws ${at(-25)}`);
  assert.equal(at(-60), 0);
  assert.ok(levelOf(new Int16Array(1_600).fill(32_767)) > 0.999);
  assert.equal(levelOf(new Int16Array(1_600)), 0);
});

/**
 * @typedef {import('../public/ui/kit/seen.js').AskSeen} AskSeen
 * @typedef {{ name: string, words: string, photos?: number, answer: string, end: 'done' | 'stopped' | 'failed', refs?: Record<string, import('../public/ui/ask/turns.js').AskCited>,
 *   seen: AskSeen, model?: { asked: string, answered: string }, details?: string[], eye: boolean, why?: string }} SeenCase
 */
const replyMarked = new Marked({ gfm: true, breaks: true, renderer: {
  html: ({ text, block }) => block ? `<p>${esc(text.trim())}</p>\n` : esc(text),
  link({ href, tokens }) {
    const words = this.parser.parseInline(tokens);
    return /^https?:\/\//u.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${words}</a>` : words;
  },
} });
const PIECE = /<span class="ck-seen ck-seen--(\w+)( is-more)?" data-said="([^"]*)"><span class="ck-seen__words">([\s\S]*?)<\/span><span class="ck-seen__said[^"]*">([\s\S]*?)<\/span><span class="ck-seen__run" aria-hidden="true"><\/span><\/span>/gu;
/** @param {string} html */
const textOf = html => html.replace(/<[^>]*>/gu, '').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
  .replace(/&#39;/gu, '\'').replace(/&amp;/gu, '&');
/** @param {string} html @param {boolean} model */
const drawnOf = (html, model) => textOf(html.replace(PIECE, (_, _kind, _more, said, words) => model ? said : words)).trim();
/** @param {string} html */
const detailsIn = html => [...html.matchAll(PIECE)].reduce((details, [, , more, said]) => more && details.length
  ? [...details.slice(0, -1), details[details.length - 1] + textOf(said)] : [...details, textOf(said)], /** @type {string[]} */ ([]));

/**
 * @param {SeenCase} shared
 * @param {boolean} model
 */
function drawnTurn(shared, model) {
  const audio = `sha256:${'c'.repeat(64)}`;
  const [turn] = turnsOf({ chat: CHAT, title: shared.name, messages: [
    { chat: CHAT, n: 1, at_ms: 1, role: 'user', text: shared.seen.spoken === undefined ? shared.words : '',
      ...shared.photos ? { photos: Array.from({ length: shared.photos }, (_, at) => `sha256:${String(at).repeat(64)}`) } : {},
      ...shared.seen.spoken === undefined ? {} : { voice: { audio, ms: 3_000, words: shared.words } } },
    { chat: CHAT, n: 2, at_ms: 2, role: 'assistant', text: shared.answer, end: shared.end, ...shared.refs ? { refs: shared.refs } : {}, seen: shared.seen },
  ] });
  const seen = seenOf(turn);
  const question = askQuestion(turn.question, { seen: seen?.asked ?? null, model,
    pictures: turn.photos.map((photo, at) => ({ src: photo.hash, alt: 'Photo', ...seen?.photos?.[at] ? { seen: String(seen.photos[at]) } : {} })),
    voice: turn.voice ? { seconds: 3, levels: [0.5], words: turn.voice.words } : null });
  const answer = askAnswer({ text: turn.text, refs: turn.refs ? shownRefs(turn.refs) : null, stopped: turn.end === 'stopped', seen: seen?.answered ?? null,
    model, failed: turn.end === 'failed' ? { sentence: 'Synthetic: it failed.', retry: null } : null },
  { markdown: text => /** @type {string} */ (replyMarked.parse(text)), year: '2026' });
  const markup = askTurn({ question, answer, model });
  const words = /<p class="ck-ask-(?:q|voice)__words[^"]*">([\s\S]*?)<\/p>/u.exec(question)?.[1] ?? '';
  const answered = /<div class="ck-answer__words mac-reading">([\s\S]*?)<\/div>(?:<div class="ck-copy|<\/div>$)/u.exec(answer)?.[1] ?? '';
  return { markup, words, answered, eye: /data-ck-seen-eye/u.test(answer) };
}

test('A21: the eye of every shared case is the one predicate\'s; each eye\'s model view draws the model\'s text, detail by detail, in reading order', () => {
  /** @type {{ turns: SeenCase[] }} */
  const shared = JSON.parse(readFileSync(new URL('../../design/privacy-view.json', import.meta.url), 'utf8'));
  for (const each of shared.turns) {
    const shown = drawnTurn(each, false);
    assert.equal(shown.eye, each.eye, `${each.name}: ${each.why ?? 'its eye'}`);
    if (!each.eye) continue;
    const turned = drawnTurn(each, true);
    assert.match(turned.markup, /^<section class="ck-ask-turn is-model">/u);
    assert.match(turned.markup, /aria-pressed="true"/u);
    assert.equal(drawnOf(shown.words, false), each.seen.spoken ?? each.words, `${each.name}: the person's question`);
    assert.equal(drawnOf(turned.words, true), each.model?.asked, `${each.name}: the question as the model read it`);
    assert.equal(drawnOf(turned.answered, true), each.model?.answered, `${each.name}: the answer as the model wrote it`);
    assert.deepEqual([...detailsIn(turned.words), ...detailsIn(turned.answered)], each.details, `${each.name}: its details in reading order`);
  }
  const plain = turnsOf({ chat: CHAT, title: 'Plain', messages: [{ chat: CHAT, n: 1, at_ms: 1, role: 'user', text: 'Hello' },
    { chat: CHAT, n: 2, at_ms: 2, role: 'assistant', text: 'Hello.', end: 'done' }] })[0];
  assert.equal(seenOf(plain), null, 'a typed turn with nothing hidden, and an answer from before the record, have no eye');
});
