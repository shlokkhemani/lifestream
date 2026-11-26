// @ts-check
/** @import { Moment } from '../panel.js' */
/** @import { Opens } from '../../lib/opening.js' */
import { accessChangeOf } from '../../lib/agents.js';
import { dayAt } from '../../lib/home-clock.js';
import { momentAt } from '../../lib/opening.js';
import { NOT_SENT } from '../../lib/reach.js';
import { clock, groupWhen, shortDay, stampWhen } from '../../lib/words.js';
import { citedIn, sourceOf } from '../kit/ask.js';
import { spansFit } from '../kit/seen.js';
import { DIDNT_PLAY } from '../kit/voice.js';

/**
 * @typedef {{ audio: string, record: string, seconds?: number, from?: string, mine?: true }} CitedVoice
 * @typedef {{ ref: string, kind: 'record' | 'message' | 'turn' | 'line' | 'photo', opens: Opens, day?: string, at?: string, title?: string, chat?: string, chat_title?: string, image?: string, voice?: CitedVoice }} AskThing
 * @typedef {{ cited: AskCited | null, words: string }} Replay
 * @typedef {{ ref: string, kind: 'window', opens: Opens, day: string, at?: string, app: string, title: string }} AskWindow
 * @typedef {AskThing | AskWindow} AskMoment
 * @typedef {AskMoment | { ref: string, kind: 'row', asked: string, n: number, opens: Opens } | { ref: string, kind: 'person' | 'chat' | 'place', name: string, opens: Opens } | { ref: string, kind: 'gone', why: string } | { ref: string }} AskCited
 * @typedef {{ name: string, words: string, ms: number, error?: string }} KeptStep
 * @typedef {{ audio: string, ms: number, words?: string, writing?: true, failed?: string }} KeptVoice
 * @typedef {{ chat: string, n: number, at_ms: number, role: 'user' | 'assistant', text: string, photos?: string[], voice?: KeptVoice, refs?: Record<string, AskCited>, steps?: KeptStep[], model?: string, ms?: number, thought_ms?: number, end?: 'done' | 'stopped' | 'failed', error?: string, failed?: 'login' | 'door' | 'model' | 'restart', thinking?: string, unsaved?: true, access?: AccessChange[], seen?: AskSeen }} AskMessage
 * @typedef {import('../kit/seen.js').AskSeen} AskSeen
 * @typedef {import('../../types.js').AccessChange} AccessChange
 * @typedef {{ chat: string, title: string, messages: AskMessage[], running?: { n: number } }} Conversation
 * @typedef {{ chat: string, title: string, first_ms: number, last_ms: number, messages: number }} ChatSummary
 * @typedef {{ chats: ChatSummary[], next?: string }} ChatList
 * @typedef {{ type: 'chat', chat: string, n: number, audio?: string } | { type: 'step', call: number, name: string, words: string } | { type: 'step', call: number, words: string, ms: number, error?: string } | { type: 'ref', handle: string, cited: AskCited } | { type: 'text', delta: string } | { type: 'done', message: AskMessage } | { type: 'title', chat: string, title: string } | { type: 'error', error: 'login' | 'door' | 'model' | 'restart' | 'erased', message: string } | { type: 'waiting', words: string } | { type: 'words', words: string } | { type: 'access', change: AccessChange }} AskEvent
 * @typedef {{ call: number, words: string, failed: boolean }} TurnStep
 * @typedef {{ hash: string, local: string, kind: string }} TurnPhoto
 * @typedef {{ ms: number, audio: string, local: string, levels: number[], words: string | null }} TurnVoice
 * @typedef {{ question: string, asked_ms: number, steps: TurnStep[], text: string, refs: Record<string, AskCited> | null, thought: number | null, end: 'running' | 'done' | 'stopped' | 'failed', failed: string, error: string, unsaved: boolean, waiting: string, photos: TurnPhoto[], voice: TurnVoice | null, n: number | null, submission: string, access: AccessChange[], seen: AskSeen | null }} Turn
 */

/**
 * @param {string} question
 * @param {number} asked_ms
 * @param {{ photos?: TurnPhoto[], voice?: TurnVoice | null, n?: number | null, submission?: string }} [files]
 * @returns {Turn}
 */
export const asking = (question, asked_ms, { photos = [], voice = null, n = null, submission = '' } = {}) => ({
  question, asked_ms, steps: [], text: '', refs: null, thought: null, end: 'running', failed: '', error: '',
  unsaved: false, waiting: '', photos, voice, n, submission, access: [], seen: null });

/**
 * @param {KeptVoice} voice
 * @returns {TurnVoice}
 */
export const voiceOf = voice => ({ ms: voice.ms, audio: voice.audio, local: '', levels: [],
  words: typeof voice.words === 'string' ? voice.words : voice.writing ? null : '' });

/**
 * @param {Turn} turn
 * @param {AskEvent} event
 * @returns {Turn}
 */
export function withEvent(turn, event) {
  if (event.type === 'waiting') return { ...turn, waiting: event.words };
  if (event.type === 'access') {
    const change = accessChangeOf(event.change);
    return change ? { ...turn, access: [...turn.access, change] } : turn;
  }
  if (event.type === 'words') return turn.voice ? { ...turn, voice: { ...turn.voice, words: event.words } } : turn;
  if (event.type === 'step' && !('ms' in event)) {
    return { ...turn, waiting: '', steps: [...turn.steps, { call: event.call, words: event.words, failed: false }] };
  }
  if (event.type === 'step') {
    const ended = { words: event.words, failed: event.error !== undefined };
    return { ...turn, waiting: '', steps: turn.steps.map(step => step.call === event.call ? { ...step, ...ended } : step) };
  }
  if (event.type === 'ref') return { ...turn, refs: { ...turn.refs ?? {}, [event.handle]: event.cited } };
  if (event.type === 'text') return { ...turn, waiting: '', text: turn.text + event.delta };
  if (event.type === 'error') return { ...writtenOut(turn), waiting: '', failed: event.error, error: event.message ?? '' };
  if (event.type === 'done') return answered(turn, event.message);
  return turn;
}

/**
 * @param {Turn} turn
 * @param {AskMessage} message
 * @returns {Turn}
 */
function answered(turn, message) {
  const end = message.end ?? 'done';
  return {
    ...end === 'failed' ? writtenOut(turn) : turn, text: message.text, refs: message.refs ?? {}, end,
    thought: message.thought_ms ?? message.ms ?? null,
    steps: (message.steps ?? []).map((step, at) => ({ call: at + 1, words: step.words, failed: step.error !== undefined })),
    failed: end === 'failed' ? turn.failed || message.failed || 'other' : '',
    error: end === 'failed' ? turn.error || message.error || '' : '',
    unsaved: message.unsaved === true,
    waiting: '',
    access: message.access ? message.access.map(accessChangeOf).filter(each => each !== null) : turn.access,
    seen: end === 'failed' ? null : message.seen ?? null,
  };
}

/**
 * @param {Turn} turn
 * @returns {AskSeen | null}
 */
export function seenOf(turn) {
  const { seen } = turn;
  if (!seen || !(turn.end === 'done' || (turn.end === 'stopped' && turn.text))) return null;
  if (seen.spoken !== (turn.voice ? turn.voice.words : undefined)) return null;
  if (!spansFit(turn.voice ? turn.voice.words ?? '' : turn.question, seen.asked) || !spansFit(turn.text, seen.answered)) return null;
  if (turn.photos.length ? seen.photos?.length !== turn.photos.length : seen.photos !== undefined) return null;
  return seen.asked.length || seen.answered.length || seen.photos?.some(Boolean) ? seen : null;
}

/** @param {Turn} turn */
const writtenOut = turn => turn.voice?.words === null ? { ...turn, voice: { ...turn.voice, words: '' } } : turn;

/**
 * @param {Conversation} conversation
 * @returns {Turn[]}
 */
export function turnsOf({ messages, running }) {
  const answers = new Map(messages.filter(message => message.role === 'assistant').map(message => [message.n, message]));
  return messages.filter(message => message.role === 'user').map(question => {
    const turn = asking(question.text, question.at_ms, { n: question.n,
      photos: (question.photos ?? []).map(hash => ({ hash, local: '', kind: '' })), voice: question.voice ? voiceOf(question.voice) : null });
    const answer = answers.get(question.n + 1);
    if (answer) return answered(turn, answer);
    return running?.n === question.n + 1 ? turn : { ...turn, end: /** @type {const} */ ('stopped') };
  });
}

/** @param {Turn} turn */
export function failedSentence(turn) {
  if (turn.failed === 'model' || turn.failed === 'login') return turn.error || 'The model didn’t answer.';
  if (turn.failed === 'door') return NOT_SENT;
  if (turn.failed === 'restart') return 'Chat restarted before it finished.';
  if (turn.failed && turn.failed !== 'other') return turn.failed;
  return 'Lost the connection to Chat.';
}

/**
 * @param {Turn} turn
 * @returns {{ handle: string, handles: string[] }[]}
 */
export function citedSources(turn) {
  const refs = turn.refs ?? {};
  const source = sourceOf(shownRefs(refs));
  /** @type {Map<string, string[]>} */
  const sources = new Map();
  for (const handle of citedIn(turn.text)) {
    if (!refs[handle]) continue;
    const stands = source(handle);
    const held = sources.get(stands) ?? [];
    if (!held.includes(handle)) held.push(handle);
    sources.set(stands, held);
  }
  return [...sources].map(([handle, handles]) => ({ handle, handles }));
}

const MOMENTS = new Set(['record', 'message', 'turn', 'line', 'photo', 'window']);

/** @param {AskCited} cited @returns {cited is AskMoment} */
const isMoment = cited => 'kind' in cited && MOMENTS.has(cited.kind);

/** @param {AskCited} cited @returns {CitedVoice | null} */
export const keptVoice = cited => 'voice' in cited && cited.voice ? cited.voice : null;

/**
 * @param {AskCited} cited
 * @param {ReadonlyMap<string, Replay>} replays
 * @returns {{ voice: CitedVoice, failed: string } | 'erased' | null}
 */
export function voiceShown(cited, replays) {
  const kept = keptVoice(cited);
  if (!kept) return null;
  const replay = replays.get(kept.record);
  if (!replay) return { voice: kept, failed: DIDNT_PLAY };
  if (replay.cited === null) return { voice: kept, failed: replay.words };
  if ('kind' in replay.cited && replay.cited.kind === 'gone') return 'erased';
  const newer = keptVoice(replay.cited);
  return newer ? { voice: newer, failed: DIDNT_PLAY } : null;
}

/**
 * @param {string} record
 * @param {{ described: AskCited[], unopened?: string[] } | null} answer
 * @param {string} words
 * @returns {Replay}
 */
export const replayOf = (record, answer, words) => ({ cited: answer?.described.find(each => each.ref === record) ?? null, words });

const SOMEONE = 'Someone';

/**
 * @param {AskThing} cited
 * @param {CitedVoice} voice
 * @param {string} year
 */
function captionOf(cited, voice, year) {
  const at = cited.at ? Date.parse(cited.at) : NaN;
  const when = [cited.day ? shortDay(cited.day, year) : '', Number.isFinite(at) ? clock(at) : ''].filter(Boolean).join(', ');
  return [voice.mine ? 'You' : voice.from ?? SOMEONE, when].filter(Boolean).join(' · ');
}

/**
 * @param {AskThing} cited
 * @param {ReadonlyMap<string, Replay>} replays
 * @param {string} year
 * @returns {import('../kit/ask.js').AskVoice | null}
 */
function shownVoice(cited, replays, year) {
  const shown = voiceShown(cited, replays);
  if (shown === 'erased') return { record: keptVoice(cited)?.record ?? cited.ref, audio: '', seconds: null, caption: '', mine: false, failed: '', erased: true };
  if (!shown) return null;
  const { voice, failed } = shown;
  return { record: voice.record, audio: voice.audio, seconds: voice.seconds ?? null, caption: captionOf(cited, voice, year), mine: voice.mine === true,
    failed };
}

/**
 * @param {Record<string, AskCited>} refs
 * @param {{ replays?: ReadonlyMap<string, Replay>, year?: string }} [voices]
 * @returns {Record<string, import('../kit/ask.js').AskRef>}
 */
export const shownRefs = (refs, { replays = new Map(), year = '' } = {}) => Object.fromEntries(Object.entries(refs).map(([handle, cited]) => {
  if (!isMoment(cited)) return [handle, { day: null, title: 'asked' in cited ? cited.asked : 'name' in cited ? cited.name : 'why' in cited ? cited.why : '' }];
  const voice = cited.kind === 'window' ? null : shownVoice(cited, replays, year || (cited.day ?? '').slice(0, 4));
  const merges = 'chat' in cited && cited.chat && !voice;
  return [handle, { day: cited.day ?? null, title: cited.title ?? '', ...('image' in cited && cited.image ? { image: cited.image } : {}),
    ...merges ? { block: cited.chat } : {}, ...voice ? { voice } : {} }];
}));

/**
 * @param {AskCited[]} cited
 * @param {string} year
 * @returns {Moment}
 */
export function momentOf(cited, year) {
  const [first] = cited;
  if ('kind' in first && first.kind === 'row') return { on: '', focus: '', facts: { token: first.ref, asked: first.asked }, head: { icon: 'info', title: first.asked, meta: '' } };
  const place = isMoment(first) ? momentAt(first.opens) : null;
  if (!isMoment(first) || !place) return { on: '', focus: '' };
  const chat = 'chat' in first && first.chat !== undefined;
  return { on: place.on, focus: place.focus, ...(chat ? { whole: true, marks: cited.map(each => 'opens' in each ? momentAt(each.opens)?.focus ?? '' : '').filter(Boolean) } : {}),
    head: { icon: 'image' in first && first.image ? 'photo' : 'days', title: first.title ?? '', meta: shortDay(place.on, year) } };
}

/** @param {Turn} turn */
export const turnDay = turn => dayAt(turn.asked_ms).day;

const NEW_AFTER_MS = 60 * 60_000;

/**
 * @param {Turn[]} turns
 * @param {number} at
 * @param {string} today
 */
export function turnStamp(turns, at, today) {
  const turn = turns[at];
  const before = turns[at - 1];
  const day = turnDay(turn);
  if (before && turnDay(before) === day && turn.asked_ms - before.asked_ms < NEW_AFTER_MS) return '';
  return stampWhen(day, today, clock(turn.asked_ms));
}

/**
 * @param {ChatSummary[]} chats
 * @param {string} today
 * @returns {{ label: string, chats: ChatSummary[] }[]}
 */
export function chatGroups(chats, today) {
  /** @type {{ label: string, chats: ChatSummary[] }[]} */
  const groups = [];
  for (const chat of [...chats].sort((a, b) => b.last_ms - a.last_ms)) {
    const label = groupWhen(dayAt(chat.last_ms).day, today);
    const group = groups.at(-1);
    if (group?.label === label) group.chats.push(chat);
    else groups.push({ label, chats: [chat] });
  }
  return groups;
}
