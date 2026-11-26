// @ts-check
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { askOn, createHandler } from '../server.mjs';
import { asked, home, homeClock, named, note, plansOn, startHome, stopHome } from './asking.mjs';
import { openMemoryConversations } from './fake/conversations.mjs';
import { fakeClaude, fakeCodex, openDoorway } from './programs.mjs';

const ARTIFACT = fileURLToPath(new URL('../.build/e2e/trace.json', import.meta.url));

/** @type {(() => Promise<unknown>)[]} */
const closing = [];

before(async () => {
  await startHome('http://127.0.0.1:9');
});

after(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await stopHome(ARTIFACT);
});

/** @param {ReturnType<typeof createHandler>} handler @param {import('node:http').Server} server */
const closeOf = async (handler, server) => {
  await handler.close(5_000);
  server.closeAllConnections();
  await new Promise(done => server.close(() => done(undefined)));
};

/** @param {string} machine @param {Record<string, unknown>} [more] */
async function tracedOn(machine, more = {}) {
  const doorway = await openDoorway(home.url);
  /** @type {any[]} */
  const traces = [];
  const ask = { ...askOn(machine, { door: doorway.url, now: homeClock, log: () => undefined }), conversations: openMemoryConversations(), titles: false,
    trace: (/** @type {unknown} */ each) => void traces.push(each), ...more };
  const handler = createHandler({ door: doorway.url, ask, log: () => undefined });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  closing.push(() => doorway.close(), () => closeOf(handler, server));
  return { url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, traces, doorway };
}

test('2, 3: a turn on Claude: its trace holds every call (several at once, one failing) with the arguments as sent and as restored, the answer as Claude Code received it, in handles, and the turn\'s times, model, prompt and tokens; a follow-up\'s in the same conversation', async () => {
  named('a traced turn on Claude');
  const machine = await plansOn({ claude: 'in' });
  const fake = fakeClaude(machine);
  const { url, traces, doorway } = await tracedOn(machine);
  await fake.script([
    [{ say: 'Looking. ' }, { calls: [{ tool: 'search', args: { query: 'lighthouse' } }, { tool: 'search', args: { query: 'tickets' } }] },
      { call: { tool: 'read', args: { ref: 'r999' } } }, { say: 'Person A got two lighthouse tickets for Sunday [r1].' }],
    [{ call: { tool: 'read', args: { ref: 'r1' } } }, { say: 'On Sunday [r1].' }],
  ]);
  const events = await asked(url, { question: 'Who got lighthouse tickets?', model: 'claude:claude-opus-5-5' });
  await asked(url, { question: 'When?', model: 'claude:claude-opus-5-5', chat: events[0]?.chat });
  assert.equal(traces.length, 2);
  const [first, second] = traces;
  note({ calls: first.calls.map((/** @type {any} */ call) => ({ ...call, start_ms: 'ms', end_ms: 'ms', ms: 'ms' })) });

  assert.deepEqual(first.calls.map((/** @type {any} */ call) => call.tool).sort(), ['read', 'search', 'search']);
  const searches = first.calls.filter((/** @type {any} */ call) => call.tool === 'search');
  assert.deepEqual(searches.map((/** @type {any} */ call) => call.args.query).sort(), ['lighthouse', 'tickets']);
  for (const call of searches) {
    assert.equal(call.restored, undefined, 'a route tool\'s arguments go to the door as written, restored there');
    assert.equal(call.error, undefined);
    assert.ok(call.end_ms >= call.start_ms && call.chars === call.answer.length);
  }
  const failing = first.calls.find((/** @type {any} */ call) => call.tool === 'read');
  assert.deepEqual(failing.args, { ref: 'r999' });
  assert.equal(typeof failing.error, 'string');
  assert.ok(searches.every((/** @type {any} */ call) => call.n < failing.n));
  const reread = second.calls[0];
  assert.deepEqual([reread.args, reread.restored], [{ ref: 'r1' }, undefined]);

  const received = (await fake.seen()).filter(line => line.answered !== undefined).map(line => line.result.content[0].text);
  const traced = [...first.calls, ...second.calls].map((/** @type {any} */ call) => call.answer);
  assert.deepEqual([...traced].sort(), [...received].sort());
  for (const call of searches) {
    assert.match(call.answer, /"r1"/u);
    assert.doesNotMatch(call.answer, /"source":/u);
  }

  assert.deepEqual([first.connection, first.model, first.answered_model, first.thinking, first.question, first.end], ['claude', 'claude:claude-opus-5-5', 'claude-opus-5-5', 'medium', 'Who got lighthouse tickets?', 'done']);
  assert.match(first.prompt_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(second.prompt_sha256, first.prompt_sha256, 'a follow-up in the same context, its prompt the same');
  assert.equal(second.chat, first.chat);
  assert.ok(first.first_step_ms !== null && first.first_text_ms !== null && first.first_answer_ms !== null);
  assert.ok(first.first_text_ms <= first.first_step_ms, 'the words before the first step came first');
  assert.equal(first.events.find((/** @type {any} */ event) => event.type === 'step')?.said, 'Looking', 'the words before the first step are its said');
  assert.ok(first.first_answer_ms >= first.first_step_ms, 'the answer\'s first word after the last step');
  assert.equal(first.text, 'Person A got two lighthouse tickets for Sunday [r1].');
  assert.ok(first.tokens !== undefined);
  assert.deepEqual(first.events.filter((/** @type {any} */ event) => event.type === 'step').length, 3);

  const reads = doorway.asked.filter(line => /^POST \/v1\/(?:search|count|people\/search|read)$/u.test(line));
  assert.ok(reads.length >= 3, doorway.asked.join('\n'));
  assert.deepEqual(doorway.forModel.filter(line => reads.includes(line)), reads);
});

test('2, 3: a turn through Codex: its own call and each call its `exec` cell makes are traced, by Codex\'s call id, with the answer Codex received', async () => {
  named('a traced turn through Codex');
  const machine = await plansOn({ codex: 'in' });
  const codex = fakeCodex(machine);
  const { url, traces } = await tracedOn(machine);
  await codex.script([[
    { say: 'Looking. ' },
    { script: [{ tool: 'search', args: { query: 'lighthouse' } }, { tool: 'search', args: { query: 'tickets' } }] },
    { call: { tool: 'search_people', args: { name: 'Person A' } } },
    { usage: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 } },
    { say: 'Person A got two lighthouse tickets for Sunday [r1].' },
  ]]);
  await asked(url, { question: 'Who got lighthouse tickets?', model: 'codex:gpt-6.2-sol' });
  const [trace] = traces;
  assert.equal(trace?.end, 'done', JSON.stringify(trace));
  note({ calls: trace.calls.map((/** @type {any} */ call) => [call.via, call.tool, call.args]) });
  assert.deepEqual(trace.calls.map((/** @type {any} */ call) => [call.via, call.tool]).sort(), [['call_3', 'search_people'], ['exec-1', 'search'], ['exec-2', 'search']]);
  const received = new Map((await codex.seen()).filter(line => line.answered !== undefined).map(line => [line.answered, line.result.contentItems[0].text]));
  for (const call of trace.calls) assert.equal(call.answer, received.get(call.via), `${call.via}'s answer as Codex received it`);
  assert.deepEqual([trace.connection, trace.model, trace.tokens], ['codex', 'codex:gpt-6.2-sol', { input: 1000, output: 200, cache_read: 800 }]);
  assert.match(trace.prompt, /^How to work\. Four tools/mu);
});

test('4: with no trace asked for, nothing is traced, and the turn is the same, byte for byte, as Claude Code and the person read it', async () => {
  named('a turn untraced');
  const machine = await plansOn({ claude: 'in' });
  const fake = fakeClaude(machine);
  const script = [{ calls: [{ tool: 'search', args: { query: 'lighthouse' } }, { tool: 'search_people', args: { name: 'Person Z' } }] },
    { say: 'Person A got two lighthouse tickets for Sunday [r1].' }];
  await fake.script([script, script]);
  /** @type {unknown[]} */
  const traces = [];
  /** @param {boolean} traced */
  const turnOn = async traced => {
    const ask = { ...askOn(machine, { door: home.url, now: homeClock, log: () => undefined }), conversations: openMemoryConversations(), titles: false,
      ...(traced ? { trace: (/** @type {unknown} */ each) => void traces.push(each) } : {}) };
    const handler = createHandler({ door: home.url, ask, log: () => undefined });
    const server = createServer(handler);
    await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
    try {
      const events = await asked(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, { question: 'Who got lighthouse tickets?', model: 'claude:claude-opus-5-5' });
      const chat = events[0]?.chat;
      /** @param {any} event */
      const ended = event => event?.type === 'step' && event.name === undefined;
      const ordered = [...events];
      for (let at = 0; at < ordered.length; at++) {
        let end = at;
        while (end < ordered.length && ended(ordered[end])) end++;
        if (end - at > 1) ordered.splice(at, end - at, ...ordered.slice(at, end).sort((a, b) => a.call - b.call));
        at = Math.max(at, end - 1);
      }
      return JSON.stringify(ordered).replaceAll(chat, '<chat>').replace(/"(ms|at_ms|thought_ms)":\d+/gu, '"$1":0');
    } finally {
      await closeOf(handler, server);
    }
  };
  const untraced = await turnOn(false);
  assert.equal(traces.length, 0);
  const traced = await turnOn(true);
  assert.equal(traces.length, 1);
  note({ untraced: JSON.parse(untraced) });
  assert.equal(untraced, traced);
  const answers = (await fake.seen()).filter(line => line.answered !== undefined).map(line => JSON.stringify(line.result));
  assert.equal(answers.length, 4);
  assert.deepEqual(answers.slice(0, 2).sort(), answers.slice(2).sort());
});

test('6: `prompt` builds the system prompt a turn opens with, handed what `askPrompt` is; the trace holds it and its SHA-256', async () => {
  named('a turn on a prompt of its own');
  const machine = await plansOn({ codex: 'in' });
  const codex = fakeCodex(machine);
  /** @type {unknown[][]} */
  const handed = [];
  const prompt = (/** @type {unknown[]} */ ...given) => {
    handed.push(given);
    return 'A synthetic prompt.';
  };
  const { url, traces } = await tracedOn(machine, { prompt });
  await codex.script([[{ say: 'Person A [r1].' }]]);
  await asked(url, { question: 'Who got lighthouse tickets?', model: 'codex:gpt-6.2-sol' });
  assert.equal(handed.length, 1);
  const [homeOf, catalog] = /** @type {any[]} */ (handed[0]);
  assert.deepEqual([typeof homeOf.zone, typeof homeOf.start_hour, typeof catalog], ['string', 'number', 'string']);
  const [asking] = await codex.asked('thread/start');
  assert.equal(asking.baseInstructions, 'A synthetic prompt.');
  assert.deepEqual([traces[0]?.prompt, traces[0]?.prompt_sha256], ['A synthetic prompt.', createHash('sha256').update('A synthetic prompt.').digest('hex')]);
});
