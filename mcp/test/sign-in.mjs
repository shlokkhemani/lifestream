// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askOn, createHandler } from '../server.mjs';
import { until } from './until.mjs';
import { asked, command, home, homeClock, keyed, listedIn, login, modelsOf, named, note, PLAN_ROWS, plansOn, plansRead, startHome, statusOf, stopHome, streaming } from './asking.mjs';
import { fakeCodex, openDoorway } from './programs.mjs';
import { ASK_TOOLS } from '../lib/tools.mjs';
import { agents } from '../lib/ask/agents.mjs';

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, body: string }>}
 */
const requested = (url, headers) => new Promise((done, fail) => {
  const asked = httpRequest(url, { headers }, answer => {
    let body = '';
    answer.on('data', chunk => { body += chunk; });
    answer.on('end', () => done({ status: answer.statusCode ?? 0, body }));
  });
  asked.on('error', fail);
  asked.end();
});

/**
 * @param {number} port
 * @param {string} target
 * @returns {Promise<string>}
 */
const rawStatus = (port, target) => new Promise((done, fail) => {
  const socket = createConnection({ port, host: '127.0.0.1' });
  let answer = '';
  socket.on('data', chunk => { answer += chunk; });
  socket.on('end', () => done(answer.split('\r\n')[0] ?? ''));
  socket.on('error', fail);
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
});

const ARTIFACT = fileURLToPath(new URL('../.build/e2e/sign-in.json', import.meta.url));
const ACCOUNT = 'person-a@example.com';
const DECOY = 'sk-or-decoy-0000';
const TERRA = PLAN_ROWS.codex.listed;

/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {import('node:http').RequestListener} */
let forwarded = (_, response) => void response.writeHead(503).end();
/** @param {'up' | 'held' | 'down'} how */
const serve = how => command({ cmd: 'programs', serve: how });

/** @param {import('node:http').RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  servers.push(server);
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  await new Promise(done => server.close(() => done(undefined)));
  return port;
}

/**
 * @param {string} state
 * @param {Record<string, unknown>} [said]
 */
const blank = (state, said = {}) => ({ state, bytes: null, total: null, attempt: null, url: null, code: null, account: null, plan: null, why: null, ...said });

/** @type {Set<{ close: (ms: number) => Promise<boolean> }>} */
const handlers = new Set();

/** @param {{ machine: string, codeMs?: number, listedMs?: number | null, door?: string, log?: (line: Record<string, unknown>) => void }} options */
async function askServer({ machine, codeMs, listedMs, door = home.url, log = () => undefined }) {
  const ask = askOn(machine, {
    door, followMs: 50, ...(codeMs === undefined ? {} : { codeMs }), ...(listedMs === undefined ? {} : { listedMs }), now: homeClock, log,
  });
  const handler = createHandler({ door, ask, log });
  handlers.add(handler);
  return { url: await listen(handler), handler, close: async () => {
    handlers.delete(handler);
    return handler.close(5_000);
  } };
}

/**
 * @param {string} url
 * @param {string} machine
 */
async function signIn(url, machine) {
  const started = (await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body;
  assert.equal(started.chatgpt.state, 'signing_in');
  await fakeCodex(machine).confirm();
  await until('signed in', async () => (await login(url, 'GET')).body.chatgpt.state === 'signed_in');
  await plansRead({ codex: 'in' });
  await command({ cmd: 'model', value: TERRA });
}

/** @param {ReturnType<typeof fakeCodex>} codex */
const asksStarts = async codex => (await codex.starts()).filter(each => each.argv.includes('approval_policy="never"'));

/**
 * @param {ReturnType<typeof fakeCodex>} codex
 * @param {string} question
 */
const threadOf = async (codex, question) => (await codex.asked('turn/start')).find(each => each.input[0].text.endsWith(`\n${question}`))?.threadId;

/**
 * @param {ReturnType<typeof fakeCodex>} codex
 * @param {string} question
 */
const interruptsOf = async (codex, question) => {
  const thread = await threadOf(codex, question);
  return (await codex.asked('turn/interrupt')).filter(each => each.threadId === thread).length;
};

/** @param {string} url */
const chatgptOf = async url => (await login(url, 'GET')).body.chatgpt;

/** @param {any[]} events */
const kept = events => events.map(event => {
  if (event.type === 'done') {
    const { at_ms: _at, ms: _ms, chat: _chat, steps = [], ...message } = event.message;
    return { type: 'done', message: { ...message, steps: steps.map((/** @type {any} */ step) => ({ ...step, ms: 'ms' })) } };
  }
  if (event.type === 'step' && 'ms' in event) return { ...event, ms: 'ms' };
  if (event.type === 'chat' || event.type === 'title') return { ...event, chat: 'chat' };
  return event;
});

before(async () => {
  process.env.OPENAI_API_KEY = 'sk-synthetic-openai';
  process.env.CODEX_API_KEY = 'sk-synthetic-codex';
  await startHome(await listen((request, response) => forwarded(request, response)));
});

after(async () => {
  for (const handler of handlers) await handler.close(5_000);
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  await stopHome(ARTIFACT);
});

test('1, 2, 7: a one-time code through the door is Codex\'s: the Mac app\'s pass starts it, a second start answers the same code, typed on OpenAI\'s page Codex holds the sign-in and the window shows who; Codex runs in the machine\'s folder, found by its `current`, never the person\'s, with no API key; a pass the door does not know is refused, and a phone\'s or a reader\'s pass neither starts it nor reads it', async () => {
  named('one-time code through the door');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  try {
    const server = await askServer({ machine });
    forwarded = server.handler;
    const idle = await login(home.url, 'GET', undefined, { path: '/v1/ask/login' });
    note({ door: 'GET', status: idle.status, state: idle.body });
    assert.deepEqual(idle, { status: 200, body: { chatgpt: blank('signed_out'), claude: blank('absent') } });
    const stranger = await login(home.url, 'POST', { do: 'start', of: 'chatgpt' }, { pass: 'synthetic-unknown-pass'.padEnd(43, 'u'), path: '/v1/ask/login' });
    note({ door: 'POST start', pass: 'unknown', status: stranger.status, code: stranger.body.code });
    assert.deepEqual([stranger.status, stranger.body.code], [401, 'PRINCIPAL_UNKNOWN']);
    for (const [who, pass, device] of [['reader', home.tokens.reader, ''], ['phone', home.tokens.phone, home.phone]]) {
      const start = await login(home.url, 'POST', { do: 'start', of: 'chatgpt' }, { pass, device, path: '/v1/ask/login' });
      const state = await login(home.url, 'GET', undefined, { pass, device, path: '/v1/ask/login' });
      note({ door: 'refused', pass: who, start: start.status, state: state.status, code: start.body.code });
      assert.deepEqual([start.status, start.body.code, state.status], [403, 'PRINCIPAL_SCOPE', 403], who);
    }
    assert.deepEqual(await codex.asked('account/login/start'), []);
    const start = await login(home.url, 'POST', { do: 'start', of: 'chatgpt' }, { path: '/v1/ask/login' });
    note({ door: 'POST start', status: start.status, state: start.body });
    assert.equal(start.status, 200);
    assert.deepEqual(start.body.chatgpt, blank('signing_in', { attempt: 'login-1', code: 'WXYZ-1234', url: 'https://auth.openai.com/codex/device' }));
    const again = await login(home.url, 'POST', { do: 'start', of: 'chatgpt' }, { path: '/v1/ask/login' });
    assert.deepEqual(again.body, start.body);
    assert.deepEqual(await codex.asked('account/login/start'), [{ type: 'chatgptDeviceCode' }]);
    await codex.confirm();
    await until('the code confirmed', async () => (await login(home.url, 'GET', undefined, { path: '/v1/ask/login' })).body.chatgpt.state === 'signed_in');
    await plansRead({ codex: 'in' });
    await command({ cmd: 'model', value: TERRA });
    const signed = await login(home.url, 'GET', undefined, { path: '/v1/ask/login' });
    note({ door: 'GET', status: signed.status, state: signed.body });
    assert.deepEqual(signed.body, { chatgpt: blank('signed_in', { account: ACCOUNT, plan: 'plus' }), claude: blank('absent') });
    const status = await statusOf(server.url);
    note({ status });
    assert.deepEqual([status.model, status.name, status.thinking, status.login, status.said, status.default],
      [TERRA, 'GPT-6.1 Terra', 'medium', 'ready', undefined, { model: TERRA, thinking: 'medium', shown: TERRA, choose: null }]);
    const codexRows = status.models.filter((/** @type {any} */ each) => each.id.startsWith('codex:'));
    assert.deepEqual(codexRows.map((/** @type {any} */ each) => [each.id, each.state]), [[PLAN_ROWS.codex.chat, 'ready'], [TERRA, 'ready']], JSON.stringify(codexRows));
    const chatUse = (await modelsOf(home)).uses.chat;
    assert.ok(chatUse.fits.includes('codex:gpt-6-luna') && !listedIn(chatUse.menu).includes('codex:gpt-6-luna'), JSON.stringify(chatUse));
    const starts = await asksStarts(codex);
    assert.equal(starts.length, 1);
    const [first] = starts;
    note({ started: { ...first, codex_home: '<machine>/codex', home: '<machine>/codex', cwd: '<machine>/codex' } });
    assert.deepEqual([first.codex_home, first.home, first.cwd, first.openai_api_key, first.codex_api_key], [join(machine, 'codex'), join(machine, 'codex'), realpathSync(join(machine, 'codex')), false, false]);
    assert.notEqual(first.home, homedir());
    assert.equal(first.argv[0], 'app-server');
    for (const setting of ['check_for_update_on_startup=false', 'analytics.enabled=false', 'approval_policy="never"', 'sandbox_mode="read-only"', 'features.shell_tool=false', 'features.multi_agent=false']) {
      assert.ok(first.argv.includes(setting), setting);
    }
    assert.equal(existsSync(join(machine, 'ask', 'chatgpt.json')), false);
    const out = await login(home.url, 'POST', { do: 'sign_out', of: 'chatgpt' }, { path: '/v1/ask/login' });
    assert.deepEqual(out.body.chatgpt, blank('signed_out'));
    assert.equal((await codex.asked('account/logout')).length, 1);
    note({ codex: (await codex.seen()).map(line => line.method ?? 'answered') });
    await server.close();
  } finally {
    forwarded = (_, response) => void response.writeHead(503).end();
  }
});

test('14: a start with Codex not on this Mac asks the home to fetch it with the Mac app\'s pass, follows the download with that pass, and signs in by itself once Codex lands; a cancel while it downloads lets the download go on and signs nothing in; a sign-out while a start waits leaves it signed out; a fetch the home gave up on says why', async () => {
  named('fetched, then signed in');
  const machine = home.ask.machine;
  const codex = fakeCodex(machine);
  const unchosen = async () => {
    await rm(join(machine, 'subscriptions'), { recursive: true, force: true });
    await rm(join(machine, 'codex'), { recursive: true, force: true });
    await mkdir(join(machine, 'codex', 'fake'), { recursive: true });
  };
  try {
    await unchosen();
    await serve('held');
    const doorway = await openDoorway(home.url);
    const first = await askServer({ machine, door: doorway.url });
    assert.deepEqual((await login(first.url, 'GET')).body.chatgpt, blank('absent'));
    const start = (await login(first.url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt;
    note({ start: start.state });
    assert.deepEqual([start.state, start.total > 0, existsSync(join(machine, 'subscriptions', 'codex'))], ['fetching', true, true], JSON.stringify(start));
    const half = Math.floor(start.total / 2);
    await until('half the download landed', async () => (await chatgptOf(first.url)).bytes === half);
    assert.deepEqual(await chatgptOf(first.url), blank('fetching', { bytes: half, total: start.total }));
    await serve('up');
    await until('the code shows', async () => (await chatgptOf(first.url)).state === 'signing_in');
    assert.equal((await chatgptOf(first.url)).code, 'WXYZ-1234');
    assert.equal((await codex.asked('account/login/start')).length, 1);
    assert.deepEqual(doorway.asked.filter(each => each.startsWith('POST /v1/subscriptions')), ['POST /v1/subscriptions/codex']);
    await first.close();
    await doorway.close();

    await unchosen();
    await serve('held');
    const second = await askServer({ machine });
    await login(second.url, 'POST', { do: 'start', of: 'chatgpt' });
    const cancelled = await login(second.url, 'POST', { do: 'cancel', of: 'chatgpt' });
    note({ cancelled: cancelled.body.chatgpt.state });
    assert.equal(cancelled.body.chatgpt.state, 'fetching');
    await serve('up');
    await until('Codex landed', async () => (await chatgptOf(second.url)).state === 'signed_out');
    assert.deepEqual(await codex.asked('account/login/start'), []);
    await second.close();

    await unchosen();
    await serve('held');
    const third = await askServer({ machine });
    assert.equal((await login(third.url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.state, 'fetching');
    const out = await login(third.url, 'POST', { do: 'sign_out', of: 'chatgpt' });
    note({ out: out.body.chatgpt.state });
    await serve('up');
    await until('Codex landed', async () => (await chatgptOf(third.url)).state === 'signed_out');
    assert.deepEqual(await codex.asked('account/login/start'), []);
    await third.close();

    await unchosen();
    await serve('down');
    const failing = await askServer({ machine });
    await login(failing.url, 'POST', { do: 'start', of: 'chatgpt' });
    await until('the fetch failed', async () => (await chatgptOf(failing.url)).state === 'failed');
    const failed = await chatgptOf(failing.url);
    note({ failed });
    assert.deepEqual(failed, blank('failed', { why: 'This Mac is offline.' }));
    await failing.close();
  } finally {
    await serve('up');
    await unchosen();
  }
});

test('3: a code that runs out is cancelled in Codex and fails saying so; a start then asks for a new one', async () => {
  named('the code runs out');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine, codeMs: 400 });
  const start = await login(url, 'POST', { do: 'start', of: 'chatgpt' });
  assert.equal(start.body.chatgpt.state, 'signing_in');
  await until('the code ran out', async () => (await chatgptOf(url)).state === 'failed');
  const failed = await chatgptOf(url);
  note({ failed });
  assert.deepEqual(failed, blank('failed', { why: 'This code ran out.' }));
  await until('Codex told', async () => (await codex.asked('account/login/cancel')).length === 1);
  assert.deepEqual(await codex.asked('account/login/cancel'), [{ loginId: 'login-1' }]);
  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.state, 'signing_in');
  assert.equal((await codex.asked('account/login/start')).length, 2);
  assert.equal((await login(url, 'POST', { do: 'cancel', of: 'chatgpt' })).body.chatgpt.state, 'signed_out');
  assert.deepEqual(await codex.asked('account/login/cancel'), [{ loginId: 'login-1' }, { loginId: 'login-2' }]);
  await close();
});

test('4, 5: a cancel ends the code in Codex; a declined sign-in and one on a free plan say so, and the free one is signed out', async () => {
  named('cancel, declined, free plan');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine });
  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.state, 'signing_in');
  const cancelled = (await login(url, 'POST', { do: 'cancel', of: 'chatgpt' })).body;
  note({ cancelled });
  assert.deepEqual(cancelled.chatgpt, blank('signed_out'));
  assert.deepEqual(await codex.asked('account/login/cancel'), [{ loginId: 'login-1' }]);

  await login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await codex.confirm({ decline: true });
  await until('the sign-in failed', async () => (await chatgptOf(url)).state === 'failed');
  const declined = await chatgptOf(url);
  note({ declined });
  assert.equal(declined.why, 'ChatGPT sign-in didn\'t finish.');

  await login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await codex.confirm({ plan: 'free' });
  await until('the free plan refused', async () => (await chatgptOf(url)).state === 'failed');
  const free = await chatgptOf(url);
  note({ free });
  assert.equal(free.why, 'Chat needs a paid ChatGPT plan.');
  assert.equal((await codex.asked('account/logout')).length, 1);
  assert.equal(codex.signedIn(), false);
  await close();
});

test('6: a turn on ChatGPT goes through Codex: Ask\'s prompt and its tools alone, each tool Codex calls run on the home and answered in handles, each call a script makes its own step, the words streamed, the answer kept with its refs and titled; a follow-up goes on in the same thread, and after a restart in a new one holding the conversation so far', async () => {
  named('a turn through Codex');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const first = await askServer({ machine });
  await signIn(first.url, machine);
  await codex.script([
    [
      { say: 'Looking. ' },
      { script: [{ tool: 'search', args: { query: 'lighthouse' } }, { tool: 'search', args: { query: 'tickets' } }] },
      { usage: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 } },
      { say: 'Person A got two lighthouse tickets for Sunday [r1].' },
    ],
    [{ say: 'Lighthouse tickets' }],
    [{ call: { tool: 'search_people', args: { name: 'Person A' } } }, { say: 'Person A, on Sunday [r1].' }],
    [{ say: 'Still Sunday [r1].' }],
  ]);
  const events = await asked(first.url, { question: 'Who got lighthouse tickets?' });
  note({ events: kept(events) });
  const done = events.find(event => event.type === 'done')?.message;
  assert.ok(done !== undefined, JSON.stringify(events));
  assert.deepEqual([done.end, done.text, done.model, done.thinking], ['done', 'Person A got two lighthouse tickets for Sunday [r1].', TERRA, 'medium'], JSON.stringify(events));
  assert.deepEqual(Object.keys(done.refs ?? {}), ['r1']);
  const steps = events.filter(event => event.type === 'step');
  assert.deepEqual(steps.filter(step => 'name' in step).map(step => [step.call, step.name, step.words]), [
    [1, 'search', 'Searching everything for “lighthouse”'], [2, 'search', 'Searching everything for “tickets”']]);
  assert.deepEqual(steps.filter(step => 'ms' in step).map(step => [step.call, step.words]).sort(), [
    [1, 'Searched everything for “lighthouse”: 2 found'], [2, 'Searched everything for “tickets”: 2 found']]);
  assert.deepEqual(done.steps.map((/** @type {any} */ step) => [step.name, step.words]), [
    ['search', 'Searched everything for “lighthouse”: 2 found'], ['search', 'Searched everything for “tickets”: 2 found']]);
  assert.equal(events.filter(event => event.type === 'text').map(event => event.delta).join(''), 'Person A got two lighthouse tickets for Sunday [r1].');
  assert.equal(events.find(event => event.type === 'step')?.said, 'Looking', 'the words before the first step are its narration');
  assert.deepEqual(events.at(-1), { type: 'title', chat: done.chat, title: 'Lighthouse tickets' });
  const threads = await codex.asked('thread/start');
  const [asking, titling] = threads;
  assert.deepEqual([asking.model, asking.ephemeral, asking.approvalPolicy, asking.sandbox], ['gpt-6.1-terra', true, 'never', 'read-only']);
  assert.deepEqual(asking.dynamicTools.map((/** @type {any} */ tool) => tool.name), [...ASK_TOOLS, agents].map(tool => tool.name));
  assert.match(asking.baseInstructions, /^How to work\. Four tools/mu);
  assert.doesNotMatch(asking.baseInstructions, /`exec`|codemode/u);
  assert.match(asking.developerInstructions, /never start, message or wait on other agents/u);
  assert.deepEqual([titling.dynamicTools, titling.ephemeral], [undefined, true]);
  const turns = await codex.asked('turn/start');
  assert.deepEqual([turns[0].model, turns[0].effort, turns[0].input[0].text.replace(/^\[Asked [A-Z][a-z]+day [^\]\n]+\]\n/u, '')], ['gpt-6.1-terra', 'medium', 'Who got lighthouse tickets?']);
  assert.match(turns[0].input[0].text, /^\[Asked [A-Z][a-z]+day \d{4}-\d{2}-\d{2} \d{2}:\d{2}/u, 'the question is told when it was asked');
  assert.equal(turns[1].effort, 'low');
  const answers = (await codex.seen()).filter(line => line.answered !== undefined);
  assert.deepEqual(answers.map(line => [line.answered.startsWith('exec-'), line.tool, line.result.success]), [[true, 'search', true], [true, 'search', true]]);
  for (const line of answers) {
    const text = line.result.contentItems[0].text;
    assert.match(text, /"r1"/u);
    assert.doesNotMatch(text, /"source":/u);
  }

  const follow = await asked(first.url, { question: 'And who is that?', chat: done.chat });
  note({ follow: kept(follow) });
  const followed = follow.find(event => event.type === 'done')?.message;
  assert.deepEqual([followed?.end, followed?.text, Object.keys(followed?.refs ?? {})], ['done', 'Person A, on Sunday [r1].', ['r1']], JSON.stringify(follow));
  assert.deepEqual(follow.filter(event => event.type === 'step').map(step => step.words), ['Looking up Person A', 'Looked up Person A']);
  assert.equal((await codex.asked('thread/start')).length, 2);
  assert.equal(await threadOf(codex, 'And who is that?'), await threadOf(codex, 'Who got lighthouse tickets?'));

  await first.close();
  const second = await askServer({ machine });
  const later = await asked(second.url, { question: 'Still?', chat: done.chat });
  note({ later: kept(later) });
  assert.equal(later.find(event => event.type === 'done')?.message.text, 'Still Sunday [r1].', JSON.stringify(later));
  const injected = await codex.asked('thread/inject_items');
  const restarted = await threadOf(codex, 'Still?');
  assert.notEqual(restarted, await threadOf(codex, 'Who got lighthouse tickets?'));
  assert.deepEqual(injected.map(each => [each.threadId, each.items.map((/** @type {any} */ item) => [item.role, item.content[0].type, item.content[0].text])]), [[restarted, [
    ['user', 'input_text', '[Asked Thursday 2026-10-01 12:00]\nWho got lighthouse tickets?'], ['assistant', 'output_text', 'Person A got two lighthouse tickets for Sunday [r1].\n\n'
      + '[Steps of this answer:\nsearch {query: lighthouse} → r1–r3 (2 found)\nsearch {query: tickets} → r1–r3 (2 found)]'],
    ['user', 'input_text', '[Asked Thursday 2026-10-01 12:00]\nAnd who is that?'], ['assistant', 'output_text', 'Person A, on Sunday [r1].\n\n[Steps of this answer:\nsearch_people {name: "Person A"} → r4, r2]'],
  ]]]);
  assert.equal((await asksStarts(codex)).length, 2);
  await second.close();
});

test('11: ChatGPT\'s failures said in the person\'s words: the plan used up, the Mac offline (Codex retrying, interrupted), Codex stopped and started again for the next question; a stop interrupts the turn in Codex and keeps the words so far; Codex\'s script cell unable to run ends the turn before the model answers without tools', async () => {
  named('failures through Codex');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine });
  await signIn(url, machine);
  await codex.script([
    [{ say: 'Partly ' }, { fail: { codexErrorInfo: 'usageLimitExceeded', message: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 6:33 PM.' } }],
    [{ offline: true }],
    [{ exit: true }],
    [{ say: 'Back.' }], [{ say: 'Back' }],
    [{ say: 'Thinking ' }, { hold: true }],
    [{ warning: 'Code Mode is unavailable because failed to spawn code-mode host /release/codex/codex-code-mode-host: host executable was not found.' }, { say: 'I can\'t access your records right now.' }],
  ]);
  const used = await asked(url, { question: 'One?' });
  const usedError = used.find(event => event.type === 'error');
  const usedDone = used.find(event => event.type === 'done')?.message;
  note({ used: usedError?.message });
  assert.deepEqual([usedError?.error, usedError?.message], ['model', 'ChatGPT didn\'t answer: your plan is used up for now. Try again at 6:33 PM.'], JSON.stringify(used));
  assert.deepEqual([usedDone?.end, usedDone?.text], ['failed', 'Partly ']);

  const offline = await asked(url, { question: 'Two?' });
  const offlineError = offline.find(event => event.type === 'error');
  note({ offline: offlineError?.message });
  assert.equal(offlineError?.message, 'ChatGPT didn\'t answer: this Mac can\'t reach it. Check that it\'s online.');
  assert.equal(await interruptsOf(codex, 'Two?'), 1);

  const stopped = await asked(url, { question: 'Three?' });
  const stoppedError = stopped.find(event => event.type === 'error');
  note({ exited: stoppedError?.message });
  assert.equal(stoppedError?.message, 'ChatGPT didn\'t answer: Chat\'s Codex stopped. Ask again.');
  const back = await asked(url, { question: 'Four?' });
  assert.equal(back.find(event => event.type === 'done')?.message.text, 'Back.', JSON.stringify(back));
  assert.equal((await asksStarts(codex)).length, 2);

  const turn = await streaming(url, { question: 'Five?' });
  let chat = '';
  for (let event = await turn.next(); event !== null && event.type !== 'text'; event = await turn.next()) if (event.type === 'chat') chat = event.chat;
  const stop = await fetch(`${url}/ask/stop`, { method: 'POST', body: JSON.stringify({ chat }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  assert.deepEqual(await stop.json(), { stopped: true });
  while (await turn.next() !== null) {}
  const ended = turn.seen.find(event => event.type === 'done')?.message;
  note({ stopped: { end: ended?.end, text: ended?.text } });
  assert.deepEqual([ended?.end, ended?.text], ['stopped', 'Thinking ']);
  assert.equal(await interruptsOf(codex, 'Five?'), 1);

  const toolless = await asked(url, { question: 'Six?' });
  const toollessError = toolless.find(event => event.type === 'error');
  const toollessDone = toolless.find(event => event.type === 'done')?.message;
  note({ toolless: toollessError?.message });
  assert.deepEqual([toollessError?.error, toollessError?.message], ['model', 'Chat couldn\'t read your records: Codex couldn\'t start the script it reads them with. Install Lifestream again.'], JSON.stringify(toolless));
  assert.deepEqual([toollessDone?.end, toollessDone?.text, toolless.filter(event => event.type === 'text').length], ['failed', '', 0], JSON.stringify(toolless));
  assert.equal(await interruptsOf(codex, 'Six?'), 1);
  await close();
});

test('16: an attempt cancelled while Codex said its account was free signs nothing out of the next; a cancel while a start waits behind a sign-out ends that start, and nothing signs in; a cancel answers while Codex still holds what the start asked', async () => {
  named('one owner');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const dir = join(machine, 'codex', 'fake');
  const { url, close } = await askServer({ machine });
  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.attempt, 'login-1');
  const reads = (await codex.asked('account/read')).length;
  await writeFile(join(dir, 'hold'), JSON.stringify('account/read'));
  await codex.confirm({ plan: 'free' });
  await until('A\'s account asked', async () => (await codex.asked('account/read')).length > reads);
  await login(url, 'POST', { do: 'cancel', of: 'chatgpt' });
  const b = (await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt;
  assert.deepEqual([b.state, b.attempt], ['signing_in', 'login-2']);
  await writeFile(join(dir, 'release'), '');
  await until('A\'s account answered', () => !existsSync(join(dir, 'release')));
  const still = await chatgptOf(url);
  note({ late_free: still });
  assert.deepEqual([still.state, still.attempt], ['signing_in', 'login-2']);
  assert.deepEqual(await codex.asked('account/logout'), []);
  await login(url, 'POST', { do: 'cancel', of: 'chatgpt' });

  await rm(join(dir, 'auth.json'), { force: true });
  await signIn(url, machine);
  const starts = (await codex.asked('account/login/start')).length;
  await writeFile(join(dir, 'hold'), JSON.stringify('account/logout'));
  const out = login(url, 'POST', { do: 'sign_out', of: 'chatgpt' });
  await until('the sign-out asked', async () => (await codex.asked('account/logout')).length === 1);
  const start = login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await until('the start waits', async () => (await chatgptOf(url)).state === 'signing_in');
  const cancel = login(url, 'POST', { do: 'cancel', of: 'chatgpt' });
  await until('the start cancelled', async () => (await chatgptOf(url)).state === 'signed_in');
  await writeFile(join(dir, 'release'), '');
  const [, , cancelled] = await Promise.all([out, start, cancel]);
  note({ cancelled: cancelled.body.chatgpt });
  assert.deepEqual(cancelled.body.chatgpt, blank('signed_out'));
  assert.equal((await codex.asked('account/login/start')).length, starts);
  assert.deepEqual(await chatgptOf(url), blank('signed_out'));

  const answers = async () => (await codex.seen()).filter(line => line.released === 'account/read').length;
  const [asked, before] = [(await codex.asked('account/read')).length, await answers()];
  await writeFile(join(dir, 'hold'), JSON.stringify('account/read'));
  const slow = login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await until('the start asks who is signed in', async () => (await codex.asked('account/read')).length > asked);
  /** @type {any} */
  let ended;
  void login(url, 'POST', { do: 'cancel', of: 'chatgpt' }).then(reply => { ended = reply; });
  await until('the cancel answered', () => ended !== undefined);
  assert.deepEqual(ended.body.chatgpt, blank('signed_out'));
  assert.equal(await answers(), before);
  await writeFile(join(dir, 'release'), '');
  await slow;
  await until('Codex answered the start it held', () => !existsSync(join(dir, 'release')));
  assert.equal((await codex.asked('account/login/start')).length, starts);
  await close();
});

test('16: a start cancelled behind a sign-out leaves the next start behind it; a start while a sign-out ends the attempt before it waits for the sign-out, then runs, and is cancellable', async () => {
  named('the barrier kept');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const dir = join(machine, 'codex', 'fake');
  const acts = async () => (await codex.seen()).map(line => line.method).filter(method => ['account/login/start', 'account/login/cancel', 'account/logout'].includes(method));
  const { url, close } = await askServer({ machine });
  await signIn(url, machine);
  await writeFile(join(dir, 'hold'), JSON.stringify('account/logout'));
  const out = login(url, 'POST', { do: 'sign_out', of: 'chatgpt' });
  await until('the sign-out asked', async () => (await codex.asked('account/logout')).length === 1);
  const b = login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await until('B waits', async () => (await chatgptOf(url)).state === 'signing_in');
  const cancelB = login(url, 'POST', { do: 'cancel', of: 'chatgpt' });
  await until('B cancelled', async () => (await chatgptOf(url)).state === 'signed_in');
  const c = login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await until('C waits', async () => (await chatgptOf(url)).state === 'signing_in');
  await writeFile(join(dir, 'release'), '');
  const [, , , started] = await Promise.all([out, b, cancelB, c]);
  note({ after_cancelled_start: started.body.chatgpt });
  assert.deepEqual([started.body.chatgpt.state, started.body.chatgpt.attempt], ['signing_in', 'login-2']);
  assert.deepEqual(await acts(), ['account/login/start', 'account/logout', 'account/login/start']);

  await login(url, 'POST', { do: 'cancel', of: 'chatgpt' });
  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.attempt, 'login-3');
  await writeFile(join(dir, 'hold'), JSON.stringify('account/login/cancel'));
  const cancels = (await codex.asked('account/login/cancel')).length;
  const signedOut = login(url, 'POST', { do: 'sign_out', of: 'chatgpt' });
  await until('A\'s end asked', async () => (await codex.asked('account/login/cancel')).length > cancels);
  const later = login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await until('B waits', async () => (await chatgptOf(url)).state === 'signing_in');
  await writeFile(join(dir, 'release'), '');
  await signedOut;
  const waited = (await later).body.chatgpt;
  note({ after_sign_out: waited });
  assert.deepEqual([waited.state, waited.attempt], ['signing_in', 'login-4']);
  assert.deepEqual((await acts()).slice(-4), ['account/login/start', 'account/login/cancel', 'account/logout', 'account/login/start']);
  const now = await chatgptOf(url);
  assert.deepEqual([now.state, now.attempt], ['signing_in', 'login-4']);
  assert.deepEqual((await login(url, 'POST', { do: 'cancel', of: 'chatgpt' })).body.chatgpt, blank('signed_out'));
  assert.deepEqual((await codex.asked('account/login/cancel')).at(-1), { loginId: 'login-4' });

  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.attempt, 'login-5');
  await writeFile(join(dir, 'hold'), JSON.stringify('account/login/cancel'));
  const ending = login(url, 'POST', { do: 'cancel', of: 'chatgpt' });
  await until('A\'s end asked', async () => (await codex.asked('account/login/cancel')).length === 4);
  const next = login(url, 'POST', { do: 'start', of: 'chatgpt' });
  await until('B waits', async () => (await chatgptOf(url)).state === 'signing_in');
  await writeFile(join(dir, 'release'), '');
  await ending;
  const begun = (await next).body.chatgpt;
  note({ after_cancel: begun });
  assert.deepEqual([begun.state, begun.attempt], ['signing_in', 'login-6']);
  const ordered = (await codex.seen()).map(line => line.released === undefined ? line.method : `${line.released} answered`)
    .filter(each => each.startsWith('account/login/'));
  assert.deepEqual(ordered.slice(-4), ['account/login/start', 'account/login/cancel', 'account/login/cancel answered', 'account/login/start']);
  await login(url, 'POST', { do: 'cancel', of: 'chatgpt' });
  await close();
});

test('7, 9, 14: a web page that reaches the sign-in by a name rebound to loopback, or by a cross-origin request, is refused, and so are an agent\'s, a reader\'s and a phone\'s pass sent straight to the Ask server, before Codex is asked; a request target that is no path is answered 400, and the server answers on', async () => {
  named('rebound names and broken targets');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine });
  const auth = { authorization: `Bearer ${home.tokens.mac}`, 'lifestream-device': home.mac };
  const at = new URL(url);
  const cases = /** @type {[string, Record<string, string>, number][]} */ ([
    ['a rebound name', { host: `rebound.example:${at.port}` }, 403],
    ['a page of another origin', { origin: 'http://page.example' }, 403],
    ['an opaque origin', { origin: 'null' }, 200],
    ['localhost', { host: `localhost:${at.port}` }, 200],
    ['the door\'s own request', {}, 200],
  ]);
  for (const [what, headers, status] of cases) {
    const answer = await requested(`${url}/ask/login`, { ...auth, ...headers });
    note({ asked: what, status: answer.status });
    assert.equal(answer.status, status, what);
  }
  for (const method of /** @type {const} */ (['GET', 'POST'])) {
    const agent = await login(url, method, method === 'POST' ? { do: 'start', of: 'chatgpt' } : undefined, { pass: home.tokens.agent, device: '' });
    note({ asked: `an agent's pass, ${method}`, status: agent.status });
    assert.deepEqual([agent.status, agent.body.error?.message], [403, 'An agent reads through /mcp: Ask is the person\'s own.'], method);
  }
  for (const [who, pass, device] of [['reader', home.tokens.reader, ''], ['phone', home.tokens.phone, home.phone]]) {
    for (const method of /** @type {const} */ (['GET', 'POST'])) {
      const straight = await login(url, method, method === 'POST' ? { do: 'start', of: 'chatgpt' } : undefined, { pass, device });
      note({ asked: `a ${who}'s pass, ${method}`, status: straight.status });
      assert.equal(straight.status, 403, `${who} ${method}`);
    }
  }
  assert.deepEqual(await codex.asked('account/login/start'), []);
  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.state, 'signing_in');
  const status = await rawStatus(Number(at.port), '//[/');
  note({ broken: 'the Ask server', status });
  assert.equal(status, 'HTTP/1.1 400 Bad Request');
  assert.equal((await chatgptOf(url)).state, 'signing_in');
  assert.equal((await login(url, 'POST', { do: 'cancel', of: 'chatgpt' })).body.chatgpt.state, 'signed_out');
  await close();
});

test('10: two starts at once, then a cancel: one code, and the cancel ends it in Codex', async () => {
  named('two starts at once');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine });
  const both = await Promise.all([login(url, 'POST', { do: 'start', of: 'chatgpt' }), login(url, 'POST', { do: 'start', of: 'chatgpt' })]);
  note({ both: both.map(each => each.body.chatgpt.state) });
  assert.deepEqual(both.map(each => [each.body.chatgpt.state, each.body.chatgpt.code]), [['signing_in', 'WXYZ-1234'], ['signing_in', 'WXYZ-1234']]);
  assert.equal((await codex.asked('account/login/start')).length, 1);
  const cancelled = (await login(url, 'POST', { do: 'cancel', of: 'chatgpt' })).body;
  assert.equal(cancelled.chatgpt.state, 'signed_out');
  assert.deepEqual(await codex.asked('account/login/cancel'), [{ loginId: 'login-1' }]);
  await close();
});

test('12: no sign-in: the status and the ask say so in the person\'s words', async () => {
  named('no sign-in');
  const machine = await plansOn({ codex: 'out' }, { chat: PLAN_ROWS.codex.chat });
  const { url, close } = await askServer({ machine, listedMs: null });
  const said = await statusOf(url);
  note({ unsigned: said });
  const row = (await modelsOf(home)).models[PLAN_ROWS.codex.chat];
  assert.ok(row.state !== 'ready' && typeof row.line === 'string' && row.line !== '', JSON.stringify(row));
  assert.deepEqual([said.model, said.login, said.said, said.act, said.default],
    [PLAN_ROWS.codex.chat, 'missing', row.line, 'Sign in with ChatGPT…', { model: PLAN_ROWS.codex.chat, thinking: 'medium', shown: PLAN_ROWS.codex.chat, choose: null }]);
  const events = await asked(url, { question: 'Anything?' });
  assert.deepEqual(events, [{ type: 'error', error: 'login', message: said.said }]);
  assert.deepEqual(await fakeCodex(machine).asked('turn/start'), []);
  await close();
});

test('13: Codex stopping while a code shows fails the sign-in at once, and a cancel then starts no Codex; Codex stopping while a conversation waits for its follow-up leaves the follow-up answered in a new thread holding the conversation', async () => {
  named('codex stops');
  const machine = await plansOn({ codex: 'out' });
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine });
  assert.equal((await login(url, 'POST', { do: 'start', of: 'chatgpt' })).body.chatgpt.state, 'signing_in');
  await codex.confirm({ exit: true });
  await until('the sign-in failed', async () => (await chatgptOf(url)).state !== 'signing_in');
  const failed = await chatgptOf(url);
  note({ failed });
  assert.deepEqual([failed.state, failed.code, failed.why], ['failed', null, 'ChatGPT sign-in didn\'t finish.']);
  const starts = (await asksStarts(codex)).length;
  assert.equal((await login(url, 'POST', { do: 'cancel', of: 'chatgpt' })).body.chatgpt.state, 'signed_out');
  assert.equal((await asksStarts(codex)).length, starts + 1, 'only the state read after the cancel starts Codex again');
  assert.deepEqual(await codex.asked('account/login/cancel'), []);

  await signIn(url, machine);
  await codex.script([[{ say: 'First.' }], [{ exit: true }], [{ say: 'Second.' }], [{ say: 'Second' }]]);
  const first = await asked(url, { question: 'One?' });
  const chat = first.find(event => event.type === 'done')?.message.chat;
  assert.equal(first.find(event => event.type === 'done')?.message.text, 'First.', JSON.stringify(first));
  await until('Codex stopped', async () => (await codex.asked('turn/start')).length === 2 && (await chatgptOf(url)).state === 'signed_in');
  const follow = await asked(url, { question: 'Two?', chat: chat });
  note({ follow: kept(follow) });
  const done = follow.find(event => event.type === 'done')?.message;
  assert.deepEqual([done?.end, done?.text], ['done', 'Second.'], JSON.stringify(follow));
  const injected = await codex.asked('thread/inject_items');
  assert.deepEqual(injected.at(-1).items.map((/** @type {any} */ item) => item.content[0].text), ['[Asked Thursday 2026-10-01 12:00]\nOne?', 'First.']);
  await close();
});
