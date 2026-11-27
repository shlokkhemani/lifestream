// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { narrated, releasable, voiced } from '../lib/ask/ask.mjs';
import { openHandles } from '../lib/ask/handles.mjs';
import { until } from './until.mjs';

/** @param {number} n */
const citation = n => /** @type {const} */ ({ ref: `record.synthetic-${n}`, kind: 'record', day: '2026-09-25', title: `Synthetic ${n}`, opens: { page: 'days', day: '2026-09-25' } });
const handles = openHandles(Object.fromEntries([1, 2, 3].map(n => [`r${n}`, citation(n)])));

/**
 * @param {{ cited?: (text: string) => Promise<{ text: string, refs: Record<string, any> }>, quietMs?: number }} [given]
 */
function voice({ cited, quietMs = 60_000 } = {}) {
  /** @type {any[]} */
  const events = [];
  const restore = {
    many: async (/** @type {string[]} */ texts) => texts,
    cited: cited ?? (async (/** @type {string} */ text) => ({ text, refs: Object.fromEntries([...text.matchAll(/r(\d)/gu)].map(([handle, n]) => [handle, citation(Number(n))])) })),
  };
  const made = voiced(/** @type {any} */ ({ send: (/** @type {any} */ event) => events.push(event) }), restore, handles, () => undefined, quietMs);
  const said = () => events.filter(event => event.type === 'text').map(event => event.delta).join('');
  return { ...made, events, said, send: made.turn.send };
}

test('narration: words the model writes before a step are the step\'s `said`, its last sentence plain; never `text`, never kept', async () => {
  const turn = voice();
  turn.send({ type: 'text', delta: 'Let me look. Checking **your** mail [r1]' });
  turn.send({ type: 'text', delta: '…' });
  turn.send({ type: 'step', call: 1, name: 'search', words: 'Searching mail' });
  turn.send({ type: 'step', call: 1, words: 'Searched mail', ms: 4 });
  turn.send({ type: 'text', delta: 'Nothing there.' });
  await turn.flush();
  assert.deepEqual(turn.events.filter(event => event.type === 'step')[0], { type: 'step', call: 1, name: 'search', words: 'Searching mail', said: 'Checking your mail' });
  assert.equal(turn.said(), 'Nothing there.');
  assert.equal(turn.written(), 'Nothing there.');
  assert.equal(turn.events.filter(event => event.type === 'ref').length, 0, 'a handle only narration cites is never told');
});

test('a stretch released before a step, by its paragraph break or the quiet, is answer: sent, kept in order with the last, a step ending its paragraph, its handles told', async () => {
  const turn = voice();
  turn.send({ type: 'text', delta: 'So far [r1].\n\n' });
  turn.send({ type: 'step', call: 1, name: 'read', words: 'Reading' });
  turn.send({ type: 'step', call: 1, words: 'Read', ms: 4 });
  turn.send({ type: 'text', delta: 'Then [r2].' });
  await turn.flush();
  assert.equal(turn.events.find(event => event.type === 'step')?.said, undefined);
  assert.equal(turn.written(), 'So far [r1].\n\nThen [r2].');
  assert.equal(turn.said(), turn.written());
  assert.deepEqual(turn.events.filter(event => event.type === 'ref').map(event => event.handle), ['r1', 'r2']);

  const quiet = voice({ quietMs: 0 });
  quiet.send({ type: 'text', delta: 'Here is a first part' });
  await until('the quiet releases the held words', () => quiet.said() === 'Here is a first part');
  quiet.send({ type: 'step', call: 1, name: 'read', words: 'Reading' });
  await until('the step is told', () => quiet.events.some(event => event.type === 'step'));
  assert.equal(quiet.said(), 'Here is a first part\n\n', 'the paragraph ends before the step, so a reader shows its last word while the step runs');
  quiet.send({ type: 'text', delta: 'And more.' });
  await quiet.flush();
  assert.equal(quiet.events.find(event => event.type === 'step')?.said, undefined);
  assert.equal(quiet.written(), 'Here is a first part\n\nAnd more.');
});

test('the stream is the kept text: a range is spelled out and told like any citation, a provider\'s mark is dropped, a partial of either held whole', async () => {
  assert.deepEqual(['See [r1', 'See [r1-', 'See [r1 to r', 'See [r10, r11, r12, r13, r14, r15, r16, r17, r18', 'a \uE200cite:0', 'a [[Pers', 'more ', 'done.'].map(releasable), [4, 4, 4, 4, 1, 2, 4, 5]);
  const turn = voice();
  for (const delta of ['Intro.\n\n', 'See [r1', '-', 'r3] and \uE200cite', ':0\uE201 more ', '[r', '2].']) turn.send({ type: 'text', delta });
  await turn.flush();
  assert.equal(turn.said(), 'Intro.\n\nSee [r1, r2, r3] and more [r2].');
  assert.equal(turn.written(), turn.said());
  const told = turn.events.map(event => event.type === 'ref' ? event.handle : event.type);
  assert.deepEqual(told, ['r1', 'r2', 'r3', 'text']);
});

test('the better ref wins: an early tell that fails is tried again at the next citing stretch; a bare early ref gives way to done\'s citation, a full one stays', async () => {
  let fails = 1;
  const turn = voice({ cited: async text => {
    if (fails-- > 0) throw new Error('not ready');
    return { text, refs: { r1: { ref: 'record.synthetic-1' }, ...(text.includes('r2') ? { r2: citation(2) } : {}) } };
  } });
  turn.send({ type: 'text', delta: 'First [r1].\n\n' });
  await until('the first stretch', () => turn.said() !== '');
  assert.equal(turn.events.filter(event => event.type === 'ref').length, 0);
  turn.send({ type: 'text', delta: 'Again [r1] and [r2].' });
  await turn.flush();
  assert.deepEqual(turn.events.filter(event => event.type === 'ref').map(event => [event.handle, event.cited]), [['r1', { ref: 'record.synthetic-1' }], ['r2', citation(2)]]);
  assert.ok(turn.events.findIndex(event => event.type === 'ref') < turn.events.findIndex(event => event.type === 'text' && event.delta.includes('Again')));
  const done = { r1: citation(1), r2: { ...citation(2), title: 'Later' } };
  assert.deepEqual(turn.shown(done), { r1: citation(1), r2: citation(2) });
});

test('narrated: the last sentence of the last line, plain, its ending marks gone', () => {
  assert.equal(narrated('Looking.'), 'Looking');
  assert.equal(narrated('I found two. Now I\'ll read **the chat** [r1, r2]:'), 'Now I\'ll read the chat');
  assert.equal(narrated('First line.\n\n- Next I search mail…'), 'Next I search mail');
  assert.equal(narrated('   '), '');
});
