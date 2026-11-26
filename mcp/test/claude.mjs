// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './until.mjs';
import { asked, homeClock, login, named, note, PLAN_ROWS, plansOn, statusOf, streaming } from './asking.mjs';
import { fakeClaude } from './programs.mjs';
import { programOf } from '../lib/ask/programs.mjs';
import { askServer, claudeState, doneOf, errorOf, gone, holding, onClaude } from './on-claude.mjs';

const CODE = 'synthetic-code#synthetic-state';
const OPUS = PLAN_ROWS.claude.chat;

onClaude('claude');

test('1, 4: Claude\'s sign-in is Claude Code\'s own, run in the machine\'s folder in its group with its environment; its address is the state\'s, the page handing back signs it in, and `claude auth status` says who; no log line, state or file of the Ask server holds the code or a token; a sign-out is Claude Code\'s', async () => {
  named('a sign-in handed back');
  const machine = await plansOn({ claude: 'out' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const { url, logged, close } = await askServer({ machine });
  assert.deepEqual((await login(url, 'GET')).body.claude.state, 'signed_out');
  const start = (await login(url, 'POST', { do: 'start', of: 'claude' })).body.claude;
  note({ start: { ...start, attempt: 'an attempt' } });
  assert.equal(start.state, 'signing_in');
  assert.match(start.attempt, /^[0-9a-f]{16}$/u);
  assert.match(start.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&/u);
  const [signIn] = (await fake.starts()).filter(each => each.argv[0] === 'auth' && each.argv[1] === 'login');
  note({ argv: signIn.argv, env: signIn.env, keys: signIn.keys });
  assert.deepEqual(signIn.argv, ['auth', 'login', '--claudeai']);
  assert.deepEqual([signIn.cwd, signIn.env, signIn.keys, signIn.user], [realpathSync(join(machine, 'claude')), {
    CLAUDE_CONFIG_DIR: join(machine, 'claude'), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  }, [], true]);
  await fake.approve();
  await until('signed in', async () => (await claudeState(url)).state === 'signed_in');
  const signed = await claudeState(url);
  note({ signed });
  assert.deepEqual([signed.account, signed.plan, signed.url, signed.attempt], ['person-a@example.com', 'max', null, null]);
  const said = JSON.stringify({ logged, state: (await login(url, 'GET')).body });
  assert.doesNotMatch(said, /SYNTHETIC-TOKEN|synthetic-code/u);
  const out = (await login(url, 'POST', { do: 'sign_out', of: 'claude' })).body.claude;
  assert.equal(out.state, 'signed_out');
  assert.ok((await fake.starts()).some(each => each.argv.join(' ') === 'auth logout'));
  assert.ok(existsSync(join(machine, 'subscriptions', 'claude', 'current')));
  await close();
});

test('2, 4: a code typed is written to the sign-in its attempt names, one typed before Claude Code asks is held for it, a wrong one fails, another attempt\'s is refused; two starts at once are one sign-in; a cancelled sign-in\'s exit changes nothing of the next', async () => {
  named('codes and attempts');
  const machine = await plansOn({ claude: 'out' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const { url, logged, close } = await askServer({ machine });
  const both = await Promise.all([login(url, 'POST', { do: 'start', of: 'claude' }), login(url, 'POST', { do: 'start', of: 'claude' })]);
  assert.equal(both[0].body.claude.attempt, both[1].body.claude.attempt);
  assert.equal((await fake.starts()).filter(each => each.argv[1] === 'login').length, 1);
  const { attempt } = both[0].body.claude;
  const stray = await login(url, 'POST', { do: 'code', of: 'claude', attempt: 'another-attempt', code: CODE });
  note({ stray });
  assert.deepEqual([stray.status, stray.body.error], [409, 'This sign-in has ended. Sign in with Claude again.']);
  assert.equal((await claudeState(url)).state, 'signing_in');
  await login(url, 'POST', { do: 'code', of: 'claude', attempt, code: 'wrong-code#wrong-state' });
  await until('the wrong code refused', async () => (await claudeState(url)).state === 'failed');
  assert.equal((await claudeState(url)).why, 'Claude sign-in didn\'t finish.');

  await rm(join(fake.dir, 'login.json'), { force: true });
  await fake.touch('hold-login');
  const starting = login(url, 'POST', { do: 'start', of: 'claude' });
  await fake.login();
  await until('the sign-in started', async () => (await claudeState(url)).state === 'signing_in');
  const held = await claudeState(url);
  assert.deepEqual([held.state, held.url], ['signing_in', null]);
  assert.equal((await login(url, 'POST', { do: 'code', of: 'claude', attempt: held.attempt, code: CODE })).status, 200);
  await rm(join(fake.dir, 'hold-login'));
  assert.equal((await starting).body.claude.attempt, held.attempt);
  await until('the held code signed in', async () => (await claudeState(url)).state === 'signed_in');
  assert.deepEqual((await fake.seen()).filter(line => line.code !== undefined).map(line => line.code === CODE), [false, true]);
  assert.deepEqual(await holding(machine, /synthetic-code|wrong-code|SYNTHETIC-TOKEN/u), []);

  await login(url, 'POST', { do: 'sign_out', of: 'claude' });
  const first = (await login(url, 'POST', { do: 'start', of: 'claude' })).body.claude;
  const firstChild = await fake.login();
  await login(url, 'POST', { do: 'cancel', of: 'claude' });
  assert.ok(gone(firstChild.pid));
  const second = (await login(url, 'POST', { do: 'start', of: 'claude' })).body.claude;
  assert.notEqual(second.attempt, first.attempt);
  assert.equal((await claudeState(url)).state, 'signing_in');
  assert.equal((await claudeState(url)).attempt, second.attempt);
  await login(url, 'POST', { do: 'cancel', of: 'claude' });
  note({ codes: logged.filter(line => line.login === 'code').length });
  assert.doesNotMatch(JSON.stringify(logged), /synthetic-code|wrong-code|SYNTHETIC-TOKEN/u);
  await close();
});

test('3: a sign-in abandoned (cancel, its fifteen minutes, the server closing) ends its process\'s whole group within three seconds, and the server\'s close still delivers its turns', async () => {
  named('sign-ins ended');
  const machine = await plansOn({ claude: 'out' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const first = await askServer({ machine, codeMs: 400 });
  await login(first.url, 'POST', { do: 'start', of: 'claude' });
  const ranOut = await fake.login();
  await until('the sign-in ran out', async () => (await claudeState(first.url)).state === 'failed');
  assert.equal((await claudeState(first.url)).why, 'This sign-in ran out.');
  await until('its group ended', () => gone(ranOut.pid) && gone(ranOut.helper));
  await first.close();

  const second = await askServer({ machine });
  await login(second.url, 'POST', { do: 'start', of: 'claude' });
  const cancelled = await fake.login();
  await login(second.url, 'POST', { do: 'cancel', of: 'claude' });
  assert.ok(gone(cancelled.pid), 'the cancel answered before the sign-in ended');
  await until('its group ended', () => gone(cancelled.helper));

  await login(second.url, 'POST', { do: 'start', of: 'claude' });
  await fake.approve();
  await until('signed in', async () => (await claudeState(second.url)).state === 'signed_in');
  await fake.script([[{ say: 'Partly ' }, { hold: true }]]);
  const turn = await streaming(second.url, { question: 'Hold on?', model: OPUS });
  for (let event = await turn.next(); event !== null && event.type !== 'text'; event = await turn.next()) {}
  await login(second.url, 'POST', { do: 'sign_out', of: 'claude' });
  await fake.touch('stubborn');
  await login(second.url, 'POST', { do: 'start', of: 'claude' });
  const closing = await fake.login();
  assert.ok(!gone(closing.helper));
  const delivered = await second.close();
  note({ delivered });
  assert.equal(delivered, true);
  assert.ok(gone(closing.pid));
  assert.ok(second.logged.some(line => line.claude === 'killed'), 'the close answered before the group was killed');
  await until('the stubborn helper gone', () => gone(closing.helper));
  while (await turn.next() !== null) {}
  assert.deepEqual([doneOf(turn.seen)?.end, errorOf(turn.seen)?.error], ['failed', 'restart']);
});

test('4: a status Claude Code cannot give fails in a fixed sentence: nothing it printed, a token among it, reaches a log line, the state or a status', async () => {
  named('a status unread');
  const machine = await plansOn({ claude: 'out' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  await fake.touch('status-unreadable');
  const { url, logged, close } = await askServer({ machine });
  const state = await claudeState(url);
  note({ state });
  assert.deepEqual([state.state, state.why], ['failed', 'Lifestream couldn\'t ask Claude Code who is signed in.']);
  const status = await statusOf(url);
  assert.equal(status.login, 'missing');
  const said = JSON.stringify({ logged, state, status });
  assert.match(said, /Claude Code did not say who is signed in \(exit 1\)\./u);
  assert.doesNotMatch(said, /SYNTHETIC-TOKEN|Not JSON|credentials/u);
  await close();
});

test('11: a sign-out ends every idle conversation\'s process: a follow-up after signing in again runs in a new one, holding the conversation so far', async () => {
  named('signed out and in');
  const machine = await plansOn({ claude: 'in' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const { url, close } = await askServer({ machine });
  await fake.script([[{ say: 'Before.' }], [{ say: 'After.' }]]);
  const first = await asked(url, { question: 'Before?' });
  assert.equal(doneOf(first)?.text, 'Before.', JSON.stringify(first));
  const [before] = (await fake.starts()).filter(each => each.argv.includes('--mcp-config'));
  await login(url, 'POST', { do: 'sign_out', of: 'claude' });
  await until('the conversation\'s process ended', () => gone(before.pid));
  await login(url, 'POST', { do: 'start', of: 'claude' });
  await fake.approve();
  await until('signed in again', async () => (await claudeState(url)).state === 'signed_in');
  const follow = await asked(url, { question: 'After?', chat: doneOf(first).chat });
  const processes = (await fake.starts()).filter(each => each.argv.includes('--mcp-config')).length;
  note({ follow: doneOf(follow)?.text, processes });
  assert.equal(doneOf(follow)?.text, 'After.', JSON.stringify(follow));
  assert.equal(processes, 2, 'the follow-up ran in a process started under the new sign-in');
  assert.match((await fake.seen()).filter(line => line.asked !== undefined).at(-1).asked, /^\[The conversation so far/u);
  await close();
});

/** @param {ReturnType<typeof fakeClaude>} fake */
const conversationPids = async fake => (await fake.starts()).filter(each => each.argv.includes('--mcp-config')).map(each => /** @type {number} */ (each.pid));

/**
 * @param {string} url
 * @param {ReturnType<typeof fakeClaude>} fake
 */
const signInAgain = async (url, fake) => {
  await login(url, 'POST', { do: 'start', of: 'claude' });
  await fake.approve();
  await until('signed in again', async () => (await claudeState(url)).state === 'signed_in');
};

test('11: a question asked while the sign-out runs is answered, and its process ends once the sign-out has: a follow-up after signing in again runs in a new one', async () => {
  named('asked while signing out');
  const machine = await plansOn({ claude: 'in' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const { url, close } = await askServer({ machine });
  await fake.script([[{ say: 'During.' }], [{ say: 'After.' }]]);
  await fake.touch('hold-logout');
  const signingOut = login(url, 'POST', { do: 'sign_out', of: 'claude' });
  await until('the logout runs', async () => (await fake.starts()).some(each => each.argv[0] === 'auth' && each.argv[1] === 'logout'));
  const during = await asked(url, { question: 'During?' });
  assert.equal(doneOf(during)?.text, 'During.', JSON.stringify(during));
  const [opened] = await conversationPids(fake);
  await rm(join(fake.dir, 'hold-logout'));
  await signingOut;
  await until('the process opened during the sign-out ended', () => gone(/** @type {number} */ (opened)));
  await signInAgain(url, fake);
  const follow = await asked(url, { question: 'After?', chat: doneOf(during).chat });
  const processes = (await conversationPids(fake)).length;
  note({ follow: doneOf(follow)?.text, processes });
  assert.equal(doneOf(follow)?.text, 'After.', JSON.stringify(follow));
  assert.equal(processes, 2, 'the follow-up ran in a process started under the new sign-in');
  await close();
});

test('11: a sign-out while a turn runs: the turn ends as it would have, and its process ends with it and is never asked again', async () => {
  named('signed out under a turn');
  const machine = await plansOn({ claude: 'in' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  const { url, close } = await askServer({ machine });
  await fake.script([[{ say: 'Partly ' }, { waitFor: 'go' }, { say: 'Whole.' }], [{ say: 'After.' }]]);
  const turn = await streaming(url, { question: 'Under way?' });
  for (let event = await turn.next(); event !== null && event.type !== 'text'; event = await turn.next()) {}
  const [running] = await conversationPids(fake);
  await login(url, 'POST', { do: 'sign_out', of: 'claude' });
  assert.equal(gone(/** @type {number} */ (running)), false, 'the turn\'s process runs on through the sign-out');
  await fake.touch('go');
  while (await turn.next() !== null) {}
  assert.deepEqual([doneOf(turn.seen)?.end, doneOf(turn.seen)?.text], ['done', 'Partly Whole.'], JSON.stringify(turn.seen));
  await until('the turn\'s process ended', () => gone(/** @type {number} */ (running)));
  await signInAgain(url, fake);
  const follow = await asked(url, { question: 'After?', chat: doneOf(turn.seen).chat });
  const processes = (await conversationPids(fake)).length;
  note({ under: doneOf(turn.seen)?.end, follow: doneOf(follow)?.text, processes });
  assert.equal(doneOf(follow)?.text, 'After.', JSON.stringify(follow));
  assert.equal(processes, 2, 'the follow-up ran in a new process');
  await close();
});

test('11: a sign-in that ends signed in ends the idle conversation\'s process: a follow-up runs in a new one', async () => {
  named('signed in again');
  const machine = await plansOn({ claude: 'in' }, { chat: OPUS });
  const fake = fakeClaude(machine);
  let shift = 0;
  const { url, close } = await askServer({ machine, now: () => homeClock() + shift });
  await fake.script([[{ say: 'Before.' }], [{ say: 'After.' }]]);
  const first = await asked(url, { question: 'Before?' });
  assert.equal(doneOf(first)?.text, 'Before.', JSON.stringify(first));
  const [idle] = await conversationPids(fake);
  await rm(join(fake.dir, 'auth.json'));
  shift += 6_000;
  await signInAgain(url, fake);
  await until('the idle process ended', () => gone(/** @type {number} */ (idle)));
  const follow = await asked(url, { question: 'After?', chat: doneOf(first).chat });
  const processes = (await conversationPids(fake)).length;
  note({ follow: doneOf(follow)?.text, processes });
  assert.equal(doneOf(follow)?.text, 'After.', JSON.stringify(follow));
  assert.equal(processes, 2, 'the follow-up ran in a process started under the new sign-in');
  await close();
});

test('10: a program is ready only while `current` names the file itself within its folder: a link there, one on its way, or a path that leaves is not ready, and is never run', async () => {
  const machine = await mkdtemp(join(tmpdir(), 'lifestream-mcp-programs-'));
  try {
    const folder = join(machine, 'subscriptions', 'claude');
    await mkdir(join(folder, '9.9.9', 'bin'), { recursive: true });
    const real = join(folder, '9.9.9', 'bin', 'claude');
    await writeFile(real, '#!/bin/sh\n');
    await chmod(real, 0o755);
    const outside = join(machine, 'planted');
    await writeFile(outside, '#!/bin/sh\n');
    await chmod(outside, 0o755);
    await symlink(outside, join(folder, '9.9.9', 'bin', 'linked'));
    await symlink(machine, join(folder, '9.9.9', 'out'));
    const named = async (/** @type {string} */ line) => {
      await writeFile(join(folder, 'current'), `${line}\n`);
      return programOf(machine, 'claude');
    };
    assert.deepEqual(await named('9.9.9/bin/claude'), { chosen: true, binary: real, home: join(machine, 'claude') });
    for (const line of ['9.9.9/bin/linked', '9.9.9/out/planted', '../../planted', outside, '9.9.9/bin/../bin/claude', 'claude', '']) {
      assert.equal((await named(line)).binary, null, `current naming ${JSON.stringify(line)} is not ready`);
    }
  } finally {
    await rm(machine, { recursive: true, force: true });
  }
});
