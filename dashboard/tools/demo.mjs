// @ts-check
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import AGENTS from '../../homelink/Tests/Fixtures/agents/door/list.json' with { type: 'json' };
import { askModel } from '../test/stand-ins/ask-ready.mjs';
import { FULL_DAY } from '../test/stand-ins/full-life.mjs';
import { CHATGPT_SIGNED_IN } from '../test/stand-ins/onboarding-home.mjs';

export const DEMO_YOU = 'Inês Moreira';

/** @type {Record<string, string>} */
export const DEMO_PEOPLE = {
  A: 'Beatriz Antunes', B: 'Samuel Osei', C: 'Helena Vaz', D: 'Tomás Brandão', E: 'Priya Raman', F: 'Diego Salgado',
  G: 'Amara Nwosu', H: 'Margarida Leal', I: 'Karim Haddad', J: 'Jonas Weber', K: 'Sara Lindqvist', L: 'Mateus Correia',
  M: 'Aiko Nishida', N: 'Lucía Ferrán', O: 'Omar Benali', P: 'Hugo Rebelo', Q: 'Rita Calado', R: 'Pedro Amaral',
  S: 'Fatima Rahimi', T: 'Clara Bastos', U: 'Arjun Pillai', V: 'Teresa Godinho', W: 'Lukas Brandt', X: 'Marisol Ortega',
  Y: 'Ben Achterberg', Z: 'Leonor Falcão', AA: 'Yusuf Kaya', AB: 'Daniel Moura', AC: 'Elena Morozova', AD: 'Filipe Lacerda',
  AE: 'Mei Lin Chou', AF: 'Noor Shah', AG: 'Tiago Rosmaninho', AH: 'André Quintela', AJ: 'Carlos Vidal', AK: 'Vasco Simões',
  AL: 'Anja Petersen',
};

export const DEMO_MODELS = [
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', thinking: ['low', 'medium', 'high'], default: 'high', group: 'ChatGPT', where: 'Sent to OpenAI' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', thinking: ['low', 'high'], default: 'high', group: 'ChatGPT', where: 'Sent to OpenAI' },
].map(askModel);

export const DEMO_NOW = Date.UTC(2026, 10, 19, 18, 40);

const DEMO_CHAT = { chat: '1792396847000-aaa001', title: 'That Saturday in Lisbon', first_ms: DEMO_NOW - 2 * 86_400_000, last_ms: DEMO_NOW - 7_200_000,
  messages: 8 };
const DEMO_DAY_BACK = Math.round((Date.parse(FULL_DAY) - Date.parse(new Date(DEMO_NOW).toISOString().slice(0, 10))) / 86_400_000);

/** @type {{ name: string, screen: string, phone: string, hash?: string, run?: string }[]} */
export const DEMO_PICTURES = [
  { name: 'timeline', screen: 'days-all-open', phone: `day:${DEMO_DAY_BACK}` },
  { name: 'chat', screen: 'chat-thread-top', phone: `thread:${DEMO_CHAT.chat}` },
  { name: 'people', screen: 'people-list', phone: 'people' },
  { name: 'places', screen: 'days-all-open', phone: 'places', hash: '#view=places', run: '' },
];
const DEMO_AGENT = AGENTS.answer.readers.find(reader => reader.kind === 'agent' && reader.state === 'connected');
const DEMO_ACCOUNTS = ['gmail'];

/** @param {{ latitude: number, longitude: number }} place */
const placed = place => Math.abs(place.latitude) > 1 || Math.abs(place.longitude) > 1;

const PERSON = /\bPerson ([A-Z]{1,2})\b/gu;

/** @param {string} text */
const renamed = text => text.replace(PERSON, (whole, letters) => {
  const name = DEMO_PEOPLE[letters];
  if (!name) throw new Error(`no demo name for ${whole}`);
  return name;
});

/**
 * @param {unknown} value
 * @returns {any}
 */
export const named = value => {
  if (typeof value === 'string') return renamed(value);
  if (Array.isArray(value)) return value.map(named);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, named(each)]));
  return value;
};

/**
 * @param {string} path
 * @param {URLSearchParams} query
 * @param {any} body
 */
const shaped = (path, query, body) => {
  const read = named(body);
  if (path === '/v1/people' && !query.has('id') && !query.has('q') && read.you) read.you = { ...read.you, name: DEMO_YOU };
  if (path === '/v1/connectors' && read.setup) read.setup = { ...read.setup, skipped: [...read.setup.skipped ?? [], 'imports'] };
  if (path === '/v1/connectors' && read.extension) read.extension = { ...read.extension, placed: true, present: true };
  if (path === '/v1/connectors' && Array.isArray(read.connectors)) {
    read.connectors = read.connectors.map((/** @type {any} */ each) => DEMO_ACCOUNTS.includes(each.id)
      ? { ...each, set_up: true, on: true, health: { ...each.health, state: 'ok', words: 'Up to date' } } : each);
  }
  if (path === '/v1/agents' && Array.isArray(read.readers) && DEMO_AGENT) read.readers = [...read.readers, DEMO_AGENT];
  if (path === '/v1/ask/chats' && Array.isArray(read.chats) && !read.chats.length && !query.has('after')) read.chats = [DEMO_CHAT];
  if (path === '/v1/page/places' && Array.isArray(read.cities)) {
    read.to_name = [];
    read.cities = read.cities.map((/** @type {any} */ city) => ({ ...city, places: city.places.filter(placed), once: city.once.filter(placed) }))
      .filter((/** @type {any} */ city) => city.places.length || city.once.length);
  }
  if (path === '/v1/places' && Array.isArray(read.places)) {
    read.spots = [];
    read.places = read.places.filter(placed)
      .map((/** @type {any} */ place) => {
        const { home: _home, ...rest } = place;
        return rest;
      });
  }
  return read;
};

/**
 * @param {{ stub?: { url: string, json?: unknown }[] }} screen
 * @returns {Map<string, unknown>}
 */
export const doorAnswers = screen => new Map((screen.stub ?? []).flatMap(rule => {
  if (rule.json === undefined) return [];
  if (rule.url === 'api/ask$') return [['/v1/ask', { starters: [], .../** @type {object} */ (rule.json) }]];
  if (rule.url === 'api/ask/chats') return [['/v1/ask/chats', rule.json]];
  const chat = /^api\/ask\/chat\\\?chat=(.+)$/u.exec(rule.url)?.[1];
  return chat ? [[`/v1/ask/chats/${chat}`, rule.json]] : [];
}));

/**
 * @param {Map<string, unknown>} answers
 * @returns {Map<string, unknown>}
 */
export const phoneAnswers = answers => new Map([...answers].map(([path, answer]) => {
  const thread = /** @type {any} */ (answer);
  return path === `/v1/ask/chats/${DEMO_CHAT.chat}` && Array.isArray(thread?.messages)
    ? [path, { ...thread, messages: thread.messages.slice(0, 2) }] : [path, answer];
}));

/** @param {{ door: { url: string }, token?: string, answers?: Map<string, unknown> }} options */
export async function demoDoor({ door, token, answers }) {
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function answer(request, response) {
    const url = new URL(request.url ?? '', 'http://door');
    const known = request.method === 'GET' ? answers?.get(url.pathname) : undefined;
    if (known !== undefined) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return void response.end(JSON.stringify(known));
    }
    /** @type {Buffer[]} */
    const body = [];
    for await (const chunk of request) body.push(chunk);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && !['host', 'connection', 'content-length'].includes(name)) headers[name] = String(value);
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const passed = await fetch(`${door.url}${request.url}`, {
      method: request.method, headers, body: body.length ? Buffer.concat(body) : undefined,
    }).catch(() => null);
    if (!passed) return void response.writeHead(502).end();
    /** @type {Record<string, string>} */
    const back = {};
    passed.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) back[name] = value;
    });
    if ((passed.headers.get('content-type') ?? '').startsWith('application/json') && passed.status === 200) {
      const text = JSON.stringify(shaped(url.pathname, url.searchParams, await passed.json()));
      response.writeHead(passed.status, back);
      return void response.end(text);
    }
    response.writeHead(passed.status, back);
    if (!passed.body) return void response.end();
    const stream = Readable.fromWeb(/** @type {any} */ (passed.body));
    response.once('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }
  const server = createServer((request, response) => {
    answer(request, response).catch(() => response.destroy());
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

const MINUTE = 60_000;

/**
 * @param {any} body
 * @param {number} by
 * @returns {any}
 */
const moved = (body, by) => {
  if (Array.isArray(body)) return body.map(each => moved(each, by));
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key,
    /_ms$/u.test(key) && typeof value === 'number' && key !== 'ms' ? Math.round((value + by) / MINUTE) * MINUTE : moved(value, by)]));
};

/** @param {any} body */
const asked = body => {
  if (!body || typeof body !== 'object' || !Array.isArray(body.models)) return body;
  const [first] = DEMO_MODELS;
  return { ...body, default: { model: first.id, thinking: first.default, shown: first.id }, models: DEMO_MODELS };
};

/** @param {any} body */
const answeredBy = body => body && typeof body === 'object' && Array.isArray(body.messages)
  ? { ...body, messages: body.messages.map((/** @type {any} */ each) => each.model ? { ...each, model: DEMO_MODELS[0].id } : each) } : body;

/** @param {any} body */
const organised = body => {
  if (!body || typeof body !== 'object' || !Array.isArray(body.people) || !body.organise) return body;
  const people = body.people.filter((/** @type {any} */ each) => each.entity !== 'ai');
  const queue = people.slice(-4).map((/** @type {any} */ each) => each.id);
  return { ...body, people: body.people.map((/** @type {any} */ each) => queue.includes(each.id) ? { ...each, organised: false } : each),
    organise: { ...body.organise, queue, organised: people.length - queue.length, often: queue.length } };
};

/** @param {any} list */
export const demoPeople = list => organised({ ...list, you: list.you && { ...list.you, name: DEMO_YOU } });

/**
 * @template {{ name: string, hash: string, host?: unknown, stub?: { url: string, json?: unknown }[], now?: number, whole?: boolean, run?: string, section: string, title: string }} Screen
 * @param {Screen[]} screens
 * @returns {Screen[]}
 */
export function demoScreens(screens) {
  const by = DEMO_NOW - Date.now();
  return DEMO_PICTURES.map(({ name, screen, hash, run }) => {
    const found = screens.find(each => each.name === screen);
    if (!found) throw new Error(`no screen ${screen} for the demo picture ${name}`);
    const stub = (found.stub ?? []).map(rule => rule.json === undefined ? rule
      : { ...rule, json: organised(answeredBy(asked(rule.url.startsWith('api/ask') ? moved(named(rule.json), by) : named(rule.json)))) });
    const host = found.host && typeof found.host === 'object' ? { ...found.host, ask_login: CHATGPT_SIGNED_IN } : found.host;
    return { ...found, host, name, section: 'Demo', title: `README picture: ${name}`, hash: hash ?? found.hash, stub, now: DEMO_NOW, whole: false,
      run: run ?? found.run };
  });
}
