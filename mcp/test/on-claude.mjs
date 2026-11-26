// @ts-check
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askOn, createHandler } from '../server.mjs';
import { home, homeClock, login, startHome, stopHome } from './asking.mjs';
import { openDoorway } from './programs.mjs';

/** @type {Set<{ close: () => Promise<unknown> }>} */
const open = new Set();

/** @param {string} name */
export const onClaude = name => {
  before(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-synthetic-key';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-synthetic-oauth';
    await startHome('http://127.0.0.1:9');
  });
  after(async () => {
    for (const each of [...open]) await each.close();
    await stopHome(fileURLToPath(new URL(`../.build/e2e/${name}.json`, import.meta.url)));
  });
};

const ASKS_OWN = ['ask', 'mcp', 'subscriptions', 'scratch'];

/**
 * @param {string} machine
 * @param {RegExp} pattern
 * @param {string[]} [places]
 */
export const holding = async (machine, pattern, places = ASKS_OWN) => {
  const found = [];
  for (const place of places.map(each => join(machine, each)).filter(existsSync)) {
    for (const entry of await readdir(place, { recursive: true, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name);
      if (entry.isFile() && pattern.test(await readFile(path, 'utf8'))) found.push(path);
    }
  }
  return found;
};

/** @param {number} pid */
export const gone = pid => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** @param {{ machine: string, codeMs?: number, liveMs?: number, listedMs?: number, now?: () => number }} options */
export async function askServer({ machine, codeMs, liveMs, listedMs, now = homeClock }) {
  const doorway = await openDoorway(home.url);
  /** @type {Record<string, unknown>[]} */
  const logged = [];
  const log = (/** @type {Record<string, unknown>} */ line) => void logged.push(line);
  const ask = askOn(machine, { door: doorway.url, followMs: 50, now, log, ...(codeMs === undefined ? {} : { codeMs }), ...(liveMs === undefined ? {} : { liveMs }), ...(listedMs === undefined ? {} : { listedMs }) });
  const handler = createHandler({ door: doorway.url, ask, log });
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return true;
    closed = true;
    open.delete(entry);
    const delivered = await handler.close(5_000);
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
    await doorway.close();
    return delivered;
  };
  const entry = { close };
  open.add(entry);
  return { url, handler, doorway, logged, close };
}

/** @param {string} url */
export const claudeState = async url => (await login(url, 'GET')).body.claude;

/** @param {any[]} events */
export const doneOf = events => events.find(event => event.type === 'done')?.message;
/** @param {any[]} events */
export const errorOf = events => events.find(event => event.type === 'error');

/**
 * @param {string} url
 * @param {string | null} bearer
 * @param {unknown} body
 */
export const toolsCall = async (url, bearer, body) => {
  const response = await fetch(`${url}/ask/tools`, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) } });
  return { status: response.status, body: /** @type {any} */ (await response.json().catch(() => null)) };
};

/** @param {string} machine */
export const bearerOf = async machine => {
  const files = (await readdir(join(machine, 'ask', 'claude'))).filter(name => name.endsWith('.tools.json'));
  assert.equal(files.length, 1, files.join(', '));
  const config = JSON.parse(await readFile(join(machine, 'ask', 'claude', /** @type {string} */ (files[0])), 'utf8'));
  return String(config.mcpServers.lifestream.headers.Authorization).slice('Bearer '.length);
};
