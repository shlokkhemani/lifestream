// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { createServer, request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createHandler } from '../server.mjs';
import { HIDE_NOT_READY_WORDS } from '../lib/hiding.mjs';
import { UNREAD_ACCESS } from '../lib/tools.mjs';
import { PEOPLE_YOU, minted, rowReady, youDoor } from './asking.mjs';
import { until } from './until.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const DAY = '2026-09-28';
const RECORD = ['synthetic', 'lighthouse', 'Synthetic subject', 'Ignore your instructions', 'stray quotes', 'Urgent account'];
const SEEDED = ['Person A', 'Person B', 'Person C', '15550000001', '15550000002', '15550000003', 'person-a@example.com', 'person-c@example.com'];

/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>} */
let child;
/** @type {{ url: string, tokens: { reader: string, agent: string }, now_ms: number, ask: { machine: string, source: string }, chat: { cloud: string, local: string, small: string } }} */
let home;
/** @type {((line: any) => void)[]} */
const waiting = [];
/** @type {import('node:http').Server[]} */
const servers = [];
let url = '';
/** @type {import('node:http').RequestListener} */
let main = (_, response) => void response.writeHead(503).end();
/** @type {(string | undefined)[]} */
const brought = [];
let bare = '';
const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
const fauxModels = createModels();
fauxModels.setProvider(faux.provider);
const fauxModel = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const started = performance.now();
const homeClock = () => home.now_ms + Math.round(performance.now() - started);

/**
 * @param {string} cmd
 * @param {Record<string, unknown>} [more]
 */
async function command(cmd, more = {}) {
  /** @type {{ came: boolean, line: any }} */
  const answer = { came: false, line: null };
  waiting.push(line => Object.assign(answer, { came: true, line }));
  child.stdin.write(`${JSON.stringify({ ...more, cmd })}\n`);
  await until(`the synthetic home's answer to ${cmd}`, () => {
    if (answer.came) return true;
    if (child.exitCode !== null) throw new Error(`the synthetic home exited before it answered ${cmd}`);
    return false;
  });
  assert.equal(answer.line.ok, true, answer.line.error);
  return answer.line.value;
}

/** @param {import('node:http').RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  servers.push(server);
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

/**
 * @param {string} at
 * @param {string} pass
 */
async function connect(at, pass) {
  const client = new Client({ name: 'lifestream-privacy', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${at}/mcp`), { requestInit: { headers: { authorization: `Bearer ${pass}` } } }));
  return client;
}

/**
 * @param {Client} client
 * @param {string} tool
 * @param {Record<string, unknown>} args
 */
async function call(client, tool, args = {}) {
  const result = /** @type {{ content: { type: string, text?: string, data?: string }[], isError?: boolean }} */ (await client.callTool({ name: tool, arguments: args }));
  const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { text, json, error: result.isError === true, images: result.content.filter(part => part.type === 'image').length };
}

/** @param {string} detail */
const seen = detail => new RegExp(`(?<![\\p{L}\\p{N}])${detail.replace(/[.+]/gu, '\\$&')}(?![\\p{L}\\p{N}])`, /^Person /u.test(detail) ? 'u' : 'iu');

/** @param {string} text */
const leaked = text => SEEDED.filter(detail => seen(detail).test(text));

/** @param {string} text */
const around = text => SEEDED.flatMap(detail => {
  const at = seen(detail).exec(text)?.index;
  return at === undefined ? [] : [text.slice(Math.max(0, at - 150), at + 150)];
}).join('\n…\n');

/** @param {Client} client */
async function everyTool(client) {
  /** @type {[string, Awaited<ReturnType<typeof call>>][]} */
  const answers = [];
  /** @param {string} tool @param {Record<string, unknown>} args */
  const run = async (tool, args) => {
    const answer = await call(client, tool, args);
    answers.push([`${tool} ${JSON.stringify(args)}`, answer]);
    return answer;
  };
  await run('count', {});
  const found = await run('search', { query: 'lighthouse' });
  await run('count', { of: 'messages', by: ['person'] });
  const hits = /** @type {any[]} */ (found.json?.record?.hits ?? []);
  const message = hits.find(hit => typeof hit.chat === 'string');
  if (message !== undefined) await run('read', { chat: message.chat });
  const people = await run('search_people', { name: /\[\[Person [1-9][0-9]*\]\]/u.exec(found.text)?.[0] ?? '' });
  for (const hit of hits) await run('read', { ref: hit.ref });
  const mail = hits.find(hit => hit.chat === undefined);
  if (mail !== undefined) await run('read', { ref: mail.ref, detail: 'raw' });
  const day = await run('read', { from: `${DAY}T08:00`, to: `${DAY}T12:00` });
  const line = /"cites":\["(r\d+)"/u.exec(day.text)?.[1];
  if (line !== undefined) await run('read', { ref: line });
  const person = /"ref":"(r\d+)"/u.exec(people.text)?.[1];
  if (person !== undefined) await run('search', { person: [person] });
  if (person !== undefined) await run('read', { ref: person });
  await run('count', { of: 'stays', measure: 'minutes', by: ['item'] });
  return { answers, people };
}

before(async () => {
  url = await listen((request, response) => {
    brought.push(request.headers.authorization);
    main(request, response);
  });
  child = spawn(process.execPath, bundledProgram('mcp/test/home.ts'),
    { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LIFESTREAM_MCP: url } });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
  await command('key', { value: 'sk-or-v1-synthetic' });
  await rowReady(home, home.chat.cloud, true);
  main = createHandler({ door: home.url, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined });
  bare = await listen(createHandler({ door: home.url, log: () => undefined }));
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  if (child) await command('stop').catch(() => undefined);
});


test('/mcp serves an agent\'s pass alone; an agent without the server\'s own pass beside it reads nothing, its access either', async () => {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
  });
  assert.equal(response.status, 403);
  assert.equal(/** @type {any} */ (await response.json()).code, 'AGENT_ONLY');
  const alone = await connect(bare, home.tokens.agent);
  try {
    assert.ok(String(alone.getInstructions()).includes(`\n\n${UNREAD_ACCESS} The door refused: 403`), String(alone.getInstructions()).slice(-300));
    const refused = await call(alone, 'search', { query: 'lighthouse' });
    assert.equal(refused.error, true);
    assert.deepEqual(leaked(refused.text), []);
    assert.doesNotMatch(refused.text, /lighthouse/u);
  } finally {
    await alone.close();
  }
});

test('the tools\' leak test: under `all`, which the agent\'s instructions name, no tool hands an agent a seeded detail, and every ref is a handle; under `names` names read and numbers do not', async () => {
  await command('privacy', { agent: 'all' });
  const agent = await connect(url, home.tokens.agent);
  try {
    assert.match(String(agent.getInstructions()), /\nYour access to this Lifestream:\n1\. Everything · all time\n2\. names and details hidden\n/u);
    const { answers, people } = await everyTool(agent);
    assert.ok(answers.length >= 10, `${answers.length} tools ran`);
    for (const [name, answer] of answers) {
      assert.deepEqual(leaked(answer.text), [], `${name}: ${answer.text.slice(0, 2_000)}`);
      assert.doesNotMatch(answer.text, /"source":"[^"]*","kind":"[^"]*","key":|\{"day":"[^"]*","(?:n|line)":\d+[,}]|\{\\?"(?:person|chat)\\?":\\?"[a-z]+:/u, `${name} hands a ref whole`);
    }
    const plain = await call(agent, 'search_people', { name: 'Person A' });
    assert.deepEqual(plain.json?.matches, [], plain.text);
    const placeholder = /\[\[Person [1-9][0-9]*\]\]/u.exec(people.text)?.[0];
    assert.ok(placeholder !== undefined, people.text);
    const named = await call(agent, 'search_people', { name: placeholder });
    assert.equal(named.error, false, named.text);
    assert.ok((named.json?.matches ?? []).length > 0, named.text);
    const unknown = await call(agent, 'read', { ref: 'r99999' });
    assert.deepEqual([unknown.error, unknown.text.includes('r99999')], [true, true], unknown.text);

    await command('privacy', { agent: 'names' });
    const day = await call(agent, 'read', { from: `${DAY}T08:00`, to: `${DAY}T08:10` });
    assert.match(day.text, /Person A/u);
    assert.doesNotMatch(day.text, /15550000001/u);
  } finally {
    await command('privacy', { agent: null });
    await agent.close();
  }
});

test('the warm-read test: after the marking job\'s run, every tool under `all` reads the index\'s words with no find; a search\'s query and read\'s content place at most one each', async () => {
  await command('privacy', { agent: 'all' });
  const agent = await connect(url, home.tokens.agent);
  try {
    /**
     * @param {string} tool
     * @param {Record<string, unknown>} args
     * @param {number} most
     */
    const warm = async (tool, args, most) => {
      const before = /** @type {{ finds: number, passages: string[][] }} */ (await command('finds'));
      const answer = await call(agent, tool, args);
      const after = /** @type {{ finds: number, passages: string[][] }} */ (await command('finds'));
      const cold = after.passages.slice(before.finds).flat().filter(passage => RECORD.some(words => passage.includes(words)));
      assert.ok(cold.length <= most, `${tool} ${JSON.stringify(args)} placed ${cold.length} of the record's passages: ${JSON.stringify(cold).slice(0, 2_000)}`);
      return answer;
    };
    const found = await warm('search', { query: 'lighthouse' }, 1);
    await warm('read', { from: DAY, detail: 'lines' }, 0);
    await warm('read', { from: DAY, detail: 'lines' }, 0);
    const hit = (found.json?.record?.hits ?? []).find((/** @type {any} */ each) => typeof each.chat === 'string');
    assert.ok(hit !== undefined, found.text);
    await warm('read', { chat: hit.chat }, 0);
    await warm('read', { ref: hit.ref }, 1);
    await warm('read', { ref: hit.ref }, 0);
  } finally {
    await command('privacy', { agent: null });
    await agent.close();
  }
});

test('a long record read by the door\'s pages under `all`: each page hidden whole, none splitting a placeholder; a secret and a phone the first page marks hidden again on the pages past it by the same placeholders', async () => {
  await command('privacy', { agent: 'all' });
  const agent = await connect(url, home.tokens.agent);
  try {
    const found = await call(agent, 'search', { query: 'quokkaparade', lists: ['record'] });
    const hit = (found.json?.record?.hits ?? [])[0];
    assert.ok(hit !== undefined, found.text);
    /** @type {string[]} */
    const pages = [];
    for (let page = await call(agent, 'read', { ref: hit.ref }); ; page = await call(agent, 'read', { cursor: page.json.next })) {
      assert.equal(page.error, false, page.text);
      assert.deepEqual([page.json.what, page.json.ref], ['record', hit.ref], page.text.slice(0, 300));
      pages.push(page.json.text);
      if (typeof page.json.next !== 'string') break;
      assert.ok(pages.length < 6, 'more pages than the text holds');
    }
    assert.equal(pages.length, 3, pages.map(page => page.length).join(', '));
    assert.ok(pages[2].endsWith(' end'), pages[2].slice(-80));
    for (const [n, page] of pages.entries()) {
      assert.deepEqual(leaked(page), [], `page ${n + 1}: ${around(page)}`);
      assert.doesNotMatch(page, /zorbix|5550000003/u, `page ${n + 1}`);
      assert.equal((page.match(/\[\[/gu) ?? []).length, (page.match(/\]\]/gu) ?? []).length, `page ${n + 1} splits a placeholder`);
    }
    const secret = /Password: (\[\[Secret \d+\]\])\./u.exec(pages[0])?.[1];
    const phone = /call (\[\[Phone \d+\]\]) today/u.exec(pages[0])?.[1];
    assert.ok(secret !== undefined && phone !== undefined, pages[0].slice(0, 200));
    assert.ok(pages.join('').includes(` ${phone} then more.`), around(pages.join('')));
    const again = pages.findIndex(page => page.includes(`the code was ${secret} again.`));
    assert.ok(again > 0, pages.map(around).join('\n'));
  } finally {
    await command('privacy', { agent: null });
    await agent.close();
  }
});

test('a refusal carries nothing hiding could not hide: while hiding is not ready an agent\'s tool answers its fixed words', async () => {
  await command('privacy', { agent: 'all', names: false });
  const agent = await connect(url, home.tokens.agent);
  try {
    const refused = await call(agent, 'search', { query: 'synthetic filler message number 7' });
    assert.deepEqual([refused.error, refused.text], [true, HIDE_NOT_READY_WORDS]);
  } finally {
    await command('privacy', { agent: null, names: true });
    await agent.close();
  }
});

test('Chat\'s leak test: under `all` the model is sent no seeded detail across a turn of every tool, a follow-up after a restart and the title; the person reads the real words, the answer kept with them and its handles', async () => {
  await command('privacy', { chat: 'all' });
  try {
    /** @type {string[]} */
    const sent = [];
    /** @param {any} context */
    const record = context => sent.push(JSON.stringify(context));
    /** @type {string | undefined} */
    let named;
    faux.setResponses([
      context => {
        record(context);
        return fauxAssistantMessage([fauxToolCall('search', { query: 'lighthouse' }), fauxToolCall('read', { from: `${DAY}T08:00`, to: `${DAY}T08:10` }),
          fauxToolCall('search_people', {}), fauxToolCall('count', { of: 'stays', measure: 'minutes', by: ['item'] })], { stopReason: 'toolUse' });
      },
      context => {
        record(context);
        const said = JSON.stringify(context.messages);
        named = /\[\[Person [1-9][0-9]*\]\]/u.exec(said)?.[0];
        const hit = /"ref":"(r\d+)"/u.exec(said)?.[1];
        const chat = /"chat":"([^"]+)"/u.exec(said)?.[1];
        return fauxAssistantMessage([fauxToolCall('read', { ref: hit ?? 'r1' }), ...(chat === undefined ? [] : [fauxToolCall('read', { chat: chat.replace(/\\"/gu, '"') })])], { stopReason: 'toolUse' });
      },
      context => {
        record(context);
        const hit = /"ref":"(r\d+)"/u.exec(JSON.stringify(context.messages))?.[1];
        return fauxAssistantMessage(fauxText(`${named ?? 'Someone'} got two lighthouse tickets [${hit}].`));
      },
      context => {
        record(context);
        return fauxAssistantMessage('Lighthouse tickets');
      },
    ]);
    const first = await fetch(`${url}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), question: 'Did Person A get the lighthouse tickets?' }) });
    const events = (await first.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    const done = events.find(event => event.type === 'done');
    assert.ok(done !== undefined, JSON.stringify(events));
    assert.equal(done.message.end, 'done', JSON.stringify(done));
    for (const each of sent) assert.deepEqual(leaked(each), [], around(each));
    assert.ok(named !== undefined);
    assert.doesNotMatch(done.message.text, /\[\[/u, done.message.text);
    assert.match(done.message.text, /\[r\d+\]/u);
    assert.equal(events.filter(event => event.type === 'text').map(event => event.delta).join(''), done.message.text);
    const told = events.filter(event => event.type === 'ref');
    assert.ok(told.length > 0 && Object.keys(done.message.refs ?? {}).length > 0, JSON.stringify(events));
    assert.deepEqual(Object.fromEntries(told.map(event => [event.handle, event.cited])), done.message.refs, 'a ref told early is put back as done keeps it');
    assert.doesNotMatch(JSON.stringify(told), /\[\[/u);
    for (const step of done.message.steps ?? []) assert.doesNotMatch(step.words, /\[\[/u, step.words);
    const chat = done.message.chat;

    const again = createHandler({ door: home.url, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined });
    const fresh = await listen(again);
    await until('the conversation in the home, as the restarted server reads it', async () => {
      const read = await fetch(`${fresh}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
      return read.status === 200 && /** @type {any} */ (await read.json()).messages?.length === 2;
    });
    sent.length = 0;
    faux.setResponses([context => {
      record(context);
      return fauxAssistantMessage(fauxText('Yes.'));
    }]);
    const second = await fetch(`${fresh}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), question: 'And who else?', chat }) });
    const later = (await second.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    assert.ok(later.some(event => event.type === 'done'), JSON.stringify(later));
    assert.equal(sent.length, 1);
    for (const each of sent) assert.deepEqual(leaked(each), [], around(each));
    assert.match(sent[0] ?? '', /\[\[Person [1-9][0-9]*\]\] got two lighthouse tickets/u);
  } finally {
    await command('privacy', { chat: null });
    await command('privacy', { chat: 'none' });
  }
});

test('hiding as main has it: a turn\'s hide sends its question\'s pieces with no `known`, and a follow-up after a restart its earlier messages with no `known`, as main does; no request carries `keep`, and every `known` mark holds main\'s members alone', async () => {
  await command('privacy', { chat: 'all' });
  /** @type {any[]} */
  const hides = [];
  const door = await listen((request, response) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if (request.url === '/v1/hide-details') hides.push(JSON.parse(body.toString('utf8')));
      const passed = httpRequest(`${home.url}${request.url}`, { method: request.method, headers: { ...request.headers, host: new URL(home.url).host } }, answer => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      passed.on('error', () => response.destroy());
      passed.end(body);
    });
  });
  try {
    const first = await listen(createHandler({ door, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined }));
    faux.setResponses([() => fauxAssistantMessage(fauxText('[[Person 1]] is around.')), () => fauxAssistantMessage('Around')]);
    const asked = await fetch(`${first}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), question: 'Is Person B around?' }) });
    const events = (await asked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    const done = events.find(event => event.type === 'done');
    assert.equal(done?.message.end, 'done', JSON.stringify(events));
    const chat = done.message.chat;
    const turn = hides.find(hide => Array.isArray(hide.texts?.[0]) && hide.texts[0].some((/** @type {any} */ piece) => piece.text === 'Is Person B around?'));
    assert.ok(turn !== undefined, JSON.stringify(hides));
    assert.deepEqual(turn.texts[0], [{ text: 'Is Person B around?', free: true }], 'the question\'s pieces as main sends them');

    const fresh = await listen(createHandler({ door, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined }));
    await until('the conversation in the home, as the restarted server reads it', async () => {
      const read = await fetch(`${fresh}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
      return read.status === 200 && /** @type {any} */ (await read.json()).messages?.length === 2;
    });
    const before = hides.length;
    faux.setResponses([() => fauxAssistantMessage(fauxText('Yes.'))]);
    const second = await fetch(`${fresh}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), question: 'And then?', chat }) });
    const later = (await second.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    assert.ok(later.some(event => event.type === 'done'), JSON.stringify(later));
    const followed = hides.slice(before).find(hide => hide.texts?.length > 1);
    assert.ok(followed !== undefined, JSON.stringify(hides.slice(before)));
    assert.deepEqual(followed.texts.slice(0, 1), [[{ text: 'And then?', free: true }]]);
    assert.ok(followed.texts.slice(1).every((/** @type {any} */ text) => !Array.isArray(text) || text.every(piece => piece.known === undefined)), JSON.stringify(followed.texts));

    const sent = JSON.stringify(hides);
    assert.equal(sent.includes('"keep"'), false, 'no hide asks a picture kept');
    const marks = hides.flatMap(hide => (hide.texts ?? []).flatMap((/** @type {any} */ text) => Array.isArray(text) ? text.flatMap(piece => piece.known ?? []) : []));
    for (const mark of marks) assert.deepEqual(Object.keys(mark).filter(key => !['start', 'end', 'type', 'who', 'shown'].includes(key)), [], JSON.stringify(mark));
  } finally {
    await command('privacy', { chat: 'none' });
  }
});

test('the steps line under `all`: a follow-up in a fresh context reads the calls before it as the model wrote them, placeholders and handles, and no seeded detail; the person\'s steps read the real words', async () => {
  await command('privacy', { chat: 'all' });
  try {
    /** @type {string[]} */
    const sent = [];
    /** @type {string | undefined} */
    let named;
    faux.setResponses([
      context => {
        sent.push(JSON.stringify(context));
        named = /\[\[Person [1-9][0-9]*\]\]/u.exec(JSON.stringify(context.messages))?.[0];
        return fauxAssistantMessage([fauxToolCall('search_people', { name: named ?? 'nobody' }), fauxToolCall('search', { query: 'lighthouse', person: [named ?? 'nobody'] })], { stopReason: 'toolUse' });
      },
      context => {
        sent.push(JSON.stringify(context));
        return fauxAssistantMessage(fauxText(`${named} did [r1].`));
      },
      fauxAssistantMessage('Tickets'),
    ]);
    const ask = (/** @type {Record<string, unknown>} */ body) => fetch(`${url}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), ...body }) }).then(async response => (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line)));
    const first = await ask({ question: 'Did Person A get the lighthouse tickets?' });
    const done = first.find(event => event.type === 'done');
    assert.equal(done?.message.end, 'done', JSON.stringify(first));
    assert.ok(named !== undefined);
    for (const step of done.message.steps) assert.doesNotMatch(step.words, /\[\[/u, step.words);
    assert.ok(done.message.steps.some((/** @type {{ words: string }} */ step) => step.words.includes('Person A')), JSON.stringify(done.message.steps));

    sent.length = 0;
    faux.setResponses([context => {
      sent.push(JSON.stringify(context));
      return fauxAssistantMessage(fauxText('Yes.'));
    }]);
    const second = await ask({ question: 'And when?', chat: done.message.chat, model: home.chat.cloud, thinking: 'low' });
    assert.ok(second.some(event => event.type === 'done'), JSON.stringify(second));
    assert.equal(sent.length, 1);
    for (const each of sent) assert.deepEqual(leaked(each), [], around(each));
    const quoted = JSON.stringify(named).slice(1, -1);
    const line = new RegExp(String.raw`\[Steps of this answer:\\nsearch_people \{name: \\"${quoted.replace(/[[\]]/gu, '\\$&')}\\"\} → r\d+[^\\]*\\nsearch \{query: lighthouse, person: \[\\"${quoted.replace(/[[\]]/gu, '\\$&')}\\"\]\}`, 'u');
    assert.match(sent[0] ?? '', line, /\[Steps of this answer:\\n.{0,400}/u.exec(sent[0] ?? '')?.[0] ?? 'no steps line: the follow-up went on in its live context');
  } finally {
    await command('privacy', { chat: null });
    await command('privacy', { chat: 'none' });
  }
});

test('a local model under `all`: its turns are sent as written and keep one live session, the conversation\'s level kept; a move to a model that leaves starts another, the earlier turns hidden too', async () => {
  await command('privacy', { chat: 'all' });
  try {
    /** @type {any[]} */
    const sent = [];
    const ask = (/** @type {Record<string, unknown>} */ body) => fetch(`${url}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), ...body }) }).then(async response => (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line)));
    const doneOf = (/** @type {any[]} */ events) => events.find(event => event.type === 'done')?.message;
    const asText = (/** @type {any} */ context) => JSON.stringify(context.messages.filter((/** @type {any} */ message) => message.role !== 'system'));
    faux.setResponses([
      context => {
        sent.push(context);
        return fauxAssistantMessage([fauxToolCall('search', { query: 'lighthouse' })], { stopReason: 'toolUse' });
      },
      context => {
        sent.push(context);
        return fauxAssistantMessage(fauxText('Person A did [r1].'));
      },
      fauxAssistantMessage('Tickets'),
    ]);
    const first = await ask({ question: 'Did Person A get the lighthouse tickets?', model: home.chat.local });
    assert.equal(doneOf(first)?.end, 'done', JSON.stringify(first));
    const { chat } = doneOf(first);
    assert.equal(sent.length, 2);
    for (const each of sent) assert.ok(leaked(asText(each)).includes('Person A'), 'a model that stays is sent the real words');
    assert.doesNotMatch(asText(sent[1]), /\[\[Person /u);

    sent.length = 0;
    faux.setResponses([context => {
      sent.push(context);
      return fauxAssistantMessage(fauxText('On Sunday, Person A.'));
    }]);
    const second = await ask({ question: 'When did Person A go?', chat, model: home.chat.local });
    assert.equal(doneOf(second)?.end, 'done', JSON.stringify(second));
    assert.ok(sent[0].messages.some((/** @type {any} */ message) => message.role === 'toolResult'), 'the live session goes on: the first turn\'s search is in it');
    assert.ok(leaked(asText(sent[0])).includes('Person A'));

    sent.length = 0;
    faux.setResponses([context => {
      sent.push(context);
      return fauxAssistantMessage(fauxText('Yes.'));
    }]);
    const third = await ask({ question: 'And was it Sunday?', chat, model: home.chat.cloud });
    assert.equal(doneOf(third)?.end, 'done', JSON.stringify(third));
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].messages.some((/** @type {any} */ message) => message.role === 'toolResult'), 'a new session, rebuilt from the kept turns');
    assert.deepEqual(leaked(asText(sent[0])), [], around(asText(sent[0])));
    assert.match(asText(sent[0]), /\[\[Person [0-9]+\]\]/u, 'the earlier turns hidden at the conversation\'s level');
  } finally {
    await command('privacy', { chat: null });
    await command('privacy', { chat: 'none' });
  }
});

test('a conversation\'s own level: two conversations at two levels at once; the person\'s pick, riding their next question, starts that turn from the kept turns, hidden at the pick, and moves no other conversation', async () => {
  /** @type {string[]} */
  const sent = [];
  /** @param {any} context */
  const answer = context => {
    sent.push(JSON.stringify(context));
    return fauxAssistantMessage(fauxText('Yes.'));
  };
  const ask = (/** @type {Record<string, unknown>} */ body) => fetch(`${url}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
    body: JSON.stringify({ submission: minted(), ...body }) }).then(async response => (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line)));
  /** @param {any[]} events */
  const doneOf = events => {
    const done = events.find(event => event.type === 'done');
    assert.equal(done?.message.end, 'done', JSON.stringify(events));
    return done.message;
  };
  const level = async (/** @type {string} */ chat) => /** @type {any} */ (await (await fetch(`${home.url}/v1/privacy/chat/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json()).level;
  faux.setResponses([answer, fauxAssistantMessage('Tickets'), answer, fauxAssistantMessage('Tickets')]);
  const first = doneOf(await ask({ question: 'Did Person A get the lighthouse tickets?' })).chat;
  const other = doneOf(await ask({ question: 'Did Person A get the lighthouse tickets?' })).chat;
  assert.deepEqual([await level(first), await level(other)], ['none', 'none']);
  assert.match(sent[0] ?? '', /Did Person A get the lighthouse tickets/u);

  const through = (/** @type {string} */ token) => fetch(`${home.url}/v1/ask`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ submission: minted(), question: 'And when?', chat: first, level: 'all' }) });
  assert.equal((await through(home.tokens.agent)).status, 403);
  assert.deepEqual([await level(first), await level(other)], ['none', 'none']);

  sent.length = 0;
  faux.setResponses([answer]);
  const picked = await through(home.tokens.reader);
  assert.equal(picked.status, 200);
  doneOf((await picked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line)));
  assert.deepEqual([await level(first), await level(other)], ['all', 'none']);
  assert.equal(sent.length, 1);
  assert.deepEqual(leaked(sent[0] ?? ''), [], around(sent[0] ?? ''));
  assert.match(sent[0] ?? '', /Did \[\[Person [1-9][0-9]*\]\] get the lighthouse tickets/u);

  sent.length = 0;
  faux.setResponses([answer]);
  doneOf(await ask({ question: 'And when?', chat: other }));
  assert.match(sent[0] ?? '', /Did Person A get the lighthouse tickets/u);
  assert.deepEqual([await level(first), await level(other)], ['all', 'none']);
});

test('a new conversation\'s level picked on its first question, through the door: picked `all` while the setting is `none`, the first question leaves hidden in a conversation the door named; one with no pick starts at the setting; an id the home does not hold starts none', async () => {
  /** @type {string[]} */
  const sent = [];
  /** @param {any} context */
  const answer = context => {
    sent.push(JSON.stringify(context));
    return fauxAssistantMessage(fauxText('Yes.'));
  };
  faux.setResponses([answer, fauxAssistantMessage('Tickets'), answer, fauxAssistantMessage('Tickets')]);
  const reader = { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' };
  const through = (/** @type {string} */ path, /** @type {string} */ method, /** @type {unknown} */ body = undefined) =>
    fetch(`${home.url}${path}`, { method, headers: reader, ...(body === undefined ? {} : { body: JSON.stringify(method === 'POST' && path.endsWith('/ask') ? { submission: minted(), ...body } : body) }) });
  const ask = async (/** @type {Record<string, unknown>} */ body) => {
    const asked = await through('/v1/ask', 'POST', { question: 'Did Person A get the lighthouse tickets?', ...body });
    assert.equal(asked.status, 200);
    const events = (await asked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    assert.equal(events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(events));
    return /** @type {string} */ (events[0].chat);
  };
  const chat = await ask({ level: 'all' });
  assert.match(chat, /^\d{13}-[0-9a-f]{6}$/u);
  assert.equal(sent.length, 1);
  assert.deepEqual(leaked(sent[0] ?? ''), [], around(sent[0] ?? ''));
  assert.match(sent[0] ?? '', /Did \[\[Person [1-9][0-9]*\]\] get the lighthouse tickets/u);
  assert.equal(/** @type {any} */ (await (await through(`/v1/privacy/chat/${chat}`, 'GET')).json()).level, 'all');
  const plain = await ask({});
  assert.notEqual(plain, chat);
  assert.match(sent[1] ?? '', /Did Person A get the lighthouse tickets/u);
  assert.equal(/** @type {any} */ (await (await through(`/v1/privacy/chat/${plain}`, 'GET')).json()).level, 'none');
  const stranger = `${Date.now()}-abcdef`;
  assert.equal((await through('/v1/ask', 'POST', { question: 'Anything?', chat: stranger })).status, 404);
  assert.equal(sent.length, 2);
});

test('claim, keep, begin: a question\'s level is kept before its turn begins, so `chat`, and a follower\'s replay of it, means kept; a keep that fails at every try begins nothing and leaves no conversation, a draft\'s or a named one\'s; a rejoin during the keep waits on the question and follows it, or reads its refusal, the refusal of a server closing during the keep too, never after a newer turn; a question that overlaps one in its keep or its turn is refused and keeps nothing', async () => {
  let failing = 0;
  let holding = false;
  /** @type {(() => void)[]} */
  const held = [];
  /** @type {(number | 'held')[]} */
  const keeps = [];
  /** @type {string[]} */
  const levelsRead = [];
  let holdingRecord = false;
  /** @type {(() => void)[]} */
  const heldRecords = [];
  const door = await listen((request, response) => {
    const onward = () => {
      const passed = httpRequest(`${home.url}${request.url}`, { method: request.method, headers: { ...request.headers, host: new URL(home.url).host } }, answer => {
        if (request.url === '/v1/privacy/keep') keeps.push(answer.statusCode ?? 0);
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      passed.on('error', () => response.destroy());
      request.pipe(passed);
    };
    const refused = () => {
      if (failing <= 0) return false;
      failing -= 1;
      keeps.push(503);
      request.resume();
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      response.end(JSON.stringify({ code: 'NOT_NOW', message: 'Synthetic: the ledger is busy' }));
      return true;
    };
    if (request.url === '/v1/privacy/keep' && holding) {
      keeps.push('held');
      return void held.push(() => { if (!refused()) onward(); });
    }
    if (request.url === '/v1/privacy/keep' && refused()) return;
    const levelOf = /^\/v1\/privacy\/chat\/([^/?]+)$/u.exec(request.url ?? '')?.[1];
    if (levelOf !== undefined) levelsRead.push(levelOf);
    if (holdingRecord && request.url?.startsWith('/v1/record?') && new URLSearchParams(request.url.slice('/v1/record?'.length)).get('kind') === 'chat') {
      holdingRecord = false;
      return void heldRecords.push(onward);
    }
    onward();
  });
  const was = main;
  /** @type {Record<string, unknown>[]} */
  const said = [];
  const asking = createHandler({ door, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: line => void said.push(line) });
  main = asking;
  const waits = () => said.filter(line => line.ask === 'waits for a question to begin').length;
  const reader = { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' };
  const through = (/** @type {string} */ path, /** @type {string} */ method, /** @type {unknown} */ body = undefined, /** @type {AbortSignal | undefined} */ signal = undefined) =>
    fetch(`${home.url}${path}`, { method, headers: reader, ...(body === undefined ? {} : { body: JSON.stringify(method === 'POST' && path.endsWith('/ask') ? { submission: minted(), ...body } : body) }), ...(signal === undefined ? {} : { signal }) });
  const level = async (/** @type {string} */ chat) => /** @type {any} */ (await (await through(`/v1/privacy/chat/${chat}`, 'GET')).json()).level;
  const listed = async () => /** @type {string[]} */ ((/** @type {any} */ (await (await through('/v1/ask/chats', 'GET')).json())).chats.map((/** @type {any} */ each) => each.chat));
  const conversation = async (/** @type {string} */ chat) => /** @type {any} */ (await (await through(`/v1/ask/chats/${chat}`, 'GET')).json());
  /** @param {Response} response */
  const reading = response => {
    const body = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    const decoder = new TextDecoder();
    let text = '';
    /** @returns {Promise<any>} */
    const next = async () => {
      while (!text.includes('\n')) {
        const read = await body.read();
        if (read.done) return null;
        text += decoder.decode(read.value, { stream: true });
      }
      const end = text.indexOf('\n');
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      return JSON.parse(line);
    };
    const rest = async () => {
      const all = [];
      for (let event = await next(); event !== null; event = await next()) all.push(event);
      return all;
    };
    return { next, rest };
  };
  const gated = () => {
    /** @type {() => void} */
    let open = () => undefined;
    const gate = new Promise(done => { open = () => done(undefined); });
    return { open, answer: async () => { await gate; return fauxAssistantMessage(fauxText('Yes.')); } };
  };
  const NOT_KEPT = { type: 'error', error: 'door', message: 'Lifestream couldn\'t keep this conversation\'s privacy level: ask again.' };
  const question = { question: 'Did Person A get the lighthouse tickets?' };
  try {
    failing = Number.POSITIVE_INFINITY;
    const lost = await through('/v1/ask', 'POST', { ...question, level: 'all' });
    assert.equal(lost.status, 200);
    assert.deepEqual(await reading(lost).rest(), [NOT_KEPT]);
    assert.deepEqual(keeps.splice(0), [503, 503, 503]);
    assert.equal(levelsRead.length, 1);
    const draft = /** @type {string} */ (levelsRead[0]);
    assert.equal((await listed()).includes(draft), false);
    failing = 0;
    faux.setResponses([fauxAssistantMessage(fauxText('Yes.')), fauxAssistantMessage('Tickets')]);
    const first = await reading(await through('/v1/ask', 'POST', { ...question, level: 'all' })).rest();
    assert.equal(first.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(first));
    const chat = /** @type {string} */ (first[0].chat);
    assert.deepEqual([keeps.splice(0), await level(chat)], [[200], 'all']);
    assert.notEqual(chat, draft);
    const now = await listed();
    assert.deepEqual([now.includes(chat), now.includes(draft)], [true, false]);

    const messages = (await conversation(chat)).messages.length;
    failing = Number.POSITIVE_INFINITY;
    assert.deepEqual(await reading(await through('/v1/ask', 'POST', { ...question, chat, level: 'none' })).rest(), [NOT_KEPT]);
    assert.deepEqual([keeps.splice(0), await level(chat), (await conversation(chat)).messages.length], [[503, 503, 503], 'all', messages]);
    failing = 1;
    const once = gated();
    faux.setResponses([once.answer]);
    const retried = reading(await through('/v1/ask', 'POST', { ...question, chat, level: 'none' }));
    assert.deepEqual(await retried.next(), { type: 'chat', chat, n: messages + 2, level: 'none' });
    assert.deepEqual([keeps.splice(0), await level(chat)], [[503, 200], 'none']);
    once.open();
    assert.equal((await retried.rest()).find(event => event.type === 'done')?.message.end, 'done');

    holding = true;
    const leaving = new AbortController();
    const rejoined = gated();
    faux.setResponses([rejoined.answer]);
    const dropped = through('/v1/ask', 'POST', { ...question, chat, level: 'names' }, leaving.signal).catch(() => null);
    await until('the question\'s keep is held', () => held.length === 1);
    leaving.abort();
    assert.equal(await dropped, null);
    let read = false;
    const rereading = conversation(chat).then(found => { read = true; return found; });
    await until('the rejoin\'s read waits on the question', () => waits() === 1);
    assert.deepEqual([read, await level(chat)], [false, 'none']);
    holding = false;
    held.shift()?.();
    const back = await rereading;
    assert.deepEqual([back.running, back.messages.at(-1)], [{ n: messages + 4 }, { type: 'ask.msg', chat, n: messages + 3, at_ms: back.messages.at(-1).at_ms, role: 'user', text: question.question }]);
    assert.equal(await level(chat), 'names');
    const followed = reading(await through(`/v1/ask/chats/${chat}/events`, 'GET'));
    assert.deepEqual(await followed.next(), { type: 'chat', chat, n: messages + 4, level: 'names' });
    assert.deepEqual(keeps.splice(0), ['held', 200]);
    rejoined.open();
    assert.equal((await followed.rest()).find(event => event.type === 'done')?.message.text, 'Yes.');
    const answeredBack = await conversation(chat);
    assert.deepEqual(answeredBack.messages.slice(-2).map((/** @type {any} */ each) => [each.n, each.role, each.text]),
      [[messages + 3, 'user', question.question], [messages + 4, 'assistant', 'Yes.']]);

    holding = true;
    const lostAgain = new AbortController();
    const refusedAsk = through('/v1/ask', 'POST', { ...question, chat, level: 'none' }, lostAgain.signal).catch(() => null);
    await until('the question\'s keep is held', () => held.length === 1);
    lostAgain.abort();
    assert.equal(await refusedAsk, null);
    const rejoin = conversation(chat);
    const follow = through(`/v1/ask/chats/${chat}/events`, 'GET');
    await until('the read and the follow wait on the question', () => waits() === 3);
    holding = false;
    failing = Number.POSITIVE_INFINITY;
    held.shift()?.();
    const refusedRead = await rejoin;
    assert.equal(refusedRead.running, undefined);
    assert.deepEqual(refusedRead.messages.slice(-2).map((/** @type {any} */ each) => [each.n, each.role, each.text, each.end, each.failed, each.error]), [
      [messages + 5, 'user', question.question, undefined, undefined, undefined],
      [messages + 6, 'assistant', '', 'failed', 'door', NOT_KEPT.message],
    ]);
    assert.deepEqual(await reading(await follow).rest(), [NOT_KEPT]);
    failing = 0;
    assert.deepEqual([keeps.splice(0), await level(chat), (await conversation(chat)).messages.length], [['held', 503, 503, 503], 'names', messages + 4]);
    assert.equal((await through(`/v1/ask/chats/${chat}/events`, 'GET')).status, 204);

    for (const during of ['keep', 'turn']) {
      const a = gated();
      faux.setResponses([a.answer]);
      holding = during === 'keep';
      const asked = through('/v1/ask', 'POST', { ...question, chat, level: 'all' });
      if (during === 'keep') await until('A\'s keep is held', () => held.length === 1);
      const running = during === 'keep' ? null : reading(await asked);
      if (running !== null) assert.deepEqual(await running.next(), { type: 'chat', chat, n: messages + 8, level: 'all' });
      const b = await through('/v1/ask', 'POST', { ...question, chat, level: 'none' });
      assert.equal(b.status, 409, during);
      await b.text();
      holding = false;
      held.shift()?.();
      const turn = running ?? reading(await asked);
      if (running === null) assert.deepEqual(await turn.next(), { type: 'chat', chat, n: messages + 6, level: 'all' });
      assert.deepEqual([keeps.splice(0), await level(chat)], [[...(during === 'keep' ? ['held'] : []), 200], 'all'], during);
      a.open();
      assert.equal((await turn.rest()).find(event => event.type === 'done')?.message.end, 'done', during);
    }

    holding = true;
    const lostA = new AbortController();
    const askedA = through('/v1/ask', 'POST', { ...question, chat, level: 'names' }, lostA.signal).catch(() => null);
    await until('A\'s keep is held', () => held.length === 1);
    lostA.abort();
    assert.equal(await askedA, null);
    const r = conversation(chat);
    await until('R waits on A', () => waits() === 4);
    holding = false;
    failing = Number.POSITIVE_INFINITY;
    holdingRecord = true;
    held.shift()?.();
    await until('R\'s read of the conversation is held, A refused', () => heldRecords.length === 1);
    failing = 0;
    faux.setResponses([fauxAssistantMessage(fauxText('Yes, B.'))]);
    const b = await reading(await through('/v1/ask', 'POST', { question: 'And B?', chat, level: 'all' })).rest();
    assert.deepEqual([b[0], b.find(event => event.type === 'done')?.message.end], [{ type: 'chat', chat, n: messages + 10, level: 'all' }, 'done']);
    heldRecords.shift()?.();
    const overtaken = await r;
    assert.equal(overtaken.running, undefined);
    assert.deepEqual(overtaken.messages.slice(-3).map((/** @type {any} */ each) => [each.n, each.role, each.text, each.end]), [
      [messages + 8, 'assistant', 'Yes.', 'done'],
      [messages + 9, 'user', 'And B?', undefined],
      [messages + 10, 'assistant', 'Yes, B.', 'done'],
    ]);
    assert.deepEqual([keeps.splice(0), await level(chat)], [['held', 503, 503, 503, 200], 'all']);

    holding = true;
    const askedC = through('/v1/ask', 'POST', { ...question, chat, level: 'none' });
    await until('C\'s keep is held', () => held.length === 1);
    const rejoinC = conversation(chat);
    const followC = through(`/v1/ask/chats/${chat}/events`, 'GET');
    await until('the read and the follow wait on C', () => waits() === 6);
    const closed = asking.close(10_000);
    holding = false;
    held.shift()?.();
    const RESTARTING = { type: 'error', error: 'restart', message: 'Chat is restarting: ask again in a moment.' };
    const refusedC = await askedC;
    assert.deepEqual([refusedC.status, await refusedC.json()], [503, { error: RESTARTING.message }]);
    const readC = await rejoinC;
    assert.equal(readC.running, undefined);
    assert.deepEqual(readC.messages.slice(-3).map((/** @type {any} */ each) => [each.n, each.role, each.text, each.end, each.failed, each.error]), [
      [messages + 10, 'assistant', 'Yes, B.', 'done', undefined, undefined],
      [messages + 11, 'user', question.question, undefined, undefined, undefined],
      [messages + 12, 'assistant', '', 'failed', 'restart', RESTARTING.message],
    ]);
    const followedC = await followC;
    assert.equal(followedC.status, 200);
    assert.deepEqual(await reading(followedC).rest(), [RESTARTING]);
    assert.deepEqual(keeps.splice(0), ['held', 200]);
    await closed;
  } finally {
    main = was;
  }
});

test('the turn runs at the level kept: A, no pick, pinned `none` and held before its claim; B picks `all` and is answered; A claims, its keep answers `all`, and its hides and its `chat` are at `all`', async () => {
  const ask = createHandler({ door: home.url, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined });
  /** @type {(() => void)[]} */
  const held = [];
  let holding = false;
  const was = main;
  main = (request, response) => {
    if (holding && request.method === 'POST' && request.url === '/ask') return void held.push(() => ask(request, response));
    ask(request, response);
  };
  /** @type {string[]} */
  const sent = [];
  /** @param {any} context */
  const answer = context => {
    sent.push(JSON.stringify(context));
    return fauxAssistantMessage(fauxText('Yes.'));
  };
  const reader = { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' };
  const through = (/** @type {string} */ path, /** @type {string} */ method, /** @type {unknown} */ body = undefined) =>
    fetch(`${home.url}${path}`, { method, headers: reader, ...(body === undefined ? {} : { body: JSON.stringify(method === 'POST' && path.endsWith('/ask') ? { submission: minted(), ...body } : body) }) });
  const eventsOf = async (/** @type {Response} */ response) => (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
  const level = async (/** @type {string} */ chat) => /** @type {any} */ (await (await through(`/v1/privacy/chat/${chat}`, 'GET')).json()).level;
  const question = 'Did Person A get the lighthouse tickets?';
  try {
    faux.setResponses([answer, fauxAssistantMessage('Tickets'), answer, answer]);
    const made = await eventsOf(await through('/v1/ask', 'POST', { question, level: 'none' }));
    const chat = /** @type {string} */ (made[0].chat);
    assert.deepEqual([made[0], await level(chat)], [{ type: 'chat', chat, n: 2, level: 'none' }, 'none']);
    holding = true;
    const a = through('/v1/ask', 'POST', { question, chat });
    await until('A held before its claim', () => held.length === 1);
    holding = false;
    const b = await eventsOf(await through('/v1/ask', 'POST', { question, chat, level: 'all' }));
    assert.deepEqual([b[0], b.find(event => event.type === 'done')?.message.end, await level(chat)], [{ type: 'chat', chat, n: 4, level: 'all' }, 'done', 'all']);
    held.shift()?.();
    const aEvents = await eventsOf(await a);
    assert.deepEqual([aEvents[0], aEvents.find(event => event.type === 'done')?.message.end, await level(chat)], [{ type: 'chat', chat, n: 6, level: 'all' }, 'done', 'all']);
    assert.equal(sent.length, 3);
    assert.match(sent[0] ?? '', /Did Person A get the lighthouse tickets/u);
    for (const turn of [sent[1] ?? '', sent[2] ?? '']) {
      assert.deepEqual(leaked(turn), [], around(turn));
      assert.match(turn, /Did \[\[Person [1-9][0-9]*\]\] get the lighthouse tickets/u);
    }
  } finally {
    main = was;
  }
});

test('a turn\'s pass replayed straight to the Ask server: it stops no other conversation, follows none, starts no turn of its own, another or a new one; once its turn ended it is no pass, at the door or the server', async () => {
  /** @type {() => void} */
  let open = () => undefined;
  const gate = new Promise(done => { open = () => done(undefined); });
  faux.setResponses([async () => {
    await gate;
    return fauxAssistantMessage(fauxText('Yes.'));
  }, fauxAssistantMessage('Tickets')]);
  const reader = { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' };
  const through = (/** @type {string} */ path, /** @type {string} */ method, /** @type {unknown} */ body = undefined) =>
    fetch(`${home.url}${path}`, { method, headers: reader, ...(body === undefined ? {} : { body: JSON.stringify(method === 'POST' && path.endsWith('/ask') ? { submission: minted(), ...body } : body) }) });
  const asked = await through('/v1/ask', 'POST', { question: 'Anything?' });
  assert.equal(asked.status, 200);
  const pass = /** @type {string} */ (brought.at(-1));
  assert.match(pass, /^Bearer turn\./u);
  const a = /** @type {any} */ (await (await fetch(`${home.url}/v1/me`, { headers: { authorization: pass } })).json()).turn.chat;
  const b = `${Date.now()}-0b0b0b`;
  assert.match(a, /^\d{13}-[0-9a-f]{6}$/u);
  const direct = (/** @type {string} */ path, /** @type {string} */ method, /** @type {unknown} */ body = undefined) =>
    fetch(`${url}${path}`, { method, headers: { authorization: pass, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await fetch(`${home.url}/v1/clock`, { headers: { authorization: pass } })).status, 200);
  for (const [path, method, body] of /** @type {const} */ ([
    ['/ask/stop', 'POST', { chat: b }], ['/ask/stop', 'POST', { chat: a }], [`/ask/chats/${b}/events`, 'GET', undefined], [`/ask/chats/${a}/events`, 'GET', undefined],
    ['/ask', 'POST', { question: 'Again?', chat: b }], ['/ask', 'POST', { question: 'Again?', chat: a }], ['/ask', 'POST', { question: 'Again?' }], ['/ask/chats', 'GET', undefined],
  ])) assert.equal((await direct(path, method, body)).status, 403, `${method} ${path} ${JSON.stringify(body)}`);
  open();
  const events = (await asked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
  assert.equal(events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(events));
  await until('the ended turn\'s pass is forgotten', async () => (await fetch(`${home.url}/v1/status`, { headers: { authorization: pass } })).status === 401);
  assert.equal((await direct('/ask', 'POST', { question: 'Again?', chat: a })).status, 401);
});

test('Ask\'s line naming the person, leaking or repeating a name: the names plain under a level that hides nothing; under `all`, the detector off, a common-word nickname too, every byte sent holds the line as [[Person 0]] once and no name; a home with no You, no line; People busy or not prepared (503), no line and the conversation opens', async () => {
  const real = /** @type {any} */ (await (await fetch(`${home.url}/v1/people?id=me`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json()).person;
  /** @type {{ me: any, refused?: [number, string] | null }} */
  const served = { me: { ...PEOPLE_YOU.me, id: real.id, also_called: [...PEOPLE_YOU.me.also_called, { name: 'Bear', from: 'Contacts' }] } };
  const door = await youDoor(home.url, served);
  const at = await listen(createHandler({ door: door.url, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined }));
  const turn = async () => {
    /** @type {string[]} */
    const sent = [];
    /** @param {any} context */
    const record = context => sent.push(JSON.stringify(context));
    faux.setResponses([
      context => {
        record(context);
        return fauxAssistantMessage(fauxText('Yes.'));
      },
      context => {
        record(context);
        return fauxAssistantMessage('A question');
      },
    ]);
    const response = await fetch(`${at}/ask`, { method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' },
      body: JSON.stringify({ submission: minted(), question: 'What am I called?' }) });
    const events = (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    assert.equal(events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(events));
    assert.ok(events.some(event => event.type === 'title'), JSON.stringify(events));
    return sent;
  };
  /** @param {string[]} sent */
  const lines = sent => sent.flatMap(each => each.match(/The person is called [^.]*\./gu) ?? []);
  try {
    assert.deepEqual(lines(await turn()), ['The person is called Sam (full name Sam Example; also called Sammy, Bear).']);

    await command('privacy', { chat: 'all', detector: 'off' });
    const hidden = await turn();
    assert.deepEqual(lines(hidden), ['The person is called [[Person 0]].']);
    for (const each of hidden) assert.doesNotMatch(each, /(?<![\p{L}\p{N}])(Sam|Sammy|Bear)(?![\p{L}\p{N}])/u, each.slice(0, 2_000));

    for (const refused of /** @type {[number, string][]} */ ([[503, 'NOT_NOW']])) {
      served.refused = refused;
      for (const each of await turn()) assert.doesNotMatch(each, /The person is called/u);
    }
    served.refused = null;

    served.me = null;
    for (const each of await turn()) assert.doesNotMatch(each, /The person is called/u);
  } finally {
    await command('privacy', { chat: 'none', detector: 'runner' });
    await door.close();
  }
});

test('the catalog in Ask\'s prompt is built once a conversation and a level: a follow-up in a fresh context, on a turn pass of its own, reads it kept; a level picked builds it again, and so does an erasure', async () => {
  /** @type {string[]} */
  const built = [];
  const door = await listen((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      if (request.method === 'POST' && request.url === '/v1/count' && Object.keys(JSON.parse(body.toString('utf8')).args ?? {}).length === 0) built.push(String(request.headers.authorization));
      const passed = httpRequest(`${home.url}${request.url}`, { method: request.method, headers: { ...request.headers, host: new URL(home.url).host } }, answer => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      passed.on('error', () => response.destroy());
      passed.end(body);
    });
  });
  const was = main;
  main = createHandler({ door, ask: { reach: () => ({ models: fauxModels, model: fauxModel }), machine: home.ask.machine, now: homeClock }, log: () => undefined });
  const through = (/** @type {Record<string, unknown>} */ body) => fetch(`${home.url}/v1/ask`, {
    method: 'POST', headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' }, body: JSON.stringify({ submission: minted(), ...body }),
  }).then(async response => (await response.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line)));
  const doneOf = (/** @type {any[]} */ events) => {
    const done = events.find(event => event.type === 'done');
    assert.equal(done?.message.end, 'done', JSON.stringify(events));
    return done.message;
  };
  try {
    faux.setResponses([fauxAssistantMessage('Yes.'), fauxAssistantMessage('Record'), fauxAssistantMessage('Yes.'), fauxAssistantMessage('Yes.'),
      fauxAssistantMessage('Yes.'), fauxAssistantMessage('Other'), fauxAssistantMessage('Yes.')]);
    const { chat } = doneOf(await through({ question: 'What does the record hold?' }));
    assert.equal(built.length, 1);
    doneOf(await through({ question: 'And now?', chat, model: home.chat.cloud, thinking: 'low' }));
    assert.equal(built.length, 1, `a fresh context of the same conversation and level, its pass another: ${new Set(built).size} passes`);
    doneOf(await through({ question: 'And hidden?', chat, level: 'all' }));
    assert.equal(built.length, 2);
    const epochOf = async () => /** @type {{ epoch: number }} */ (await (await fetch(`${home.url}/v1/privacy/chat/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json()).epoch;
    const before = await epochOf();
    const other = doneOf(await through({ question: 'Another?' })).chat;
    assert.equal(built.length, 3);
    const answer = `/v1/record?source=${encodeURIComponent(home.ask.source)}&kind=msg&key=${encodeURIComponent(`${other}:0001`)}`;
    await until('the other conversation\'s answer imported by the home, so its erasure finds it',
      async () => (await fetch(`${home.url}${answer}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).status === 200);
    await command('erase', { key: `${other}:0001` });
    assert.notEqual(await epochOf(), before);
    doneOf(await through({ question: 'And after?', chat }));
    assert.equal(built.length, 4, 'a catalog read before an erasure is never read after it');
  } finally {
    main = was;
  }
});
