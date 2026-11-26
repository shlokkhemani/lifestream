// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { until } from './until.mjs';
import { asked, home, homeClock, listedIn, modelsOf, named, note, PLAN_ROWS, plansOn, plansRead, statusOf, streaming } from './asking.mjs';
import { fakeClaude } from './programs.mjs';
import { ASK_TOOLS } from '../lib/tools.mjs';
import { agents } from '../lib/ask/agents.mjs';
import { askServer, bearerOf, doneOf, errorOf, gone, holding, onClaude, toolsCall } from './on-claude.mjs';

onClaude('claude-turns');

test('5, 6, 7: a turn on Claude: its process\'s arguments, environment and two files, the bearer in its file alone; text, a tool call and several at once stepped and streamed, a tool failing, the answer kept with the model that answered and titled; a follow-up in the same process, and after a restart in a new one holding the conversation so far; the tools\' address refuses every other caller', async () => {
  named('a turn on Claude');
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const first = await askServer({ machine });
  const status = await statusOf(first.url);
  note({ status });
  assert.deepEqual([status.model, status.login, status.default], [PLAN_ROWS.claude.chat, 'ready', { model: PLAN_ROWS.claude.chat, thinking: 'medium', shown: PLAN_ROWS.claude.chat, choose: null }]);
  assert.deepEqual(status.models.map((/** @type {any} */ each) => each.id).filter((/** @type {string} */ id) => id.startsWith('claude:')), [PLAN_ROWS.claude.chat]);
  const chatUse = (await modelsOf(home)).uses.chat;
  assert.ok(['claude:claude-haiku-5-5', PLAN_ROWS.claude.listed].every(id => chatUse.fits.includes(id) && !listedIn(chatUse.menu).includes(id)), JSON.stringify(chatUse));
  await fake.script([
    [{ say: 'Looking. ' }, { calls: [{ tool: 'search', args: { query: 'lighthouse' } }, { tool: 'search', args: { query: 'tickets' } }] },
      { call: { tool: 'read', args: { ref: 'r999' } } }, { say: 'Person A got two lighthouse tickets for Sunday [r1].' }],
    [{ call: { tool: 'search_people', args: { name: 'Person A' } } }, { say: 'Person A, on Sunday [r1].' }],
    [{ say: 'Still Sunday [r1].' }],
  ]);
  await writeFile(join(fake.dir, 'title'), 'Lighthouse tickets');
  const events = await asked(first.url, { question: 'Who got lighthouse tickets?' });
  note({ events: events.map(event => event.type === 'done' ? { type: 'done', end: event.message.end, model: event.message.model } : event.type === 'chat' || event.type === 'title' ? { type: event.type } : 'ms' in event ? { ...event, ms: 'ms' } : event) });
  const done = doneOf(events);
  assert.deepEqual([done?.end, done?.text, done?.model, done?.thinking], ['done', 'Person A got two lighthouse tickets for Sunday [r1].', PLAN_ROWS.claude.chat, 'medium'], JSON.stringify(events));
  assert.deepEqual(Object.keys(done.refs ?? {}), ['r1']);
  assert.deepEqual(done.steps.map((/** @type {any} */ step) => [step.name, step.words, step.error ?? null]).slice(0, 2).sort(), [
    ['search', 'Searched everything for “lighthouse”: 2 found', null], ['search', 'Searched everything for “tickets”: 2 found', null]]);
  assert.equal(done.steps[2].name, 'read');
  assert.ok(typeof done.steps[2].error === 'string', 'a tool failing is a step with its error');
  assert.equal(events.filter(event => event.type === 'text').map(event => event.delta).join(''), 'Person A got two lighthouse tickets for Sunday [r1].');
  assert.equal(events.find(event => event.type === 'step')?.said, 'Looking', 'the words before the first step are its narration');
  assert.deepEqual(events.at(-1), { type: 'title', chat: done.chat, title: 'Lighthouse tickets' });
  const answers = (await fake.seen()).filter(line => line.answered === 'search');
  for (const line of answers) assert.match(line.result.content[0].text, /"r1"/u);
  const [chat] = (await fake.starts()).filter(each => each.argv[0] === '-p' && each.argv.includes('--mcp-config'));
  const files = (await fake.starts().then(() => readFile(join(fake.dir, 'started.jsonl'), 'utf8'))).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(line => line.config_mode !== undefined);
  const argv = chat.argv.map((/** @type {string} */ arg) => arg.startsWith(join(machine, 'ask', 'claude')) ? '<file>' : arg);
  note({ argv, files });
  assert.deepEqual(argv, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config',
    '--setting-sources', '', '--no-session-persistence', '--permission-mode', 'dontAsk', '--include-partial-messages', '--mcp-config', '<file>',
    '--allowedTools', 'mcp__lifestream__*', '--system-prompt-file', '<file>', '--model', 'claude-opus-5-5', '--effort', 'medium']);
  assert.deepEqual([files.config_mode, files.prompt_mode], ['600', '600']);
  assert.deepEqual([chat.cwd, chat.env.CLAUDE_CONFIG_DIR, chat.keys], [realpathSync(join(machine, 'claude')), join(machine, 'claude'), []]);
  const bearer = await bearerOf(machine);
  assert.equal(existsSync(join(machine, 'scratch')), false, 'a plain home\'s files are where they always were, nothing in scratch');
  assert.ok(!chat.argv.some((/** @type {string} */ arg) => arg.includes(bearer)));
  assert.doesNotMatch(JSON.stringify(first.logged), new RegExp(bearer, 'u'));
  const promptFile = (await readdir(join(machine, 'ask', 'claude'))).find(name => name.endsWith('.prompt.md'));
  const prompt = await readFile(join(machine, 'ask', 'claude', String(promptFile)), 'utf8');
  assert.match(prompt, /^How to work\. Four tools/mu);
  assert.doesNotMatch(prompt, /codemode|`exec`/u);
  const title = (await fake.seen()).find(line => line.title !== undefined);
  assert.deepEqual([title.model, title.effort], ['claude-opus-5-5', 'low']);

  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_people', arguments: { name: 'Person A' } } };
  assert.equal((await toolsCall(first.url, null, list)).status, 401);
  assert.equal((await toolsCall(first.url, 'a-wrong-bearer', list)).status, 401);
  const listed = await toolsCall(first.url, bearer, list);
  assert.deepEqual(listed.body.result.tools.map((/** @type {any} */ tool) => tool.name), [...ASK_TOOLS, agents].map(tool => tool.name));
  const idle = await toolsCall(first.url, bearer, call);
  note({ idle: idle.body.result });
  assert.deepEqual([idle.body.result.isError, idle.body.result.content[0].text], [true, 'No question is being answered: this call is refused.']);
  await mkdir(join(machine, 'mcp'), { recursive: true });
  await writeFile(join(machine, 'mcp', 'public.json'), JSON.stringify({ origin: 'https://synthetic-mac.example.ts.net' }));
  const publicListener = createServer(first.handler.public({ machine }));
  await new Promise(done => publicListener.listen(0, '127.0.0.1', () => done(undefined)));
  const publicUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (publicListener.address()).port}`;
  assert.equal((await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`)).status, 200, 'the public listener is on');
  assert.equal((await toolsCall(publicUrl, bearer, list)).status, 404);
  publicListener.close();

  const follow = await asked(first.url, { question: 'And who is that?', chat: done.chat });
  assert.deepEqual([doneOf(follow)?.end, doneOf(follow)?.text], ['done', 'Person A, on Sunday [r1].'], JSON.stringify(follow));
  assert.deepEqual(follow.filter(event => event.type === 'step').map(step => step.words), ['Looking up Person A', 'Looked up Person A']);
  assert.equal((await fake.starts()).filter(each => each.argv.includes('--mcp-config')).length, 1);

  process.kill(chat.pid, 'SIGKILL');
  await until('the dead process\'s bearer refused', async () => (await toolsCall(first.url, bearer, list)).status === 401);
  await until('its files removed', async () => (await readdir(join(machine, 'ask', 'claude'))).length === 0);

  await first.close();
  const second = await askServer({ machine });
  const later = await asked(second.url, { question: 'Still?', chat: done.chat });
  assert.equal(doneOf(later)?.text, 'Still Sunday [r1].', JSON.stringify(later));
  const replay = (await fake.seen()).filter(line => line.asked !== undefined).at(-1).asked;
  note({ replay });
  assert.match(replay, /^\[The conversation so far, which you answered before:\]/u);
  assert.match(replay, /Question: \[Asked [A-Z][a-z]+day [^\]\n]+\]\nWho got lighthouse tickets\?/u);
  assert.match(replay, /\[Steps of this answer:\n/u);
  assert.match(replay, /\[The question now:\]\n\n\[Asked [A-Z][a-z]+day [^\]\n]+\]\nStill\?$/u);
  await second.close();
});

test('an encrypted home\'s conversation on Claude: its prompt and tools files in scratch alone, gone when its run ends, killed or closed, and those a killed server left gone at the next start; its bearer dies with its run; its question and prompt nowhere else on this Mac, no submissions\' record', async () => {
  named('an encrypted home on Claude');
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const scratch = join(machine, 'scratch', 'ask');
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, '1792396847000-0a0a0a-0b0b0b.prompt.md'), 'Left by a server killed mid-run.');
  const server = await askServer({ machine });
  server.doorway.state.keyed = true;
  assert.equal(existsSync(scratch), false, 'a start removes what a killed server left');
  await fake.script([[{ say: 'A synthetic answer.' }], [{ say: 'Another synthetic answer.' }]]);
  await writeFile(join(fake.dir, 'title'), 'Synthetic title');
  const events = await asked(server.url, { question: 'Where is the synthetic canary?' });
  const done = doneOf(events);
  assert.equal(done?.text, 'A synthetic answer.', JSON.stringify(events));
  const live = (await readdir(scratch)).sort();
  note({ live: live.map(name => name.slice(name.indexOf('.'))) });
  assert.deepEqual(live.map(name => [name.startsWith(`${done.chat}-`), name.slice(name.indexOf('.'))]), [[true, '.prompt.md'], [true, '.tools.json']]);
  assert.match(await readFile(join(scratch, String(live[0])), 'utf8'), /^How to work\. Four tools/mu);
  const bearer = String(JSON.parse(await readFile(join(scratch, String(live[1])), 'utf8')).mcpServers.lifestream.headers.Authorization).slice('Bearer '.length);
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  assert.equal((await toolsCall(server.url, bearer, list)).status, 200);
  assert.equal(existsSync(join(machine, 'ask', 'claude')), false);
  const plain = new RegExp(`synthetic canary|How to work|${bearer}`, 'u');
  assert.deepEqual(await holding(machine, plain, ['ask', 'mcp', 'subscriptions']), []);

  const [first] = (await fake.starts()).filter(each => each.argv.includes('--mcp-config'));
  process.kill(first.pid, 'SIGKILL');
  await until('the killed run\'s files removed', async () => (await readdir(scratch)).length === 0);
  assert.equal((await toolsCall(server.url, bearer, list)).status, 401, 'the bearer is no pass once its run ended');

  const follow = await asked(server.url, { question: 'And the synthetic canary now?', chat: done.chat });
  assert.equal(doneOf(follow)?.text, 'Another synthetic answer.', JSON.stringify(follow));
  assert.equal((await readdir(scratch)).length, 2);
  assert.equal(await server.close(), true, 'every turn delivered');
  assert.deepEqual(await readdir(scratch), [], 'a closed run\'s files removed');
  assert.equal(existsSync(join(machine, 'ask', 'submitted.ndjson')), false);
  assert.deepEqual(await holding(machine, plain), []);
});

test('5: Claude\'s failures said in the person\'s words: a stop mid-answer keeps the words so far and ends the process, the process dying, the plan\'s limit with when it resets, a signed-out answer; the next turn\'s steps hold nothing of a stopped one', async () => {
  named('failures on Claude');
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const { url, doorway, close } = await askServer({ machine });
  const resets = Math.floor(Math.max(home.now_ms, Date.now()) / 1000) + 3 * 3600;
  await fake.script([
    [{ say: 'Thinking ' }, { call: { tool: 'search_people', args: { name: 'Person A' } } }, { say: 'Never said.' }],
    [{ say: 'Partly ' }, { waitFor: 'go' }, { exit: true }],
    [{ say: 'Part ' }, { limit: resets }],
    [{ limit: resets, by: 'event' }],
    [{ limit: resets, by: 'status' }],
    [{ signedOut: true }],
    [{ call: { tool: 'search_people', args: { name: 'Person A' } } }, { say: 'Back.' }],
  ]);
  doorway.state.stalled = '/v1/people/search';
  const turn = await streaming(url, { question: 'One?' });
  let chat = '';
  for (let event = await turn.next(); event !== null && event.type !== 'step'; event = await turn.next()) if (event.type === 'chat') chat = event.chat;
  await until('the tool\'s read held', () => doorway.holding() > 0);
  const process_ = (await fake.starts()).filter(each => each.argv.includes('--mcp-config')).at(-1).pid;
  const stoppedBearer = await bearerOf(machine);
  const stop = await fetch(`${url}/ask/stop`, { method: 'POST', body: JSON.stringify({ chat }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  assert.deepEqual(await stop.json(), { stopped: true });
  assert.equal((await toolsCall(url, stoppedBearer, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).status, 401);
  while (await turn.next() !== null) {}
  assert.deepEqual([doneOf(turn.seen)?.end, doneOf(turn.seen)?.text], ['stopped', '']);
  assert.deepEqual(doneOf(turn.seen)?.steps.map((/** @type {any} */ step) => [step.name, step.error]), [['search_people', 'Stopped: the person stopped this answer.']]);
  await until('the stopped process gone', () => gone(process_));

  const next = await streaming(url, { question: 'Two?', chat });
  for (let event = await next.next(); event !== null && event.type !== 'text'; event = await next.next()) {}
  doorway.unstall();
  await fake.touch('go');
  while (await next.next() !== null) {}
  const died = next.seen;
  note({ died: errorOf(died) });
  assert.deepEqual(errorOf(died), { type: 'error', error: 'model', message: 'Claude didn\'t answer: Chat\'s Claude Code stopped. Ask again.' });
  assert.equal(doneOf(died)?.text, 'Partly ');
  assert.deepEqual(died.filter(event => event.type === 'step'), []);

  const limited = await asked(url, { question: 'Three?' });
  const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York' }).format(resets * 1000);
  note({ limited: errorOf(limited) });
  assert.deepEqual(errorOf(limited), { type: 'error', error: 'model', message: `Claude didn't answer: your plan is used up for now. It resets at ${at}.` });
  assert.deepEqual(errorOf(await asked(url, { question: 'Three again?' })), { type: 'error', error: 'model', message: `Claude didn't answer: your plan is used up for now. It resets at ${at}.` });
  assert.deepEqual(errorOf(await asked(url, { question: 'Three once more?' })), { type: 'error', error: 'model', message: 'Claude didn\'t answer: your plan is used up for now.' });

  const signedOut = await asked(url, { question: 'Four?' });
  note({ signedOut: errorOf(signedOut) });
  assert.deepEqual(errorOf(signedOut), { type: 'error', error: 'login', message: 'Chat needs your Claude sign-in on your Mac.' });
  const row = (await modelsOf(home)).models[PLAN_ROWS.claude.chat];
  assert.ok(row.state !== 'ready' && typeof row.line === 'string' && row.line !== '', JSON.stringify(row));
  const status = await statusOf(url);
  assert.deepEqual([status.login, status.said], ['missing', row.line]);
  assert.deepEqual(errorOf(await asked(url, { question: 'Five?' })), { type: 'error', error: 'login', message: row.line });
  await close();

  await fake.signIn();
  await plansRead({ claude: 'in' });

  const again = await askServer({ machine });
  const back = await asked(again.url, { question: 'Six?', chat });
  assert.deepEqual(doneOf(back)?.steps.map((/** @type {any} */ step) => step.words), ['Looked up Person A'], JSON.stringify(back));
  await again.close();
});

test('7: a tool call belongs to the turn that admitted it: one whose body comes after that turn ended and the next began is refused and is no step of the next; one whose turn stopped under it answers nothing of the record', async () => {
  named('calls bound to their turn');
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const { url, doorway, close } = await askServer({ machine });
  await fake.script([[{ waitFor: 'a' }, { say: 'A.' }], [{ waitFor: 'b' }, { say: 'B.' }], [{ waitFor: 'c' }, { say: 'C.' }]]);
  const asking = async (/** @type {number} */ count) => until(`question ${count} asked`, async () => (await fake.seen()).filter(line => line.asked !== undefined).length === count);
  const a = await streaming(url, { question: 'A?' });
  const { chat } = await a.next();
  await asking(1);
  const bearer = await bearerOf(machine);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'search_people', arguments: { name: 'Person A' } } });
  const late = httpRequest({ host: '127.0.0.1', port: new URL(url).port, path: '/ask/tools', method: 'POST', headers: {
    authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'content-length': Buffer.byteLength(body), expect: '100-continue' } });
  /** @type {Promise<any>} */
  const answered = new Promise((done, fail) => {
    late.on('response', response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => done(JSON.parse(text)));
    });
    late.on('error', fail);
  });
  const admitted = new Promise(done => late.once('continue', done));
  late.flushHeaders();
  await admitted;
  await fake.touch('a');
  while (await a.next() !== null) {}
  const b = await streaming(url, { question: 'B?', chat });
  await asking(2);
  late.end(body);
  const refused = await answered;
  note({ late: refused.result });
  assert.deepEqual([refused.result.isError, refused.result.content[0].text], [true, 'No question is being answered: this call is refused.']);
  await fake.touch('b');
  while (await b.next() !== null) {}
  assert.deepEqual([doneOf(b.seen)?.text, b.seen.filter(event => event.type === 'step')], ['B.', []]);

  const c = await streaming(url, { question: 'C?', chat });
  await asking(3);
  doorway.state.stalled = '/v1/people/search';
  const call = toolsCall(url, bearer, JSON.parse(body));
  await until('the call\'s read held', () => doorway.holding() > 0);
  await fetch(`${url}/ask/stop`, { method: 'POST', body: JSON.stringify({ chat }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  const dropped = (await call).body.result;
  doorway.unstall();
  note({ dropped });
  assert.deepEqual([dropped.isError, dropped.content[0].text], [true, 'The question this call was part of has ended: its answer is dropped.']);
  while (await c.next() !== null) {}
  assert.equal(doneOf(c.seen)?.end, 'stopped');
  await close();
});

test('8: a follow-up runs while thirteen other conversations end done, and finishes in its own process; past the twelfth the context idle longest is ended; a context idle past its hour is not reused', async () => {
  named('live contexts');
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  let shift = 0;
  const { url, close } = await askServer({ machine, now: () => homeClock() + shift });
  await fake.script([[{ say: 'First.' }], [{ waitFor: 'go' }, { say: 'Second.' }], ...Array.from({ length: 13 }, (_, at) => [{ say: `Other ${at}.` }])]);
  const first = await asked(url, { question: 'One?' });
  const chat = doneOf(first).chat;
  const turn = await streaming(url, { question: 'Two?', chat });
  await until('the follow-up asked', async () => (await fake.seen()).filter(line => line.asked !== undefined).length === 2);
  for (let at = 0; at < 13; at++) assert.equal(doneOf(await asked(url, { question: `Other ${at}?` }))?.end, 'done');
  await fake.touch('go');
  while (await turn.next() !== null) {}
  note({ follow: { end: doneOf(turn.seen)?.end, text: doneOf(turn.seen)?.text } });
  assert.deepEqual([doneOf(turn.seen)?.end, doneOf(turn.seen)?.text], ['done', 'Second.']);
  const conversations = (await fake.starts()).filter(each => each.argv.includes('--mcp-config'));
  assert.equal(conversations.length, 14, 'the follow-up went on in its own process');
  const [own, other0, other1, ...rest] = conversations;
  await until('the two idle longest ended', () => gone(other0.pid) && gone(other1.pid));
  assert.deepEqual([own, ...rest].map(each => gone(each.pid)), Array.from({ length: 12 }, () => false));

  await fake.script([[{ say: 'Third.' }]]);
  shift = 61 * 60_000;
  const later = await asked(url, { question: 'Three?', chat });
  assert.equal(doneOf(later)?.text, 'Third.', JSON.stringify(later));
  assert.equal((await fake.starts()).filter(each => each.argv.includes('--mcp-config')).length, 15);
  assert.match((await fake.seen()).filter(line => line.asked !== undefined).at(-1).asked, /^\[The conversation so far/u);
  await close();
});

test('8: a context idle its time is ended by its timer: its process gone, its bearer refused', async () => {
  named('idle ended');
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const { url, close } = await askServer({ machine, liveMs: 200 });
  await fake.script([[{ waitFor: 'go' }, { say: 'Once.' }]]);
  const turn = await streaming(url, { question: 'Once?' });
  await until('the question asked', async () => (await fake.seen()).some(line => line.asked !== undefined));
  const [process_] = (await fake.starts()).filter(each => each.argv.includes('--mcp-config'));
  const bearer = await bearerOf(machine);
  await fake.touch('go');
  while (await turn.next() !== null) {}
  assert.equal(doneOf(turn.seen)?.text, 'Once.');
  await until('the idle process ended', () => gone(process_.pid));
  assert.equal((await toolsCall(url, bearer, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).status, 401);
  await close();
});
