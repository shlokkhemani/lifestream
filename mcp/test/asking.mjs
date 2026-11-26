// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { bundledProgram } from '../../testing/program.mjs';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ready } from './programs.mjs';
import { until } from './until.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const HOMELINK_FIXTURES = join(REPO, 'homelink', 'Tests', 'Fixtures');
const WRITE = process.env.LIFESTREAM_FIXTURES === 'write';
const COMMAND_MS = 30_000;

/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>} */
let child;
/** @type {{ url: string, tokens: { reader: string, agent: string, phone: string, mac: string }, phone: string, mac: string, now_ms: number, ask: { machine: string }, chat: { cloud: string, local: string, small: string } }} */
export let home;
/** @type {((line: any) => void)[]} */
const waiting = [];
/** @type {Record<string, unknown[]>} */
const artifact = {};
let current = '';

/**
 * @param {string} mcp
 * @param {Record<string, string>} [env]
 */
export async function startHome(mcp, env = {}) {
  child = spawn(process.execPath, bundledProgram('mcp/test/home.ts'),
    { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LIFESTREAM_MCP: mcp, ...env } });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the synthetic home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
}

/** @param {Record<string, unknown>} said */
export async function command(said) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`the synthetic home exited (${child.exitCode ?? child.signalCode}) before it answered ${said.cmd}`);
  }
  const line = await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      fail(new Error(`never came in ${COMMAND_MS / 1000} s: the synthetic home's answer to ${said.cmd}`));
    }, COMMAND_MS);
    /** @param {number | null} code @param {NodeJS.Signals | null} signal */
    const onExit = (code, signal) => {
      clearTimeout(timer);
      fail(new Error(`the synthetic home exited (${code ?? signal}) before it answered ${said.cmd}`));
    };
    child.once('exit', onExit);
    waiting.push(reply => {
      clearTimeout(timer);
      child.off('exit', onExit);
      done(reply);
    });
    child.stdin.write(`${JSON.stringify(said)}\n`);
  });
  if (!line.ok) throw new Error(`${said.cmd}: ${line.error}`);
  return line.value;
}

/** @param {string} file */
export async function stopHome(file) {
  if (child) await command({ cmd: 'stop' });
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify(artifact, null, 1)}\n`);
}

/** @param {string} name */
export const named = name => {
  current = name;
  artifact[name] = [];
};
/** @param {unknown} line */
export const note = line => void artifact[current]?.push(line);

const started = performance.now();
export const homeClock = () => home.now_ms + Math.round(performance.now() - started);

/**
 * @param {string} at
 * @param {'GET' | 'POST'} method
 * @param {unknown} [body]
 * @param {{ pass?: string, device?: string, path?: string }} [options]
 */
export async function login(at, method, body, { pass = home.tokens.mac, device = home.mac, path = '/ask/login' } = {}) {
  const response = await fetch(`${at}${path}`, {
    method, headers: { authorization: `Bearer ${pass}`, 'lifestream-device': device, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: /** @type {any} */ (await response.json()) };
}

/**
 * @param {{ url: string, tokens: { reader: string } }} at
 * @returns {Promise<any>}
 */
export const modelsOf = async at => (await fetch(`${at.url}/v1/models`, { headers: { authorization: `Bearer ${at.tokens.reader}` } })).json();

/**
 * @param {{ rows: { value: string }[], local: { rows: { value: string }[] } | null }} menu
 * @returns {string[]}
 */
export const listedIn = menu => [...menu.rows, ...menu.local?.rows ?? []].map(row => row.value);

/**
 * @param {{ url: string, tokens: { reader: string } }} at
 * @param {string} id
 * @param {boolean} ready
 */
export const rowReady = (at, id, ready) => until(`the models read saying ${id} is ${ready ? 'ready' : 'not ready'}`, async () => ((await modelsOf(at)).models?.[id]?.state === 'ready') === ready);

export const PLAN_ROWS = /** @type {const} */ ({ claude: { chat: 'claude:claude-opus-5-5', listed: 'claude:claude-sonnet-5-5' }, codex: { chat: 'codex:gpt-6.2-sol', listed: 'codex:gpt-6.1-terra' } });
const PLANS = /** @type {const} */ (['claude', 'codex']);

/**
 * @typedef {'in' | 'out' | 'absent'} PlanState
 * @param {Partial<Record<'claude' | 'codex', PlanState>>} wanted
 */
export async function plansRead(wanted) {
  const saying = async () => {
    const { models } = await modelsOf(home);
    return PLANS.every(name => {
      const { chat, listed } = PLAN_ROWS[name];
      const state = wanted[name] ?? 'absent';
      return state === 'in' ? models[chat]?.state === 'ready' && models[listed]?.state === 'ready' : models[chat]?.state !== 'ready';
    });
  };
  await until(() => `the home's rows reading ${JSON.stringify(wanted)}`, async () => {
    if (await saying()) return true;
    await command({ cmd: 'models-read' });
    return false;
  });
}

/**
 * @param {Partial<Record<'claude' | 'codex', PlanState>>} wanted
 * @param {{ chat?: string }} [options]
 */
export async function plansOn(wanted, { chat } = {}) {
  const machine = home.ask.machine;
  for (const own of ['claude', 'pending', 'submitted.ndjson']) await rm(join(machine, 'ask', own), { recursive: true, force: true });
  await rm(join(machine, 'scratch'), { recursive: true, force: true });
  for (const name of PLANS) {
    await rm(join(machine, 'subscriptions', name), { recursive: true, force: true });
    await rm(join(machine, name, 'fake'), { recursive: true, force: true });
    await mkdir(join(machine, name, 'fake'), { recursive: true });
    if ((wanted[name] ?? 'absent') === 'absent') continue;
    await ready(machine, name);
    if (wanted[name] === 'in') await writeFile(join(machine, name, 'fake', 'auth.json'), JSON.stringify({ email: 'person-a@example.com', plan: name === 'claude' ? 'max' : 'plus' }));
  }
  await plansRead(wanted);
  if (chat !== undefined) await command({ cmd: 'model', value: chat });
  return machine;
}

/** @param {string | null} value */
export async function keyed(value) {
  await command({ cmd: 'key', value });
  await rowReady(home, home.chat.cloud, value !== null);
}

export const minted = () => randomBytes(16).toString('hex');

/**
 * @param {string} name
 * @param {unknown} answer
 */
export async function homeLinkFixture(name, answer) {
  const file = join(HOMELINK_FIXTURES, name);
  const text = `${JSON.stringify(answer, null, 2)}\n`;
  if (WRITE) await writeFile(file, text);
  assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : '', text, `homelink/Tests/Fixtures/${name} is this answer as HomeLink decodes it: LIFESTREAM_FIXTURES=write writes it`);
}

/** @param {string} at */
export const statusOf = async at => /** @type {any} */ (await (await fetch(`${at}/ask`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());

/**
 * @param {string} at
 * @param {Record<string, unknown>} body
 * @returns {Promise<any[]>}
 */
export async function asked(at, body) {
  const response = await fetch(`${at}/ask`, { method: 'POST', body: JSON.stringify({ submission: minted(), ...body }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  const text = await response.text();
  if (response.status !== 200) return [{ status: response.status, ...JSON.parse(text) }];
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line));
}

/**
 * @param {string} at
 * @param {Record<string, unknown>} body
 */
export async function streaming(at, body) {
  const response = await fetch(`${at}/ask`, { method: 'POST', body: JSON.stringify({ submission: minted(), ...body }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {any[]} */
  const seen = [];
  /** @returns {Promise<any | null>} */
  const next = async () => {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        seen.push(event);
        return event;
      }
      const read = await reader.read();
      if (read.done) return null;
      buffer += decoder.decode(read.value, { stream: true });
    }
  };
  return { next, seen };
}

/** @type {{ you: any, me: any, person: any }} */
export const PEOPLE_YOU = JSON.parse(readFileSync(new URL('./fake/people-you.json', import.meta.url), 'utf8'));

/**
 * @param {string} door
 * @param {{ me: any, people?: any[], refused?: [number, string] | null }} served
 */
export async function youDoor(door, served) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://door');
    const id = url.pathname === '/v1/people' && request.method === 'GET' ? url.searchParams.get('id') : null;
    const person = id === null ? undefined : id === 'me' ? served.me : (served.people ?? []).find(each => each.id === id);
    if (id === 'me' && served.refused) {
      const [status, code] = served.refused;
      return void response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code, message: `${code} (the test's)` }));
    }
    if (person !== undefined) {
      const [status, body] = person === null
        ? [404, { code: 'PERSON_UNKNOWN', message: 'no person me' }]
        : [200, { person, position: 'synthetic' }];
      return void response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }
    const { host: _host, ...headers } = request.headers;
    const onward = httpRequest(`${door}${request.url}`, { method: request.method, headers }, answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    onward.on('error', () => response.destroy());
    request.pipe(onward);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    close: () => new Promise(done => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    }),
  };
}
