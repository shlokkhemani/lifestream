// @ts-check
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { createHandler } from '../server.mjs';
import { asked, home, keyed, named, note, startHome, stopHome } from './asking.mjs';
import { until } from './until.mjs';

const ARTIFACT = fileURLToPath(new URL('../.build/e2e/voice-cite.json', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../homelink/Tests/Fixtures/ask-voice-cite.json', import.meta.url));
const WRITE = process.env.LIFESTREAM_FIXTURES === 'write';
const FIXED_CHAT = '1792396847000-3fa9c2';
const [HEARD_BYTES, RECORDED_BYTES] = ['whatsapp.ogg', 'iphone.m4a'].map(name => readFileSync(new URL(`../../packages/core/test/audio/${name}`, import.meta.url)));
/** @param {Buffer} bytes */
const audioOf = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const [HEARD, RECORDED] = [audioOf(HEARD_BYTES), audioOf(RECORDED_BYTES)];
const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
const models = createModels();
models.setProvider(faux.provider);
/** @type {import('node:http').RequestListener} */
let serve = (_, response) => void response.writeHead(503).end();
/** @type {import('node:http').Server | undefined} */
let server;

/** @param {any} context @param {string} name */
const toolSaid = (context, name) => context.messages.filter((/** @type {any} */ message) => message.role === 'toolResult' && message.toolName === name)
  .map((/** @type {any} */ message) => message.content.map((/** @type {any} */ part) => part.text).join(''));

/** @param {string} path */
async function door(path) {
  const response = await fetch(`${home.url}${path}`, { headers: { authorization: `Bearer ${home.tokens.reader}` } });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

/** @param {string} path */
async function doorJson(path) {
  const { status, bytes } = await door(path);
  return { status, body: /** @type {any} */ (bytes.length === 0 ? null : JSON.parse(bytes.toString('utf8'))) };
}

/**
 * @param {any[]} events
 * @param {any} conversation
 * @param {string} chat
 */
function stable(events, conversation, chat) {
  /** @type {any[]} */
  const lines = [];
  for (const event of events) {
    const last = lines.at(-1);
    if (event.type === 'text' && last?.type === 'text') last.delta += event.delta;
    else lines.push(event.type === 'text' ? { ...event } : event);
  }
  const text = JSON.stringify({ lines, conversation }, (key, value) => (['ms', 'thought_ms'].includes(key) && typeof value === 'number' ? 0 : value), 1)
    .replaceAll(chat, FIXED_CHAT);
  return `${text}\n`;
}

/** @param {string} written */
function skeleton(written) {
  const { lines, conversation } = JSON.parse(written);
  const answer = lines.find((/** @type {any} */ line) => line.type === 'done').message;
  /** @param {Record<string, any>} refs */
  const voices = refs => Object.fromEntries(Object.entries(refs).map(([handle, cited]) => [handle, { kind: cited.kind, voice: cited.voice }]));
  return {
    types: lines.map((/** @type {any} */ line) => line.type), text: answer.text, refs: voices(answer.refs),
    kept: conversation.messages.map((/** @type {any} */ message) => [message.role, message.refs === undefined ? null : voices(message.refs)]),
  };
}

before(async () => {
  server = createServer((request, response) => serve(request, response));
  await new Promise(done => /** @type {import('node:http').Server} */ (server).listen(0, '127.0.0.1', () => done(undefined)));
  await startHome(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`, { LIFESTREAM_MCP_MEDIA: '1', LIFESTREAM_MCP_VOICE: '1' });
  await keyed('sk-or-v1-synthetic');
  serve = createHandler({ door: home.url, ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: home.ask.machine, now: () => home.now_ms }, log: () => undefined });
});

after(async () => {
  server?.closeAllConnections();
  await new Promise(done => server ? server.close(() => done(undefined)) : done(undefined));
  await stopHome(ARTIFACT);
});

test('the journey: a WhatsApp voice note and an iPhone recording, read into the home, cited by Chat with `voice`; each told so, described so again by its own record, its bytes served, and the answer kept in the home with its `voice`', async () => {
  named('journey');
  const window = /** @type {{ from: string, to: string }} */ (/** @type {any} */ (home).voice);
  /** @type {{ text: string, notes: any[] }} */
  const read = { text: '', notes: [] };
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('read', window)], { stopReason: 'toolUse' }),
    context => {
      read.text = toolSaid(context, 'read')[0] ?? '';
      read.notes = (JSON.parse(read.text || '{}').lines ?? []).filter((/** @type {any} */ line) => /voice note/iu.test(line.text ?? ''));
      const [said, recorded] = read.notes;
      return fauxAssistantMessage(fauxText(`Person A sent a voice note [${said?.ref}], and you recorded one after it [${recorded?.ref}].`));
    },
    fauxAssistantMessage('"Two voice notes."'),
  ]);
  const events = await asked(`${home.url}/v1`, { question: 'What did Person A say that evening, and what did I record?' });
  note({ read, events });
  assert.equal(read.notes.length, 2, `the read of the evening holds both notes: ${read.text}`);
  const done = events.find(event => event.type === 'done');
  assert.equal(done?.message.end, 'done', JSON.stringify(events));
  const { message } = done;
  const [said, recorded] = read.notes.map(line => /** @type {string} */ (line.ref));
  assert.deepEqual(Object.keys(message.refs).sort(), [said, recorded].sort());

  const told = events.filter(event => event.type === 'ref');
  assert.deepEqual(Object.fromEntries(told.map(event => [event.handle, event.cited])), message.refs, 'each cited note told once, as done keeps it');
  const [heard, own] = [message.refs[said], message.refs[recorded]];
  assert.deepEqual([heard.kind, own.kind], ['message', 'record'], 'the read gives a line with a record its record\'s ref: the WhatsApp note cited as its message, the recording as its record');
  assert.equal(typeof heard.voice?.from, 'string', JSON.stringify(heard));
  assert.equal(heard.voice.record, heard.ref, 'the cited message is the note\'s own record');
  assert.equal(own.voice?.record, own.ref, 'the cited recording is the note\'s own record');
  assert.deepEqual(heard.voice, { audio: HEARD, record: heard.ref, seconds: 3, from: heard.voice.from }, 'the WhatsApp note: its blob, its record, its stated seconds, who said it');
  assert.deepEqual(own.voice, { audio: RECORDED, record: own.ref, seconds: 3, mine: true }, 'the recording: its blob, its record, its rounded seconds, the person\'s own');

  const again = new URLSearchParams([heard.voice.record, own.voice.record].map(ref => /** @type {[string, string]} */ (['ref', ref])));
  const described = await doorJson(`/v1/describe?${again}`);
  assert.equal(described.status, 200, JSON.stringify(described.body));
  assert.deepEqual(described.body.described, [heard, own], 'a failed play describes each note\'s own record: the message and the recording again as the answer kept them, `voice` still');

  for (const [audio, bytes] of /** @type {const} */ ([[HEARD, HEARD_BYTES], [RECORDED, RECORDED_BYTES]])) {
    const blob = await door(`/v1/blobs/${audio}`);
    assert.equal(blob.status, 200, audio);
    assert.ok(blob.bytes.equals(bytes), `the home serves ${audio} as it keeps it`);
  }

  const source = /** @type {{ source: string }} */ (/** @type {unknown} */ (home.ask)).source;
  const key = `${message.chat}:${String(message.n).padStart(4, '0')}`;
  /** @type {any} */
  let record = null;
  await until('the answer kept in the home as an ask-home record', async () => {
    const kept = await doorJson(`/v1/record?source=${encodeURIComponent(source)}&kind=msg&key=${encodeURIComponent(key)}`);
    record = kept.body;
    return kept.status === 200;
  });
  assert.deepEqual(record.version.content.refs, message.refs, 'the kept answer\'s refs keep `voice`');
  const files = JSON.stringify(record.blobs ?? []);
  assert.ok(!files.includes(HEARD.slice(7)) && !files.includes(RECORDED.slice(7)), 'a cited note\'s audio is no file of the answer');

  const conversation = await doorJson(`/v1/ask/chats/${message.chat}`);
  assert.equal(conversation.status, 200, JSON.stringify(conversation.body));
  assert.deepEqual(conversation.body.messages.find((/** @type {any} */ each) => each.n === message.n)?.refs, message.refs);
  note({ kept: record.version.content, conversation: conversation.body });

  const written = stable(events, conversation.body, message.chat);
  if (WRITE) await writeFile(FIXTURE, written);
  assert.ok(existsSync(FIXTURE), 'homelink/Tests/Fixtures/ask-voice-cite.json is this turn: LIFESTREAM_FIXTURES=write writes it');
  assert.deepEqual(skeleton(readFileSync(FIXTURE, 'utf8')), skeleton(written),
    'homelink/Tests/Fixtures/ask-voice-cite.json is this turn as streamed and kept: LIFESTREAM_FIXTURES=write writes it');
});
