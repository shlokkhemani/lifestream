// @ts-check
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as ask } from 'node:http';
import { readFileSync } from 'node:fs';
import { MODELS_BARE } from '../public/kit-gallery-llm.js';
import { hostScript, hostState } from './stand-ins/onboarding-home.mjs';
import { askReady, askSignedOut } from './stand-ins/ask-ready.mjs';
import { pageHarness } from './stand-ins/page-harness.mjs';
import { until } from './until.mjs';

const WINDOW = { width: 1440, height: 900 };
const STARTERS = [{ kind: 'places', question: 'Where have I been today?' }, { kind: 'walking', question: 'How far did I walk today?' },
  { kind: 'photos', question: 'What did I photograph this week?' }];
const CHAT = '1792396847000-3fa9c2';
/**
 * @param {string} kind
 * @param {...unknown} parts
 */
const madeRef = (kind, ...parts) => `${kind}.${Buffer.from(JSON.stringify([kind, ...parts]), 'utf8').toString('base64url')}`;
const REFS = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(n => [`r${n}`,
  { ref: madeRef('record', 'synthetic:one', 'item', `k${n}`), kind: 'record', day: '2026-10-1' + n % 10, at: `2026-10-1${n % 10}T10:00+00:00`,
    title: `Synthetic booking receipt ${n}`, opens: { page: 'days', day: '2026-10-1' + n % 10, focus: `rec:synthetic:one item k${n}` } }]));
const CHAT_DAY = '2026-10-21';
const PERSON_A = 'whatsapp:15550000001@s.whatsapp.net';
const HOME_WHATSAPP = 'whatsapp:+15550000009:iphone-aa01';
const CHAT_LINES = [['m1', '09'], ['m2', '13'], ['m3', '17']];
Object.assign(REFS, Object.fromEntries([['m1', '09'], ['m3', '17']].map(([key, hour], at) => [`r${at + 8}`, {
  ref: madeRef('record', HOME_WHATSAPP, 'msg', `15550000001@s.whatsapp.net:${key}`),
  kind: 'message', day: CHAT_DAY, at: `${CHAT_DAY}T${hour}:00+00:00`, title: 'Person A', chat: madeRef('chat', PERSON_A), chat_title: 'Person A',
  opens: { page: 'days', day: CHAT_DAY, focus: `rec:${HOME_WHATSAPP} msg 15550000001@s.whatsapp.net:${key}` } }])));
const TEXT = 'You paid four reservations in all [r1, r2, r3, r4]. The last one came with a refund [r2][r5] and a note.\n\n'
  + 'Written apart, the same source twice [r5] [r6] [r6] [r7] counts once, and this sentence goes on.\n\n'
  + 'The same first source again [r1, r5, r6] has a menu of its own.\n\n'
  + 'Person A said so twice [r8, r9], in one chat on one day.';
const SAVING = '1792396849000-5bc1e4';
/** @param {boolean} written */
const savingConversation = written => ({
  chat: SAVING, title: 'Synthetic tide',
  messages: [
    { chat: SAVING, n: 1, at_ms: Date.parse('2026-10-20T11:00:00Z'), role: 'user', text: 'When does the tide turn?', ...written ? {} : { unsaved: true } },
    { chat: SAVING, n: 2, at_ms: Date.parse('2026-10-20T11:00:20Z'), role: 'assistant', text: 'At six, by the synthetic tables.', end: 'done',
      ms: 20_000, steps: [], model: 'synthetic-terra', thinking: 'high', ...written ? {} : { unsaved: true } },
  ],
});
const NAMES = '1792396850500-6cd2f7';
const NAMED = {
  r1: { ref: madeRef('person', 'synthetic-b'), kind: 'person', name: 'Person B' },
  r2: { ref: madeRef('chat', 'synthetic-group'), kind: 'chat', name: 'Group Alpha' },
  r3: { ref: madeRef('place', 'synthetic-place'), kind: 'place', name: 'A place' },
};
/** @param {Record<string, string>} ids */
const namesConversation = ids => ({
  chat: NAMES, title: 'Synthetic names',
  messages: [
    { chat: NAMES, n: 1, at_ms: Date.parse('2026-10-20T08:00:00Z'), role: 'user', text: 'Who wrote, and where?' },
    { chat: NAMES, n: 2, at_ms: Date.parse('2026-10-20T08:00:30Z'), role: 'assistant', text: 'Person B [r1] wrote in [r2], from [r3].',
      refs: Object.fromEntries(Object.entries(NAMED).map(([handle, cited]) => [handle,
        { ...cited, opens: cited.kind === 'chat' ? { page: 'people', id: ids[handle] ?? '', person: null, group: ids[handle] ?? '' }
          : { page: cited.kind === 'place' ? 'places' : 'people', id: ids[handle] ?? '' } }])),
      end: 'done', ms: 30_000, steps: [], model: 'synthetic-terra', thinking: 'high' },
  ],
});
const WIDE = '1792396848000-4ab0d3';
const FORTY = Array.from({ length: 40 }, (_, at) => `r${at + 1}`);
const WIDE_CONVERSATION = {
  chat: WIDE, title: 'Synthetic forty',
  messages: [
    { chat: WIDE, n: 1, at_ms: Date.parse('2026-10-20T10:00:00Z'), role: 'user', text: 'Every receipt this year?' },
    { chat: WIDE, n: 2, at_ms: Date.parse('2026-10-20T10:00:30Z'), role: 'assistant', text: `Forty receipts [${FORTY.join(', ')}], all paid.`,
      refs: Object.fromEntries(FORTY.map((handle, at) => [handle, { ref: madeRef('record', 'synthetic:one', 'item', `w${at + 1}`), kind: 'record',
        day: '2026-10-11', at: '2026-10-11T10:00+00:00', title: `Synthetic receipt ${at + 1}`,
        opens: { page: 'days', day: '2026-10-11', focus: `rec:synthetic:one item w${at + 1}` } }])),
      end: 'done', ms: 30_000, steps: [], model: 'synthetic-terra', thinking: 'high' },
  ],
};
const REJOIN = '1792396851000-7de3a6';
const REJOIN_AT = Date.parse('2026-10-20T12:00:00Z');
/** @param {number} n @param {string} text */
const rejoinAsked = (n, text) => ({ type: 'ask.msg', chat: REJOIN, n, at_ms: REJOIN_AT + n * 60_000, role: 'user', text });
/** @param {number} n @param {string} text */
const rejoinAnswer = (n, text) => ({ type: 'ask.msg', chat: REJOIN, n, at_ms: REJOIN_AT + n * 60_000 + 1000, role: 'assistant', text, refs: {},
  end: 'done', ms: 1000, steps: [], model: 'synthetic-terra', thinking: 'high' });
const REJOIN_KEPT = [rejoinAsked(1, 'Did the synthetic parcel come?'), rejoinAnswer(2, 'It did.')];
const REJOIN_ASKED = 'Did Person A get the lighthouse tickets?';
const RESTARTING = 'Chat is restarting: ask again in a moment.';
const NEW_CHAT = '1792396850000-6cd2f5';
const NEW_CONVERSATION = {
  chat: NEW_CHAT, title: 'Synthetic new',
  messages: [
    { chat: NEW_CHAT, n: 1, at_ms: Date.parse('2026-10-20T12:00:00Z'), role: 'user', text: 'What is new?' },
    { chat: NEW_CHAT, n: 2, at_ms: Date.parse('2026-10-20T12:00:01Z'), role: 'assistant', text: 'Nothing synthetic.', end: 'done', ms: 1_000,
      steps: [], model: 'synthetic-terra', thinking: 'high' },
  ],
};
const CONVERSATION = {
  chat: CHAT, title: 'Synthetic receipts',
  messages: [
    { chat: CHAT, n: 1, at_ms: Date.parse('2026-10-20T09:00:00Z'), role: 'user', text: 'What did I pay for the reservations?' },
    { chat: CHAT, n: 2, at_ms: Date.parse('2026-10-20T09:00:30Z'), role: 'assistant', text: TEXT, refs: REFS, end: 'done', ms: 30_000,
      steps: [{ name: 'search', words: 'Searched mail for “receipt”', ms: 800 }], model: 'synthetic-terra', thinking: 'high' },
  ],
};

/** @type {{ turns: { words: string, answer: string, refs?: Record<string, unknown>, seen: Record<string, unknown>, model?: { asked: string, answered: string } }[] }} */
const SHARED = JSON.parse(readFileSync(new URL('../../design/privacy-view.json', import.meta.url), 'utf8'));
const CITED = /** @type {(typeof SHARED.turns)[number]} */ (SHARED.turns.find(each => each.refs));
const SEEN_CHAT = '1792396852000-8ef4b7';
const SEEN_CONVERSATION = {
  chat: SEEN_CHAT, title: 'Synthetic sleep',
  messages: [
    { chat: SEEN_CHAT, n: 1, at_ms: Date.parse('2026-10-20T07:00:00Z'), role: 'user', text: CITED.words },
    { chat: SEEN_CHAT, n: 2, at_ms: Date.parse('2026-10-20T07:00:10Z'), role: 'assistant', text: CITED.answer, refs: CITED.refs, end: 'done',
      ms: 10_000, steps: [], model: 'synthetic-terra', thinking: 'high', seen: CITED.seen },
  ],
};

const MODELS = [
  { id: 'claude/synthetic-opus', name: 'Synthetic Opus', thinking: ['low', 'high'], default: 'low', group: 'Claude' },
  { id: 'synthetic-terra', name: 'Synthetic Terra', thinking: ['low', 'high'], default: 'high', group: 'ChatGPT' },
  { id: 'synthetic-luna', name: 'Synthetic Luna', thinking: ['low', 'medium', 'high'], default: 'medium', group: 'ChatGPT' },
  { id: 'synthetic-sol', name: 'Synthetic Sol', thinking: ['low', 'medium'], default: 'medium', group: 'ChatGPT' },
];
const CLAUDE_OUT = 'Chat needs your Claude sign-in on your Mac.';

/** @param {{ url: string, tokens: Record<string, string>, day: string }} home */
async function chatHome(home) {
  const behind = new URL(home.url);
  let holding = true;
  /** @type {number | null} */
  let hourAt = null;
  /** @type {{ unsaved_in_ms?: number, model: string }[]} */
  const readies = [];
  let claude = false;
  /** @type {Set<string>} */
  const retired = new Set();
  /** @type {string} */
  let heldPick = '';
  /** @type {(() => void)[]} */
  const held = [];
  let written = true;
  let login = 'ready';
  let defaultOff = false;
  let defaultThinking = '';
  let failingLogin = false;
  /** @type {'wait' | 'held' | null} */
  let chatRefusal = null;
  /** @type {Record<string, unknown>[]} */
  const questions = [];
  /** @type {string[]} */
  const askedIn = [];
  /** @type {string[]} */
  const named = [];
  let setting = 'all';
  /** @type {Map<string, string>} */
  const levels = new Map();
  let holdingReads = false;
  /** @type {(() => void)[]} */
  const heldReads = [];
  /** @type {import('node:http').ServerResponse | null} */
  let turn = null;
  let turnChat = '';
  let turnN = 0;
  /** @type {Map<string, number>} */
  const turnsIn = new Map();
  let holdingTurns = false;
  /** @type {Record<string, string>} */
  const namedIds = {};
  /** @type {string[]} */
  const readsAsked = [];
  let holdingRejoin = false;
  /** @type {(() => void)[]} */
  const heldRejoins = [];
  /** @type {Record<string, unknown>} */
  let rejoinRead = { chat: REJOIN, title: 'Synthetic parcel', messages: REJOIN_KEPT };
  /** @type {Record<string, unknown>[] | null} */
  let rejoinEvents = null;
  let rejoinFollows = 0;
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  let answers = false;
  let made = false;
  let listFails = false;
  let listHeld = false;
  let many = false;
  /** @type {(() => void)[]} */
  const heldLists = [];
  let seq = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '', 'http://door');
    if (url.pathname === '/v1/feed') {
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 1000\n\n');
      return;
    }
    /** @param {unknown} body */
    const send = body => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === '/v1/ask' && request.method === 'POST') {
      /** @type {Buffer[]} */
      const parts = [];
      request.on('data', part => parts.push(part));
      request.on('end', () => {
        const { chat: named0, ...asked } = JSON.parse(Buffer.concat(parts).toString('utf8'));
        const chat = named0 ?? `${1792396900000 + named.length}-abcdef`;
        if (named0 === undefined) named.push(chat);
        const begun = asked.level ?? (levels.has(chat) ? undefined : setting);
        questions.push(asked);
        askedIn.push(named0 ?? '');
        turnsIn.set(chat, (turnsIn.get(chat) ?? 0) + 1);
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (failingLogin) return void response.end(`${JSON.stringify({ type: 'error', error: 'login', message: CLAUDE_OUT })}\n`);
        if (holdingTurns) {
          turnN = 2 * (turnsIn.get(chat) ?? 1);
          if (begun !== undefined) levels.set(chat, begun);
          response.write(`${JSON.stringify({ type: 'chat', chat, n: turnN })}\n`);
          turn = response;
          turnChat = chat;
          return;
        }
        if (!answers) return void response.end(`${JSON.stringify({ type: 'error', error: 'model', message: 'Synthetic: no model here.' })}\n`);
        made = true;
        const [, answer] = NEW_CONVERSATION.messages;
        response.end([{ type: 'chat', chat: NEW_CHAT, n: 2 }, { type: 'done', message: answer },
          { type: 'title', chat: NEW_CHAT, title: NEW_CONVERSATION.title }].map(event => `${JSON.stringify(event)}\n`).join(''));
      });
      return;
    }
    if (url.pathname === '/v1/privacy') {
      const now = setting;
      if (holdingReads) return void heldReads.push(() => send({ chat: now, ready: true, epoch: 0 }));
      return send({ chat: now, ready: true, epoch: 0 });
    }
    const level = /^\/v1\/privacy\/chat\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (level !== undefined) {
      const answer = (/** @type {string} */ now) => () => send({ chat: level, level: now, epoch: 0 });
      if (holdingReads) return void heldReads.push(answer(levels.get(level) ?? setting));
      return answer(levels.get(level) ?? setting)();
    }
    if (url.pathname === '/v1/ask') {
      const pick = { model: url.searchParams.get('model') ?? '', thinking: url.searchParams.get('thinking') ?? '' };
      const answer = () => {
        const hour = hourAt === null ? {} : { unsaved_in_ms: Math.max(0, hourAt - Date.now()) };
        readies.push({ ...hour, model: pick.model });
        if (login !== 'ready') return send({ ...askSignedOut([MODELS[0]], CLAUDE_OUT), ...hour });
        const offered = MODELS.filter(each => !retired.has(each.id))
          .map(each => claude || each.group !== 'Claude' ? each : { ...each, state: 'unavailable', line: CLAUDE_OUT });
        const fallback = offered.find(each => !('state' in each));
        const picked = offered.find(each => each.id === pick.model);
        const chosen = picked ?? (defaultOff ? offered[0] : fallback);
        send({ ...askReady(offered, { model: defaultOff ? null : fallback?.id ?? null, ...defaultThinking ? { thinking: defaultThinking } : {} }),
          ...chosen && 'line' in chosen ? { said: chosen.line, act: `Sign in with ${chosen.group}…` } : {},
          ...pick.model && !picked ? { gone: true } : {}, starters: STARTERS, ...hour });
      };
      if (heldPick && pick.model === heldPick) return void held.push(answer);
      return answer();
    }
    if (url.pathname === '/v1/ask/chats') {
      if (listFails) {
        response.writeHead(500, { 'content-type': 'application/json' });
        return void response.end(JSON.stringify({ error: 'Synthetic: the list broke.' }));
      }
      const chats = [...made ? [{ chat: NEW_CHAT, title: NEW_CONVERSATION.title, first_ms: Date.now(), last_ms: Date.now(), messages: 2 }] : [],
        ...holding ? [{ chat: CHAT, title: CONVERSATION.title, first_ms: Date.now(), last_ms: Date.now(), messages: 2 }] : []];
      if (many) {
        const from = Number(url.searchParams.get('after') ?? 0);
        const all = [...Array.from({ length: 45 }, (_, n) => ({ chat: `synthetic-many-${n}`, title: `Synthetic conversation ${n}`,
          first_ms: Date.now() - n * 24 * 3_600_000, last_ms: Date.now() - n * 24 * 3_600_000, messages: 2 }))];
        return send({ chats: all.slice(from, from + 20), ...from + 20 < all.length ? { next: String(from + 20) } : {} });
      }
      if (listHeld) return void heldLists.push(() => send({ chats }));
      return send({ chats });
    }
    if (url.pathname === `/v1/ask/chats/${NEW_CHAT}`) return send(NEW_CONVERSATION);
    if (url.pathname === `/v1/ask/chats/${CHAT}` && chatRefusal) {
      response.writeHead(503, { 'content-type': 'application/json', ...chatRefusal === 'wait' ? { 'retry-after': '0.1' } : {} });
      return void response.end(JSON.stringify(chatRefusal === 'wait' ? { code: 'NOT_NOW', message: 'Your conversation is being prepared.' }
        : { code: 'NOT_NOW', wait: 'needs', message: 'Lifestream is held', title: 'Lifestream is held', line: 'The drive holding it went away.', acts: [] }));
    }
    if (url.pathname === `/v1/ask/chats/${CHAT}`) return send(CONVERSATION);
    if (url.pathname === `/v1/ask/chats/${WIDE}`) return send(WIDE_CONVERSATION);
    if (url.pathname === `/v1/ask/chats/${SEEN_CHAT}`) return send(SEEN_CONVERSATION);
    if (url.pathname === `/v1/ask/chats/${NAMES}`) return send(namesConversation(namedIds));
    if (url.pathname === '/v1/read' || url.pathname === '/v1/describe') {
      const named = Object.values(NAMED).map(each => each.ref);
      readsAsked.push(...url.searchParams.getAll('ref').filter(ref => named.includes(ref)));
    }
    if (url.pathname === `/v1/ask/chats/${SAVING}`) return send(savingConversation(written));
    if (url.pathname === `/v1/ask/chats/${REJOIN}`) {
      if (holdingRejoin) return void heldRejoins.push(() => send(rejoinRead));
      return send(rejoinRead);
    }
    if (url.pathname === `/v1/ask/chats/${REJOIN}/events`) {
      rejoinFollows += 1;
      if (rejoinEvents === null) return void response.writeHead(204).end();
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return void response.end(rejoinEvents.map(event => `${JSON.stringify(event)}\n`).join(''));
    }
    if (url.pathname === '/v1/page/models/defaults' || url.pathname === '/v1/page/models/providers') return send(MODELS_BARE);
    if (url.pathname.startsWith('/v1/ask')) {
      response.writeHead(204);
      return void response.end();
    }
    const passed = ask({ host: behind.hostname, port: behind.port, path: request.url, method: request.method, headers: { ...request.headers, host: behind.host } },
      answer => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
    passed.on('error', () => response.destroy());
    request.pipe(passed);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    questions,
    askedIn,
    named,
    levels,
    namedIds,
    readsAsked,
    /** @param {string} now */
    sets: now => { setting = now; },
    /** @param {boolean} now */
    holdsReads: now => { holdingReads = now; },
    heldReads: () => heldReads.length,
    releaseReads: () => { holdingReads = false; for (const answer of heldReads.splice(0)) answer(); },
    releaseLast: () => heldReads.pop()?.(),
    /** @param {boolean} now */
    holdsTurns: now => { holdingTurns = now; },
    running: () => turn !== null,
    endTurn: () => {
      turn?.end(`${JSON.stringify({ type: 'done', message: { chat: turnChat, n: turnN, at_ms: Date.now(), role: 'assistant', text: 'Two receipts.',
        end: 'done', ms: 1000, steps: [], model: 'synthetic-terra', thinking: 'high' } })}\n`);
      turn = null;
    },
    /** @param {number} count */
    asked: count => until(`${count} questions at the stand-in`, () => questions.length >= count),
    /** @param {boolean} now */
    holds: now => { holding = now; },
    readies,
    /** @param {number | null} ms */
    waits: ms => { hourAt = ms === null ? null : Date.now() + ms; },
    /** @param {string} now */
    signs: now => { login = now; },
    /** @param {boolean} now */
    failsLogin: now => { failingLogin = now; },
    /** @param {boolean} now */
    claude: now => { claude = now; },
    /** @param {boolean} now */
    defaultOff: now => { defaultOff = now; },
    /** @param {string} level */
    thinks: level => { defaultThinking = level; },
    /** @param {string} id */
    retire: id => { if (id) retired.add(id); else retired.clear(); },
    /** @param {string} model */
    hold: model => { heldPick = model; },
    held: () => held.length,
    release: () => { heldPick = ''; for (const answer of held.splice(0)) answer(); },
    /** @param {'wait' | 'held' | null} kind */
    refuseChat: kind => { chatRefusal = kind; },
    /** @param {boolean} now */
    answers: now => { answers = now; },
    unmake: () => { made = false; },
    /** @param {boolean} now */
    listFails: now => { listFails = now; },
    /** @param {boolean} now */
    holdLists: now => { listHeld = now; },
    /** @param {boolean} now */
    many: now => { many = now; },
    heldLists: () => heldLists.length,
    releaseList: () => heldLists.shift()?.(),
    /** @param {boolean} now */
    writes: now => { written = now; },
    /** @param {boolean} now */
    holdsRejoin: now => { holdingRejoin = now; },
    heldRejoins: () => heldRejoins.length,
    rejoinFollows: () => rejoinFollows,
    /**
     * @param {Record<string, unknown>} read
     * @param {Record<string, unknown>[] | null} events
     */
    settlesRejoin: (read, events) => {
      rejoinRead = read;
      rejoinEvents = events;
      holdingRejoin = false;
      for (const answer of heldRejoins.splice(0)) answer();
    },
    /** @param {{ kind: string, key: string }} event */
    tell: event => {
      seq += 1;
      for (const feed of feeds) feed.write(`id: chat-${seq}\ndata: ${JSON.stringify({ seq, at_ms: Date.now(), ...event })}\n\n`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(() => done(undefined)));
    },
  };
}

const seen = { shots: /** @type {string[]} */ ([]), waiting: '', capsules: /** @type {string[]} */ ([]) };
const page = pageHarness({ file: 'ask-page', seen, size: WINDOW, scrollbars: true, mutable: true, front: chatHome });

/** @type {Awaited<ReturnType<typeof page.journey>>['chrome']} */
let chrome;
/** @type {Awaited<ReturnType<typeof chatHome>>} */
let front;

before(async () => {
  await page.open();
  ({ chrome, front } = await page.journey('ask-page'));
});

afterEach(() => {
  assert.deepEqual(chrome?.thrown.splice(0), []);
});

after(() => page.close());

const answered = `document.querySelector('.ck-answer__words .ck-cites') !== null`;
const capsules = () => chrome.evaluate(`[...document.querySelectorAll('.ck-answer__words .ck-cite')]
  .filter(each => !each.closest('.ck-flist')).map(each => each.textContent.replace(/\\u00A0/gu, ' '))`);

/** @param {string} selector */
async function press(selector) {
  await chrome.until(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    return found.length !== 1 || document.getAnimations().every(each => !(each.effect instanceof KeyframeEffect)
      || !each.effect.target?.contains(found[0]) || each.effect.getComputedTiming().endTime === Infinity); })()`, `${selector} still`);
  const [x, y] = await chrome.evaluate(`(() => { const found = document.querySelectorAll(${JSON.stringify(selector)});
    if (found.length !== 1) throw new Error(${JSON.stringify(selector)} + ' names ' + found.length);
    const box = found[0].getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2]; })()`);
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

const KEYS = /** @type {Record<string, [number, string]>} */ ({ Escape: [27, ''], ArrowDown: [40, ''], Enter: [13, '\r'] });

/** @param {string} key */
async function key(key) {
  const [code, text] = KEYS[key];
  await chrome.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: key,
    windowsVirtualKeyCode: code, text, unmodifiedText: text });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
}

/**
 * @param {'model' | 'thinking'} name
 * @param {string} value
 */
async function pick(name, value) {
  await press('.ck-pick .ck-fmenu__btn');
  await chrome.until(`document.querySelector('.ck-pick .ck-fmenu__panel')?.hidden === false`);
  if (name === 'model') {
    await press('.ck-pick [data-value="models"]');
    await chrome.until(`document.querySelector('.ck-pick [data-value="model:${value}"]')?.hidden === false`);
  }
  await press(`.ck-pick .ck-fmenu__item[data-value="${name}:${value}"]`);
}
const CHIP = '.ck-pick .ck-pick__words';
const OFFERED = `[...document.querySelectorAll('.ck-pick .ck-fmenu__item[data-value^="model:"]:not([aria-disabled="true"])')].map(each => each.dataset.value.slice(6))`;
const LISTED = `[...document.querySelectorAll('.ck-pick .ck-fmenu__item[data-value^="model:"]')].map(each => each.dataset.value.slice(6))`;

const FIRST = '.ck-answer__words p:first-of-type .ck-cites';
const menuOpen = `document.querySelector('${FIRST} .ck-fmenu__panel')?.hidden === false`;
const MOMENT = 'aside[aria-label="Moment"].is-open';

describe('ask-page: Chat on the Mac', () => {
  test('C1: the page is called Chat, under its star', async () => {
    await chrome.load(`#view=ask&chat=${CHAT}`, '');
    await chrome.until(answered);
    assert.equal(await page.words('#sidebar-sections .sidebar__item.is-on'), 'Chat');
    assert.equal(await page.words('.ak-bar__title'), 'Synthetic receipts');
    assert.match(await chrome.evaluate('document.title'), /^Chat/u);
    assert.match(await chrome.evaluate(`document.querySelector('#sidebar-sections .sidebar__item.is-on .ck-icon').innerHTML`), /M128,24C134,88/u);
    await page.shot('thread', answered);
  });

  test('C22: the head draws its line across the pane once the thread scrolls under it, and none at its top', async () => {
    const stage = `document.querySelector('.ak-stage')`;
    const kept = await chrome.evaluate(`${stage}.scrollTop`);
    await chrome.size(1600, 1000);
    await chrome.until('innerWidth === 1600');
    await chrome.evaluate(`(() => {
      const room = Object.assign(document.createElement('div'), { id: 'test-room' });
      room.style.height = '2000px';
      document.querySelector('.ak-stage .ck-ask-thread').append(room);
    })()`);
    await chrome.until(`${stage}.scrollHeight > ${stage}.clientHeight + 200`, 'the thread runs past the pane');
    await chrome.evaluate(`${stage}.scrollTop = 0`);
    await chrome.until(`!document.querySelector('.ak').classList.contains('is-scrolled')`, 'at the top');
    assert.equal(await chrome.evaluate(`getComputedStyle(document.querySelector('.ak-bar')).boxShadow`), 'none');
    await chrome.evaluate(`${stage}.scrollTop = 200`);
    await chrome.until(`document.querySelector('.ak').classList.contains('is-scrolled')`, 'scrolled');
    assert.deepEqual(await chrome.evaluate(`(() => {
      const bar = document.querySelector('.ak-bar'), pane = document.querySelector('.ak').getBoundingClientRect();
      return { line: /inset/u.test(getComputedStyle(bar).boxShadow), across: bar.getBoundingClientRect().width === pane.width,
        tools: Math.round(pane.right - bar.querySelector('.ck-page__tools').getBoundingClientRect().right) };
    })()`), { line: true, across: true, tools: 24 });
    await page.shot('thread-scrolled', `document.querySelector('.ak').classList.contains('is-scrolled')`);
    await chrome.size(WINDOW.width, WINDOW.height);
    await chrome.until(`innerWidth === ${WINDOW.width}`);
    await chrome.evaluate(`document.getElementById('test-room').remove(); ${stage}.scrollTop = ${kept}`);
  });

  test('C2 C3: past two sources at one place, the first two and how many more, in the line of the words; two stand as two', async () => {
    seen.capsules = await capsules();
    assert.deepEqual(seen.capsules, ['1', '2', '+2', '2', '5', '5', '6', '+1', '1', '5', '+1', '8']);
    assert.equal(await page.count('.ck-answer__words p'), 4, 'the menu ended its paragraph');
    assert.deepEqual(await chrome.evaluate(`(() => { const ids = [...document.querySelectorAll('.ck-answer [id]')].map(each => each.id);
      return ids.filter((id, at) => ids.indexOf(id) !== at); })()`), []);
    const inline = await chrome.evaluate(`(() => {
      const box = document.querySelector('${FIRST} button').getBoundingClientRect();
      const range = document.createRange();
      const text = [...document.querySelectorAll('.ck-answer__words p:first-child .ck-answer__w')].find(each => each.textContent === 'The'
        && each.nextElementSibling?.textContent === 'last');
      range.selectNode(text);
      const after = range.getClientRects()[0];
      return Math.abs((box.top + box.height / 2) - (after.top + after.height / 2));
    })()`);
    assert.ok(inline < 4, `the words after the capsule stand ${inline} away from its line`);
  });

  test('C4: the capsule’s menu lists each source and opens its moment; keys; the panel stands under it; the focus comes back', async () => {
    await press(`${FIRST} button`);
    await chrome.until(menuOpen);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('${FIRST} .ck-fmenu__item')].map(each => each.textContent)`),
      [3, 4].map(n => `${n}Synthetic booking receipt ${n}${dayOf(n)}`));
    await page.shot('menu', menuOpen);
    await key('Escape');
    await chrome.until(`!(${menuOpen})`);
    assert.equal(await page.count(MOMENT), 0, 'a moment opened');

    await press(`${FIRST} button`);
    await chrome.until(menuOpen);
    await press(`${FIRST} .ck-fmenu__item[data-value="r3"]`);
    const moment = `document.querySelector('.ck-step__value')?.textContent === '3 of 8'`;
    await chrome.until(moment);
    await chrome.until(`document.querySelector('${FIRST} > button').classList.contains('is-open')`);
    await page.shot('moment', moment);

    await press(`${FIRST} > button`);
    await chrome.until(menuOpen);
    assert.equal(await page.count(MOMENT), 1, 'the panel closed under the press');
    await key('ArrowDown');
    await key('Enter');
    await chrome.until(`document.querySelector('.ck-step__value')?.textContent === '4 of 8'`);

    await key('Escape');
    await chrome.until(`document.querySelector('${MOMENT}') === null && document.activeElement === document.querySelector('${FIRST} > button')`);

    const alone = '.ck-answer__words button[data-ask-cite$=" r2"][data-ck-place="1"]';
    assert.equal(await page.count(alone), 1);
    await press(alone);
    await chrome.until(`document.querySelector('.ck-step__value')?.textContent === '2 of 8' && document.querySelector('${MOMENT}') !== null`);
    await key('Escape');
    await chrome.until(`document.querySelector('${MOMENT}') === null && document.activeElement === document.querySelector('${alone}')`);

    await press(`${FIRST} > button`);
    await chrome.until(menuOpen);
    await press(`${FIRST} .ck-fmenu__item[data-value="r4"]`);
    await chrome.until(`document.querySelector('${MOMENT}') !== null`);
    await press(`${FIRST} > button`);
    await chrome.until(menuOpen);
    await press('.ak-bar__title');
    await chrome.until(`!(${menuOpen}) && document.querySelector('${MOMENT}') === null`);
  });

  test('C7: a chat on a day is one source: one capsule, which opens it whole, each cited message marked', async () => {
    for (const [key, hour] of CHAT_LINES) {
      await page.command('message', { key, at: Date.parse(`${CHAT_DAY}T${hour}:00:00Z`), text: `synthetic ${key}` });
    }
    const one = '.ck-answer__words button[data-ask-cite$=" r8"]';
    assert.equal(await page.count(one), 1);
    assert.equal(await page.count('.ck-answer__words button[data-ask-cite$=" r9"]'), 0);
    await press(one);
    await chrome.until(`document.querySelector('.ck-step__value')?.textContent === '8 of 8' && document.querySelectorAll('${MOMENT} .ck-msg').length === 3`);
    assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('${MOMENT} .ck-msg')].map(each => each.classList.contains('is-marked'))`), [true, false, true]);
    assert.match(await chrome.evaluate(`document.querySelector('${MOMENT} .ck-inspector__meta')?.textContent`), /09:00.17:00/u);
    await page.shot('chat-on-a-day', `document.querySelectorAll('${MOMENT} .ck-msg.is-marked').length === 2`);
    await key('Escape');
    await chrome.until(`document.querySelector('${MOMENT}') === null`);
  });

  test('C5: the clock opens the conversations under it, Search focused, the open one lit; typing keeps the titles holding the words, ↓ and Return open one', async () => {
    const toggle = '.ak-bar [data-ask-action="chats"]';
    const row = `#ak-chats [data-ask-chat="${CHAT}"]`;
    const find = '#ak-chats [data-part="chat-find"]';
    const opened = `document.querySelector('#ak-chats')?.classList.contains('is-open')`;
    const still = `!document.querySelector('#ak-chats').getAnimations().length`;
    await chrome.until(`document.querySelector('${row}') !== null && ${answered}`);
    assert.equal(await chrome.evaluate(`document.querySelector('${toggle}').getAttribute('aria-expanded')`), 'false');
    await press(toggle);
    await chrome.until(`${opened} && ${still} && document.activeElement === document.querySelector('${find}')`);
    assert.equal(await chrome.evaluate(`document.querySelector('${toggle}').getAttribute('aria-expanded')`), 'true');
    assert.equal(await page.words(row), 'Synthetic receipts');
    assert.equal(await chrome.evaluate(`document.querySelector('${row}').getAttribute('aria-current')`), 'true');
    const [panel, button] = await chrome.evaluate(`[document.querySelector('#ak-chats').getBoundingClientRect(),
      document.querySelector('${toggle}').getBoundingClientRect()].map(box => ({ left: box.left, top: box.top, bottom: box.bottom }))`);
    assert.ok(Math.abs(panel.left - button.left) <= 1, `the panel stands ${panel.left - button.left} off the clock's edge`);
    assert.ok(panel.top > button.bottom && panel.top - button.bottom <= 8, `the panel stands ${panel.top - button.bottom} under the clock`);
    await page.shot('conversations', `${opened} && ${still}`);
    await chrome.evaluate(`(() => { const field = document.querySelector('${find}'); field.value = 'zzz';
      field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await chrome.until(`document.querySelector('#ak-chats .ck-none')?.textContent === 'No conversations match “zzz”.'`);
    await chrome.evaluate(`(() => { const field = document.querySelector('${find}'); field.value = 'RECEIPTS';
      field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await chrome.until(`document.querySelectorAll('#ak-chats [data-ask-chat]').length === 1 && document.querySelector('${row}') !== null`);
    await key('ArrowDown');
    await chrome.until(`document.activeElement === document.querySelector('${row}')`);
    await key('Escape');
    await chrome.until(`!${opened} && document.activeElement === document.querySelector('${toggle}')`);

    await press('.ak-bar [data-ask-action="new"]');
    await chrome.until(`!document.querySelector('.ak-stage--thread')`);
    assert.equal(await chrome.evaluate(`[...document.querySelectorAll('.ak-stage [data-ask-chat], .ak-stage .ck-ask-starter')]
      .filter(each => each.checkVisibility()).length`), 0, 'the blank page lists the conversations');
    await press(toggle);
    await chrome.until(`${opened} && document.querySelector('${find}').value === '' && document.querySelector('#ak-chats .ck-chat.is-selected') === null`);
    await press('.ak-bar');
    await chrome.until(`!${opened}`);
    await press(toggle);
    await chrome.until(`${opened} && document.activeElement === document.querySelector('${find}')`);
    await chrome.evaluate(`(() => { const field = document.querySelector('${find}'); field.value = 'receipts';
      field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await chrome.until(`document.querySelector('#ak-chats [data-ask-chat]') === document.querySelector('${row}')`);
    await key('Enter');
    await chrome.until(`${answered} && location.hash.includes('${CHAT}') && !${opened}`);
  });

  test('C15: a home with no conversations: its three starters under the composer, which stands where it stood; one pressed is asked', async () => {
    const composerTop = `Math.round(document.querySelector('.ak-stage .ck-composer').getBoundingClientRect().top)`;
    await chrome.load('#view=ask', '');
    await chrome.until(`document.querySelector('#ak-chats [data-ask-chat]') && document.querySelector('.ck-pick')`);
    assert.equal(await page.count('.ck-ask-starter'), 0, 'starters beside conversations');
    const listed = await chrome.evaluate(composerTop);
    front.holds(false);
    try {
      await chrome.load('#view=ask', '');
      await chrome.until(`document.querySelectorAll('.ck-ask-starter').length === 3`);
      assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-ask-starter')].map(each => each.textContent)`),
        STARTERS.map(each => each.question));
      assert.equal(await chrome.evaluate(composerTop), listed, 'the starters moved the composer');
      assert.equal(await page.words('#ak-chats .ak-chats__list'), 'No conversations yet.');
      await page.shot('starters', `document.querySelectorAll('.ck-ask-starter').length === 3`);
      const before = front.questions.length;
      await press('.ck-ask-starter[data-ask-starter="0"]');
      await front.asked(before + 1);
      assert.equal(front.questions.at(-1)?.question, STARTERS[0].question);
    } finally {
      front.holds(true);
    }
  });

  test('C6: a pick stays as picked when it becomes the default and after; the Thinking pill names the model’s own level', async () => {
    front.claude(true);
    try {
      await chrome.load('#view=ask', 'try { localStorage.removeItem("lifestream.ask.pick"); } catch {}');
      const items = () => chrome.evaluate(OFFERED);
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Opus · Low'`);
      await pick('model', 'synthetic-terra');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · High'`);
      front.claude(false);
      front.tell({ kind: 'models', key: 'models' });
      await until('Claude’s models left out of the menu', async () => !(await items()).some(id => id.startsWith('claude/')));
      assert.equal((await chrome.evaluate(LISTED)).includes('claude/synthetic-opus'), false);
      assert.equal(front.readies.at(-1)?.model, 'synthetic-terra');
      front.claude(true);
      front.tell({ kind: 'models', key: 'models' });
      await until('Claude’s models offered again', async () => (await items()).some(id => id.startsWith('claude/')));
      assert.equal(await page.words(CHIP), 'Synthetic Terra · High');
      assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('.ck-pick [data-value^="model:"][aria-checked="true"]')].map(each => each.dataset.value)`),
        ['model:synthetic-terra']);
      assert.deepEqual(await chrome.evaluate('JSON.parse(localStorage.getItem("lifestream.ask.pick"))'), { model: 'synthetic-terra', thinking: '' });
      const before = front.questions.length;
      await chrome.evaluate(`(() => { const field = document.querySelector('.ck-composer textarea'); field.value = 'Which one?';
        field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await press('.ck-composer__send');
      await chrome.until(`document.querySelector('.ck-ask-q__words')?.textContent === 'Which one?'`);
      await front.asked(before + 1);
      const { submission, ...asked } = front.questions.at(-1) ?? {};
      assert.match(String(submission), /^[0-9a-f]{32}$/u);
      assert.deepEqual(asked, { question: 'Which one?', model: 'synthetic-terra' });
    } finally {
      front.claude(false);
    }
  });

  test('C28: the default and its level are the answer’s: a question with no pick names the default’s level, a pick its model’s own, Reset the default’s again', async () => {
    front.thinks('low');
    try {
      await chrome.load('#view=ask', 'try { localStorage.removeItem("lifestream.ask.pick"); } catch {}');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · Low'`);
      await pick('model', 'synthetic-luna');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Luna · Medium'`);
      await pick('model', 'synthetic-terra');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · High'`);
      await press('.ck-pick .ck-fmenu__btn');
      await chrome.until(`document.querySelector('.ck-pick .ck-fmenu__panel')?.hidden === false`);
      await press('.ck-pick .ck-fmenu__item[data-value="reset"]');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · Low'`);
    } finally {
      front.thinks('');
    }
  });

  test('C29: no default model: the first model’s line, the composer waits, nothing checked; a ready model picked is asked on', async () => {
    front.defaultOff(true);
    try {
      await chrome.load('#view=ask', 'try { localStorage.removeItem("lifestream.ask.pick"); } catch {}');
      const line = `document.querySelector('.ak-stage .ck-in-place .mac-body')?.textContent`;
      await chrome.until(`${line} === ${JSON.stringify(CLAUDE_OUT)}`);
      assert.equal(await chrome.evaluate(`document.querySelector('.ck-composer textarea').disabled`), true);
      assert.equal(await page.count('.ck-pick [data-value^="model:"][aria-checked="true"]'), 0);
      await pick('model', 'synthetic-luna');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Luna · Medium'
        && !document.querySelector('.ck-composer textarea').disabled && ${line} === undefined`);
      const before = front.questions.length;
      await chrome.evaluate(`(() => { const field = document.querySelector('.ck-composer textarea'); field.value = 'Which one?';
        field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await press('.ck-composer__send');
      await front.asked(before + 1);
      const { submission, ...asked } = front.questions.at(-1) ?? {};
      assert.match(String(submission), /^[0-9a-f]{32}$/u);
      assert.deepEqual(asked, { question: 'Which one?', model: 'synthetic-luna' });
    } finally {
      front.defaultOff(false);
      await chrome.evaluate('localStorage.removeItem("lifestream.ask.pick")');
    }
  });

  test('C12: a kept pick whose model is not ready: its line is the answer’s, as given, the composer waits, the pick kept and left out of the menu', async () => {
    const kept = { model: 'claude/synthetic-opus', thinking: 'high' };
    await chrome.load('#view=ask', `try { localStorage.setItem("lifestream.ask.pick", ${JSON.stringify(JSON.stringify(kept))}); } catch {}`);
    const line = `document.querySelector('.ak-stage .ck-in-place .mac-body')?.textContent`;
    await chrome.until(`${line} === ${JSON.stringify(CLAUDE_OUT)}`);
    assert.equal(front.readies.at(-1)?.model, kept.model);
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-composer textarea').disabled`), true);
    assert.equal(await page.count('.ak-stage .ck-in-place button'), 0);
    assert.equal(await page.words(CHIP), 'Synthetic Opus · High');
    assert.equal((await chrome.evaluate(LISTED)).includes('claude/synthetic-opus'), false);
    assert.deepEqual(await chrome.evaluate('JSON.parse(localStorage.getItem("lifestream.ask.pick"))'), kept);
    await page.shot('pick-signed-out', `${line} === ${JSON.stringify(CLAUDE_OUT)}`);
  });

  test('C13: only the newest read is drawn: a late `gone` for a pick since changed keeps the newer pick; a `gone` for the pick kept forgets it', async () => {
    await chrome.load('#view=ask', 'try { localStorage.setItem("lifestream.ask.pick", JSON.stringify({ model: "synthetic-gone", thinking: "low" })); } catch {}');
    await until('the pick read', () => front.readies.some(each => each.model === 'synthetic-gone'));
    await chrome.until(`localStorage.getItem('lifestream.ask.pick') === JSON.stringify({ model: '', thinking: '' })`);
    try {
      await chrome.evaluate('performance.clearResourceTimings()');
      front.hold('synthetic-sol');
      await pick('model', 'synthetic-sol');
      await until('the read for Sol held', () => front.held() > 0);
      front.retire('synthetic-sol');
      await pick('model', 'synthetic-luna');
      await chrome.until(`!${OFFERED}.includes('synthetic-sol')`);
      front.release();
      await chrome.until(`(() => { const sol = performance.getEntriesByType('resource').filter(each => each.name.includes('model=synthetic-sol'));
        return sol.length > 0 && sol.every(each => each.responseEnd > 0); })()`);
      const before = front.readies.length;
      await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
      await until('Ask read again', () => front.readies.length > before);
      assert.equal(front.readies.at(-1)?.model, 'synthetic-luna');
      assert.match(await page.words(CHIP), /^Synthetic Luna · /u);
      assert.deepEqual(await chrome.evaluate('JSON.parse(localStorage.getItem("lifestream.ask.pick"))'), { model: 'synthetic-luna', thinking: '' });
    } finally {
      front.release();
      front.retire('');
    }
  });

  test('C8: forty sources at one place are the first two and +38, its menu scrolls inside the window, the last opens', async () => {
    await chrome.load(`#view=ask&chat=${WIDE}`, '');
    await chrome.until(answered);
    assert.deepEqual(await capsules(), ['1', '2', '+38']);
    const wide = '.ck-answer__words .ck-cites';
    await press(`${wide} > button`);
    await chrome.until(`document.querySelector('${wide} .ck-fmenu__panel')?.hidden === false`);
    const menu = await chrome.evaluate(`(() => { const panel = document.querySelector('${wide} .ck-fmenu__panel');
      const box = panel.getBoundingClientRect();
      return { rows: panel.querySelectorAll('.ck-fmenu__item').length, top: box.top, bottom: box.bottom, height: innerHeight,
        scrolls: panel.scrollHeight > panel.clientHeight }; })()`);
    assert.equal(menu.rows, 38);
    assert.ok(menu.top >= 0 && menu.bottom <= menu.height, `the menu stands outside the window: ${JSON.stringify(menu)}`);
    assert.equal(menu.scrolls, true, 'the menu is as tall as its rows');
    await page.shot('forty-sources', `document.querySelector('${wide} .ck-fmenu__panel')?.hidden === false`);
    await chrome.evaluate(`document.querySelector('${wide} .ck-fmenu__item[data-value="r40"]').scrollIntoView({ block: 'nearest' })`);
    await press(`${wide} .ck-fmenu__item[data-value="r40"]`);
    await chrome.until(`document.querySelector('.ck-step__value')?.textContent === '40 of 40'`);
    await key('Escape');
    await chrome.until(`document.querySelector('${MOMENT}') === null`);
  });

  test('C9: a turn waiting whose hour passes on the open page is said over the composer, which stays usable; the line goes once Ask says the home took it', async () => {
    const line = `[...document.querySelectorAll('.ck-in-place')].some(each => each.textContent.includes('Recent chats are not saved to Lifestream yet.'))`;
    front.waits(1_500);
    const before = front.readies.length;
    await chrome.load('#view=ask', '');
    await until('Ask\'s state read', () => front.readies.length > before);
    assert.ok((front.readies[before].unsaved_in_ms ?? 0) > 0, JSON.stringify(front.readies[before]));
    await chrome.until(line);
    assert.ok(front.readies.slice(before).some(said => said.unsaved_in_ms === 0), JSON.stringify(front.readies.slice(before)));
    assert.equal(await chrome.evaluate(`document.querySelector('.ck-composer textarea').disabled`), false);
    await page.shot('unsaved', line);
    await chrome.load(`#view=ask&chat=${CHAT}`, '');
    await chrome.until(`${answered} && ${line}`);
    front.waits(null);
    await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await chrome.until(`!(${line})`);
  });

  test('C11: an answer not on disk yet says so under it with nothing to press, and the line goes once the home imports Chat\'s turns', async () => {
    const line = `[...document.querySelectorAll('.ck-ask-turn .ck-in-place')].some(each => each.textContent.includes('Not saved yet'))`;
    front.writes(false);
    try {
      await chrome.load(`#view=ask&chat=${SAVING}`, '');
      await chrome.until(`document.querySelector('.ck-answer') !== null && ${line}`);
      assert.equal(await page.count('.ck-ask-turn .ck-in-place button'), 0);
      assert.equal(await page.count('[data-ask-retry]'), 0);
      assert.equal(await page.count('.ck-answer__copy'), 1);
      await page.shot('not-saved', line);
      front.writes(true);
      front.tell({ kind: 'import', key: 'ask:local:macbook-pro-0001/20261020T110020000Z.0123456789ab' });
      await chrome.until(`!(${line}) && document.querySelector('.ck-answer') !== null`);
    } finally {
      front.writes(true);
    }
  });

  test('C23: a new conversation’s level is picked before its first question and rides it; the next question of a conversation carries a pick made in it, once; no level leaves the person did not pick; an older read never draws over a pick or a conversation’s kept level; while a turn runs the level chip names its level, dimmed', async () => {
    const PILL = `document.querySelector('[data-pick="privacy"] .ck-fmenu__btn')`;
    /**
     * @param {string} words
     * @param {boolean} enabled
     */
    const pill = (words, enabled) => `${PILL}?.textContent === ${JSON.stringify(words)} && ${PILL}.disabled === ${!enabled}`;
    const type = (/** @type {string} */ words) => chrome.evaluate(`(() => { const field = document.querySelector('.ck-composer textarea');
      field.value = ${JSON.stringify(words)}; field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    let step = 0;
    /** @param {string} ready */
    const reach = async ready => {
      step += 1;
      try {
        await chrome.until(ready);
      } catch (error) {
        const stood = await chrome.evaluate(`(() => { const box = document.querySelector('[data-pick="privacy"] .ck-fmenu__btn')?.getBoundingClientRect();
          const at = box && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return location.hash + ' | ' + document.querySelector('.ck-composer')?.className + ' | ' + JSON.stringify(box) + ' ' + innerHeight + ' | at: '
          + (at?.outerHTML.slice(0, 200) ?? 'none'); })()`);
        throw new Error(`C23 wait ${step}: ${/** @type {Error} */ (error).message}\n${stood}`);
      }
    };
    /** @param {string} value */
    const choose = async value => {
      await press('[data-pick="privacy"] .ck-fmenu__btn');
      await reach(`document.querySelector('[data-pick="privacy"] .ck-fmenu__panel')?.hidden === false`);
      await press(`[data-pick="privacy"] .ck-fmenu__item[data-value="${value}"]`);
    };
    front.sets('none');
    try {
      await chrome.load('#view=ask', `try { localStorage.removeItem("lifestream.ask.pick"); } catch {}
        window.levelReads = { start: 0, level: 0 };
        const json = Response.prototype.json;
        Response.prototype.json = async function () {
          const value = await json.call(this);
          const kind = /\\/api\\/privacy$/u.test(this.url) ? 'start' : /\\/api\\/ask\\/privacy\\?/u.test(this.url) ? 'level' : '';
          if (kind) setTimeout(() => { window.levelReads[kind] += 1; });
          return value;
        };`);
      await reach(pill('Don’t hide', true));
      front.holdsTurns(true);
      const before = front.questions.length;
      await type('Which receipts?');
      await press('.ck-composer__send');
      await until('the turn running at the stand-in', () => front.running());
      await reach(pill('Don’t hide', false));
      assert.equal(await chrome.evaluate(`${PILL}.getAttribute('aria-label')`), 'Sensitive information: Don’t hide');
      await page.shot('privacy-while-running', pill('Don’t hide', false));
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], [undefined, '']);
      const first = String(front.named.at(-1));
      assert.equal(front.levels.get(first), 'none');
      front.endTurn();
      await reach(pill('Don’t hide', true));
      const MENU = `document.querySelector('[data-pick="privacy"] .ck-fmenu__panel')`;
      await press('[data-pick="privacy"] .ck-fmenu__btn');
      await reach(`${MENU}?.hidden === false`);
      assert.deepEqual(await chrome.evaluate(`[...${MENU}.children].map(each => each.textContent)`),
        ['Sensitive information', 'Hide all', 'Keep names', 'Don’t hide']);
      await page.shot('level-menu', `${MENU}?.hidden === false`);
      await press('[data-pick="privacy"] .ck-fmenu__item[data-value="names"]');
      await reach(pill('Keep names', true));
      await type('And the total?');
      await press('.ck-composer__send');
      await until('the second turn running at the stand-in', () => front.running());
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], ['names', first]);
      assert.equal(front.levels.get(first), 'names');
      front.endTurn();
      await reach(pill('Keep names', true));
      front.levels.set(first, 'all');
      await type('And the date?');
      await press('.ck-composer__send');
      await until('the third turn running at the stand-in', () => front.running());
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], [undefined, first]);
      assert.equal(front.levels.get(first), 'all');
      await reach(pill('Hide all', false));
      front.holdsTurns(false);
      front.endTurn();
      await reach(pill('Hide all', true));
      await choose('none');
      await reach(pill('Don’t hide', true));
      await type('And the tax?');
      await press('.ck-composer__send');
      await front.asked(before + 4);
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], ['none', first]);
      await reach(pill('Hide all', true));
      assert.equal(front.levels.get(first), 'all');
      front.levels.set(first, 'all');
      front.holdsTurns(true);
      await type('And the tip?');
      await press('.ck-composer__send');
      await until('the fifth turn running at the stand-in', () => front.running());
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], [undefined, first]);
      assert.equal(front.levels.get(first), 'all');
      await reach(pill('Hide all', false));
      front.holdsTurns(false);
      front.endTurn();
      await reach(pill('Hide all', true));
      await choose('none');
      await reach(pill('Don’t hide', true));
      front.failsLogin(true);
      await type('And the fee?');
      await press('.ck-composer__send');
      await front.asked(before + 6);
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], ['none', first]);
      await reach(pill('Hide all', true));
      assert.equal(front.levels.get(first), 'all');
      front.failsLogin(false);
      await type('');

      await reach(`${pill('Hide all', true)} && document.querySelector('.ak-dock').getAnimations().length === 0`);
      await press('.ak-bar [data-ask-action="new"]');
      await reach(pill('Don’t hide', true));
      const levelsRead = Number(await chrome.evaluate('window.levelReads.level'));
      await chrome.evaluate(`location.hash = '#view=ask&chat=${first}'`);
      await reach(`document.querySelector('.ak-bar [data-ask-action="new"]') !== null && window.levelReads.level === ${levelsRead + 1}`);
      front.holdsReads(true);
      await press('.ak-bar [data-ask-action="new"]');
      await until('Chat’s setting read held', () => front.heldReads() === 1);
      await reach(pill('Don’t hide', true));
      await page.shot('new-conversation-privacy', pill('Don’t hide', true));
      await choose('all');
      await reach(pill('Hide all', true));
      front.releaseReads();
      await reach(pill('Hide all', true));
      await page.shot('new-conversation-privacy-picked', pill('Hide all', true));
      front.holdsTurns(true);
      await type('Did Person A pay?');
      await press('.ck-composer__send');
      await until('the new conversation’s first turn running at the stand-in', () => front.running());
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], ['all', '']);
      assert.equal(front.levels.get(String(front.named.at(-1))), 'all');
      assert.notEqual(front.named.at(-1), first);
      front.holdsTurns(false);
      front.endTurn();

      await reach(`document.querySelector('.ak-dock').getAnimations().length === 0`);
      front.sets('all');
      front.holdsReads(true);
      await press('.ak-bar [data-ask-action="new"]');
      await until('the draft’s setting read held', () => front.heldReads() === 1);
      front.sets('none');
      front.holdsTurns(true);
      await type('Which receipts again?');
      await press('.ck-composer__send');
      await until('the new conversation’s turn running at the stand-in', () => front.running());
      assert.deepEqual([front.questions.at(-1)?.level, front.askedIn.at(-1)], [undefined, '']);
      assert.equal(front.levels.get(String(front.named.at(-1))), 'none');
      await until('the new conversation’s level read held', () => front.heldReads() === 2);
      const starts = Number(await chrome.evaluate('window.levelReads.start'));
      front.releaseLast();
      await reach(pill('Don’t hide', false));
      front.releaseReads();
      await reach(`window.levelReads.start === ${starts + 1}`);
      await reach(pill('Don’t hide', false));
      front.endTurn();
      await reach(pill('Don’t hide', true));
    } finally {
      front.sets('all');
      front.holdsTurns(false);
      front.endTurn();
      front.holdsReads(false);
      front.failsLogin(false);
      front.releaseReads();
    }
  });

  test('C10: Chat needing a sign-in says the Ask server’s line; in the Mac window its link names the plan and opens Settings at Providers over Chat', async () => {
    front.signs('signed_out');
    try {
      const line = `document.querySelector('.ak-stage .ck-in-place .mac-body')?.textContent`;
      await chrome.load('#view=ask', '');
      await chrome.until(`${line} === ${JSON.stringify(CLAUDE_OUT)}`);
      assert.equal(await page.count('.ak-stage .ck-in-place button'), 0);
      await chrome.load('#view=ask', hostScript(hostState({ more: { setup: { state: 'done', error: null } } })));
      const LINK = '[data-ask-action="sign-in"]';
      await chrome.until(`document.querySelector('${LINK}')?.textContent.trim() === 'Sign in with Claude…'`);
      assert.equal(await chrome.evaluate(line), CLAUDE_OUT);
      await page.shot('sign-in-needed', `document.querySelector('${LINK}') !== null`);
      await press(LINK);
      await chrome.until(`location.hash.includes('view=ask') && decodeURIComponent(location.hash).includes('dialog=settings/providers')
        && document.querySelector('.ck-dialog [data-flow="connect:claude"]') !== null`);
      assert.equal(await chrome.evaluate(`location.hash.includes('flow=')`), false, 'a flow of its own');
      await page.shot('sign-in-in-settings', `document.querySelector('.ck-dialog [data-flow="connect:chatgpt"]') !== null`);
      await key('Escape');
      await chrome.until(`!location.hash.includes('dialog=') && location.hash.includes('view=ask') && document.querySelector('${LINK}') !== null`);
      const keyTurned = () => front.tell({ kind: 'models', key: 'models' });
      front.signs('ready');
      keyTurned();
      await chrome.until(`document.querySelector('${LINK}') === null`, 'ready once the key is held');
      front.signs('signed_out');
      keyTurned();
      await chrome.until(`document.querySelector('${LINK}') !== null`, 'a sign-in needed once the key is gone');
    } finally {
      front.signs('ready');
    }
  });

  test('C25: a person, a chat and a place an answer cites open People and Places at the id the door\'s citation of each names', async () => {
    await chrome.load(`#view=ask&chat=${NAMES}`, '');
    await chrome.until(`document.querySelectorAll('.ck-answer__words button[data-ask-cite]').length === 3`);
    const listed = await chrome.evaluate(`Promise.all([fetch('api/life/people').then(answer => answer.json()), fetch('api/life/places').then(answer => answer.json())])
      .then(([people, places]) => ({ person: people.people.find(each => each.name === 'Person B')?.id ?? '',
        chat: people.chats.find(each => (each.label || each.chat) === 'Group Alpha')?.key ?? '',
        place: places.places[0]?.slug ?? '', name: places.places[0]?.name ?? '' }))`);
    assert.ok(listed.person && listed.chat && listed.place && listed.name, JSON.stringify(listed));
    Object.assign(front.namedIds, { r1: listed.person, r2: listed.chat, r3: listed.place });
    for (const [handle, view, focus, shown, name] of [['r1', 'people', listed.person, '.pp-head__title', 'Person B'],
      ['r2', 'people', `chat:${listed.chat}`, '.pp-head__title', 'Group Alpha'], ['r3', 'places', listed.place, '.pl-card__title', listed.name]]) {
      await chrome.load(`#view=ask&chat=${NAMES}`, '');
      await chrome.until(`document.querySelectorAll('.ck-answer__words button[data-ask-cite]').length === 3`);
      await press(`.ck-answer__words button[data-ask-cite$=" ${handle}"]`);
      await chrome.until(`(() => { const route = new URLSearchParams(location.hash.slice(1));
        return route.get('view') === ${JSON.stringify(view)} && route.get('focus') === ${JSON.stringify(focus)}
          && document.querySelector(${JSON.stringify(shown)})?.textContent === ${JSON.stringify(name)}; })()`);
      await page.shot(`cited-${view}-${handle}`, `document.querySelector(${JSON.stringify(shown)})?.textContent === ${JSON.stringify(name)}`);
    }
    assert.deepEqual(front.readsAsked, []);
  });

  test('C26: a redraw keeps what the page\'s own scripts gave an element it drew (a photo loaded stays loaded, a failed one stays failed), markup a whole draw inserted too, and what the drawing changes still changes; a photo of another source is a new node', async () => {
    const drawn = await chrome.evaluate(`(async () => {
      const { adopt, morph } = await import('/ui/kit/index.js');
      const draw = markup => { const shell = document.createElement('div'); shell.innerHTML = markup; return shell.firstElementChild; };
      const host = document.createElement('div');
      host.innerHTML = '<div><button class="ck-pics__pic"><img class="ck-pic" data-src="/a"></button><p>One</p></div>';
      adopt(host);
      const img = host.querySelector('img');
      img.setAttribute('src', 'data:,');
      img.classList.add('is-loaded');
      host.querySelector('button').classList.add('is-failed');
      morph(host.firstElementChild, draw('<div><button class="ck-pics__pic"><img class="ck-pic" data-src="/a"></button><p>One two</p></div>'));
      const kept = { same: host.querySelector('img') === img, src: img.getAttribute('src'), img: img.className,
        button: host.querySelector('button').className, words: host.querySelector('p').textContent };
      morph(host.firstElementChild, draw('<div class="is-done"><button class="ck-pics__pic"><img class="ck-pic" data-src="/b"></button><p>One two</p></div>'));
      const fresh = host.querySelector('img');
      const stray = document.createElement('div');
      let refused = '';
      try {
        morph(stray, draw('<div class="next"></div>'));
      } catch (error) {
        refused = error.message;
      }
      return { kept, changed: [host.firstElementChild.className, fresh === img, fresh.getAttribute('data-src'), fresh.getAttribute('src'), fresh.className], refused };
    })()`);
    assert.deepEqual(drawn.kept, { same: true, src: 'data:,', img: 'ck-pic is-loaded', button: 'ck-pics__pic is-failed', words: 'One two' },
      'a thread drawn whole mid-answer, then patched, keeps its loaded photo');
    assert.deepEqual(drawn.changed, ['is-done', false, '/b', null, 'ck-pic'], 'a changed photo never keeps the old one\'s bytes');
    assert.equal(drawn.refused, 'morph met a node no draw adopted');
  });

  test('C24: a rejoin while a question\'s keep is held waits on the Ask server\'s read, then follows the turn begun to its answer, or shows the refusal of a server closing as the question and its answer failed', async () => {
    const asked = `[...document.querySelectorAll('.ck-ask-q__words')].map(each => each.textContent)`;
    const lastWords = `[...document.querySelectorAll('.ck-answer__words')].at(-1)?.textContent.trim()`;
    /** @param {string} ready */
    const reach = async ready => {
      try {
        await chrome.until(ready);
      } catch (error) {
        const stood = await chrome.evaluate(`document.querySelector('.ck-ask-thread')?.innerText ?? 'no thread'`);
        throw new Error(`${/** @type {Error} */ (error).message}\nfollows: ${front.rejoinFollows()}\n${stood}`);
      }
    };
    front.holdsRejoin(true);
    await chrome.load(`#view=ask&chat=${REJOIN}`, '');
    await until('the page\'s read of the conversation held', () => front.heldRejoins() >= 1);
    assert.deepEqual(await chrome.evaluate(asked), []);
    front.settlesRejoin({ chat: REJOIN, title: 'Synthetic parcel', messages: [...REJOIN_KEPT, rejoinAsked(3, REJOIN_ASKED)], running: { n: 4 } }, [
      { type: 'chat', chat: REJOIN, n: 4, level: 'names' },
      { type: 'text', delta: 'Yes.' },
      { type: 'done', message: rejoinAnswer(4, 'Yes.') },
    ]);
    await reach(`${lastWords} === 'Yes.'`);
    assert.deepEqual(await chrome.evaluate(asked), ['Did the synthetic parcel come?', REJOIN_ASKED]);
    assert.equal(front.rejoinFollows(), 1);
    const kept = [...REJOIN_KEPT, rejoinAsked(3, REJOIN_ASKED), rejoinAnswer(4, 'Yes.')];
    front.holdsRejoin(true);
    await chrome.load(`#view=ask&chat=${REJOIN}`, '');
    await until('the page\'s read of the conversation held again', () => front.heldRejoins() >= 1);
    assert.deepEqual(await chrome.evaluate(asked), []);
    front.settlesRejoin({ chat: REJOIN, title: 'Synthetic parcel', messages: [...kept, rejoinAsked(5, 'And the ferry?'),
      { type: 'ask.msg', chat: REJOIN, n: 6, at_ms: REJOIN_AT + 5 * 60_000, role: 'assistant', text: '', end: 'failed', error: RESTARTING, failed: 'restart' }] }, null);
    const failedLine = `[...document.querySelectorAll('.ck-ask-turn .ck-in-place')].at(-1)?.textContent.includes('Chat restarted before it finished.')`;
    await reach(`${failedLine} === true`);
    assert.deepEqual(await chrome.evaluate(asked), ['Did the synthetic parcel come?', REJOIN_ASKED, 'And the ferry?']);
    assert.equal(front.rejoinFollows(), 1);
    await page.shot('rejoin-refused', `${failedLine} === true`);
  });

  test('C27: the eye beside Copy turns its turn into what the model read and wrote, detail by detail, and back; Reduce Motion swaps it in one step', async () => {
    await chrome.load(`#view=ask&chat=${SEEN_CHAT}`, '');
    const eye = '.ck-answer__foot [data-ck-seen-eye]';
    await chrome.until(`document.querySelector('${eye}') !== null`);
    assert.deepEqual(await chrome.evaluate(`(() => { const eye = document.querySelector('${eye}');
      return [eye.getAttribute('aria-label'), eye.getAttribute('aria-pressed'), eye.title, eye.previousElementSibling?.getAttribute('aria-label')]; })()`),
    ['What the model saw', 'false', 'Show what the model saw', 'Copy answer']);
    const drawn = `[document.querySelector('.ck-ask-q__words').innerText, document.querySelector('.ck-answer__words').innerText.trim()]`;
    const settled = `document.querySelector('.ck-ask-turn .ck-seen:is(.is-turning, .is-said, .is-words)') === null`;
    const [asked, answered] = await chrome.evaluate(drawn);
    assert.equal(asked, CITED.words);
    /** @param {string} shown @param {string} text @param {{ start: number, end: number, placeholder?: string }[]} spans */
    const standing = (shown, text, spans) => spans.reduce((out, span) => span.placeholder === undefined ? out
      : out.replace(text.slice(span.start, span.end), span.placeholder.slice(2, -2)), shown);
    const model = [standing(asked, CITED.words, CITED.seen.asked), standing(answered, CITED.answer, CITED.seen.answered)];
    assert.notDeepEqual(model, [asked, answered]);
    await press(eye);
    await chrome.until(`document.querySelector('.ck-ask-turn').classList.contains('is-model') && ${settled}`, 'the turn turned');
    assert.deepEqual(await chrome.evaluate(drawn), model, 'the model\'s words, drawn: each stand-in a chip, each citation the app\'s mark');
    assert.deepEqual(await chrome.evaluate(`(() => { const eye = document.querySelector('${eye}');
      return [eye.getAttribute('aria-label'), eye.getAttribute('aria-pressed'), eye.hasAttribute('title')]; })()`), ['What the model saw', 'true', false]);
    await page.shot('seen-on', settled);
    await press(eye);
    await chrome.until(`!document.querySelector('.ck-ask-turn').classList.contains('is-model') && ${settled}`, 'the turn back');
    assert.equal((await chrome.evaluate(drawn))[0], CITED.words);

    await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const swapped = `(() => { document.querySelector('${eye}').click();
      return [document.querySelectorAll('.ck-seen.is-turning').length, ...${drawn}]; })()`;
    assert.deepEqual(await chrome.evaluate(swapped), [0, ...model], 'in one step, no decrypt');
    assert.deepEqual((await chrome.evaluate(swapped)).slice(0, 2), [0, CITED.words]);
    await chrome.send('Emulation.setEmulatedMedia', { features: [] });
  });
});

describe('ask-page: Chat through the home\'s reach', () => {
  test('C16: a choice of the model that is the default now is kept as chosen: the default moves to Claude, questions still say Terra', async () => {
    const before = front.questions.length;
    try {
      await chrome.load('#view=ask', 'try { localStorage.removeItem("lifestream.ask.pick"); } catch {}');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · High'`);
      await pick('model', 'synthetic-luna');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Luna · Medium'`);
      await pick('model', 'synthetic-terra');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · High'`);
      assert.deepEqual(await chrome.evaluate('JSON.parse(localStorage.getItem("lifestream.ask.pick"))'), { model: 'synthetic-terra', thinking: '' });
      front.claude(true);
      front.tell({ kind: 'models', key: 'models' });
      await until('Claude’s models offered', async () => (await chrome.evaluate(OFFERED)).some((/** @type {string} */ id) => id.startsWith('claude/')));
      assert.equal(await page.words(CHIP), 'Synthetic Terra · High');
      await chrome.evaluate(`(() => { const field = document.querySelector('.ck-composer textarea'); field.value = 'Which one?';
        field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await press('.ck-composer__send');
      await front.asked(before + 1);
      const { submission, ...asked } = front.questions.at(-1) ?? {};
      assert.match(String(submission), /^[0-9a-f]{32}$/u);
      assert.deepEqual(asked, { question: 'Which one?', model: 'synthetic-terra' });
      await press('.ck-pick .ck-fmenu__btn');
      await chrome.until(`document.querySelector('.ck-pick .ck-fmenu__panel')?.hidden === false`);
      await press('.ck-pick .ck-fmenu__item[data-value="reset"]');
      await chrome.until(`localStorage.getItem('lifestream.ask.pick') === JSON.stringify({ model: '', thinking: '' })`);
    } finally {
      front.claude(false);
    }
  });

  test('C17: the starters obey the composer: none while the host says reach lacks, back once the home answers', async () => {
    const STATE = hostState({ more: { setup: { state: 'done', error: null } } });
    /**
     * @param {string} state
     * @param {number} revision
     */
    const at = (state, revision) => JSON.stringify({ ...STATE, reach: { ...STATE.reach, state, revision } });
    front.holds(false);
    try {
      await chrome.load('#view=ask', hostScript(JSON.parse(at('unreachable', 1))));
      await chrome.until(`document.querySelector('[data-ck-composer]')?.classList.contains('is-waiting') && document.querySelector('.ck-pick') !== null`);
      await until('the list read', async () => await chrome.evaluate(`document.querySelector('[data-tour="ask"]')?.dataset.read`) !== 'reading');
      assert.equal(await page.count('.ck-ask-starter'), 0, 'a starter while the composer waits');
      await chrome.evaluate(`window.setHostState(${at('answering', 2)})`);
      await chrome.until(`document.querySelectorAll('.ck-ask-starter').length === 3`);
    } finally {
      front.holds(true);
    }
  });

  test('C18: a readiness read that lands while the chip’s menu is open, on either page, leaves it open; what changed is drawn as it closes', async () => {
    const panelOpen = `document.querySelector('.ck-pick .ck-fmenu__panel')?.hidden === false`;
    /** @param {number} count */
    const landed = async count => {
      await chrome.until(`performance.getEntriesByType('resource').filter(each => /\\/api\\/ask(\\?|$)/u.test(each.name) && each.responseEnd > 0).length >= ${count}`);
      await chrome.evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
    };
    try {
      await chrome.load('#view=ask', 'try { localStorage.removeItem("lifestream.ask.pick"); } catch {}');
      await chrome.until(`document.querySelector('${CHIP}')?.textContent === 'Synthetic Terra · High'`);
      await press('.ck-pick .ck-fmenu__btn');
      await chrome.until(panelOpen);
      await chrome.evaluate('performance.clearResourceTimings()');
      await chrome.evaluate(`window.dispatchEvent(new Event('focus'))`);
      await landed(1);
      assert.equal(await chrome.evaluate(panelOpen), true, 'the menu closed under a read that drew nothing new');
      await press('.ck-pick [data-value="models"]');
      await chrome.until(`document.querySelector('.ck-pick [data-value="model:synthetic-luna"]')?.hidden === false`);
      front.claude(true);
      front.tell({ kind: 'models', key: 'models' });
      await landed(2);
      assert.equal(await chrome.evaluate(`${panelOpen} && document.querySelector('.ck-pick [data-value="model:synthetic-luna"]')?.hidden === false`), true,
        'the menu closed under a read that changed it');
      assert.equal((await chrome.evaluate(OFFERED)).some((/** @type {string} */ id) => id.startsWith('claude/')), false, 'drawn over the open menu');
      await press('.ck-composer textarea');
      await chrome.until(`!(${panelOpen})`);
      await until('Claude’s models drawn once the menu closed', async () => (await chrome.evaluate(OFFERED)).some((/** @type {string} */ id) => id.startsWith('claude/')));
    } finally {
      front.claude(false);
    }
  });

  test('C19: the list after an answer is read after it: a read begun before the conversation, landing after its turn, never drops it', async () => {
    const recent = `#ak-chats [data-ask-chat="${NEW_CHAT}"]`;
    try {
      await chrome.load('#view=ask', '');
      await chrome.following();
      await chrome.until(`document.querySelector('#ak-chats [data-ask-chat="${CHAT}"]') !== null && document.querySelector('.ck-pick') !== null`);
      await chrome.evaluate('performance.clearResourceTimings()');
      front.holdLists(true);
      front.tell({ kind: 'import', key: 'ask:local:macbook-pro-0001/20261020T110020000Z.0123456789ab' });
      await until('the old read held', () => front.heldLists() === 1);
      front.answers(true);
      await chrome.evaluate(`(() => { const field = document.querySelector('.ck-composer textarea'); field.value = 'What is new?';
        field.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await press('.ck-composer__send');
      await chrome.until(`document.querySelector('${recent}') !== null`);
      await until('a read begun after the turn', () => front.heldLists() === 2);
      front.releaseList();
      await chrome.until(`(() => { const [old] = performance.getEntriesByType('resource').filter(each => each.name.includes('/api/ask/chats'));
        return old !== undefined && old.responseEnd > 0; })()`);
      await chrome.evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
      assert.equal(await page.count(recent), 1, 'the old read dropped the conversation');
      front.releaseList();
      await chrome.until(`document.querySelector('${recent}')?.textContent.includes('Synthetic new')`);
    } finally {
      front.holdLists(false);
      while (front.heldLists()) front.releaseList();
      front.answers(false);
      front.unmake();
    }
  });

  test('C20: a failed list read, then a good read of anyone’s: the failure goes', async () => {
    const notice = `document.querySelector('.ak-stage [data-part="notice"]')?.textContent ?? ''`;
    const read = `document.querySelector('[data-tour="ask"]')?.dataset.read`;
    front.listFails(true);
    try {
      await chrome.load('#view=ask', '');
      await chrome.following();
      await chrome.until(`(${notice}) !== '' && ${read} === 'failed'`);
      front.listFails(false);
      front.tell({ kind: 'import', key: 'ask:local:macbook-pro-0001/20261020T110020000Z.0123456789ab' });
      await chrome.until(`(${notice}) === '' && ${read} === 'ready'`);
    } finally {
      front.listFails(false);
    }
  });

  test('C21: the drawer reads a page, the next as it scrolls near its end, under heads of when', async () => {
    const rows = `document.querySelectorAll('#ak-chats [data-ask-chat]').length`;
    const reads = `performance.getEntriesByType('resource').filter(each => each.name.includes('/api/ask/chats'))
      .map(each => new URL(each.name).searchParams.get('after') ?? '')`;
    front.many(true);
    try {
      await chrome.load('#view=ask', '');
      await chrome.until(`${rows} >= 20`);
      await chrome.evaluate(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`);
      const first = /** @type {string[]} */ (await chrome.evaluate(reads));
      assert.ok(!first.includes('40'), `the start read the whole list: ${first.join(', ')}`);
      await press('.ak-bar [data-ask-action="chats"]');
      await chrome.until(`document.querySelector('#ak-chats')?.classList.contains('is-open') && !document.querySelector('#ak-chats').getAnimations().length`);
      assert.deepEqual(await chrome.evaluate(`[...document.querySelectorAll('#ak-chats .ck-chats__label')].map(each => each.textContent).slice(0, 3)`),
        ['Today', 'Yesterday', 'Previous 7 days']);
      await page.shot('conversations-grouped', `${rows} >= 20`);
      await chrome.until(`(() => { const list = document.querySelector('#ak-chats .ak-chats__list'); list.scrollTop = list.scrollHeight;
        return ${rows} === 45; })()`);
      assert.deepEqual(/** @type {string[]} */ (await chrome.evaluate(reads)).filter(after => after === '40'), ['40'], 'the last page read once');
      assert.equal(await page.count('#ak-chats [data-ask-list-end]'), 0, 'no end once the home holds no more');
    } finally {
      front.many(false);
    }
  });

  test('C14: a held read is read again once the home answers, a wait at its time; the composer waits only while reach lacks', async () => {
    const STATE = hostState({ more: { setup: { state: 'done', error: null } } });
    /**
     * @param {string} state
     * @param {number} revision
     */
    const at = (state, revision) => JSON.stringify({ ...STATE, reach: { ...STATE.reach, state, revision } });
    const waits = `document.querySelector('[data-ck-composer]')?.classList.contains('is-waiting')`;
    const probes = 'window.hostActs.filter(act => act.act === "home" && act.do === "probe").length';
    try {
      front.refuseChat('held');
      await chrome.load(`#view=ask&chat=${CHAT}`, hostScript(STATE));
      await chrome.until(`${probes} === 1 && document.querySelector('.ak-stage.ck-reading') !== null`);
      assert.equal(await page.count('[data-ask-action="reread"]'), 0);
      assert.equal(await chrome.evaluate(waits), false, 'askable while the home answers');
      await chrome.evaluate(`window.setHostState(${at('held', 1)})`);
      await chrome.until(`document.querySelector('.ak.ck-lacks') !== null
        && getComputedStyle(document.querySelector('.ak-stage .ck-lack--reach')).display === 'flex'`);
      assert.equal(await chrome.evaluate(waits), true, 'the composer waits while reach lacks');
      front.refuseChat(null);
      await chrome.evaluate(`window.setHostState(${at('answering', 2)})`);
      await chrome.until(answered);
      assert.equal(await chrome.evaluate(waits), false);
      await chrome.evaluate(`window.setHostState(${at('waiting', 2)})`);
      assert.equal(await chrome.evaluate(waits), false, 'askable while the home waits');
      await chrome.evaluate(`window.setHostState(${at('unreachable', 2)})`);
      assert.equal(await chrome.evaluate(waits), true);
      front.refuseChat('wait');
      await chrome.load(`#view=ask&chat=${CHAT}`, hostScript(STATE));
      await chrome.until(`/being prepared/u.test(document.querySelector('.ak-stage .ck-sk-wait')?.textContent ?? '')`);
      assert.equal(await page.count('[data-ask-action="reread"]'), 0);
      front.refuseChat(null);
      await chrome.until(answered);
    } finally {
      front.refuseChat(null);
    }
  });
});

/** @param {number} n */
function dayOf(n) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`2026-10-1${n}T12:00:00Z`)).replace(',', '');
}
