// @ts-check
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as ask } from 'node:http';
import { deflateSync } from 'node:zlib';
import { wavOf } from '../public/lib/ask-media.js';
import { askReady } from './stand-ins/ask-ready.mjs';
import { pageHarness } from './stand-ins/page-harness.mjs';
import { until } from './until.mjs';

const WINDOW = { width: 1440, height: 900 };
const KEPT = '1792396851000-7de3a6';
const MODELS = [
  { id: 'synthetic-terra', name: 'Synthetic Terra', thinking: ['low', 'high'], default: 'high', group: 'ChatGPT' },
  { id: 'synthetic-blind', name: 'Synthetic Blind', thinking: ['low'], default: 'low', group: 'ChatGPT', input: ['text'] },
];
const CAUTION = 'Voice notes go to Synthetic Cloud as they are: sound can’t be hidden.';
const NO_VOICE = 'Choose a model for Voice notes';
const WORDS = 'How far did I walk on the synthetic beach?';
const UNREADABLE = 'Lifestream can\'t read this picture.';
const REFUSED = 'Synthetic: the home couldn’t read your record for this question.';
const UNWRITTEN = 'Couldn’t write out your voice note: synthetic.';

/** @param {Buffer} bytes */
const named = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const CRCS = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** @param {Buffer} bytes */
const crcOf = bytes => (bytes.reduce((c, byte) => CRCS[(c ^ byte) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
/** @param {string} type @param {Buffer} data */
const chunkOf = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, 'ascii');
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crcOf(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, sum]);
};
/** @param {[number, number, number]} colour */
const pngOf = colour => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64);
  header.writeUInt32BE(48, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 64 }, () => colour).flat()]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunkOf('IHDR', header),
    chunkOf('IDAT', deflateSync(Buffer.concat(Array.from({ length: 48 }, () => row)))), chunkOf('IEND', Buffer.alloc(0))]);
};
const SEEN_PHOTO = pngOf([200, 136, 102]);
const SEEN_COVER = pngOf([60, 60, 60]);
const LOST_COVER = `sha256:${'e'.repeat(64)}`;
const SEEN_CHAT = '1792396852000-8ef4b7';
const LOST_CHAT = '1792396853000-9fa5c8';
const VOICED_CHAT = '1792396854000-0ab6d9';
const ERASED_AUDIO = `sha256:${'d'.repeat(64)}`;
const RENAMED_AUDIO = `sha256:${'c'.repeat(64)}`;
const QUESTION_AUDIO = `sha256:${'b'.repeat(64)}`;
const VOICED_ANSWER = 'Person A said it on the 4th [r1].\n\nThen a note that is gone [r2], and one whose day was printed again [r3].';
/**
 * @param {string} key
 * @param {string} audio
 * @param {number} seconds
 */
const citedNote = (key, audio, seconds) => ({ ref: `record.${key}`, kind: 'message', day: '2026-11-04', at: '2026-11-04T21:40+00:00',
  title: 'Person A', chat: 'chat.synthetic-a', chat_title: 'Person A',
  opens: { page: 'days', day: '2026-11-04', focus: `rec:whatsapp:local:phone-a message ${key}` },
  voice: { audio, record: `record.${key}`, seconds, from: 'Person A' } });
const SEEN_QUESTION = 'Who is with me here?';
const SEEN_ANSWER = 'That is Person B on the left.';
/**
 * @param {string} chat
 * @param {string} cover
 */
const coveredConversation = (chat, cover) => ({ chat, title: 'Synthetic cover', messages: [
  { chat, n: 1, at_ms: Date.parse('2026-10-20T10:00:00Z'), role: 'user', text: SEEN_QUESTION, photos: [named(SEEN_PHOTO)] },
  { chat, n: 2, at_ms: Date.parse('2026-10-20T10:00:05Z'), role: 'assistant', text: SEEN_ANSWER, end: 'done', ms: 5_000, steps: [],
    model: 'synthetic-terra', thinking: 'high',
    seen: { asked: [{ start: SEEN_QUESTION.length, end: SEEN_QUESTION.length, added: '\n[Photo 1: taken 3 Nov 2026 14:02]' }],
      answered: [{ start: 8, end: 16, placeholder: '[[Person 1]]' }], photos: [cover] } },
] });

/** @param {{ url: string }} home */
async function mediaHome(home) {
  const behind = new URL(home.url);
  /** @type {{ method: string, path: string, bytes: number }[]} */
  const staged = [];
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  const shown = new Map([[named(SEEN_PHOTO), SEEN_PHOTO], [named(SEEN_COVER), SEEN_COVER]]);
  /** @type {(() => void)[]} */
  const heldCovers = [];
  let holdCovers = false;
  /** @type {Record<string, any>[]} */
  const questions = [];
  /** @type {(() => void)[]} */
  const heldFiles = [];
  /** @type {(() => void)[]} */
  const heldAsks = [];
  /** @type {(() => void)[]} */
  const heldWords = [];
  /** @type {(() => void)[]} */
  const heldPrivacy = [];
  let holdFiles = false;
  let holdPrivacy = false;
  let holdAsk = false;
  let holdWords = false;
  /** @type {(() => void)[]} */
  const heldDescribes = [];
  let holdDescribes = false;
  /** @type {string[]} */
  const blobReads = [];
  let missingOnce = false;
  const scripted = /** @type {string[]} */ ([]);
  /** @type {(() => void)[]} */
  const heldSlow = [];
  /** @type {string[]} */
  const log = [];
  let cut = 0;
  /** @type {Set<string>} */
  const erased = new Set();
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  /** @type {Map<string, Record<string, any>[]>} */
  const conversations = new Map();
  /** @type {Map<string, { chat: string, n: number }>} */
  const submitted = new Map();
  let voiceReady = true;
  const keptAudio = wavOf([Buffer.alloc(32_000 * 3)]);
  const keptAudioName = named(Buffer.from(keptAudio));
  let keptPhoto = '';
  /** @type {Set<string>} */
  const unknown = new Set();
  /** @type {string[]} */
  const reads = [];
  let madeReads = 0;
  const sounds = new Map([[keptAudioName, Buffer.from(keptAudio)], [QUESTION_AUDIO, Buffer.from(keptAudio)]]);
  /** @type {string[][]} */
  const describes = [];
  /** @type {Record<string, unknown>} */
  const described = {
    'record.erased': { ref: 'record.erased', kind: 'gone', why: 'This was erased.' },
    'record.renamed': citedNote('renamed', keptAudioName, 3),
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '', 'http://door');
    /** @param {unknown} body @param {number} [status] */
    const send = (body, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/v1/feed') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 1000\n\n');
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      return;
    }
    const blob = /^\/v1\/(?:blobs|pictures)\/(sha256:[0-9a-f]{64})$/u.exec(url.pathname)?.[1];
    if (blob === LOST_COVER || blob === ERASED_AUDIO || blob === RENAMED_AUDIO) return send({ code: 'NOT_FOUND', message: 'No such blob.' }, 404);
    if (url.pathname === '/v1/describe') {
      const refs = url.searchParams.getAll('ref');
      describes.push(refs);
      const answer = () => send({ described: refs.flatMap(ref => described[ref] ? [described[ref]] : []) });
      return void (holdDescribes ? heldDescribes.push(answer) : answer());
    }
    const picture = blob ? shown.get(blob) : undefined;
    if (picture) {
      const answer = () => {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': picture.length });
        response.end(picture);
      };
      return void (blob === named(SEEN_COVER) && holdCovers ? heldCovers.push(answer) : answer());
    }
    if (blob && (blobs.has(blob) || sounds.has(blob))) {
      blobReads.push(url.pathname);
      const bytes = /** @type {Buffer} */ (sounds.get(blob) ?? blobs.get(blob));
      response.writeHead(200, { 'content-type': sounds.has(blob) ? 'audio/wav' : 'image/png', 'content-length': bytes.length });
      return void response.end(bytes);
    }
    if (url.pathname.startsWith('/v1/ask')) {
      /** @type {Buffer[]} */
      const parts = [];
      for await (const part of request) parts.push(part);
      const body = Buffer.concat(parts);
      if (url.pathname === '/v1/ask/files' || url.pathname.startsWith('/v1/ask/notes/')) {
        staged.push({ method: request.method ?? '', path: url.pathname, bytes: body.length });
        const answer = () => {
          if (url.pathname !== '/v1/ask/files') return send({});
          if (body.subarray(0, 3).toString() === 'BAD') return send({ code: 'PICTURE_UNREADABLE', message: UNREADABLE }, 422);
          const file = named(body);
          blobs.set(file, body);
          keptPhoto ||= file;
          send({ file, kind: 'photo', width: 64, height: 48 });
        };
        if (holdFiles && url.pathname === '/v1/ask/files') return void heldFiles.push(answer);
        return answer();
      }
      if (url.pathname === '/v1/ask' && request.method === 'POST') {
        const question = JSON.parse(body.toString('utf8'));
        questions.push(question);
        log.push(`ask ${question.submission}`);
        const answer = () => {
          if (erased.has(question.chat)) return send({ error: 'erased' }, 410);
          if (unknown.has(question.chat)) return send({ error: `No conversation ${question.chat}.` }, 404);
          if (missingOnce && question.photos) {
            missingOnce = false;
            return send({ error: 'Some files are missing.', missing: { photos: [question.photos[0]], seconds: [] } }, 409);
          }
          const how = scripted.shift() ?? 'answer';
          if (how === 'down') return send({ code: 'ASK_DOWN', error: 'Chat isn’t answering.' }, 503);
          if (how === 'missing-audio') {
            return send({ error: 'Some files are missing.', missing: { photos: [], seconds: [], audio: [question.voice.audio] } }, 409);
          }
          response.writeHead(200, { 'content-type': 'application/x-ndjson' });
          if (how === 'eof') return void response.end();
          /** @param {unknown} event */
          const event = event => response.write(`${JSON.stringify(event)}\n`);
          if (how === 'refused') {
            event({ type: 'error', error: 'model', message: REFUSED });
            return void response.end();
          }
          const known = submitted.get(question.submission);
          const chat = known?.chat ?? question.chat ?? `${1792396860000 + conversations.size}-9a${String(conversations.size).padStart(4, '0')}`;
          const messages = conversations.get(chat) ?? [];
          conversations.set(chat, messages);
          const n = known?.n ?? messages.length + 2;
          if (!known) {
            submitted.set(question.submission, { chat, n });
            const voice = question.voice?.note ? { audio: named(Buffer.from(question.voice.note)), ms: question.voice.seconds * 1000 }
              : question.voice?.audio ? { audio: question.voice.audio, ms: 3_000 } : undefined;
            if (voice) sounds.set(voice.audio, Buffer.from(keptAudio));
            messages.push({ chat, n: n - 1, at_ms: Date.now(), role: 'user', text: question.question ?? '',
              ...(question.photos ? { photos: question.photos } : {}), ...(voice ? { voice: { ...voice, words: WORDS } } : {}) });
          }
          const audio = messages.find(each => each.n === n - 1)?.voice?.audio;
          event({ type: 'chat', chat, n, ...(audio ? { audio } : {}) });
          if (how === 'erased') {
            event({ type: 'error', error: 'erased', message: 'This conversation was erased.' });
            return void response.end();
          }
          const kept = how === 'failed'
            ? { chat, n, at_ms: Date.now(), role: 'assistant', text: '', end: 'failed', failed: 'model', error: UNWRITTEN, steps: [] }
            : { chat, n, at_ms: Date.now(), role: 'assistant', text: 'On the synthetic beach.', end: 'done', ms: 900, steps: [],
              model: 'synthetic-terra', thinking: 'high' };
          if (!known && how !== 'slow') messages.push(kept);
          const end = () => {
            if (how === 'slow') log.push(`end ${question.submission}`);
            if (!known && how === 'slow') messages.push(kept);
            if (how === 'failed') event({ type: 'error', error: 'model', message: UNWRITTEN });
            else if (question.voice) event({ type: 'words', words: WORDS });
            event({ type: 'done', message: kept });
            response.end();
          };
          if (holdWords && question.voice) return void heldWords.push(end);
          if (how === 'slow') {
            response.on('close', () => {
              if (!response.writableEnded) cut += 1;
            });
            return void heldSlow.push(end);
          }
          end();
        };
        if (holdAsk) return void heldAsks.push(answer);
        return answer();
      }
      if (url.pathname === '/v1/ask') {
        return send({ ...askReady(MODELS),
          voice: voiceReady
            ? { ready: true, words: 'Synthetic Cloud · Sent as it is', line: null, caution: CAUTION, value: 'default',
              choices: [{ value: 'runner:macbook-pro-0001/parakeet', words: 'Parakeet · this Mac', sent: false },
                { value: 'synthetic-cloud', words: 'Synthetic Cloud · Sent as it is', sent: true }] }
            : { ready: false, words: 'Parakeet · this Mac', line: NO_VOICE, caution: null, value: 'default', choices: [] } });
      }
      if (url.pathname === '/v1/ask/chats') return send({ chats: [{ chat: KEPT, title: 'Synthetic beach', first_ms: 1, last_ms: 2, messages: 2 }] });
      const read = /^\/v1\/ask\/chats\/([^/]+)/u.exec(url.pathname)?.[1];
      if (read && erased.has(read)) return send({ error: 'erased' }, 410);
      if (read && unknown.has(read)) {
        reads.push(read);
        return send({ error: `No conversation ${read}.` }, 404);
      }
      const made = conversations.get(url.pathname.slice('/v1/ask/chats/'.length));
      if (made) {
        madeReads += 1;
        return send({ chat: made[0]?.chat, title: 'Synthetic question', messages: made });
      }
      if (url.pathname === `/v1/ask/chats/${SEEN_CHAT}`) return send(coveredConversation(SEEN_CHAT, named(SEEN_COVER)));
      if (url.pathname === `/v1/ask/chats/${LOST_CHAT}`) return send(coveredConversation(LOST_CHAT, LOST_COVER));
      if (url.pathname === `/v1/ask/chats/${VOICED_CHAT}`) {
        return send({ chat: VOICED_CHAT, title: 'Synthetic notes', messages: [
          { chat: VOICED_CHAT, n: 1, at_ms: Date.parse('2026-11-05T09:00:00Z'), role: 'user', text: '',
            voice: { audio: QUESTION_AUDIO, ms: 3_000, words: WORDS } },
          { chat: VOICED_CHAT, n: 2, at_ms: Date.parse('2026-11-05T09:00:05Z'), role: 'assistant', text: VOICED_ANSWER, end: 'done',
            ms: 5_000, steps: [], model: 'synthetic-terra', thinking: 'high',
            refs: { r1: citedNote('said', keptAudioName, 3), r2: citedNote('erased', ERASED_AUDIO, 23), r3: citedNote('renamed', RENAMED_AUDIO, 23) } },
        ] });
      }
      if (url.pathname === `/v1/ask/chats/${KEPT}`) {
        return send({ chat: KEPT, title: 'Synthetic beach', messages: [
          { chat: KEPT, n: 1, at_ms: Date.parse('2026-10-20T09:00:00Z'), role: 'user', text: '', photos: [keptPhoto, keptPhoto],
            voice: { audio: keptAudioName, ms: 3_000, words: WORDS } },
          { chat: KEPT, n: 2, at_ms: Date.parse('2026-10-20T09:00:05Z'), role: 'assistant', text: 'On the synthetic beach.', end: 'done',
            ms: 5_000, steps: [], model: 'synthetic-terra', thinking: 'high' },
        ] });
      }
      response.writeHead(204);
      return void response.end();
    }
    const pass = () => {
      const passed = ask({ host: behind.hostname, port: behind.port, path: request.url, method: request.method,
        headers: { ...request.headers, host: behind.host } }, answer => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      passed.on('error', () => response.destroy());
      request.pipe(passed);
    };
    if (holdPrivacy && url.pathname === '/v1/privacy') return void heldPrivacy.push(pass);
    pass();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    staged,
    blobs,
    blobReads,
    questions,
    /** @param {number} count */
    asked: count => until(`${count} questions at the stand-in`, () => questions.length >= count),
    /** @param {(each: { method: string, path: string, bytes: number }) => boolean} which @param {number} count */
    stagedAt: (which, count) => until(`${count} stage requests`, () => staged.filter(which).length >= count),
    /** @param {boolean} now */
    holdFiles: now => {
      holdFiles = now;
      if (!now) for (const answer of heldFiles.splice(0)) answer();
    },
    /** @param {boolean} now */
    holdCovers: now => {
      holdCovers = now;
      if (!now) for (const answer of heldCovers.splice(0)) answer();
    },
    heldCovers: () => heldCovers.length,
    /** @param {boolean} now */
    holdAsk: now => {
      holdAsk = now;
      if (!now) for (const answer of heldAsks.splice(0)) answer();
    },
    /** @param {boolean} now */
    holdWords: now => {
      holdWords = now;
      if (!now) for (const answer of heldWords.splice(0)) answer();
    },
    heldWords: () => heldWords.length,
    /** @param {boolean} now */
    holdPrivacy: now => {
      holdPrivacy = now;
      if (!now) for (const pass of heldPrivacy.splice(0)) pass();
    },
    log,
    cut: () => cut,
    release: () => {
      for (const answer of heldSlow.splice(0)) answer();
    },
    /** @param {string} chat */
    erase: chat => { erased.add(chat); },
    /** @param {string} chat @param {boolean} now */
    unknown: (chat, now) => { if (now) unknown.add(chat); else unknown.delete(chat); },
    /** @param {string} chat */
    unknownReads: chat => reads.filter(each => each === chat).length,
    madeReads: () => madeReads,
    breakFeed: () => {
      for (const feed of feeds) feed.destroy();
    },
    missingOnce: () => { missingOnce = true; },
    /** @param {string[]} hows */
    script: (...hows) => { scripted.push(...hows); },
    /** @param {boolean} now */
    voiceReady: now => { voiceReady = now; },
    keptAudioName,
    describes,
    /** @param {boolean} now */
    holdDescribes: now => {
      holdDescribes = now;
      if (!now) for (const answer of heldDescribes.splice(0)) answer();
    },
    heldDescribes: () => heldDescribes.length,
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}

const seen = { shots: /** @type {string[]} */ ([]), waiting: '', staged: /** @type {unknown[]} */ ([]), questions: /** @type {unknown[]} */ ([]) };
const page = pageHarness({ file: 'ask-media', seen, size: WINDOW, scrollbars: true, front: mediaHome,
  ending: () => ({ staged: front?.staged, questions: front?.questions }) });

/** @type {Awaited<ReturnType<typeof page.journey>>['chrome']} */
let chrome;
/** @type {Awaited<ReturnType<typeof mediaHome>>} */
let front;

before(async () => {
  await page.open();
  ({ chrome, front } = await page.journey('ask-media'));
});

afterEach(() => {
  assert.deepEqual(chrome?.thrown.splice(0), []);
});

after(() => page.close());

/**
 * @param {string} selector
 * @param {() => Promise<void>} [held]
 */
async function press(selector, held) {
  const [x, y] = await chrome.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length);
    const box = found[0].getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await held?.();
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function enter() {
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
    unmodifiedText: '\r' });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

/** @param {string} words */
async function type(words) {
  await chrome.evaluate(`document.querySelector('.ck-composer__input').focus()`);
  await chrome.send('Input.insertText', { text: words });
}

/** @param {string} files */
const drop = files => chrome.evaluate(`(() => {
  const transfer = new DataTransfer();
  for (const file of ${files}) transfer.items.add(file);
  const on = document.querySelector('.ak-stage');
  on.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  on.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
})()`);

const TONE = `navigator.mediaDevices.getUserMedia = async () => {
  const context = new AudioContext();
  const tone = context.createOscillator();
  tone.frequency.value = 330;
  const out = context.createMediaStreamDestination();
  tone.connect(out);
  tone.start();
  return out.stream;
}`;

/**
 * @param {string} method
 * @param {string} path
 * @param {number} count
 */
const DROP = (method, path, count) => `(() => {
  window.dropped ??= [];
  const real = window.realFetch ??= window.fetch;
  let left = ${count};
  window.fetch = (input, init = {}) => {
    if (left > 0 && (init.method ?? 'GET') === ${JSON.stringify(method)} && String(input).split('?')[0] === ${JSON.stringify(path)}) {
      left -= 1;
      window.dropped.push({ path: String(input), body: typeof init.body === 'string' ? init.body : null });
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return real(input, init);
  };
})()`;

/** @param {string[]} colours */
const make = colours => chrome.evaluate(`(async () => {
  const png = async colour => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const pen = canvas.getContext('2d');
    pen.fillStyle = colour;
    pen.fillRect(0, 0, 64, 48);
    return new Promise(done => canvas.toBlob(done, 'image/png'));
  };
  window.made = await Promise.all(${JSON.stringify(colours)}.map(async (colour, at) =>
    new File([await png(colour)], 'picture-' + at + '.png', { type: 'image/png', lastModified: 100 + at })));
})()`);

/** @param {number} [chunks] */
async function recordNote(chunks = 1) {
  const opened = front.staged.filter(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/')).length;
  const puts = front.staged.filter(PUTS).length;
  await press('.ck-composer__mic');
  await front.stagedAt(PUTS, puts + chunks);
  await press('[data-ask-action="rec-stop"]');
  return /** @type {string} */ (front.staged.filter(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/'))[opened]
    ?.path.split('/').at(-1));
}

const PLAYERS = `(() => {
  const Real = window.Audio;
  window.players = [];
  window.Audio = function (...args) {
    const made = new Real(...args);
    window.players.push(made);
    return made;
  };
})()`;

const LOOPING = `${PLAYERS};(() => {
  const Made = window.Audio;
  window.Audio = function (...args) {
    const made = Made(...args);
    made.loop = true;
    return made;
  };
})()`;

/** @param {string} bar */
const stateOf = bar => `document.querySelector(${JSON.stringify(bar)})?.dataset.voiceState`;

const chatShown = () => chrome.evaluate(`new URLSearchParams(location.hash.slice(1)).get('chat') ?? ''`);

const LAST = '.ck-ask-turn:last-child';
const PICTURES = '.ck-composer__pictures .ck-composer__picture';
const PUTS = (/** @type {{ method: string }} */ each) => each.method === 'PUT';

describe('ask-media: photos and voice notes in Chat on the Mac', () => {
  test('P1: a home that takes photos and voice notes draws the + slot and the mic; the + menu is Photos…, Files… ⌘O, Paste ⌘V; a press the level chip draws during still opens it', async () => {
    front.holdPrivacy(true);
    await chrome.load('#view=ask', PLAYERS);
    await chrome.until(`document.querySelector('.ck-composer__attach') !== null && document.querySelector('.ck-composer__mic') !== null`);
    await press('.ck-composer__attach .ck-fmenu__btn', async () => {
      front.holdPrivacy(false);
      await chrome.until(`document.querySelector('.ck-composer__tools .ck-level') !== null`);
    });
    await chrome.until(`document.querySelector('#ck-attach-menu')?.hidden === false`);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('#ck-attach-menu .ck-fmenu__item')]
      .map(each => each.textContent.replace(/\\s+/gu, ''))`), ['Photos…', 'Files…⌘O', 'Paste⌘V']);
    await page.shot('menu', `document.querySelector('#ck-attach-menu')?.hidden === false`);
    await press('.ck-composer__attach .ck-fmenu__btn');
    await chrome.until(`document.querySelector('#ck-attach-menu')?.hidden === true`);
  });

  test('P2: photos dropped upload at once, uploading then ready; one the home cannot read says so with its ×; the same file once', async () => {
    await chrome.evaluate(`(async () => {
      const png = async colour => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 48;
        const pen = canvas.getContext('2d');
        pen.fillStyle = colour;
        pen.fillRect(0, 0, 64, 48);
        return new Promise(done => canvas.toBlob(done, 'image/png'));
      };
      window.made = [new File([await png('#c86')], 'dune.png', { type: 'image/png', lastModified: 1 }),
        new File([await png('#68c')], 'sea.png', { type: 'image/png', lastModified: 2 }),
        new File(['BAD synthetic bytes'], 'broken.jpg', { type: 'image/jpeg', lastModified: 3 })];
    })()`);
    front.holdFiles(true);
    await drop('window.made');
    await front.stagedAt(each => each.path === '/v1/ask/files', 3);
    await chrome.until(`document.querySelectorAll('${PICTURES}.is-uploading').length === 3`);
    await page.shot('uploading', `document.querySelectorAll('${PICTURES}.is-uploading').length === 3`);
    front.holdFiles(false);
    await chrome.until(`document.querySelectorAll('${PICTURES}.is-failed').length === 1
      && document.querySelectorAll('${PICTURES}:not(.is-uploading):not(.is-failed)').length === 2`);
    assert.equal(await page.words('.ck-composer__said'), UNREADABLE);
    const sizes = await chrome.evaluate(`window.made.map(file => file.size)`);
    const bySize = (/** @type {number} */ one, /** @type {number} */ other) => one - other;
    assert.deepEqual(front.staged.filter(each => each.path === '/v1/ask/files').map(each => each.bytes).sort(bySize), sizes.sort(bySize));
    await page.shot('picked', `document.querySelectorAll('${PICTURES}').length === 3`);
    await drop('[window.made[0]]');
    assert.equal(await page.count(PICTURES), 3);
    await press(`${PICTURES}.is-failed .ck-composer__unpick`);
    await chrome.until(`document.querySelectorAll('${PICTURES}').length === 2 && !document.querySelector('.ck-composer__said')`);
  });

  test('P3: Send draws the question at once, "Sending" until the turn is named; a missing photo is sent again under the same submission; once named its photos are the home’s', async () => {
    const uploads = front.staged.filter(each => each.path === '/v1/ask/files').length;
    front.holdAsk(true);
    front.missingOnce();
    await type('Where did I take these?');
    await enter();
    await chrome.until(`document.querySelectorAll('.ck-ask-q__pictures .ck-ask-q__square').length === 2`);
    await chrome.until(`document.querySelector('.ck-steps__words')?.textContent === 'Sending'`);
    assert.equal(await page.count(PICTURES), 0, 'the photos stayed in the composer');
    await page.shot('sending', `document.querySelector('.ck-steps__words')?.textContent === 'Sending'`);
    const local = await chrome.evaluate(`[...document.querySelectorAll('.ck-ask-q__square')].map(each => each.src)`);
    assert.ok(local.every((/** @type {string} */ each) => each.startsWith('blob:')), 'a question sending not drawn from the page’s copies');
    front.holdAsk(false);
    await front.asked(2);
    await chrome.until(`document.querySelector('.ck-answer__words')?.textContent.includes('synthetic beach')`);
    const [first, again] = front.questions;
    assert.match(first.submission, /^[0-9a-f]{32}$/u);
    assert.equal(again.submission, first.submission, 'the question was asked again under another submission');
    assert.equal(first.question, 'Where did I take these?');
    const picked = await chrome.evaluate(`Promise.all(window.made.slice(0, 2).map(async file => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
    }))`);
    assert.deepEqual(first.photos, picked.map((/** @type {string} */ bytes) => named(Buffer.from(bytes, 'base64'))), 'the photos out of the order picked');
    assert.equal(front.staged.filter(each => each.path === '/v1/ask/files').length, uploads + 1, 'the missing photo was not sent again');
    assert.match(await chrome.evaluate(`document.querySelector('.ck-steps__words:not(.is-leaving)')?.textContent`), /^Thought for \d/u,
      '"Sending" stayed after the turn was named and answered');
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-ask-q__square')].map(each => new URL(each.src).pathname)`),
      ['/api/life/picture', '/api/life/picture'], 'a named question drawn from the page’s copies');
    assert.equal(await chrome.evaluate(`fetch(${JSON.stringify(local[0])}).then(() => 'read', () => 'gone')`), 'gone',
      'the page kept its copy of a photo sent');
    await page.shot('sent', `document.querySelector('.ck-answer__words') !== null`);
  });

  test('P4: the mic records 16 kHz seconds as they fill with its waveform; Stop sends the note, its player writing it out, then its words; the typed words stay; once named it plays from the home', async () => {
    await chrome.evaluate(TONE);
    await type('words typed before');
    front.holdWords(true);
    await press('.ck-composer__mic');
    await front.stagedAt(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/'), 1);
    await front.stagedAt(PUTS, 2);
    assert.ok(front.staged.filter(PUTS).every(each => each.bytes === 32_000), 'a second not 32,000 bytes');
    await chrome.until(`document.querySelectorAll('.ck-composer__wave .ck-wave > i').length > 10
      && document.querySelector('.ck-composer__time')?.textContent !== '0:00'`);
    await page.shot('recording', `document.querySelector('.ck-composer.is-recording') !== null`);
    const note = /** @type {string} */ (front.staged.find(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/'))
      ?.path.split('/').at(-1));
    const read = front.madeReads();
    await press('[data-ask-action="rec-stop"]');
    await front.asked(3);
    const seconds = front.staged.filter(each => each.method === 'PUT' && each.path.startsWith(`/v1/ask/notes/${note}/`));
    const voice = front.questions[2];
    assert.deepEqual(voice.voice, { note, seconds: seconds.length });
    assert.equal(voice.question, undefined, 'a voice question carried words');
    assert.ok(seconds.slice(0, -1).every(each => each.bytes === 32_000) && seconds.at(-1)?.bytes !== undefined
      && /** @type {number} */ (seconds.at(-1)?.bytes) % 2 === 0, 'the last part odd');
    await chrome.until(`document.querySelector('.ck-ask-voice__writing') !== null`);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-composer__input').value`), 'words typed before');
    await page.shot('writing', `document.querySelector('.ck-ask-voice__writing') !== null`);
    const audio = named(Buffer.from(note));
    await chrome.until(`document.querySelector('${LAST} .ck-steps__words')?.textContent !== 'Sending'`);
    await press(`${LAST} .ck-ask-voice__play`);
    await chrome.until(`window.players.some(each => each.src.includes(${JSON.stringify(encodeURIComponent(audio))}))`);
    await until('the note read from the home by name', () => front.blobReads.includes(`/v1/blobs/${audio}`));
    assert.equal(front.madeReads(), read, 'the conversation read for the note’s name');
    front.holdWords(false);
    await chrome.until(`document.querySelector('.ck-ask-voice__words')?.textContent === ${JSON.stringify(WORDS)}`);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-ask-turn:last-child .ck-ask-q__edit')`), null);
    await page.shot('words', `document.querySelector('.ck-ask-voice__words') !== null`);
  });

  test('P5: a note cancelled is let go at the home and asks nothing', async () => {
    const asked = front.questions.length;
    await press('.ck-composer__mic');
    await front.stagedAt(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/'), 2);
    await chrome.until(`document.querySelector('[data-ask-action="rec-cancel"]') !== null`);
    await press('[data-ask-action="rec-cancel"]');
    await front.stagedAt(each => each.method === 'DELETE', 1);
    await chrome.until(`document.querySelector('.ck-composer.is-recording') === null && document.querySelector('.ck-composer__input') !== null`);
    assert.equal(front.questions.length, asked);
  });

  test('P8: the voice row stands in the chip’s menu, with its caution mark while it cannot keep Chat’s level', async () => {
    await press('.ck-pick .ck-fmenu__btn');
    await chrome.until(`document.querySelector('.ck-pick [data-value="voice"]')?.hidden === false`);
    assert.match(await page.words('.ck-pick [data-value="voice"]'), /Voice.*Synthetic Cloud · Sent as it is/u);
    assert.equal(await page.count('.ck-pick [data-value="voice"] .ck-fill-caution'), 1);
    await page.shot('voice-row', `document.querySelector('.ck-pick [data-value="voice"]')?.hidden === false`);
    await press('.ck-pick .ck-fmenu__btn');
  });

  test('P7: a model whose input holds no image greys the + menu and says why', async () => {
    await press('.ck-pick .ck-fmenu__btn');
    await chrome.until(`document.querySelector('.ck-pick [data-value="models"]')?.hidden === false`);
    await press('.ck-pick [data-value="models"]');
    await chrome.until(`document.querySelector('.ck-pick [data-value="model:synthetic-blind"]')?.hidden === false`);
    await press('.ck-pick [data-value="model:synthetic-blind"]');
    await chrome.until(`document.querySelector('.ck-pick__words')?.textContent.startsWith('Synthetic Blind')`);
    await press('.ck-composer__attach .ck-fmenu__btn');
    await chrome.until(`document.querySelector('#ck-attach-menu')?.hidden === false`);
    assert.match(await page.words('#ck-attach-menu'), /Synthetic Blind can't see photos\./u);
    assert.equal(await page.count('#ck-attach-menu [aria-disabled="true"]'), 3);
    await page.shot('photos-off', `document.querySelector('#ck-attach-menu')?.hidden === false`);
    await press('.ck-composer__attach .ck-fmenu__btn');
  });

  test('P6: no voice model: the tap says the home\'s line and records nothing', async () => {
    front.voiceReady(false);
    const opened = front.staged.filter(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/')).length;
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await chrome.until(`document.querySelector('.ck-pick [data-value="voice"]')?.textContent.includes('Parakeet · this Mac')`);
    await press('.ck-composer__mic');
    await chrome.until(`document.body.textContent.includes(${JSON.stringify(NO_VOICE)})`);
    assert.equal(await page.count('.ck-composer.is-recording'), 0);
    assert.equal(front.staged.filter(each => each.method === 'POST' && each.path.startsWith('/v1/ask/notes/')).length, opened);
    await page.shot('no-voice', `document.body.textContent.includes(${JSON.stringify(NO_VOICE)})`);
    front.voiceReady(true);
  });

  test('P9: a kept question draws its photos from the home, plays its note from the home’s blob, and offers no Edit', async () => {
    await chrome.load(`#view=ask&chat=${KEPT}`, '');
    await chrome.until(`document.querySelectorAll('.ck-ask-q__square').length === 2 && document.querySelector('.ck-ask-voice__words') !== null`);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-ask-q__square')].map(each => new URL(each.src).pathname)`),
      ['/api/life/picture', '/api/life/picture']);
    await chrome.until(`[...document.querySelectorAll('.ck-ask-q__square')].every(each => each.complete && each.naturalWidth > 0)`);
    assert.equal(await page.count('.ck-ask-q__edit'), 0);
    await press('.ck-ask-voice__play');
    await until('the note read from the home', () => front.blobReads.includes(`/v1/blobs/${front.keptAudioName}`));
    await page.shot('kept', `document.querySelector('.ck-ask-voice__words') !== null`);
  });

  test('P10: photos still uploading at Send: the one the seal finds missing is sent again, under the same submission', async () => {
    await chrome.evaluate(`localStorage.removeItem('lifestream.ask.pick')`);
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__attach') !== null`);
    const uploads = () => front.staged.filter(each => each.path === '/v1/ask/files').length;
    const before = uploads();
    await make(['#3a5', '#a35']);
    front.holdFiles(true);
    await drop('window.made');
    await front.stagedAt(each => each.path === '/v1/ask/files', before + 2);
    await type('What are these two?');
    await enter();
    await chrome.until(`document.querySelector('.ck-steps__words')?.textContent === 'Sending'`);
    const asked = front.questions.length;
    front.missingOnce();
    front.holdFiles(false);
    await front.asked(asked + 2);
    await chrome.until(`document.querySelector('${LAST} .ck-answer__words')?.textContent.includes('synthetic beach')`);
    const [first, again] = front.questions.slice(asked);
    assert.equal(again.submission, first.submission, 'asked again under another submission');
    assert.deepEqual(again.photos, first.photos);
    assert.equal(uploads(), before + 3, 'the photo the seal found missing was not sent again');
  });

  test('P11: a voice question whose answer was lost, then whose stream ended before any event, stays sending and is posted again whole when the home answers', async () => {
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__mic') !== null`);
    await chrome.evaluate(TONE);
    await chrome.evaluate(DROP('POST', 'api/ask', 1));
    front.script('eof');
    const asked = front.questions.length;
    await recordNote(2);
    await chrome.until(`window.dropped?.length === 1`);
    await chrome.until(`document.querySelector('.ck-steps__words')?.textContent === 'Sending'`);
    assert.equal(front.questions.length, asked, 'a lost answer posted again before the home answered');
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await front.asked(asked + 1);
    await chrome.until(`document.querySelector('.ck-steps__words')?.textContent === 'Sending'`);
    assert.equal(await page.count('[data-ask-retry]'), 0, 'the question was drawn failed');
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await front.asked(asked + 2);
    await chrome.until(`document.querySelector('.ck-ask-voice__words')?.textContent === ${JSON.stringify(WORDS)}`);
    const lost = JSON.parse(await chrome.evaluate(`window.dropped[0].body`));
    assert.match(lost.submission, /^[0-9a-f]{32}$/u);
    assert.ok(lost.voice?.note && lost.voice.seconds >= 2, 'the question lost its note');
    assert.deepEqual(front.questions.slice(asked), [lost, lost], 'posted again as another question, or without its note');
  });

  test('P12: a voice question refused before it began keeps its note: Try again posts the same body under the same submission', async () => {
    front.script('refused');
    const asked = front.questions.length;
    await recordNote();
    await front.asked(asked + 1);
    await chrome.until(`document.querySelector('${LAST} [data-ask-retry]') !== null`);
    assert.match(await page.words(`${LAST} .ck-answer > .ck-in-place`), /the home couldn’t read your record/u);
    await press(`${LAST} [data-ask-retry]`);
    await front.asked(asked + 2);
    await chrome.until(`document.querySelector('${LAST} .ck-ask-voice__words')?.textContent === ${JSON.stringify(WORDS)}`);
    const [refused, again] = front.questions.slice(asked);
    assert.ok(refused.voice?.note, 'the question had no note');
    assert.deepEqual(again, refused, 'Try again posted another question');
  });

  test('P13: Try again of a voice question the Ask server named posts its audio; the home missing it draws it failed, nothing to ask again', async () => {
    front.script('failed', 'missing-audio');
    const asked = front.questions.length;
    await recordNote();
    await front.asked(asked + 1);
    await chrome.until(`document.querySelector('${LAST} [data-ask-retry]') !== null`);
    assert.match(await page.words(`${LAST} .ck-answer > .ck-in-place`), /Couldn’t write out your voice note/u);
    const staged = front.staged.length;
    await press(`${LAST} [data-ask-retry]`);
    await front.asked(asked + 2);
    await chrome.until(`document.querySelector('${LAST} .ck-answer > .ck-in-place')?.textContent.includes('Some files are missing.')
      && document.querySelector('${LAST} [data-ask-retry]') === null`);
    const [sent, held] = front.questions.slice(asked);
    assert.deepEqual(held.voice, { audio: named(Buffer.from(sent.voice.note)) }, 'Try again posted no held audio');
    assert.notEqual(held.submission, sent.submission);
    assert.equal(front.questions.length, asked + 2, 'the voice question asked again');
    assert.equal(front.staged.length, staged, 'the note sent again');
  });

  test('P14: an erasure while answering purges the conversation and draws it erased', async () => {
    front.script('erased');
    await type('Is this one kept?');
    await enter();
    await chrome.until(`document.body.textContent.includes('This conversation was erased.')
      && document.querySelectorAll('.ck-ask-turn').length === 0`);
    await page.shot('erased', `document.body.textContent.includes('This conversation was erased.')`);
  });

  test('P15: a note cancelled while its DELETE reaches no home is let go once the home answers', async () => {
    await chrome.evaluate(DROP('DELETE', 'api/ask/notes', 1));
    const deletes = () => front.staged.filter(each => each.method === 'DELETE');
    const before = deletes().length;
    const puts = front.staged.filter(PUTS).length;
    await press('.ck-composer__mic');
    await front.stagedAt(PUTS, puts + 1);
    await press('[data-ask-action="rec-cancel"]');
    await chrome.until(`window.dropped.some(each => each.path.startsWith('api/ask/notes'))`);
    assert.equal(deletes().length, before);
    const note = new URL(await chrome.evaluate(`window.dropped.find(each => each.path.startsWith('api/ask/notes')).path`),
      'http://page').searchParams.get('note');
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await front.stagedAt(each => each.method === 'DELETE', before + 1);
    assert.equal(deletes().at(-1)?.path, `/v1/ask/notes/${note}`);
  });

  test('P16: a question of words alone refused while Chat is down stays in the thread, sending, and goes under its submission once Chat answers', async () => {
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__mic') !== null`);
    front.script('down');
    const asked = front.questions.length;
    await type('Was the synthetic pier open?');
    await enter();
    await front.asked(asked + 1);
    await chrome.until(`document.querySelector('.ck-composer.is-waiting') !== null
      && document.querySelector('${LAST} .ck-steps__words')?.textContent === 'Sending'`);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-composer__input').value`), '', 'the words came back to the field');
    assert.equal(await page.count('.ck-ask-turn'), 1);
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await front.asked(asked + 2);
    await chrome.until(`document.querySelector('${LAST} .ck-answer__words')?.textContent.includes('synthetic beach')`);
    const [refused, again] = front.questions.slice(asked);
    assert.equal(refused.question, 'Was the synthetic pier open?');
    assert.deepEqual(again, refused, 'asked again under another submission');
  });

  test('P17: Try again of an older question refused before it began waits for the turn answering, then goes under its submission', async () => {
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__mic') !== null`);
    const asked = front.questions.length;
    await type('Where did the synthetic walk start?');
    await enter();
    await chrome.until(`document.querySelector('${LAST} .ck-answer__words')?.textContent.includes('synthetic beach')`);
    front.script('refused');
    await type('Who was on the synthetic beach?');
    await enter();
    await chrome.until(`document.querySelector('${LAST} [data-ask-retry]') !== null`);
    front.script('slow');
    await type('How long was the synthetic walk?');
    await enter();
    await front.asked(asked + 3);
    await chrome.until(`document.querySelector('.ck-composer.is-running') !== null
      && ![...document.querySelectorAll('.ck-steps__words')].some(each => each.textContent === 'Sending')`);
    await chrome.evaluate(`document.querySelector('.ck-ask-turn:nth-child(2) [data-ask-retry]').scrollIntoView({ block: 'center' })`);
    await press('.ck-ask-turn:nth-child(2) [data-ask-retry]');
    await chrome.until(`document.querySelector('.ck-ask-turn:nth-child(2) .ck-steps__words')?.textContent === 'Sending'`);
    front.release();
    await chrome.until(`[...document.querySelectorAll('.ck-ask-turn .ck-answer__words')]
      .filter(each => each.textContent.includes('synthetic beach')).length === 3`);
    const [, refused, slow, again] = front.questions.slice(asked);
    assert.equal(front.questions.length, asked + 4);
    assert.equal(slow.question, 'How long was the synthetic walk?');
    assert.deepEqual(again, refused, 'Try again posted another question');
    assert.equal(front.cut(), 0, 'the newer turn’s stream cut before its end');
    assert.ok(front.log.indexOf(`end ${slow.submission}`) < front.log.lastIndexOf(`ask ${refused.submission}`),
      'Try again posted while the newer turn was answering');
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-ask-q__words')].map(each => each.textContent.trim())`),
      ['Where did the synthetic walk start?', 'How long was the synthetic walk?', 'Who was on the synthetic beach?']);
  });

  test('P18: a conversation erased on the home and read again as it opens is purged: its turns', async () => {
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__attach') !== null`);
    await type('Where is this synthetic place?');
    await enter();
    await chrome.until(`document.querySelector('${LAST} .ck-answer__words')?.textContent.includes('synthetic beach')`);
    const chat = await chatShown();
    front.erase(chat);
    await press('.ak-bar [data-ask-action="new"]');
    await chrome.until(`!location.hash.includes('chat=')`);
    await chrome.evaluate(`location.hash = '#view=ask&chat=${chat}'`);
    await chrome.until(`document.body.textContent.includes('This conversation was erased.')
      && document.querySelectorAll('.ck-ask-turn').length === 0`);
  });

  test('P19: a conversation open while it is erased is purged at the feed’s reset, its note playing from the home stopped', async () => {
    await chrome.load(`#view=ask&chat=${KEPT}`, PLAYERS);
    await chrome.until(`document.querySelector('.ck-ask-voice__words') !== null`);
    await press('.ck-ask-voice__play');
    await chrome.until(`window.players.some(each => each.src.includes('/api/life/media'))`);
    front.erase(KEPT);
    front.breakFeed();
    await chrome.until(`document.body.textContent.includes('This conversation was erased.')
      && document.querySelectorAll('.ck-ask-turn').length === 0`);
    assert.ok(await chrome.evaluate(`window.players.length > 0
      && window.players.every(each => each.paused && each.getAttribute('src') === null)`), 'the erased note still held by the player');
  });
  test('P20: a conversation the Ask server does not know keeps what the page has not sent: a question into it failed with Try again, kept through a read again, sent under its submission once known', async () => {
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__mic') !== null`);
    await type('Which synthetic trail was it?');
    await enter();
    await chrome.until(`document.querySelector('${LAST} .ck-answer__words')?.textContent.includes('synthetic beach')`);
    const chat = await chatShown();
    front.unknown(chat, true);
    const asked = front.questions.length;
    await type('And the one after it?');
    await enter();
    await front.asked(asked + 1);
    await chrome.until(`document.querySelector('${LAST} [data-ask-retry]') !== null`);
    const reads = front.unknownReads(chat);
    front.breakFeed();
    await until('the conversation read again', () => front.unknownReads(chat) > reads);
    front.unknown(chat, false);
    await press(`${LAST} [data-ask-retry]`);
    await front.asked(asked + 2);
    await chrome.until(`[...document.querySelectorAll('.ck-ask-turn .ck-answer__words')]
      .filter(each => each.textContent.includes('synthetic beach')).length === 2`);
    const [unknown, again] = front.questions.slice(asked);
    assert.deepEqual(again, unknown, 'Try again posted another question');
    assert.equal(await chrome.evaluate(`document.body.textContent.includes('This conversation was erased.')`), false);
    assert.equal(await page.count('.ck-ask-turn'), 2);
  });

  test('P21: a photo the home refuses after Send is taken out of the question, drawn failed in the home’s words; Try again sends the rest under its submission', async () => {
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('.ck-composer__attach') !== null`);
    await make(['#35a']);
    await chrome.evaluate(`window.made.push(new File(['BAD synthetic bytes'], 'broken.jpg', { type: 'image/jpeg', lastModified: 9 }))`);
    const uploads = () => front.staged.filter(each => each.path === '/v1/ask/files').length;
    const before = uploads();
    front.holdFiles(true);
    await drop('window.made');
    await front.stagedAt(each => each.path === '/v1/ask/files', before + 2);
    const asked = front.questions.length;
    await type('What is in this synthetic picture?');
    await enter();
    await chrome.until(`document.querySelectorAll('${LAST} .ck-ask-q__square').length === 2`);
    front.holdFiles(false);
    await chrome.until(`document.querySelector('${LAST} [data-ask-retry]') !== null
      && document.querySelectorAll('${LAST} .ck-ask-q__picture').length === 1`);
    assert.ok((await page.words(`${LAST} .ck-in-place`)).includes(UNREADABLE));
    assert.equal(front.questions.length, asked, 'asked with a photo the home refused');
    assert.equal(await page.count('.ck-composer__said'), 0, 'the refusal said under the composer');
    await press(`${LAST} [data-ask-retry]`);
    await front.asked(asked + 1);
    await chrome.until(`document.querySelector('${LAST} .ck-answer__words')?.textContent.includes('synthetic beach')`);
    const [sent] = front.questions.slice(asked);
    assert.equal(sent.question, 'What is in this synthetic picture?');
    assert.deepEqual(sent.photos, [[...front.blobs.keys()].at(-1)]);
    assert.equal(uploads(), before + 2, 'the refused photo sent again');
  });
  test('P22: a covered photo in the model view never shows the original: an opaque tile until the cover is in, then the cover; the person\'s view again', async () => {
    await chrome.load(`#view=ask&chat=${SEEN_CHAT}`, '');
    const eye = '.ck-answer__foot [data-ck-seen-eye]';
    await chrome.until(`document.querySelector('${eye}') !== null
      && document.querySelector('.ck-seen-pic .ck-seen-pic__shown')?.complete && document.querySelector('.ck-seen-pic .ck-seen-pic__shown').naturalWidth > 0`);
    assert.equal(await chrome.evaluate(`getComputedStyle(document.querySelector('.ck-seen-pic__said')).opacity`), '0', 'the person sees the photo');
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-seen-pic__said img').getAttribute('src')`), null, 'the cover read before the eye');
    front.holdCovers(true);
    await press(eye);
    await until('the cover asked of the home', () => front.heldCovers() === 1);
    const tile = `(() => { const said = document.querySelector('.ck-seen-pic__said'), style = getComputedStyle(said);
      return { opacity: style.opacity, fill: style.backgroundColor, in: said.classList.contains('is-in'), cover: getComputedStyle(said.querySelector('img')).opacity,
        source: new URL(said.querySelector('img').src).pathname }; })()`;
    const loading = await chrome.evaluate(tile);
    assert.deepEqual([loading.opacity, loading.in, loading.cover, loading.source], ['1', false, '0', '/api/life/picture'], 'an opaque tile at once while the cover loads');
    assert.match(loading.fill, /^rgb\(/u, 'the tile is opaque');
    await page.shot('cover-loading', `document.querySelector('.ck-ask-turn').classList.contains('is-model')`);
    front.holdCovers(false);
    await chrome.until(`document.querySelector('.ck-seen-pic__said').classList.contains('is-in')
      && getComputedStyle(document.querySelector('.ck-seen-pic__said img')).opacity === '1'`, 'the cover in');
    await page.shot('cover-in', `document.querySelector('.ck-seen-pic__said').classList.contains('is-in')`);
    await press(eye);
    await chrome.until(`!document.querySelector('.ck-ask-turn').classList.contains('is-model')
      && getComputedStyle(document.querySelector('.ck-seen-pic__said')).opacity === '0'`, 'the original back');
  });

  test('P23: a cover the home answers 404 for stays an opaque tile with its standing line, never the original', async () => {
    await chrome.load(`#view=ask&chat=${LOST_CHAT}`, '');
    const eye = '.ck-answer__foot [data-ck-seen-eye]';
    await chrome.until(`document.querySelector('${eye}') !== null`);
    await press(eye);
    await chrome.until(`document.querySelector('.ck-seen-pic__said')?.classList.contains('is-lost')`, 'the cover refused');
    assert.deepEqual(await chrome.evaluate(`(() => { const said = document.querySelector('.ck-seen-pic__said'), line = said.querySelector('.ck-pics__lost');
      return [getComputedStyle(said).opacity, getComputedStyle(line).display, line.textContent, getComputedStyle(said.querySelector('img')).visibility]; })()`),
    ['1', 'flex', 'Can’t show this photo', 'hidden']);
    await page.shot('cover-lost', `document.querySelector('.ck-seen-pic__said')?.classList.contains('is-lost')`);
  });

  test('P24: a voice note cited is a bar under its paragraph with its caption and its own number; a tap loads then plays it from the home; the question’s note stops it', async () => {
    await chrome.load(`#view=ask&chat=${VOICED_CHAT}`, PLAYERS);
    await chrome.until(`document.querySelectorAll('.ck-answer .ck-voice-cite').length === 3`);
    const said = `.ck-answer [data-voice="${front.keptAudioName}"]`;
    const bars = await chrome.evaluate(`[...document.querySelectorAll('.ck-answer .ck-voice-cite')].map(each =>
      [each.querySelector('[data-voice-time]').textContent, each.querySelector('.ck-voice-cite__caption').textContent])`);
    assert.deepEqual(bars.map((/** @type {string[]} */ [time]) => time), ['0:03', '0:23', '0:23']);
    assert.ok(bars.every((/** @type {string[]} */ [, caption]) => /^Person A · Wed 4 Nov( 2026)?, 21:40$/u.test(caption)), JSON.stringify(bars));
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-answer .ck-cite')].map(each => each.textContent)`), ['1', '2', '3'],
      'notes of one chat and day merged into one number');
    assert.ok(await chrome.evaluate(`document.querySelector('${said}').closest('.ck-voice-cite').previousElementSibling.textContent.includes('on the 4th')`),
      'the bar is not under the paragraph that cites it');
    await press(`${said} .ck-audio__play`);
    await chrome.until(`${stateOf(said)} === 'playing'`);
    await until('the cited note read from the home', () => front.blobReads.includes(`/v1/blobs/${front.keptAudioName}`));
    await press('.ck-ask-voice__play');
    await chrome.until(`${stateOf('.ck-ask-voice')} === 'playing'`);
    assert.equal(await chrome.evaluate(`${stateOf(said)} ?? 'ready'`), 'ready', 'the cited note played on beside the question’s');
    assert.equal(await chrome.evaluate(`window.players.length`), 1, 'a second player');
    await page.shot('voice-cited', `${stateOf('.ck-ask-voice')} === 'playing'`);
  });

  test('P25: a cited note that fails to play describes its record: erased says so in its place; one still held says it didn’t play, drawn from the newer describe, and Try again plays that', async () => {
    await chrome.load(`#view=ask&chat=${VOICED_CHAT}`, PLAYERS);
    await chrome.until(`document.querySelectorAll('.ck-answer .ck-voice-cite').length === 3`);
    await press(`.ck-answer [data-voice="${ERASED_AUDIO}"] .ck-audio__play`);
    await chrome.until(`document.querySelector('.ck-voice-cite__gone')?.textContent === 'This voice note was erased.'`);
    assert.deepEqual(front.describes.at(-1), ['record.erased']);
    assert.equal(await page.count(`[data-voice="${ERASED_AUDIO}"]`), 0);
    const renamed = `.ck-answer [data-voice="${RENAMED_AUDIO}"]`;
    const line = `document.querySelector('${renamed} .ck-voice__failed')`;
    front.holdDescribes(true);
    await press(`${renamed} .ck-audio__play`);
    await chrome.until(`${stateOf(renamed)} === 'failed' && getComputedStyle(${line}).display !== 'none'
      && ${line}.textContent.includes('This voice note didn’t play.')`);
    await page.shot('voice-failed', `${stateOf(renamed)} === 'failed'`);
    await until('the failed play described', () => front.heldDescribes() === 1);
    const taps = `performance.getEntriesByName('voice-tap').length`;
    const tapped = await chrome.evaluate(taps);
    await press(`${renamed} .ck-in-place__act`);
    await chrome.until(`${taps} === ${tapped + 1} && ${stateOf(renamed)} === 'failed'`);
    front.holdDescribes(false);
    await until('the second failed play described', () => front.describes.filter(refs => refs.join() === 'record.renamed').length === 2);
    await chrome.until(`document.querySelectorAll('.ck-answer [data-voice="${front.keptAudioName}"]').length === 2`);
    assert.deepEqual(front.describes.slice(-2), [['record.renamed'], ['record.renamed']]);
    assert.ok(await chrome.evaluate(`[...document.querySelectorAll('.ck-answer .ck-voice__failed')].every(each => getComputedStyle(each).display === 'none')`),
      'a failed line shown beside a bar that has not failed');
    await press(`.ck-answer [data-voice="${front.keptAudioName}"]:has([data-ask-cite$=" r3"]) .ck-audio__play`);
    await chrome.until(`[...document.querySelectorAll('.ck-answer [data-voice="${front.keptAudioName}"]')].every(each => each.dataset.voiceState === 'playing')`);
  });

  test('P26: a note played while its answer still streams leaves the answer drawing to its end; leaving Chat by the sidebar stops it, named or not', async () => {
    await chrome.load('#view=ask', LOOPING);
    await chrome.until(`document.querySelector('.ck-composer__mic') !== null`);
    await chrome.evaluate(TONE);
    front.holdAsk(true);
    front.script('slow');
    await recordNote();
    const own = `${LAST} .ck-ask-voice[data-voice]`;
    await chrome.until(`document.querySelector('${own}') !== null`);
    await press(`${own} .ck-ask-voice__play`);
    await chrome.until(`${stateOf(own)} === 'playing'`);
    front.holdAsk(false);
    await chrome.until(`document.querySelector('${LAST} .ck-steps__words')?.textContent !== 'Sending' && ${stateOf(own)} === 'playing'`);
    front.release();
    await chrome.until(`document.querySelector('${LAST} .ck-answer:not(.is-pacing)')?.textContent.includes('On the synthetic beach.') === true`);
    assert.equal(await chrome.evaluate(stateOf(own)), 'playing', 'the answer’s redraw stopped the note');
    assert.equal(await chrome.evaluate(`document.querySelectorAll('${own} [data-voice-face]').length`), 3);
    await press('a.sidebar__item[href="#view=days"]');
    await chrome.until(`window.players.length === 1 && window.players[0].paused && window.players[0].getAttribute('src') === null`);
    assert.equal(await chrome.evaluate(`${stateOf(own)} ?? 'ready'`), 'ready', 'the question’s bar still says it plays');
  });
});
