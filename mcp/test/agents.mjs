// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askOn, createHandler } from '../server.mjs';
import { agents, SHAPE } from '../lib/ask/agents.mjs';
import { ASK_TOOLS } from '../lib/tools.mjs';
import { asked, home, named, note, PLAN_ROWS, plansOn, startHome, stopHome } from './asking.mjs';
import { fakeClaude, openDoorway } from './programs.mjs';

const ARTIFACT = fileURLToPath(new URL('../.build/e2e/agents.json', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../homelink/Tests/Fixtures/agents/ask/', import.meta.url));
const WRITE = process.env.LIFESTREAM_FIXTURES === 'write';
const DAY = 86_400_000;
const AGENT = 'Synthetic Agent';
const FIXED_CHAT = '1792396847000-3fa9c2';

/** @type {(() => Promise<unknown>)[]} */
const closing = [];

before(async () => {
  await startHome('http://127.0.0.1:9');
});

after(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await stopHome(ARTIFACT);
});

/**
 * @param {string} method
 * @param {string} path
 * @param {string} pass
 * @param {unknown} [body]
 * @param {string} [device]
 */
async function door(method, path, pass, body, device) {
  const response = await fetch(`${home.url}${path}`, {
    method, headers: { authorization: `Bearer ${pass}`, ...(device === undefined ? {} : { 'lifestream-device': device }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: /** @type {any} */ (await response.json()) };
}

/** @param {string} machine */
async function askServer(machine) {
  const doorway = await openDoorway(home.url);
  const ask = askOn(machine, { door: doorway.url, now: () => home.now_ms, log: () => undefined });
  const handler = createHandler({ door: doorway.url, ask, log: () => undefined });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  let closed = false;
  const close = async () => {
    if (closed) return true;
    closed = true;
    const delivered = await handler.close(5_000);
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
    await doorway.close();
    return delivered;
  };
  closing.push(close);
  return { url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, doorway, close };
}

/**
 * @param {unknown} value
 * @param {string} chat
 */
function stable(value, chat) {
  /** @type {Map<string, string>} */
  const named = new Map();
  /**
   * @param {string} id
   * @param {string} prefix
   * @param {number} width
   */
  const of = (id, prefix, width) => {
    if (!named.has(id)) named.set(id, `${prefix}${String([...named.keys()].filter(each => each.startsWith(prefix)).length + 1).padStart(width, '0')}`);
    return /** @type {string} */ (named.get(id));
  };
  const text = JSON.stringify(value, (key, each) => (['ms', 'thought_ms'].includes(key) && typeof each === 'number' ? 0 : each), 1)
    .replaceAll(chat, FIXED_CHAT)
    .replace(/rq-[0-9a-f]{16}/gu, id => of(id, 'rq-', 16))
    .replace(/p-[0-9a-f]{8}/gu, id => of(id, 'p-', 8));
  return `${text}\n`;
}

/** @param {Record<string, string>} files */
async function held(files) {
  if (WRITE) {
    await mkdir(FIXTURES, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(FIXTURES, name), text);
  }
  for (const [name, text] of Object.entries(files)) {
    const file = join(FIXTURES, name);
    assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : '', text, `homelink/Tests/Fixtures/agents/ask/${name} is what this turn streams and keeps: LIFESTREAM_FIXTURES=write writes it`);
  }
}

test('agents is Ask\'s alone, beside its four tools and feedback', () => {
  assert.equal(ASK_TOOLS.some(tool => tool.name === 'agents'), false, '/mcp never offers it');
  assert.equal(agents.writes({ access: '{}' }), true);
  assert.equal(agents.writes({}), false);
});

test('1, 2, 3: Chat reads every reader\'s access, narrows an agent at once (the turn\'s line, with Undo), and asks to widen it (the card, nothing changed until a phone\'s Allow); a change naming a person is refused in the parser\'s words; the kept answer holds its changes, as the home keeps it', async () => {
  named('Chat changes an agent\'s access');
  const listed = await door('GET', '/v1/agents', home.tokens.reader);
  const row = listed.body.readers.find((/** @type {any} */ each) => each.name === AGENT);
  assert.ok(row !== undefined, JSON.stringify(listed.body));
  const before = (await door('GET', `/v1/agents/${row.id}`, home.tokens.reader)).body;
  const pastDay = { ...before.access, window: { past_ms: DAY } };
  const person = { ...before.access, not: [{ person: 'Person A' }] };

  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const first = await askServer(machine);
  await fake.script([[
    { call: { tool: 'agents', args: {} } },
    { call: { tool: 'agents', args: { reader: row.id, version: before.version, access: JSON.stringify(pastDay) } } },
    { call: { tool: 'agents', args: { reader: row.id, version: before.version + 1, access: JSON.stringify(before.access) } } },
    { call: { tool: 'agents', args: { reader: row.id, version: before.version + 1, access: JSON.stringify(person) } } },
    { say: `${AGENT} reads only the past day now; widening it again waits for you.` },
  ]]);
  const events = await asked(first.url, { question: `Let ${AGENT} read only the past day, then put it back` });
  const chat = events[0]?.chat;
  note({ events });

  const answered = (await fake.seen()).filter(line => line.answered === 'agents').map(line => ({ text: line.result.content[0].text, error: line.result.isError === true }));
  assert.equal(answered.length, 4, JSON.stringify(answered));
  const [read, narrowed, widened, refused] = answered;
  assert.match(read?.text ?? '', new RegExp(`^${AGENT} \\(reader ${row.id}, an agent, version ${before.version}\\): `, 'mu'));
  assert.match(read?.text ?? '', /^Chat \(reader ask, Chat itself, version \d+\): /mu);
  assert.ok(read?.text.includes(`access: ${JSON.stringify(before.access)}`), read?.text);
  assert.match(read?.text ?? '', /^Accounts: .*gmail:person-a@example\.com \(Mail, Gmail/mu);
  assert.ok(read?.text.endsWith(SHAPE), 'the shape an access is written in');
  assert.deepEqual([narrowed?.text, narrowed?.error], [`Saved. ${AGENT} now sees the past 24 hours. Applied now; the person sees this line with Undo.`, false]);
  assert.match(widened?.text ?? '', /This widens the access, so it waits for the person/u);
  assert.equal(refused?.error, true);
  assert.match(refused?.text ?? '', /422 BAD_REQUEST: access: not must be empty/u, 'the parser\'s words');

  const changes = events.filter(event => event.type === 'access').map(event => event.change);
  assert.deepEqual(changes.map(change => change.kind), ['narrowed', 'asked'], 'a change refused is no event');
  const [line, card] = changes;
  assert.deepEqual([line.reader, line.words, line.undo], [row.id, [{ text: `Saved. ${AGENT} now sees the ` }, { text: 'past 24 hours', bold: true }, { text: '.' }], { access: before.access, expect: before.version + 1 }]);
  assert.deepEqual([card.id, card.snapshot.id, card.snapshot.by, card.snapshot.state, card.snapshot.version, card.snapshot.reader],
    [card.snapshot.id, card.id, 'chat', 'open', before.version + 1, row.id]);
  assert.deepEqual(card.snapshot.choices.map((/** @type {any} */ each) => each.answer), ['always', 'no']);
  assert.deepEqual(events.filter(event => event.type === 'step' && event.name === 'agents').map(event => event.words),
    ['Reading your agents’ access', 'Proposing a change to an agent’s access', 'Proposing a change to an agent’s access', 'Proposing a change to an agent’s access']);
  const done = events.find(event => event.type === 'done')?.message;
  assert.deepEqual(done?.access, changes, 'the kept answer holds the turn\'s changes in order');
  assert.ok(first.doorway.forModel.includes('GET /v1/agents') && first.doorway.forModel.includes(`POST /v1/agents/${row.id}/propose`), first.doorway.forModel.join('\n'));

  const waiting = (await door('GET', `/v1/agents/${row.id}`, home.tokens.reader)).body;
  assert.deepEqual([waiting.version, waiting.access], [before.version + 1, pastDay], 'the widening changed nothing');
  assert.equal(waiting.ask?.id, card.id);
  const tapped = await door('POST', '/v1/agents/answer', home.tokens.phone, { id: card.id, answer: 'always', expect: card.snapshot.version }, home.phone);
  assert.deepEqual([tapped.status, tapped.body.state], [200, 'allowed'], JSON.stringify(tapped.body));
  const allowed = (await door('GET', `/v1/agents/${row.id}`, home.tokens.reader)).body;
  assert.deepEqual([allowed.version, allowed.access], [before.version + 2, before.access], 'the phone\'s Allow widened it');

  assert.equal(await first.close(), true);
  const second = await askServer(machine);
  const kept = await fetch(`${second.url}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
  const conversation = /** @type {any} */ (await kept.json());
  const answer = conversation.messages.find((/** @type {any} */ each) => each.role === 'assistant');
  assert.equal(answer.unsaved, undefined, 'read from the home');
  assert.deepEqual(answer.access, changes, 'the home keeps the changes as the turn made them');

  await held({
    'events.json': stable(events.filter(event => event.type === 'access'), chat),
    'kept.json': stable(done, chat),
  });
});

test('a disconnected agent: Chat reads that it is disconnected and reads nothing, never an access it could change', async () => {
  const listed = await door('GET', '/v1/agents', home.tokens.reader);
  const vault = listed.body.readers.find((/** @type {any} */ each) => each.name === 'Vault App');
  assert.ok(vault !== undefined, JSON.stringify(listed.body));
  const gone = await door('POST', `/v1/agents/${vault.id}/disconnect`, home.tokens.phone, {}, home.phone);
  assert.equal(gone.body.state, 'disconnected', JSON.stringify(gone.body));
  const machine = await plansOn({ claude: 'in' }, { chat: PLAN_ROWS.claude.chat });
  const fake = fakeClaude(machine);
  const server = await askServer(machine);
  await fake.script([[{ call: { tool: 'agents', args: {} } }, { call: { tool: 'agents', args: { reader: vault.id } } }, { say: 'Vault App is disconnected.' }]]);
  await asked(server.url, { question: 'Which agents read my Lifestream?' });
  const [all, one] = (await fake.seen()).filter(line => line.answered === 'agents').map(line => /** @type {string} */ (line.result.content[0].text));
  const words = `Vault App (reader ${vault.id}, an agent): ${gone.body.disconnected} · its history stays. It reads nothing, and its access can't change: to read again it signs in again.`;
  for (const text of [all, one]) {
    assert.ok(text?.includes(words), text);
    assert.doesNotMatch(text ?? '', /Vault App \(reader [^)]*version/u);
  }
  assert.match(all ?? '', new RegExp(`^${AGENT} \\(reader p-[0-9a-f]{8}, an agent, version \\d+\\): `, 'mu'));
  await server.close();
});
