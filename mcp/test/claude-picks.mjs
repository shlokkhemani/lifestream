// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asked, home, listedIn, modelsOf, named, note, PLAN_ROWS, plansOn, plansRead, statusOf } from './asking.mjs';
import { fakeClaude, fakeCodex } from './programs.mjs';
import { askServer, doneOf, errorOf, onClaude } from './on-claude.mjs';

onClaude('claude-picks');

const OPUS = PLAN_ROWS.claude.chat;
const SONNET = PLAN_ROWS.claude.listed;
const TERRA = PLAN_ROWS.codex.listed;
const LUNA = 'codex:gpt-6-luna';

/**
 * @param {string} at
 * @param {Record<string, string>} pick
 */
const pickedStatus = async (at, pick) => /** @type {any} */ (await (await fetch(`${at}/ask?${new URLSearchParams(pick)}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());

/** @param {ReturnType<typeof fakeClaude>} fake */
const claudeAsked = async fake => (await fake.starts()).filter(each => each.argv.includes('--mcp-config')).map(each => each.argv.slice(-4));

test('9: both plans signed in: the picker holds each plan\'s rows as the home lists them, a pick from each runs on its own program at its level, a conversation moved between plans starts a new context with the conversation so far; a pick no row holds runs on the home\'s default at its level and says so', async () => {
  named('both plans');
  const machine = await plansOn({ claude: 'in', codex: 'in' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const codex = fakeCodex(machine);
  const { url, close } = await askServer({ machine });
  try {
    const status = await statusOf(url);
    const ids = status.models.map((/** @type {any} */ each) => each.id);
    const chatUse = (await modelsOf(home)).uses.chat;
    note({ models: ids, default: status.default });
    assert.ok(ids.every((/** @type {string} */ id) => listedIn(chatUse.menu).includes(id)) && [OPUS, PLAN_ROWS.codex.chat].every(id => ids.includes(id)), JSON.stringify(ids));
    assert.ok([SONNET, TERRA, LUNA].every(id => chatUse.fits.includes(id) && !ids.includes(id)), JSON.stringify(chatUse));
    assert.deepEqual([status.model, status.login, status.said, status.default], [OPUS, 'ready', undefined, { model: OPUS, thinking: 'medium', shown: OPUS, choose: null }]);

    await fake.script([[{ say: 'On Claude.' }], [{ say: 'Back on Claude.' }]]);
    await codex.script([[{ say: 'On ChatGPT.' }], [{ say: 'title' }]]);
    const onClaude = await asked(url, { question: 'Which?', model: SONNET, thinking: 'low' });
    assert.deepEqual([doneOf(onClaude)?.text, doneOf(onClaude)?.model, doneOf(onClaude)?.thinking], ['On Claude.', SONNET, 'low'], JSON.stringify(onClaude));
    assert.deepEqual((await claudeAsked(fake)).at(-1), ['--model', 'claude-sonnet-5-5', '--effort', 'low']);
    assert.deepEqual((await pickedStatus(url, { model: SONNET })).models.map((/** @type {any} */ each) => each.id), [...ids, SONNET], 'a pick outside the menu is the picker\'s too');
    const chat = doneOf(onClaude).chat;
    const onChatGPT = await asked(url, { question: 'And now?', chat, model: LUNA });
    assert.deepEqual([doneOf(onChatGPT)?.text, doneOf(onChatGPT)?.model, doneOf(onChatGPT)?.thinking], ['On ChatGPT.', LUNA, 'medium'], JSON.stringify(onChatGPT));
    const started = (await codex.asked('turn/start')).at(-1);
    assert.deepEqual([started?.model, started?.effort], ['gpt-6-luna', 'medium']);
    const injected = await codex.asked('thread/inject_items');
    assert.deepEqual(injected.at(-1).items.map((/** @type {any} */ item) => item.content[0].text), ['[Asked Thursday 2026-10-01 12:00]\nWhich?', 'On Claude.']);
    const back = await asked(url, { question: 'Back?', chat, model: SONNET, thinking: 'low' });
    assert.equal(doneOf(back)?.text, 'Back on Claude.');
    assert.equal((await claudeAsked(fake)).length, 2);
    assert.match((await fake.seen()).filter(line => line.asked !== undefined).at(-1).asked, /Your answer: On ChatGPT\./u);

    const retired = 'claude:claude-retired-1';
    const stale = await pickedStatus(url, { model: retired, thinking: 'low' });
    assert.deepEqual([stale.gone, stale.model, stale.thinking, stale.said], [true, OPUS, 'medium', `${retired} isn't offered now. Asking ${status.name}.`]);
    await fake.script([[{ say: 'By default.' }]]);
    const answeredStale = await asked(url, { question: 'Stale?', model: retired, thinking: 'low' });
    assert.deepEqual([doneOf(answeredStale)?.text, doneOf(answeredStale)?.model, doneOf(answeredStale)?.thinking], ['By default.', OPUS, 'medium'], JSON.stringify(answeredStale));
    assert.deepEqual((await claudeAsked(fake)).at(-1), ['--model', 'claude-opus-5-5', '--effort', 'medium']);
  } finally {
    await close();
  }
});

test('13: a plan signed out: its row says the home\'s line, and the status, a question with no pick and a pick of it say that line and ask no program, while a pick of the other plan answers; signed in again and read by the home, a pick answers at its level; a signed-out answer mid-turn says the sign-in line', async () => {
  named('picks');
  const machine = await plansOn({ claude: 'out', codex: 'in' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const codex = fakeCodex(machine);
  const first = await askServer({ machine });
  try {
    const row = (await modelsOf(home)).models[OPUS];
    note({ row });
    assert.ok(row.state !== 'ready' && typeof row.line === 'string' && row.line !== '', JSON.stringify(row));
    const signedOut = await statusOf(first.url);
    assert.deepEqual([signedOut.model, signedOut.login, signedOut.said], [OPUS, 'missing', row.line]);
    const noPick = await asked(first.url, { question: 'Anyone?' });
    assert.deepEqual([errorOf(noPick)?.error, errorOf(noPick)?.message], ['login', row.line], JSON.stringify(noPick));
    const picked = await asked(first.url, { question: 'You?', model: OPUS, thinking: 'low' });
    assert.deepEqual([errorOf(picked)?.error, errorOf(picked)?.message], ['login', row.line], JSON.stringify(picked));
    assert.deepEqual(await claudeAsked(fake), [], 'Claude Code is never asked');

    await codex.script([[{ say: 'From ChatGPT.' }], [{ say: 'title' }]]);
    const other = await asked(first.url, { question: 'Who?', model: TERRA, thinking: 'low' });
    assert.deepEqual([doneOf(other)?.text, doneOf(other)?.model, doneOf(other)?.thinking], ['From ChatGPT.', TERRA, 'low'], JSON.stringify(other));
    await first.close();

    await fake.signIn();
    await plansRead({ claude: 'in', codex: 'in' });
    const second = await askServer({ machine });
    try {
      const ready = await pickedStatus(second.url, { model: SONNET, thinking: 'low' });
      assert.deepEqual([ready.model, ready.thinking, ready.login, ready.said, ready.gone], [SONNET, 'low', 'ready', undefined, undefined]);
      await fake.script([[{ say: 'On Sonnet.' }], [{ signedOut: true }]]);
      const onSonnet = await asked(second.url, { question: 'Which?', model: SONNET, thinking: 'low' });
      assert.deepEqual([doneOf(onSonnet)?.text, doneOf(onSonnet)?.thinking], ['On Sonnet.', 'low'], JSON.stringify(onSonnet));
      assert.deepEqual((await claudeAsked(fake)).at(-1), ['--model', 'claude-sonnet-5-5', '--effort', 'low']);
      const sonnet = (await modelsOf(home)).models[SONNET];
      const refused = await asked(second.url, { question: 'And?', model: SONNET, thinking: 'low' });
      note({ refused });
      assert.deepEqual([errorOf(refused)?.error, errorOf(refused)?.message], ['login', sonnet.line ?? `Chat needs your ${sonnet.group} sign-in on your Mac.`], JSON.stringify(refused));
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
