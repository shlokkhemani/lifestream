// @ts-check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { askOn, createHandler } from '../server.mjs';
import { ERASED, pendingFolder } from '../lib/ask/conversations.mjs';
import { EARLIER_PHOTO, VOICE_LINE } from '../lib/ask/prompt.mjs';
import { modelText } from '../lib/ask/seen.mjs';
import { command, home, homeClock, listedIn, minted, modelsOf, named, note, PLAN_ROWS, plansOn, rowReady, startHome, stopHome } from './asking.mjs';
import { fakeClaude, fakeCodex, openDoorway } from './programs.mjs';
import { until } from './until.mjs';

const ARTIFACT = fileURLToPath(new URL('../.build/e2e/media.json', import.meta.url));
/** @type {{ turns: { name: string, words: string, answer: string, seen: import('../lib/ask/seen.mjs').Seen, model: { asked: string, answered: string } }[] }} */
const PRIVACY_VIEW = JSON.parse(readFileSync(new URL('../../design/privacy-view.json', import.meta.url), 'utf8'));
const TYPED = 'Person B';
const FACE = { lines: [], faces: [{ box: [600, 300, 700, 420], confidence: 0.9 }] };
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const ASK_SERVER = fileURLToPath(new URL('./fake/ask-server.mjs', import.meta.url));
const OUTCOMES = fileURLToPath(new URL('../../homelink/Tests/Fixtures/ask-outcomes.json', import.meta.url));
const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
const models = createModels();
models.setProvider(faux.provider);
/** @type {import('node:http').RequestListener} */
let serve = (_, response) => void response.writeHead(503).end();
/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {string[]} */
const machines = [];
let url = '';

/** @param {import('node:http').RequestListener} handler */
async function listen(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
}

/**
 * @param {string} time
 * @param {string} [offset]
 * @param {[number, number]} [point]
 */
function exifJpeg(time, offset, point) {
  const u16 = (/** @type {number} */ value) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
  const u32 = (/** @type {number} */ value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const text = (/** @type {string} */ words) => Buffer.from(`${words}\0`, 'latin1');
  const entry = (/** @type {number} */ tag, /** @type {number} */ type, /** @type {number} */ count, /** @type {Buffer} */ value) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + (point === undefined ? 1 : 2) * 12 + 4;
  const gpsAt = exifAt + 2 + (offset === undefined ? 1 : 2) * 12 + 4;
  let dataAt = gpsAt + (point === undefined ? 0 : 2 + 4 * 12 + 4);
  /** @type {Buffer[]} */
  const data = [];
  const put = (/** @type {Buffer} */ bytes) => { const at = dataAt; data.push(bytes); dataAt += bytes.length; return at; };
  /** @param {number} value */
  const dms = value => Buffer.concat([u32(Math.floor(value)), u32(1), u32(Math.round((value % 1) * 60)), u32(1), u32(0), u32(1)]);
  const exif = [entry(0x9003, 2, time.length + 1, u32(put(text(time)))), ...(offset === undefined ? [] : [entry(0x9011, 2, offset.length + 1, u32(put(text(offset))))])];
  const gps = point === undefined ? [] : [
    entry(0x0001, 2, 2, Buffer.from('N\0\0\0', 'latin1')), entry(0x0002, 5, 3, u32(put(dms(point[0])))),
    entry(0x0003, 2, 2, Buffer.from('E\0\0\0', 'latin1')), entry(0x0004, 5, 3, u32(put(dms(point[1])))),
  ];
  const ifd0 = [entry(0x8769, 4, 1, u32(exifAt)), ...(point === undefined ? [] : [entry(0x8825, 4, 1, u32(gpsAt))])];
  const tiff = Buffer.concat([
    Buffer.from('MM\0*', 'latin1'), u32(ifd0At), u16(ifd0.length), ...ifd0, u32(0), u16(exif.length), ...exif, u32(0),
    ...(point === undefined ? [] : [u16(gps.length), ...gps, u32(0)]), ...data,
  ]);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), u16(app1.length + 2), app1, Buffer.from([0xff, 0xd9])]);
}

/** @param {string} words */
const jpeg = words => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(words, 'utf8')]);
/** @param {Buffer} bytes */
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {string} method
 * @param {string} path
 * @param {Buffer | Record<string, unknown>} [body]
 */
async function door(method, path, body) {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const response = await fetch(`${home.url}${path}`, {
    method, ...(bytes === undefined ? {} : { body: new Uint8Array(bytes) }),
    headers: { authorization: `Bearer ${home.tokens.reader}`, ...(bytes === undefined ? {} : { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' }) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

/**
 * @param {Record<string, unknown>} body
 * @param {{ at?: string, seen?: any[] }} [options]
 */
async function asking(body, { at = `${home.url}/v1/ask`, seen = [] } = {}) {
  const response = await fetch(at, { method: 'POST', body: JSON.stringify({ submission: minted(), ...body }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
  if (!String(response.headers.get('content-type')).startsWith('application/x-ndjson')) return { status: response.status, refused: /** @type {any} */ (await response.json()), events: /** @type {any[]} */ ([]), atChat: null };
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const decoder = new TextDecoder();
  /** @type {any[]} */
  const events = [];
  /** @type {string[] | null} */
  let atChat = null;
  let buffer = '';
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const event = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (event.type === 'chat' && atChat === null) atChat = readdirSync(pendingFolder(home.ask.machine));
      events.push(event);
      seen.push(event);
    }
  }
  note({ asked: body, events: events.map(event => (event.type === 'text' ? { type: 'text' } : event)) });
  return { status: response.status, refused: null, events, atChat };
}

/** @param {Buffer[]} photos */
async function uploaded(photos) {
  for (const photo of photos) {
    const sent = await door('POST', '/v1/ask/files', photo);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  }
  return photos.map(photo => `sha256:${sha(photo)}`);
}

/** @param {string} name */
async function ownMachine(name) {
  const own = await mkdtemp(join(tmpdir(), `lifestream-mcp-${name}-`));
  machines.push(own);
  await mkdir(join(own, 'ask'), { recursive: true });
  await copyFile(join(home.ask.machine, 'ask', 'door-token'), join(own, 'ask', 'door-token'));
  return own;
}

/**
 * @param {string} chat
 * @param {number} n
 */
async function kept(chat, n) {
  const source = /** @type {{ source: string }} */ (/** @type {unknown} */ (home.ask)).source;
  return door('GET', `/v1/record?source=${encodeURIComponent(source)}&kind=msg&key=${encodeURIComponent(`${chat}:${String(n).padStart(4, '0')}`)}`);
}

/** @param {string} machine */
const pendingIn = machine => existsSync(pendingFolder(machine)) ? readdirSync(pendingFolder(machine)) : [];

/**
 * @param {(request: import('node:http').IncomingMessage, status: number, body: string) => boolean | { status: number, body: unknown }} swallowed
 * @param {(request: import('node:http').IncomingMessage) => { status: number, body: unknown } | null | Promise<{ status: number, body: unknown } | null>} [ahead]
 */
function frontDoor(swallowed, ahead = (/** @type {import('node:http').IncomingMessage} */ _request) => /** @type {{ status: number, body: unknown } | null} */ (null)) {
  return listen(async (request, response) => {
    const answered = await ahead(request);
    if (answered !== null) return void request.resume().on('end', () => response.writeHead(answered.status, { 'content-type': 'application/json' }).end(JSON.stringify(answered.body)));
    const { host: _host, ...headers } = request.headers;
    const onward = httpRequest(`${home.url}${request.url}`, { method: request.method, headers }, answer => {
      /** @type {Buffer[]} */
      const chunks = [];
      answer.on('data', chunk => chunks.push(chunk));
      answer.on('end', () => {
        const body = Buffer.concat(chunks);
        const instead = swallowed(request, answer.statusCode ?? 502, body.toString('utf8'));
        if (instead === true) return;
        if (instead !== false) return void response.writeHead(instead.status, { 'content-type': 'application/json' }).end(JSON.stringify(instead.body));
        response.writeHead(answer.statusCode ?? 502, answer.headers).end(body);
      });
    });
    onward.on('error', () => response.destroy());
    request.pipe(onward);
  });
}

/**
 * @param {string} machine
 * @param {string} at
 * @param {Record<string, string>} env
 */
async function serverChild(machine, at, env) {
  const child = spawn(process.execPath, ['--import', join(REPO, 'testing/process.mjs'), ASK_SERVER], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ASK_DOOR: at, ASK_MACHINE: machine, ASK_NOW_MS: String(homeClock()), ...env },
  });
  const exited = new Promise(done => child.once('exit', (_code, signal) => done(signal)));
  const line = await new Promise(done => createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) }).once('line', done));
  return { child, exited, url: /** @type {string} */ (JSON.parse(String(line)).url) };
}

/**
 * @param {string} machine
 * @param {(line: Record<string, unknown>) => void} [log]
 * @param {string} [at]
 */
const ownServer = (machine, log = () => undefined, at = home.url) => listen(createHandler({ door: at, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine, now: homeClock }, log }));

before(async () => {
  url = await listen((request, response) => serve(request, response));
  await startHome(url, { LIFESTREAM_MCP_MEDIA: '1' });
  await command({ cmd: 'key', value: 'sk-or-v1-synthetic' });
  await rowReady(home, home.chat.cloud, true);
  serve = createHandler({ door: home.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: home.ask.machine, now: homeClock }, log: () => undefined });
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise(done => server.close(() => done(undefined)));
  }
  await stopHome(ARTIFACT);
  for (const machine of machines) await rm(machine, { recursive: true, force: true });
});

test('1–4: a photo and a voice note through the real door: the question on disk before `chat`, the note written out by the home and told, the model handed the words after the server\'s line and the photo as the engine made it, the question landed with both blobs, the day\'s line and every read telling the words; the same submission again is answered by its turn', async () => {
  named('journey');
  const photo = jpeg('a synthetic photo sent to Chat');
  const uploaded = await door('POST', '/v1/ask/files', photo);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const file = `sha256:${sha(photo)}`;
  assert.equal(uploaded.body.file, file);
  const voiceNote = randomBytes(16).toString('hex');
  assert.equal((await door('POST', `/v1/ask/notes/${voiceNote}`)).status, 200);
  assert.equal((await door('PUT', `/v1/ask/notes/${voiceNote}/0`, Buffer.alloc(32_000, 3))).status, 200);
  assert.equal((await door('PUT', `/v1/ask/notes/${voiceNote}/1`, Buffer.alloc(16_000, 5))).status, 200);
  /** @type {any} */
  let seen = null;
  faux.setResponses([
    context => {
      seen = context.messages.at(-1);
      return fauxAssistantMessage('A synthetic answer about the photo.');
    },
    fauxAssistantMessage('Synthetic photo'),
  ]);
  const submission = randomBytes(16).toString('hex');
  const turn = await asking({ submission, voice: { note: voiceNote, seconds: 2 }, photos: [file] });
  assert.equal(turn.status, 200, JSON.stringify(turn.refused));
  assert.equal(turn.events[0]?.type, 'chat');
  assert.ok((turn.atChat ?? []).some(name => name.endsWith('.json')), `the pending folder held ${JSON.stringify(turn.atChat)}`);
  const { chat, n } = turn.events[0];
  const told = turn.events.find(event => event.type === 'words');
  assert.ok(typeof told?.words === 'string' && told.words !== '', JSON.stringify(turn.events));
  assert.ok(turn.events.indexOf(/** @type {any} */ (told)) < turn.events.findIndex(event => event.type === 'text'));
  const done = turn.events.find(event => event.type === 'done');
  assert.equal(done?.message.end, 'done', JSON.stringify(done));
  assert.ok(Array.isArray(seen?.content), JSON.stringify(seen));
  const [words, image, ...more] = seen.content;
  assert.equal(more.length, 0);
  assert.equal(words.type, 'text');
  assert.ok(words.text.replace(/^\[Asked [A-Z][a-z]+day [^\]\n]+\]\n/u, '').startsWith(VOICE_LINE), words.text);
  assert.ok(words.text.includes(told.words.trim().slice(0, 20)), words.text);
  assert.deepEqual([image.type, image.mimeType], ['image', 'image/jpeg']);
  const made = Buffer.from(image.data, 'base64').toString('latin1');
  assert.ok(made.includes(`made ${sha(photo)}`), made.slice(0, 200));
  assert.equal(made.includes('a synthetic photo sent to Chat'), false, 'the original bytes never reach the model');
  const source = /** @type {{ source: string }} */ (/** @type {unknown} */ (home.ask)).source;
  const key = `${chat}:${String(n - 1).padStart(4, '0')}`;
  /** @type {any} */
  let record = null;
  await until('the question landed in the home with its words', async () => {
    const read = await door('GET', `/v1/record?source=${encodeURIComponent(source)}&kind=msg&key=${encodeURIComponent(key)}&text=1`);
    record = read.body;
    return read.status === 200 && record?.text?.text === told.words;
  });
  const question = record.version.content;
  assert.deepEqual(question.photos, [file]);
  assert.match(question.voice.audio, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(question.voice.ms, 1_500);
  assert.equal(question.text, '');
  assert.equal(turn.events[0].audio, question.voice.audio, 'the `chat` event names the audio a device plays');
  const blobs = JSON.stringify(record.blobs);
  assert.ok(blobs.includes(file.slice(7)) && blobs.includes(question.voice.audio.slice(7)), blobs);
  note({ record: { content: question, blobs: record.blobs, transcribed: record.transcribed } });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(question.at_ms);
  let lines = '';
  await until(() => `the day's line of the voice question in ${day}: ${lines.slice(-1_500)}`, async () => {
    const read = await fetch(`${home.url}/v1/days/${day}?file=txt`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
    lines = `${read.status} ${await read.text()}`;
    return lines.includes('the user: [voice note, ') && lines.includes(JSON.stringify(told.words.trim().slice(0, 12)).slice(1, -1));
  });
  const kept = /** @type {any} */ (await (await fetch(`${home.url}/v1/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());
  assert.equal(kept.messages[0].voice.words, told.words);
  const fresh = await listen(createHandler({ door: home.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: home.ask.machine, now: homeClock }, log: () => undefined }));
  const read = /** @type {any} */ (await (await fetch(`${fresh}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());
  assert.equal(read.messages.find((/** @type {any} */ message) => message.n === n - 1)?.voice.words, told.words);
  const again = await asking({ submission, voice: { note: voiceNote, seconds: 2 }, photos: [file] });
  assert.deepEqual(again.events.map(event => event.type), ['chat', 'done'], JSON.stringify(again.refused));
  assert.deepEqual([again.events[0].chat, again.events[0].n, again.events[0].audio, again.events[1].message.n], [chat, n, question.voice.audio, n]);
});

test('5: files the door does not hold are the client\'s to send, before any event: a photo the seal finds missing, a note\'s second the join does; no submission, more than ten photos, a photo twice, words with a note or neither are refused', async () => {
  named('refusals');
  const unnamed = await asking({ submission: undefined, question: 'Which id?' });
  assert.equal(unnamed.status, 422);
  assert.match(unnamed.refused.error, /names its submission/u);
  const absent = `sha256:${sha(jpeg('never sent'))}`;
  const missing = await asking({ submission: randomBytes(16).toString('hex'), question: 'What is this?', photos: [absent] });
  assert.equal(missing.status, 409);
  assert.deepEqual(missing.refused.missing, { photos: [absent] });
  const short = randomBytes(16).toString('hex');
  assert.equal((await door('POST', `/v1/ask/notes/${short}`)).status, 200);
  assert.equal((await door('PUT', `/v1/ask/notes/${short}/0`, Buffer.alloc(32_000, 9))).status, 200);
  const unjoined = await asking({ voice: { note: short, seconds: 2 } });
  assert.equal(unjoined.status, 409);
  assert.deepEqual(unjoined.refused.missing, { seconds: [1] });
  const photos = Array.from({ length: 11 }, (_, at) => `sha256:${sha(jpeg(`photo ${at}`))}`);
  assert.equal((await asking({ question: 'Too many?', photos })).status, 422);
  assert.equal((await asking({ question: 'Twice?', photos: [absent, absent] })).status, 422);
  assert.equal((await asking({ question: 'Both?', voice: { audio: absent } })).status, 422);
  assert.equal((await asking({ photos: [absent] })).status, 422);
});

test('6: readiness states the voice row, the limits and each model\'s photos', async () => {
  named('readiness');
  const ready = /** @type {any} */ (await (await fetch(`${home.url}/v1/ask`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());
  note({ ready });
  assert.deepEqual(ready.limits, { photos: 10, photo_bytes: 26_214_400, voice_ms: 600_000 });
  const read = await modelsOf(home);
  assert.deepEqual(new Map(ready.models.map((/** @type {any} */ model) => [model.id, model.photos_off === null])),
    new Map(listedIn(read.uses.chat.menu).map(id => [id, read.models[id].input.includes('image')])));
  assert.deepEqual([home.chat.cloud, home.chat.local, home.chat.small].map(id => ready.models.find((/** @type {any} */ model) => model.id === id)?.photos_off === null), [true, false, true]);
  const listed = /** @type {any} */ ((await door('GET', '/v1/connectors')).body).connectors?.find((/** @type {any} */ each) => each.id === 'ask-home');
  assert.equal(ready.voice.ready, true, JSON.stringify({ voice: ready.voice, members: listed?.members?.map((/** @type {any} */ member) => [member.key, member.value, member.words, member.menu]) ?? listed ?? null }));
  assert.equal(ready.voice.words, 'Parakeet');
  assert.ok(ready.voice.choices.some((/** @type {any} */ choice) => choice.words === 'Parakeet' && choice.sent === false), JSON.stringify(ready.voice.choices));
});

test('7: each photo\'s facts line, the server\'s words: when its EXIF says it was taken, at the offset it states, else in the home\'s zone, and where, the point hidden as every place is; none for a photo whose EXIF states no time; the model\'s images hold no EXIF', async () => {
  named('facts');
  const files = await uploaded([exifJpeg('2026:10:23 09:59:07', '+05:30', [10.5, 20.25]), exifJpeg('2026:10:23 09:59:07'), jpeg('a synthetic photo whose EXIF states nothing')]);
  await command({ cmd: 'privacy', chat: 'all' });
  try {
    /** @type {any} */
    let seen = null;
    faux.setResponses([
      context => {
        seen = context.messages.at(-1);
        return fauxAssistantMessage('A synthetic answer about three photos.');
      },
      fauxAssistantMessage('Three photos'),
    ]);
    const turn = await asking({ question: 'Where were these taken?', photos: files });
    assert.equal(turn.events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(turn.events));
    const [words, ...images] = seen.content;
    note({ said: words.text.slice(words.text.indexOf('Where were these taken?')) });
    assert.match(words.text, /Where were these taken\?\n\[Photo 1: taken 23 Oct 2026 09:59 at \[\[Place \d+\]\]\]\n\[Photo 2: taken 23 Oct 2026 09:59\]$/u);
    assert.equal(/Photo 3|10\.5|20\.25/u.test(words.text), false, words.text);
    assert.equal(images.length, 3);
    for (const image of images) assert.equal(Buffer.from(image.data, 'base64').includes('Exif'), false, 'the made photo holds no EXIF');
  } finally {
    await command({ cmd: 'privacy', chat: 'none' });
  }
});

test('8: a replay while its turn still runs is answered by that turn: its `chat`, then its events to its end; the model asked once', async () => {
  named('replay running');
  /** @type {() => void} */
  let open = () => undefined;
  const gate = new Promise(done => { open = () => done(undefined); });
  let asked = 0;
  faux.setResponses([
    async () => {
      asked++;
      await gate;
      return fauxAssistantMessage('A synthetic answer, asked once.');
    },
    fauxAssistantMessage('Asked once'),
  ]);
  const calls = faux.state.callCount;
  const submission = minted();
  const first = asking({ submission, question: 'Was this asked once?' });
  await until('the model asked', () => asked === 1);
  /** @type {any[]} */
  const replayed = [];
  const again = asking({ submission, question: 'Was this asked once?' }, { seen: replayed });
  await until('the replay told its turn while it runs', () => replayed.some(event => event.type === 'chat'));
  open();
  const [one, two] = await Promise.all([first, again]);
  assert.deepEqual([two.events[0].chat, two.events[0].n], [one.events[0].chat, one.events[0].n]);
  assert.deepEqual(two.events, one.events);
  assert.deepEqual(two.events.map(event => event.type), ['chat', 'text', 'done', 'title']);
  await until('the title asked', () => faux.state.callCount === calls + 2);
  assert.equal(asked, 1);
});

test('9: a question with photos asked of a pick that takes none: refused in the pick\'s words before any `chat`, asking no model and moving to no other', async () => {
  named('no photos');
  const files = await uploaded([jpeg('a synthetic photo for a model that cannot see')]);
  const ready = /** @type {any} */ (await (await fetch(`${home.url}/v1/ask`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());
  const blind = ready.models.find((/** @type {any} */ model) => model.id === home.chat.local);
  assert.equal(blind?.photos_off, `${blind?.name} can't see photos.`, 'the photo button\'s answer: this model takes no photo, in the words the refusal says');
  const calls = faux.state.callCount;
  const turn = await asking({ question: 'What is in it?', photos: files, model: home.chat.local });
  assert.deepEqual(turn.events, [{ type: 'error', error: 'model', message: blind.photos_off }], JSON.stringify(turn.events));
  assert.equal(faux.state.callCount, calls, 'no model asked, the default neither');
});

test('10: a rebuilt context restates the earlier photos within what the model takes, its own photos counted first, and says the rest', async () => {
  named('rebuilt');
  const files = await uploaded([jpeg('the first earlier synthetic photo'), jpeg('the second earlier synthetic photo'), jpeg('the newest synthetic photo')]);
  faux.setResponses([fauxAssistantMessage('Two synthetic photos.'), fauxAssistantMessage('Two photos')]);
  const first = await asking({ question: 'What are these two?', photos: files.slice(0, 2) });
  const { chat } = first.events[0];
  /** @type {any[]} */
  let seen = [];
  faux.setResponses([context => {
    seen = context.messages;
    return fauxAssistantMessage('And a third.');
  }]);
  const next = await asking({ question: 'And this one?', photos: [files[2]], chat, model: home.chat.small });
  assert.equal(next.events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(next.events));
  const asked = seen.filter(message => message.role === 'user');
  const imagesOf = (/** @type {any} */ message) => Array.isArray(message.content) ? message.content.filter((/** @type {any} */ part) => part.type === 'image') : [];
  const textOf = (/** @type {any} */ message) => Array.isArray(message.content) ? message.content.filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join('') : message.content;
  note({ restated: asked.map(message => ({ text: textOf(message).slice(0, 200), images: imagesOf(message).length })) });
  assert.equal(asked.length, 2);
  assert.equal(imagesOf(asked[0]).length, 1);
  assert.equal(textOf(asked[0]).split(EARLIER_PHOTO).length - 1, 1, textOf(asked[0]));
  assert.equal(imagesOf(asked[1]).length, 1);
});

test('11: a server killed between its question\'s envelope and its seal\'s answer: its next start seals the question once, its photo with it, then lands its marker `failed` `restart`', async () => {
  named('killed at the seal');
  const own = await ownMachine('sealed');
  const [file] = await uploaded([jpeg('a synthetic photo sealed by a server that then died')]);
  let sealed = 0;
  /** @type {import('node:child_process').ChildProcess | null} */
  let running = null;
  const front = await frontDoor((request, status) => {
    if (request.method !== 'PUT' || request.url?.startsWith('/v1/acquisitions/') !== true || status !== 201) return false;
    sealed++;
    running?.kill('SIGKILL');
    return true;
  });
  const server = await serverChild(own, front, { ASK_ANSWER: 'Never said.' });
  running = server.child;
  try {
    await asking({ question: 'Is this ever answered?', photos: [file] }, { at: `${server.url}/ask` }).catch(() => null);
    assert.equal(await server.exited, 'SIGKILL');
    assert.equal(sealed, 1);
    const [envelope] = pendingIn(own);
    assert.ok(envelope !== undefined, 'the envelope stands');
    const { chat } = JSON.parse(readFileSync(join(pendingFolder(own), envelope), 'utf8')).turn;
    await ownServer(own);
    /** @type {any} */
    let marker = null;
    await until('the marker landed', async () => {
      marker = await kept(chat, 2);
      return marker.status === 200;
    });
    assert.deepEqual([marker.body.version.content.end, marker.body.version.content.failed], ['failed', 'restart']);
    assert.deepEqual((await kept(chat, 1)).body.version.content.photos, [file]);
    await until('the envelope let go', () => pendingIn(own).length === 0);
  } finally {
    server.child.kill('SIGKILL');
  }
});

test('12: a server killed mid-turn: its next start lands the turn\'s marker, `failed` `restart`, and the next question is numbered after it', async () => {
  named('killed mid-turn');
  const own = await ownMachine('mid-turn');
  const server = await serverChild(own, home.url, { ASK_HOLD: '1' });
  try {
    /** @type {any[]} */
    const told = [];
    void asking({ question: 'Is this answered before the kill?' }, { at: `${server.url}/ask`, seen: told }).catch(() => null);
    await until('the turn told its `chat`', () => told.some(event => event.type === 'chat'));
    const { chat, n } = told[0];
    assert.equal(n, 2);
    await until('the question landed', async () => (await kept(chat, 1)).status === 200);
    server.child.kill('SIGKILL');
    assert.equal(await server.exited, 'SIGKILL');
    assert.equal(pendingIn(own).length, 1, 'the envelope stands');
    const again = await ownServer(own);
    /** @type {any} */
    let marker = null;
    await until('the marker landed', async () => {
      marker = await kept(chat, 2);
      return marker.status === 200;
    });
    assert.deepEqual([marker.body.version.content.end, marker.body.version.content.failed], ['failed', 'restart']);
    faux.setResponses([fauxAssistantMessage('Answered after the restart.')]);
    const next = await asking({ question: 'And now?', chat }, { at: `${again}/ask` });
    assert.deepEqual([next.events[0].type, next.events[0].n], ['chat', 4], JSON.stringify(next.events));
    assert.equal(next.events.at(-1)?.message.end, 'done', JSON.stringify(next.events));
  } finally {
    server.child.kill('SIGKILL');
  }
});

async function erasedWhileAnswering() {
  const own = await ownMachine('erased');
  const doorway = await openDoorway(home.url);
  const at = await listen(createHandler({ door: doorway.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: own, now: homeClock }, log: () => undefined }));
  /** @type {() => void} */
  let open = () => undefined;
  const gate = new Promise(done => { open = () => done(undefined); });
  let answering = false;
  try {
    faux.setResponses([fauxAssistantMessage('A synthetic first answer.'), fauxAssistantMessage('Kept a while')]);
    const first = await asking({ question: 'Is this kept?' }, { at: `${at}/ask` });
    const { chat } = first.events[0];
    await until('the first turn landed and imported', async () => pendingIn(own).length === 0 && (await kept(chat, 1)).status === 200);
    doorway.state.stalled = '/v1/acquisitions/';
    faux.setResponses([async () => {
      answering = true;
      await gate;
      return fauxAssistantMessage('A synthetic answer never kept.');
    }]);
    const submission = minted();
    /** @type {any[]} */
    const seen = [];
    const pending = asking({ submission, question: 'And now?', chat }, { at: `${at}/ask`, seen });
    await until('the turn told its `chat`', () => seen.some(event => event.type === 'chat'));
    await until('its question held at the door', () => doorway.holding() > 0);
    await until('its model answering', () => answering);
    await command({ cmd: 'erase', key: `${chat}:0001` });
    doorway.unstall();
    const { events } = await pending;
    await until('the envelope let go', () => pendingIn(own).length === 0);
    return { events, chat, submission, at, own, close: () => doorway.close() };
  } finally {
    open();
    doorway.unstall();
  }
}

/**
 * @param {string} at
 * @param {string} chat
 */
async function chatAt(at, chat) {
  const response = await fetch(`${at}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
  return { status: response.status, body: /** @type {any} */ (await response.json()) };
}

test('13: a question pending while its conversation is erased, its model still answering: the door\'s 422 `CHAT_ERASED` ends the turn `erased` with no `done`, lets its envelope go whole, nothing of it landed; the server holds nothing of the conversation, its read 410 erased as a fresh server\'s is, its submission again is told erased', async () => {
  named('erased pending');
  const erased = await erasedWhileAnswering();
  try {
    const { events, chat, submission, at } = erased;
    assert.deepEqual(events.map(event => event.type), ['chat', 'error'], JSON.stringify(events));
    assert.deepEqual(events.at(-1), { type: 'error', error: 'erased', message: ERASED });
    assert.deepEqual([(await kept(chat, 3)).status, (await kept(chat, 4)).status], [404, 404]);
    const fresh = await ownServer(await ownMachine('erased-fresh'));
    assert.deepEqual(await chatAt(at, chat), { status: 410, body: { error: 'erased' } });
    assert.deepEqual(await chatAt(fresh, chat), { status: 410, body: { error: 'erased' } }, 'the door\'s key read, nothing kept on a server\'s disk');
    const again = await asking({ submission, question: 'And now?', chat }, { at: `${at}/ask` });
    assert.deepEqual(again.events, [{ type: 'error', error: 'erased', message: ERASED }]);
  } finally {
    await erased.close();
  }
});

test('14: Codex and Claude Code are handed the question\'s photos after its words, each the made JPEG', async () => {
  named('codex and claude');
  const machine = await plansOn({ codex: 'in', claude: 'in' });
  const codex = fakeCodex(machine);
  const claude = fakeClaude(machine);
  const handler = createHandler({ door: home.url, ask: askOn(machine, { door: home.url, now: homeClock, log: () => undefined }), log: () => undefined });
  const at = await listen(handler);
  try {
    const photos = [jpeg('a synthetic photo for ChatGPT'), jpeg('a synthetic photo for Claude')];
    const files = await uploaded(photos);
    await codex.script([[{ say: 'From ChatGPT.' }], [{ say: 'Synthetic' }]]);
    const viaCodex = await asking({ question: 'What is this?', photos: [files[0]], model: PLAN_ROWS.codex.listed }, { at: `${at}/ask` });
    assert.equal(viaCodex.events.find(event => event.type === 'done')?.message.text, 'From ChatGPT.', JSON.stringify(viaCodex.events));
    const started = (await codex.asked('turn/start')).find(params => JSON.stringify(params.input).includes('What is this?'));
    const [said, image, ...more] = started.input;
    assert.deepEqual([said.type, image.type, more.length], ['text', 'image', 0]);
    assert.ok(image.url.startsWith('data:image/jpeg;base64,'), image.url.slice(0, 40));
    assert.ok(Buffer.from(image.url.slice('data:image/jpeg;base64,'.length), 'base64').toString('latin1').includes(`made ${sha(/** @type {Buffer} */ (photos[0]))}`));
    await claude.script([[{ say: 'From Claude.' }]]);
    const viaClaude = await asking({ question: 'And this?', photos: [files[1]], model: PLAN_ROWS.claude.chat }, { at: `${at}/ask` });
    assert.equal(viaClaude.events.find(event => event.type === 'done')?.message.text, 'From Claude.', JSON.stringify(viaClaude.events));
    const heard = (await claude.seen()).find(line => typeof line.asked === 'string' && line.asked.includes('And this?'));
    note({ codex: started.input.map((/** @type {any} */ part) => part.type), claude: heard.images.map((/** @type {any} */ each) => each.media_type) });
    assert.equal(heard.images.length, 1);
    assert.equal(heard.images[0].media_type, 'image/jpeg');
    assert.ok(Buffer.from(heard.images[0].data, 'base64').toString('latin1').includes(`made ${sha(/** @type {Buffer} */ (photos[1]))}`));
  } finally {
    await handler.close(5_000);
    await plansOn({});
  }
});

/**
 * @param {string} at
 * @param {string} chat
 */
async function read(at, chat) {
  const response = await fetch(`${at}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
  return { status: response.status, refused: response.status === 200 ? null : /** @type {any} */ (await response.json()), events: /** @type {any[]} */ ([]), atChat: null };
}

/**
 * @param {Awaited<ReturnType<typeof asking>>} asked
 * @param {'sending' | 'named'} phase
 */
function outcomeOf(asked, phase) {
  if (asked.refused !== null) {
    if (asked.status !== 409) return { status: asked.status };
    const { missing } = asked.refused;
    return missing === undefined ? { status: 409, busy: true } : { status: 409, missing: Object.keys(missing).filter(name => missing[name].length > 0) };
  }
  const types = asked.events.filter(event => ['chat', 'text', 'done', 'error'].includes(event.type))
    .map(event => event.type === 'error' && event.error === 'erased' ? 'error:erased' : event.type)
    .filter((type, at, all) => type !== 'text' || all[at - 1] !== 'text');
  const named = types.indexOf('chat');
  return { events: phase === 'sending' ? types.slice(0, named + 1 || types.length) : types.slice(named + 1) };
}

test('15: every answer of the outcome table the server can give, given as the table names it: a question with files through its join and its seal', async () => {
  named('outcomes');
  const { cases } = JSON.parse(readFileSync(OUTCOMES, 'utf8'));
  /** @type {Record<string, unknown>} */
  const given = {};
  const absent = `sha256:${sha(jpeg(`never sent ${minted()}`))}`;
  const [file] = await uploaded([jpeg(`a synthetic photo the table is walked with ${minted()}`)]);
  faux.setResponses([fauxAssistantMessage('A synthetic walked answer.'), fauxAssistantMessage('Walked')]);
  const answered = await asking({ question: 'Is the table walked?', photos: [file] });
  given.named = outcomeOf(answered, 'sending');
  given.answered = outcomeOf(answered, 'named');
  given.missing = outcomeOf(await asking({ question: 'What is this?', photos: [absent] }), 'sending');
  given['shape refused'] = outcomeOf(await asking({ photos: [absent] }), 'sending');
  given['voice note gone'] = outcomeOf(await asking({ voice: { audio: `sha256:${sha(Buffer.from(`a note the home never held ${minted()}`))}` } }), 'sending');
  given['conversation unknown'] = outcomeOf(await asking({ question: 'Still there?', chat: '1792396847000-0a0a0a' }), 'sending');
  const unread = await ownMachine('unread');
  await writeFile(join(unread, 'ask', 'submitted.ndjson'), `${JSON.stringify({ submission: minted(), chat: '1792396847000-0c0c0c', n: 2, kept_ms: Date.now() })}\n`);
  given['not readable yet'] = outcomeOf(await read(await ownServer(unread), '1792396847000-0c0c0c'), 'named');
  /** @type {() => void} */
  let open = () => undefined;
  const gate = new Promise(done => { open = () => done(undefined); });
  faux.setResponses([async () => {
    await gate;
    return fauxAssistantMessage('A synthetic slow answer.');
  }, fauxAssistantMessage('Slow')]);
  /** @type {any[]} */
  const seen = [];
  const slow = asking({ question: 'Is this slow?' }, { seen });
  await until('the slow turn told its `chat`', () => seen.some(event => event.type === 'chat'));
  given['still answering'] = outcomeOf(await asking({ question: 'And now?', chat: seen[0].chat }), 'sending');
  open();
  await slow;
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'A synthetic failure.' })]);
  given['failed after it began'] = outcomeOf(await asking({ question: 'Does this fail?' }), 'named');
  const held = await modelsOf(home);
  const unkeyed = { ...held, models: { ...held.models, [home.chat.cloud]: { ...held.models[home.chat.cloud], state: 'unavailable', line: 'Add the key for OpenRouter' } } };
  const keyless = await frontDoor(request => request.method === 'GET' && request.url?.startsWith('/v1/models') === true ? { status: 200, body: unkeyed } : false);
  const refusing = await ownServer(await ownMachine('keyless'), () => undefined, keyless);
  given['refused before it began'] = outcomeOf(await asking({ question: 'Who answers?' }, { at: `${refusing}/ask` }), 'sending');
  let lose = true;
  const losing = await frontDoor((request, status) => {
    if (!lose || request.method !== 'PUT' || request.url?.startsWith('/v1/acquisitions/') !== true || status !== 201) return false;
    lose = false;
    return { status: 503, body: { code: 'SYNTHETIC', message: 'Synthetic: the seal\'s answer was lost.' } };
  });
  const away = await ownMachine('away');
  const [awayFile] = await uploaded([jpeg(`a synthetic photo whose seal's answer is lost ${minted()}`)]);
  given['home away'] = outcomeOf(await asking({ question: 'Anyone home?', photos: [awayFile] }, { at: `${await ownServer(away, () => undefined, losing)}/ask` }), 'sending');
  assert.equal(pendingIn(away).length, 1, 'the envelope kept on an end unknown');
  const closing = createHandler({ door: home.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: await ownMachine('closing'), now: homeClock }, log: () => undefined });
  const closed = await listen(closing);
  await closing.close(0);
  assert.deepEqual(outcomeOf(await asking({ question: 'Anyone home?' }, { at: `${closed}/ask` }), 'sending'), given['home away'], 'a server closing answers as the seal\'s end unknown');
  faux.setResponses([fauxAssistantMessage('A synthetic answer before the erasure.'), fauxAssistantMessage('Before')]);
  const { chat: doomed } = (await asking({ question: 'Is this erased next?' })).events[0];
  await until('the question landed', async () => (await kept(doomed, 1)).status === 200);
  let erasing = true;
  const eraser = await frontDoor(() => false, async request => {
    if (erasing && request.method === 'PUT' && request.url?.startsWith('/v1/acquisitions/') === true) {
      erasing = false;
      await command({ cmd: 'erase', key: `${doomed}:0001` });
    }
    return null;
  });
  const [doomedFile] = await uploaded([jpeg(`a synthetic photo of a conversation erased at its seal ${minted()}`)]);
  given['conversation erased'] = outcomeOf(await asking({ question: 'And this photo?', photos: [doomedFile], chat: doomed }, { at: `${await ownServer(await ownMachine('sealed-erased'), () => undefined, eraser)}/ask` }), 'sending');
  assert.equal(erasing, false, 'refused by the seal, not the read before it');
  assert.deepEqual(outcomeOf(await asking({ question: 'Anything left?', chat: doomed }), 'sending'), given['conversation erased'], 'and by the read once erased');
  const erased = await erasedWhileAnswering();
  try {
    given['erased while answering'] = outcomeOf({ status: 200, refused: null, events: erased.events, atChat: null }, 'named');
    given['erased before it began'] = outcomeOf(await asking({ submission: erased.submission, question: 'And now?', chat: erased.chat }, { at: `${erased.at}/ask` }), 'sending');
    given['conversation erased while answering'] = outcomeOf(await read(`${home.url}/v1`, erased.chat), 'named');
  } finally {
    await erased.close();
  }
  note({ outcomes: given });
  const ofDevices = ['photo refused', 'photo stage full', 'no answer', 'ended before any event', 'lost while answering'];
  const table = Object.fromEntries(cases.filter((/** @type {any} */ each) => !ofDevices.includes(each.name)).map((/** @type {any} */ each) => {
    const { missing, ...answer } = each.answer;
    const said = /** @type {any} */ (given[each.name]);
    return [each.name, missing === undefined ? answer : { ...answer, missing: said?.missing?.every((/** @type {string} */ name) => missing.includes(name)) ? said.missing : missing }];
  }));
  assert.deepEqual(given, table);
});

/**
 * @param {string} name
 * @param {string} at
 */
async function askedTwice(name, at) {
  const [file] = await uploaded([jpeg(`a synthetic photo whose seal ends unknown: ${name} ${minted()}`)]);
  const body = { submission: minted(), question: `Is this resumed (${name})?`, photos: [file] };
  const first = await asking(body, { at: `${at}/ask` });
  faux.setResponses([fauxAssistantMessage('A synthetic resumed answer.'), fauxAssistantMessage('Resumed')]);
  return { file, first, again: await asking(body, { at: `${at}/ask` }) };
}

test('20: Send is resumable: a seal answered 503 once, or not answered past its deadline, fails no turn and lands no marker; the same submission again resumes from the seal, says `chat` and runs the turn, its question landed with its photo', async () => {
  named('send resumable');
  let refuse = true;
  const refusing = await frontDoor(() => false, async request => {
    if (!refuse || request.method !== 'PUT' || request.url?.startsWith('/v1/acquisitions/') !== true) return null;
    refuse = false;
    return { status: 503, body: { code: 'NOT_NOW', message: 'Synthetic: the door is busy.' } };
  });
  /** @type {() => void} */
  let release = () => undefined;
  const late = new Promise(done => { release = () => done(undefined); });
  let hold = true;
  const silent = await frontDoor(() => false, async request => {
    if (!hold || request.method !== 'PUT' || request.url?.startsWith('/v1/acquisitions/') !== true) return null;
    hold = false;
    await late;
    return { status: 503, body: { code: 'NOT_NOW', message: 'Synthetic: an answer past the deadline.' } };
  });
  const own = await ownMachine('silent');
  const silentServer = await listen(createHandler({ door: silent, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: own, now: homeClock, putMs: 2_000 }, log: () => undefined }));
  /** @type {Record<string, unknown>} */
  const given = {};
  for (const [name, at] of /** @type {const} */ ([['answered 503', await ownServer(await ownMachine('refused-once'), () => undefined, refusing)], ['no answer', silentServer]])) {
    const { file, first, again } = await askedTwice(name, at);
    release();
    assert.equal(first.status, 503, `${name}: ${JSON.stringify(first)}`);
    assert.deepEqual([outcomeOf(again, 'sending'), outcomeOf(again, 'named')], [{ events: ['chat'] }, { events: ['text', 'done'] }], `${name}: ${JSON.stringify(again.events)}`);
    const done = again.events.find(event => event.type === 'done');
    assert.deepEqual([done.message.end, done.message.text], ['done', 'A synthetic resumed answer.']);
    const { chat, n } = again.events[0];
    await until(`${name}: the answer landed`, async () => (await kept(chat, n)).status === 200);
    assert.equal((await kept(chat, n)).body.version.content.end, 'done');
    assert.deepEqual((await kept(chat, n - 1)).body.version.content.photos, [file]);
    given[name] = { first: first.status, again: again.events.map(event => event.type) };
  }
  note({ resumed: given });
});

test('21: a note\'s words refused 409 `CHAT_ERASED` for a conversation the door\'s erased route says is not erased erase nothing: the turn fails as the door\'s failure and the conversation still reads', async () => {
  named('words not erased');
  const voiceNote = randomBytes(16).toString('hex');
  assert.equal((await door('POST', `/v1/ask/notes/${voiceNote}`)).status, 200);
  assert.equal((await door('PUT', `/v1/ask/notes/${voiceNote}/0`, Buffer.alloc(32_000, 7))).status, 200);
  const front = await frontDoor(request => request.method === 'POST' && request.url === '/v1/ask/words'
    ? { status: 409, body: { code: 'CHAT_ERASED', message: 'Synthetic: no lane holds this audio.' } } : false);
  const at = await ownServer(await ownMachine('words-erased'), () => undefined, front);
  const asked = await asking({ voice: { note: voiceNote, seconds: 1 } }, { at: `${at}/ask` });
  assert.deepEqual(outcomeOf(asked, 'named'), { events: ['error', 'done'] }, JSON.stringify(asked.events));
  assert.equal(asked.events.find(event => event.type === 'error')?.error, 'door');
  const { chat } = asked.events[0];
  assert.equal((await read(at, chat)).status, 200);
});

test('22: the door\'s 422 at the seal is a refusal before the turn began, never the question\'s shape', async () => {
  named('seal 422');
  const front = await frontDoor(() => false, async request => request.method === 'PUT' && request.url?.startsWith('/v1/acquisitions/') === true
    ? { status: 422, body: { code: 'STATEMENTS_BAD', message: 'Synthetic: the door cannot read these statements.' } } : null);
  const own = await ownMachine('seal-422');
  const [file] = await uploaded([jpeg(`a synthetic photo whose seal is refused 422 ${minted()}`)]);
  const asked = await asking({ question: 'Is this refused?', photos: [file] }, { at: `${await ownServer(own, () => undefined, front)}/ask` });
  assert.deepEqual(outcomeOf(asked, 'sending'), { events: ['error'] }, JSON.stringify(asked));
  assert.equal(pendingIn(own).length, 0);
});

test('16: a turn delivered whose answer neither the home nor this server holds yet: its replay is 503, asked again, never told erased', async () => {
  named('delivered unread');
  const own = await ownMachine('delivered');
  const submission = minted();
  await writeFile(join(own, 'ask', 'submitted.ndjson'), `${JSON.stringify({ submission, chat: '1792396847000-0b0b0b', n: 2, kept_ms: Date.now() })}\n`);
  const at = await ownServer(own);
  const replayed = await asking({ submission, question: 'Was this answered?' }, { at: `${at}/ask` });
  assert.equal(replayed.status, 503, JSON.stringify(replayed));
  assert.match(replayed.refused.error, /still saving this answer/u);
});

test('17: a voice question whose words failed is read from the home after its turn: the words it wrote out since', async () => {
  named('words from the home');
  const voiceNote = randomBytes(16).toString('hex');
  assert.equal((await door('POST', `/v1/ask/notes/${voiceNote}`)).status, 200);
  assert.equal((await door('PUT', `/v1/ask/notes/${voiceNote}/0`, Buffer.alloc(32_000, 7))).status, 200);
  const front = await frontDoor(request => request.method === 'POST' && request.url === '/v1/ask/words'
    ? { status: 503, body: { code: 'SYNTHETIC', message: 'Synthetic: the words did not come back.' } } : false);
  const at = await ownServer(await ownMachine('words'), () => undefined, front);
  const asked = await asking({ voice: { note: voiceNote, seconds: 1 } }, { at: `${at}/ask` });
  const done = asked.events.find(event => event.type === 'done');
  assert.equal(done?.message.end, 'failed', JSON.stringify(asked.events));
  const { chat, n } = asked.events[0];
  /** @type {any} */
  let voice = null;
  await until(() => `the words read from the home: ${JSON.stringify(voice)}`, async () => {
    voice = (await chatAt(at, chat)).body.messages?.find((/** @type {any} */ message) => message.n === n - 1)?.voice;
    return typeof voice?.words === 'string' && voice.words !== '';
  });
  assert.equal(voice.failed, undefined);
});

test('18: a rebuilt context after a restart restates an earlier photo with its facts line, read from the home, its point a placeholder under Hide all', async () => {
  named('facts rebuilt');
  const [file] = await uploaded([exifJpeg('2026:10:23 09:59:07', '+05:30', [10.5, 20.25])]);
  await command({ cmd: 'privacy', chat: 'all' });
  try {
    faux.setResponses([fauxAssistantMessage('A synthetic answer about one photo.'), fauxAssistantMessage('One photo')]);
    const first = await asking({ question: 'What is this?', photos: [file] });
    assert.equal(first.events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(first.events));
    const { chat } = first.events[0];
    await until('the question landed', async () => (await kept(chat, 1)).status === 200);
    const again = await ownServer(await ownMachine('facts'));
    /** @type {any[]} */
    let seen = [];
    faux.setResponses([context => {
      seen = context.messages;
      return fauxAssistantMessage('Where the facts line says.');
    }]);
    const next = await asking({ question: 'Where did I take that?', chat }, { at: `${again}/ask` });
    assert.equal(next.events.find(event => event.type === 'done')?.message.end, 'done', JSON.stringify(next.events));
    const [earlier] = seen.filter(message => message.role === 'user');
    const text = Array.isArray(earlier.content) ? earlier.content.filter((/** @type {any} */ part) => part.type === 'text').map((/** @type {any} */ part) => part.text).join('') : earlier.content;
    note({ restated: text });
    assert.match(text, /What is this\?\n\[Photo 1: taken 23 Oct 2026 09:59 at \[\[Place \d+\]\]\]/u);
    assert.equal(/10\.5|20\.25/u.test(JSON.stringify(seen)), false, 'the point is hidden');
  } finally {
    await command({ cmd: 'privacy', chat: 'none' });
  }
});

test('19: a question the door can never read (422 `STATEMENTS_BAD`) ends its running turn at once, `failed` `door` in its own words, its answer kept nowhere; the conversation is unknown after', async () => {
  named('unreadable');
  let refused = false;
  const front = await frontDoor(() => false, request => {
    if (request.method !== 'PUT' || request.url?.startsWith('/v1/acquisitions/') !== true) return null;
    refused = true;
    return { status: 422, body: { code: 'STATEMENTS_BAD', message: 'A synthetic bundle the home can never read.' } };
  });
  const own = await ownMachine('unreadable');
  const at = await ownServer(own, () => undefined, front);
  /** @type {() => void} */
  let open = () => undefined;
  const gate = new Promise(done => { open = () => done(undefined); });
  faux.setResponses([async () => {
    await gate;
    return fauxAssistantMessage('A synthetic answer never kept.');
  }]);
  const pending = asking({ question: 'Is this ever kept?' }, { at: `${at}/ask` });
  try {
    await until('the question refused', () => refused);
  } finally {
    open();
  }
  const { events } = await pending;
  assert.deepEqual(events.map(event => event.type).filter(type => type !== 'text'), ['chat', 'error', 'done'], JSON.stringify(events));
  const error = events.find(event => event.type === 'error');
  assert.equal(error.error, 'door');
  assert.match(error.message, /couldn't keep this question/u);
  const { message } = events.at(-1);
  assert.deepEqual([message.end, message.failed, message.error], ['failed', 'door', error.message]);
  assert.deepEqual(pendingIn(own), []);
  assert.equal((await read(at, events[0].chat)).status, 404);
});

/**
 * @param {string} text
 * @param {import('../lib/ask/seen.mjs').Span[]} spans
 * @param {string} from
 * @param {string} to
 */
function swapped(text, spans, from, to) {
  const at = text.indexOf(from);
  const shift = to.length - from.length;
  const moved = (/** @type {number} */ offset) => offset >= at + from.length ? offset + shift : offset;
  return spans.map(span => ({ ...span, start: moved(span.start), end: moved(span.end) }));
}

/** @param {Buffer} photo */
async function seenBy(photo) {
  await command({ cmd: 'engine', found: { [sha(photo)]: FACE } });
  return (await uploaded([photo]))[0];
}

/** @param {any} context */
const imagesOf = context => /** @type {any[]} */ (context.messages.at(-1).content).filter(part => part.type === 'image');

/** @param {string} file */
const pictureOf = async file => (await fetch(`${home.url}/v1/pictures/${file}?size=tile`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).status;

test('23: the privacy view\'s journey: a name typed, a photo with a face, an answer that writes the placeholder; the answer read back from the home holds what the model read and wrote, the journey case of design/privacy-view.json but for the photo, the covered picture the model got, which the home serves', async () => {
  named('privacy view journey');
  const journey = /** @type {(typeof PRIVACY_VIEW.turns)[number]} */ (PRIVACY_VIEW.turns[0]);
  const words = journey.words.replace('Maya', TYPED);
  const photo = exifJpeg('2026:11:03 14:02:00', '+00:00', [10.5, 20.25]);
  const file = await seenBy(photo);
  await command({ cmd: 'privacy', chat: 'all' });
  try {
    /** @type {any} */
    let asked = null;
    faux.setResponses([
      context => {
        asked = context.messages.at(-1);
        return fauxAssistantMessage(journey.model.answered);
      },
      fauxAssistantMessage('Who is here'),
    ]);
    const turn = await asking({ question: words, photos: [file] });
    const done = turn.events.find(event => event.type === 'done')?.message;
    assert.equal(done?.end, 'done', JSON.stringify(turn.events));
    const sent = asked.content.find((/** @type {any} */ part) => part.type === 'text').text;
    assert.equal(sent.slice(sent.indexOf("Who's with me")), journey.model.asked, 'the model read the fixture\'s question');
    const [image] = imagesOf({ messages: [asked] });
    const covered = `sha256:${sha(Buffer.from(image.data, 'base64'))}`;
    const { chat } = turn.events[0];
    await until('the answer landed', async () => (await kept(chat, 2)).status === 200);
    const fresh = await ownServer(await ownMachine('privacy-view'));
    const read = /** @type {any} */ (await (await fetch(`${fresh}/ask/chats/${chat}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } })).json());
    const answer = read.messages.find((/** @type {any} */ message) => message.role === 'assistant');
    const shown = answer.text;
    note({ seen: answer.seen, text: shown });
    assert.deepEqual(answer.seen, {
      asked: swapped(journey.words, journey.seen.asked, 'Maya', TYPED),
      answered: swapped(journey.answer, journey.seen.answered, 'Maya Iyer', shown.slice(7, shown.indexOf(' on the left.'))),
      photos: [covered],
    });
    assert.equal(modelText(words, answer.seen.asked), journey.model.asked);
    assert.equal(modelText(shown, answer.seen.answered), journey.model.answered);
    assert.notEqual(covered, file, 'the picture the model got is not the photo');
    assert.equal(await pictureOf(covered), 200, 'the home serves the covered picture');
    assert.deepEqual(done.seen, answer.seen, '`done` carries the record the home stores');
  } finally {
    await command({ cmd: 'privacy', chat: 'none' });
    await command({ cmd: 'engine', found: {} });
  }
});

test('24: no record where nothing was hidden: hiding off and no face, a typed question and its answer carry no `seen`', async () => {
  named('privacy view none');
  faux.setResponses([fauxAssistantMessage('A synthetic answer naming nobody.'), fauxAssistantMessage('Nothing hidden')]);
  const turn = await asking({ question: 'What did I do on the synthetic Sunday?' });
  const done = turn.events.find(event => event.type === 'done')?.message;
  assert.equal(done?.end, 'done', JSON.stringify(turn.events));
  assert.equal('seen' in done, false);
  const { chat } = turn.events[0];
  await until('the answer landed', async () => (await kept(chat, 2)).status === 200);
  assert.equal('seen' in (await kept(chat, 2)).body.version.content, false);
});

test('25: a turn that keeps no answer leaves no picture on the home: one whose model failed and one stopped before a word stage nothing; one whose conversation the home erased while it answered is dropped once the home refuses its answer', async () => {
  named('privacy view nothing staged');
  await command({ cmd: 'privacy', chat: 'all' });
  try {
    const failing = await seenBy(exifJpeg('2026:11:03 14:05:00', '+00:00', [10.5, 20.25]));
    /** @type {{ file?: string }} */
    const failed = {};
    faux.setResponses([context => {
      failed.file = `sha256:${sha(Buffer.from(imagesOf(context)[0].data, 'base64'))}`;
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'A synthetic failure.' });
    }]);
    const turn = await asking({ question: 'Who is this?', photos: [failing] });
    const failedDone = turn.events.find(event => event.type === 'done')?.message;
    assert.equal(failedDone?.end, 'failed', JSON.stringify(turn.events));
    assert.equal('seen' in failedDone, false);
    assert.notEqual(failed.file, undefined);
    assert.equal(await pictureOf(/** @type {string} */ (failed.file)), 404, 'the failed turn staged nothing');

    const stopping = await seenBy(exifJpeg('2026:11:03 14:04:00', '+00:00', [10.5, 20.25]));
    /** @type {() => void} */
    let unstop = () => undefined;
    const stopGate = new Promise(done => { unstop = () => done(undefined); });
    /** @type {{ file?: string }} */
    const stopped = {};
    faux.setResponses([async context => {
      stopped.file = `sha256:${sha(Buffer.from(imagesOf(context)[0].data, 'base64'))}`;
      await stopGate;
      return fauxAssistantMessage('Never read.');
    }]);
    /** @type {any[]} */
    const heard = [];
    const running = asking({ question: 'Who is here?', photos: [stopping] }, { seen: heard });
    try {
      await until('the model answering', () => stopped.file !== undefined);
      const stop = await fetch(`${home.url}/v1/ask/stop`, { method: 'POST', body: JSON.stringify({ chat: heard[0].chat }), headers: { authorization: `Bearer ${home.tokens.reader}`, 'content-type': 'application/json' } });
      assert.equal(stop.status, 200);
    } finally {
      unstop();
    }
    const stoppedDone = (await running).events.find(event => event.type === 'done')?.message;
    assert.equal(stoppedDone?.end, 'stopped', JSON.stringify(heard));
    assert.equal('seen' in stoppedDone, false);
    assert.equal(await pictureOf(/** @type {string} */ (stopped.file)), 404, 'the stopped turn staged nothing');

    const erasing = await seenBy(exifJpeg('2026:11:03 14:03:00', '+00:00', [10.5, 20.25]));
    /** @type {() => void} */
    let open = () => undefined;
    const gate = new Promise(done => { open = () => done(undefined); });
    /** @type {{ file?: string }} */
    const erased = {};
    faux.setResponses([async context => {
      erased.file = `sha256:${sha(Buffer.from(imagesOf(context)[0].data, 'base64'))}`;
      await gate;
      return fauxAssistantMessage('A synthetic answer never kept.');
    }]);
    /** @type {any[]} */
    const seen = [];
    const pending = asking({ question: 'And who is this?', photos: [erasing] }, { seen });
    try {
      await until('the model answering', () => erased.file !== undefined);
      const { chat } = seen[0];
      await until('the question landed', async () => (await kept(chat, 1)).status === 200);
      await command({ cmd: 'erase', key: `${chat}:0001` });
    } finally {
      open();
    }
    await pending;
    await until('the erased turn\'s picture dropped once the home refused its answer', async () => await pictureOf(/** @type {string} */ (erased.file)) === 404);
  } finally {
    await command({ cmd: 'privacy', chat: 'none' });
    await command({ cmd: 'engine', found: {} });
  }
});
