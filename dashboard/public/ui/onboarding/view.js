// @ts-check
/** @import { Screen, Seen } from './model.js' */
/** @import { HostAct } from '../../lib/host.js' */
/** @import { Flow, FlowItem, FlowSession } from '../flows/model.js' */
/** @import { ModelKind, StartCost } from '../../types.js' */
/** @import { Models } from '../../lib/model-menu.js' */
import { attributes, esc } from '../../lib/html.js';
import { sizeWords } from '../../lib/words.js';
import {
  action, appIcon, button, dialog, diskBar, icon, iconButton, menuButton, settingRow, settingTile, setupCheck, setupChip,
  setupChipReading, setupGranted, setupHead, setupNever, setupSheet, setupUnder, setupWait, status, textField, toggle,
} from '../kit/index.js';
import { addRow } from '../kit/add-row.js';
import { standIn } from '../kit/seen.js';
import { APP_FINDS, withMode } from '../connectors/dialog.js';
import { settingKey } from '../connectors/view.js';
import { keyOf, thingKey } from '../connectors/pending.js';
import { actState, ELSEWHERE, modelOf, refused } from '../flows/model.js';
import { flowAction } from '../flows/view.js';
import {
  accountName, backOf, macOf, NAME_LIMIT, nameHolds, neverOf, recordOf, whereOf,
} from './model.js';

/**
 * @typedef {FlowSession & {
 *   picked: import('./model.js').Picked,
 *   dialog: { app: string, lit: number, site: string, error: string } | null,
 *   how: boolean,
 *   changes: Pick<import('../connectors/changes.js').PageChanges, 'busy' | 'models' | 'privacy' | 'screen'>,
 *   nameTyped: string | null,
 *   span: { months: number | null } | null,
 *   cost: { read: StartCost | null, failed: string, settled: boolean },
 *   saved: boolean,
 *   recovery: string | null,
 *   drafted: number | null,
 *   redrafted: boolean,
 * }} Session
 */

export const NO_CHANGES = /** @type {Session['changes']} */ ({ busy: new Set(), models: { read: null, drawn: null, failed: '' },
  privacy: { read: null, drawn: null, failed: '' }, screen: { read: null, drawn: null, failed: '' } });

export const SCRAMBLE_CAUGHT_PERCENT = 74;

export const SOURCE_URL = 'https://github.com/shlokkhemani/lifestream';

/** @typedef {{ back?: string, note?: string, end?: string }} Foot */

/**
 * @typedef {object} Parts
 * @property {'' | 'centred'} look
 * @property {boolean} [brand]
 * @property {string} head
 * @property {string} [body]
 * @property {Foot} foot
 * @property {string} [dialog]
 */

/**
 * @param {string} label
 * @param {string} key
 * @param {Session} session
 * @param {{ variant?: 'primary' | 'secondary' | 'plain', host?: boolean, busy?: boolean, working?: boolean, disabled?: boolean, failed?: string, result?: string, done?: boolean, beside?: boolean, waiting?: string, more?: import('../../lib/html.js').Attributes }} [options]
 */
function act(label, key, session, { variant = 'secondary', host = false, busy, working = false, disabled = false, failed = '',
  result = '', done = false, beside = false, waiting, more = {} } = {}) {
  const away = host && !session.hosted;
  return action(label, { state: actState(key, session, { done, working, busy }), done: result, variant, waiting,
    why: beside ? refused(key, session, failed) : '', after: true, disabled: away || disabled,
    attrs: { 'data-ob': key, title: away ? ELSEWHERE : null, ...more } });
}

/**
 * @param {string} label
 * @param {string} key
 * @param {{ variant?: 'primary' | 'secondary' | 'plain', disabled?: boolean }} [options]
 */
const move = (label, key, { variant = 'plain', disabled = false } = {}) => button(label, { variant, disabled,
  attrs: { 'data-ob': key } });

/**
 * @param {Screen} screen
 * @param {Seen} seen
 * @param {{ disabled?: boolean }} [options]
 */
const back = (screen, seen, { disabled = false } = {}) => backOf(screen, seen) ? move('Back', 'back', { disabled }) : '';

/** @param {string} words */
const fine = words => `<p class="ob-fine">${esc(words)}</p>`;

/**
 * @param {Screen} screen
 * @param {Seen} seen
 * @param {Session} session
 * @param {Flow | null} flow
 * @returns {Parts}
 */
export const partsOf = (screen, seen, session, flow) => PARTS[screen](seen, session, flow);

/** @param {Seen} seen @param {Session} session */
export const typedName = (seen, session) => session.nameTyped ?? accountName(seen);

export const MOVING_LINE = 'If macOS asks about your Downloads folder, click Allow so Lifestream can move itself.';

/** @type {Record<Screen, (seen: Seen, session: Session, flow: Flow | null) => Parts>} */
const PARTS = {
  place(seen, session) {
    const moving = seen.state?.placement?.moving === true;
    const failed = seen.state?.placement?.error ?? '';
    return {
      look: 'centred', brand: false,
      head: '<div class="ob-place" aria-hidden="true">'
        + '<img class="ob-place__app" src="icon.svg" alt="" width="52" height="52" draggable="false">'
        + '<span class="ob-place__arrow"></span><span class="ob-place__folder">Applications</span></div>'
        + setupHead({ title: moving ? 'Moving to Applications' : 'Move Lifestream to Applications',
          sub: moving ? MOVING_LINE : '', live: true }),
      body: failed && !moving ? status('failed', failed) : '',
      foot: { end: act('Move to Applications', 'move-app', session, { variant: 'primary', host: true, busy: moving,
        waiting: 'Moving', beside: true }) },
    };
  },

  welcome: () => ({
    look: 'centred', brand: false,
    head: '<span class="ck-onb__mark ob-hero" aria-hidden="true"></span>'
      + setupHead({ hero: true, title: 'Your life, kept on your Mac', sub: 'Your messages, mail, notes, photos and more, '
        + 'in one encrypted folder on this Mac. Search it, or ask your AI about it.' }),
    foot: { end: move('Get started', 'onward', { variant: 'primary' }),
      note: `<span class="ob-meta"><a${attributes({ class: 'ob-meta__item', href: SOURCE_URL, target: '_blank',
        rel: 'noopener noreferrer' })}>${icon('github')}<span class="ob-meta__link">Open source</span></a>`
        + `<span class="ob-meta__item">${icon('work-mac')}Local</span><span class="ob-meta__item">${icon('private')}Private</span></span>` },
  }),

  where(seen, session) {
    const where = whereOf(seen, session);
    const busy = where.working || !session.hosted;
    const place = settingRow({ label: where.folder, lead: settingTile('folder'),
      line: [where.drive ?? 'This Mac', where.free, where.external ? 'Keep it plugged in' : ''].filter(Boolean).join(' · '),
      end: act('Choose', 'choose-folder', session, { host: true, disabled: busy }),
      attrs: { class: 'ob-folder' } });
    const tight = where.tight && where.room ? setupUnder(`${esc(where.room)} Choose an external drive, or free up space first. `
      + 'You can move the folder later in Settings › Storage.', { className: 'is-caution' }) : '';
    const kept = where.home === 'plain' ? '' : settingRow({ label: 'Encrypted', lead: settingTile('private'),
      line: 'Only this Mac’s key or your recovery key can open it.' });
    const made = where.home === 'plain' || where.home === 'encrypted';
    const why = refused('choose-folder', session) || refused('setup', session);
    return {
      look: '',
      head: setupHead({ title: 'Where should Lifestream keep your data?', sub: 'One folder holds everything. It grows about 3 GB a week '
        + 'from this Mac, so pick a disk with room. An external drive works too.' }),
      body: setupSheet([place, tight, kept], { label: 'Where Lifestream lives' })
        + (why ? status('failed', why) : where.error && !where.working ? status('failed', where.error) : ''),
      foot: { back: back('where', seen, { disabled: where.working }),
        note: where.starting ? esc(where.starting) : '',
        end: act(where.error && !where.working ? 'Try again' : made ? 'Open this Lifestream' : 'Create Lifestream', 'setup',
          session, { variant: 'primary', host: true, busy: where.working, waiting: made ? 'Opening' : 'Creating' }) },
    };
  },

  login(seen, session) {
    const where = whereOf(seen, session);
    const asking = seen.state?.setup?.state === 'login-items';
    const failed = refused('setup', session) || where.error;
    return {
      look: '',
      head: setupHead({ title: 'Allow Lifestream in the background', sub: 'So Lifestream keeps your folder up to date when this '
        + 'window is closed. macOS asks once.' }),
      body: setupSheet([setupUnder(`${fine('In System Settings › General › Login Items, under “Allow in the Background”:')}`
        + '<span class="ob-sysrow"><img src="icon.svg" alt="" width="22" height="22"><span>Lifestream</span>'
        + `${toggle({ on: true, label: 'Lifestream', attrs: { disabled: true, tabindex: '-1' } })}</span>`, { className: 'ob-login' })])
        + (failed ? status('failed', failed) : ''),
      foot: asking ? { note: setupWait({ words: 'Waiting for you to turn it on. This page moves on by itself.' }),
        end: act('Open Login Items', 'login-items', session, { host: true, beside: true }) }
        : failed ? { back: move('Back', 'login-back'), end: act('Try again', 'setup', session, { variant: 'primary', host: true }) }
          : { note: setupWait({ words: where.starting || 'Starting Lifestream' }) },
    };
  },

  key(seen, session) {
    const key = seen.state?.setup?.key ?? null;
    const making = seen.state?.setup?.state === 'working';
    const groups = session.recovery ? session.recovery.split(' ') : [];
    const failed = refused('key-show', session);
    const grid = groups.length ? `<span class="ob-key__grid" aria-label="Recovery key">${groups.map(group =>
      `<span class="ob-key__group">${esc(group)}</span>`).join('')}</span>`
      : `<span class="ob-key__grid is-reading">${failed ? status('failed', failed)
        : setupWait({ words: making ? 'Creating your Lifestream' : 'Making your key' })}</span>`;
    const said = refused('key-copy', session) || refused('key-save', session) || key?.said || '';
    const tools = '<span class="ob-key__tools">'
      + button('Copy', { size: 'sm', icon: 'copy', disabled: !groups.length || making || !session.hosted || session.busy.has('key-copy'),
        attrs: { 'data-ob': 'key-copy' } })
      + button('Save as file…', { size: 'sm', disabled: !groups.length || making || !session.hosted || session.busy.has('key-save'),
        attrs: { 'data-ob': 'key-save' } })
      + `<span class="ob-key__said" role="status">${esc(said)}</span></span>`;
    const used = key?.used != null;
    const ready = session.saved && used;
    const why = refused('key-done', session) || refused('key-back', session);
    return {
      look: '',
      head: setupHead({ title: 'Save your recovery key', sub: 'Your Lifestream is encrypted. Either of these two keys opens it.' }),
      body: setupSheet([
        settingRow({ label: 'This Mac', lead: settingTile('work-mac'), line: 'Stored on this Mac automatically. You don’t need to do anything here.',
          end: setupGranted('Saved') }),
        settingRow({ label: 'Recovery key', lead: settingTile('private'),
          line: session.redrafted ? 'This is a new key. The one shown before no longer works.'
            : 'To access your Lifestream on a new Mac, or if this one is damaged or reset. No one else has a copy.' }),
        setupUnder(grid + tools, { className: 'ob-key' }),
        `<li class="ob-keycheck">${setupCheck({ label: 'I’ve saved it somewhere other than this Mac, like a password manager.',
          on: session.saved, disabled: !used && !making, attrs: { 'data-ob': 'saved' } })}</li>`,
      ], { label: 'Your keys' }) + (why ? status('failed', why) : ''),
      foot: { back: move('Back', 'key-back', { disabled: making || session.busy.has('key-back') || session.busy.has('key-done') }),
        end: act('Continue', 'key-done', session, { variant: 'primary', host: true, disabled: !ready && !making, busy: making || undefined,
          waiting: 'Creating' }) },
    };
  },

  name(seen, session) {
    const typed = typedName(seen, session);
    const busy = session.busy.has('name');
    return {
      look: '',
      head: setupHead({ title: 'What’s your name?', sub: 'So Lifestream can identify you across your context.' }),
      body: textField({ label: 'Your name', value: typed, placeholder: 'Full name',
        attrs: { maxlength: NAME_LIMIT, disabled: busy, 'data-ob': 'name', autocomplete: 'name' } })
        + (refused('name', session) ? status('failed', refused('name', session)) : ''),
      foot: { back: back('name', seen),
        end: act('Continue', 'name', session, { variant: 'primary', disabled: !nameHolds(typed), busy: busy || undefined }) },
    };
  },

  mac(seen, session) {
    const mac = macOf(seen, session);
    const chips = !mac.detected ? Array.from({ length: 6 }, (_, at) => setupChipReading(at)).join('')
      : mac.sources.map(source => setupChip({ name: source.name, icon: source.icon, on: source.on, count: source.count,
        disabled: !session.hosted, title: session.hosted ? '' : ELSEWHERE,
        attrs: { 'data-ob': 'pick', 'data-id': source.id } })).join('');
    const full = settingRow({ label: 'Apps on this Mac', lead: settingTile('work-mac'),
      line: mac.full.granted ? 'Lifestream is reading these sources now.' : `${mac.full.title} helps read these sources.`,
      end: mac.full.granted ? setupGranted('Allowed') : act(`Allow ${mac.full.title}`, 'allow-full', session, { host: true,
        variant: 'primary', disabled: !mac.detected, busy: mac.full.asking || undefined }) });
    const found = mac.detected && !mac.sources.length ? fine('Nothing on this Mac to read yet.')
      : `<div class="ck-onb__chips" role="group" aria-label="Sources on this Mac"${attributes({
        'aria-busy': mac.detected ? null : 'true' })}>${chips}</div>`;
    const photos = mac.photos.shown ? settingRow({ label: 'Photos', lead: settingTile('photos'),
      line: 'Lifestream can store all your pictures and their metadata.',
      end: mac.photos.granted ? setupGranted('Allowed') : act(mac.photos.denied ? 'Open System Settings' : 'Allow Photos', 'allow-photos',
        session, { host: true, variant: mac.full.granted ? 'primary' : 'secondary', disabled: !mac.photos.grant,
          busy: mac.photos.asking || undefined }) }) : '';
    const why = refused('allow-full', session) || refused('allow-photos', session)
      || (session.failure?.key.startsWith('pick:') ? session.failure.words : '');
    const ready = mac.full.granted && (!mac.photos.shown || mac.photos.granted);
    return {
      look: '',
      head: setupHead({ title: 'Bring in what’s on this Mac', sub: 'Lifestream reads these apps in the background. Choose the ones '
        + 'to store.' }),
      body: setupSheet([full, setupUnder(found), photos], { label: 'From this Mac' }) + (why ? status('failed', why) : ''),
      foot: { back: back('mac', seen),
        end: (ready ? '' : move('Not now', 'leave')) + move('Continue', 'leave', { variant: 'primary' }) },
    };
  },

  range(seen, session) {
    const range = rangeOf(seen, session);
    return {
      look: '',
      head: setupHead({ title: 'How far back should Lifestream go?', sub: 'Further back takes more space. You can change this '
        + 'later in Settings.' }),
      body: rangeBody(range) + (refused('range', session) ? status('failed', refused('range', session)) : ''),
      foot: { back: back('range', seen), note: range.settled ? '' : 'Sizes are ready in a minute or two.',
        end: act(range.stop ? `Continue with ${range.stop.short}` : 'Continue', 'range', session,
        { variant: 'primary', host: true, disabled: !range.stop || !session.hosted }) },
    };
  },

  record(seen, session) {
    const record = recordOf(seen, session);
    const next = record.rows.find(row => row.state === 'asking' || row.state === 'ask')?.id ?? '';
    const rows = record.rows.map(row => settingRow({ label: row.name, lead: settingTile(row.icon), line: row.words, dim: row.state === 'off',
      end: row.state === 'allowed' ? setupGranted('Allowed') : act('Allow', `allow-row:${row.id}`, session, { host: true,
        variant: row.id === next ? 'primary' : 'secondary', busy: row.state === 'asking' || undefined,
        disabled: row.state === 'idle' || record.asking, more: { 'aria-label': `Allow ${row.name}` } }) }));
    const never = record.never;
    const named = [{ name: 'Password managers', icon: 'private' }, { name: 'Password fields', icon: 'private' },
      ...never.privately ? [{ name: 'Private windows', icon: 'hidden' }] : [],
      ...never.added.map(app => ({ name: app.name, icon: 'hidden' })), ...never.sites.map(site => ({ name: site, icon: 'web' }))];
    const kept = never.shown ? setupSheet([
      settingRow({ label: 'Never recorded', lead: settingTile('hidden'),
        end: act('Edit', 'never', session, { disabled: !never.editable }) }),
      setupUnder(`<ul class="ck-onb__nevers">${named.map(setupNever).join('')}</ul>`),
    ], { label: 'Never recorded' }) : '';
    const why = record.rows.map(row => refused(`allow-row:${row.id}`, session)).find(Boolean) ?? '';
    return {
      look: '',
      head: setupHead({ title: 'Record what you do on this Mac', sub: 'So you can find anything you saw, typed or heard. Each is '
        + 'optional, and you can pause recording at any time.' }),
      body: setupSheet(rows, { label: 'What Lifestream records' }) + kept + (why ? status('failed', why) : ''),
      foot: { back: back('record', seen),
        end: (record.held ? '' : move('Not now', 'leave')) + move('Continue', 'leave', { variant: 'primary' }) },
      dialog: neverDialog(seen, session),
    };
  },

  ai(seen, session, flow) {
    const model = modelOf(seen);
    const items = (flow?.lists.flatMap(list => list.items) ?? []).sort((a, b) => Number(b.id === 'claude') - Number(a.id === 'claude'));
    const privacy = session.changes.privacy.read;
    const on = privacy ? privacy.level !== 'none' : true;
    const busy = session.changes.busy.has(SCRAMBLE_BUSY);
    const scramble = setupSheet([
      settingRow({ label: 'Personal details are hidden before anything is sent.', lead: settingTile('private'),
        end: toggle({ on, label: 'Hide personal details', busy,
          attrs: { 'data-ob': 'scramble', disabled: busy || !session.hosted || !privacy } }) }),
      setupUnder(example(on), { className: 'is-quiet is-wide' }),
      setupUnder(`<span class="ob-caught">Catches <b>${SCRAMBLE_CAUGHT_PERCENT}%</b> of personal details</span>`
        + move('How it works', 'how'), { className: 'is-wide ob-scramble-foot' }),
    ], { label: 'Scrambling' });
    const failed = session.changes.privacy.failed || refused('scramble', session);
    return {
      look: '',
      head: setupHead({ eyebrow: 'Optional', title: 'Connect your AI', sub: 'Use your Claude or ChatGPT plan to ask about your life '
        + 'in Chat. Skip this, and nothing is sent to an AI.' }),
      body: `<div class="ob-plans">${items.map(item => planCard(item, model)).join('')}</div>`
        + scramble + (failed ? status('failed', failed) : ''),
      foot: { back: back('ai', seen),
        end: model.connected ? move('Continue', 'leave', { variant: 'primary' }) : move('Not now', 'leave') },
      dialog: session.how ? howDialog() : '',
    };
  },

  media(seen, session) {
    const pictures = mediaPlaces(session.changes.models.read, 'pictures');
    const audio = mediaPlaces(session.changes.models.read, 'audio');
    const cloud = pictures.chosen?.leaves ?? false;
    const images = settingRow({ label: 'Describe photos and screenshots', lead: settingTile('photos'),
      line: 'So you can find a picture by what’s in it.', end: mediaMenu('pictures', 'Describe photos and screenshots', pictures, session) });
    const covered = cloud ? setupUnder(facesPicture(pictures.chosen?.words ?? ''), { className: 'is-quiet ob-faces' }) : '';
    const sound = settingRow({ label: 'Turn voice into text', lead: settingTile('voice-note'),
      line: 'Voice notes, memos and calls become text you can search.', end: mediaMenu('audio', 'Turn voice into text', audio, session) });
    const line = (/** @type {MediaPick} */ pick) => pick.line ? setupUnder(fine(pick.line)) : '';
    const failed = session.changes.models.failed || refused('media', session);
    return {
      look: '',
      head: setupHead({ title: 'Make your pictures and audio searchable', sub: 'A model can describe your pictures and turn speech '
        + 'into text, so Search finds them.' }),
      body: setupSheet([images, covered, line(pictures)], { label: 'Images' }) + setupSheet([sound, line(audio)], { label: 'Audio' })
        + (failed ? status('failed', failed) : ''),
      foot: { back: back('media', seen), note: 'Models download in the background.',
        end: move('Continue', 'leave', { variant: 'primary' }) },
    };
  },

  set: () => ({
    look: 'centred', brand: false,
    head: '<span class="ck-onb__mark ob-hero" aria-hidden="true"></span>' + setupHead({ hero: true, title: 'You’re all set',
      sub: 'Lifestream is bringing in your past now. It keeps going while you use it.' }),
    foot: { end: move('Open Lifestream', 'finish', { variant: 'primary' }) },
  }),
};

const TIERS = { claude: 'Pro or Max plan', chatgpt: 'Plus or Pro plan' };

/**
 * @param {FlowItem} item
 * @param {ReturnType<typeof modelOf>} model
 */
function planCard(item, model) {
  const plan = item.id === 'claude' || item.id === 'chatgpt' ? model[item.id] : null;
  const signed = plan?.state === 'signed_in';
  const line = plan?.state === 'absent' ? TIERS[/** @type {'claude' | 'chatgpt'} */ (item.id)] : item.line;
  const end = signed ? setupGranted('Connected') : (item.cancel ? flowAction(item.cancel) : '') + (item.act ? flowAction(item.act) : '');
  const pieces = item.body.length ? `<div class="ob-plan__more">${item.body.map(piece => 'copy' in piece
    ? `<span class="ob-plan__code mac-mono-data">${esc(piece.copy.value)}</span>`
      + button('Copy', { attrs: { 'data-flow': piece.copy.key } })
    : 'field' in piece ? `<form${attributes({ id: piece.field.form, 'data-flow-form': piece.field.kind, novalidate: true })}>`
      + textField({ label: piece.field.label, name: piece.field.name, value: piece.field.value, placeholder: piece.field.placeholder,
        attrs: { 'data-flow': `${piece.field.kind}-field`, disabled: piece.field.disabled,
          'aria-invalid': piece.field.invalid ? 'true' : null } }) + '</form>' : '').join('')}</div>` : '';
  return `<div${attributes({ class: 'ob-plan', 'data-item': item.id })}><span class="ob-plan__logo" aria-hidden="true">${
    icon(item.icon, { size: 'md' })}</span><span class="ob-plan__main"><span class="ob-plan__name">${esc(item.name)}</span>`
    + (item.why ? `<span class="ob-plan__line is-why" role="alert">${esc(item.why)}</span>` : planLines(line ?? ''))
    + `</span><span class="ob-plan__end">${end}</span>${pieces}</div>`;
}

/** @param {string} line */
function planLines(line) {
  const parts = line.split(' · ');
  const tail = parts.length > 1 ? parts.pop() : null;
  return tail ? `<span class="ob-plan__line is-account">${esc(parts.join(' · '))}</span><span class="ob-plan__line">${esc(tail)}</span>`
    : `<span class="ob-plan__line">${esc(line)}</span>`;
}

const SCRAMBLED = /** @type {const} */ ([['Call '], ['Sam Rivera', 'Person 1'], [' on '], ['+1 555 0142', 'Phone 1'],
  [' about '], ['14 Harbour Lane', 'Address 1'], ['.']]);

/** @param {'real' | 'stand'} side */
const sentence = side => SCRAMBLED.map(part => part.length === 1 ? esc(part[0])
  : side === 'real' ? `<span class="ob-real">${esc(part[0])}</span>` : standIn(part[1])).join('');

/** @param {boolean} on */
const example = on => '<div class="ob-example">'
  + `<span class="ob-example__side"><span class="ob-example__label">You ask</span><span class="ob-example__words">${sentence('real')}</span></span>`
  + `<span class="ob-example__side"><span class="ob-example__label">Your AI gets</span><span class="ob-example__words">${
    sentence(on ? 'stand' : 'real')}</span></span></div>`;

function howDialog() {
  const pairs = SCRAMBLED.filter(part => part.length === 2);
  const step = (/** @type {number} */ at, /** @type {string} */ title, /** @type {string} */ shown) => '<li class="ob-how__step">'
    + `<span class="ob-how__n" aria-hidden="true">${at}</span><span class="ob-how__main"><span class="ob-how__title">${esc(title)}</span>`
    + `<span class="ob-how__shown">${shown}</span></span></li>`;
  return dialog({ icon: 'private', title: 'How hiding works', line: 'Personal details become placeholders before anything leaves this Mac.',
    close: { 'data-ob': 'close' }, foot: `<span></span>${move('Done', 'close', { variant: 'primary' })}`,
    body: '<ol class="ob-how">'
      + step(1, 'You ask', sentence('real'))
      + step(2, 'This Mac finds names, numbers and places', `<span class="ob-how__found">${pairs.map(([real]) =>
        `<span class="ob-real">${esc(real)}</span>`).join('')}</span>`)
      + step(3, 'Each becomes a placeholder', `<span class="ob-how__pairs">${pairs.map(([real, stand]) =>
        `<span class="ob-how__pair"><span class="ob-real">${esc(real)}</span>${icon('forward', { size: 'xs' })}`
        + `${standIn(stand)}</span>`).join('')}</span>`)
      + step(4, 'Only this is sent to your AI', sentence('stand'))
      + step(5, 'The answer comes back with the real names put back', 'Done. I’ve drafted a note to '
        + `${standIn('Person 1')} → <span class="ob-real">Sam Rivera</span>.`)
      + '</ol>' });
}

/** @param {string} who */
const facesPicture = who => '<span class="ob-pair" aria-hidden="true">'
  + '<span class="ob-shot"><span class="ob-shot__face"></span><span class="ob-shot__body"></span>'
  + '<span class="ob-shot__cap">On this Mac</span></span>'
  + icon('forward', { size: 'xs' })
  + '<span class="ob-shot"><span class="ob-shot__tag">Person 1</span><span class="ob-shot__face is-covered"></span>'
  + '<span class="ob-shot__body"></span>'
  + `<span class="ob-shot__cap">${esc(who ? `Sent to ${who}` : 'Sent to a model')}</span></span></span>`
  + '<span class="ob-pair__words">Faces and personal details are covered before a photo leaves this Mac.</span>';

/** @typedef {{ value: string, words: string, note: string, working: boolean, disabled: boolean, leaves: boolean }} MediaChoice */
/** @typedef {{ choices: MediaChoice[], chosen: MediaChoice | null, words: string, off: boolean, line: string }} MediaPick */

/**
 * @param {Models | null} models
 * @param {ModelKind} kind
 * @returns {MediaPick}
 */
export function mediaPlaces(models, kind) {
  const use = models?.uses.find(each => each.use === kind);
  if (!use) return { choices: [], chosen: null, words: 'Off', off: true, line: '' };
  const names = new Map([...use.menu.rows, ...use.menu.local?.rows ?? []].map(each => [each.value, each.name]));
  const choices = use.places.flatMap(place => place.value === null ? [] : [{ value: place.value, words: place.place,
    note: place.line ?? names.get(place.value) ?? '', working: place.working, disabled: !place.ready, leaves: place.leaves }]);
  const chosen = choices.find(each => each.value === use.value) ?? null;
  return { choices, chosen, words: chosen?.words ?? use.words, off: use.value === null, line: use.line ?? '' };
}

/**
 * @param {ModelKind} kind
 * @param {string} label
 * @param {MediaPick} pick
 * @param {Session} session
 */
function mediaMenu(kind, label, pick, session) {
  const busy = session.changes.busy.has(thingKey({ kind: 'default', of: kind }));
  return menuButton({ id: `ob-${kind}`, label, words: pick.words, busy,
    attrs: { class: 'ob-menu', 'data-ob-menu': kind },
    choices: [{ value: 'none', words: 'Off', chosen: pick.off, default: false },
      ...pick.choices.map(each => ({ value: each.value, words: each.words, note: each.note, working: each.working, chosen: each === pick.chosen,
        default: false, disabled: each.disabled }))] });
}

/** @typedef {{ months: number | null, day: string | null, short: string, long: string, bytes: number, more: boolean }} RangeStop */

/** @param {number | null} months */
const shortOf = months => months === null ? 'All' : months % 12 === 0 ? `${months / 12}y` : `${months}m`;

/** @param {number | null} months */
const longOf = months => months === null ? 'Everything' : months === 1 ? 'Last month' : months === 12 ? 'Last year'
  : months % 12 === 0 ? `Last ${months / 12} years` : `Last ${months} months`;

/** @param {number | null} months */
const continueOf = months => months === null ? 'everything' : months === 1 ? '1 month' : months === 12 ? '1 year'
  : months % 12 === 0 ? `${months / 12} years` : `${months} months`;

const DEFAULT_MONTHS = 6;

/** @param {Seen} seen @param {Session} session */
export function rangeOf(seen, session) {
  const cost = session.cost.read;
  const stops = (cost?.stops ?? []).map(stop => ({ months: stop.months, day: stop.day, short: shortOf(stop.months),
    long: longOf(stop.months), bytes: stop.bytes, more: stop.more }))
    .sort((a, b) => (a.months ?? Infinity) - (b.months ?? Infinity));
  const kept = cost?.start ? stops.findIndex(stop => stop.day === cost.start) : -1;
  const fallback = stops.findIndex(stop => stop.months === DEFAULT_MONTHS);
  const span = session.span;
  const picked = span === null ? -1 : stops.findIndex(stop => stop.months === span.months);
  const at = picked >= 0 ? picked : kept >= 0 ? kept : Math.max(0, fallback);
  const stop = stops[at] ?? null;
  return { stops, at, stop: stop ? { ...stop, short: continueOf(stop.months) } : null, cost,
    settled: cost !== null && session.cost.settled, disk: seen.state?.machine?.disk ?? null, failed: session.cost.failed };
}

/** @param {ReturnType<typeof rangeOf>} range */
function rangeBody(range) {
  const { stops, at, stop, cost, disk, settled } = range;
  if (!cost || !stop) {
    return setupSheet([setupUnder(range.failed ? status('failed', range.failed) : setupWait({ words: 'Estimating sizes' }),
      { className: 'ob-range__reading' })]);
  }
  const adds = stop.bytes;
  const after = (disk?.free_bytes ?? cost.disk.free_bytes) - adds;
  const tight = settled && after < cost.disk.keep_bytes;
  const estimate = settled ? `about ${sizeWords(stop.bytes)}` : 'Estimating';
  const head = '<div class="ob-range__top">'
    + `<span class="ob-range__span" role="status">${esc(stops[at]?.long ?? '')}</span>`
    + `<span class="ob-range__size"><span>Lifestream will store</span><b${attributes({ class: settled ? null : 'is-estimating' })}>${
      esc(estimate)}</b></span></div>`;
  const track = `<div class="ob-range__track" data-ob-track${attributes({ 'data-geo': `--ob-stops:${stops.length};--ob-at:${at}` })}>`
    + '<span class="ob-range__rail"></span><span class="ob-range__fill"></span><span class="ob-range__knob"></span></div>'
    + `<div class="ob-range__stops" role="radiogroup" aria-label="How far back"${attributes({
      'data-geo': `--ob-stops:${stops.length}` })}>`
    + stops.map((each, index) => `<button${attributes({ type: 'button', role: 'radio', class: 'ob-range__stop',
      'aria-checked': String(index === at), tabindex: index === at ? '0' : '-1', 'aria-label': each.long,
      'data-ob': 'span', 'data-at': String(index) })}>${esc(each.short)}</button>`).join('') + '</div>';
  const total = disk ? disk.total_bytes : null;
  const used = disk ? disk.used_bytes : null;
  const share = (/** @type {number} */ bytes) => total ? 100 * bytes / total : 0;
  const adding = settled ? `Lifestream adds ${sizeWords(adds)}, ${sizeWords(Math.max(0, after))} free after`
    : 'estimating what Lifestream adds';
  const bar = total !== null && used !== null ? diskBar({ label: `${disk?.name ?? ''}: ${sizeWords(used)} used, ${adding}`, parts: [
    { id: 'used', name: 'Already used', tone: 'other', share: share(used), size: sizeWords(used) },
    ...settled ? [{ id: 'lifestream', name: 'Lifestream', tone: /** @type {const} */ ('own'), share: share(adds),
      size: sizeWords(adds) }] : [],
    { id: 'free', name: 'Free after', tone: 'free', share: 0, size: sizeWords(Math.max(0, after)) }], key: [] }) : '';
  const legend = (/** @type {string} */ part, /** @type {string} */ name, /** @type {string} */ value) => `<span class="ob-range__key">`
    + `<i class="ob-range__swatch is-${part}" aria-hidden="true"></i>${esc(name)} <b${attributes({
      class: settled || part === 'used' ? null : 'is-estimating' })}>${esc(value)}</b></span>`;
  const drive = disk ? '<div class="ob-range__disk">'
    + `<div class="ob-range__drive"><span>${esc(disk.name)}</span>`
    + `<span class="ob-range__free">${esc(`${sizeWords(disk.free_bytes)} free of ${sizeWords(disk.total_bytes)}`)}</span></div>`
    + bar + '<div class="ob-range__keys">'
    + legend('used', 'Already used', used === null ? '' : sizeWords(used))
    + legend('lifestream', 'Lifestream', settled ? `about ${sizeWords(adds)}` : 'Estimating')
    + legend('free', 'Free after', settled ? sizeWords(Math.max(0, after)) : 'Estimating') + '</div></div>' : '';
  const warn = tight ? setupUnder(`${esc(stop.long === 'Everything' ? 'All of it' : stop.long)} would leave about `
    + `${esc(sizeWords(Math.max(0, after)))} free, too little for macOS to run well. Choose a shorter time, or put Lifestream `
    + 'on an external drive.', { className: 'is-caution' }) : '';
  return setupSheet([`<li class="ob-range">${head}${track}</li>`, drive ? `<li class="ob-range__foot">${drive}</li>` : '', warn],
    { label: 'How far back', className: tight ? 'is-tight' : '' });
}

/**
 * @param {string} connector
 * @param {string} member
 * @param {import('./model.js').ModeItem[]} items
 * @returns {import('../connectors/words.js').Do}
 */
const setTo = (connector, member, items) => ({ host: { act: 'setting', connector, member, value: items } });

/**
 * @param {Seen} seen
 * @param {Session} session
 */
function neverDialog(seen, session) {
  const open = session.dialog;
  const never = neverOf(seen);
  const { screen: stream, member } = never;
  if (!open || !stream || !member || !never.editable) return '';
  const key = settingKey(stream.id, member.key);
  const busy = session.changes.busy.has(key);
  const items = never.items;
  /** @param {{ app: string } | { site: string }} which @param {'record' | 'exclude'} mode */
  const doing = (which, mode) => JSON.stringify(setTo(stream.id, member.key, withMode(items, which, mode)));
  const row = (/** @type {string} */ name, /** @type {string} */ lead, /** @type {string} */ end) => settingRow({ label: name, lead, end });
  const apps = never.apps.map(app => row(app.name, appIcon(app.name, app.icon), iconButton('close', `Remove ${app.name}`,
    { disabled: busy, attrs: { 'data-cn-do': doing({ app: app.id }, 'record') } })));
  const typed = open.app.trim().toLowerCase();
  /** @type {{ name: string, lead: string, attrs: import('../../lib/html.js').Attributes }[]} */
  const finds = [];
  if (typed) {
    for (const app of seen.state?.apps?.offered ?? []) {
      if (finds.length >= APP_FINDS) break;
      if (never.apps.some(each => each.id === app.id) || !app.name.toLowerCase().includes(typed)) continue;
      finds.push({ name: app.name, lead: appIcon(app.name, app.icon), attrs: { 'data-cn-do': doing({ app: app.id }, 'exclude') } });
    }
  }
  const lit = Math.min(Math.max(0, open.lit), Math.max(0, finds.length - 1));
  const adding = addRow({ placeholder: 'Add an app', value: open.app, finds, lit: finds.length ? lit : null,
    input: { 'data-cn-add': 'app', disabled: busy } });
  const privately = never.privately ? row('Private windows', settingTile('hidden'), '<span class="ob-always">Always</span>') : '';
  const sites = never.sites.map(site => row(site, settingTile('web'), iconButton('close', `Remove ${site}`, { disabled: busy,
    attrs: { 'data-cn-do': doing({ site }, 'record') } })));
  const addingSite = addRow({ placeholder: 'Add a site, like mybank.com', value: open.site,
    input: { 'data-ob-site': '', disabled: busy, 'aria-invalid': open.error ? 'true' : null } });
  const failed = session.failure?.key === key ? session.failure.words : '';
  return dialog({ icon: 'hidden', title: 'Never recorded', line: 'Lifestream never records these, on screen or from the keys.',
    close: { 'data-ob': 'close' }, foot: `<span></span>${move('Done', 'close', { variant: 'primary' })}`,
    body: '<div class="ob-never">'
      + `<section aria-label="Apps"><h3 class="ob-never__label">Apps</h3>${setupSheet([...apps, adding])}</section>`
      + (privately ? setupSheet([privately]) : '')
      + `<section aria-label="Sites"><h3 class="ob-never__label">Sites</h3>${setupSheet([...sites, addingSite])}`
      + `${open.error ? status('failed', open.error) : ''}</section>`
      + (failed ? status('failed', failed) : '') + '</div>' });
}

/**
 * @param {Seen} seen
 * @param {string} site
 * @returns {import('../connectors/words.js').Do | null}
 */
export function siteAdded(seen, site) {
  const never = neverOf(seen);
  if (!never.screen || !never.member || never.sites.includes(site)) return null;
  return setTo(never.screen.id, never.member.key, withMode(never.items, { site }, 'exclude'));
}

/**
 * @param {boolean} on
 * @returns {HostAct}
 */
export const scrambleAct = on => ({ act: 'home-setting', settings: { 'privacy.level': on ? 'all' : 'none' } });

export const SCRAMBLE_BUSY = /** @type {string} */ (keyOf(scrambleAct(true)));

