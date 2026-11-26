// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openMemoryConversations } from './fake/conversations.mjs';
import { createHandler } from '../server.mjs';
import { DoorRefusal } from '../lib/errors.mjs';
import { HIDE_NOT_READY_WORDS, openWrapper } from '../lib/hiding.mjs';
import { openHandles } from '../lib/ask/handles.mjs';
import { MAX_CHARS, NOTE } from '../lib/shape.mjs';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inputSchemaOf, shapeOf } from '../lib/params.mjs';
import { ASK_TOOLS, INSTRUCTIONS, SKILL_FILE, TOOLS, serverOf, unfit } from '../lib/tools.mjs';
import { count } from '../lib/tools/count.mjs';
import { PAGE_CHARS, PAGE_MOST, modelChars, read, readTool } from '../lib/tools/read.mjs';
import { search, withoutPending } from '../lib/tools/search.mjs';
import { searchPeople } from '../lib/tools/search_people.mjs';
import { minted } from './asking.mjs';

/**
 * @param {string} name
 * @returns {any}
 */
const fixture = name => JSON.parse(readFileSync(new URL(`../../packages/home/test/contract/${name}.json`, import.meta.url), 'utf8'));

/**
 * @param {any[]} answers
 * @param {any} [people]
 * @param {{ counts?: any[], reads?: any[] }} [more]
 */
function contextOf(answers, people, { counts = [], reads = [] } = {}) {
  /** @type {[string, Record<string, unknown>][]} */
  const calls = [];
  /** @type {Record<string, () => any>} */
  const routes = {
    '/v1/search': () => answers.shift(),
    '/v1/people/search': () => people,
    '/v1/count': () => counts.shift(),
    '/v1/read': () => reads.shift(),
  };
  return {
    calls,
    /** @param {string} path */
    asked: path => calls.filter(([at]) => at === path).map(([, args]) => args),
    async read(/** @type {string} */ path, /** @type {Record<string, unknown>} */ args) {
      calls.push([path, args]);
      const answer = routes[path]?.();
      if (answer === undefined) throw new Error(`the synthetic door was asked ${path} once too often`);
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
    door: new Proxy({}, { get: (_, name) => { throw new Error(`a tool touched door.${String(name)}`); } }),
  };
}

/** @param {any} told */
const plain = told => /** @type {any} */ (JSON.parse(JSON.stringify(told.json)));

/** @param {Record<string, unknown>} args @param {any[]} answers */
async function searched(args, answers) {
  const context = contextOf(answers);
  const told = /** @type {any} */ (await search.run(/** @type {any} */ (args), /** @type {any} */ (context)));
  assert.ok(context.calls.every(([path]) => path === '/v1/search'), 'search reads its one route alone');
  return { json: plain(told), found: told.found, links: told.links, asked: context.asked('/v1/search') };
}

/** @param {any} json */
const linesOf = json => {
  assert.ok(typeof json.note === 'string' && json.note.startsWith(NOTE), json.note);
  return json.note === NOTE ? [] : json.note.slice(NOTE.length + 1, -1).split('. ');
};

/** @param {string} text */
const sha = text => createHash('sha256').update(text).digest('hex');

test('1, 2, 3: search asks its one route, its arguments as written, both lists; every member is the door\'s; nothing read of a day, an extract or a label', async () => {
  const door = fixture('search');
  const { json, found, links, asked } = await searched({ query: 'exampel what did', person: ['r7'], chat: '[[Person 1]]', families: ['messages'], from: '2026-09-01', limit: 5 }, [door]);
  assert.deepEqual(asked, [{ query: 'exampel what did', person: ['r7'], chat: '[[Person 1]]', families: ['messages'], from: '2026-09-01', limit: 5, lists: ['record', 'screen'] }]);
  const { note, ...rest } = json;
  assert.deepEqual(rest, door, 'read_as, variants, record, screen and goto as the door gave them');
  assert.equal(rest.record.hits[0].the_user_was_at, 'Example City');
  assert.deepEqual((await searched({ query: 'example', lists: ['goto'] }, [{ goto: door.goto }])).asked, [{ query: 'example', lists: ['goto'] }]);
  assert.equal(found, '10000+');
  assert.deepEqual(links, []);
  assert.deepEqual((await searched({ cursor: 'r5' }, [fixture('search-screen-next')])).asked, [{ cursor: 'r5' }]);
  assert.deepEqual((await searched({ cursor: 'r5', query: 'example', limit: 10 }, [fixture('search-screen-next')])).asked, [{ cursor: 'r5', limit: 10 }],
    'a cursor goes on alone, with `limit`: the terms are page one\'s');
});

/** @param {Record<string, any>} routes */
function onePath(routes) {
  /** @type {{ path: string, body: any }[]} */
  const calls = [];
  const door = {
    pass: 'turn-pass',
    calls,
    async json(/** @type {string} */ path) { throw new Error(`a route tool read GET ${path}`); },
    async post(/** @type {string} */ path, /** @type {any} */ body) {
      calls.push({ path, body });
      const answer = routes[path];
      if (answer === undefined) throw new Error(`a route tool asked POST ${path}`);
      if (answer instanceof Error) throw answer;
      return structuredClone(typeof answer === 'function' ? answer(body) : answer);
    },
    forModel() { return door; },
  };
  return door;
}

test('3, 12: through the one dispatcher, each route tool posts `{args, to, shown}` once, as the contract\'s model call; nothing restored, hidden or described by the server', async () => {
  const door = onePath({ '/v1/search': fixture('search-hidden'), '/v1/count': fixture('count-hidden'), '/v1/read': fixture('read-refs'), '/v1/people/search': fixture('people-hidden') });
  const chat = openWrapper({ table: 'chat:c-0001', to: 'anthropic', agent: false, shown: () => ['refund', 'Example Air'] });
  const context = { door: /** @type {any} */ (door) };
  const { args: searchArgs } = fixture('call-search-hidden');
  const { lists: _lists, ...written } = searchArgs;
  const ran = await chat.run(/** @type {any} */ (search), written, context);
  assert.deepEqual(door.calls, [{ path: '/v1/search', body: fixture('call-search-hidden') }]);
  const { note: _note, ...answer } = JSON.parse(ran.text);
  assert.deepEqual(answer, fixture('search-hidden'), 'the door\'s hidden answer, as it came');
  assert.deepEqual(ran.cited, [{ handle: 'r1', title: '[[Person 1]]' }, { handle: 'r3', title: 'Your example receipt' }, { handle: 'r4', title: 'Example review' },
    { handle: 'r6', title: 'Example Air: your trip' }, { handle: 'r7', title: 'Trip list' }]);
  assert.equal(ran.found, '3+');

  door.calls.length = 0;
  const agent = openWrapper({ table: 'grant', agent: true });
  await agent.run(/** @type {any} */ (count), fixture('call-count-hidden').args, context);
  await agent.run(/** @type {any} */ (read), fixture('call-read-hidden').args, context);
  const people = await agent.run(/** @type {any} */ (searchPeople), { id: 'r14' }, context);
  assert.deepEqual(door.calls, [
    { path: '/v1/count', body: { ...fixture('call-count-hidden'), to: 'agent' } },
    { path: '/v1/read', body: { ...fixture('call-read-hidden'), to: 'agent' } },
    { path: '/v1/people/search', body: { args: { id: 'r14' }, to: 'agent', shown: [] } },
  ], 'an agent\'s call is Chat\'s but for `to` and `shown`');
  assert.deepEqual(JSON.parse(people.text).matches, fixture('people-hidden').matches);
});

test('12: a route\'s `HIDE_NOT_READY` waits on Chat\'s `ready` and asks again; an agent\'s is the fixed words; any other refusal is the door\'s, as it hid it', async () => {
  let refusals = 1;
  const door = onePath({
    '/v1/count': () => {
      if (refusals-- > 0) throw new DoorRefusal(503, 'HIDE_NOT_READY', 'Hiding is getting ready', 5, { code: 'HIDE_NOT_READY', message: 'Hiding is getting ready' });
      return fixture('count-hidden');
    },
  });
  /** @type {string[]} */
  const waited = [];
  const chat = openWrapper({ table: 'chat:c-0001', to: 'anthropic', agent: false, shown: () => [], ready: async line => { waited.push(line); } });
  const ran = await chat.run(/** @type {any} */ (count), { of: 'payments' }, { door: /** @type {any} */ (door) });
  assert.deepEqual(waited, ['Hiding is getting ready']);
  assert.equal(JSON.parse(ran.text).total.ref, 'r1');
  assert.equal(door.calls.length, 2);
  refusals = 1;
  await assert.rejects(openWrapper({ table: 'grant', agent: true }).run(/** @type {any} */ (count), { of: 'payments' }, { door: /** @type {any} */ (door) }),
    (/** @type {Error} */ error) => error.message === HIDE_NOT_READY_WORDS);
  const several = fixture('refusals-hidden').find((/** @type {any} */ each) => each.body?.matches !== undefined).body;
  const refusing = onePath({ '/v1/count': new DoorRefusal(404, 'PERSON_UNKNOWN', several.message, null, several) });
  await assert.rejects(chat.run(/** @type {any} */ (count), { of: 'payments', person: ['Per'] }, { door: /** @type {any} */ (refusing) }),
    (/** @type {Error} */ error) => error.message === 'Several people go by Per: ask by one of their refs. Find them with `search_people`. They are: r1 [[Person 1]]; r2 [[Person 2]]. Pass the one meant as `person`, by its handle.');
});

test('13: a photo\'s data URL is handed to the model as its picture, its words why not as they came; a link a record held openable after; a chat or a cursor never noted as a thing', async () => {
  const photo = fixture('read-photo-hidden');
  const refused = { ...photo, ref: 'r2', image: 'its picture could not be made' };
  const record = { ...fixture('read-record'), ref: 'r3', text: 'Track it at https://example.com/track/2.' };
  const door = onePath({ '/v1/read': { what: 'refs', opened: [photo, refused, record] } });
  const handles = openHandles();
  const wrapper = openWrapper({ table: 'chat:c-0001', to: 'anthropic', agent: false, shown: () => [] });
  const asks = readTool({ links: true });
  const ran = await wrapper.run(/** @type {any} */ (asks), { ref: ['r1', 'r2', 'r3'] }, { door: /** @type {any} */ (door), seen: handles.seen });
  const answer = JSON.parse(ran.text);
  assert.deepEqual(ran.images, [{ data: '/9j/2Q==', mimeType: 'image/jpeg' }]);
  assert.deepEqual(answer.opened.map((/** @type {any} */ each) => each.image), ['yes, image 1', 'no: its picture could not be made', undefined]);
  assert.doesNotMatch(ran.text, /base64/u);
  handles.ran(ran);
  assert.ok(handles.seen('https://example.com/track/2'), 'a link in a record\'s text');
  assert.deepEqual(ran.cited.map(each => each.handle), ['r1', 'r2', 'r3']);
  const chat = onePath({ '/v1/read': { ...fixture('read-chat-hidden'), next: 'r40' } });
  const span = await wrapper.run(/** @type {any} */ (asks), { chat: 'r7' }, { door: /** @type {any} */ (chat) });
  const spanned = JSON.parse(span.text);
  assert.ok(!span.cited.some(cited => cited.handle === spanned.chat || cited.handle === 'r40'), 'a chat beside its lines, or a cursor, is no thing cited');
  assert.deepEqual(chat.calls.map(call => call.path), ['/v1/read']);
});

test('4: a capped record list says how far it counted, by time or by rank, from the door\'s members alone; one that read all it was asked says nothing', async () => {
  const counted = await searched({ query: 'example', order: 'newest' }, [fixture('search')]);
  assert.deepEqual(linesOf(counted.json), [
    'read without: what, did',
    '10,000 matches counted back to 2026-09-03 14:22, every day from 2026-09-04 whole; older ones not counted: `next` goes on',
    'on the screen: 37 windows in the newest year, the two best shown: its `next` gives more windows of it',
    'on the screen: by words only: search by meaning is off',
  ]);
  const ranked = await searched({ query: 'example' }, [fixture('search')]);
  assert.equal(linesOf(ranked.json)[1], 'the best of the newest 10,000 matches, back to 2026-09-03 14:22, every day from 2026-09-04 whole: `next` gives the next best; after the last of them it ranks the older ones among themselves');
  const oldest = fixture('search');
  oldest.record.reached = { side: 'oldest', at: '2019-04-02T08:00+01:00', whole: null };
  assert.equal(linesOf((await searched({ query: 'example', order: 'oldest' }, [oldest])).json)[1], '10,000 matches counted forward to 2019-04-02 08:00, no day whole; newer ones not counted: `next` goes on');
  const whole = fixture('search-hidden');
  assert.deepEqual(linesOf((await searched({ query: 'refund' }, [{ record: { ...whole.record, capped: false, next: null } }])).json), []);
});

test('4: a page given by time once ranked paging stops says so; the days still being read are one line, their count and first and last', async () => {
  const { json } = await searched({ from: '2025-01-01', families: ['mail'] }, [fixture('search-record-by-time')]);
  assert.deepEqual(linesOf(json), [
    'ranked paging stops here; the rest come newest first: `next` goes on',
    '10,000 matches counted back to 2025-12-01 10:00, every day from 2025-12-02 whole; older ones not counted: `next` goes on',
    '130 days of this range are still being read, from before 2026-08-07 to 2026-11-14',
  ]);
  const screen = await searched({ cursor: 'cursor:screen:s1' }, [fixture('search-screen-next')]);
  assert.deepEqual(linesOf(screen.json), ['on the screen: ranked paging stops here; the rest come newest first: `next` goes on']);
});

test('4: a capped list by a placeholder is at least its count, with no date; what a hidden search left out is said, as the door gave it', async () => {
  const placeholder = await searched({ query: '[[Person 1]]' }, [fixture('search-placeholder-hidden')]);
  assert.deepEqual(linesOf(placeholder.json), ['at least 3 matches; there may be more: `next` goes on']);
  assert.doesNotMatch(placeholder.json.note, /\d{4}-\d{2}/u);
  assert.equal(placeholder.found, '3+');
  const hidden = await searched({ query: 'refund +15550000001' }, [{ ...fixture('search-hidden'), screen: { ...fixture('search-hidden').screen, total: undefined, next_gives: 'days' } }]);
  assert.deepEqual(linesOf(hidden.json), [
    'read without: what, did',
    'at least 3 matches; there may be more: `next` goes on',
    'on the screen: read back to 2026-10-15; its `next` reads older days',
    'on the screen: by words only: search by meaning is off',
    'Not searched (a word that could tell where a hidden detail is): +15550000001',
    'Search them by the placeholder an answer gave, or a word an answer showed',
  ]);
  assert.doesNotMatch(hidden.json.note, /\d+ windows/u, 'no count of the screen under a level that hides');
  assert.doesNotMatch(hidden.json.note, /every window shown/u, 'no count proves every window shown');
});

test('4: what the screen\'s `next` gives is its `next_gives`, never a page\'s length: more windows of the stretch, or older days with how far it read', async () => {
  const screen = fixture('search-hidden').screen;
  const hit = screen.hits[0];
  const page = (/** @type {number} */ hits, /** @type {string | undefined} */ gives) => ({ screen: { ...screen, hits: Array.from({ length: hits }, (_, at) => ({ ...hit, ref: `r${at + 20}` })),
    next: gives === undefined ? null : 'r5', next_gives: gives, capped: gives !== undefined } });
  const lineOf = async (/** @type {Record<string, unknown>} */ args, /** @type {number} */ hits, /** @type {string | undefined} */ gives) => linesOf((await searched(args, [page(hits, gives)])).json)[0];
  assert.equal(await lineOf({ query: 'refund' }, 9, 'days'), 'on the screen: read back to 2026-10-15; its `next` reads older days');
  assert.equal(await lineOf({ query: 'refund' }, 3, 'windows'), 'on the screen: the three best windows of the newest year: its `next` gives more windows of it');
  assert.equal(await lineOf({ query: 'refund' }, 10, 'days'), 'on the screen: read back to 2026-10-15; its `next` reads older days');
  assert.equal(await lineOf({ cursor: 'r5' }, 10, 'windows'), 'on the screen: the ten best windows of the days read: its `next` gives more windows of it');
  assert.equal(await lineOf({ cursor: 'r5' }, 2, 'days'), 'on the screen: read back to 2026-10-15; its `next` reads older days');
  const forward = { screen: { ...page(4, 'days').screen, reached: { side: 'oldest', whole: '2025-01-31' } } };
  assert.equal(linesOf((await searched({ query: 'refund', order: 'oldest' }, [forward])).json)[0], 'on the screen: read forward to 2025-01-31; its `next` reads newer days');
  assert.deepEqual(linesOf((await searched({ query: 'refund' }, [page(4, undefined)])).json), ['on the screen: by words only: search by meaning is off']);
  assert.deepEqual((await searched({ cursor: 'r5' }, [page(10, 'windows')])).asked, [{ cursor: 'r5' }]);
});

test('4: a capped scan with no hit is followed by its `next` three times at most, then says how far it looked; one that finds a hit stops there', async () => {
  const door = fixture('search');
  const empty = (/** @type {string} */ next) => ({ ...door, record: { ...door.record, hits: [], next } });
  const nothing = await searched({ query: 'example', families: ['notes'] }, [empty('k1'), empty('k2'), empty('k3'), empty('k4')]);
  assert.deepEqual(nothing.asked.slice(1), [{ cursor: 'k1' }, { cursor: 'k2' }, { cursor: 'k3' }]);
  assert.equal(linesOf(nothing.json)[1], 'nothing found back to 2026-09-03 14:22; older not searched: pass `cursor`, or give dates or families');
  assert.equal(nothing.json.record.next, 'k4');
  assert.deepEqual(nothing.json.screen, door.screen, 'the screen\'s list is the first answer\'s');
  const found = await searched({ query: 'example', families: ['notes'] }, [empty('k1'), door]);
  assert.equal(found.asked.length, 2);
  assert.equal(found.json.record.hits.length, 3);
  assert.equal((await searched({ cursor: 'k1' }, [empty('k2')])).asked.length, 1);
});

test('4: the screen\'s stretch given whole, its `next` reading older days; not searched said with why, never as nothing on the screen; meaning that waits says what on', async () => {
  const door = fixture('search');
  const whole = await searched({ query: 'example' }, [{ ...door, screen: { ...door.screen, total: 3, next_gives: 'days' } }]);
  assert.equal(linesOf(whole.json)[2], 'on the screen: read back to 2026-10-15, every window shown; its `next` reads older days');
  const none = await searched({ query: 'example' }, [{ ...door, screen: { ...door.screen, total: 0, hits: [], next_gives: 'days' } }]);
  assert.equal(linesOf(none.json)[2], 'on the screen: read back to 2026-10-15, no window matched; its `next` reads older days');
  const unread = await searched({ person: ['Person A'] }, [fixture('search-unread')]);
  assert.deepEqual(linesOf(unread.json), ['1 day of this range is still being read: 2026-11-14', 'the screen\'s text was not searched: the screen records no person']);
  assert.doesNotMatch(unread.json.note, /nothing on the screen/u);
  const waits = await searched({ query: 'booking' }, [{ screen: fixture('search-screen-next').screen }]);
  assert.ok(linesOf(waits.json).includes('on the screen: by words only: search by meaning waits for the Mac to be plugged in'), waits.json.note);
});

test('5: each `person` as the door resolved it, handed on as it came: one person by name and ref, a handle People does not know with no ref', async () => {
  const door = fixture('search-unread');
  const unknown = { asked: 'phone:+15550000099', name: '+1 555 000 0099' };
  const { json, asked } = await searched({ query: 'lunch', person: ['Person A', 'phone:+15550000099'] }, [{ ...door, person: [...door.person, unknown] }]);
  assert.deepEqual(asked[0]?.person, ['Person A', 'phone:+15550000099']);
  assert.deepEqual(json.person, [...door.person, unknown]);
  assert.doesNotMatch(json.note, /may be/u);
});

test('6: search_people asks /v1/people/search alone, its arguments as written; its first line is the door\'s note, no one by the name, a read or a count that stopped at its budget, a next page', async () => {
  /** @param {Record<string, unknown>} args @param {any} door */
  const people = async (args, door) => {
    const context = contextOf([], door);
    const json = plain(await searchPeople.run(/** @type {any} */ (args), /** @type {any} */ (context)));
    assert.deepEqual(context.calls, [['/v1/people/search', args]]);
    return json;
  };
  const two = await people({ name: 'Person A' }, fixture('people'));
  const { note: doorNote, ...door } = fixture('people');
  assert.equal(two.note, `${NOTE} ${doorNote}.`);
  assert.deepEqual({ ...two, note: undefined }, { note: undefined, ...door });
  const elsewhere = await people({ name: 'Example Town' }, fixture('people-elsewhere'));
  assert.deepEqual(linesOf(elsewhere), ['No person goes by this name whole; what else does is in `elsewhere`', 'an `elsewhere` count marked `capped` stopped at its budget: at least that many']);
  assert.deepEqual(elsewhere.elsewhere, fixture('people-elsewhere').elsewhere);
  const capped = await people({ name: 'Example' }, fixture('people-capped'));
  assert.deepEqual(linesOf(capped), ['the read stopped at its budget: the matches with no `reach` were not counted, and follow those counted in People\'s order; `next` goes on']);
  assert.deepEqual(capped.matches, fixture('people-capped').matches);
  assert.deepEqual(linesOf(await people({ name: 'Nobody' }, { matches: [], as_of: '2026-11-14T22:10+00:00' })), ['No person goes by this name']);
  const hidden = 'Names are hidden from you, so no one is found by a name. Find the person in `search` or `read`, then give the placeholder shown for them as `name`.';
  assert.deepEqual(linesOf(await people({ name: 'Person A' }, { matches: [], note: hidden })), hidden.slice(0, -1).split('. '), 'names hidden: the home\'s words alone, never "No person goes by this name"');
  assert.deepEqual(linesOf(await people({ cursor: 'r20' }, { ...fixture('people'), note: undefined, next: 'r21' })), ['more match: `next` gives the next page']);
  assert.deepEqual(linesOf(await people({ id: 'r14' }, fixture('people-hidden'))), [fixture('people-hidden').note]);
});

test('7: the descriptions are the search spec\'s, character for character; the tools are search_people, search, count, read, feedback and, on /mcp alone, access, and no word names `who` or `stats`', () => {
  assert.equal(sha(search.description), '47cd4dec7333ea6e0ed47190c2d952d5ffa286864a66781544ee0da0369ee54e');
  assert.equal(sha(searchPeople.description), 'a1d09b7859da4949098bf35d817afe97c29dcffba56a829672f0614ec2dedaa7');
  assert.equal(sha(count.description), '31f40cc2da818306eaaa875b356d3cbb2ef21bf07d3a53a4b08c313273cc5ae1');
  assert.equal(sha(read.description), '8595d2ceb0a74993fe1f482408600340269113754046fe9126845be0c7d6764a');
  assert.equal(sha(readTool({ links: true }).description), '054eefd9ba413fec32070f4ff70f7e302610896c90899ce5c8ec3b03fdffc260');
  assert.deepEqual(TOOLS.map(tool => tool.name), ['search_people', 'search', 'count', 'read', 'feedback', 'access']);
  assert.deepEqual(ASK_TOOLS.map(tool => tool.name), ['search_people', 'search', 'count', 'read', 'feedback']);
  for (const [what, text] of [['the skill', SKILL_FILE], ['the instructions', INSTRUCTIONS], ...ASK_TOOLS.map(tool => [tool.name, tool.description])]) {
    assert.doesNotMatch(text, /`who`|\bwho,|\bstats\b/u, what);
  }
  assert.match(SKILL_FILE, /`search_people` names/u);
  assert.match(SKILL_FILE, /`count` counts and adds up/u);
  assert.match(INSTRUCTIONS, /Call `count` with no `of` first: it is the map/u);
});

/** @param {Record<string, unknown>} args @param {any[]} counts */
async function counted(args, counts) {
  const context = contextOf([], undefined, { counts });
  const json = plain(await count.run(/** @type {any} */ (args), /** @type {any} */ (context)));
  assert.ok(context.calls.every(([path]) => path === '/v1/count'), 'count reads its one route alone');
  return { json, asked: context.asked('/v1/count') };
}

test('8: count asks its one route, its arguments as written, `match` a map as the model wrote it; every member is the door\'s; nothing read of a day, an extract or a label', async () => {
  const sum = await counted({ of: 'payments', measure: 'amount', by: ['item'], match: { payee: 'acme' }, from: '2026-03-01', to: '2026-03-31', at_least: 10, limit: 20 }, [fixture('count')]);
  assert.deepEqual(sum.asked, [{ of: 'payments', measure: 'amount', by: ['item'], match: { payee: 'acme' }, from: '2026-03-01', to: '2026-03-31', at_least: 10, limit: 20 }]);
  const { note, ...door } = sum.json;
  assert.equal(note, NOTE, 'a whole count with no next opens with the notice alone');
  assert.deepEqual(door, fixture('count'));
  for (const name of ['count-catalog', 'count-hidden', 'count-first']) {
    const { json } = await counted({ of: 'calls' }, [fixture(name)]);
    const { note: _note, ...rest } = json;
    assert.deepEqual(rest, fixture(name), name);
  }
  const hidden = await counted(fixture('call-count-hidden').args, [fixture('count-hidden')]);
  assert.deepEqual(hidden.asked, [fixture('call-count-hidden').args]);
  assert.deepEqual((await counted({ cursor: 'r20' }, [fixture('count')])).asked, [{ cursor: 'r20' }]);
});

test('8: count\'s first line: the days still being read, the words a hidden count left out, a first that found nothing, a next page', async () => {
  assert.deepEqual(linesOf((await counted({ of: 'days', measure: 'sleep', by: ['month'] }, [fixture('count-by-month')])).json),
    ['1 day of this range is still being read: 2026-10-31']);
  const left = await counted({ of: 'messages', words: '+15550000001' }, [{ ...fixture('count-hidden'), not_searched: ['+15550000001'], next: 'r30' }]);
  assert.deepEqual(linesOf(left.json), ['Not searched (a word that could tell where a hidden detail is): +15550000001', 'Search them by the placeholder an answer gave, or a word an answer showed', 'more rows: `next` gives the next page']);
  const none = await counted({ of: 'payments', measure: 'amount', op: 'last' }, [{ ...fixture('count-first'), op: 'last', found: null, ties: undefined }]);
  assert.deepEqual(linesOf(none.json), ['no last: nothing in the range is kept']);
});

/** @param {Record<string, unknown>} args @param {any[]} reads */
async function opened(args, reads) {
  const context = contextOf([], undefined, { reads });
  const told = /** @type {any} */ (await read.run(/** @type {any} */ (args), /** @type {any} */ (context)));
  assert.ok(context.calls.every(([path]) => path === '/v1/read'), 'read reads /v1/read alone');
  return { told, json: plain(told), asked: context.asked('/v1/read') };
}

test('9: read asks /v1/read alone, its arguments as written, `history` as the route takes it; every answer is the door\'s, as it came', async () => {
  const shapes = ['read-record', 'read-chat', 'read-chat-hidden', 'read-line', 'read-lines', 'read-brief', 'read-raw', 'read-screen', 'read-window', 'read-people', 'read-place', 'read-row', 'read-gone'];
  for (const name of shapes) {
    const { json } = await opened({ ref: 'r1' }, [fixture(name)]);
    const { note: _note, ...rest } = json;
    assert.deepEqual(rest, withoutPending(fixture(name)), name);
  }
  assert.deepEqual((await opened({ ref: ['r3', 'r4'], history: 1 }, [fixture('read-refs')])).asked, [fixture('call-read-hidden').args]);
  assert.deepEqual((await opened({ chat: 'r15', from: '2026-10-01', to: '2026-10-07' }, [fixture('read-chat')])).asked, [{ chat: 'r15', from: '2026-10-01', to: '2026-10-07' }]);
  assert.deepEqual((await opened({ from: '2026-10-01', families: ['messages', 'physical'], detail: 'lines' }, [fixture('read-lines')])).asked,
    [{ from: '2026-10-01', families: ['messages', 'physical'], detail: 'lines' }]);
  assert.deepEqual((await opened({ cursor: 'r9', chat: 'r15' }, [fixture('read-chat')])).asked, [{ cursor: 'r9' }]);
});

test('9: a photo is handed to the model as its picture, each the door made one; a photo past the door\'s six, with none, handed on as the door says it (its own `facts`), no line of the tool\'s', async () => {
  const one = await opened({ ref: 'r6' }, [fixture('read-photo-hidden')]);
  assert.equal(one.json.image, 'yes, image 1');
  assert.deepEqual(one.told.images, [{ data: '/9j/2Q==', mimeType: 'image/jpeg' }]);
  const { image: _image, ...past } = fixture('read-photo-hidden');
  const many = { what: 'refs', opened: [...Array.from({ length: 6 }, () => fixture('read-photo-hidden')), past, past] };
  const eight = await opened({ ref: Array.from({ length: 8 }, (_, at) => `r${at + 1}`) }, [many]);
  assert.equal(eight.told.images.length, 6);
  assert.deepEqual(eight.json.opened.slice(6), [past, past], 'a photo with no picture is handed on as the door gave it');
  assert.deepEqual(linesOf(eight.json), []);
});

test('9: read\'s first line: the span a page covers, a count\'s row that moved, a ref gone, the days still being read, a next page', async () => {
  const chat = fixture('read-chat');
  assert.deepEqual(linesOf((await opened({ chat: 'r15' }, [{ ...chat, next: 'r40' }])).json), [`${chat.span.from} to ${chat.span.to}`, '`next` reads on']);
  assert.deepEqual(linesOf((await opened({ ref: 'r8' }, [fixture('read-row')])).json),
    ['this row counted 7 when it was given and counts 8 now: the record moved since; the rows are of now']);
  assert.deepEqual(linesOf((await opened({ ref: 'r7' }, [fixture('read-gone')])).json), ['a ref is gone: erased: this window\'s day was forgotten']);
  const lines = fixture('read-lines');
  assert.deepEqual(linesOf((await opened({ from: '2026-10-04' }, [lines])).json),
    [`${lines.span.from} to ${lines.span.to}`, 'every day of this range is still being read (1 day, 2026-10-04)']);
  const days = { ...lines, span: { from: '2026-10-01', to: '2026-10-07' }, pending: [{ day: '2026-10-05', why: 'new' }, { day: '2026-10-02', why: 'failed' }] };
  assert.deepEqual(linesOf((await opened({ from: '2026-10-01', to: '2026-10-07' }, [days])).json),
    ['2026-10-01 to 2026-10-07', '2 days of this range are still being read, from 2026-10-02 to 2026-10-05']);
});

test('9: a link a record `read` opened shows may be opened after, through the wrapper, its next part by the same `link` and the number it names; one never shown is refused at every part', async () => {
  const record = { ...fixture('read-record'), ref: 'r1', text: `${fixture('read-record').text} Track it at https://example.com/track/2.` };
  /** @type {{ path: string, body: any }[]} */
  const calls = [];
  const door = {
    pass: 'p',
    forModel() { return door; },
    async json(/** @type {string} */ path) { throw new Error(`read GET ${path}`); },
    async post(/** @type {string} */ path, /** @type {any} */ body) {
      calls.push({ path, body });
      if (path === '/v1/read') return structuredClone(record);
      if (path === '/v1/restore-details') return { level: 'all', epoch: 3, params: body.params.map((/** @type {{ value: string }} */ { value }) => ({ value, marks: [], unknown: [] })) };
      if (path === '/v1/hide-details') return { level: 'all', epoch: 3, texts: body.texts.map((/** @type {any} */ each) => each.map((/** @type {any} */ piece) => piece.text).join('')) };
      throw new Error(`the synthetic door serves no POST ${path}`);
    },
  };
  const asks = readTool({ links: true });
  const handles = openHandles();
  const wrapper = openWrapper({ table: 'chat:c-0001', to: 'anthropic', agent: false });
  const ran = await wrapper.run(/** @type {any} */ (asks), { ref: 'r1' }, { door: /** @type {any} */ (door), seen: handles.seen });
  const { note: _note, ...answer } = JSON.parse(ran.text);
  assert.deepEqual(answer, record, 'the answer is the door\'s');
  assert.deepEqual(calls.map(call => call.path), ['/v1/read'], 'a route read asks no restore and no hide');
  handles.ran(ran);
  assert.ok(handles.seen('https://example.com/orders/1'), 'its link');
  assert.ok(handles.seen('https://example.com/track/2'), 'a link in its text');
  assert.ok(!handles.seen('https://example.com/elsewhere'));
  /** @type {string[]} */
  const out = [];
  const stopped = new Error('stopped before the page is fetched');
  const opening = (/** @type {Record<string, unknown>} */ args) => wrapper.run(/** @type {any} */ (asks), args, { door: /** @type {any} */ (door), seen: handles.seen,
    outbound: async (/** @type {string} */ link) => { out.push(link); throw stopped; } });
  calls.length = 0;
  await assert.rejects(opening({ link: 'https://example.com/orders/1' }), error => error === stopped);
  await assert.rejects(opening({ link: 'https://example.com/orders/1', cursor: '19000' }), error => error === stopped);
  assert.deepEqual(out, ['https://example.com/orders/1', 'https://example.com/orders/1']);
  assert.ok(calls.every(call => call.path === '/v1/restore-details'), 'a link is the wrapper\'s: restored, never posted to a route');
  await assert.rejects(opening({ link: 'https://example.com/elsewhere', cursor: '19000' }), /in neither the person's words nor a record/u);
  await assert.rejects(opening({ link: 'https://example.com/orders/1', cursor: 'r9' }), /the number its last part named/u);
});

test('10: a person several people may be is one line naming each by its handle; no one by the name, how to find them', () => {
  const [, , nobody, several] = fixture('refusals');
  assert.equal(new DoorRefusal(404, 'PERSON_UNKNOWN', nobody.body.message, null, nobody.body).message,
    'No such person: Person Z. Find them with `search_people`.');
  const hidden = { ...several.body, matches: [{ ...several.body.matches[0], ref: 'r1' }, { ...several.body.matches[1], ref: 'r2' }] };
  assert.equal(new DoorRefusal(404, 'PERSON_UNKNOWN', hidden.message, null, hidden).message,
    'Several people go by Per: ask by one of their refs. Find them with `search_people`. They are: r1 Person A; r2 Person B. Pass the one meant as `person`, by its handle.');
});

test('10: every refusal of the contract is said in one line; A1\'s shapes and the cursors\' sentences each in the words the door gives now', () => {
  /** @param {number} status @param {Record<string, unknown>} body @param {number | null} [retry] */
  const said = (status, body, retry = null) => new DoorRefusal(status, String(body.code), String(body.message), retry, body).message;
  for (const { status, retry_after: retry, body } of fixture('refusals')) {
    assert.doesNotMatch(said(status, body, retry ?? null), /\n/u, body.code);
  }
  const notYet = '; this says nothing of what the record holds.';
  assert.equal(said(503, { code: 'INDEX_BUILDING', message: 'the record\'s index is being built', building: ['words'] }, 5),
    `The home could not answer this yet: it is still building what it reads (the record's index is being built). Ask again in 5 s${notYet}`);
  assert.equal(said(503, { code: 'INDEX_BUILDING', message: 'your people are being prepared', building: ['people'] }, 2),
    `The home could not answer this yet: it is still building what it reads (your people are being prepared). Ask again in 2 s${notYet}`);
  assert.equal(said(422, { code: 'BAD_PARAMETER', message: '`person` is a ref that names no one held' }),
    'An argument is not one this takes: `person` is a ref that names no one held. Fix it and ask again.');
  const [, , , , fits, day] = fixture('refusals');
  assert.equal(said(422, fits.body), 'Too much to count in one call. 2024-03-01 → 2026-11-14 fits: ask it, then the rest with `to: 2024-02-29`.');
  assert.equal(said(422, day.body), 'Too much to count in one call, and not one whole day of it fits, so no range would: one day of this is too much to count in one call: narrow by a filter, a chat or more words.');
  assert.equal(said(409, { code: 'CURSOR_EXPIRED', message: 'what this page was read from changed since it was given (the index was built again, something was erased, or what the ask named changed): ask again' }),
    'That cursor or handle no longer holds: what this page was read from changed since it was given (the index was built again, something was erased, or what the ask named changed): ask again, without it.');
});

/** @type {Record<string, { properties: Record<string, { description?: string }> }>} */
const PARAMS_FILE = JSON.parse(readFileSync(new URL('../../packages/home/contract/params.json', import.meta.url), 'utf8'));
/**
 * @param {Record<string, any>} shape
 * @returns {any}
 */
const schemaOf = shape => z.toJSONSchema(z.object(shape), { target: 'draft-7' });
const SCHEMA_PINS = ['50ab90f99e1c1eda69173036f71771f55783057cbd794f7d7cf4b9f713566e98', '8658d7f169fb1bc0cb81b8cdb6c1b4147ff8f739da5f5ee83fb29cb1426a1bc0',
  '4be2998cfce80cfc40a50d9e398cefcc4d1ab72e246c1c5bf96089037c97e6c2', 'e9996d7c8c1dcb787b38661525c2a1277fdcaa22bae8489eff4470fa5f314875'];
/** @type {[any, string][]} */
const ROUTED = [[searchPeople, '/v1/people/search'], [search, '/v1/search'], [count, '/v1/count'], [read, '/v1/read']];

test('11: each route tool takes its route\'s parameters as the params file states them, descriptions and all; a member the file adds shows in it; `/mcp` lists them so', async () => {
  for (const [tool, route] of ROUTED) {
    assert.deepEqual(schemaOf(tool.inputSchema), schemaOf(inputSchemaOf(route)), tool.name);
    assert.deepEqual(Object.keys(tool.inputSchema), Object.keys(PARAMS_FILE[route]?.properties ?? {}), tool.name);
    for (const [name, member] of Object.entries(PARAMS_FILE[route]?.properties ?? {})) {
      assert.equal(schemaOf(tool.inputSchema).properties[name].description, member.description, `${tool.name}.${name}`);
    }
  }
  assert.deepEqual(Object.keys(readTool({ links: true }).inputSchema), [...Object.keys(PARAMS_FILE['/v1/read']?.properties ?? {}), 'link']);
  assert.deepEqual([schemaOf(read.inputSchema).properties.last?.pattern, schemaOf(read.inputSchema).properties.products?.type], ['^[1-9][0-9]{0,3}[mh]$', 'array'], 'read takes `last` and `products`');
  assert.match(read.description, /`last` \("45m", "3h", at most "24h"\): the stretch ending now/u);
  assert.match(read.description, /`freshness`, which sources have not synced lately; `products` keeps some, as in search\./u);
  const file = /** @type {any} */ (PARAMS_FILE['/v1/count']);
  const more = shapeOf({ ...file, properties: { ...file.properties, round: { type: 'integer', minimum: 0, description: 'the digits kept' } } });
  assert.equal(schemaOf(more).properties.round.description, 'the digits kept');
  assert.throws(() => inputSchemaOf('/v1/nowhere'), /names no route \/v1\/nowhere/u);
  assert.deepEqual(ROUTED.map(([tool]) => sha(JSON.stringify(schemaOf(tool.inputSchema)))), SCHEMA_PINS);

  const [near, far] = InMemoryTransport.createLinkedPair();
  const server = serverOf(/** @type {any} */ ({ door: { json: async () => ({ text: 'Your access to this Lifestream:\n1. Everything · all time' }) } }), () => undefined);
  await server.connect(far);
  const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
  await client.connect(near);
  try {
    const { tools } = await client.listTools();
    for (const [tool, route] of ROUTED) {
      const listed = tools.find(each => each.name === tool.name);
      assert.deepEqual(Object.keys(listed?.inputSchema.properties ?? {}), Object.keys(PARAMS_FILE[route]?.properties ?? {}), tool.name);
    }
  } finally {
    await client.close();
  }
});

test('13: Ask checks a model\'s arguments against the tool\'s schema before any call: one line naming the first that does not fit; a list given one value only where the schema takes one', () => {
  const [searchPeopleTool, searchTool, countTool, readAsk] = ASK_TOOLS;
  assert.equal(unfit(/** @type {any} */ (searchTool), { query: 'x', person: ['r7'] }), null);
  const line = unfit(/** @type {any} */ (searchTool), { query: 'x', person: 'r7' });
  assert.match(String(line), /^An argument is not one this takes: `person` expected array, received string\. Fix it and ask again\.$/u);
  assert.equal(unfit(/** @type {any} */ (readAsk), { ref: 'r3' }), null, '`read` takes one ref or a list');
  assert.equal(unfit(/** @type {any} */ (readAsk), { ref: ['r3', 'r4'] }), null);
  assert.match(String(unfit(/** @type {any} */ (countTool), { of: 'payments', by: 'month' })), /`by`/u);
  assert.match(String(unfit(/** @type {any} */ (readAsk), { ref: 'r3', history: true })), /`history`/u);
  assert.equal(unfit(/** @type {any} */ (searchPeopleTool), {}), null, 'a rule across members is the door\'s');
  assert.equal(unfit(/** @type {any} */ (searchPeopleTool), undefined), null);
});

test('14: a `limit` past its most is given as its most and said in one line, its `next` kept; search\'s and count\'s alike, never refused (0 still is)', async () => {
  const [, searchTool, countTool] = ASK_TOOLS;
  assert.equal(unfit(/** @type {any} */ (searchTool), { query: 'x', limit: 120 }), null);
  assert.equal(unfit(/** @type {any} */ (countTool), { of: 'calls', limit: 1_000 }), null);
  assert.match(String(unfit(/** @type {any} */ (searchTool), { query: 'x', limit: 0 })), /`limit`/u);
  const many = await searched({ from: '2025-01-01', families: ['mail'], limit: 120 }, [fixture('search-record-by-time')]);
  assert.equal(many.asked[0]?.limit, 50);
  assert.equal(linesOf(many.json)[0], '`limit` is 50 at most: 50 given');
  assert.equal(many.json.record.next, fixture('search-record-by-time').record.next, 'the clamped page goes on by the door\'s `next`');
  const within = await searched({ from: '2025-01-01', families: ['mail'], limit: 50 }, [fixture('search-record-by-time')]);
  assert.ok(!linesOf(within.json).some((/** @type {string} */ line) => line.includes('`limit`')), 'a `limit` within its most says nothing');
  const rows = await counted({ of: 'calls', by: ['item'], limit: 500 }, [{ ...fixture('count'), next: 'cursor:count:c2' }]);
  assert.equal(rows.asked[0]?.limit, 100);
  assert.deepEqual(linesOf(rows.json), ['`limit` is 100 at most: 100 given', 'more rows: `next` gives the next page']);
  assert.equal(rows.json.next, 'cursor:count:c2');
});

/**
 * @param {string} newest
 * @param {number} n
 */
const daysBack = (newest, n) => Array.from({ length: n }, (_, at) => ({ day: new Date(Date.parse(`${newest}T00:00:00Z`) - at * 86_400_000).toISOString().slice(0, 10), why: 'new' }));

test('14: the days still being read are one line, their count and first and last, never the list; a range wholly unread says so; count\'s and read\'s alike', async () => {
  const pending = daysBack('2026-11-01', 100);
  const empty = { record: { as_of: '2026-11-14T22:10+00:00', total: 0, capped: false, hits: [], pending, pending_more: 2_974, next: null } };
  const { json } = await searched({ query: 'example' }, [empty]);
  assert.equal(json.note, `${NOTE} 3,074 days of this range are still being read, from before ${pending.at(-1)?.day} to 2026-11-01.`);
  assert.ok(json.note.length < 200, `${json.note.length} characters`);
  assert.doesNotMatch(JSON.stringify(json), /"pending/u, 'the list is left out of the answer');
  const whole = { record: { ...empty.record, pending: daysBack('2026-10-03', 3), pending_more: undefined } };
  assert.deepEqual(linesOf((await searched({ query: 'example', from: '2026-10-01', to: '2026-10-03' }, [whole])).json),
    ['every day of this range is still being read (3 days, 2026-10-01 to 2026-10-03)']);
  assert.deepEqual(linesOf((await searched({ query: 'example', from: '2026-09-30', to: '2026-10-03' }, [whole])).json),
    ['3 days of this range are still being read, from 2026-10-01 to 2026-10-03'], 'a range of four days, three unread, is not wholly unread');
  const counts = await counted({ of: 'days', measure: 'sleep', by: ['month'], from: '2026-10-31', to: '2026-10-31' }, [fixture('count-by-month')]);
  assert.deepEqual(linesOf(counts.json), ['every day of this range is still being read (1 day, 2026-10-31)']);
  assert.doesNotMatch(JSON.stringify(counts.json), /"pending/u);
  const lines = await opened({ from: '2026-10-04' }, [fixture('read-lines')]);
  assert.doesNotMatch(JSON.stringify(lines.json), /"pending/u);
});

/**
 * @param {number} first
 * @param {number} count
 * @param {string | null} next
 */
function linesPage(first, count, next) {
  const at = (/** @type {number} */ minute) => `2026-10-04T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}+01:00`;
  return {
    what: 'lines',
    span: { from: at(first), to: at(first + count) },
    lines: Array.from({ length: count }, (_, n) => ({
      ref: `r${first + n + 100}`, at: at(first + n), day: '2026-10-04', family: 'notes', text: `line ${first + n}: ${'quiet harbour words '.repeat(12)}`,
    })),
    as_of: '2026-11-14T22:10+00:00',
    next,
  };
}

test('14: a stretch reads in pages of round F\'s size: the door\'s pages joined in order while under PAGE_CHARS, never past the model\'s answer; a page that would pass it, or a refusal, left for `next`', async () => {
  const pages = [linesPage(0, 15, 'cursor:read:p1'), linesPage(15, 15, 'cursor:read:p2'), linesPage(30, 15, 'cursor:read:p3'), linesPage(45, 15, null)];
  assert.ok(modelChars(pages[0]) > 4_500 && modelChars(pages[0]) < 6_000, `${modelChars(pages[0])}`);
  const day = await opened({ from: '2026-10-04' }, structuredClone(pages));
  assert.deepEqual(day.asked, [{ from: '2026-10-04' }, { cursor: 'cursor:read:p1' }, { cursor: 'cursor:read:p2' }]);
  assert.deepEqual(day.json.lines.map((/** @type {any} */ line) => line.at), pages.slice(0, 3).flatMap(page => page.lines.map(line => line.at)), 'every line once, in order');
  assert.equal(day.json.next, 'cursor:read:p3', 'the last page joined goes on');
  assert.deepEqual(day.json.span, { from: pages[0]?.span.from, to: pages[2]?.span.to });
  assert.ok(modelChars(day.json) >= PAGE_CHARS && modelChars(day.json) <= PAGE_MOST, `${modelChars(day.json)}`);
  assert.ok(JSON.stringify(day.json).length < MAX_CHARS);
  assert.equal(linesOf(day.json).at(-1), '`next` reads on: a question about the whole span reads every page to the end');
  const large = [linesPage(0, 36, 'cursor:read:q1'), linesPage(36, 36, null)];
  assert.ok(modelChars(large[0]) < PAGE_CHARS);
  const alone = await opened({ from: '2026-10-04' }, structuredClone(large));
  assert.equal(alone.asked.length, 2);
  assert.deepEqual(alone.json.lines.length, 36);
  assert.equal(alone.json.next, 'cursor:read:q1');
  assert.ok(JSON.stringify(alone.json).length < MAX_CHARS);
  const refused = await opened({ from: '2026-10-04' }, [linesPage(0, 20, 'cursor:read:r1')]);
  assert.deepEqual([refused.json.lines.length, refused.json.next], [20, 'cursor:read:r1']);
  const brief = fixture('read-brief');
  const second = { what: 'brief', span: { from: '2026-10-02', to: '2026-10-04' }, days: [{ day: '2026-10-02', lines: [{ text: 'an example walk' }] }, { day: '2026-10-04', lines: [] }], next: null };
  const briefed = await opened({ from: '2026-10-01', to: '2026-10-04' }, [{ ...brief, span: { from: '2026-10-01', to: '2026-10-02' }, days: brief.days.slice(0, 2), next: 'cursor:read:b1' }, second]);
  assert.deepEqual(briefed.json.days.map((/** @type {any} */ each) => [each.day, each.lines.length]), [['2026-10-01', 1], ['2026-10-02', 2], ['2026-10-04', 0]]);
  assert.deepEqual(briefed.json.span, { from: '2026-10-01', to: '2026-10-04' });
  const chat = await opened({ chat: 'r15' }, [{ ...fixture('read-chat'), next: 'cursor:read:c1' }, fixture('read-chat')]);
  assert.equal(chat.asked.length, 1);
});

test('14: twenty minutes of the screen read in order through `read`, in one answer; a minute gone past the first page (the door refuses its cursor) leaves the rest to `next`', async () => {
  const screen = fixture('read-screen');
  const minute = (/** @type {number} */ m) => `2026-11-02T06:${String(m).padStart(2, '0')}+01:00`;
  const page = (/** @type {number} */ from, /** @type {number} */ to, /** @type {string | null} */ next) => ({
    ...screen, span: { from: minute(from), to: minute(to) },
    lines: Array.from({ length: to - from }, (_, n) => ({ at: minute(from + n), app: 'Example Browser', title: 'Example page', text: `line of minute ${from + n}` })),
    ...(next === null ? {} : { next }),
  });
  const asked = { from: minute(0), to: minute(20), families: ['screen'], detail: 'raw' };
  const read20 = await opened(asked, [page(0, 10, 'cursor:read:s1'), page(10, 20, null)]);
  assert.deepEqual(read20.asked, [asked, { cursor: 'cursor:read:s1' }]);
  const times = read20.json.lines.map((/** @type {any} */ line) => line.at);
  assert.deepEqual(times, Array.from({ length: 20 }, (_, m) => minute(m)), 'its minutes in order, each once');
  assert.equal(read20.json.next, undefined);
  assert.deepEqual(linesOf(read20.json), [`${minute(0)} to ${minute(20)}`]);
  const gone = await opened(asked, [page(0, 10, 'cursor:read:s1'), new DoorRefusal(410, 'CURSOR_EXPIRED', 'erased', null)]);
  assert.deepEqual([gone.json.lines.length, gone.json.next], [10, 'cursor:read:s1']);
  assert.deepEqual(linesOf(gone.json), [`${minute(0)} to ${minute(10)}`, '`next` reads on: a question about the whole span reads every page to the end']);
});

const CHAT_MODEL = 'openrouter:openai/gpt-6-luna';
const MODELS = {
  connections: [{ id: 'openrouter', kind: 'key', name: 'OpenRouter', line: null }],
  uses: { chat: { value: CHAT_MODEL, thinking: 'medium', fits: [CHAT_MODEL], menu: {
    default: null, rows: [{ value: CHAT_MODEL, name: 'GPT-6 Luna', account: null, chosen: true }], local: null, more: { words: 'More', use: 'chat', work: null }, off: null,
  } } },
  models: { [CHAT_MODEL]: { id: CHAT_MODEL, connection: 'openrouter', model: 'openai/gpt-6-luna', name: 'GPT-6 Luna', input: ['text', 'image'], tools: true, thinking: ['low', 'medium', 'high'],
    context_tokens: null, chat: 'door', suggested: ['chat'], group: 'OpenRouter', leaves: 'OpenRouter', state: 'ready', line: null } },
};

/** @param {string} level @param {Record<string, (body: any, pass: string) => unknown>} [answers] */
async function fixtureDoor(level, answers = {}) {
  /** @type {{ method: string, path: string, body: any }[]} */
  const calls = [];
  const citation = fixture('citations').r3;
  /** @type {Record<string, (body: any, pass: string) => unknown>} */
  const routes = {
    'GET /v1/me': (_body, pass) => ({ id: pass, kind: pass === 'agent-pass' ? 'agent' : null, resource: null, turn: null }),
    'GET /v1/models': () => MODELS,
    'GET /v1/clock': () => ({ id: 'clock-1', zone: 'UTC', start_hour: 4, runs: [{ day: '2026-01-01', start_ms: Date.parse('2026-01-01T04:00:00Z'), days: 10_000, zone: 'UTC' }] }),
    'GET /v1/privacy/chat': () => ({ level, epoch: 1 }),
    'GET /v1/people': () => JSON.parse(readFileSync(new URL('./fake/people-you.json', import.meta.url), 'utf8')),
    'POST /v1/hide-details': body => ({ level, epoch: 1, texts: body.texts.map((/** @type {{ text: string }[]} */ pieces) => pieces.map(piece => piece.text).join('')) }),
    'POST /v1/restore-details': body => (typeof body.text === 'string'
      ? { level, epoch: 1, text: body.text, marks: [], unknown: [], refs: body.text.includes('[r1]') ? [{ handle: 'r1', ref: citation.ref }] : [], citations: { r1: citation } }
      : { level, epoch: 1, params: (body.params ?? []).map((/** @type {{ value: string }} */ { value }) => ({ value, marks: [], unknown: [] })) }),
    'POST /v1/search': () => fixture('search-hidden'),
    'POST /v1/count': body => (Object.keys(body.args).length === 0 ? fixture('count-catalog') : fixture('count-hidden')),
    'POST /v1/people/search': () => fixture('people-hidden'),
    'POST /v1/read': () => fixture('read-row-hidden'),
    ...answers,
  };
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const path = String(request.url).split('?')[0]?.replace(/^\/v1\/privacy\/chat\/.*$/u, '/v1/privacy/chat') ?? '';
    const body = raw === '' ? {} : JSON.parse(raw);
    calls.push({ method: String(request.method), path, body });
    const route = routes[`${request.method} ${path}`];
    const pass = String(request.headers.authorization).replace(/^Bearer /u, '');
    response.writeHead(route === undefined ? 404 : 200, { 'content-type': 'application/json' })
      .end(JSON.stringify(route === undefined ? { code: 'NO_ROUTE', message: `no ${path}` } : route(body, pass)));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return { calls, url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done(undefined)); }) };
}

/** @param {{ method: string, path: string, body: any }[]} calls */
const routeCalls = calls => calls.filter(call => ['/v1/search', '/v1/count', '/v1/people/search', '/v1/read'].includes(call.path));

test('15: one Ask question at each level and one /mcp call, against the hidden fixtures: answered, cited, kept; every route read a POST of `{args, to, shown}`, none a hide, a restore or `/v1/describe`', async () => {
  const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  /** @type {unknown[][]} */
  const bodies = [];
  /** @param {unknown[]} list */
  const sorted = list => list.map(each => JSON.stringify(each)).sort();
  for (const level of ['none', 'names', 'all']) {
    const door = await fixtureDoor(level);
    const handler = createHandler({ door: door.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }),
      machine: mkdtempSync(join(tmpdir(), 'lifestream-one-path-')), conversations: openMemoryConversations(), titles: false }, log: () => undefined });
    const server = createServer(handler);
    await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
    const at = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('search', { query: 'refund', person: ['[[Person 1]]'] }), fauxToolCall('count', { of: 'payments', by: ['item'] }),
          fauxToolCall('search_people', { name: '[[Person 1]]' }), fauxToolCall('read', { ref: 'r1' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('The refund came through [r1].'),
      ]);
      const asked = await fetch(`${at}/ask`, { method: 'POST', headers: { authorization: 'Bearer reader-pass', 'content-type': 'application/json' }, body: JSON.stringify({ submission: minted(), question: 'Did the refund come?' }) });
      const events = (await asked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
      const done = events.find(event => event.type === 'done')?.message;
      assert.equal(done?.end, 'done', JSON.stringify(events));
      assert.equal(done.text, 'The refund came through [r1].');
      assert.deepEqual(done.refs, { r1: fixture('citations').r3 }, 'the cited handle kept as the door\'s citation');
      assert.deepEqual(done.steps.map((/** @type {any} */ step) => step.name), ['search', 'count', 'search_people', 'read']);
      const reads = routeCalls(door.calls);
      assert.ok(reads.every(call => call.method === 'POST'), 'every route read is the one path');
      assert.deepEqual(sorted(reads.map(call => [call.path, call.body.args])), sorted([
        ['/v1/count', {}],
        ['/v1/search', { query: 'refund', person: ['[[Person 1]]'], lists: ['record', 'screen'] }],
        ['/v1/count', { of: 'payments', by: ['item'] }],
        ['/v1/people/search', { name: '[[Person 1]]' }],
        ['/v1/read', { ref: 'r1' }],
      ]));
      assert.ok(reads.every(call => call.body.to === CHAT_MODEL && call.body.shown.includes('Did the refund come?')), JSON.stringify(reads));
      assert.deepEqual(door.calls.filter(call => call.path === '/v1/hide-details' && call.body.what === 'read'), [], 'no route\'s answer hidden by the server');
      assert.deepEqual(door.calls.filter(call => call.path === '/v1/describe'), []);
      bodies.push(sorted(reads.map(call => call.body)));

      const agent = new Client({ name: 'synthetic-agent', version: '1.0.0' });
      await agent.connect(new StreamableHTTPClientTransport(new URL(`${at}/mcp`), { requestInit: { headers: { authorization: 'Bearer agent-pass' } } }));
      try {
        const from = door.calls.length;
        const result = /** @type {any} */ (await agent.callTool({ name: 'search', arguments: { query: 'refund' } }));
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const { note, ...answer } = JSON.parse(result.content[0].text);
        assert.ok(String(note).startsWith(NOTE));
        assert.deepEqual(answer, fixture('search-hidden'));
        assert.deepEqual(routeCalls(door.calls.slice(from)).map(call => [call.method, call.path, call.body]),
          [['POST', '/v1/search', { args: { query: 'refund', lists: ['record', 'screen'] }, to: 'agent', shown: [] }]]);
        assert.ok(!door.calls.slice(from).some(call => call.path === '/v1/hide-details' || call.path === '/v1/restore-details'));
      } finally {
        await agent.close();
      }
    } finally {
      await handler.close?.(5_000);
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
      await door.close();
    }
  }
  assert.deepEqual(bodies[1], bodies[0], 'the level is the door\'s: the server asks the same at every level');
  assert.deepEqual(bodies[2], bodies[0]);
});

test('16: what Chat\'s model was shown is what the home showed it: each tool answer\'s words, never the model\'s own answer nor what it wrote into a call', async () => {
  const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const searched = /** @type {any} */ (fixture('search-hidden'));
  searched.not_searched = ['Rosalind'];
  searched.record.hits[0].snippet = 'the refund for order 4411 came';
  const door = await fixtureDoor('all', { 'POST /v1/search': () => searched });
  const handler = createHandler({ door: door.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }),
    machine: mkdtempSync(join(tmpdir(), 'lifestream-shown-')), conversations: openMemoryConversations(), titles: false }, log: () => undefined });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const at = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  /** @param {Record<string, unknown>} body */
  const ask = async body => {
    const asked = await fetch(`${at}/ask`, { method: 'POST', headers: { authorization: 'Bearer reader-pass', 'content-type': 'application/json' }, body: JSON.stringify({ submission: minted(), ...body }) });
    const events = (await asked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    const done = events.find(event => event.type === 'done')?.message;
    assert.equal(done?.end, 'done', JSON.stringify(events));
    return done;
  };
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search', { query: 'Rosalind Quorne refund' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Rosalind Quorne sent order 7302.'),
      fauxAssistantMessage([fauxToolCall('search_people', { name: 'Rosalind Quorne' }), fauxToolCall('search', { query: 'order 4411' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ]);
    const first = await ask({ question: 'Did the refund come?' });
    await ask({ question: 'Who sent it?', chat: first.chat });
    const later = routeCalls(door.calls).filter(call => call.body.args.name !== undefined || call.body.args.query === 'order 4411');
    assert.deepEqual(later.map(call => call.path).sort(), ['/v1/people/search', '/v1/search']);
    for (const { body } of later) {
      const words = body.shown.join(' ').toLowerCase();
      assert.match(words, /\b4411\b/u, 'a number a tool answer showed is shown');
      assert.match(words, /who sent it/u);
      assert.doesNotMatch(words, /rosalind|quorne|7302/u, 'neither the model\'s answer nor its own call\'s words said back');
    }
  } finally {
    await handler.close?.(5_000);
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
    await door.close();
  }
});

test('17: a page read again in a later context says back what the model once wrote, and none of it is shown: the name it wrote answers as a name no one has', async () => {
  const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const searched = /** @type {any} */ (fixture('search-hidden'));
  searched.not_searched = ['Rosalind'];
  searched.read_as = { without: ['the'], as: { rosalind: ['rosalynd'] } };
  searched.variants = { rosalind: ['rosalinde'] };
  searched.person = [{ asked: 'Rosalind', name: '[[Person 1]]' }];
  searched.record.hits[0].snippet = 'the lantern came on Tuesday';
  const counted = /** @type {any} */ ({ ...fixture('count-hidden'), not_searched: ['Rosalind'], matched: { payee: { rosalind: ['[[Person 1]]'] } } });
  const door = await fixtureDoor('all', {
    'POST /v1/search': () => searched,
    'POST /v1/count': (/** @type {any} */ body) => (Object.keys(body.args).length === 0 ? fixture('count-catalog') : counted),
    'POST /v1/hide-details': (/** @type {any} */ body) => ({ level: 'all', epoch: 1, texts: body.texts.map((/** @type {{ text: string }[]} */ pieces) => pieces.map(piece => piece.text).join('').replaceAll('Rosalind', '[[Person 1]]')) }),
  });
  const handler = createHandler({ door: door.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }),
    machine: mkdtempSync(join(tmpdir(), 'lifestream-echo-')), conversations: openMemoryConversations(), titles: false, liveMs: 0 }, log: () => undefined });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const at = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  /** @param {Record<string, unknown>} body */
  const ask = async body => {
    const asked = await fetch(`${at}/ask`, { method: 'POST', headers: { authorization: 'Bearer reader-pass', 'content-type': 'application/json' }, body: JSON.stringify({ submission: minted(), ...body }) });
    const events = (await asked.text()).split('\n').filter(line => line !== '').map(line => JSON.parse(line));
    const done = events.find(event => event.type === 'done')?.message;
    assert.equal(done?.end, 'done', JSON.stringify(events));
    return done;
  };
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search', { query: 'Rosalind lantern' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Looked.'),
      fauxAssistantMessage([fauxToolCall('search', { cursor: 'r5' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('count', { of: 'payments', match: { payee: 'Rosalind' } })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('search_people', { name: 'Rosalind' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ]);
    const first = await ask({ question: 'Did the lantern come?' });
    await ask({ question: 'And after?', chat: first.chat });
    const people = routeCalls(door.calls).filter(call => call.path === '/v1/people/search');
    assert.equal(people.length, 1);
    const words = people[0]?.body.shown.join(' ').toLowerCase();
    assert.match(words, /\blantern\b/u, 'a word a hit showed is shown');
    assert.match(words, /\btuesday\b/u);
    assert.doesNotMatch(words, /rosalind|rosalynd|rosalinde/u, 'no member that says back the model\'s own words, on any page of any context');
  } finally {
    await handler.close?.(5_000);
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
    await door.close();
  }
});
