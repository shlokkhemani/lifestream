// @ts-check
/** @import { Mounted, PageContext } from '../ui/route.js' */
/** @import { Host } from '../lib/host.js' */
/** @import { Route } from '../lib/hash.js' */
/** @import { AskEvent, ChatSummary, Turn } from '../ui/ask/turns.js' */
/** @import { AskLiveView } from '../ui/kit/ask-live.js' */
/** @import { Outcome } from '../lib/ask-outbox.js' */
import { ahead, restOn } from '../lib/ahead.js';
import { askEvents, cancelNote, fetchAskReady, fetchChat, fetchChatPrivacy, fetchLifeDescribe, fetchPrivacy, lifeMediaUrl, openNote,
  pictureUrl, sendSecond, stopAsk, uploadPhoto } from '../lib/api.js';
import { barsOf, mint, noteMs, PHOTO_ACCEPT, photoKind, photosToTake, RATE, wavOf } from '../lib/ask-media.js';
import { bodyOf, outcome } from '../lib/ask-outbox.js';
import { record } from '../ui/ask/recorder.js';
import { DOOR_WORDS, lacks, NOT_SENT, pageReach, wordsOr } from '../lib/reach.js';
import { esc } from '../lib/html.js';
import { today } from '../lib/home-clock.js';
import { clock, levelWords, shortDay } from '../lib/words.js';
import { openingOf } from '../lib/opening.js';
import { chatAccess } from '../ui/ask/access.js';
import { answeringIn, began, followChats, moreWhenNear, readChats, titled } from '../ui/ask/chats.js';
import {
  asking, chatGroups, citedSources, failedSentence, keptVoice, momentOf, replayOf, seenOf, shownRefs, turnDay, turnStamp, turnsOf, voiceShown, withEvent,
} from '../ui/ask/turns.js';
import { SETTINGS_PROVIDERS, SETTINGS_PRIVACY } from '../ui/connectors/settings.js';
import { FEEDBACK } from '../ui/feedback.js';
import { reducedMotion } from '../ui/dom.js';
import {
  adopt, ASK_SENT, askAnswer, askFound, askHome, askLevel, askLive, askPaceOf, askPick, askQuestion, askStarters, askSteps, askThread, askThreadReading, askTurn, askWaiting, chatList,
  chatListReading, chatRow, composer, composerAttach, composerState, holdVoice, inPlaceLine, iconButton, installAsk, installFilterMenus, morph,
  pageHead, thoughtFor,
  noneLine, pageLack, reading, readingAgain, stopVoice, voiceOwner, voicePlays, waitLine, watchPictures,
} from '../ui/kit/index.js';
import { onHomeChange } from '../ui/live.js';
import { findFor, modelFinder } from '../lib/model-menu.js';
import { replyMarkdown } from '../ui/markdown.js';
import { installMomentPanel } from '../ui/panel.js';

const DESCRIBED_AT_ONCE = 20;

const NOT_SAVED = 'Not saved yet: Chat can’t write to your Mac’s disk. It keeps trying.';
const PICKED = 'lifestream.ask.pick';
/** @returns {{ model: string, thinking: string }} */
function readPicked() {
  try {
    const kept = JSON.parse(localStorage.getItem(PICKED) ?? '{}');
    return { model: typeof kept.model === 'string' ? kept.model : '', thinking: typeof kept.thinking === 'string' ? kept.thinking : '' };
  } catch {
    return { model: '', thinking: '' };
  }
}

/** @param {{ model: string, thinking: string }} pick */
function keepPicked(pick) {
  try {
    localStorage.setItem(PICKED, JSON.stringify(pick));
  } catch {}
}

/**
 * @typedef {{ chat: string, title: string, turns: Turn[], read: boolean, failed: import('../lib/reach.js').Drawn | null, open: Set<number>, seen: Set<number>, scroll: number | null, level: '' | Level, pick: '' | Level, reading: number, replays: Map<string, import('../ui/ask/turns.js').Replay>, owner: string }} Thread
 * @typedef {'all' | 'names' | 'none'} Level
 */

/**
 * @param {string} chat
 * @param {string} title
 * @returns {Thread}
 */
const threadOf = (chat, title) => ({ chat, title, turns: [], read: !chat, failed: null, open: new Set(), seen: new Set(), scroll: null, level: '',
  pick: '', reading: 0, replays: new Map(), owner: voiceOwner('answer') });

/**
 * @param {Thread} target
 * @param {Turn} turn
 */
const ownSound = (target, turn) => `own:${turn.submission || `${target.owner} ${turn.n}`}`;

const NOT_CHECKED = 'Lifestream didn’t answer.';

const LEVELS = /** @type {const} */ (['all', 'names', 'none']);

const THREAD_UNREAD = 'This conversation couldn’t be read.';
const THREAD_NOT_HERE = 'This conversation isn’t on this Mac yet.';
const ERASED = 'This conversation was erased.';
const LIST_UNREAD = 'Your conversations couldn’t be read.';
const LIST_NOT_HERE = 'Your conversations aren’t on this Mac yet.';
const MIC_REFUSED_MAC = 'Chat can’t use the microphone: allow Lifestream in System Settings › Privacy & Security › Microphone.';
const MIC_REFUSED = 'Chat can’t use the microphone: allow it for this page in your browser.';
const FLAT = Array.from({ length: 40 }, () => 0.2);
const NOTE_BARS = 48;

/** @typedef {{ file: File, local: string, kind: string, state: 'uploading' | 'ready' | 'failed' | 'lost', hash: string, said: string, status: number, sent: Promise<void> }} Attached */

/** @typedef {{ note: string, parts: Uint8Array[], posts: Promise<void>[], lost: Set<number>, levels: number[], recorder: import('../ui/ask/recorder.js').Recording | null, stopping: boolean }} Recording */

/**
 * @typedef {{ submission: string, chat: string, pick: { model?: string, thinking?: string }, level: '' | Level, words: string,
 *   photos: Attached[], names: string[], note: Recording | null, audio: string, target: Thread,
 *   waits: boolean, resent: boolean, again: string }} Pending
 */

/**
 * @param {HTMLElement} container
 * @param {PageContext} context
 * @param {Host | null} [host]
 * @param {Pick<import('../ui/feedback.js').FeedbackForm, 'entry' | 'follow' | 'open'> | null} [feedback]
 * @returns {Mounted}
 */
export const mountAsk = (container, context, host = null, feedback = null) => {
  context.title('Chat');
  /** @type {Map<string, Thread>} */
  const threads = new Map();
  const chatAhead = ahead(fetchChat);
  /** @type {{ list: ChatSummary[], more: boolean } | null} */
  let chats = null;
  /** @type {import('../lib/reach.js').Drawn | null} */
  let chatsFailed = null;
  const listLack = () => chatsFailed?.kind === 'lack' ? chatsFailed : null;
  /** @type {'ready' | 'unreachable' | 'unready'} */
  let status = 'ready';
  let confirmed = false;
  let heard = false;
  let unsaved = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let recheck;
  /** @type {import('../lib/api.js').AskModel[]} */
  let models = [];
  let said = '';
  let act = '';
  let stopRefused = { target: /** @type {Thread | null} */ (null), words: '' };
  /** @type {import('../lib/api.js').AskReady['default']} */
  let chatDefault = { model: null, thinking: '', shown: null, choose: null };
  /** @type {import('../lib/api.js').AskReady['menu'] | null} */
  let menu = null;
  let otherTyped = '';
  let picked = readPicked();
  /** @type {{ kind: string, question: string }[]} */
  let starters = [];
  let readyRead = 0;
  /** @type {Thread | null} */
  let thread = null;
  let draft = threadOf('', '');
  const access = chatAccess({ host, redraw: () => thread?.turns.forEach((turn, at) => {
    if (turn.access.length) drawTurn(at, false);
  }), shown: () => thread?.turns ?? [] });
  /** @type {Map<Thread, { controller: AbortController, named: boolean, done: boolean }>} */
  const following = new Map();
  /** @type {Map<Thread, Pending[]>} */
  const queued = new Map();
  /** @type {Map<string, { target: Thread, live: ReturnType<typeof askLive>, drawn: AskLiveView | null }>} */
  const lives = new Map();
  let ticking = 0;
  /** @type {{ thread: Thread, at: number, handle: string, from: string } | null} */
  let cited = null;
  /** @type {import('../lib/api.js').AskLimits | null} */
  let limits = null;
  /** @type {import('../lib/api.js').AskVoiceReady | null} */
  let voice = null;
  /** @type {Attached[]} */
  let attached = [];
  let attachSaid = '';
  /** @type {Recording | null} */
  let recording = null;
  let micSaid = '';
  let turnSaid = { target: /** @type {Thread | null} */ (null), words: '' };
  /** @type {Map<string, Pending>} */
  const outbox = new Map();
  /** @type {Set<string>} */
  const toCancel = new Set();
  /** @type {WeakSet<Thread>} */
  const erased = new WeakSet();

  container.innerHTML = '<div class="ck-page ak">'
    + '<header class="ck-page__bar ck-page__bar--slim ak-bar" data-window-drag data-part="bar"></header>'
    + '<div class="ak-under"><div class="ak-main"><div class="ak-stage ck-page__scroll" data-part="stage"></div>'
    + '<div class="ak-foot" data-part="foot"></div></div>'
    + '<aside aria-label="Moment" data-part="panel"></aside></div>'
    + '<div class="ck-flist ak-chats" id="ak-chats" role="dialog" aria-label="Conversations" data-part="chats" inert>'
    + '<input class="ck-fmenu__find mac-body" type="search" placeholder="Search" aria-label="Search conversations" autocomplete="off"'
    + ' spellcheck="false" data-part="chat-find"><div class="ak-chats__list" data-part="chat-list"></div></div></div>';
  /** @param {string} name */
  const part = name => /** @type {HTMLElement} */ (container.querySelector(`[data-part="${name}"]`));
  const root = /** @type {HTMLElement} */ (container.querySelector('.ak'));
  const reach = pageReach(host, root);
  /** @param {import('../lib/reach.js').Retry | null} [retry] */
  const listAgain = (retry = null) => void readList(retry);
  const bar = part('bar');
  const stage = part('stage');
  const foot = part('foot');
  const aside = part('panel');
  const drawer = part('chats');
  const drawerList = part('chat-list');
  const find = /** @type {HTMLInputElement} */ (part('chat-find'));
  let listing = false;
  watchPictures(root);
  holdVoice({
    refuses: () => recording !== null,
    failed: (sound, play) => {
      if (thread && !sound.startsWith('own:')) void replay(thread, sound, play);
    },
  });
  const dock = document.createElement('div');
  dock.className = 'ak-dock';
  dock.dataset.tour = 'ask';
  dock.innerHTML = composer();
  const form = /** @type {HTMLFormElement} */ (dock.firstElementChild);
  const field = /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea'));
  const tools = /** @type {HTMLElement} */ (form.querySelector('.ck-composer__tools'));
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = PHOTO_ACCEPT;
  picker.multiple = true;
  picker.hidden = true;
  dock.append(picker);
  picker.addEventListener('change', () => {
    attach([...picker.files ?? []]);
    picker.value = '';
  });
  const blank = document.createElement('div');
  blank.className = 'ck-composer__blank';
  blank.setAttribute('aria-hidden', 'true');
  installFilterMenus(root, (menu, value) => {
    if (menu.dataset.askMore !== undefined) {
      if (value === FEEDBACK && thread) feedback?.open({ kind: 'chat', chat: thread.chat, n: Number(menu.dataset.askMore) });
      return;
    }
    if (menu.dataset.ckCites !== undefined) {
      return void openCited(Number(menu.dataset.ckCites), value, `[data-ck-cites="${menu.dataset.ckCites}"][data-ck-place="${menu.dataset.ckPlace}"] > button`);
    }
    if (menu.dataset.pick === 'privacy') {
      const level = LEVELS.find(each => each === value);
      if (level) pickLevel(thread ?? draft, level);
      return;
    }
    if (menu.classList.contains('ck-composer__attach')) {
      if (value === 'paste') void paste();
      else if (value === 'photos' || value === 'files') picker.click();
      return;
    }
    if (!menu.classList.contains('ck-pick')) return;
    if (value.startsWith('voice:')) return void pickVoice(value.slice('voice:'.length));
    if (value === 'reset') picked = { model: '', thinking: '' };
    else if (value.startsWith('model:')) {
      const model = value.slice('model:'.length);
      picked = { model, thinking: fits(model, picked.thinking) ? picked.thinking : '' };
    } else if (value.startsWith('thinking:')) {
      picked = { ...picked, thinking: value.slice('thinking:'.length) };
    }
    keepPicked(picked);
    drawPick();
    void readReady();
    field.focus({ preventScroll: true });
  });

  const panel = installMomentPanel(aside, {
    go: (view, patch) => context.go(view, patch),
    again: sentence => edit(sentence),
    closed: () => {
      if (!cited) return;
      const { thread: at, at: turn, from } = cited;
      cited = null;
      if (at !== thread) return;
      drawTurn(turn);
      /** @type {HTMLElement | null} */ (stage.querySelector(from))?.focus({ preventScroll: true });
    },
  });


  /**
   * @param {unknown} error
   * @param {string} otherwise
   */
  const refused = (error, otherwise) => {
    const { status, message } = /** @type {{ status?: number, message?: string }} */ (error);
    return status && message ? message : otherwise;
  };

  /** @param {Thread} target */
  const running = target => target.turns.at(-1)?.end === 'running';

  /** @param {Turn} turn */
  const heldAgain = turn => {
    const pending = outbox.get(turn.submission);
    return Boolean(pending && pending.again !== 'none');
  };

  function noticeMarkup() {
    if (thread && stopRefused.target === thread && running(thread)) return inPlaceLine(stopRefused.words);
    if (thread && turnSaid.target === thread) return inPlaceLine(turnSaid.words);
    if (status === 'unreachable') {
      return inPlaceLine(DOOR_WORDS.ASK_DOWN, { retry: { 'data-ask-action': 'recheck' }, shape: 'caution' });
    }
    if (status === 'unready' && host && act) return inPlaceLine(said, { retry: { 'data-ask-action': 'sign-in' }, label: act, shape: 'caution' });
    if (status === 'unready' && said) return inPlaceLine(said, { shape: 'caution' });
    if (micSaid) {
      return inPlaceLine(micSaid, host && voice && !voice.ready ? { retry: { 'data-ask-action': 'sign-in' }, label: 'Open Providers', shape: 'caution' }
        : { shape: 'caution' });
    }
    if (unsaved) return inPlaceLine('Recent chats are not saved to Lifestream yet.', { shape: 'caution' });
    if (said) return inPlaceLine(said, { shape: 'caution' });
    return '';
  }

  let grouped = { list: /** @type {ChatSummary[] | null} */ (null), groups: /** @type {ReturnType<typeof chatGroups>} */ ([]) };
  /** @param {ChatSummary[]} list */
  function groupsOf(list) {
    if (grouped.list !== list) grouped = { list, groups: chatGroups(list, today()) };
    return grouped.groups;
  }

  function listMarkup() {
    if (status === 'unreachable') return noneLine(DOOR_WORDS.ASK_DOWN);
    const lack = listLack();
    if (lack) return pageLack(lack.words ?? LIST_UNREAD, lack.retry ? { retry: { 'data-ask-action': 'recheck' } } : {});
    if (!chats) return chatListReading() + (chatsFailed ? readingAgain(chatsFailed, LIST_NOT_HERE) : waitLine());
    if (!chats.list.length) return noneLine('No conversations yet.');
    const open = thread?.chat ?? '';
    const words = find.value.trim().toLocaleLowerCase();
    const titleOf = (/** @type {ChatSummary} */ chat) => threads.get(chat.chat)?.title || chat.title;
    const shown = groupsOf(chats.list).map(group => ({
      label: group.label,
      chats: words ? group.chats.filter(chat => titleOf(chat).toLocaleLowerCase().includes(words)) : group.chats,
    })).filter(group => group.chats.length);
    if (!shown.length) return noneLine(`No conversations match “${find.value.trim()}”.`);
    const groups = shown.map(group => ({
      label: group.label,
      rows: group.chats.map(chat => {
        const held = threads.get(chat.chat);
        return chatRow({ title: held?.title || chat.title, selected: chat.chat === open,
          running: Boolean(held && following.has(held) && running(held)), attrs: { 'data-ask-chat': chat.chat } });
      }),
    }));
    return chatList(groups) + (chats.more && !words ? '<div data-ask-list-end aria-hidden="true"></div>' : '');
  }

  /** @type {Map<HTMLElement, string>} */
  const drawn = new Map();
  /**
   * @param {HTMLElement} element
   * @param {string} markup
   */
  function put(element, markup) {
    if (drawn.get(element) === markup) return false;
    drawn.set(element, markup);
    element.innerHTML = markup;
    return true;
  }

  const startersMarkup = () => !thread && askable() && chats?.list.length === 0
    ? askStarters(starters, at => ({ 'data-ask-starter': String(at) })) : '';

  /** @type {() => void} */
  let unwatchList = () => undefined;
  let watching = false;
  function drawLists() {
    dock.dataset.read = !heard || (!chats && !listLack() && status === 'ready') ? 'reading'
      : status === 'ready' && !listLack() ? 'ready' : 'failed';
    dock.toggleAttribute('data-tour-ready', confirmed && status === 'ready');
    answeringIn([...following.keys()].filter(each => each.chat && running(each)).map(each => each.chat));
    if (put(drawerList, listMarkup()) || watching !== listing) {
      unwatchList();
      watching = listing;
      const end = drawerList.querySelector('[data-ask-list-end]');
      unwatchList = end && listing ? moreWhenNear(end, drawerList) : () => undefined;
    }
    const offered = /** @type {HTMLElement | null} */ (stage.querySelector('[data-part="starters"]'));
    if (offered) put(offered, startersMarkup());
  }

  function drawBar() {
    const toggle = iconButton('conversations', 'Conversations', { attrs: { 'data-ask-action': 'chats', 'aria-controls': 'ak-chats',
      'aria-expanded': String(listing) } });
    put(bar, pageHead({
      lead: `<div class="ak-bar__lead">${toggle}${thread ? `<h1 class="ak-bar__title" tabindex="-1">${esc(thread.title)}</h1>`
        : '<h1 class="sr-only ak-bar__title" tabindex="-1">Chat</h1>'}</div>`,
      tools: thread ? [iconButton('compose', 'New conversation',
        { attrs: { 'data-ask-action': 'new', 'aria-keyshortcuts': 'Meta+N', title: 'New conversation ⌘N' } })] : [],
    }));
  }

  const chatsToggle = () => /** @type {HTMLElement | null} */ (bar.querySelector('[data-ask-action="chats"]'));

  function placeChats() {
    const toggle = chatsToggle();
    if (!toggle) return;
    const from = root.getBoundingClientRect();
    const at = toggle.getBoundingClientRect();
    root.style.setProperty('--ak-chats-top', `${at.bottom - from.top}px`);
    root.style.setProperty('--ak-chats-left', `${at.left - from.left}px`);
  }

  /**
   * @param {boolean} on
   * @param {{ back?: boolean }} [how]
   */
  function showChats(on, { back = false } = {}) {
    if (listing === on) return;
    listing = on;
    const toggle = chatsToggle();
    toggle?.setAttribute('aria-expanded', String(on));
    if (on) {
      find.value = '';
      placeChats();
      drawLists();
      drawer.inert = false;
      drawer.classList.add('is-open');
      find.focus({ preventScroll: true });
      drawerList.querySelector('.ck-chat.is-selected')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const inside = drawer.contains(document.activeElement);
    drawer.classList.remove('is-open');
    drawer.inert = true;
    drawLists();
    if (back || inside) toggle?.focus({ preventScroll: true });
  }

  /** @param {KeyboardEvent} event */
  function stepChats(event) {
    const rows = /** @type {HTMLElement[]} */ ([...drawerList.querySelectorAll('[data-ask-chat]')]);
    if (event.key === 'Enter' && event.target === find) {
      event.preventDefault();
      if (rows[0]) openChat(String(rows[0].dataset.askChat));
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const next = event.key === 'ArrowDown' ? Math.min(at + 1, rows.length - 1) : at - 1;
    const target = next < 0 ? find : rows[next];
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }

  function drawHomeNotice() {
    const slot = /** @type {HTMLElement | null} */ (stage.querySelector('[data-part="notice"]'));
    if (!slot) return;
    const lack = listLack();
    const failed = lack ? pageLack(lack.words ?? LIST_UNREAD, lack.retry ? { retry: { 'data-ask-action': 'recheck' } } : {}) : '';
    put(slot, noticeMarkup() || failed);
    reading(stage, !chats && !lack && status !== 'unreachable');
  }

  const askable = () => status === 'ready' && !lacks(reach.reach);

  function drawComposer() {
    drawPick();
    composerState(form, composerNow());
  }
  /** @returns {import('../ui/kit/ask.js').ComposerState} */
  const composerNow = () => !askable() ? 'waiting' : thread && running(thread) ? 'running' : 'ready';

  function drawHome() {
    forgetOwed();
    stage.className = 'ak-stage ck-page__scroll';
    drawn.delete(stage);
    stage.innerHTML = askHome({ notice: '<div class="ak-slot" data-part="notice"></div>', composer: '',
      starters: '<div class="ak-slot" data-part="starters"></div>' });
    /** @type {HTMLElement} */ (stage.querySelector('.ck-ask-home__stage')).append(dock);
    foot.replaceChildren();
    drawn.delete(foot);
    drawHomeNotice();
    drawLists();
  }

  /** @param {Turn} turn */
  const moreOf = turn => {
    const label = feedback?.entry();
    return label && turn.n !== null && turn.end !== 'running'
      ? { items: [{ name: label, value: FEEDBACK }], attrs: { 'data-ask-more': String(turn.n + 1) } } : null;
  };

  /**
   * @param {Thread} target
   * @param {number} at
   */
  function turnMarkup(target, at) {
    const { view, turn } = liveOf(target.turns[at]);
    const now = today();
    const year = now.slice(0, 4);
    const day = turnDay(turn);
    const runs = turn.end === 'running';
    const open = cited && cited.thread === target && cited.at === at ? cited.handle : '';
    const seen = view || turn.n === null ? null : seenOf(turn);
    const model = seen !== null && turn.n !== null && target.seen.has(turn.n);
    const voices = { replays: target.replays, year };
    return askTurn({
      stamp: turnStamp(target.turns, at, now),
      model,
      question: askQuestion(turn.question, { at: `${shortDay(day, year)} · ${clock(turn.asked_ms)}`,
        edit: turn.voice ? null : { 'data-ask-edit': String(at) },
        seen: seen?.asked ?? null, model,
        pictures: turn.photos.map((photo, place) => {
          const covered = seen?.photos?.[place];
          return { src: photo.local || (photo.hash ? pictureUrl(photo.hash, 'tile') : ''), alt: 'Photo', kind: photo.kind,
            ...covered ? { seen: pictureUrl(covered, 'tile') } : {} };
        }),
        voice: turn.voice ? { seconds: turn.voice.ms / 1000, levels: turn.voice.levels.length ? turn.voice.levels : FLAT,
          words: turn.voice.words, sound: ownSound(target, turn), owner: target.owner,
          src: turn.voice.local || (turn.voice.audio ? lifeMediaUrl(turn.voice.audio) : '') } : null }),
      steps: runs && turn.waiting ? askWaiting(turn.waiting, { 'data-ask-action': 'hiding' })
        : askSteps({ said: view ? view.line : turn.thought === null ? '' : thoughtFor(turn.thought), working: view?.working ?? false,
          live: Boolean(view), steps: turn.steps, open: !view && target.open.has(at), attrs: { 'data-ask-steps': String(at) } })
        + access.markup(turn),
      answer: view ? view.shown && askAnswer({ text: view.shown, refs: shownRefs(turn.refs ?? {}, voices), open, paced: true }, {
        markdown: replyMarkdown, year, turn: at, owner: target.owner,
        cite: handle => ({ 'data-ask-cite': `${at} ${handle}` }),
      })
        : runs && !turn.text ? '' : askAnswer({
        text: turn.text, refs: turn.refs ? shownRefs(turn.refs, voices) : null, open, stopped: turn.end === 'stopped',
        seen: seen?.answered ?? null, model, eye: { 'data-ask-seen': String(turn.n) }, more: moreOf(turn),
        failed: turn.end === 'failed' && !(turn.failed === 'login' && status === 'unready')
          ? { sentence: failedSentence(turn),
            retry: heldAgain(turn) || (!outbox.has(turn.submission) && turn.n !== null) ? { 'data-ask-retry': String(at) } : null }
          : null,
      }, {
        markdown: replyMarkdown, year, turn: at, owner: target.owner,
        cite: handle => ({ 'data-ask-cite': `${at} ${handle}` }),
      }) + (turn.unsaved ? inPlaceLine(NOT_SAVED, { shape: 'caution' }) : ''),
    });
  }

  function drawThread() {
    if (!thread) return;
    forgetOwed();
    const target = thread;
    const reads = !target.read && !target.turns.length;
    const lack = target.failed?.kind === 'lack' ? target.failed : null;
    reading(stage, reads && !lack, 'Reading the conversation');
    drawn.delete(stage);
    stage.innerHTML = lack && !target.turns.length
      ? `<div class="ck-ask-thread">${pageLack(lack.words ?? THREAD_UNREAD, lack.retry ? { retry: { 'data-ask-action': 'reread' } } : {})}</div>`
      : reads ? askThreadReading() + (target.failed ? readingAgain(target.failed, THREAD_NOT_HERE) : waitLine())
        : askThread(target.turns.map((_, at) => turnMarkup(target, at)));
    adopt(stage);
    measure();
  }

  /** @type {Set<number>} */
  const owed = new Set();
  let frame = 0;
  /**
   * @param {number} at
   * @param {boolean} [now]
   */
  function drawTurn(at, now = true) {
    owed.add(at);
    if (!now) {
      frame ||= requestAnimationFrame(flush);
      return;
    }
    flush();
  }
  function flush() {
    const turns = [...owed];
    forgetOwed();
    if (!thread) return;
    const sections = stage.querySelectorAll('.ck-ask-thread > .ck-ask-turn');
    if (sections.length !== thread.turns.length) return drawThread();
    for (const at of turns) {
      if (sections[at]) patch(sections[at], turnMarkup(thread, at), lives.has(thread.turns[at].submission));
    }
    markEnd();
  }
  function forgetOwed() {
    cancelAnimationFrame(frame);
    frame = 0;
    owed.clear();
  }

  /**
   * @param {Element} section
   * @param {string} markup
   * @param {boolean} live
   */
  function patch(section, markup, live) {
    const shell = document.createElement('div');
    shell.innerHTML = markup;
    const next = /** @type {Element} */ (shell.firstElementChild);
    if (live) return morph(section, next);
    const parts = [...next.children];
    if (parts.length !== section.children.length) {
      adopt(next);
      return void section.replaceWith(next);
    }
    parts.forEach((part, at) => {
      const now = section.children[at];
      if (now.outerHTML === part.outerHTML) return;
      if (now.matches('.ck-steps') && part.matches('.ck-steps')) morph(now, part);
      else {
        adopt(part);
        now.replaceWith(part);
      }
    });
  }

  /**
   * @param {Turn} turn
   * @returns {{ view: AskLiveView | null, turn: Turn }}
   */
  function liveOf(turn) {
    const kept = turn.submission ? lives.get(turn.submission) : undefined;
    if (!kept) return { view: null, turn };
    const view = kept.live.at(Date.now());
    return view.settled ? { view: null, turn: landed(turn) } : { view, turn };
  }

  /**
   * @param {Thread} target
   * @param {string} submission
   * @param {number} start
   * @param {boolean} [followed]
   */
  function begin(target, submission, start, followed = false) {
    lives.set(submission, { target, live: askLive(start, askPaceOf(root), { followed }), drawn: null });
    ticking ||= requestAnimationFrame(tick);
  }

  /**
   * @param {Turn} turn
   * @returns {Turn}
   */
  function landed(turn) {
    const kept = lives.get(turn.submission);
    if (!kept) return turn;
    const view = kept.live.at(Date.now());
    return { ...turn, text: kept.live.answer() || turn.text, thought: view.thought ?? turn.thought ?? Date.now() - turn.asked_ms };
  }

  function tick() {
    ticking = 0;
    for (const [submission, kept] of [...lives]) {
      const at = kept.target.turns.findIndex(each => each.submission === submission);
      const turn = kept.target.turns[at];
      if (!turn) {
        lives.delete(submission);
        continue;
      }
      const view = kept.live.at(Date.now());
      if (view.settled && turn.end !== 'running') {
        settle(kept.target, landed(turn));
        lives.delete(submission);
        continue;
      }
      if (view === kept.drawn) continue;
      kept.drawn = view;
      if (thread === kept.target) drawTurn(at);
    }
    if (lives.size) ticking = requestAnimationFrame(tick);
  }

  /**
   * @param {string} submission
   * @param {import('../ui/kit/ask-live.js').AskLiveEvent} event
   */
  function feed(submission, event) {
    lives.get(submission)?.live.hear(event, Date.now());
  }

  function measure() {
    const style = getComputedStyle(stage);
    stage.style.setProperty('--ak-view', `${Math.max(0, stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))}px`);
    markEnd();
  }

  function markEnd() {
    const end = /** @type {HTMLElement | null} */ (foot.querySelector('.ak-end'));
    if (!end) return;
    const last = thread ? stage.querySelector('.ck-ask-thread > .ck-ask-turn:last-child')?.lastElementChild : null;
    end.hidden = !last || last.getBoundingClientRect().bottom <= stage.getBoundingClientRect().bottom + 1;
  }

  /** @param {number} at */
  function scrollToTurn(at) {
    const section = /** @type {HTMLElement | undefined} */ (stage.querySelectorAll('.ck-ask-thread > .ck-ask-turn')[at]);
    if (section) stage.scrollTop = section.offsetTop - parseFloat(getComputedStyle(stage).paddingTop);
    markEnd();
  }

  /** @param {Thread} target */
  function enter(target) {
    if (cited) panel.close();
    if (thread && thread !== target) stopVoice(thread.owner);
    thread = target;
    if (context.route.chat !== target.chat) context.set({ chat: target.chat });
    stage.className = 'ak-stage ck-page__scroll ak-stage--thread';
    drawBar();
    put(foot, iconButton('expand', 'Scroll to the end', { variant: 'raised', attrs: { 'data-ask-action': 'end' }, className: 'ak-end' })
      + '<div class="ak-slot" data-part="notice"></div>');
    foot.append(dock);
    drawNotice();
    drawThread();
    if (target.scroll !== null) stage.scrollTop = target.scroll;
    else scrollToTurn(target.turns.length - 1);
    drawComposer();
    drawLists();
    void readLevel(target);
  }

  function drawNotice() {
    const slot = /** @type {HTMLElement | null} */ (foot.querySelector('[data-part="notice"]'));
    if (slot) put(slot, noticeMarkup());
  }

  function goHome() {
    showChats(false);
    if (cited) panel.close();
    if (thread) stopVoice(thread.owner);
    thread = null;
    if (context.route.chat) context.set({ chat: '' });
    drawBar();
    drawHome();
    drawComposer();
    field.focus();
    void readStart();
  }

  /** @param {string} chat */
  function openChat(chat) {
    showChats(false);
    let target = threads.get(chat);
    if (!target) {
      const title = chats?.list.find(each => each.chat === chat)?.title ?? '';
      target = threadOf(chat, title);
      threads.set(chat, target);
    }
    enter(target);
    void reread(target);
    field.focus({ preventScroll: true });
  }

  /**
   * @param {Thread} target
   * @param {import('../lib/reach.js').Retry | null} [retry]
   */
  async function reread(target, retry = null) {
    if (!target.chat || following.has(target)) return;
    const fresh = target.scroll === null;
    const begun = reach.begin(retry);
    try {
      const conversation = await chatAhead.take(target.chat);
      if (following.has(target) || erased.has(target)) return;
      const heard = target.turns.filter(turn => !outbox.has(turn.submission)).at(-1);
      const turns = turnsOf(conversation);
      const kept = turns.at(-1);
      if (heard && kept && heard.end === 'failed' && kept.end === 'failed' && kept.failed === 'other' && heard.question === kept.question) {
        turns[turns.length - 1] = { ...kept, failed: heard.failed };
      }
      target.title = conversation.title;
      target.turns = [...turns, ...target.turns.filter(turn => outbox.has(turn.submission))];
      void describeKept(target);
      target.read = true;
      target.failed = null;
      if (conversation.running) follow(target, conversation.running.n);
    } catch (error) {
      if (erased.has(target)) return;
      if (outcome('named', answerOf(error)).copies === 'purge') return purge(target);
      if (unreachable(error)) return;
      /** @param {import('../lib/reach.js').Retry | null} [given] */
      const again = (given = null) => {
        if (threads.get(target.chat) === target) void reread(target, given);
      };
      target.failed = reach.failed(error, begun, again);
      if (target.failed.kind === 'wait') setTimeout(() => again(), Math.max(0, target.failed.until - Date.now()));
    }
    if (thread === target) {
      const scroll = target.scroll;
      drawBar();
      drawThread();
      if (fresh || scroll === null) scrollToTurn(target.turns.length - 1);
      else stage.scrollTop = scroll;
      drawComposer();
    }
    drawLists();
    release(target);
  }

  /**
   * @param {Thread} target
   * @param {string} sound
   * @param {number} play
   */
  async function replay(target, sound, play) {
    /** @type {Map<string, Set<number>>} */
    const records = new Map();
    target.turns.forEach((turn, at) => {
      for (const cited of Object.values(turn.refs ?? {})) {
        const shown = voiceShown(cited, target.replays);
        const kept = keptVoice(cited);
        if (kept && shown && shown !== 'erased' && shown.voice.audio === sound) records.set(kept.record, (records.get(kept.record) ?? new Set()).add(at));
      }
    });
    await Promise.all([...records].map(async ([record, turns]) => {
      const replayed = await fetchLifeDescribe([record]).then(answer => replayOf(record, answer, NOT_CHECKED),
        error => replayOf(record, null, wordsOr(error, NOT_CHECKED)));
      if (voicePlays(sound) !== play) return;
      target.replays.set(record, replayed);
      if (thread === target) for (const at of turns) drawTurn(at);
    }));
  }

  /** @param {Thread} target */
  async function describeKept(target) {
    const alone = [...new Set(target.turns.flatMap(turn => Object.values(turn.refs ?? {}).flatMap(cited => ('kind' in cited ? [] : [cited.ref]))))];
    /** @type {Map<string, import('../ui/ask/turns.js').AskCited>} */
    const described = new Map();
    let left = alone;
    while (left.length > 0) {
      const asked = left.slice(0, DESCRIBED_AT_ONCE);
      const answer = await fetchLifeDescribe(asked).catch(() => null);
      if (answer === null) break;
      for (const each of answer.described) described.set(each.ref, each);
      const unopened = new Set(answer.unopened ?? []);
      if (asked.every(ref => unopened.has(ref))) break;
      left = [...asked.filter(ref => unopened.has(ref)), ...left.slice(asked.length)];
    }
    if (described.size === 0) return;
    target.turns = target.turns.map(turn => (turn.refs === null ? turn
      : { ...turn, refs: Object.fromEntries(Object.entries(turn.refs).map(([handle, cited]) => [handle, 'kind' in cited ? cited : described.get(cited.ref) ?? cited])) }));
    if (thread === target) drawThread();
  }

  /** @param {unknown} error */
  function unreachable(error) {
    if (/** @type {{ code?: string }} */ (error).code !== 'ASK_DOWN') return false;
    status = 'unreachable';
    drawStatus();
    return true;
  }

  function drawStatus() {
    drawNotice();
    drawHomeNotice();
    drawComposer();
    drawLists();
    thread?.turns.forEach((turn, at) => {
      if (turn.failed === 'login') drawTurn(at);
    });
  }

  /**
   * @param {Thread} target
   * @param {number} n
   */
  function follow(target, n) {
    const at = target.turns.findIndex(turn => turn.n === n - 1);
    const last = target.turns[at];
    if (!last) return;
    const key = last.submission || `follow:${n}`;
    const { photos, voice } = last;
    const followed = asking(last.question, last.asked_ms, { photos, voice, n: last.n, submission: key });
    target.turns = target.turns.map((each, index) => index === at ? followed : each);
    begin(target, key, last.asked_ms, true);
    run(target, { follow: target.chat }, n, null, key);
  }

  /**
   * @param {Thread} target
   * @param {string} submission
   */
  const current = (target, submission) => (submission && target.turns.find(turn => turn.submission === submission)) || target.turns.at(-1);

  /**
   * @param {string} words
   * @param {{ fromField?: boolean, note?: Recording | null }} [options]
   */
  function send(words, { fromField = true, note = null } = {}) {
    if (!askable() || (thread && running(thread))) return;
    const files = attached;
    const failed = files.find(each => each.state === 'failed');
    if (failed) {
      attachSaid = failed.said || attachSaid;
      return void drawParts();
    }
    const wav = note ? new Blob([wavOf(note.parts)], { type: 'audio/wav' }) : null;
    /** @type {import('../ui/ask/turns.js').TurnVoice | null} */
    const voiced = note && wav ? { ms: noteMs(note.parts.reduce((sum, part) => sum + part.length, 0)), audio: '',
      local: URL.createObjectURL(wav), levels: barsOf(note.levels, NOTE_BARS), words: null } : null;
    attached = [];
    attachSaid = '';
    if (fromField && !note) {
      field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    drawParts();
    const target = thread ?? draft;
    if (!thread) {
      target.title = voiced ? 'Voice note' : words.split('\n')[0];
      draft = threadOf('', '');
    }
    ask(target,
      { words: voiced ? '' : words, photos: files, names: [], note, audio: '' },
      files.map(each => ({ hash: each.hash, local: each.local, kind: each.kind })), voiced);
    field.focus({ preventScroll: true });
    dock.dispatchEvent(new CustomEvent(ASK_SENT, { bubbles: true }));
  }

  /**
   * @param {Thread} target
   * @param {Pick<Pending, 'words' | 'photos' | 'names' | 'note' | 'audio'>} question
   * @param {import('../ui/ask/turns.js').TurnPhoto[]} photos
   * @param {import('../ui/ask/turns.js').TurnVoice | null} voiced
   */
  function ask(target, question, photos, voiced) {
    micSaid = '';
    turnSaid = { target: null, words: '' };
    const level = target.pick;
    if (target.chat) {
      target.pick = '';
      target.reading += 1;
    }
    /** @type {Pending} */
    const pending = { ...question, submission: mint(), chat: target.chat, pick: pickOf(), level, target, waits: false,
      resent: false, again: '' };
    outbox.set(pending.submission, pending);
    const asked = Date.now();
    target.turns = [...target.turns, asking(pending.words, asked, { photos, voice: voiced, submission: pending.submission })];
    begin(target, pending.submission, asked);
    if (thread === target) {
      drawThread();
      scrollToTurn(target.turns.length - 1);
      drawComposer();
    } else moveComposer(() => enter(target));
    post(pending);
  }

  /** @param {Pending} pending */
  function post(pending) {
    const { target } = pending;
    const turn = target.turns.find(each => each.submission === pending.submission);
    if (!turn) return;
    pending.waits = false;
    const active = following.get(target);
    const waiting = Boolean(active && !active.done);
    if (waiting) {
      const line = queued.get(target) ?? [];
      if (!line.includes(pending)) queued.set(target, [...line, pending]);
    } else if (target.turns.at(-1) !== turn) {
      target.turns = [...target.turns.filter(each => each !== turn), turn];
      if (thread === target) drawThread();
    }
    if (turn.end !== 'running') {
      begin(target, turn.submission, Date.now());
      settle(target, { ...turn, end: 'running', failed: '', error: '', text: '', steps: [], refs: null });
      if (thread === target) drawComposer();
      drawLists();
    }
    if (!waiting) run(target, { ask: prepare(pending) }, target.turns.length * 2, pending);
  }

  /** @param {Thread} target */
  function release(target) {
    const active = following.get(target);
    if (active && !active.done) return;
    const next = queued.get(target)?.shift();
    if (next) post(next);
  }

  /**
   * @param {Pending} pending
   * @returns {Promise<import('../lib/api.js').AskBody>}
   */
  async function prepare(pending) {
    await Promise.all(pending.photos.map(each => each.sent));
    for (const photo of pending.photos.filter(each => each.state === 'lost' || (each.state === 'failed' && each.status >= 500))) {
      upload(photo);
      await photo.sent;
    }
    const refusedPhoto = pending.photos.find(each => each.state !== 'ready');
    if (refusedPhoto) {
      const answer = refusedPhoto.state === 'failed' ? { status: refusedPhoto.status, photo: true } : { status: 503 };
      throw Object.assign(new Error(refusedPhoto.said || NOT_SENT), answer);
    }
    const note = pending.note;
    if (note) {
      await Promise.all(note.posts);
      for (const k of [...note.lost]) postSecond(note, k);
      await Promise.all(note.posts);
      if (note.lost.size) throw Object.assign(new Error(NOT_SENT), { status: 503 });
    }
    const names = [...pending.photos.map(each => each.hash), ...pending.names];
    const turn = current(pending.target, pending.submission);
    if (turn?.photos.some((each, at) => each.hash !== names[at])) {
      settle(pending.target, { ...turn, photos: turn.photos.map((each, at) => ({ ...each, hash: names[at] ?? '' })) });
    }
    const body = bodyOf({ submission: pending.submission, chat: pending.chat, pick: pending.pick, words: pending.words, photos: names,
      note: note ? { id: note.note, seconds: note.parts.length } : null, audio: pending.audio });
    return pending.level ? { ...body, level: pending.level } : body;
  }

  /** @param {() => void} change */
  function moveComposer(change) {
    const before = dock.getBoundingClientRect();
    change();
    const after = dock.getBoundingClientRect();
    const tokens = getComputedStyle(document.documentElement);
    const timing = { duration: parseFloat(tokens.getPropertyValue('--duration-slow')) || 0,
      easing: tokens.getPropertyValue('--ease-in-out').trim() || 'ease-in-out' };
    if (reducedMotion()) dock.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    else {
      dock.animate([{ transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` }, { transform: 'none' }],
        timing);
    }
  }

  /**
   * @param {Thread} target
   * @param {{ ask: Promise<import('../lib/api.js').AskBody> } | { follow: string }} what
   * @param {number} n
   * @param {Pending | null} [pending]
   * @param {string} [submission]
   */
  function run(target, what, n, pending = null, submission = pending?.submission ?? '') {
    following.get(target)?.controller.abort();
    const controller = new AbortController();
    const mine = { controller, named: false, done: false };
    following.set(target, mine);
    const owns = () => following.get(target) === mine;
    drawLists();
    let counted = target.read;
    /** @type {string[]} */
    const events = [];
    const stream = 'ask' in what
      ? what.ask.then(body => askEvents({ ask: body }, heard, controller.signal))
      : askEvents(what, heard, controller.signal);
    /** @param {AskEvent} event */
    function heard(event) {
      if (controller.signal.aborted) return;
      if (event.type === 'chat') {
        mine.named = true;
        counted &&= event.n === n;
        if (!counted && 'follow' in what) {
          controller.abort();
          following.delete(target);
          return void reread(target);
        }
        events.length = 0;
        feed(submission, event);
        if (pending) named(pending, event);
        nameThread(target, event.chat);
        if ('ask' in what) {
          target.pick = '';
          void readLevel(target);
        }
        return;
      }
      events.push(event.type === 'error' && event.error === 'erased' ? 'error:erased' : event.type);
      hear(target, event, submission);
      if (event.type !== 'done' || !owns()) return;
      mine.done = true;
      release(target);
    }
    /** @param {() => void} then */
    const close = then => {
      if (controller.signal.aborted || !owns()) return;
      following.delete(target);
      if ('ask' in what) void readLevel(target);
      then();
      release(target);
    };
    stream.then(ran => close(() => {
      if (!ran) return void reread(target);
      if (pending && !mine.named) return decide(pending, outcome('sending', { events }), null);
      ended(target, outcome('named', { events }), counted, submission);
    }), error => close(() => {
      if (pending && !mine.named) return decide(pending, outcome('sending', answerOf(error)), error);
      const row = outcome('named', mine.named ? { lost: true } : answerOf(error));
      if (mine.named || row.copies === 'purge') return ended(target, row, counted, submission);
      if (!unreachable(error) && row.name === 'not readable yet') return ended(target, row, counted, submission);
      const last = current(target, submission);
      if (last) settle(target, { ...last, end: 'failed', failed: refused(error, 'other') });
    }));
  }

  /** @param {unknown} error @returns {import('../lib/ask-outbox.js').Answer} */
  const answerOf = error => {
    const { status, missing, photo } = /** @type {{ status?: number, missing?: unknown, photo?: boolean }} */ (
      error ?? {});
    if (typeof status !== 'number') return { lost: true };
    const kinds = missing && typeof missing === 'object'
      ? Object.entries(missing).filter(([, files]) => Array.isArray(files) && files.length).map(([kind]) => kind)
      : undefined;
    return { status, ...(kinds ? { missing: kinds } : {}), ...(photo ? { photo } : {}) };
  };

  /**
   * @param {Thread} target
   * @param {Outcome} row
   * @param {boolean} counted
   * @param {string} submission
   */
  function ended(target, row, counted, submission) {
    if (row.copies === 'purge') return purge(target);
    if (row.turn === 'follow' || !counted || current(target, submission)?.end === 'running') return void reread(target);
    void readList(null, { again: true });
    void readReady();
  }

  /**
   * @param {Pending} pending
   * @param {Outcome} row
   * @param {unknown} error
   */
  function decide(pending, row, error) {
    const { target } = pending;
    if (error) unreachable(error);
    const turn = current(target, pending.submission);
    if (!turn) return;
    pending.again = row.again;
    if (row.copies === 'purge') return purge(target);
    const failed = error ? refused(error, 'other') : 'other';
    const ends = { end: /** @type {const} */ ('failed') };
    if (row.copies === 'drop') return settle(target, { ...letGo(pending, turn), ...ends, failed });
    if (row.name === 'missing') return void sendMissing(pending, error);
    if (row.name === 'photo refused') {
      return settle(target, { ...withoutRefused(pending, turn), ...ends, failed });
    }
    if (row.turn === 'failed') return settle(target, { ...turn, ...ends, failed: turn.failed || failed });
    pending.waits = true;
  }

  /**
   * @param {Pending} pending
   * @param {unknown} error
   */
  async function sendMissing(pending, error) {
    const { target } = pending;
    const { missing = {} } = /** @type {{ missing?: { photos?: string[], seconds?: number[] } }} */ (error);
    const mine = { controller: new AbortController(), named: false, done: false };
    following.set(target, mine);
    const resent = !pending.resent && await resend(pending, missing);
    if (following.get(target) !== mine) return;
    following.delete(target);
    if (resent) {
      pending.resent = true;
      return post(pending);
    }
    const turn = current(target, pending.submission);
    if (turn) settle(target, { ...turn, end: 'failed', failed: refused(error, 'other') });
    release(target);
  }

  /**
   * @param {Pending} pending
   * @param {{ photos?: string[], seconds?: number[] }} missing
   */
  async function resend(pending, missing) {
    const photos = (missing.photos ?? []).map(hash => pending.photos.find(each => each.hash === hash));
    const note = pending.note;
    const seconds = (missing.seconds ?? []).map(k => note?.parts[k] ? { k, bytes: note.parts[k] } : null);
    if (photos.some(each => !each) || seconds.some(each => !each)) return false;
    try {
      await Promise.all([...photos.map(each => uploadPhoto(/** @type {Attached} */ (each).file)),
        ...seconds.map(each => sendSecond(/** @type {Recording} */ (note).note, /** @type {{ k: number }} */ (each).k,
          /** @type {{ bytes: Uint8Array }} */ (each).bytes))]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {Pending} pending
   * @param {{ chat: string, n: number, audio?: string }} event
   */
  function named(pending, event) {
    const turn = current(pending.target, pending.submission);
    if (!turn) return void outbox.delete(pending.submission);
    const kept = letGo(pending, turn);
    const voice = kept.voice && { ...kept.voice, audio: kept.voice.audio || event.audio || '' };
    settle(pending.target, { ...kept, voice, n: event.n - 1 });
  }

  /**
   * @param {Pending} pending
   * @param {Turn} turn
   * @returns {Turn}
   */
  function letGo(pending, turn) {
    outbox.delete(pending.submission);
    for (const url of [...pending.photos.map(each => each.local), turn.voice?.local ?? '']) {
      if (url) URL.revokeObjectURL(url);
    }
    const voice = turn.voice && { ...turn.voice, local: '' };
    return { ...turn, photos: turn.photos.map(each => ({ ...each, local: '' })), voice };
  }

  /**
   * @param {Pending} pending
   * @param {Turn} turn
   * @returns {Turn}
   */
  function withoutRefused(pending, turn) {
    const kept = pending.photos.map(each => each.state !== 'failed');
    for (const photo of pending.photos) if (photo.state === 'failed' && photo.local) URL.revokeObjectURL(photo.local);
    pending.photos = pending.photos.filter((_, at) => kept[at]);
    return { ...turn, photos: turn.photos.filter((_, at) => kept[at] ?? true) };
  }

  /**
   * @param {Thread} target
   * @param {number} at
   */
  async function retry(target, at) {
    const turn = target.turns[at];
    if (!turn) return;
    const pending = outbox.get(turn.submission);
    if (pending) {
      if (pending.again === 'none') return;
      pending.resent = false;
      return post(pending);
    }
    if (turn.n === null || !askable() || running(target)) return;
    const audio = turn.voice?.audio ?? '';
    if (turn.voice && !audio) {
      turnSaid = { target, words: 'This voice note can’t be sent again yet.' };
      return void drawNotice();
    }
    ask(target, { words: turn.question, photos: [], names: turn.photos.map(each => each.hash), note: null, audio },
      turn.photos, turn.voice ? { ...turn.voice, audio, words: null } : null);
  }

  /**
   * @param {Thread} target
   * @param {AskEvent} event
   * @param {string} submission
   */
  function hear(target, event, submission) {
    if (event.type === 'chat') return;
    if (event.type === 'title') {
      target.title = event.title;
      if (thread === target) drawBar();
      return titled(target.chat, event.title);
    }
    const turn = current(target, submission);
    if (!turn || (event.type === 'error' && event.error === 'erased')) return;
    if (event.type === 'error' && event.error === 'login') {
      status = 'unready';
      said = event.message ?? '';
      drawStatus();
      void readReady();
    }
    if (event.type === 'step' || event.type === 'text' || event.type === 'done') feed(turn.submission, event);
    settle(target, withEvent(turn, event), event.type === 'text');
  }

  /**
   * @param {Thread} target
   * @param {Turn} turn
   * @param {boolean} [streaming]
   */
  function settle(target, turn, streaming = false) {
    if (turn.end !== 'running' && turn.end !== 'done' && lives.has(turn.submission)) {
      const ended = landed(turn);
      lives.delete(turn.submission);
      return settle(target, ended, streaming);
    }
    const found = turn.submission ? target.turns.findIndex(each => each.submission === turn.submission) : -1;
    const at = found < 0 ? target.turns.length - 1 : found;
    target.turns = target.turns.map((each, index) => index === at ? turn : each);
    if (thread === target) drawTurn(at, !streaming);
    if (turn.end !== 'running') {
      if (stopRefused.target === target) stopRefused = { target: null, words: '' };
      if (thread === target) {
        drawComposer();
        drawNotice();
      }
      drawLists();
    }
  }

  /** @param {Thread} target */
  function purge(target) {
    erased.add(target);
    following.get(target)?.controller.abort();
    following.delete(target);
    queued.delete(target);
    for (const pending of [...outbox.values()]) {
      const turn = pending.target === target && target.turns.find(each => each.submission === pending.submission);
      if (turn) letGo(pending, turn);
      else if (pending.target === target) outbox.delete(pending.submission);
    }
    stopVoice(target.owner);
    target.turns = [];
    target.read = true;
    target.failed = { kind: 'lack', words: ERASED, retry: false };
    if (thread === target) {
      drawThread();
      drawComposer();
    }
    drawLists();
    void readList(null, { again: true });
  }

  function homeAnswers() {
    for (const pending of [...outbox.values()]) if (pending.waits) post(pending);
    for (const note of [...toCancel]) cancelHeld(note);
  }

  /** @param {string} note */
  function cancelHeld(note) {
    toCancel.add(note);
    cancelNote(note).then(() => toCancel.delete(note), error => {
      const { status: answered } = /** @type {{ status?: number }} */ (error ?? {});
      if (typeof answered === 'number' && answered < 500) toCancel.delete(note);
    });
  }

  /**
   * @param {Thread} target
   * @param {string} chat
   */
  function nameThread(target, chat) {
    if (target.chat === chat) return;
    target.chat = chat;
    threads.set(chat, target);
    if (thread === target) context.set({ chat });
    began(chat, target.title);
    drawLists();
  }

  function stop() {
    const target = thread;
    if (!target || !running(target) || !following.get(target)?.named) return;
    const chat = target.chat;
    stopRefused = { target: null, words: '' };
    drawNotice();
    stopAsk(chat).catch(error => {
      stopRefused = { target, words: refused(error, 'The answer could not be stopped.') };
      if (thread === target) drawNotice();
    });
  }

  /**
   * @param {import('../lib/reach.js').Retry | null} [retry]
   * @param {{ again?: boolean }} [options]
   */
  async function readList(retry = null, { again = retry !== null } = {}) {
    const begun = reach.begin(retry);
    try {
      if (await readChats({ again }) === null) return;
      chatsFailed = null;
    } catch (error) {
      if (unreachable(error)) return;
      chatsFailed = reach.failed(error, begun, listAgain);
      if (chatsFailed.kind === 'wait') setTimeout(() => listAgain(), Math.max(0, chatsFailed.until - Date.now()));
    }
    drawLists();
    drawHomeNotice();
  }

  /** @param {string} id */
  const modelOf = id => models.find(each => each.id === id) ?? models.find(each => each.id === chatDefault.model);
  /** @param {import('../lib/api.js').AskModel} model */
  const startOf = model => model.id !== picked.model && model.thinking.includes(chatDefault.thinking) ? chatDefault.thinking : model.default;
  /**
   * @param {string} id
   * @param {string} level
   */
  const fits = (id, level) => !level || Boolean(modelOf(id)?.thinking.includes(level));
  const pickOf = () => ({ ...(picked.model ? { model: picked.model } : {}), ...(picked.thinking ? { thinking: picked.thinking } : {}) });

  let pickDrawn = '';
  /** @type {string[]} */
  let toolsDrawn = [];
  let picturesDrawn = '';
  tools.addEventListener('ck-fmenu-closed', () => {
    otherTyped = '';
    drawPick();
  });

  const finder = modelFinder(() => showFound());

  function findNow() {
    if (!menu) return null;
    const found = finder.find(findFor(menu.more), otherTyped);
    const answer = found?.answer ?? null;
    return { placeholder: answer?.placeholder ?? '', found: answer?.groups ?? [], none: answer?.none ?? found?.failed ?? '' };
  }

  function showFound() {
    const now = findNow();
    const shown = tools.querySelector('.ck-pick__found');
    const find = /** @type {HTMLInputElement | null} */ (tools.querySelector('[data-ask-find]'));
    if (!now || !shown || !find) return;
    find.placeholder = now.placeholder;
    shown.innerHTML = askFound(now.found, picked.model, now.none);
  }

  const focusFind = () => requestAnimationFrame(() => {
    const find = /** @type {HTMLInputElement | null} */ (tools.querySelector('[data-ask-find]'));
    if (find && !find.closest('[hidden]')) find.focus({ preventScroll: true });
  });
  tools.addEventListener('click', event => {
    if (/** @type {Element} */ (event.target).closest('[data-ck-page="other"]')) focusFind();
  });
  tools.addEventListener('keydown', event => {
    const target = /** @type {Element} */ (event.target);
    if (target.matches('[data-ask-find]')) {
      if (event.key === 'Enter') {
        event.preventDefault();
        /** @type {HTMLElement | null} */ (tools.querySelector('.ck-pick__found .ck-fmenu__item:not([aria-disabled="true"])'))?.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        /** @type {HTMLElement | null} */ (tools.querySelector('.ck-pick .ck-fmenu__btn'))?.click();
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === 'ArrowRight') && tools.querySelector('.ck-pick .is-lit[data-ck-page="other"]')) focusFind();
  });
  tools.addEventListener('input', event => {
    const target = /** @type {Element} */ (event.target);
    if (!(target instanceof HTMLInputElement) || !target.matches('[data-ask-find]')) return;
    otherTyped = target.value;
    showFound();
  });

  function drawPick() {
    const asks = modelOf(picked.model);
    const model = asks ?? models.find(each => each.id === chatDefault.shown);
    const thinking = model ? picked.thinking || startOf(model) : '';
    const named = model?.name ?? chatDefault.choose;
    pickDrawn = named ? askPick({
      model: named, level: levelWords(thinking),
      levels: model ? model.thinking.map(level => ({ value: level, label: levelWords(level) })) : [],
      thinking, menu: menu ?? { rows: [], local: null }, chosen: asks?.id ?? '',
      reset: Boolean(picked.model || picked.thinking),
      voice: voice ? { words: voice.words, caution: voice.caution, choices: host ? voice.choices.map(choice => ({ value: choice.value,
        words: choice.words, chosen: choice.value === voice?.value || (voice?.value === 'default' && choice.words === voice.words) })) : [] } : null,
      find: findNow(),
    }) + (model?.hides ? levelMenu() : '') : '';
    drawParts();
  }

  function levelMenu() {
    const target = thread ?? draft;
    return target.level ? askLevel({ level: target.level, waiting: running(target), attrs: { 'data-pick': 'privacy' } }) : '';
  }

  /** @param {Thread} target */
  const shown = target => (thread ?? draft) === target;

  /** @param {Thread} target */
  function drawLevel(target) {
    if (shown(target)) drawPick();
  }

  /** @param {Thread} target */
  async function readLevel(target) {
    if (!target.chat) return;
    const mine = ++target.reading;
    try {
      const read = await fetchChatPrivacy(target.chat);
      if (target.pick || mine !== target.reading) return;
      target.level = read.level;
    } catch {}
    drawLevel(target);
  }

  async function readStart() {
    const target = draft;
    const mine = ++target.reading;
    try {
      const { chat } = /** @type {{ chat?: unknown }} */ (await fetchPrivacy());
      if (target.pick || target.chat || mine !== target.reading) return;
      target.level = LEVELS.find(each => each === chat) ?? '';
    } catch {}
    drawLevel(target);
  }

  /**
   * @param {Thread} target
   * @param {Level} level
   */
  function pickLevel(target, level) {
    if (running(target)) return;
    target.level = level;
    target.pick = level;
    drawLevel(target);
  }

  const offersPhotos = () => limits !== null;
  function photosOff() {
    return modelOf(picked.model)?.photos_off ?? '';
  }

  function drawParts() {
    const shell = document.createElement('div');
    shell.innerHTML = composer({
      attach: offersPhotos() && attached.length < (limits?.photos ?? 0) ? composerAttach({ off: photosOff() }) : '',
      pick: pickDrawn, mic: voice ? { 'data-ask-action': 'mic' } : null,
      pictures: attached.map(each => ({ src: each.local, alt: each.file.name || 'Photo', kind: each.kind,
        ...(each.state === 'uploading' || each.state === 'failed' ? { state: each.state } : {}) })),
      remove: at => ({ 'data-ask-unpick': String(at) }), said: attachSaid,
      recording: recording ? { seconds: recording.levels.length / 10, levels: barsOf(recording.levels.slice(-120), 120),
        stop: { 'data-ask-action': 'rec-stop' }, cancel: { 'data-ask-action': 'rec-cancel' } } : null,
    });
    const made = /** @type {HTMLElement} */ (shell.firstElementChild);
    const pictures = [...made.children].filter(each => each.matches('.ck-composer__pictures, .ck-composer__said'));
    const markup = pictures.map(each => each.outerHTML).join('');
    if (markup !== picturesDrawn) {
      picturesDrawn = markup;
      for (const each of form.querySelectorAll(':scope > .ck-composer__pictures, :scope > .ck-composer__said')) each.remove();
      form.prepend(...pictures);
    }
    if (recording && field.isConnected) field.replaceWith(blank);
    else if (!recording && blank.isConnected) blank.replaceWith(field);
    form.classList.toggle('is-recording', Boolean(recording));
    const next = [.../** @type {HTMLElement} */ (made.querySelector('.ck-composer__tools')).children];
    const markups = next.map(each => each.outerHTML);
    const same = markups.length === toolsDrawn.length && markups.every((each, at) => each === toolsDrawn[at]);
    if (same || tools.querySelector('[aria-expanded="true"]')) return;
    redrawTools(next, markups);
    if (!recording) composerState(form, composerNow());
  }

  /**
   * @param {Element[]} next
   * @param {string[]} markups
   */
  function redrawTools(next, markups) {
    const standing = [...tools.children];
    let from = 0;
    const kept = next.map((part, at) => {
      const found = toolsDrawn.indexOf(markups[at], from);
      if (found < 0) return part;
      from = found + 1;
      return standing[found];
    });
    for (const each of standing) if (!kept.includes(each)) each.remove();
    kept.forEach((each, at) => {
      if (tools.children[at] !== each) tools.insertBefore(each, tools.children[at] ?? null);
    });
    toolsDrawn = markups;
  }

  async function readReady() {
    const mine = ++readyRead;
    try {
      const ready = await fetchAskReady(pickOf());
      if (mine !== readyRead) return;
      heard = true;
      said = ready.said ?? '';
      act = ready.act ?? '';
      unsaved = ready.unsaved_in_ms === 0;
      clearTimeout(recheck);
      if (typeof ready.unsaved_in_ms === 'number' && ready.unsaved_in_ms > 0) recheck = setTimeout(() => void readReady(), ready.unsaved_in_ms);
      models = Array.isArray(ready.models) ? ready.models : [];
      menu = ready.menu ?? null;
      chatDefault = ready.default;
      starters = Array.isArray(ready.starters) ? ready.starters : [];
      limits = ready.limits;
      voice = ready.voice;
      if (voice.ready && micSaid === voice.line) micSaid = '';
      if (ready.gone) {
        picked = { model: '', thinking: '' };
        keepPicked(picked);
      }
      status = modelOf(picked.model)?.state === 'ready' ? 'ready' : 'unready';
      confirmed = status === 'ready';
      drawPick();
      homeAnswers();
    } catch (error) {
      if (mine !== readyRead) return;
      heard = true;
      confirmed = false;
      if (unreachable(error)) return;
      status = 'ready';
      said = '';
    }
    drawStatus();
  }

  /**
   * @param {number} at
   * @param {string} handle
   * @param {string} from
   */
  function openCited(at, handle, from) {
    const turn = thread?.turns[at];
    if (!thread || !turn?.refs || turn.end === 'running') return;
    const refs = turn.refs;
    const one = refs[handle];
    if (!one) return;
    const opening = openingOf(one);
    if (opening === null) return;
    if ('go' in opening) return context.go(opening.go, opening.patch);
    const sources = citedSources(turn).filter(source => 'panel' in (openingOf(refs[source.handle]) ?? {}));
    const year = today().slice(0, 4);
    panel.show(sources.map(({ handles }) => momentOf(handles.map(each => refs[each]), year)),
      sources.findIndex(each => each.handles.includes(handle)));
    const was = cited;
    cited = { thread, at, handle, from };
    if (was && was.thread === thread && was.at !== at) drawTurn(was.at);
    drawTurn(at);
  }

  /** @param {File[]} files */
  function attach(files) {
    if (!limits || photosOff() || recording) return;
    const { take, said: refusal } = photosToTake(files, { attached: attached.map(each => each.file), limits });
    attachSaid = refusal;
    for (const file of take) {
      const kind = photoKind(file);
      /** @type {Attached} */
      const photo = { file, local: URL.createObjectURL(file), kind, state: 'uploading', hash: '', said: '', status: 0,
        sent: Promise.resolve() };
      const trial = new Image();
      trial.onerror = () => {
        URL.revokeObjectURL(photo.local);
        photo.local = '';
        drawParts();
        if (thread) drawThread();
      };
      trial.src = photo.local;
      attached = [...attached, photo];
      upload(photo);
    }
    drawParts();
  }

  /** @param {Attached} photo */
  function upload(photo) {
    photo.state = 'uploading';
    photo.sent = uploadPhoto(photo.file).then(staged => {
      photo.hash = staged.file;
      photo.state = 'ready';
      if (attached.some(each => each !== photo && each.hash === photo.hash)) unpick(attached.indexOf(photo));
    }, error => {
      const { status, message } = /** @type {{ status?: number, message?: string }} */ (error);
      if (status) {
        photo.state = 'failed';
        photo.status = status;
        photo.said = message ?? '';
        if (attached.includes(photo)) attachSaid = photo.said;
      } else photo.state = 'lost';
    }).finally(() => drawParts());
  }

  /** @param {number} at */
  function unpick(at) {
    const photo = attached[at];
    if (!photo) return;
    if (photo.local) URL.revokeObjectURL(photo.local);
    attached = attached.filter(each => each !== photo);
    if (photo.state === 'failed' || !attached.some(each => each.state === 'failed')) attachSaid = '';
    drawParts();
    field.focus({ preventScroll: true });
  }

  async function paste() {
    try {
      /** @type {File[]} */
      const files = [];
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(each => each.startsWith('image/'));
        if (type) files.push(new File([await item.getType(type)], `Pasted ${files.length + 1}.${type.slice('image/'.length)}`, { type }));
      }
      if (files.length) return attach(files);
    } catch {}
    attachSaid = 'Nothing to paste: copy a photo first.';
    drawParts();
  }

  /** @param {string} value */
  function pickVoice(value) {
    if (!host || !voice || value === voice.value) return;
    host.act({ act: 'setting', connector: 'ask', member: 'llm.voice', value, was: voice.value })
      .catch(error => {
        micSaid = refused(error, 'The voice model could not be changed.');
      })
      .finally(() => void readReady());
  }

  async function startRecording() {
    if (recording || !voice || !limits || !askable() || (thread && running(thread))) return;
    if (!voice.ready) {
      micSaid = voice.line ?? '';
      return drawStatus();
    }
    micSaid = '';
    /** @type {Recording} */
    const note = { note: mint(), parts: [], posts: [], lost: new Set(), levels: [], recorder: null, stopping: false };
    recording = note;
    stopVoice();
    drawStatus();
    void openNote(note.note).catch(() => undefined);
    try {
      note.recorder = await record({
        second: (k, bytes) => {
          note.parts[k] = bytes;
          postSecond(note, k);
        },
        level: level => {
          note.levels.push(level);
          if (recording === note) drawParts();
        },
        full: () => void stopRecording(),
      }, Math.round(limits.voice_ms * RATE / 1000));
      if (recording !== note) note.recorder.cancel();
    } catch {
      if (recording !== note) return;
      recording = null;
      micSaid = host ? MIC_REFUSED_MAC : MIC_REFUSED;
      cancelHeld(note.note);
      drawStatus();
    }
  }

  /**
   * @param {Recording} note
   * @param {number} k
   */
  function postSecond(note, k) {
    note.lost.delete(k);
    note.posts.push(sendSecond(note.note, k, note.parts[k]).then(() => undefined, error => {
      if (!/** @type {{ status?: number }} */ (error).status) note.lost.add(k);
    }));
  }

  function cancelRecording() {
    const note = recording;
    if (!note) return;
    recording = null;
    note.recorder?.cancel();
    note.parts = [];
    note.levels = [];
    cancelHeld(note.note);
    drawStatus();
    field.focus({ preventScroll: true });
  }

  async function stopRecording() {
    const note = recording;
    if (!note?.recorder || note.stopping) return;
    note.stopping = true;
    const rest = await note.recorder.stop();
    if (recording !== note) return;
    recording = null;
    if (rest.length) {
      note.parts.push(rest);
      postSecond(note, note.parts.length - 1);
    }
    if (!note.parts.length) {
      cancelHeld(note.note);
      return drawStatus();
    }
    send('', { fromField: false, note });
  }

  /** @type {Record<string, (control: HTMLElement) => void>} */
  const actions = {
    'data-ask-chat': control => openChat(String(control.dataset.askChat)),
    'data-ask-cite': control => {
      const [at, handle] = String(control.dataset.askCite).split(' ');
      const place = control.dataset.ckPlace === undefined ? '' : `[data-ck-place="${control.dataset.ckPlace}"]`;
      void openCited(Number(at), handle, `[data-ask-cite="${at} ${handle}"]${place}`);
    },
    'data-ask-steps': control => {
      if (!thread) return;
      const at = Number(control.dataset.askSteps);
      if (!thread.open.delete(at)) thread.open.add(at);
      drawTurn(at);
      /** @type {HTMLElement | null} */ (stage.querySelector(`[data-ask-steps="${at}"]`))?.focus({ preventScroll: true });
    },
    'data-ask-access': control => access.press(control, thread?.turns ?? []),
    'data-ask-unpick': control => unpick(Number(control.dataset.askUnpick)),
    'data-ask-edit': control => {
      const turn = thread?.turns[Number(control.dataset.askEdit)];
      if (turn) edit(turn.question);
    },
    'data-ask-starter': control => {
      const starter = starters[Number(control.dataset.askStarter)];
      if (starter) send(starter.question, { fromField: false });
    },
    'data-ask-retry': control => {
      if (thread) void retry(thread, Number(control.dataset.askRetry));
    },
    'data-ask-action': control => {
      const action = control.dataset.askAction;
      if (action === 'mic') void startRecording();
      else if (action === 'rec-stop') void stopRecording();
      else if (action === 'rec-cancel') cancelRecording();
      else if (action === 'new') goHome();
      else if (action === 'chats') showChats(!listing);
      else if (action === 'end') stage.scrollTo({ top: stage.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
      else if (action === 'recheck') {
        chatsFailed = null;
        status = 'ready';
        drawStatus();
        void readReady();
        void readList();
      } else if (action === 'reread' && thread) {
        thread.failed = null;
        drawThread();
        void reread(thread);
      } else if (action === 'hiding') {
        context.dialog(SETTINGS_PRIVACY);
      } else if (action === 'sign-in' && host) {
        context.dialog(SETTINGS_PROVIDERS);
      }
    },
  };

  /** @param {string} words */
  function edit(words) {
    field.value = words;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
    field.setSelectionRange(words.length, words.length);
  }

  /** @param {MouseEvent} event */
  const onClick = event => {
    const target = /** @type {Element} */ (event.target);
    if (aside.contains(target)) return;
    for (const [name, act] of Object.entries(actions)) {
      const control = /** @type {HTMLElement | null} */ (target.closest(`[${name}]`));
      if (control && root.contains(control)) {
        act(control);
        return;
      }
    }
  };

  /** @param {KeyboardEvent} event */
  const onKey = event => {
    if (event.defaultPrevented || container.hidden) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (thread) goHome();
      else field.focus();
      return;
    }
    if (command && event.key === '.') {
      event.preventDefault();
      stop();
      return;
    }
    if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o' && offersPhotos() && !photosOff() && !recording) {
      event.preventDefault();
      picker.click();
      return;
    }
    if (event.key === 'Escape' && listing) {
      event.preventDefault();
      showChats(false, { back: true });
      return;
    }
    if (event.key === 'Escape' && recording) {
      event.preventDefault();
      cancelRecording();
      return;
    }
    const target = event.target;
    const free = target === document.body || target === container || target === document.documentElement;
    if (command || event.altKey || !free || event.key.length !== 1 || field.disabled) return;
    event.preventDefault();
    edit(field.value + event.key);
  };

  installAsk(root, {
    send: words => send(words),
    stop,
    seen: (eye, on) => {
      const n = Number(eye.dataset.askSeen);
      if (!thread || !Number.isInteger(n)) return;
      if (on) thread.seen.add(n);
      else thread.seen.delete(n);
    },
    last: () => thread?.turns.at(-1)?.question ?? '',
    pictures: files => attach(files),
  });
  feedback?.follow(() => thread?.turns.forEach((_, at) => drawTurn(at, false)));
  form.addEventListener('submit', event => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    void stopRecording();
  });
  root.addEventListener('click', onClick);
  restOn(root, '[data-ask-chat]', on => {
    const chat = String(on.dataset.askChat);
    if (chat !== thread?.chat) chatAhead.begin(chat);
  });
  document.addEventListener('keydown', onKey);
  drawer.addEventListener('keydown', stepChats);
  find.addEventListener('input', () => {
    drawLists();
    drawerList.scrollTop = 0;
  });
  document.addEventListener('pointerdown', event => {
    const target = /** @type {Element} */ (event.target);
    if (listing && !drawer.contains(target) && !target.closest('[data-ask-action="chats"]')) showChats(false);
  });
  stage.addEventListener('scroll', () => {
    if (thread) thread.scroll = stage.scrollTop;
    markEnd();
  }, { passive: true });
  const resized = new ResizeObserver(() => {
    measure();
    if (listing) placeChats();
  });
  resized.observe(stage);
  const onFocus = () => void readReady();
  window.addEventListener('focus', onFocus);
  let signIns = '';
  let recovered = -1;
  host?.follow(state => {
    drawComposer();
    drawLists();
    if (state.reach && !lacks(state.reach) && state.reach.revision > recovered) {
      recovered = state.reach.revision;
      homeAnswers();
    }
    const login = state.ask_login;
    const now = [login.chatgpt.state, login.claude.state].join(' ');
    if (now === signIns) return;
    const first = signIns === '';
    signIns = now;
    if (!first) void readReady();
  });
  onHomeChange(change => {
    if (change.reset) {
      homeAnswers();
      for (const held of threads.values()) void reread(held);
    }
    if (change.clock) {
      grouped = { list: null, groups: [] };
      drawLists();
      if (thread) drawThread();
    }
    const chats = change.reset || [...change.imports].some(source => source.startsWith('ask:'));
    if (change.models || (chats && unsaved)) void readReady();
    if (!change.reset && chats && thread?.turns.some(turn => turn.unsaved)) void reread(thread);
  }, container);
  followChats(held => {
    if (!held.list) return;
    if (!held.failed) chatsFailed = null;
    chats = { list: held.list, more: held.more };
    for (const each of held.list) {
      const kept = threads.get(each.chat);
      if (kept && !following.has(kept) && kept.title !== each.title) {
        kept.title = each.title;
        if (thread === kept) drawBar();
      }
    }
    drawLists();
    drawHomeNotice();
  });

  drawBar();
  const chat = context.route.chat;
  if (chat) openChat(chat);
  else {
    drawHome();
    drawComposer();
  }
  void readStart();
  void readReady();
  void readList();

  return {
    focus: () => field.focus({ preventScroll: true }),
    /** @param {Route} route */
    update(route) {
      if (route.chat === (thread?.chat ?? '')) return;
      if (route.chat) openChat(route.chat);
      else goHome();
    },
  };
};
