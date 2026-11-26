// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chosenOf, LIMITS, readyModels, voiceRow } from '../lib/ask/ask.mjs';
import { homeLinkFixture } from './asking.mjs';

const READY = JSON.parse(readFileSync(fileURLToPath(new URL('../../homelink/Tests/Fixtures/ask-ready.json', import.meta.url)), 'utf8'));
const PARAKEET = 'runner:runner-macbook-pro-0001/parakeet-unified-en-0.6b';
const OTHER = 'runner:runner-mac-mini-bb01/parakeet-unified-en-0.6b';
const SCRIBE = 'openrouter:elevenlabs/scribe-v2';

/** @param {string} value @param {string} name @param {string | null} [account] */
const row = (value, name, account = null) => ({ value, name, account, chosen: false });

/**
 * @typedef {ReturnType<typeof row>} MenuRow
 * @param {{ words: string, rows?: MenuRow[], local?: MenuRow[], route: string | null, line?: string | null, chat?: unknown, leaves?: string | null }} home
 */
const reads = ({ words, rows = [], local = [], route, line = null, chat = 'none', leaves = null }) => ({
  listed: { connectors: [{ id: 'ask', members: [{ key: 'llm.voice', value: 'default', words, steps: null, route, line, menu: {
    default: { value: 'default', name: words, account: null, chosen: true }, rows, local: local.length === 0 ? null : { label: 'Local', rows: local },
    more: { words: 'More', use: 'audio', work: 'ask/voice' }, off: { value: 'off', name: 'Off', account: null, chosen: false },
  } }] }] },
  privacy: { chat, voice: { leaves } },
});

test('1: no model that writes out a note: not ready, the home\'s line', () => {
  assert.deepEqual(voiceRow(reads({ words: 'No model yet', route: null, line: 'Choose a model for Voice notes' })), READY.voices['not ready']);
});

test('2: a route that sends the note as it is, under Hide all: the caution names who the door says it leaves for; none when the door says it leaves for no one', () => {
  const sent = { words: 'Default · Scribe v2', rows: [row(SCRIBE, 'Scribe v2')], route: SCRIBE, chat: 'all' };
  assert.deepEqual(voiceRow(reads({ ...sent, leaves: 'OpenRouter' })), READY.voices['sent as it is, under Hide all']);
  assert.equal(voiceRow(reads({ ...sent, leaves: null })).caution, null);
  assert.equal(voiceRow(reads({ ...sent, chat: 'none', leaves: 'OpenRouter' })).caution, null, 'a level that hides nothing says no caution');
});

test('3: Parakeet installed, its runner away: left out of the menu, still ready, named in the home\'s words', () => {
  assert.deepEqual(voiceRow(reads({ words: 'Default · Parakeet', route: PARAKEET, chat: 'all' })), READY.voices['Parakeet\'s runner away']);
});

test('4: the row the apps decode first, Parakeet ready on a runner beside a route that sends the note as it is: each choice its name, the local one not sent', () => {
  assert.deepEqual(voiceRow(reads({ words: 'Default · Parakeet', rows: [row(SCRIBE, 'Scribe v2')], local: [row(PARAKEET, 'Parakeet')], route: PARAKEET })), READY.voice);
});

test('5: two runners offer Parakeet, the home\'s route the second\'s: each choice names its Mac, the row the second; while that runner is away, the home\'s words', () => {
  const local = [row(PARAKEET, 'Parakeet', 'MacBook Pro'), row(OTHER, 'Parakeet', 'Mac mini')];
  const voice = voiceRow(reads({ words: 'Default · Parakeet', local, route: OTHER }));
  assert.deepEqual([voice.ready, voice.words, voice.choices], [true, 'Parakeet · Mac mini',
    [{ value: PARAKEET, words: 'Parakeet · MacBook Pro', sent: false }, { value: OTHER, words: 'Parakeet · Mac mini', sent: false }]]);
  const away = voiceRow(reads({ words: 'Default · Parakeet', local: [row(PARAKEET, 'Parakeet')], route: OTHER }));
  assert.deepEqual([away.ready, away.words, away.line], [true, 'Default · Parakeet', null]);
});

/**
 * @param {Partial<import('../lib/ask/reach.mjs').Row> & { id: string, connection: string }} row
 * @returns {import('../lib/ask/reach.mjs').Row}
 */
const chatRow = row => ({
  model: row.id.slice(row.id.indexOf(':') + 1), name: row.id, input: ['text', 'image'], tools: true, thinking: ['low', 'medium', 'high'], context_tokens: 200_000,
  chat: 'door', group: 'OpenRouter', leaves: 'OpenRouter', state: 'ready', line: null, ...row,
});
const LUNA = chatRow({ id: 'openrouter:openai/gpt-6-luna', name: 'GPT-6 Luna', connection: 'openrouter' });
const OPUS = chatRow({ id: 'claude:claude-opus-5-5', name: 'Claude Opus 5.5', connection: 'claude', chat: 'program', group: 'Claude',
  leaves: 'Anthropic', state: 'unavailable', line: 'Claude isn\'t set up on this Mac yet' });
const LOCAL = chatRow({ id: 'address:llama3.2', name: 'llama3.2', connection: 'address', input: ['text'], thinking: [], context_tokens: null, group: 'Other server',
  leaves: null });
/** @param {import('../lib/ask/reach.mjs').Row[]} rows @param {string | null} value @param {string[]} [menu] */
const modelsRead = (rows, value, menu = rows.filter(row => row.state === 'ready').map(row => row.id)) => /** @type {import('../lib/ask/ask.mjs').ModelsRead} */ ({
  connections: [{ id: 'claude', kind: 'plan', name: 'Claude', line: null }, { id: 'openrouter', kind: 'key', name: 'OpenRouter', line: null },
    { id: 'address', kind: 'address', name: 'Other server', line: null }],
  uses: { chat: { value, thinking: 'medium', fits: rows.map(row => row.id), menu: {
    default: null, rows: menu.map(id => ({ value: id, name: rows.find(row => row.id === id)?.name ?? id, account: null, chosen: id === value })), local: null,
    more: { words: 'More', use: 'chat', work: null }, off: null,
  } } },
  models: Object.fromEntries(rows.map(row => [row.id, row])),
});

test('6: no default with a ready first row: no model is named for a question with no pick, the shipped phone told it is not ready, the chip told to choose, a question refused as a model\'s, not a sign-in\'s', async () => {
  const chosen = chosenOf(modelsRead([LUNA, OPUS], null), {});
  assert.deepEqual([chosen.picked, chosen.failure, chosen.said], [null, 'model', 'Chat has no default model: choose one from the menu.']);
  const ready = readyModels(chosen);
  assert.deepEqual([ready.model, ready.login, ready.said, 'act' in ready], [LUNA.id, 'missing', chosen.said, false]);
  assert.deepEqual(ready.default, { model: null, thinking: 'medium', shown: null, choose: 'Choose a model' });
  await homeLinkFixture('ask-ready-no-default-ready.json', { ...ready, starters: [], voice: READY.voice, limits: LIMITS });
});

test('7: no default, a plan not signed in is left out of the menu: refused as no default, never a sign-in; a key not ready is a model\'s; nothing to choose: no chip words', () => {
  assert.deepEqual([chosenOf(modelsRead([OPUS, LUNA], null), {}).failure, chosenOf(modelsRead([OPUS, LUNA], null), {}).said], ['model', 'Chat has no default model: choose one from the menu.']);
  const away = { ...LUNA, state: /** @type {const} */ ('waiting'), line: 'OpenRouter is not answering' };
  assert.deepEqual([chosenOf(modelsRead([away], null), {}).failure, chosenOf(modelsRead([away], null), {}).said], ['model', away.line]);
  const none = readyModels(chosenOf(modelsRead([], null), {}));
  assert.deepEqual([none.login, none.default.shown, none.default.choose], ['missing', null, null]);
});

test('8a: the picker carries the home\'s short menu, More its last row; a pick found through More is any fitting model, its behaviour carried, never gone; a pick no fit holds is gone; with no menu but fits, the chip still says to choose', () => {
  const many = Array.from({ length: 40 }, (_, at) => chatRow({ id: `openrouter:vendor-b/model-${at}`, name: `Model ${at}`, connection: 'openrouter' }));
  const read = modelsRead([OPUS, LUNA, ...many], OPUS.id, [OPUS.id, LUNA.id]);
  const short = readyModels(chosenOf(read, {}));
  assert.deepEqual([short.models.map(model => model.id), short.menu.rows.map(row => row.value), short.menu.more.words], [[OPUS.id, LUNA.id], [OPUS.id, LUNA.id], 'More']);
  const found = chosenOf(read, { model: 'openrouter:vendor-b/model-31' });
  assert.deepEqual([found.gone, found.picked?.row.id, readyModels(found).models.map(model => model.id)], [false, 'openrouter:vendor-b/model-31', [OPUS.id, LUNA.id, 'openrouter:vendor-b/model-31']]);
  assert.equal(chosenOf(read, { model: 'openrouter:vendor-b/model-99' }).gone, true);
  const bare = readyModels(chosenOf(modelsRead([LUNA, ...many], null, []), {}));
  assert.deepEqual([bare.models, bare.default.choose, bare.menu.rows, bare.model], [[], 'Choose a model', [], LUNA.id]);
});

test('8: each model says whether its turns are hidden: one that leaves is, one that stays is not', () => {
  const ready = readyModels(chosenOf(modelsRead([LUNA, LOCAL], LUNA.id), {}));
  assert.deepEqual(ready.models.map(model => [model.id, model.hides]), [[LUNA.id, true], [LOCAL.id, false]]);
  assert.deepEqual([ready.login, ready.default.shown, ready.default.choose], ['ready', LUNA.id, null]);
});
