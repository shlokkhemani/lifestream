// @ts-check
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LIMITS, openAsk } from './lib/ask/ask.mjs';
import { openClaude } from './lib/ask/claude.mjs';
import { openCodex } from './lib/ask/codex.mjs';
import { modelsRead } from './lib/ask/conversations.mjs';
import { machineDir, PROGRAM_OF, programAt } from './lib/ask/programs.mjs';
import { openSignIn } from './lib/ask/sign-in.mjs';
import { createPublicHandler, PUBLIC_PORT } from './lib/agents/public.mjs';
import { DEFAULT_DOOR, openDoor, passOf, serverPass } from './lib/door.mjs';
import { DoorRefusal, ToolError } from './lib/errors.mjs';
import { openMemory } from './lib/memory.mjs';
import { serverOf, SKILL_FILE, SKILL_ROUTE } from './lib/tools.mjs';


export const DEFAULT_PORT = 4681;
const EVERY_ADDRESS = '0.0.0.0';
const LOOPBACK = '127.0.0.1';
const BEARER = /^Bearer\s+\S+$/u;
const CLOSE_MS = 20_000;
const MAX_BODY = 16_384;
const MAX_QUESTION = 2_000;
const ASK_ROUTES = /^\/ask(?:\/(stop)|\/(chats)(?:\/([^/]+)(\/events)?)?)?$/u;
const LOGIN_ROUTE = '/ask/login';
const TOOLS_ROUTE = '/ask/tools';
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/iu;
/** @param {Record<string, unknown>} line */
const LOG = line => void process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);

/**
 * @param {{ door: string, ask?: (Omit<Parameters<typeof openAsk>[0], 'memory' | 'door' | 'log'> & { signIn?: ReturnType<typeof openSignIn> }) | null, machine?: string, log?: (line: Record<string, unknown>) => void }} options
 * @returns {import('node:http').RequestListener & { close: (ms: number) => Promise<boolean>, public: (options: { machine: string, now?: () => number, clientDocument?: import('./lib/agents/clients.mjs').ClientDocument }) => import('node:http').RequestListener }}
 */
export function createHandler({ door, ask = null, machine = ask?.machine, log = LOG }) {
  const server = machine === undefined ? undefined : serverPass(machine);
  const asking = ask === null ? null : openAsk({ ...ask, memory: openMemory(), door, log });
  const signIn = ask?.signIn ?? null;
  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {import('./lib/door.mjs').Door} reader
   * @param {import('./lib/door.mjs').Pass} pass
   * @param {Seen} seen
   */
  const mcpServe = (request, response, reader, pass, seen) => {
    const server = serverOf({ door: reader }, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('finish', () => {
      if (response.statusCode === 200 && server.server.getClientVersion() !== undefined) log({ mcp: 'session', principal: pass.id, ...seen });
    });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    return server.connect(transport).then(() => transport.handleRequest(request, response));
  };
  /** @param {import('node:http').ServerResponse} response @param {unknown} error */
  const failed = (response, error) => {
    log({ failed: error instanceof Error ? error.message : String(error) });
    if (!response.headersSent) refuse(response, 500, 'The MCP server failed on this request.');
  };

  const handler = Object.assign((/** @type {import('node:http').IncomingMessage} */ request, /** @type {import('node:http').ServerResponse} */ response) => {
    const path = URL.parse(request.url ?? '/', 'http://mcp')?.pathname;
    if (path === undefined) return refuse(response, 400, 'The request names no path.');
    if (path === SKILL_ROUTE) return skillRequest(request, response);
    if (asking !== null && path === TOOLS_ROUTE) return void toolsRequest(asking, request, response, log).catch(error => failed(response, error));
    const login = signIn !== null && path === LOGIN_ROUTE;
    const route = asking === null || login ? null : ASK_ROUTES.exec(path);
    if (path !== '/mcp' && route === null && !login) return refuse(response, 404, 'Not found: the MCP endpoint is /mcp.');
    const methods = login ? ['GET', 'POST'] : route === null ? ['POST'] : route[1] !== undefined ? ['POST']
      : route[2] !== undefined ? ['GET'] : ['GET', 'POST'];
    if (!methods.includes(request.method ?? '')) {
      response.setHeader('allow', methods.join(', '));
      return refuse(response, 405, route !== null || login ? `${path} takes ${methods.join(' and ')}.` : 'This server is stateless: it takes POST only.');
    }
    const reader = readerOf(request, door, log, undefined, path === '/mcp' ? server : undefined);
    if (reader === null) {
      response.setHeader('www-authenticate', LOCAL_CHALLENGE);
      return refuse(response, 401, 'Send a door pass: Authorization: Bearer <pass>.');
    }
    const seen = seenOf(request, 'local');
    admitted(reader, response, { log, challenge: `${LOCAL_CHALLENGE}, error="invalid_token"`, seen }).then(pass => {
      if (pass === null) return;
      if (path === '/mcp') return agentOnly(pass, response, log, seen) ? mcpServe(request, response, reader, pass, seen) : undefined;
      if (pass.kind === 'agent') {
        log({ ask: 'refused an agent', path });
        return refuse(response, 403, 'An agent reads through /mcp: Ask is the person\'s own.');
      }
      if (pass.turn !== null && pass.turn.relayed !== `${request.method} ${path}`) {
        log({ ask: 'refused a turn\'s pass', path });
        return refuse(response, 403, 'A turn\'s pass reads for its turn, and asks Chat nothing.');
      }
      if (signIn !== null && login) {
        if (pass.kind !== 'mac') {
          log({ login: 'refused a pass not the Mac app\'s', kind: pass.kind });
          return refuse(response, 403, 'Ask is signed in from Lifestream on the Mac it runs on.');
        }
        return loginRequest(signIn, reader, request, response, log).catch(error => {
          const message = error instanceof Error ? error.message : String(error);
          log({ login: `failed: ${message.slice(0, 200)}` });
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: `The sign-in failed: ${message}` }));
          }
        });
      }
      if (asking !== null && route !== null) {
        const door = pass.turn === null ? reader
          : { ...reader, pass: createHash('sha256').update(`turn\0${pass.id}\0${pass.turn.chat ?? ''}`).digest('hex') };
        return askRequest(asking, door, route, request, response, log, pass.turn?.chat ?? undefined).catch(error => log({ failed: error instanceof Error ? error.message : String(error) }));
      }
    }).catch(error => failed(response, error));
  }, {
    close: async (/** @type {number} */ ms) => {
      const [, delivered] = await Promise.all([signIn?.close(), asking === null ? true : asking.close(ms)]);
      return delivered;
    },
    /**
     * @param {{ machine: string, now?: () => number, clientDocument?: import('./lib/agents/clients.mjs').ClientDocument }} options
     * @returns {import('node:http').RequestListener}
     */
    public: ({ machine, now, clientDocument }) => createPublicHandler({
      door, machine, log, ...(now === undefined ? {} : { now }), ...(clientDocument === undefined ? {} : { clientDocument }),
      mcp: (request, response, { resource, challenge }) => {
        const reader = readerOf(request, door, log, 'public', server);
        if (reader === null) {
          response.setHeader('www-authenticate', challenge(false));
          return refuse(response, 401, 'Send a pass: Authorization: Bearer <pass>.');
        }
        const seen = seenOf(request, 'public');
        admitted(reader, response, { log, challenge: challenge(true), resource, seen })
          .then(pass => pass === null || !agentOnly(pass, response, log, seen) ? undefined : mcpServe(request, response, reader, pass, seen))
          .catch(error => failed(response, error));
      },
    }),
  });
  return handler;
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
function skillRequest(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    return refuse(response, 405, `${SKILL_ROUTE} takes GET.`);
  }
  response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  response.end(SKILL_FILE);
}

const LOCAL_CHALLENGE = 'Bearer realm="lifestream"';

/** @typedef {{ via: 'local' | 'public', client?: string }} Seen */

/** @param {import('node:http').IncomingMessage} request @param {'local' | 'public'} via @returns {Seen} */
function seenOf(request, via) {
  const agent = request.headers['user-agent'];
  return { via, ...(typeof agent === 'string' && agent !== '' ? { client: agent.slice(0, 80) } : {}) };
}

export const AGENT_ONLY_WORDS = 'This pass is not an agent\'s pass. In Lifestream, open Settings, then Agents, '
  + 'and add this agent: click "Add an agent with a pass" and give the agent the pass it shows, or turn on "Reach from '
  + 'anywhere" and sign the agent in.';

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {string} door
 * @param {(line: Record<string, unknown>) => void} log
 * @param {'public'} [reach]
 * @param {() => string | null} [server]
 */
function readerOf(request, door, log, reach, server) {
  const authorization = request.headers.authorization ?? '';
  if (!BEARER.test(authorization)) return null;
  const named = request.headers['lifestream-device'];
  return openDoor({ url: door, authorization, ...(typeof named === 'string' ? { device: named } : {}), ...(reach === undefined ? {} : { reach }),
    ...(server === undefined ? {} : { server }), log });
}

/**
 * @param {import('./lib/door.mjs').Pass} pass
 * @param {import('node:http').ServerResponse} response
 * @param {(line: Record<string, unknown>) => void} log
 * @param {Seen} seen
 */
function agentOnly(pass, response, log, seen) {
  if (pass.kind === 'agent') return true;
  log({ mcp: 'refused a pass not an agent\'s', kind: pass.kind, ...seen });
  response.writeHead(403, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: AGENT_ONLY_WORDS, code: 'AGENT_ONLY' }));
  return false;
}

/**
 * @param {import('./lib/door.mjs').Door} reader
 * @param {import('node:http').ServerResponse} response
 * @param {{ log: (line: Record<string, unknown>) => void, challenge: string, resource?: string, seen: Seen }} options
 * @returns {Promise<import('./lib/door.mjs').Pass | null>}
 */
async function admitted(reader, response, { log, challenge, resource, seen }) {
  const asked = await passOf(reader);
  if ('pass' in asked) {
    if (resource === undefined || asked.pass.resource === resource || asked.pass.resource === null) return asked.pass;
    log({ mcp: 'pass refused', status: 401, code: 'ANOTHER_RESOURCE', ...seen });
    response.setHeader('www-authenticate', challenge);
    refuse(response, 401, 'This access was granted for another address. Sign in again.');
    return null;
  }
  const { refusal } = asked;
  if (refusal instanceof DoorRefusal && refusal.status >= 400 && refusal.status < 500) {
    log({ mcp: 'pass refused', status: refusal.status, code: refusal.code, ...seen });
    response.setHeader('www-authenticate', challenge);
    refuse(response, 401, `The door refused this pass: ${refusal.code}. Sign in again, or send a pass the door knows.`);
  } else if (refusal instanceof DoorRefusal) {
    log({ mcp: 'pass unchecked', via: seen.via, status: refusal.status, code: refusal.code });
    if (refusal.retryAfter !== null) response.setHeader('retry-after', String(refusal.retryAfter));
    refuse(response, refusal.status, refusal.message);
  } else {
    log({ mcp: 'pass unchecked', via: seen.via, status: 503, code: 'GONE' });
    refuse(response, 503, refusal.message);
  }
  return null;
}

/** @param {{ door: string, pass: string, machine?: string, log?: (line: Record<string, unknown>) => void }} options */
export async function serveStdio({ door, pass, machine = machineDir(), log = line => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`) }) {
  const server = serverOf({ door: openDoor({ url: door, authorization: `Bearer ${pass}`, server: serverPass(machine), log }) }, log);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * @param {ReturnType<typeof openAsk>} asking
 * @param {import('./lib/door.mjs').Door} door
 * @param {RegExpExecArray} route
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {(line: Record<string, unknown>) => void} log
 * @param {string} [fresh]
 */
async function askRequest(asking, door, route, request, response, log, fresh) {
  /** @param {number} status @param {unknown} body */
  const json = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const [, stop, chats, chat, events] = route;
  const url = /** @type {URL} */ (URL.parse(request.url ?? '/', 'http://mcp'));
  try {
    if (chats !== undefined) {
      if (chat === undefined) return json(200, await asking.list(door, url.searchParams.get('after') ?? undefined));
      if (events === undefined) {
        const found = await asking.read(door, chat);
        if (found === null) return json(404, { error: `No conversation ${chat}.` });
        return 'refused' in found ? json(found.refused, { error: found.error }) : json(200, found);
      }
      await asking.allowed(door);
      const turn = await asking.follow(door, chat);
      if (turn === null) {
        response.writeHead(204);
        return response.end();
      }
      if ('refused' in turn) return json(turn.refused, { error: turn.error });
      return stream(turn, response);
    }
    if (stop === undefined && request.method === 'GET') {
      const [model, thinking] = ['model', 'thinking'].map(name => url.searchParams.get(name) || undefined);
      return json(200, await asking.status(door, { ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinking }) }));
    }
    const read = await bodyOf(request, '{"question": "…"}');
    if (!('body' in read)) {
      log({ ask: `refused ${read.refused}` });
      return json(read.refused, { error: read.error });
    }
    const { body } = read;
    if (stop !== undefined) {
      if (typeof body.chat !== 'string') return json(400, { error: 'Send JSON: {"chat": "…"}.' });
      await asking.allowed(door);
      return json(200, { stopped: asking.stop(body.chat) });
    }
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const tools = `http://127.0.0.1:${request.socket.localPort}${TOOLS_ROUTE}`;
    const asked = askedOf(body, question);
    if ('refused' in asked) return json(asked.refused, { error: asked.error });
    if (body.chat !== undefined && typeof body.chat !== 'string') return json(400, { error: 'chat is a conversation\'s id, as the chat event named it.' });
    for (const name of /** @type {const} */ (['model', 'thinking'])) {
      if (body[name] !== undefined && typeof body[name] !== 'string') return json(400, { error: `${name} is a name, as GET /ask lists them.` });
    }
    const turn = await asking.ask(door, {
      question, tools, ...asked.files, keep: fresh !== undefined, ...(typeof body.chat === 'string' ? { chat: body.chat } : fresh === undefined ? {} : { fresh }),
      ...(typeof body.model === 'string' ? { model: body.model } : {}), ...(typeof body.thinking === 'string' ? { thinking: body.thinking } : {}),
    });
    if ('refused' in turn && 'missing' in turn && turn.missing !== undefined) return json(turn.refused, { error: turn.error, missing: turn.missing });
    if ('refused' in turn) return json(turn.refused, { error: turn.error });
    return stream(turn, response);
  } catch (error) {
    if (error instanceof ToolError) return json(error instanceof DoorRefusal ? error.status : 503, { error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    log({ ask: `failed: ${message.slice(0, 200)}` });
    if (!response.headersSent) json(500, { error: `The ask failed: ${message}` });
    else if (!response.writableEnded) response.end();
  }
}

const FILE = /^sha256:[0-9a-f]{64}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const MOST_PHOTOS = LIMITS.photos;
const MOST_SECONDS = LIMITS.voice_ms / 1_000;

/**
 * @param {Record<string, any>} body
 * @param {string} question
 * @returns {{ files: { submission: string, photos?: string[], voice?: { note: string, seconds: number } | { audio: string } } } | { refused: number, error: string }}
 */
function askedOf(body, question) {
  if (body.submission === undefined) return { refused: 422, error: 'A question names its submission: its id, 32 hex, minted once and sent again with every replay.' };
  if (typeof body.submission !== 'string' || !HEX32.test(body.submission)) return { refused: 400, error: 'submission is the question\'s id, 32 hex, minted once and sent again with every replay.' };
  const photos = body.photos ?? [];
  if (!Array.isArray(photos) || !photos.every(photo => typeof photo === 'string' && FILE.test(photo))) return { refused: 400, error: 'photos is a list of files, each sha256:<64 hex> as POST /v1/ask/files answered.' };
  if (photos.length > MOST_PHOTOS) return { refused: 422, error: `A question holds at most ${MOST_PHOTOS} photos.` };
  if (new Set(photos).size !== photos.length) return { refused: 422, error: 'A photo is named twice.' };
  const voice = body.voice;
  /** @type {{ note: string, seconds: number } | { audio: string } | undefined} */
  let note;
  if (voice !== undefined) {
    if (voice === null || typeof voice !== 'object') return { refused: 400, error: 'voice is {note, seconds} or {audio}.' };
    if (Object.keys(voice).length === 1 && typeof voice.audio === 'string' && FILE.test(voice.audio)) note = { audio: voice.audio };
    else if (Object.keys(voice).length === 2 && typeof voice.note === 'string' && HEX32.test(voice.note) && Number.isSafeInteger(voice.seconds) && voice.seconds >= 1) {
      if (voice.seconds > MOST_SECONDS) return { refused: 422, error: `A voice note lasts at most ${MOST_SECONDS / 60} minutes.` };
      note = { note: voice.note, seconds: voice.seconds };
    } else return { refused: 400, error: 'voice is {note: <32 hex>, seconds: 1 or more} or {audio: sha256:<64 hex>}.' };
  }
  if (note !== undefined && question !== '') return { refused: 422, error: 'A question is typed words or a voice note, not both.' };
  if (note === undefined && question === '') return { refused: 422, error: 'A question is typed words or a voice note: send one.' };
  if (question.length > MAX_QUESTION) return { refused: 400, error: `question is the words asked, 1 to ${MAX_QUESTION} characters.` };
  return { files: { submission: body.submission, ...(photos.length === 0 ? {} : { photos }), ...(note === undefined ? {} : { voice: note }) } };
}

/**
 * @param {ReturnType<typeof openSignIn>} signIn
 * @param {import('./lib/door.mjs').Door} door
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {(line: Record<string, unknown>) => void} log
 */
async function loginRequest(signIn, door, request, response, log) {
  /** @param {number} status @param {unknown} body */
  const json = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const origin = request.headers.origin;
  if (!request.socket.localAddress?.startsWith('127.') || !LOOPBACK_HOST.test(request.headers.host ?? '') || (origin !== undefined && origin !== 'null')) {
    return json(403, { error: 'Ask is signed in on its own Mac, through Lifestream.' });
  }
  if (request.method === 'GET') return json(200, await signIn.state(door));
  const read = await bodyOf(request, '{"do": "start", "of": "chatgpt"}');
  if (!('body' in read)) return json(read.refused, { error: read.error });
  const { body } = read;
  const of = /** @type {'chatgpt' | 'claude'} */ (body.of);
  const subscribed = typeof body.of === 'string' && Object.hasOwn(PROGRAM_OF, body.of);
  if (!['start', 'code', 'cancel', 'sign_out'].includes(String(body.do))) return json(400, { error: 'do is start, code, cancel or sign_out.' });
  if (!subscribed) return json(400, { error: 'of is chatgpt or claude.' });
  log({ login: String(body.do), of });
  if (body.do === 'start') return json(200, await signIn.start(of, door));
  if (body.do === 'cancel') return json(200, await signIn.cancel(of, door));
  if (body.do === 'sign_out') return json(200, await signIn.signOut(of, door));
  if (of !== 'claude') return json(400, { error: 'A code is typed for Claude\'s sign-in alone.' });
  if (typeof body.attempt !== 'string' || typeof body.code !== 'string') return json(400, { error: 'Send JSON: {"do": "code", "of": "claude", "attempt": "…", "code": "…"}.' });
  const taken = await signIn.code(body.attempt, body.code.trim(), door);
  return 'refused' in taken ? json(taken.refused, { error: taken.error }) : json(200, taken);
}

/**
 * @param {ReturnType<typeof openAsk>} asking
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {(line: Record<string, unknown>) => void} log
 */
async function toolsRequest(asking, request, response, log) {
  if (!request.socket.localAddress?.startsWith('127.')) return refuse(response, 404, 'Not found: the MCP endpoint is /mcp.');
  const bearer = /^Bearer\s+(\S+)$/u.exec(request.headers.authorization ?? '')?.[1];
  const tooling = bearer === undefined ? null : asking.tooling(bearer);
  if (tooling === null) {
    log({ tools: 'refused a bearer no process holds' });
    return refuse(response, 401, 'These tools are a Claude Code process of Ask\'s, by its own bearer.');
  }
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    return refuse(response, 405, 'This server is stateless: it takes POST only.');
  }
  const server = new Server({ name: 'lifestream', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tooling.list() }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const answer = await tooling.call(params.name, params.arguments ?? {});
    return { content: [{ type: 'text', text: answer.text }, ...answer.images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))], isError: answer.error };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

/**
 * @param {import('./lib/ask/ask.mjs').Turn} turn
 * @param {import('node:http').ServerResponse} response
 */
function stream(turn, response) {
  response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const leave = turn.follow(event => {
    if (event === null) response.end();
    else response.write(`${JSON.stringify(event)}\n`);
  });
  response.on('close', leave);
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {string} example
 * @returns {Promise<{ body: Record<string, unknown> } | { refused: number, error: string }>}
 */
async function bodyOf(request, example) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) return { refused: 413, error: `A body is at most ${MAX_BODY} bytes.` };
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) return { body };
  } catch {}
  return { refused: 400, error: `Send JSON: ${example}.` };
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {string} message
 */
function refuse(response, status, message) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/** @typedef {NodeJS.Dict<import('node:os').NetworkInterfaceInfo[]>} Interfaces */

/**
 * @param {() => Interfaces} [read]
 * @returns {(address: string) => boolean}
 */
export function tailnetOf(read = networkInterfaces) {
  const reading = () => {
    /** @type {Set<string>} */
    const found = new Set();
    for (const [name, each] of Object.entries(read())) {
      if (!name.startsWith('utun')) continue;
      for (const address of each ?? []) {
        const [first, second] = address.address.split('.').map(Number);
        if (address.family === 'IPv4' && !address.internal && first === 100 && (second ?? 0) >= 64 && (second ?? 0) < 128) found.add(address.address);
      }
    }
    return found;
  };
  let known = reading();
  return address => {
    if (known.has(address)) return true;
    known = reading();
    return known.has(address);
  };
}

/**
 * @param {(address: string) => boolean} tailnet
 * @returns {(socket: import('node:net').Socket) => boolean}
 */
function admitting(tailnet) {
  return socket => {
    const local = socket.localAddress ?? '';
    const answered = isIPv4(local) && (local.startsWith('127.') || tailnet(local));
    if (!answered) socket.destroy();
    return answered;
  };
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 */
export function settingsFrom(argv, env) {
  /** @param {string} flag */
  const flag = flag => {
    const at = argv.indexOf(flag);
    return at < 0 ? undefined : argv[at + 1];
  };
  const port = Number(flag('--port') ?? env.LIFESTREAM_MCP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('--port is a port, 0 to 65535');
  const publicPort = Number(env.LIFESTREAM_MCP_PUBLIC_PORT || PUBLIC_PORT);
  if (!Number.isInteger(publicPort) || publicPort < 0 || publicPort > 65_535) throw new Error('LIFESTREAM_MCP_PUBLIC_PORT is a port, 0 to 65535');
  return {
    port,
    publicPort,
    door: (env.LIFESTREAM_DOOR || DEFAULT_DOOR).replace(/\/+$/u, ''),
  };
}

/**
 * @param {string} machine
 * @param {{ door: string, codeMs?: number, followMs?: number, liveMs?: number, listedMs?: number | null, now?: () => number, log?: (line: Record<string, unknown>) => void }} options
 */
export function askOn(machine, { door, codeMs, followMs, liveMs, listedMs, now = Date.now, log = LOG }) {
  const codex = openCodex({ at: () => programAt(machine, 'codex'), log });
  const claude = openClaude({ at: () => programAt(machine, 'claude'), machine, log, now });
  const signIn = openSignIn({ codex, claude, machine, reread: () => modelsRead(machine, door), log, ...(codeMs === undefined ? {} : { codeMs }), ...(followMs === undefined ? {} : { followMs }) });
  return { codex, claude, machine, now, signIn, ...(liveMs === undefined ? {} : { liveMs }), ...(listedMs === undefined ? {} : { listedMs }) };
}

/** @param {{ port: number, publicPort: number, door: string, machine?: string, log?: (line: Record<string, unknown>) => void, interfaces?: () => Interfaces }} settings */
export async function serve({ port, publicPort, door, machine = machineDir(), log = LOG, interfaces = networkInterfaces }) {
  const handler = createHandler({ door, ask: askOn(machine, { door, log }), machine, log });
  const server = createServer(handler);
  server.prependListener('connection', admitting(tailnetOf(interfaces)));
  /** @param {import('node:http').Server} listener @param {number} at @param {string} host @returns {Promise<number>} */
  const listen = (listener, at, host) => new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(at, host, () => {
      listener.off('error', reject);
      resolve(/** @type {import('node:net').AddressInfo} */ (listener.address()).port);
    });
  });
  const served = await listen(server, port, EVERY_ADDRESS);
  const opened = createServer(handler.public({ machine }));
  const open = await listen(opened, publicPort, LOOPBACK).catch((/** @type {NodeJS.ErrnoException} */ error) => {
    log({ public: `not listening on ${LOOPBACK}:${publicPort}: ${error.code ?? error.message}; the next start tries again` });
    return null;
  });
  return { server, port: served, public: open === null ? null : opened, publicPort: open, close: handler.close };
}

const entry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) process.umask(0o077);

if (entry && process.argv.includes('--stdio')) {
  const pass = process.env.LIFESTREAM_PASS ?? '';
  if (!/^\S+$/u.test(pass)) {
    process.stderr.write('LIFESTREAM_PASS holds no pass: make one in Connectors in the Lifestream app, and paste its lines again.\n');
    process.exit(2);
  }
  const server = await serveStdio({ door: settingsFrom([], process.env).door, pass });
  process.stdin.once('end', () => void server.close().then(() => process.exit(0)));
} else if (entry) {
  const settings = settingsFrom(process.argv.slice(2), process.env);
  const { server, port, public: opened, publicPort, close } = await serve(settings);
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), mcp: 'open', host: EVERY_ADDRESS, port, public: publicPort, door: settings.door })}\n`);
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    process.once(signal, () => {
      server.close();
      opened?.close();
      void close(CLOSE_MS).then((/** @type {boolean} */ delivered) => {
        process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), mcp: 'closed', delivered })}\n`);
        process.exit(0);
      });
    });
  }
}
