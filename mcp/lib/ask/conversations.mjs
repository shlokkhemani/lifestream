// @ts-check
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { DoorRefusal } from '../errors.mjs';

/**
 * @typedef {import('../door.mjs').Door} Door
 * @typedef {{ page: 'days', day: string, focus?: string, span?: { from_ms: number, to_ms: number } } | { page: 'people' | 'places', id: string, person?: string | null, group?: string } | { page: 'read' }} Opens
 * @typedef {{ audio: string, record: string, seconds?: number, from?: string, mine?: true }} CitedVoice
 * @typedef {{ ref: string, kind: 'record' | 'message' | 'line', opens: Opens, day?: string, at?: string, title?: string, chat?: string, chat_title?: string, voice?: CitedVoice } | { ref: string, kind: 'turn', opens: Opens, day?: string, at?: string, title?: string, chat?: string, chat_title?: string } | { ref: string, kind: 'photo', opens: Opens, image: string, day?: string, at?: string, title?: string, chat?: string, chat_title?: string } | { ref: string, kind: 'window', opens: Opens, day: string, app: string, title: string, at?: string } | { ref: string, kind: 'row', asked: string, n: number, opens: Opens } | { ref: string, kind: 'person' | 'chat' | 'place', name: string, opens: Opens } | { ref: string, kind: 'gone', why: string }} Citation
 * @typedef {Citation | { ref: string }} Cited
 * @typedef {{ name: string, words: string, ms: number, error?: string, line?: string }} Step
 * @typedef {{ audio: string, ms: number }} Voice
 * @typedef {{ type: 'ask.msg', chat: string, n: number, at_ms: number, role: 'user' | 'assistant', text: string, seen?: import('./seen.mjs').Seen, photos?: string[], voice?: Voice, refs?: Record<string, Cited>, steps?: Step[], model?: string, ms?: number, thought_ms?: number, end?: 'done' | 'stopped' | 'failed', error?: string, failed?: 'login' | 'door' | 'model' | 'restart', thinking?: string, access?: import('./agents.mjs').AccessChange[] }} Message
 * @typedef {Message & { unsaved?: true }} Told
 * @typedef {{ chat: string, title: string, messages: Told[] }} Kept
 * @typedef {{ chat: string, title: string, messages: Message[], erased: boolean, running: Running | null, live: Live | null, shown: string[], marks: Map<number, Mark[]>, words: Map<string, string>, readied: number }} Conversation
 * @typedef {import('./ask.mjs').Turn} Running
 * @typedef {import('./ask.mjs').Live} Live
 * @typedef {import('../pieces.mjs').Mark} Mark
 * @typedef {{ state: 'pending' | 'delivered' | 'erased', chat: string, n: number }} Submitted
 * @typedef {{ chat: string, title: string, messages: Told[] }} Read
 * @typedef {{ absent: 'erased' | 'waiting' | 'unknown' }} Absent
 * @typedef {{ chat: string, title: string, first_ms: number, last_ms: number, messages: number }} Listed
 * @typedef {{ kind: 'chat' | 'msg', key: string, content: Record<string, unknown> }} Statement
 */

const CONNECTOR = 'ask-home';
const PAGE = 20;
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const UNSAVED_MS = 60 * 60_000;
const PENDING_FILE = /^\d{12}-[0-9a-f]{8}\.json$/u;
const SUBMITTED_MS = 30 * 24 * 3_600_000;
const ERASED_MAX = 100;
const PUT_MS = 60_000;
const RESUME_MS = 10 * 60_000;
export const VOICE_TITLE = 'Voice note';
export const RESTARTED = 'Chat restarted before this answer finished.';
export const ERASED = 'This conversation was erased.';
export const UNTAKEN = 'Lifestream couldn\'t take this question in time. Ask it again.';
export const CHAT_ERASED = 'CHAT_ERASED';
const LET_GO = ['STATEMENTS_BAD', 'FILES_MISSING'];

/**
 * @param {{ machine: string, door: string, now?: () => number, log: (line: Record<string, unknown>) => void,
 *   onLetGo?: (conversation: Conversation, n: number | null) => void, putMs?: number, resumeMs?: number, retryMs?: number }} options
 */
export function openConversations({ machine, door: doorUrl, now = Date.now, log, onLetGo = () => undefined, putMs = PUT_MS, resumeMs = RESUME_MS, retryMs = RETRY_MS }) {
  /** @type {Map<string, Conversation>} */
  const held = new Map();
  const folder = pendingFolder(machine);
  const submissions = loadSubmitted(machine, log);
  /** @type {Set<string>} */
  const erased = new Set();
  /** @type {Delivery[]} */
  const pending = [];
  /** @type {Map<string, number>} */
  const holds = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const deleting = new Map();
  /** @param {readonly string[]} files */
  const take = files => {
    for (const file of files) holds.set(file, (holds.get(file) ?? 0) + 1);
  };
  /**
   * @param {readonly string[]} files
   * @param {boolean} dropped
   */
  const release = (files, dropped) => {
    for (const file of files) {
      const left = (holds.get(file) ?? 1) - 1;
      if (left > 0) {
        holds.set(file, left);
        continue;
      }
      holds.delete(file);
      if (!dropped) continue;
      const gone = serverCall(machine, doorUrl, 'DELETE', `/v1/ask/files/${file}`, undefined, putMs).then(answer => {
        if (answer.status !== 200) log({ ask: 'a staged picture not dropped', status: answer.status });
      }).finally(() => {
        if (deleting.get(file) === gone) deleting.delete(file);
      });
      deleting.set(file, gone);
    }
  };
  let written = 0;
  let closed = false;
  for (const delivery of loadPending(folder, log)) {
    take(seenFiles(delivery));
    written = Math.max(written, Number(delivery.file.slice(0, 12)));
    const turn = delivery.turn;
    pending.push(delivery);
    if (turn !== undefined) {
      turn.finished = true;
      if (!submissions.has(turn.submission)) submissions.set(turn.submission, { state: 'pending', chat: turn.chat, n: turn.n });
      hold(conversationOf, turn.question.statements);
    }
    hold(conversationOf, delivery.statements);
  }
  /** @type {Map<Delivery, (answer: Put | null) => void>} */
  const sealing = new Map();
  /** @type {Map<string, Unsealed>} */
  const unsealed = new Map();
  /** @type {string | null} */
  let source = null;
  /** @type {boolean | null} */
  let keyed = null;
  /** @type {Promise<void> | null} */
  let flushing = null;
  let wait = retryMs;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @param {string} chat */
  function conversationOf(chat) {
    const found = held.get(chat);
    if (found !== undefined) return found;
    /** @type {Conversation} */
    const made = { chat, title: '', messages: [], erased: erased.has(chat), running: null, live: null, shown: [], marks: new Map(), words: new Map(), readied: 0 };
    if (!made.erased) held.set(chat, made);
    return made;
  }

  /** @param {Door} door */
  const sourceOf = async door => {
    if (source !== null) return source;
    const { sources } = await door.json('/v1/sources', { product: 'ask' });
    source = sources.find((/** @type {{ connector?: string }} */ each) => each.connector === CONNECTOR)?.id ?? null;
    return source;
  };

  /** @param {Door} door */
  const learnForm = async door => {
    keyed ??= (await door.json('/v1/me')).keyed === true;
  };

  /** @param {Delivery} delivery */
  const kept = delivery => delivery.saved || keyed === true;

  /** @param {Delivery} delivery */
  const write = delivery => {
    if (keyed === true) return false;
    try {
      const { source: to, made_ms, statements, kept_ms, turn } = delivery;
      replaceDurably(join(folder, delivery.file), `${JSON.stringify({ source: to, made_ms, statements, kept_ms, ...(turn === undefined ? {} : { turn: fileTurn(turn) }) })}\n`);
      delivery.saved = true;
      return true;
    } catch (error) {
      delivery.saved = false;
      log({ ask: 'a delivery not written to disk, written again at its next try', said: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  /** @param {Turn} turn */
  const delivered = turn => {
    if (keyed !== true) recordLine(machine, { submission: turn.submission, chat: turn.chat, n: turn.n });
    submissions.set(turn.submission, { state: 'delivered', chat: turn.chat, n: turn.n });
  };

  /**
   * @param {Delivery} delivery
   * @param {Put | null} answer
   */
  const answerSeal = (delivery, answer) => {
    const told = sealing.get(delivery);
    sealing.delete(delivery);
    told?.(answer);
  };

  /**
   * @param {Delivery} delivery
   * @param {boolean} [sealed]
   */
  const drop = (delivery, sealed = false) => {
    answerSeal(delivery, null);
    const waiting = delivery.turn === undefined ? undefined : unsealed.get(delivery.turn.submission);
    if (waiting?.delivery === delivery) {
      clearTimeout(waiting.timer);
      unsealed.delete(waiting.submission);
    }
    rmSync(join(folder, delivery.file), { force: true });
    const at = pending.indexOf(delivery);
    if (at < 0) return;
    pending.splice(at, 1);
    release(seenFiles(delivery), !sealed);
  };

  /** @param {Delivery} delivery */
  const unseen = delivery => {
    const answers = delivery.statements.filter(statement => statement.kind === 'msg' && Object.hasOwn(statement.content, 'seen'));
    if (answers.length === 0) return false;
    release(seenFiles(delivery), true);
    for (const statement of answers) {
      const { seen: _seen, ...content } = statement.content;
      statement.content = content;
      const message = held.get(String(content.chat))?.messages.find(each => each.n === content.n);
      if (message !== undefined) delete message.seen;
    }
    delete delivery.bundle;
    write(delivery);
    return true;
  };

  /** @param {string} chat */
  const erase = chat => {
    erased.add(chat);
    const found = held.get(chat);
    held.delete(chat);
    if (found !== undefined && !found.erased) {
      found.erased = true;
      log({ ask: 'a conversation erased', chat });
      onLetGo(found, null);
    }
    for (const delivery of pending.filter(each => chatOf(each) === chat)) drop(delivery);
  };

  /** @param {string[]} chats */
  const reconcile = async chats => {
    for (let at = 0; at < chats.length; at += ERASED_MAX) {
      const asked = chats.slice(at, at + ERASED_MAX);
      const answer = await serverCall(machine, doorUrl, 'GET', `/v1/ask/erased?${asked.map(chat => `chat=${encodeURIComponent(chat)}`).join('&')}`);
      if (answer.status !== 200 || !Array.isArray(answer.body?.erased)) {
        log({ ask: 'whether a conversation is erased not read', status: answer.status });
        return;
      }
      for (const chat of answer.body.erased) if (asked.includes(chat)) erase(chat);
    }
  };

  /** @param {string} chat */
  const knows = chat => (held.get(chat)?.messages.length ?? 0) > 0 || [...submissions.values()].some(made => made.chat === chat);

  /** @param {Delivery} delivery */
  const unreadable = delivery => {
    drop(delivery);
    const turn = delivery.turn;
    if (turn === undefined) return;
    submissions.delete(turn.submission);
    const mine = held.get(turn.chat);
    if (mine !== undefined) {
      mine.messages = mine.messages.filter(message => message.n !== turn.n && message.n !== turn.n - 1);
      onLetGo(mine, turn.n);
    }
  };

  const flush = () => flushing ??= sendAll().then(through => {
    flushing = null;
    if (through && sealing.size > 0) void flush();
  });
  /** @returns {Promise<boolean>} */
  const sendAll = async () => {
    clearTimeout(timer);
    /** @param {Record<string, unknown>} why */
    const later = why => {
      log({ ask: 'delivery waits', ...why, retry_ms: wait });
      for (const delivery of [...sealing.keys()]) answerSeal(delivery, { ok: false, status: 0, said: '' });
      if (closed) return false;
      timer = setTimeout(() => void flush(), wait);
      timer.unref();
      wait = Math.min(wait * 2, MAX_RETRY_MS);
      return false;
    };
    try {
      pending.every(each => kept(each) || write(each));
      for (let at = 0; at < pending.length;) {
        const next = /** @type {Delivery} */ (pending[at]);
        if (!kept(next)) return later({ said: 'a delivery not written to disk' });
        const turn = next.turn;
        const asking = turn !== undefined && !turn.delivered;
        if (turn !== undefined && !asking && !turn.finished) {
          at++;
          continue;
        }
        const sent = asking ? turn.question : next;
        sent.bundle ??= bundleOf(next.source, sent.made_ms, sent.statements);
        const answer = await put(machine, doorUrl, sent.bundle, putMs);
        const code = answer.ok ? undefined : bodyOf(answer.said)?.code;
        const awaited = asking && sealing.has(next);
        const definite = awaited && answer.status >= 400 && answer.status < 500;
        if (!asking && LET_GO.includes(String(code)) && unseen(next)) {
          log({ ask: 'an answer sent again without seen', status: answer.status, said: answer.said.slice(0, 500) });
          continue;
        }
        if (code === CHAT_ERASED || LET_GO.includes(String(code)) || definite) {
          log({ ask: 'delivery refused', status: answer.status, said: answer.said.slice(0, 500) });
          if (awaited) answerSeal(next, answer);
          if (code === CHAT_ERASED) erase(chatOf(next));
          else if (definite) drop(next);
          else unreadable(next);
        }
        if (!pending.includes(next)) {
          wait = retryMs;
          at = 0;
          continue;
        }
        if (!answer.ok) {
          answerSeal(next, answer);
          return later({ status: answer.status, said: answer.said.slice(0, 200) });
        }
        wait = retryMs;
        if (asking) {
          turn.delivered = true;
          write(next);
          answerSeal(next, answer);
          continue;
        }
        if (turn !== undefined) delivered(turn);
        drop(next, true);
      }
      return true;
    } catch (error) {
      return later({ said: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * @param {Delivery} delivery
   * @returns {Promise<Put | null>}
   */
  const sealOf = delivery => new Promise(done => {
    sealing.set(delivery, done);
    void flush();
  });

  /**
   * @param {Delivery} delivery
   * @param {string} title
   * @param {Message} marker
   */
  const marked = (delivery, title, marker) => {
    delivery.statements = [shell(marker.chat, title, marker.at_ms), statementOf(marker)];
    delete delivery.bundle;
    write(delivery);
  };

  /** @param {Unsealed} waiting */
  const awaitReplay = waiting => {
    clearTimeout(waiting.timer);
    unsealed.set(waiting.submission, waiting);
    waiting.timer = setTimeout(() => land(waiting.submission), resumeMs);
    waiting.timer.unref();
  };

  /** @param {string} submission */
  const land = submission => {
    const waiting = unsealed.get(submission);
    if (waiting === undefined) return;
    clearTimeout(waiting.timer);
    unsealed.delete(submission);
    if (!pending.includes(waiting.delivery)) return;
    /** @type {Turn} */ (waiting.delivery.turn).finished = true;
    holdMessage(waiting.conversation, waiting.marker);
    write(waiting.delivery);
    void flush();
  };

  /**
   * @param {number} made_ms
   * @param {Statement[]} statements
   * @param {Turn} [turn]
   */
  const deliver = (made_ms, statements, turn) => {
    if (source === null) throw new Error('a turn kept before the home\'s Ask source was found');
    const file = `${String(++written).padStart(12, '0')}-${randomBytes(4).toString('hex')}.json`;
    /** @type {Delivery} */
    const delivery = { file, saved: false, source, made_ms, statements, kept_ms: Date.now(), ...(turn === undefined ? {} : { turn }) };
    pending.push(delivery);
    write(delivery);
    return delivery;
  };

  /**
   * @param {Message} answer
   * @param {(string | null)[]} pictures
   * @returns {Promise<Message>}
   */
  const staged = async (answer, pictures) => {
    const bytes = pictures.map(picture => (picture === null ? null : Buffer.from(picture, 'base64')));
    const photos = bytes.map(each => (each === null ? null : `sha256:${createHash('sha256').update(each).digest('hex')}`));
    /** @type {string[]} */
    const files = photos.flatMap(photo => (photo === null ? [] : [photo]));
    take(files);
    const puts = await Promise.all(photos.map(async (file, at) => {
      if (file === null) return 200;
      await deleting.get(file);
      return (await serverCall(machine, doorUrl, 'PUT', `/v1/ask/files/${file}`, /** @type {Buffer} */ (bytes[at]), putMs)).status;
    }));
    const refused = puts.find(status => status !== 200);
    if (refused !== undefined) {
      log({ ask: 'seen not staged', status: refused });
      release(files, true);
      const { seen: _seen, ...without } = answer;
      return without;
    }
    return { ...answer, seen: { .../** @type {import('./seen.mjs').Seen} */ (answer.seen), photos } };
  };

  /**
   * @param {Message} message
   * @returns {Told}
   */
  const told = message => {
    const key = messageKey(message);
    return pending.some(each => !each.saved && each.statements.some(statement => statement.key === key && statement.kind === 'msg'))
      ? { ...message, unsaved: true } : message;
  };

  /**
   * @param {Conversation} conversation
   * @param {Message} message
   */
  const holdMessage = (conversation, message) => {
    conversation.messages = [...conversation.messages.filter(each => each.n !== message.n), message].sort((left, right) => left.n - right.n);
  };

  if (pending.length > 0) log({ ask: 'deliveries loaded', count: pending.length });
  void flush();

  /**
   * @param {Door} door
   * @param {string} chat
   * @returns {Promise<Kept | null>}
   */
  const fromHome = async (door, chat) => {
    const id = await sourceOf(door);
    if (id === null) return null;
    let shell;
    try {
      shell = await door.json('/v1/record', { source: id, kind: 'chat', key: chat });
    } catch (error) {
      if (error instanceof DoorRefusal && error.status === 404) return null;
      throw error;
    }
    const content = shell.version?.content;
    if (content === undefined) return null;
    /** @type {Message[]} */
    const messages = [];
    for (let after; ;) {
      const page = await door.json('/v1/records', { source: id, kind: 'msg', from_ms: Number(chat.slice(0, 13)), to_ms: Number(content.at_ms) + 1, after, limit: 1024 });
      messages.push(...page.records.map((/** @type {{ content: Message }} */ record) => record.content).filter((/** @type {Message} */ message) => message.chat === chat));
      if (page.next === undefined) break;
      after = page.next;
    }
    return { chat, title: String(content.title), messages: messages.sort((left, right) => left.n - right.n) };
  };

  return {
    /** @param {string} chat */
    get: chat => held.get(chat),

    all: () => [...held.values()],

    /**
     * @param {Door} door
     * @param {string} chat
     * @returns {Promise<Read | Absent>}
     */
    async read(door, chat) {
      if (!erased.has(chat)) await reconcile([chat]);
      if (erased.has(chat)) return { absent: 'erased' };
      const home = await fromHome(door, chat);
      const mine = held.get(chat);
      if (mine === undefined || (home === null && mine.messages.length === 0)) return home ?? { absent: knows(chat) ? 'waiting' : 'unknown' };
      const last = home?.messages.at(-1)?.n ?? 0;
      return { chat, title: mine.title, messages: [...home?.messages ?? [], ...mine.messages.filter(message => message.n > last).map(told)] };
    },
    /**
     * @param {Door} door
     * @param {string | undefined} after
     * @returns {Promise<{ chats: Listed[], next?: string }>}
     */
    async list(door, after) {
      const past = after === undefined ? null : readCursor(after);
      const id = await sourceOf(door);
      await reconcile([...held.values()].filter(each => each.messages.length > 0).map(each => each.chat));
      const mine = [...held.values()].flatMap(each => {
        const last = each.messages.at(-1);
        return last === undefined ? [] : [{ chat: each.chat, title: each.title, first_ms: Number(each.chat.slice(0, 13)), last_ms: last.at_ms, messages: last.n }];
      });
      const listed = new Set(mine.map(each => each.chat));
      const home = id === null ? [] : (await homeChats(door, id)).filter(each => !listed.has(each.chat))
        .map(each => ({ ...each, title: held.get(each.chat)?.title || each.title }));
      const left = [...mine, ...home].sort((one, other) => other.last_ms - one.last_ms || (one.chat < other.chat ? 1 : -1))
        .filter(each => past === null || each.last_ms < past[0] || (each.last_ms === past[0] && each.chat < past[1]));
      const page = left.slice(0, PAGE);
      await reconcile(page.filter(each => !listed.has(each.chat)).map(each => each.chat));
      const shown = page.filter(each => !erased.has(each.chat));
      const last = id === null ? new Map() : await counted(door, id, shown.filter(each => !listed.has(each.chat)));
      /** @type {Listed[]} */
      const chats = shown.map(each => 'messages' in each ? each : { ...each, messages: last.get(each.chat) ?? 0 });
      const end = page.at(-1);
      return left.length > PAGE && end !== undefined ? { chats, next: cursorOf([end.last_ms, end.chat]) } : { chats };
    },

    /** @param {Door} door */
    async any(door) {
      if ([...held.values()].some(each => each.messages.length > 0)) return true;
      const id = await sourceOf(door);
      if (id === null) return false;
      const found = await door.json('/v1/records', { source: id, kind: 'chat', limit: 1 });
      return found.records.length > 0;
    },

    /** @param {Door} door */
    knowsSource: async door => {
      await learnForm(door);
      return await sourceOf(door) !== null;
    },

    /** @param {Door} door */
    sourceId: door => sourceOf(door),

    keyed: () => keyed === true,

    /**
     * @param {{ title: string, chat: string, n: number, submission: string, files: boolean, question: Message }} begun
     * @returns {Promise<{ conversation: Conversation, question: Message } | { refused: { status: number, body: any } }
     *   | { unknown: { status: number, body: any } } | { unsaved: true } | { erased: true }>}
     */
    async begin({ title, chat, n, submission, files, question }) {
      if (erased.has(chat)) return { erased: true };
      const made = !held.has(chat);
      const conversation = conversationOf(chat);
      const unmade = () => {
        if (made && held.get(chat) === conversation && conversation.messages.length === 0) held.delete(chat);
      };
      const named = conversation.title === '' ? title : conversation.title;
      /** @type {Message} */
      const marker = { type: 'ask.msg', chat, n: n + 1, at_ms: question.at_ms, role: 'assistant', text: '', end: 'failed', failed: 'restart', error: RESTARTED };
      /** @type {Turn} */
      const turn = { submission, chat, n: n + 1, delivered: false, finished: false,
        question: { made_ms: question.at_ms, statements: [shell(chat, named, question.at_ms), statementOf(question)] } };
      const delivery = deliver(question.at_ms, [shell(chat, named, question.at_ms), statementOf(marker)], turn);
      if (!kept(delivery)) {
        pending.splice(pending.indexOf(delivery), 1);
        unmade();
        return { unsaved: true };
      }
      submissions.set(submission, { state: 'pending', chat, n: n + 1 });
      const sealed = files ? await sealOf(delivery) : null;
      if (conversation.erased) return { erased: true };
      if (sealed !== null && !sealed.ok && sealed.status >= 400 && sealed.status < 500) {
        submissions.delete(submission);
        unmade();
        return { refused: { status: sealed.status, body: bodyOf(sealed.said) } };
      }
      conversation.title = named;
      holdMessage(conversation, question);
      if (sealed !== null && !sealed.ok) {
        const untaken = { ...marker, failed: /** @type {const} */ ('door'), error: UNTAKEN };
        marked(delivery, named, untaken);
        awaitReplay({ submission, delivery, conversation, question, marker: untaken, title: named, timer: undefined });
        return { unknown: { status: sealed.status, body: bodyOf(sealed.said) } };
      }
      if (sealed === null) void flush();
      return { conversation, question };
    },

    /**
     * @param {string} submission
     * @returns {{ chat: string, question: Message } | null}
     */
    unsealed: submission => {
      const waiting = unsealed.get(submission);
      return waiting === undefined ? null : { chat: waiting.conversation.chat, question: waiting.question };
    },

    /** @param {string} chat */
    landUnsealed(chat) {
      for (const waiting of [...unsealed.values()]) if (waiting.conversation.chat === chat) land(waiting.submission);
    },

    /**
     * @param {string} submission
     * @returns {Promise<{ conversation: Conversation, question: Message } | { refused: { status: number, body: any } }
     *   | { unknown: { status: number, body: any } } | { erased: true }>}
     */
    async resume(submission) {
      const waiting = /** @type {Unsealed} */ (unsealed.get(submission));
      clearTimeout(waiting.timer);
      const { delivery, conversation, question, marker, title } = waiting;
      const turn = /** @type {Turn} */ (delivery.turn);
      const sealed = turn.delivered ? null : await sealOf(delivery);
      if (conversation.erased) return { erased: true };
      if (sealed !== null && !sealed.ok && sealed.status >= 400 && sealed.status < 500) {
        submissions.delete(submission);
        conversation.messages = conversation.messages.filter(message => message.n !== question.n);
        if (conversation.messages.length === 0 && held.get(conversation.chat) === conversation) held.delete(conversation.chat);
        return { refused: { status: sealed.status, body: bodyOf(sealed.said) } };
      }
      if (sealed !== null && !sealed.ok) {
        awaitReplay(waiting);
        return { unknown: { status: sealed.status, body: bodyOf(sealed.said) } };
      }
      unsealed.delete(submission);
      marked(delivery, title, { ...marker, failed: 'restart', error: RESTARTED });
      return { conversation, question };
    },

    /**
     * @param {Conversation} conversation
     * @param {string} title
     * @param {Message} reply
     * @param {(string | null)[]} [pictures]
     * @returns {Promise<Told>}
     */
    async finish(conversation, title, reply, pictures = []) {
      const { chat, n } = reply;
      const envelope = pending.find(each => each.turn?.chat === chat && each.turn.n === n);
      if (conversation.erased || envelope === undefined) return reply;
      const answer = reply.seen === undefined || pictures.length === 0 ? reply : await staged(reply, pictures);
      if (conversation.erased || !pending.includes(envelope)) {
        release(photosOf(answer), true);
        return answer;
      }
      holdMessage(conversation, answer);
      if (conversation.title === '' || conversation.title === VOICE_TITLE) conversation.title = title;
      envelope.statements = [shell(chat, conversation.title, answer.at_ms), statementOf(answer)];
      envelope.made_ms = answer.at_ms;
      delete envelope.bundle;
      /** @type {Turn} */ (envelope.turn).finished = true;
      write(envelope);
      void flush();
      return told(answer);
    },

    /**
     * @param {string} submission
     * @returns {Submitted | null}
     */
    submitted: submission => {
      const made = submissions.get(submission);
      if (made === undefined) return null;
      return erased.has(made.chat) ? { ...made, state: 'erased' } : made;
    },

    /** @param {string} chat */
    erase,

    /**
     * @param {string} chat
     * @returns {Promise<boolean>}
     */
    async erasedNow(chat) {
      await reconcile([chat]);
      return erased.has(chat);
    },

    /** @param {number} ms */
    async settle(ms) {
      const until = Date.now() + ms;
      try {
        for (;;) {
          await flush();
          if (pending.length === 0) return true;
          const left = until - Date.now();
          if (left <= 0) return false;
          await new Promise(done => setTimeout(done, Math.min(left, 1_000)));
        }
      } finally {
        closed = true;
        clearTimeout(timer);
        for (const waiting of unsealed.values()) clearTimeout(waiting.timer);
      }
    },

    unsavedIn: () => pending.length === 0 ? null : Math.max(0, UNSAVED_MS - (Date.now() - pending[0].kept_ms)),

    /**
     * @param {Conversation} conversation
     * @param {string} title
     */
    retitle(conversation, title) {
      const last = conversation.messages.at(-1);
      if (conversation.erased || last === undefined) return;
      conversation.title = title;
      deliver(now(), [shell(conversation.chat, title, last.at_ms)]);
      void flush();
    },
  };
}

/**
 * @typedef {{ submission: string, delivery: Delivery, conversation: Conversation, question: Message, marker: Message,
 *   title: string, timer: ReturnType<typeof setTimeout> | undefined }} Unsealed
 * @typedef {{ ok: boolean, status: number, said: string }} Put
 * @typedef {{ submission: string, chat: string, n: number, delivered: boolean, finished: boolean,
 *   question: { made_ms: number, statements: Statement[], bundle?: Bundle } }} Turn
 */

/**
 * @typedef {{ file: string, saved: boolean, source: string, made_ms: number, statements: Statement[], kept_ms: number, bundle?: Bundle, turn?: Turn }} Delivery
 * @typedef {{ path: string, bytes: Buffer }} Bundle
 */

/** @param {Turn} turn */
function fileTurn({ submission, chat, n, delivered, finished, question }) {
  return { submission, chat, n, delivered, finished, question: { made_ms: question.made_ms, statements: question.statements } };
}

/**
 * @param {any} value
 * @returns {Turn | null}
 */
function turnOfFile(value) {
  if (value === null || typeof value !== 'object' || typeof value.submission !== 'string' || typeof value.chat !== 'string'
    || typeof value.n !== 'number' || !Array.isArray(value.question?.statements) || typeof value.question?.made_ms !== 'number') return null;
  return { submission: value.submission, chat: value.chat, n: value.n,
    delivered: value.delivered === true, finished: value.finished === true,
    question: { made_ms: value.question.made_ms, statements: value.question.statements } };
}

/** @param {string} machine */
const submittedFile = machine => join(machine, 'ask', 'submitted.ndjson');

/**
 * @param {string} machine
 * @param {(line: Record<string, unknown>) => void} log
 * @returns {Map<string, Submitted>}
 */
function loadSubmitted(machine, log) {
  const file = submittedFile(machine);
  /** @type {Map<string, Submitted>} */
  const submissions = new Map();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') log({ ask: 'the submissions\' records cannot be read', said: error instanceof Error ? error.message : String(error) });
    return submissions;
  }
  const since = Date.now() - SUBMITTED_MS;
  /** @type {string[]} */
  const lines = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const { submission, chat, n, kept_ms } = JSON.parse(line);
      if (typeof submission !== 'string' || typeof chat !== 'string' || typeof n !== 'number' || typeof kept_ms !== 'number') throw new Error('not a line of the record');
      if (kept_ms < since) {
        dropped++;
        continue;
      }
      submissions.set(submission, { state: 'delivered', chat, n });
      lines.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    try {
      replaceDurably(file, lines.map(line => `${line}\n`).join(''));
    } catch (error) {
      log({ ask: 'the submissions\' records not trimmed', said: error instanceof Error ? error.message : String(error) });
    }
  }
  return submissions;
}

/**
 * @param {string} machine
 * @param {{ submission: string, chat: string, n: number }} line
 */
function recordLine(machine, line) {
  const file = submittedFile(machine);
  folderMade(dirname(file));
  const made = !existsSync(file);
  const fd = openSync(file, 'a', 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify({ ...line, kept_ms: Date.now() })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (made) syncFolder(dirname(file));
}

/**
 * @param {string} file
 * @param {string} text
 */
function replaceDurably(file, text) {
  folderMade(dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  syncFolder(dirname(file));
}

/** @param {string} folder */
function folderMade(folder) {
  if (existsSync(folder)) return;
  folderMade(dirname(folder));
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
  }
  syncFolder(dirname(folder));
}

/** @param {string} folder */
function syncFolder(folder) {
  const fd = openSync(folder, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} machine
 * @param {string} door
 */
export const modelsRead = (machine, door) => serverCall(machine, door, 'POST', '/v1/models/read');

/**
 * @param {string} machine
 * @param {string} door
 * @param {'GET' | 'POST' | 'PUT' | 'DELETE'} method
 * @param {string} path
 * @param {Record<string, unknown> | Buffer} [body]
 * @param {number} [ms]
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function serverCall(machine, door, method, path, body, ms) {
  let pass;
  try {
    pass = readFileSync(join(machine, 'ask', 'door-token'), 'utf8').trim();
  } catch {
    return { status: 0, body: { message: 'no pass yet: the home\'s start makes it' } };
  }
  try {
    const response = await fetch(`${door}${path}`, {
      method, headers: { authorization: `Bearer ${pass}`, ...(body === undefined ? {} : { 'content-type': Buffer.isBuffer(body) ? 'image/jpeg' : 'application/json' }) },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      ...(ms === undefined ? {} : { signal: AbortSignal.timeout(ms) }),
    });
    const text = await response.text();
    let said = {};
    try {
      said = JSON.parse(text);
    } catch {}
    return { status: response.status, body: said };
  } catch {
    return { status: 0, body: { message: 'Can\'t reach Lifestream.' } };
  }
}

/**
 * @param {string} said
 * @returns {any}
 */
function bodyOf(said) {
  try {
    return JSON.parse(said);
  } catch {
    return undefined;
  }
}

/**
 * @param {Message} message
 * @returns {Statement}
 */
const statementOf = message => ({ kind: 'msg', key: messageKey(message), content: message });

/** @param {string} machine */
export const pendingFolder = machine => join(machine, 'ask', 'pending');

/**
 * @param {string} folder
 * @param {(line: Record<string, unknown>) => void} log
 * @returns {Delivery[]}
 */
function loadPending(folder, log) {
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return [];
    log({ ask: 'the turns waiting for the home cannot be read, and Chat\'s turns may not be kept', folder, said: error instanceof Error ? error.message : String(error) });
    return [];
  }
  /** @type {Delivery[]} */
  const loaded = [];
  for (const name of names.sort()) {
    if (name.endsWith('.tmp')) {
      rmSync(join(folder, name), { force: true });
      log({ ask: 'a delivery half-written when the server stopped, removed', file: name });
      continue;
    }
    if (!PENDING_FILE.test(name)) continue;
    try {
      const { source, made_ms, statements, kept_ms, turn } = JSON.parse(readFileSync(join(folder, name), 'utf8'));
      if (typeof source !== 'string' || typeof made_ms !== 'number' || !Array.isArray(statements) || typeof kept_ms !== 'number') throw new Error('not a delivery');
      const envelope = turn === undefined ? null : turnOfFile(turn);
      if (turn !== undefined && envelope === null) throw new Error('not a turn\'s envelope');
      loaded.push({ file: name, saved: true, source, made_ms, statements, kept_ms, ...(envelope === null ? {} : { turn: envelope }) });
    } catch (error) {
      log({ ask: 'a delivery that cannot be read, left in place', file: name, said: error instanceof Error ? error.message : String(error) });
    }
  }
  return loaded;
}

/**
 * @param {(chat: string) => Conversation} conversationOf
 * @param {Statement[]} statements
 */
function hold(conversationOf, statements) {
  for (const { kind, key, content } of statements) {
    const mine = conversationOf(kind === 'chat' ? key : String(content.chat));
    if (kind === 'chat') mine.title = String(content.title);
    else if (mine.messages.every(message => message.n !== content.n)) mine.messages.push(/** @type {Message} */ (/** @type {unknown} */ (content)));
  }
}

/**
 * @param {Delivery} delivery
 * @returns {string[]}
 */
const seenFiles = delivery => delivery.statements.flatMap(({ kind, content }) => (kind === 'msg' ? photosOf(/** @type {Message} */ (/** @type {unknown} */ (content))) : []));

/**
 * @param {Message} message
 * @returns {string[]}
 */
const photosOf = message => (message.seen?.photos ?? []).flatMap(photo => (photo === null ? [] : [photo]));

/** @param {Delivery} delivery */
const chatOf = delivery => {
  const [first] = delivery.statements;
  return delivery.turn?.chat ?? (first === undefined ? '' : first.kind === 'chat' ? first.key : String(first.content.chat));
};

/**
 * @param {Door} door
 * @param {string} source
 * @returns {Promise<{ chat: string, title: string, first_ms: number, last_ms: number }[]>}
 */
async function homeChats(door, source) {
  const chats = [];
  for (let after; ;) {
    const page = await door.json('/v1/records', { source, kind: 'chat', after, limit: 1024 });
    for (const record of page.records) chats.push({ chat: String(record.key), title: String(record.content.title), first_ms: Number(String(record.key).slice(0, 13)), last_ms: Number(record.content.at_ms) });
    if (page.next === undefined) break;
    after = page.next;
  }
  return chats;
}

/**
 * @param {Door} door
 * @param {string} source
 * @param {{ chat: string, last_ms: number }[]} chats
 * @returns {Promise<Map<string, number>>}
 */
async function counted(door, source, chats) {
  /** @type {Map<string, number>} */
  const last = new Map();
  if (chats.length === 0) return last;
  const times = chats.map(each => each.last_ms);
  for (let after; ;) {
    const page = await door.json('/v1/records', { source, kind: 'msg', from_ms: Math.min(...times), to_ms: Math.max(...times) + 1, after, limit: 1024 });
    for (const record of page.records) {
      const { chat, n } = record.content;
      if (n > (last.get(chat) ?? 0)) last.set(chat, Number(n));
    }
    if (page.next === undefined) break;
    after = page.next;
  }
  return last;
}

/** @param {[number, string]} value */
function cursorOf(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * @param {string} text
 * @returns {[number, string] | null}
 */
function readCursor(text) {
  try {
    const value = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && typeof value[1] === 'string') return [value[0], value[1]];
  } catch {}
  return null;
}

/** @param {Message} message */
const messageKey = message => `${message.chat}:${String(message.n).padStart(4, '0')}`;

/**
 * @param {string} chat
 * @param {string} title
 * @param {number} at_ms
 * @returns {Statement}
 */
function shell(chat, title, at_ms) {
  return { kind: 'chat', key: chat, content: { type: 'ask.chat', title, at_ms } };
}

/**
 * @param {string} source
 * @param {number} made_ms
 * @param {Statement[]} statements
 */
export function bundleOf(source, made_ms, statements) {
  const fetched_at = new Date(made_ms).toISOString();
  const body = Buffer.from(statements.map(statement => `${JSON.stringify(statement)}\n`).join(''), 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const manifest = {
    format: 'org.lifestreamprotocol.acquisition/1', source_id: source, feeder: 'owner-statements', fetched_at, complete: true,
    files: [{ file: 'statements.ndjson', sha256, bytes: body.length }], facts: { statements: statements.length, blobs_carried: 0 },
  };
  return {
    path: `/v1/acquisitions/${encodeURIComponent(source)}/${fetched_at.replace(/[-:]/gu, '')}.${sha256.slice(0, 12)}`,
    bytes: storedZip([['statements.ndjson', body], ['manifest.json', Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')]]),
  };
}

/**
 * @param {string} machine
 * @param {string} door
 * @param {{ path: string, bytes: Buffer }} bundle
 * @param {number} ms
 * @returns {Promise<Put>}
 */
async function put(machine, door, bundle, ms) {
  let pass;
  try {
    pass = readFileSync(join(machine, 'ask', 'door-token'), 'utf8').trim();
  } catch {
    return { ok: false, status: 0, said: `no pass in ${join(machine, 'ask', 'door-token')} yet: the home's start makes it` };
  }
  try {
    const response = await fetch(`${door}${bundle.path}`, {
      method: 'PUT', body: new Uint8Array(bundle.bytes), signal: AbortSignal.timeout(ms),
      headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/zip', 'content-length': String(bundle.bytes.length), 'lifestream-kind': 'new' },
    });
    const said = await response.text();
    return { ok: response.status === 200 || response.status === 201, status: response.status, said };
  } catch {
    return { ok: false, status: 0, said: 'Can\'t reach Lifestream.' };
  }
}

/** @param {[string, Buffer][]} members */
function storedZip(members) {
  /** @type {Buffer[]} */
  const locals = [];
  /** @type {Buffer[]} */
  const centrals = [];
  let offset = 0;
  for (const [name, bytes] of members) {
    const named = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(1 << 11, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(named.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(1 << 11, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(named.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, named, bytes);
    centrals.push(central, named);
    offset += local.length + named.length + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
