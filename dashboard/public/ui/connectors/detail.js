// @ts-check
/** @import { Callout, Confirm, Detail, DetailPart, End, Lead, Nav, Panel, PanelRow, Progress, SignIn } from './dialog.js' */
/** @import { Act } from './words.js' */
/** @import { View } from './view.js' */
import { attributes, esc } from '../../lib/html.js';
import {
  accessFoot, addRow, findRow, amountBar, appIcon, ARRIVES, askBody, pickSection, boldLine, callout, checkedRow, dialog, differsFace, differsFold, dropZone, factChip,
  factChips, filterChips, icon, iconButton, lines, menuButton, noneLine, progressLine, readFailure, searchField, sectionLabel,
  segmented, settingMenuRow, settingRow, settingsSection, settingTile, settingTime, settingValue, signalShape, stateShape, stepField, stepper, steps, toggle,
  weekFigure,
} from '../kit/index.js';
import { TRY_AGAIN } from '../../lib/reach.js';
import { flowPageRows } from '../flows/view.js';
import { SETTINGS_FIND } from './settings.js';
import { storageMarkup } from './settings-storage.js';
import { actButton, busyWith, doAttrs, failureMarkup, refusalAt } from './view.js';
import { DETAIL } from './words.js';
import { EDITOR_BUSY } from '../agents/detail.js';
import { ACCESS, AGENT } from '../agents/words.js';

/** @param {string[]} buttons */
const acts = buttons => buttons.length ? `<div class="cn-detail__acts">${buttons.join('')}</div>` : '';

/**
 * @param {Confirm} asked
 * @param {View} view
 */
const confirmMarkup = (asked, view) => '<div class="cn-alert" data-cn-alert>'
  + `<div${attributes({ class: 'cn-alert__box', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'cn-alert-q',
    'aria-describedby': 'cn-alert-d' })}>`
  + `<p class="cn-alert__q mac-headline" id="cn-alert-q">${esc(asked.question)}</p>`
  + `<p class="cn-alert__d mac-body" id="cn-alert-d">${esc(asked.detail)}</p>`
  + `<div class="cn-alert__acts">${actButton(asked.no, view)}${actButton(asked.yes, view)}</div></div></div>`;

/**
 * @param {Act} act
 * @param {View} view
 */
function endButton(act, view) {
  if (!act.out) return actButton(act, view);
  const look = `ck-btn ck-btn--${act.variant ?? 'plain'} mac-headline cn-out`;
  if ('link' in act.do) {
    return `<a${attributes({ class: look, href: act.do.link, target: '_blank', rel: 'noopener noreferrer' })}>`
      + `<span class="ck-btn__label">${esc(act.label)}</span>${icon('open-out', { size: 'xs' })}</a>`;
  }
  return `<button${attributes({ type: 'button', class: look, ...doAttrs(act) })}>`
    + `<span class="ck-btn__label">${esc(act.label)}</span>${icon('open-out', { size: 'xs' })}</button>`;
}

/**
 * @param {Lead | null} lead
 * @param {'tile' | 'sm' | 'xs'} [size]
 */
function leadMarkup(lead, size = 'tile') {
  if (!lead) return '';
  if ('icon' in lead) return size === 'tile' ? settingTile(lead.icon) : icon(lead.icon, { size });
  if ('app' in lead) return appIcon(lead.app.name, lead.app.src);
  if ('look' in lead) return stateShape(lead.look);
  if (lead.status === 'done') return icon('done', { size: size === 'xs' ? 'xs' : 'sm' });
  /** @type {Record<string, import('../kit/signal.js').SignalKind>} */
  const shapes = { running: 'engaged', paused: 'idle', waiting: 'idle', disk: 'caution' };
  return signalShape(shapes[lead.status], { pulse: lead.status === 'running' });
}

/**
 * @param {NonNullable<import('./dialog.js').Menu['date']>['said']} said
 * @param {View} view
 */
const dateSaid = (said, view) => !said ? '' : `<p class="ck-fmenu__said-note mac-subhead">${esc(said.note)}</p>`
  + (said.act ? actButton(said.act, view, { size: 'sm' }) : '');

/**
 * @param {import('./dialog.js').Menu} menu
 * @returns {import('../kit/menu-button.js').MenuChoice[]}
 */
const menuChoices = menu => menu.choices.map(choice => ({ value: choice.do ? JSON.stringify(choice.do) : '', words: choice.words,
  note: choice.note, tag: choice.tag, head: choice.head, more: choice.more, chosen: choice.chosen, default: choice.default, disabled: choice.do === null, parted: choice.parted }));

/**
 * @param {End | null} end
 * @param {View} view
 */
function endMarkup(end, view) {
  if (!end) return '';
  if ('time' in end) return settingTime(end.time);
  /** @param {string | undefined} said @param {boolean} [done] */
  const value = (said, done = false) => said ? settingValue(said, { done }) : '';
  if ('segmented' in end) {
    return segmented({ label: end.segmented.label, choices: end.segmented.choices.map(choice => ({ value: choice.value,
      words: choice.words, chosen: choice.chosen, attrs: doAttrs({ label: choice.words, do: choice.do }) })) });
  }
  if ('menu' in end) {
    const { menu } = end;
    return menuButton({ id: menu.id, label: menu.label, words: menu.words, choices: menuChoices(menu), find: menu.find,
      busy: menu.busy !== '' && view.busy.has(menu.busy),
      date: menu.date ? { label: menu.date.label, value: menu.date.value, said: dateSaid(menu.date.said, view),
        attrs: { 'data-cn-date': JSON.stringify({ connector: menu.date.connector, member: menu.date.member, asks: menu.date.asks }) } }
        : null }) + (end.acts ?? []).map(act => endButton(act, view)).join('');
  }
  if ('toggle' in end) {
    const act = { label: '', do: end.toggle.do };
    return value(end.words) + (end.acts ?? []).map(each => endButton(each, view)).join('')
      + toggle({ on: end.toggle.on, label: end.toggle.label, busy: busyWith(act, view), attrs: doAttrs(act) });
  }
  if ('field' in end) {
    const { key, label, kind, value, placeholder, max } = end.field;
    const type = { secret: 'password', email: 'email', date: 'date', text: 'text' }[kind];
    return `<input${attributes({ class: 'ck-field mac-body cn-row__field', type,
      value, placeholder, maxlength: max === undefined ? null : String(max), 'aria-label': label, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'data-cn-field': key })}>`
      + (end.acts ?? []).map(act => endButton(act, view)).join('');
  }
  if ('copy' in end) {
    const { copied, do: doing } = end.copy;
    return `<button${attributes({ type: 'button', class: `ck-ibtn ck-copy__btn${copied ? ' is-copied' : ''}`, 'aria-label': `Copy ${end.copy.label}`,
      title: 'Copy', 'data-cn-copy': end.copy.value, ...doing ? doAttrs({ label: end.copy.label, do: doing }) : {} })}>${icon('copy', { className: 'ck-copy__glyph' })}`
      + `${icon('done', { className: 'ck-copy__check' })}</button><span class="ck-copy__said sr-only" aria-live="polite"></span>`;
  }
  if ('stepper' in end) {
    const { label, text, less, more } = end.stepper;
    /** @param {string} said @param {import('./words.js').Do | null} doing */
    const side = (said, doing) => ({ label: said, disabled: !doing || busyWith({ label: said, do: doing }, view),
      attrs: doing ? doAttrs({ label: said, do: doing }) : {} });
    return stepper({ label, text, less: side(`Less ${label}`, less), more: side(`More ${label}`, more) });
  }
  return value(end.words, end.done) + ('acts' in end ? end.acts.map(act => endButton(act, view)).join('') : '');
}

/**
 * @param {PanelRow} row
 * @param {View} view
 */
function panelRow(row, view) {
  const asked = row.confirm && view.asking === row.confirm.ask ? row.confirm : null;
  if (asked) {
    return settingRow({ asking: true, label: asked.question, line: asked.detail,
      attrs: { class: 'cn-row-ask', role: 'group', 'aria-label': asked.question },
      end: actButton(asked.no, view) + actButton(asked.yes, view) });
  }
  const copy = row.end && 'copy' in row.end;
  const menu = row.menu ? { id: row.menu.id, label: row.menu.label, words: row.menu.words, choices: menuChoices(row.menu),
    busy: row.menu.busy !== '' && view.busy.has(row.menu.busy) } : null;
  /** @type {import('../kit/setting-row.js').SettingRow} */
  const fields = { label: row.label, lead: leadMarkup(row.lead), does: row.does, line: row.line, working: row.working === true, tail: row.tail ?? '', tone: row.tone ?? '',
    tag: row.tag ?? '',
    mark: leadMarkup(row.mark, 'xs'), signal: row.signal ?? null, pulse: row.pulse === true, act: row.act ? doAttrs({ label: '', do: row.act }) : null,
    waiting: row.waiting, only: row.only, holds: row.progress ? progressLine(row.progress) : '', end: endMarkup(row.end, view), dim: row.dim,
    attrs: { class: [copy ? 'cn-row-copy' : '', row.inset ? 'ck-srow--inset' : ''].filter(Boolean).join(' ') || null },
    go: row.go ? { value: row.go.value, time: row.go.time ?? '', attrs: doAttrs({ label: '', do: row.go.do }) } : null,
    open: row.open ? doAttrs({ label: '', do: row.open }) : null };
  return menu ? settingMenuRow(fields, menu) : settingRow(fields);
}

/**
 * @param {Panel} panel
 * @param {View} view
 * @param {{ card?: boolean }} [options]
 */
export const panelMarkup = (panel, view, { card = false } = {}) => settingsSection({ heading: panel.label, line: panel.lede || panel.about, note: panel.note,
  group: panel.group === true,
  attrs: card ? { class: 'ck-ssection--card' } : {},
  rows: [...panel.find ? [findMarkup(panel.find)] : [], ...panel.rows.map(row => panelRow(row, view)), ...panel.add ? [addMarkup(panel.add, view)] : []] });

/** @param {import('./dialog.js').Finding} find */
const findMarkup = find => findRow({ placeholder: find.placeholder, value: find.typed, input: { 'data-cn-add': '' } });

/**
 * @param {NonNullable<Panel['add']>} add
 * @param {View} view
 */
const addMarkup = (add, view) => addRow({ placeholder: add.placeholder, value: add.typed, lit: add.lit,
  input: { 'data-cn-add': '' }, end: endMarkup(add.end, view),
  finds: add.finds.map(find => ({ name: find.name, lead: leadMarkup(find.lead, 'sm'), attrs: doAttrs({ label: find.name, do: find.do }) })) });

/**
 * @param {Callout} said
 * @param {View} view
 */
const calloutMarkup = (said, view) => callout({ kind: said.kind, title: said.title, lines: said.lines,
  acts: said.acts.map(act => actButton(act, view, { size: 'sm' })).join(''),
  choice: said.acts.filter(act => !('feedback' in act.do)).length > 1 });

/**
 * @param {NonNullable<Detail['connect']>} connect
 * @param {View} view
 */
const connectMarkup = (connect, view) => '<div class="cn-connect">' + connect.ways.map((way, at) => (at ? sectionLabel(DETAIL.or, { level: 3 }) : '')
  + steps(way.rows.map(row => ({ title: row.name, line: row.line, mark: row.mark, why: refusalAt(row.act, view),
    body: row.act ? actButton({ ...row.act, variant: row.mark === 'here' ? 'primary' : 'secondary' }, view) : '' })),
  { label: way.label })).join('')
  + connect.notes.map(note => `<p class="cn-connect__note mac-subhead">${esc(note)}</p>`).join('') + '</div>';

/**
 * @param {string} heading
 * @param {string} words
 */
const proseSection = (heading, words) => words ? settingsSection({ heading, body: `<p class="cn-prose mac-body">${esc(words)}</p>` }) : '';

/** @param {Progress} progress */
const progressMarkup = progress => '<section class="cn-progress">'
  + `<p class="cn-progress__head"><span class="mac-headline">${esc(progress.label)}</span>`
  + `<span class="cn-progress__done mac-mono-data">${esc(progress.done)}</span></p>`
  + (progress.share === null ? '' : progressLine({ label: progress.label, share: progress.share }))
  + (progress.line ? `<p class="cn-progress__line mac-subhead">${esc(progress.line)}</p>` : '') + '</section>';

/**
 * @param {SignIn} signin
 * @param {View} view
 */
const signInMarkup = (signin, view) => steps([
  ...signin.steps.map(step => ({ title: step.title, line: step.line, body: step.open ? endButton(step.open, view) : '' })),
  { title: signin.last, mark: /** @type {const} */ ('here'), body: signin.fields.map(field => stepField({ label: field.label, why: field.why,
    note: field.note, input: { type: field.kind === 'secret' ? 'password' : field.kind, value: field.value,
      placeholder: field.placeholder || null, 'data-cn-field': field.key } })).join('') }])
  + (signin.rows.length ? panelMarkup({ label: '', about: '', lede: '', find: null, rows: signin.rows, add: null, note: '' }, view) : '');

/**
 * @param {import('./imports.js').Guide} guide
 * @param {import('./imports.js').Drop | null} drop
 * @param {View} view
 */
const guideMarkup = (guide, drop, view) => steps([
  ...guide.steps.map(step => step.title ? { title: step.title, line: step.words, body: step.open ? endButton(step.open, view) : '' }
    : { title: step.words, body: step.open ? endButton(step.open, view) : '' }),
  ...drop ? [{ title: drop.title, mark: /** @type {const} */ ('here'), body: dropMarkup(drop, view) }] : []], { label: guide.label });

/**
 * @param {import('./imports.js').Drop} drop
 * @param {View} view
 */
const dropMarkup = (drop, view) => dropZone({ words: drop.words, line: drop.line, elsewhere: drop.elsewhere,
  act: drop.choose ? actButton(drop.choose, view) : '' });

/**
 * @param {import('./imports.js').Part} part
 * @param {string} label
 * @param {View} view
 */
function heldMarkup(part, label, view) {
  const [status, ...rest] = part.panel.rows;
  const end = status?.end && 'acts' in status.end ? status.end.acts ?? [] : [];
  const rows = status && part.open ? [{ ...status, end: { acts: [...end, part.open] } }, ...rest] : part.panel.rows;
  if (!part.callout && !part.question) return panelMarkup({ ...part.panel, label, rows }, view);
  return (part.callout ? settingsSection({ heading: label, body: calloutMarkup(part.callout, view) }) : '')
    + (part.question ? panelMarkup({ ...part.question, label: part.callout ? '' : label }, view) : '')
    + panelMarkup({ ...part.panel, rows }, view);
}

/**
 * @param {import('./imports.js').ImportBody} body
 * @param {View} view
 */
function importMarkup(body, view) {
  const yours = body.yours;
  const coming = yours?.coming ? panelMarkup({ ...yours.coming, label: yours.label }, view) : '';
  return (view.error ? failureMarkup(view) : '')
    + body.needs.map(said => calloutMarkup(said, view)).join('')
    + factChips(body.chips.map(chip => factChip(chip)))
    + guideMarkup(body.guide, body.backups ? null : body.drop, view)
    + (body.backups ? panelMarkup(body.backups, view) : '')
    + coming
    + (yours?.parts.map((part, at) => heldMarkup(part, at === 0 && !coming ? yours.label : '', view)).join('') ?? '');
}

/**
 * @param {Detail} detail
 * @param {View} view
 */
function footMarkup(detail, view) {
  const asked = detail.confirm && view.asking === detail.confirm.ask ? detail.confirm : null;
  if (!detail.foot) return asked ? confirmMarkup(asked, view) : '';
  if (detail.foot.note) return `<p class="cn-foot__note mac-subhead">${esc(detail.foot.note)}</p>`;
  if (detail.foot.said) {
    return accessFoot({ said: detail.foot.said, waits: detail.foot.waits ?? [], mark: detail.foot.mark ?? '', busy: detail.foot.busy === true,
      acts: detail.foot.end.map(act => actButton(act, view)).join('') });
  }
  const start = detail.foot.start ? actButton(detail.foot.start, view, { className: 'cn-foot__off' }) : '<span></span>';
  return start + detail.foot.end.map(act => actButton(act, view)).join('') + (asked ? confirmMarkup(asked, view) : '');
}

/**
 * @param {DetailPart} part
 * @param {View} view
 */
function settingsPart(part, view) {
  if (part.flow) return settingsSection({ heading: part.label, rows: [...flowPageRows(part.flow), ...(part.panel?.rows ?? []).map(row => panelRow(row, view))] });
  if (part.button) {
    const asked = part.confirm && view.asking === part.confirm.ask ? part.confirm : null;
    return asked ? settingsSection({ rows: [settingRow({ asking: true, label: asked.question, line: asked.detail,
      attrs: { class: 'cn-row-ask', role: 'group', 'aria-label': asked.question }, end: actButton(asked.no, view) + actButton(asked.yes, view) })] })
      : `<div class="cn-set__foot">${actButton(part.button, view)}</div>`;
  }
  if (part.figure) return readsFigure(part.figure);
  if (part.kinds) {
    return filterChips({ label: part.kinds.label, value: part.kinds.value, clears: true, attrs: { 'data-cn-chips': 'kind' },
      choices: part.kinds.choices });
  }
  if (part.amount) return amountBar({ ...part.amount, other: AGENT.other });
  if (part.refused) return `<p class="ck-refused" role="status">${esc(part.refused)}</p>`;
  if (part.control) return controlMarkup(part.control, view);
  if (part.hides) {
    const { level, heading, rows } = part.hides;
    const busy = view.busy.has(EDITOR_BUSY);
    return segmented({ label: level.label, choices: level.choices.map(choice => ({ value: choice.value, words: choice.words,
      chosen: choice.chosen, attrs: doAttrs({ label: choice.words, do: choice.do }) })) })
      + settingsSection({ heading, attrs: { class: 'ck-ssection--card' }, rows: rows.map(row => checkedRow({ name: row.name, line: row.line,
        check: row.check, fixed: row.do === null, busy, attrs: row.do ? doAttrs({ label: ACCESS.hide(row.name), do: row.do }) : {} })) });
  }
  if (part.steps) return stepsMarkup(part.steps, view);
  if (part.pick) {
    return pickSection({ label: part.pick.label, line: part.pick.line,
      choices: part.pick.choices.map(choice => ({ n: choice.n, busy: busyWith({ label: '', do: choice.do }, view),
        attrs: doAttrs({ label: String(choice.n), do: choice.do }) })) });
  }
  if (part.ask) return askBody(part.ask);
  if (part.said && !part.label) return boldLine(part.said, { attrs: { class: 'ck-said' } });
  if (part.said) return settingsSection({ heading: part.label, body: boldLine(part.said) });
  const panel = part.panel;
  const add = panel?.add ? addMarkup(panel.add, view) : '';
  const find = panel?.find ? findMarkup(panel.find) : '';
  const rows = (panel?.rows ?? []).map(row => panelRow(row, view));
  const alone = !rows.length && !add && !find && !part.list?.length && part.text === undefined && part.lines.length > 0;
  const body = part.list?.length ? `<ul class="cn-set__list mac-body">${part.list.map(each => `<li>${esc(each)}</li>`).join('')}</ul>`
    : part.text !== undefined ? `<pre class="cn-set__text mac-mono-data">${esc(part.text)}</pre>`
      : alone ? `<p class="cn-set__said mac-body">${esc(part.lines.join(' '))}</p>` : '';
  const chips = part.chips?.length ? '<li class="cn-set__chips"><div class="ck-chips" role="group" aria-label="Starting points">'
    + part.chips.map(chip => `<button${attributes({ type: 'button', class: `ck-chip${chip.lit ? ' is-selected' : ''}`,
      'aria-pressed': chip.lit ? 'true' : 'false', disabled: busyWith({ label: chip.label, do: chip.do }, view),
      ...doAttrs({ label: chip.label, do: chip.do }) })}>${esc(chip.label)}</button>`).join('') + '</div></li>' : '';
  return settingsSection({ heading: part.label, line: alone ? '' : part.lines.join(' '), aside: part.aside ?? [],
    rows: [...find ? [find] : [], ...chips ? [chips] : [], ...rows, ...add ? [add] : []],
    ...body ? { body } : {}, act: part.acts.map(act => actButton(act, view)).join(''), note: panel?.note ?? '', group: panel?.group === true,
    attrs: { ...part.id ? { 'data-set-at': part.id } : {}, ...part.card ? { class: 'ck-ssection--card' } : {} } });
}

/**
 * @param {import('../agents/guides.js').StepShown[]} shown
 * @param {View} view
 * @returns {string}
 */
const stepsMarkup = (shown, view) => `<div class="cn-guide">${steps(shown.map(step => ({ title: step.title, line: step.line,
  mark: step.mark === 'later' ? 'idle' : step.mark,
  body: (step.field ? stepField({ label: step.field.label, shown: false, input: { value: step.field.value,
    placeholder: step.field.placeholder, maxlength: '200', 'data-cn-field': step.field.key } }) : '')
    + (step.open ? endButton(step.open, view) : '') + step.parts.map(part => settingsPart(part, view)).join('') })))}</div>`;

/** @param {import('../../types.js').ReadsFigure} figure */
const readsFigure = figure => weekFigure({ today: figure.today, noun: null, unit: figure.words, last: '', said: figure.said,
  week: figure.days.map(day => day.n), end: figure.days.at(-1)?.day ?? '' });

/**
 * @param {import('../agents/detail.js').ControlLine} line
 * @param {View} view
 * @param {boolean} [inner]
 * @returns {string}
 */
function controlLineMarkup(line, view, inner = false) {
  const { differs } = line;
  const shown = !differs ? '' : 'fold' in differs
    ? differsFold({ words: differs.fold.words, open: differs.fold.open, attrs: doAttrs({ label: '', do: differs.fold.do }) })
    : menuButton({ id: differs.menu.id, label: differs.menu.label, words: differs.menu.words, choices: menuChoices(differs.menu),
      busy: differs.menu.busy !== '' && view.busy.has(differs.menu.busy), attrs: { class: 'ck-fmenu--start' },
      face: { markup: differsFace(differs.menu.words), className: 'ck-srow__differs mac-subhead' } });
  return checkedRow({ name: line.name, icon: line.icon, line: line.line, check: line.check, waits: line.waits, inner,
    busy: view.busy.has(EDITOR_BUSY), attrs: doAttrs({ label: line.name, do: line.do }), differs: shown,
    end: line.count?.n ?? '', endSaid: line.count?.words ?? '' })
    + line.inner.map(each => controlLineMarkup(each, view, true)).join('');
}

/**
 * @param {import('../agents/detail.js').Control} control
 * @param {View} view
 */
const controlMarkup = (control, view) => '<div class="ck-modes">'
  + segmented({ label: control.mode.label, choices: control.mode.choices.map(choice => ({ value: choice.value, words: choice.words,
    chosen: choice.chosen, attrs: doAttrs({ label: choice.words, do: choice.do }) })) })
  + (control.modeLine ? `<p class="ck-modes__line">${esc(control.modeLine)}</p>` : '') + '</div>'
  + settingsSection({ heading: control.label, aside: control.aside ? [{ text: control.aside }] : [], attrs: { class: 'ck-ssection--card' },
    rows: control.lines.map(line => controlLineMarkup(line, view)) });

/** @param {Nav} nav */
const settingsNav = nav => '<nav class="cn-set__nav" aria-label="Settings pages">'
  + searchField({ placeholder: 'Search', value: nav.query, attrs: { 'aria-label': 'Search settings', 'data-cn-field': SETTINGS_FIND } })
  + nav.groups.map((group, at) => `<div class="cn-set__group" role="group"${attributes({ 'aria-labelledby': `cn-set-g${at}` })}>`
    + sectionLabel(group.label, { id: `cn-set-g${at}` })
    + group.items.map(item => `<button${attributes({ type: 'button', class: `cn-set__item ck-navrow${item.on ? ' is-on' : ''}`,
      'aria-current': item.on ? 'page' : null, 'data-cn-set-page': item.id, ...doAttrs({ label: item.label, do: item.do }) })}>`
      + `${icon(item.icon, { size: 'sm' })}<span class="cn-set__iname ck-navrow__words">${esc(item.label)}</span>`
      + (item.dot ? '<span class="cn-set__dot" aria-hidden="true"></span><span class="sr-only">, needs you</span>' : '')
      + '</button>').join('') + '</div>').join('')
  + (nav.groups.length ? '' : noneLine('No settings match.')) + '</nav>';

/**
 * @param {Detail & { nav: Nav }} detail
 * @param {View} view
 * @param {string} [flow]
 */
function settingsMarkup(detail, view, flow = '') {
  const title = detail.back
    ? `<button${attributes({ type: 'button', class: 'cn-set__back', ...doAttrs({ label: '', do: { back: true } }),
      'aria-label': `Back to ${detail.back.label}` })}>${icon('back', { size: 'sm' })}<span>${esc(detail.back.label)}</span></button>`
    : `<h2 class="cn-set__title">${esc(detail.name)}</h2>`;
  const said = !detail.line ? '' : (detail.back ? `<h2 class="cn-set__title">${esc(detail.name)}</h2>` : '')
    + `<p class="cn-set__line">${esc(detail.line)}</p>`;
  const body = (detail.storage ? storageMarkup(detail.storage.answer, detail.storage.more) : '') + detail.parts.map(part => settingsPart(part, view)).join('');
  const failed = detail.readFailed ? readFailure(detail.readFailed.drawn, { notHere: detail.readFailed.notHere,
    unread: detail.readFailed.unread, lacking: detail.readFailed.lacking,
    retry: doAttrs({ label: TRY_AGAIN, do: { reread: detail.readFailed.reread } }) }) : '';
  const page = flow ? flow
    : `<div class="cn-set__page">${title}${said}`
      + (detail.note ? `<p class="cn-set__note">${esc(detail.note)}</p>` : '')
      + (detail.callout ? calloutMarkup(detail.callout, view) : '')
      + (detail.reading ? lines(3) + failed : failed + body) + '</div>';
  return '<div class="ck-scrim" data-scrim>'
    + `<div${attributes({ class: 'ck-dialog cn-set', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Settings: ${detail.name}` })}>`
    + `<header class="cn-set__bar"><p class="cn-set__name">Settings</p>${iconButton('close', 'Close', { attrs: { 'data-cn-close': '' } })}</header>`
    + `<div class="cn-set__body">${settingsNav(detail.nav)}`
    + `<div${attributes({ class: `cn-set__main ck-dialog__body${flow ? ' cn-set__main--flow' : ''}` })}>${page}</div></div></div></div>`;
}

/**
 * @param {Detail} detail
 * @param {View} view
 * @param {{ flow?: string }} [options]
 */
export function detailMarkup(detail, view, { flow = '' } = {}) {
  if (detail.nav) return settingsMarkup({ ...detail, nav: detail.nav }, view, flow);
  const close = { 'data-cn-close': '' };
  const back = detail.back ? { label: detail.back.label, above: detail.back.above === true, attrs: doAttrs({ label: '', do: { back: true } }) }
    : null;
  /** @param {Panel[]} drawn */
  const panelsMarkup = drawn => drawn.map(panel => panelMarkup(panel, view, { card: true })).join('');
  if (detail.import) {
    return dialog({ icon: detail.icon, title: detail.name, line: detail.line, close, back, foot: '', page: detail.page === true,
      body: `<div class="cn-detail__read cn-import ${ARRIVES}">${importMarkup(detail.import, view)}</div>` });
  }
  const callout = (detail.callout ? calloutMarkup(detail.callout, view) : '') + (detail.held ?? []).map(said => calloutMarkup(said, view)).join('');
  const figure = detail.figure;
  const emptyWeek = figure?.today === 0 && figure.week?.every(count => count === 0);
  const weekly = !figure ? '' : emptyWeek
    ? noneLine(`No ${figure.noun?.[1] ?? 'records'} this week${figure.last ? ` · ${figure.last}` : ''}`)
    : weekFigure(figure);
  const body = detail.signin ? signInMarkup(detail.signin, view)
    : detail.connect ? connectMarkup(detail.connect, view) + proseSection(DETAIL.reads, detail.reads ?? '') + proseSection(DETAIL.where, detail.where ?? '')
      : (detail.progress ? progressMarkup(detail.progress) : weekly) + detail.parts.map(part => settingsPart(part, view)).join('')
        + panelsMarkup(detail.panels)
        + (detail.reads ? `<p class="cn-prose cn-prose--reads mac-body">${esc(detail.reads)}</p>` : '');
  const above = callout;
  return dialog({
    icon: detail.icon, title: detail.name, line: detail.line, said: detail.said ?? [], close, back,
    foot: footMarkup(detail, view), above, page: detail.page === true,
    body: detail.reading ? body + lines(3) : `<div class="cn-detail__read ${ARRIVES}">${body}</div>`,
  });
}

