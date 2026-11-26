// @ts-check
import { attributes, esc } from '../../lib/html.js';
import { shortDay } from '../../lib/words.js';
import { duration } from './duration.js';
import { showCopied } from './copy-value.js';
import { inPlaceLine } from './states.js';
import { floatList, floatRows } from './float-list.js';
import { icon } from './icon.js';
import { menuLines } from '../../lib/model-menu.js';
import { bar, lines, shape } from './skeleton.js';
import { signalShape } from './signal.js';
import { picture as renderPicture } from './picture.js';
import { flipSeen, seenAnswer, seenCite, seenEye, seenWords } from './seen.js';
import { DIDNT_PLAY, runs, voiceBar, voiceButton, voiceFailed, voiceNote, voiceTime } from './voice.js';

/** @typedef {import('../../lib/html.js').Attributes} Attributes */

/**
 * @typedef {{ record: string, audio: string, seconds: number | null, caption: string, mine: boolean, failed: string, erased?: boolean }} AskVoice
 * @typedef {{ day: string | null, title: string, image?: string | null, block?: string, voice?: AskVoice }} AskRef
 */

/** @typedef {{ words: string, failed?: boolean }} AskStep */

/** @typedef {'ready' | 'running' | 'waiting'} ComposerState */

/** @typedef {{ src: string, alt: string, state?: 'uploading' | 'failed', kind?: string, seen?: string }} Picked */

/** @typedef {import('./seen.js').SeenSpan} SeenSpan */

/** @typedef {{ seconds: number, levels: number[] }} Recorded */

const SEND = { face: () => icon('send', { size: 'sm' }), label: 'Send', title: 'Send' };
const CIRCLE = {
  ready: SEND,
  running: { face: () => '<span class="ck-composer__stop" aria-hidden="true"></span>', label: 'Stop', title: 'Stop ⌘.' },
  waiting: SEND,
};

/**
 * @param {number[]} levels
 * @param {{ quietFrom?: number }} [wave]
 */
export const waveform = (levels, { quietFrom = levels.length } = {}) => '<span class="ck-wave" aria-hidden="true">'
  + levels.map((level, at) => `<i${attributes({ class: at >= quietFrom ? 'is-quiet' : null,
    'data-level': String(Math.max(1, Math.min(10, Math.round(level * 10)))) })}></i>`).join('') + '</span>';

/** @param {{ value?: string, state?: ComposerState, placeholder?: string, attrs?: Attributes, pick?: string, attach?: string, mic?: Attributes | null, pictures?: Picked[], remove?: (at: number) => Attributes, recording?: (Recorded & { stop: Attributes, cancel?: Attributes }) | null, said?: string }} [composer] */
export function composer({ value = '', state = 'ready', placeholder = 'Ask anything', attrs = {}, pick = '', attach = '',
  mic = null, pictures = [], remove = () => ({}), recording = null, said = '' } = {}) {
  const face = CIRCLE[state];
  const send = `<button class="ck-composer__send"${attributes({ type: state === 'running' ? 'button' : 'submit',
    'aria-label': face.label, title: face.title,
    disabled: !recording && (state === 'waiting' || (state === 'ready' && !value.trim())),
    'data-ck-composer-stop': state === 'running' ? '' : null })}>${face.face()}</button>`;
  const picked = (pictures.length ? '<div class="ck-composer__pictures">' + pictures.map((picture, at) => '<span'
    + `${attributes({ class: `ck-composer__picture${picture.state ? ` is-${picture.state}` : ''}`, 'aria-busy': picture.state === 'uploading' ? 'true' : null })}>`
    + (picture.src ? `<img${attributes({ src: picture.src, alt: picture.alt })}>`
      : `<span${attributes({ class: 'ck-composer__kind mac-mono-label', role: 'img', 'aria-label': picture.alt })}>${esc(picture.kind ?? '')}</span>`)
    + (picture.state === 'uploading' ? '<span class="ck-ask-mark ck-composer__loading" aria-hidden="true"></span>' : '')
    + (picture.state === 'failed' ? `<span class="ck-composer__failed">${signalShape('warning')}</span>` : '')
    + `<button${attributes({ type: 'button', class: 'ck-composer__unpick', 'aria-label': `Remove ${picture.alt}`, ...remove(at) })}>`
    + `${icon('close', { size: 'xs' })}</button></span>`).join('') + '</div>' : '')
    + (said ? `<p class="ck-composer__said mac-footnote" role="status">${esc(said)}</p>` : '');
  const field = recording ? '<div class="ck-composer__blank" aria-hidden="true"></div>'
    : `<textarea class="ck-composer__input mac-reading" rows="1"${attributes({ placeholder, 'aria-label': 'Ask',
      disabled: state === 'waiting', autocomplete: 'off', spellcheck: 'true' })}>${esc(value)}</textarea>`;
  const tools = recording
    ? (recording.cancel ? `<button${attributes({ type: 'button', class: 'ck-composer__tool', 'aria-label': 'Cancel the voice note',
      title: 'Cancel', ...recording.cancel })}>${icon('close', { size: 'sm' })}</button>` : '')
      + `<button${attributes({ type: 'button', class: 'ck-composer__tool ck-composer__recstop', 'aria-label': 'Stop recording', ...recording.stop })}>`
      + '<span class="ck-composer__stop" aria-hidden="true"></span></button>'
      + `<span class="ck-composer__wave">${waveform(recording.levels, { quietFrom: recording.levels.length - 4 })}</span>`
      + `<span class="ck-composer__time mac-body" role="timer">${runs(recording.seconds)}</span>`
    : attach + pick + '<span class="ck-composer__gap"></span>'
      + (mic ? `<button${attributes({ type: 'button', class: 'ck-composer__tool ck-composer__mic', 'aria-label': 'Record a voice note',
        title: 'Record a voice note', ...mic })}>${icon('voice-note', { size: 'md' })}</button>` : '');
  return `<form class="ck-composer${state === 'ready' ? '' : ` is-${state}`}${recording ? ' is-recording' : ''}" data-ck-composer${attributes(attrs)}>`
    + picked + field + `<div class="ck-composer__tools">${tools}${send}</div></form>`;
}

/** @param {{ attrs?: Attributes, active?: number, off?: string }} [attach] */
export const composerAttach = ({ attrs = {}, active, off = '' } = {}) => {
  const open = active !== undefined;
  return `<div${attributes({ class: `ck-fmenu ck-fmenu--start ck-composer__attach${open ? '' : ' ck-fmenu--float'}`, ...attrs })}>`
    + `<button${attributes({ type: 'button', class: 'ck-fmenu__btn ck-composer__tool', 'aria-label': 'Add a photo or file',
      title: 'Add a photo or file', 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-controls': 'ck-attach-menu',
      'aria-activedescendant': open ? `ck-attach-${active}` : null })}>${icon('add', { size: 'md' })}</button>`
    + floatList({
      label: 'Add', role: 'menu', className: 'ck-fmenu__panel', lit: open ? active : null,
      attrs: { id: 'ck-attach-menu', hidden: !open },
      items: [['photos', 'Photos…', 'photo', ''], ['files', 'Files…', 'folder', '⌘O'], ['paste', 'Paste', 'attach', '⌘V']]
        .map(([value, name, glyph, key], at) => ({ name, icon: glyph, key, disabled: Boolean(off),
          ...(off && at === 0 ? { note: off } : {}),
          attrs: { id: `ck-attach-${at}`, 'data-value': value, class: 'ck-fmenu__item' } })),
    }) + '</div>';
};

/** @typedef {import('../../lib/model-menu.js').MenuParts} AskMenu */
/** @typedef {{ placeholder: string, found: import('../../pages.js').ModelGroup[], none: string }} AskFind */

/**
 * @param {import('../../pages.js').ModelGroup[]} found
 * @param {string} chosen
 * @param {string} none
 * @param {boolean} [shown]
 */
export const askFound = (found, chosen, none, shown = true) => floatRows({ role: 'menu', lit: null, items: found.flatMap((group, at) => [
  { head: group.label, attrs: { 'data-ck-page-of': 'other', hidden: !shown } },
  ...group.rows.map((row, place) => ({ name: row.name, tag: row.account ?? '', chosen: row.value === chosen,
    attrs: { id: `ck-pick-found-${at}-${place}`, 'data-value': `model:${row.value}`, 'data-ck-page-of': 'other', class: 'ck-fmenu__item', hidden: !shown } })),
]) }) + (none ? `<p${attributes({ class: 'ck-flist__none mac-subhead', 'data-ck-page-of': 'other', hidden: !shown })}>${esc(none)}</p>` : '');

/**
 * @param {import('../../lib/model-menu.js').MenuLine} line
 * @param {string} chosen
 * @returns {import('./float-list.js').FloatItem[]}
 */
const modelItems = (line, chosen) => 'more' in line
  ? [{ name: line.more, parted: false, attrs: { 'data-value': 'other', 'data-ck-page': 'other', 'data-ck-page-of': 'models', class: 'ck-flist__more' } }]
  : [...line.head ? [{ head: line.head, attrs: { 'data-ck-page-of': 'models' } }] : [],
    { name: line.row.name, tag: line.row.account ?? '', chosen: line.row.value === chosen, parted: line.parted,
      attrs: { 'data-value': `model:${line.row.value}`, 'data-ck-page-of': 'models' } }];

/** @param {{ model: string, level: string, levels: { value: string, label: string }[], thinking: string, menu: AskMenu, chosen: string, reset?: boolean, voice?: { words: string, caution: string | null, choices: { value: string, words: string, chosen: boolean }[] } | null, find?: AskFind | null, attrs?: Attributes, active?: number, page?: 'models' | 'voice' | 'other' }} pick */
export function askPick({ model, level, levels, thinking, menu, chosen, reset = false, voice = null, find = null, attrs = {}, active, page }) {
  const more = find ? menu.more ?? null : null;
  /** @type {import('./float-list.js').FloatItem[]} */
  const items = [
    ...levels.length ? [{ head: 'Thinking', attrs: { 'data-ck-page-of': '' } }] : [],
    ...levels.map((each, at) => ({ name: each.label, chosen: each.value === thinking, parted: at === levels.length - 1,
      attrs: { 'data-value': `thinking:${each.value}`, 'data-ck-page-of': '' } })),
    { name: 'Model', tag: model, lead: '', attrs: { 'data-value': 'models', 'data-ck-page': 'models', 'data-ck-page-of': '', class: 'ck-flist__more' } },
    ...voice ? [{ name: 'Voice', tag: voice.words, lead: voice.caution ? signalShape('caution') : '', disabled: !voice.choices.length,
      attrs: { 'data-value': 'voice', 'data-ck-page': 'voice', 'data-ck-page-of': '', class: 'ck-flist__more', title: voice.caution } }] : [],
    ...reset ? [{ name: 'Reset to default', attrs: { 'data-value': 'reset', 'data-ck-page-of': '' } }] : [],
    ...menuLines({ ...menu, more }).flatMap(line => modelItems(line, chosen)),
    ...voice?.choices.length ? [{ head: 'Voice notes', attrs: { 'data-ck-page-of': 'voice' } },
      ...voice.choices.map(choice => ({ name: choice.words, chosen: choice.chosen, note: choice.chosen && voice.caution ? voice.caution : undefined,
        attrs: { 'data-value': `voice:${choice.value}`, 'data-ck-page-of': 'voice' } }))] : [],
  ].map((item, at) => {
    const shown = (item.attrs?.['data-ck-page-of'] ?? '') === (page ?? '');
    /** @type {Attributes} */
    const attrs = { ...item.attrs, hidden: !shown };
    return 'head' in item ? { ...item, attrs } : { ...item, attrs: { id: `ck-pick-${at}`, ...attrs,
      class: `ck-fmenu__item${attrs.class ? ` ${attrs.class}` : ''}` } };
  });
  const away = page !== 'other';
  const after = find && more ? `<div${attributes({ class: 'ck-pick__other', 'data-ck-page-of': 'other', hidden: away })}>`
    + `<input${attributes({ class: 'ck-pick__find mac-body', type: 'search', placeholder: find.placeholder, 'aria-label': more.words,
      autocomplete: 'off', spellcheck: 'false', 'data-ask-find': '' })}></div>`
    + `<div${attributes({ class: 'ck-pick__found', 'data-ck-page-of': 'other', hidden: away })}>${askFound(find.found, chosen, find.none, !away)}</div>` : '';
  return chipMenu({ kind: 'ck-pick', words: level ? `${model} · ${level}` : model, name: 'Model and thinking',
    label: level ? `Model and thinking: ${model}, ${level}` : `Model and thinking: ${model}`, items, attrs, active, after });
}

/**
 * @param {{ kind: string, words: string, glyph?: string, name: string, label: string,
 *   items: import('./float-list.js').FloatItem[], waiting?: boolean, attrs?: Attributes, active?: number, after?: string }} chip
 */
const chipMenu = ({ kind, words, glyph = '', name, label, items, waiting = false, attrs = {}, active, after = '' }) => {
  const open = active !== undefined;
  return `<div${attributes({ class: `ck-fmenu ck-fmenu--start ${kind}${open ? '' : ' ck-fmenu--float'}`, ...attrs })}>`
    + `<button${attributes({ type: 'button', class: 'ck-fmenu__btn ck-pick__chip mac-headline', disabled: waiting,
      'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-controls': `${kind}-menu`, 'aria-label': label,
      'aria-activedescendant': open ? `${kind}-${active}` : null })}>`
    + (glyph ? icon(glyph, { size: 'sm' }) : '')
    + `<span class="ck-pick__words">${esc(words)}</span>${icon('expand', { size: 'xs', className: 'ck-fmenu__caret' })}</button>`
    + floatList({ label: name, role: 'menu', className: 'ck-fmenu__panel', lit: open ? active : null,
      attrs: { id: `${kind}-menu`, hidden: !open }, items, after }) + '</div>';
};

export const ASK_LEVELS = /** @type {const} */ ([
  { value: 'all', words: 'Hide all', glyph: 'hidden' },
  { value: 'names', words: 'Keep names', glyph: 'person' },
  { value: 'none', words: 'Don’t hide', glyph: 'visible' },
]);

/** @param {{ level: 'all' | 'names' | 'none', waiting?: boolean, attrs?: Attributes, active?: number }} chip */
export function askLevel({ level, waiting = false, attrs = {}, active }) {
  const held = ASK_LEVELS.find(each => each.value === level) ?? ASK_LEVELS[0];
  /** @type {import('./float-list.js').FloatItem[]} */
  const items = [{ head: 'Sensitive information' }, ...ASK_LEVELS.map((each, at) => ({ name: each.words,
    chosen: each.value === held.value, attrs: { id: `ck-level-${at + 1}`, 'data-value': each.value, class: 'ck-fmenu__item' } }))];
  return chipMenu({ kind: 'ck-level', words: held.words, glyph: held.glyph, name: 'Sensitive information',
    label: `Sensitive information: ${held.words}`, items, waiting, attrs, active });
}

/**
 * @param {HTMLElement} within
 * @param {ComposerState} state
 */
export function composerState(within, state) {
  const form = /** @type {HTMLFormElement | null} */ (within.closest('[data-ck-composer]'));
  const field = form?.querySelector('textarea');
  const circle = /** @type {HTMLButtonElement | null | undefined} */ (form?.querySelector('.ck-composer__send'));
  if (!form || !field || !circle) return;
  const face = CIRCLE[state];
  form.classList.toggle('is-running', state === 'running');
  form.classList.toggle('is-waiting', state === 'waiting');
  field.disabled = state === 'waiting';
  circle.type = state === 'running' ? 'button' : 'submit';
  circle.setAttribute('aria-label', face.label);
  circle.title = face.title;
  circle.toggleAttribute('data-ck-composer-stop', state === 'running');
  circle.disabled = state === 'waiting' || (state === 'ready' && !field.value.trim());
  circle.innerHTML = face.face();
}

/** @param {HTMLTextAreaElement} field */
const grow = field => {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
};

export const ASK_SENT = 'ck-ask-sent';

/**
 * @param {HTMLElement} root
 * @param {{ send: (words: string, field: HTMLTextAreaElement) => void, stop: () => void, last?: () => string, pictures?: (files: File[]) => void, seen?: (eye: HTMLElement, on: boolean) => void }} handlers
 */
export function installAsk(root, { send, stop, last = () => '', pictures, seen = () => undefined }) {
  /** @param {HTMLTextAreaElement} field */
  const asked = field => {
    const form = field.closest('[data-ck-composer]');
    if (!form || form.classList.contains('is-running') || form.classList.contains('is-waiting') || !field.value.trim()) return;
    send(field.value.trim(), field);
  };
  root.addEventListener('input', event => {
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement) || !field.closest('[data-ck-composer]')) return;
    grow(field);
    const form = /** @type {HTMLElement} */ (field.closest('[data-ck-composer]'));
    const circle = /** @type {HTMLButtonElement | null} */ (form.querySelector('.ck-composer__send'));
    if (circle && !form.classList.contains('is-running')) circle.disabled = !field.value.trim();
  });
  root.addEventListener('keydown', event => {
    if (event.key === '.' && (event.metaKey || event.ctrlKey) && root.querySelector('[data-ck-composer-stop]')) {
      event.preventDefault();
      stop();
      return;
    }
    const field = event.target;
    if (!(field instanceof HTMLTextAreaElement) || !field.closest('[data-ck-composer]')) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      asked(field);
    } else if (event.key === 'ArrowUp' && !field.value && last()) {
      event.preventDefault();
      field.value = last();
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.setSelectionRange(field.value.length, field.value.length);
    }
  });
  root.addEventListener('submit', event => {
    const form = /** @type {Element} */ (event.target).closest?.('[data-ck-composer]');
    if (!form) return;
    event.preventDefault();
    const field = form.querySelector('textarea');
    if (field) asked(field);
  });
  root.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    const copy = target.closest('[data-ck-answer-copy]');
    const eye = /** @type {HTMLElement | null} */ (target.closest('[data-ck-seen-eye]'));
    const turn = /** @type {HTMLElement | null | undefined} */ (eye?.closest('.ck-ask-turn'));
    if (eye && turn) {
      const on = eye.getAttribute('aria-pressed') !== 'true';
      flipSeen(turn, on);
      seen(eye, on);
    }
    else if (target.closest('[data-ck-composer-stop]')) stop();
    else if (copy) {
      void navigator.clipboard?.writeText(copy.getAttribute('data-ck-answer-copy') ?? '');
      showCopied(copy);
    }
    else if (target.matches('[data-ck-composer], .ck-composer__tools, .ck-composer__gap')) {
      target.closest('[data-ck-composer]')?.querySelector('textarea')?.focus();
    }
  });
  if (pictures) {
    /** @param {DataTransfer | null} transfer */
    const images = transfer => [...transfer?.files ?? []].filter(file => file.type.startsWith('image/'));
    /** @param {DragEvent} event */
    const carries = event => [...event.dataTransfer?.types ?? []].includes('Files');
    root.addEventListener('dragover', event => {
      if (!carries(event)) return;
      event.preventDefault();
      root.classList.add('is-dropping');
    });
    root.addEventListener('dragleave', event => {
      if (!root.contains(/** @type {Node | null} */ (event.relatedTarget))) root.classList.remove('is-dropping');
    });
    root.addEventListener('drop', event => {
      root.classList.remove('is-dropping');
      if (!carries(event)) return;
      event.preventDefault();
      const files = images(event.dataTransfer);
      if (files.length) pictures(files);
    });
    root.addEventListener('paste', event => {
      if (!/** @type {Element} */ (event.target).closest?.('[data-ck-composer]')) return;
      const files = images(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      pictures(files);
    });
  }
  root.addEventListener('error', event => {
    if (!(event.target instanceof HTMLImageElement)) return;
    event.target.closest('.ck-pics__pic')?.classList.add('is-failed');
    event.target.closest('.ck-seen-pic__said')?.classList.add('is-lost');
  }, true);
  root.addEventListener('load', event => {
    if (event.target instanceof HTMLImageElement) event.target.closest('.ck-seen-pic__said')?.classList.add('is-in');
  }, true);
  for (const field of root.querySelectorAll('[data-ck-composer] textarea')) grow(/** @type {HTMLTextAreaElement} */ (field));
}

/**
 * @param {string} words
 * @param {{ at?: string, edit?: Attributes | null, picture?: Picked | null, pictures?: Picked[], voice?: (Recorded & { words: string | null, sound?: string, owner?: string, src?: string }) | null, seen?: SeenSpan[] | null, model?: boolean }} [question]
 */
export const askQuestion = (words, { at = '', edit = null, picture = null, pictures = picture ? [picture] : [], voice = null, seen = null,
  model = false } = {}) => `<div class="ck-ask-q"${attributes({ title: at || null })}>`
  + (pictures.length === 1 ? askPicture(pictures[0], 'ck-ask-q__picture', model)
    : pictures.length ? '<div class="ck-ask-q__pictures">' + pictures.map(each => askPicture(each, 'ck-ask-q__square', model)).join('') + '</div>' : '')
  + (voice ? askVoice(voice, seen) : words ? `<p class="ck-ask-q__words mac-reading">${seenWords(words, seen)}</p>` : '')
  + (edit ? `<button class="ck-btn ck-btn--plain ck-btn--sm mac-headline ck-ask-q__edit"${attributes({ type: 'button', ...edit })}>`
    + '<span class="ck-btn__label">Edit</span></button>' : '')
  + '</div>';

/**
 * @param {Picked} picture
 * @param {string} className
 * @param {boolean} model
 */
const askPicture = (picture, className, model) => picture.seen
  ? `<span${attributes({ class: `${className} ck-seen-pic` })}>`
    + `<img${attributes({ class: 'ck-seen-pic__shown', src: picture.src || null, alt: picture.alt })}>`
    + '<span class="ck-seen-pic__said" aria-hidden="true">'
    + `<img${attributes({ src: model ? picture.seen : null, 'data-src': picture.seen, alt: '' })}>`
    + `<span class="ck-pics__lost mac-footnote">${icon('photo', { size: 'xs' })}Can’t show this photo</span></span></span>`
  : picture.src ? `<img${attributes({ class: className, src: picture.src, alt: picture.alt })}>`
    : `<span${attributes({ class: `${className} ck-ask-q__kind mac-mono-label`, role: 'img', 'aria-label': picture.alt })}>${esc(picture.kind ?? '')}</span>`;

/**
 * @param {Recorded & { words: string | null, sound?: string, owner?: string, src?: string }} voice
 * @param {SeenSpan[] | null} [seen]
 */
export const askVoice = ({ seconds, levels, words, sound = '', owner = '', src = '' }, seen = null) => `<div${attributes({ class: 'ck-ask-voice',
  ...sound ? voiceBar({ sound, owner, seconds: Math.floor(seconds), src }) : {} })}>`
  + `<div class="ck-ask-voice__player">${voiceButton('ck-ask-voice__play', `Play the voice note, ${runs(seconds)}`)}`
  + `${waveform(levels)}${voiceTime('ck-ask-voice__time mac-subhead', Math.floor(seconds))}</div>`
  + (words === null ? '<p class="ck-ask-voice__writing mac-subhead">Writing it out…</p>'
    : words ? `<p class="ck-ask-voice__words">${seenWords(words, seen)}</p>` : '')
  + (sound ? voiceFailed(DIDNT_PLAY) : '') + '</div>';

/** @param {Element} element @returns {import('./ask-live.js').AskPace} */
export const askPaceOf = element => ({ dwell: duration(element, '--duration-dwell'), quiet: duration(element, '--duration-quiet'),
  word: duration(element, '--duration-word') });

/**
 * @param {{ said: string, working?: boolean, live?: boolean, steps: AskStep[], open?: boolean, attrs?: Attributes }} line
 */
export function askSteps({ said, working = false, live = working, steps, open = false, attrs = {} }) {
  if (!said) return '';
  const opens = !live && steps.length > 0;
  const head = `<button${attributes({ type: 'button', class: 'ck-steps__line mac-subhead', disabled: !opens,
    'aria-expanded': opens ? String(open) : null, ...attrs })}>`
    + `<span class="ck-steps__roll" data-ck-roll><span class="ck-steps__words${working ? ' ck-shimmer' : ''}">${esc(said)}</span></span>`
    + (!working && steps.length ? icon('forward', { size: 'xs', className: 'ck-steps__caret' }) : '') + '</button>';
  const list = opens ? `<div${attributes({ class: 'ck-steps__open', 'aria-hidden': open ? null : 'true', inert: !open })}><div>`
    + '<ol class="ck-steps__list">' + steps.map(step => `<li class="ck-steps__step mac-subhead${step.failed ? ' is-failed' : ''}">`
      + (step.failed ? signalShape('warning') : '') + `<span>${esc(step.words)}</span></li>`).join('')
    + '</ol></div></div>' : '';
  return `<div${attributes({ class: `ck-steps${working ? ' is-running' : ''}${open && opens ? ' is-open' : ''}`,
    role: working ? 'status' : null })}>${head}${list}</div>`;
}

const CITED = /\[(r\d+(?:\s*,\s*r\d+)*)\]/gu;
const CODE_OR_CITED = /(`+)[\s\S]*?\1|\]\([^)\s]*\)|([ \t]*)((?:\[r\d+(?:\s*,\s*r\d+)*\][ \t]*)*\[r\d+(?:\s*,\s*r\d+)*\])/gu;
const SHOWN = 2;
const FENCE = /^\s*(```|~~~)/u;
const OPENING = /\[(?:r\d*(?:\s*,\s*(?:r\d*)?)*)?$/u;
const HOLDERS = /[\uE000-\uE003]/gu;
const HELD_CITE = /\uE000(\d+)\uE001/gu;
const HELD_IN_TAG = /(?:\uE000|%EE%80%80)(\d+)(?:\uE001|%EE%80%81)/giu;
const HELD_PICS = /<p>\s*\uE002(\d+)\uE003\s*<\/p>|\uE002(\d+)\uE003/gu;
const SOURCES = /^\W*sources?\W*:/iu;
const ONLY_HANDLES = /^[\s\-*•·,;.]*$/u;
const HELD = /(\uE000\d+\uE001|\uE002\d+\uE003)/u;
const WORD = /\S+/gu;
const GLUED = /(\uE000\d+\uE001)(<span class="ck-answer__w">[^<]*<\/span>)/gu;

/** @param {string} piece */
const wordsOf = piece => piece.split(HELD).map((part, at) => at % 2 ? part : part.replace(WORD, '<span class="ck-answer__w">$&</span>')).join('')
  .replace(GLUED, '<span class="ck-answer__glued">$1$2</span>');

/**
 * @param {string} text
 * @param {(space: string, handles: string[], whole: string) => string} put
 */
function citations(text, put) {
  let fenced = false;
  return text.split('\n').map(row => {
    if (FENCE.test(row)) fenced = !fenced;
    else if (!fenced) {
      return row.replace(CODE_OR_CITED, (whole, _ticks, space, list) => list === undefined ? whole
        : put(space, [...new Set(String(list).match(/r\d+/gu))], whole.slice(space.length)));
    }
    return row;
  }).join('\n');
}

/** @param {string} text */
function withoutSources(text) {
  const rows = text.split('\n');
  let end = rows.length - 1;
  while (end >= 0 && !rows[end].trim()) end -= 1;
  let at = end;
  while (at >= 0 && rows[at].trim() && !SOURCES.test(rows[at]) && ONLY_HANDLES.test(rows[at].replace(CITED, ''))) at -= 1;
  if (at < 0 || !SOURCES.test(rows[at]) || !ONLY_HANDLES.test(rows[at].replace(SOURCES, '').replace(CITED, ''))) return text;
  const named = rows.slice(at, end + 1).join(' ').match(CITED) ?? [];
  const rest = rows.slice(0, at).join('\n').trimEnd();
  const missing = [...new Set(named)].filter(cite => !rest.includes(cite));
  return missing.length ? `${rest} ${missing.join(' ')}` : rest;
}

/** @param {string} text */
function blocksOf(text) {
  /** @type {string[]} */
  const blocks = [];
  let block = [];
  let fenced = false;
  for (const row of text.split('\n')) {
    if (/^\s*(```|~~~)/u.test(row)) fenced = !fenced;
    if (!fenced && !row.trim()) {
      if (block.length) blocks.push(block.join('\n'));
      block = [];
    } else block.push(row);
  }
  if (block.length) blocks.push(block.join('\n'));
  return blocks;
}

/** @param {{ hash: string, alt: string, attrs: Attributes }[]} shown */
function picturesHtml(shown) {
  const kind = shown.length === 1 ? 'is-one' : shown.length <= 3 ? 'is-row' : 'is-grid';
  const drawn = shown.slice(0, 6);
  return `<div class="ck-pics ${kind}">` + drawn.map((picture, at) => {
    const more = at === 5 && shown.length > 6;
    return `<button class="ck-pics__pic${more ? ' is-more' : ''}"${attributes({ type: 'button',
      'aria-label': more ? `${shown.length - 5} more photos` : picture.alt, ...picture.attrs })}>` + (more ? `<span class="ck-pics__more">+${shown.length - 5}</span>`
      : renderPicture({ hash: picture.hash, size: 'tile', alt: picture.alt }) + '<span class="ck-pics__lost mac-footnote">'
        + `${icon('photo', { size: 'xs' })}Can’t show this photo</span>`) + '</button>';
  }).join('') + '</div>';
}

/**
 * @param {AskVoice} voice
 * @param {{ owner: string, open: Attributes }} drawn
 */
const citedVoice = (voice, { owner, open }) => voice.erased
  ? `<p class="ck-voice-cite__gone mac-subhead">${esc(ERASED_NOTE)}</p>`
  : voiceNote({ audio: voice.audio, seconds: voice.seconds, caption: voice.caption, mine: voice.mine, owner, open, failed: voice.failed });

export const ERASED_NOTE = 'This voice note was erased.';

/**
 * @param {string} text
 * @returns {string[]}
 */
export function citedIn(text) {
  /** @type {string[]} */
  const order = [];
  citations(withoutSources(text.replace(OPENING, '').replace(HOLDERS, '')), (_, handles) => {
    order.push(...handles);
    return '';
  });
  return order;
}

/**
 * @param {Record<string, { day?: string | null, block?: string }>} refs
 * @returns {(handle: string) => string}
 */
export function sourceOf(refs) {
  /** @type {Map<string, string>} */
  const first = new Map();
  return handle => {
    const ref = refs[handle];
    if (!ref?.block) return handle;
    const chat = `${ref.day} ${ref.block}`;
    return first.get(chat) ?? first.set(chat, handle).get(chat) ?? handle;
  };
}

/**
 * @typedef {{ text: string, refs: Record<string, AskRef> | null, open?: string, stopped?: boolean, failed?: { sentence: string, retry: Attributes | null } | null, paced?: boolean, seen?: SeenSpan[] | null, model?: boolean, eye?: Attributes, more?: AnswerMore | null }} AskAnswer
 * @typedef {{ items: { name: string, value: string }[], attrs: Attributes }} AnswerMore
 * @typedef {{ markdown: (text: string) => string, cite?: (handle: string, n: number) => Attributes, owner?: string, year?: string, turn?: number }} AskDraw
 */

/**
 * @param {string} text
 * @param {boolean} linked
 */
function shapedOf(text, linked) {
  /** @type {{ handles: string[], whole: string, block: number }[]} */
  const held = [];
  const blocks = blocksOf(withoutSources(text.replace(OPENING, '').replace(HOLDERS, ''))).map((block, at) => {
    const before = held.length;
    const words = citations(block, (space, handles, whole) => {
      held.push({ handles, whole, block: at });
      return `${space}\uE000${held.length - 1}\uE001`;
    });
    return linked && held.length > before ? `${words}\n\n\uE002${at}\uE003` : words;
  });
  return { joined: blocks.join('\n\n'), held, blocks: blocks.length };
}

/**
 * @param {AskAnswer} answer
 * @param {AskDraw} draw
 * @returns {string}
 */
export function askAnswer(answer, draw) {
  const { text, refs, open = '', stopped = false, failed = null, paced = false, seen = null, model = false, eye = {},
    more = null } = answer;
  const { markdown, cite = () => ({}), owner = '', year = new Date().getFullYear().toString(), turn = 0 } = draw;
  const shaped = shapedOf(text, refs !== null);
  const turned = seen ? seenAnswer(text, seen, source => markdown(shapedOf(source, refs !== null).joined)) : null;
  const shows = turned !== null;
  const { held } = shaped;
  /** @type {{ hash: string, alt: string, attrs: Attributes }[][]} */
  const pictures = Array.from({ length: shaped.blocks }, () => []);
  /** @type {string[][]} */
  const voices = Array.from({ length: shaped.blocks }, () => []);
  /** @type {Map<string, number>} */
  const numbers = new Map();
  /** @param {string} handle */
  const number = handle => numbers.get(handle) ?? numbers.set(handle, numbers.size + 1).get(handle) ?? 0;
  /** @param {string} handle */
  const known = handle => refs === null || Boolean(refs[handle]);
  const source = sourceOf(refs ?? {});
  const placed = new Set();
  /** @type {Set<string>} */
  const voiced = new Set();
  /** @param {AskRef} ref */
  const named = ref => `${ref.title}${ref.day ? ` · ${shortDay(ref.day, year)}` : ''}`;
  /**
   * @param {{ handles: string[], block: number }} citation
   * @param {number} place
   */
  const capsules = ({ handles, block }, place) => {
    const shown = [...new Set(handles.filter(known).map(source))];
    for (const handle of shown) {
      const ref = refs?.[handle];
      if (ref?.image && !placed.has(handle)) {
        placed.add(handle);
        pictures[block].push({ hash: ref.image, alt: ref.title, attrs: cite(handle, number(handle)) });
      }
      number(handle);
    }
    for (const handle of shown) {
      const voice = refs?.[handle]?.voice;
      if (!voice || placed.has(handle) || voiced.has(voice.record)) continue;
      placed.add(handle);
      voiced.add(voice.record);
      voices[block].push(citedVoice(voice, { owner, open: cite(handle, number(handle)) }));
    }
    const rest = shown.slice(SHOWN);
    return shown.slice(0, SHOWN).map(handle => oneCited(handle, place)).join('')
      + (rest.length === 1 ? oneCited(rest[0], place, '+1') : rest.length ? moreCited(rest, place) : '');
  };
  /**
   * @param {string} handle
   * @param {number} place
   * @param {string} [said]
   */
  const oneCited = (handle, place, said = String(number(handle))) => {
    const n = number(handle);
    const ref = refs?.[handle];
    return ref ? `<button${attributes({ type: 'button', class: `ck-cite mac-footnote${handle === open ? ' is-open' : ''}`,
      title: named(ref), 'aria-label': `Source ${n}, ${named(ref)}`, 'data-ck-place': String(place), ...cite(handle, n) })}>${said}</button>`
      : `<span class="ck-cite mac-footnote" aria-hidden="true">${said}</span>`;
  };
  /**
   * @param {string[]} handles
   * @param {number} place
   */
  const moreCited = (handles, place) => {
    const said = `+${handles.length}`;
    if (refs === null) return `<span class="ck-cite mac-footnote" aria-hidden="true">${said}</span>`;
    return `<span class="ck-fmenu ck-fmenu--float ck-fmenu--start ck-cites"${attributes({ 'data-ck-cites': String(turn), 'data-ck-place': String(place) })}>`
      + `<button${attributes({ type: 'button', class: `ck-fmenu__btn ck-cite mac-footnote${handles.includes(open) ? ' is-open' : ''}`,
        title: `${handles.length} more sources`, 'aria-label': `${handles.length} more sources`, 'aria-haspopup': 'menu',
        'aria-expanded': 'false', 'aria-controls': `ck-cites-${turn}-${place}` })}>${said}</button>`
      + floatList({
        label: 'Sources', role: 'menu', className: 'ck-fmenu__panel', lit: null, inline: true,
        attrs: { id: `ck-cites-${turn}-${place}`, hidden: true },
        items: handles.map(handle => {
          const ref = /** @type {AskRef} */ (refs[handle]);
          const n = number(handle);
          return { name: ref.title, tag: ref.day ? shortDay(ref.day, year) : undefined,
            lead: `<span class="ck-cite mac-footnote" aria-hidden="true">${n}</span>`,
            attrs: { id: `ck-cites-${turn}-${place}-${n}`, 'data-value': handle, class: 'ck-fmenu__item' } };
        }),
      }) + '</span>';
  };
  /** @param {number} index */
  const capsule = index => {
    const citation = held[index];
    if (!citation) return '';
    return shows ? seenCite(capsules(citation, index), citation.whole) : capsules(citation, index);
  };
  const html = (turned ?? markdown(shaped.joined)).split(/(<[^>]*>)/u).map((piece, at) => at % 2
    ? piece.replace(HELD_IN_TAG, (_, index) => esc(held[Number(index)]?.whole ?? ''))
    : wordsOf(piece).replace(HELD_CITE, (_, index) => capsule(Number(index)))).join('')
    .replace(HELD_PICS, (_, a, b) => {
      const shown = pictures[Number(a ?? b)] ?? [];
      const media = (shown.length ? picturesHtml(shown) : '') + (voices[Number(a ?? b)] ?? []).join('');
      return !media ? '' : shows ? `<div class="ck-seen-fold"><div class="ck-seen-fold__in">${media}</div></div>` : media;
    });
  const end = failed ? inPlaceLine(failed.sentence, failed.retry ? { retry: failed.retry } : {})
    : stopped ? '<p class="ck-answer__stopped mac-footnote">Stopped</p>' : '';
  const copied = citations(withoutSources(text.replace(HOLDERS, '')), () => '').trim();
  const copies = (paced || (refs !== null && !failed)) && Boolean(copied);
  const offers = more !== null && more.items.length > 0 && !paced;
  const foot = copies || shows || offers ? `<div${attributes({ class: `ck-copy ck-answer__foot${paced ? ' is-held' : ''}`,
    'aria-hidden': paced ? 'true' : null, inert: paced })}>`
    + (copies ? '<button class="ck-copy__btn ck-answer__copy"'
      + `${attributes({ type: 'button', 'aria-label': 'Copy answer', title: 'Copy', 'data-ck-answer-copy': paced ? null : copied })}>`
      + `${icon('copy', { className: 'ck-copy__glyph' })}${icon('done', { className: 'ck-copy__check' })}</button>` : '')
    + (shows ? seenEye({ attrs: eye, on: model }) : '')
    + (offers ? answerMore(/** @type {AnswerMore} */ (more), turn) : '')
    + (copies ? '<span class="ck-copy__said sr-only" aria-live="polite"></span>' : '') + '</div>' : '';
  return `<div class="ck-answer${paced ? ' is-pacing' : ''}"><div class="ck-answer__words mac-reading">${html}</div>${end}${foot}</div>`;
}

/**
 * @param {AnswerMore} more
 * @param {number} turn
 */
const answerMore = (more, turn) => `<span${attributes({ class: 'ck-fmenu ck-fmenu--float ck-fmenu--start ck-answer__more',
  ...more.attrs })}><button${attributes({ type: 'button', class: 'ck-fmenu__btn ck-copy__btn', 'aria-label': 'More', title: 'More',
  'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `ck-more-${turn}` })}>`
  + `${icon('more', { className: 'ck-copy__glyph' })}</button>`
  + floatList({ label: 'More', role: 'menu', className: 'ck-fmenu__panel', lit: null, inline: true,
    attrs: { id: `ck-more-${turn}`, hidden: true },
    items: more.items.map(item => ({ name: item.name, attrs: { id: `ck-more-${turn}-${item.value}`, class: 'ck-fmenu__item',
      role: 'menuitem', 'aria-checked': null, 'data-value': item.value } })) })
  + '</span>';

/** @param {string} when */
export const askStamp = when => `<p class="ck-ask-stamp mac-mono-time">${esc(when)}</p>`;

/** @param {{ question: string, steps?: string, answer?: string, stamp?: string, model?: boolean }} turn */
export const askTurn = ({ question, steps = '', answer = '', stamp = '', model = false }) => `<section class="ck-ask-turn${model ? ' is-model' : ''}">`
  + (stamp ? askStamp(stamp) : '')
  + `${question}${steps}${answer}</section>`;

/**
 * @param {string} line
 * @param {Attributes} [attrs]
 */
export const askWaiting = (line, attrs = {}) => `<div class="ck-steps is-running ck-ask-wait" role="status">`
  + `<button${attributes({ type: 'button', class: 'ck-steps__line mac-subhead', ...attrs })}>`
  + '<span class="ck-ask-mark" aria-hidden="true"></span>'
  + `<span class="ck-steps__words">${esc(line)}</span>${icon('forward', { size: 'xs', className: 'ck-steps__caret' })}</button></div>`;

/** @param {string[]} turns */
export const askThread = turns => `<div class="ck-ask-thread">${turns.join('')}</div>`;

const STARTER_ICONS = /** @type {Record<string, string>} */ ({
  places: 'places', walking: 'steps', photos: 'photos', sleep: 'sleep', workouts: 'workout', people: 'people',
  calendar: 'calendar-event', screen: 'screen', music: 'music', mail: 'mail',
});

/**
 * @param {{ kind: string, question: string }[]} starters
 * @param {(at: number) => Attributes} [attrs]
 */
export const askStarters = (starters, attrs = () => ({})) => starters.length
  ? '<ul class="ck-ask-starters" aria-label="Ask">' + starters.map((starter, at) => {
    const glyph = STARTER_ICONS[starter.kind];
    return `<li><button${attributes({ type: 'button', class: 'ck-ask-starter mac-body', ...attrs(at) })}>`
      + (glyph ? icon(glyph, { className: 'ck-ask-starter__icon' }) : '<span class="ck-ask-starter__icon"></span>')
      + `<span class="ck-ask-starter__words">${esc(starter.question)}</span></button></li>`;
  }).join('') + '</ul>'
  : '';

/** @param {{ composer: string, notice?: string, starters?: string, heading?: string }} home */
export const askHome = ({ composer: field, notice = '', starters = '', heading = 'What shall we look back on?' }) =>
  '<div class="ck-ask-home">'
  + `<h2${attributes({ class: 'ck-ask-home__heading mac-greeting' })}>${esc(heading)}</h2>`
  + `<div class="ck-ask-home__stage">${notice}${field}</div>`
  + `<div class="ck-ask-home__under">${starters}</div></div>`;

/** @param {{ title: string, selected?: boolean, running?: boolean, attrs?: Attributes }} chat */
export const chatRow = ({ title, selected = false, running = false, attrs = {} }) => `<button${attributes({
  type: 'button', class: `ck-chat${selected ? ' is-selected' : ''}`, 'aria-current': selected ? 'true' : null, ...attrs,
})}><span class="ck-chat__title mac-body">${esc(title)}</span>`
  + (running ? '<span class="ck-chat__mark" role="img" aria-label="Answering"></span>' : '') + '</button>';

/** @param {{ label: string, rows: string[] }[]} groups */
export const chatList = groups => '<nav class="ck-chats" aria-label="Conversations">' + groups.map(group => '<section class="ck-chats__group">'
  + `<h3 class="ck-chats__label mac-footnote">${esc(group.label)}</h3><ul>${group.rows.map(row => `<li>${row}</li>`).join('')}</ul></section>`).join('')
  + '</nav>';

const TITLES = /** @type {const} */ ([7, 6, 8, 5, 7, 6]);

export const chatListReading = () => '<div class="ck-chats" aria-hidden="true"><section class="ck-chats__group">'
  + `<span class="ck-chats__label mac-footnote">${bar(3)}</span><ul>`
  + TITLES.map(width => `<li><span class="ck-chat"><span class="ck-chat__title mac-body">${bar(width)}</span></span></li>`).join('')
  + '</ul></section></div>';

export const askThreadReading = () => '<div class="ck-ask-thread" aria-hidden="true">'
  + [3, 2].map(width => '<section class="ck-ask-turn"><div class="ck-ask-q">'
    + shape({ className: `ck-ask-q__sk ck-ask-q__sk--${width} mac-reading` }) + '</div>'
    + `<div class="ck-answer">${lines(3, 'mac-reading')}</div></section>`).join('')
  + '</div>';
