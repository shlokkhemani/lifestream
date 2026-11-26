// @ts-check
/** @import { Host, HostAct, HostState } from '../../lib/host.js' */
/** @import { ReportReader } from '../../lib/report.js' */
/** @import { StreamsReport } from '../../types.js' */
/** @import { PageChanges } from './changes.js' */
/** @import { Opened } from './dialog.js' */
/** @import { Do } from './words.js' */
/** @import { View } from './view.js' */
import { actOnNeed, refreshNow } from '../../lib/api.js';
import { refusalOf } from '../../lib/host.js';
import { actSaid, actWords, lacks, requestState } from '../../lib/reach.js';
import {
  arrivals, arrive, checkPanelHere, checkPanelTravel, chipPick, installAreaCharts, installCardGrid, installDropZones, installFilterMenus,
  installLights, installTabs, reading, showCopied,
} from '../kit/index.js';
import { copyText } from '../dom.js';
import { applyGeometry } from '../geometry.js';
import { onHomeChange } from '../live.js';
import { detailMarkup } from './detail.js';
import { detailOf, formActs, formAnswered, modelFinding, OPENED } from './dialog.js';
import { modelFinder } from '../../lib/model-menu.js';
import { usesFinding } from './settings-models.js';
import { isSettings, pagesAt, SETTINGS_FIND, settingsAt } from './settings.js';
import { agentsFrame } from '../agents/frame.js';
import { isAgentDialog } from '../agents/detail.js';
import { dayAt } from '../../lib/home-clock.js';
import { storageAfter, storageBefore } from './settings-storage.js';
import { settingsFrame } from './settings-frame.js';
import { appAdded, formDo, signInOf } from './page.js';
import { actKey } from './pending.js';
import { installRangeDates } from './range-dates.js';
import { busyKey, landed, refusalAt, refusing, saidMarkup } from './view.js';
import { sessionOf } from '../flows/model.js';
import { actRunner, flowFrame, focusFirst, installFlow, leavesBack, primary, put } from '../flows/frame.js';
import { flowDialog } from '../flows/view.js';

const TICK_MS = 60_000;
const SAVED_MS = 2_000;

/**
 * @typedef {object} LayerRoutes
 * @property {(id: string) => void} dialog
 * @property {(id: string) => void} flow
 * @property {(view: string, patch?: object) => void} go
 * @property {(asked: { connector: string, name: string }) => void} feedback
 */

/**
 * @param {HTMLElement} container
 * @param {Host | null} host
 * @param {ReportReader} reports
 * @param {PageChanges} changes
 * @param {{ routes: () => LayerRoutes, inert: (on: boolean) => void }} parts
 */
export function streamDialogs(container, host, reports, changes, { routes, inert }) {
  container.innerHTML = '<div data-part="dialog"></div><p class="sr-only" aria-live="polite" data-part="flow-said"></p>';
  container.hidden = true;
  /** @param {string} name */
  const part = name => /** @type {HTMLElement} */ (container.querySelector(`[data-part="${name}"]`));
  installCardGrid(container);
  const relight = installLights(container);
  /** @type {StreamsReport | null} */
  let report = reports.seen.report;
  /** @type {HostState | null} */
  let state = host?.state ?? null;
  let id = '';
  let routed = '';
  /** @type {number[]} */
  let scrolls = [];
  let alerting = false;
  /** @type {HTMLElement | null} */
  let opener = null;
  /** @type {HTMLElement | null} */
  let pressed = null;
  let focusing = false;
  /** @type {View} */
  const view = { busy: changes.busy, asking: '', notice: '', error: '', at: '', over: /** @type {object | null} */ (null), done: '' };
  let drawn = '';
  let shown = '';
  let opened = /** @type {Opened & { kept: Set<string> }} */ ({ ...OPENED, kept: new Set() });
  let opening = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticker = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  const session = sessionOf(host !== null, 'dialog');
  const runner = actRunner(host, session, { draw: () => draw(), reports, name: 'streams' });
  const flow = flowFrame({ session, reports, runner, draw: () => draw(),
    shown: () => id !== '', root: () => part('dialog'), leave: () => routes().flow(''),
    say: words => {
      part('flow-said').textContent = words;
    } });
  const settings = settingsFrame(host, reports, changes, { draw: () => draw(), root: () => part('dialog'), say: words => {
    part('flow-said').textContent = words;
  } });
  const holdsHome = () => host !== null && state !== null && state.folder !== null && reports.seen.report !== null
    && reports.failure() === '' && !lacks(state.reach);
  const agents = agentsFrame({ host, draw: () => draw(), holdsHome, hold: changes.hold });
  let wanted = { then: '', make: false };
  let then = '';
  /** @type {{ here: DOMRect | null, said: Map<string, string> } | null} */
  let under = null;

  const finder = modelFinder(() => draw());
  const foundNow = () => {
    const asked = isSettings(id) ? usesFinding(opened) : modelFinding(report, id, opened);
    return asked ? finder.find(asked, opened.typed) : null;
  };
  const detail = () => !id ? null : isSettings(id) ? settings.detail({ id, state, opened: { ...opened, found: foundNow() }, report })
    : isAgentDialog(id) ? agents.detail({ id, state, opened, home: holdsHome(), now: Date.now() })
      : detailOf(report, state, id, { ...opened, dated: dates.dated(), found: foundNow() });
  const ownReading = () => isSettings(id) || isAgentDialog(id);

  const dates = installRangeDates(container, { draw: () => draw(), markup: () => {
    const open = detail();
    return open ? detailMarkup(open, view) : '';
  }, send: doing => void run(JSON.stringify(doing)) });

  /** @returns {View} */
  const dialogSaid = () => {
    const open = detail();
    const saidThere = Boolean(open?.import)
      || open?.connect?.ways.some(way => way.rows.some(row => refusalAt(row.act, view) !== '')) === true;
    return saidThere ? { ...view, error: '' } : view;
  };

  let dead = '';
  let placed = '';

  /** @type {ReturnType<typeof storageBefore> | null} */
  let stood = null;

  function draw() {
    if (settings.follow({ id, state, opened, visible: !container.hidden })) return;
    agents.follow({ id, state, opened, shown: !container.hidden, zone: dayAt(Date.now()).zone });
    const open = detail();
    if (id && !open && (ownReading() || report !== null)) {
      if (dead !== id) {
        dead = id;
        queueMicrotask(() => {
          if (id === dead) routes().dialog('');
        });
      }
      return;
    }
    const showing = id ? flow.tick() : null;
    reading(container, open !== null && (ownReading() ? open.reading : report === null && !reports.failure()),
      isSettings(id) ? 'Reading your settings' : 'Reading your connectors');
    const at = showing ? `${id}/flow:${showing.id}` : open ? `${open.id}/${opened.pages.join('/')}` : '';
    if (!part('dialog').querySelector('.ck-fmenu--float [aria-expanded="true"]')) {
      const flowing = showing ? flowDialog(showing, { back: open ? `Back to ${open.name}` : 'Back', bare: Boolean(open?.nav),
        page: open?.page === true }) : '';
      const markup = open?.nav ? detailMarkup(open, view, { flow: flowing }) : flowing || (open ? detailMarkup(open, view) : '');
      stood = storageBefore(part('dialog'));
      if (markup !== drawn) {
        put(part('dialog'), markup, { keep: at.split('/')[0] && at.split('/')[0] === shown.split('/')[0] ? '.ck-dialog' : '',
          scroll: at === shown });
        drawn = markup;
      }
      const named = open?.at ? `${opening}:${open.at}` : '';
      const target = named && placed !== named ? part('dialog').querySelector(`[data-set-at="${CSS.escape(/** @type {string} */ (open?.at))}"]`) : null;
      if (target) {
        target.scrollIntoView({ block: 'start' });
        placed = named;
      }
      shown = at;
    }
    const close = /** @type {HTMLElement | null} */ (part('dialog').querySelector('[data-cn-close]'));
    if (focusing && close) {
      focusing = false;
      const dialog = /** @type {HTMLElement | null} */ (close.closest('.ck-dialog'));
      if (dialog) {
        dialog.tabIndex = -1;
        dialog.focus({ preventScroll: true });
      }
    }
    const alert = /** @type {HTMLElement | null} */ (part('dialog').querySelector('[data-cn-alert] button'));
    if (alert && !alerting) alert.focus();
    alerting = alert !== null;
    if (open?.ticking && !ticker) ticker = setInterval(() => { if (!document.hidden) void read(); }, TICK_MS);
    if (!open?.ticking && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    const body = showing ? null : part('dialog').querySelector('.cn-set__page') ?? part('dialog').querySelector('.ck-dialog__body');
    const said = body ? saidMarkup(dialogSaid()) : '';
    let line = body?.querySelector(':scope > [data-layer-said]') ?? null;
    const came = Boolean(said && !line);
    if (said && !line) {
      line = document.createElement('div');
      line.className = 'cn-said';
      line.setAttribute('data-layer-said', '');
      const title = body?.querySelector(':scope > .cn-set__title, :scope > .cn-set__back');
      if (title) title.after(line);
      else body?.prepend(line);
    }
    if (line && !said) line.remove();
    else if (line && line.innerHTML !== said) line.innerHTML = said;
    if (came && line && body?.matches('.cn-set__page')) line.scrollIntoView({ block: 'nearest' });
    applyGeometry(part('dialog'));
    if (stood) storageAfter(part('dialog'), stood);
    stood = null;
    relight();
    for (const listener of listeners) listener();
  }

  const read = () => reports.read();
  const heard = () => {
    report = reports.seen.report;
    landed(view, report);
    draw();
  };

  /** @param {string | null} page */
  function turnPage(page) {
    const pages = page ? [...opened.pages, page] : opened.pages.slice(0, -1);
    if (!isSettings(id)) {
      routes().dialog([id, ...pages].join('/'));
      return;
    }
    turnTo(pages);
  }

  /** @param {string[]} pages */
  function turnTo(pages) {
    const from = opened.pages;
    const deeper = pages.length > from.length;
    const was = part('dialog').querySelector('.ck-dialog__body');
    if (deeper && was) scrolls[from.length] = was.scrollTop;
    opened = { ...opened, pages, typed: '', lit: 0, kept: new Set(), fields: {}, refused: '' };
    view.asking = '';
    draw();
    const body = part('dialog').querySelector('.ck-dialog__body');
    if (body instanceof HTMLElement) {
      body.scrollTop = deeper ? 0 : scrolls[pages.length] ?? 0;
      body.closest('.ck-dialog')?.classList.toggle('is-scrolled', body.scrollTop > 0);
      body.classList.remove('is-pushed', 'is-popped');
      void body.offsetWidth;
      body.classList.add(deeper ? 'is-pushed' : 'is-popped');
    }
    scrolls = scrolls.slice(0, pages.length + 1);
    const to = deeper ? part('dialog').querySelector('.ck-dialog__back, .ck-dialog__backlink, .cn-set__back')
      : part('dialog').querySelector(`[data-cn-do="${CSS.escape(JSON.stringify({ page: from.at(-1) }))}"]`);
    if (to instanceof HTMLElement) to.focus({ preventScroll: true });
  }

  /** @param {string} next */
  const placeOf = next => isSettings(next) ? { base: next, pages: pagesAt(next) }
    : { base: next.split('/')[0], pages: next.split('/').slice(1).filter(Boolean) };

  /** @param {string} key */
  function forgetField(key) {
    if (!key) return;
    const { [key]: _gone, ...kept } = opened.fields ?? {};
    opened = { ...opened, fields: kept };
    for (const field of part('dialog').querySelectorAll(`[data-cn-field="${CSS.escape(key)}"]`)) {
      if (field instanceof HTMLInputElement) field.value = '';
    }
    drawn = '';
    draw();
  }

  /** @param {HostAct} act */
  function keepRows(act) {
    if (act.act !== 'setting' || !Array.isArray(act.value) || opened.pages.at(-1) !== `list:${act.member}`) return;
    const member = report?.connectors.find(each => each.id === act.connector)?.members.find(each => each.key === act.member);
    const before = Array.isArray(member?.value) ? member.value : [];
    /** @param {unknown} item */
    const name = item => item && typeof item === 'object' ? JSON.stringify(item) : String(item);
    const after = new Set(act.value.map(name));
    for (const item of before) {
      if (after.has(name(item))) continue;
      const which = /** @type {{ app?: string, site?: string }} */ (item && typeof item === 'object' ? item : {});
      opened.kept.add(`${act.connector}.${act.member}:${which.app ? `app:${which.app}`
        : which.site ? `rule:${which.site}` : String(item)}`);
    }
  }

  /**
   * @param {string} key
   * @param {string} [label]
   */
  async function run(key, label = '') {
    const doing = /** @type {Do} */ (JSON.parse(key));
    if ('open' in doing && flow.id) return void flow.tryLeave('close', () => routes().dialog(doing.open));
    if ('open' in doing && doing.push) {
      window.location.hash = `#dialog=${encodeURIComponent(doing.open)}`;
      return;
    }
    if ('open' in doing) return routes().dialog(doing.open);
    if ('theme' in doing) return settings.theme(doing.theme);
    if ('form' in doing) return setUp(doing.form, key, label);
    if ('page' in doing) return turnPage(doing.page);
    if ('back' in doing) return turnPage(null);
    if ('rest' in doing) return settings.more();
    if ('reread' in doing) return settings.reread(doing.reread);
    if ('typed' in doing) {
      opened = { ...opened, fields: { ...opened.fields, [doing.typed.key]: doing.typed.value } };
      return draw();
    }
    if ('flow' in doing) {
      wanted = { then: doing.then ?? '', make: doing.make ?? false };
      return routes().flow(doing.flow);
    }
    if ('to' in doing) return routes().go(doing.to.view, doing.to.patch);
    if ('feedback' in doing) return routes().feedback(doing.feedback);
    if ('ask' in doing) {
      view.asking = doing.ask;
      return draw();
    }
    if ('at' in doing || 'fold' in doing) return;
    if ('refresh' in doing) {
      const under = busyKey(doing);
      if (changes.busy.has(under)) return;
      refusing(view, null, '', '', null);
      /** @type {{ said: import('../../lib/reach.js').Said, words: string } | null} */
      let refused = null;
      await changes.hold(under, async () => {
        await refreshNow(doing.refresh).catch(error => {
          refused = actSaid(requestState(error));
        });
        await read();
      });
      if (refused) refusing(view, refused, key, label, reports.seen.report);
      return draw();
    }
    if ('edit' in doing || 'editor' in doing || 'since' in doing || 'answer' in doing || 'earlier' in doing || 'disconnect' in doing
      || 'unlist' in doing || 'kind' in doing || 'things' in doing || 'guide' in doing) {
      refusing(view, null, '', '', null);
      draw();
      const done = await agents.act(doing).catch(error => {
        refusing(view, refusalOf(error), key, label, reports.seen.report);
        return undefined;
      });
      if (done === 'close') return routes().dialog('');
      if (done === 'back') return turnPage(null);
      return draw();
    }
    if (!('home' in doing) && !host) return;
    const saved = 'save' in doing ? settings.saved(doing.save, opened, report) : null;
    const asked = 'host' in doing ? doing.host : saved?.act ?? null;
    if ('save' in doing && !asked) return;
    const savedOn = opened.pages.at(-1) ?? null;
    const stillOn = () => 'save' in doing && asking === opening && (opened.pages.at(-1) ?? null) === savedOn;
    const under = saved ? actKey(saved.act) : busyKey(doing);
    if (changes.busy.has(under)) return;
    if (asked) keepRows(asked);
    forgetField(saved?.forget ?? '');
    const adding = document.activeElement?.closest('.ck-srow--add') ?? null;
    if ((asked?.act === 'setting' || asked?.act === 'home-setting') && opened.typed) opened = { ...opened, typed: '', lit: 0 };
    const asking = opening;
    refusing(view, null, '', '', null);
    view.notice = '';
    view.asking = '';
    view.done = '';
    if ('home' in doing) {
      await changes.hold(under, async () => {
        await actOnNeed(doing.home).catch(() => undefined);
        await read();
      });
    } else if (asked) {
      const sent = await changes.send(asked, { holds: 'host' in doing ? doing.holds ?? null : null,
        keeps: reply => asked.act !== 'choose-app' || appAdded(reply), label });
      if (!sent) return;
      if ('refused' in sent) refusing(view, refusalOf(sent.refused), saved?.forget ? '' : key, label, reports.seen.report);
      else {
        view.notice = sent.reply.notice ?? '';
        if (stillOn()) opened = { ...opened, fields: {} };
        if (stillOn() && savedOn === null) {
          const done = busyKey(doing);
          view.done = done;
          setTimeout(() => {
            if (view.done !== done) return;
            view.done = '';
            draw();
          }, SAVED_MS);
        }
      }
    }
    if (stillOn() && !view.error && savedOn !== null) turnPage(null);
    draw();
    if (adding) /** @type {HTMLElement | null} */ (part('dialog').querySelector('[data-cn-add]'))?.focus();
  }

  /**
   * @param {string} connectorId
   * @param {string} key
   * @param {string} label
   */
  async function setUp(connectorId, key, label) {
    const connector = report?.connectors.find(each => each.id === connectorId);
    if (!host || !connector || changes.busy.has(key)) return;
    const acts = formActs(connector, opened);
    const asking = opening;
    opened = { ...opened, refused: '' };
    view.notice = '';
    /** @type {string | null} */
    let refused = null;
    await changes.hold(key, async () => {
      try {
        for (const act of acts) await host.act(act, label);
      } catch (error) {
        refused = actWords(refusalOf(error));
      }
      await read();
    });
    const answered = formAnswered(opened, { pressed: asking, now: opening, refused });
    opened = /** @type {typeof opened} */ (answered.opened);
    if (answered.back) turnPage(null);
    else draw();
  }

  container.addEventListener('click', event => {
    const target = /** @type {Element} */ (event.target);
    const chip = target.closest('[data-cn-chips] .ck-fchip');
    const chips = /** @type {HTMLElement | null} */ (chip?.closest('[data-cn-chips]') ?? null);
    if (chip && chips) return void run(JSON.stringify({ [chips.dataset.cnChips ?? '']: chipPick(chip) }));
    const copying = /** @type {HTMLElement | null} */ (target.closest('[data-cn-copy]'));
    if (copying) {
      void copyText(copying.dataset.cnCopy ?? '').then(() => showCopied(copying));
      if (copying.dataset.cnDo) void run(copying.dataset.cnDo, copying.dataset.cnLabel);
      return;
    }
    const doer = /** @type {HTMLElement | null} */ (target.closest('[data-cn-do]'));
    const opens = /** @type {HTMLElement | null} */ (target.closest('[data-cn-open]'));
    if (target.matches('[data-cn-alert]')) {
      view.asking = '';
      draw();
    } else if (doer) void run(/** @type {string} */ (doer.dataset.cnDo), doer.dataset.cnLabel);
    else if (opens) routes().dialog(/** @type {string} */ (opens.dataset.cnOpen));
    else if (target.matches('[data-scrim]') && flow.id) flow.tryLeave('close');
    else if (target.closest('[data-cn-close]') && flow.id) flow.tryLeave('close', () => routes().dialog(''));
    else if (target.closest('[data-cn-close]') || target.matches('[data-scrim]')) routes().dialog('');
  });

  installTabs(container);
  installAreaCharts(container);
  installDropZones(container);
  installFilterMenus(container, (menu, value) => {
    if (menu.dataset.flowMenu === 'browser') return flow.picked(value);
    void run(value);
  });
  installFlow(container, () => flow.id ? flow : settings.plans.id ? settings.plans : null);

  container.addEventListener('input', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.cnField === SETTINGS_FIND) {
      settings.find(input.value);
      return;
    }
    if (input.dataset.cnField) {
      opened = { ...opened, fields: { ...opened.fields, [input.dataset.cnField]: input.value } };
      draw();
      return;
    }
    if (!input.hasAttribute('data-cn-add')) return;
    opened = { ...opened, typed: input.value, lit: 0 };
    draw();
  });

  container.addEventListener('keydown', event => {
    const input = event.target;
    const item = input instanceof HTMLElement ? input.closest('[data-cn-set-page]') : null;
    if (item && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = [...part('dialog').querySelectorAll('[data-cn-set-page]')];
      const next = items[items.indexOf(item) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next instanceof HTMLElement) {
        next.focus();
        next.click();
      }
      return;
    }
    if (input instanceof HTMLInputElement && input.dataset.cnField === SETTINGS_FIND && event.key === 'Escape' && input.value) {
      event.preventDefault();
      event.stopPropagation();
      settings.find('');
      return;
    }
    if (input instanceof HTMLInputElement && input.dataset.cnField && event.key === 'Enter') {
      const send = input.closest('.ck-srow')?.querySelector('.ck-srow__end button:not(:disabled)')
        ?? part('dialog').querySelector('.ck-dialog__foot .ck-btn--primary:not(:disabled)');
      if (!(send instanceof HTMLElement)) return;
      event.preventDefault();
      send.click();
      return;
    }
    if (!(input instanceof HTMLInputElement) || !input.hasAttribute('data-cn-add')) return;
    const open = detail();
    const add = [...open?.panels ?? [], ...open?.parts.map(each => each.panel) ?? []].find(panel => panel?.add)?.add;
    if (!add) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      opened = { ...opened, lit: Math.max(0, Math.min(add.finds.length - 1, opened.lit + step)) };
      draw();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const doing = add.finds[add.lit]?.do ?? add.enter;
      if (doing) void run(JSON.stringify(doing));
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      opened = { ...opened, typed: '', lit: 0 };
      draw();
    }
  });

  document.addEventListener('keydown', event => {
    if (!id) return;
    event.stopImmediatePropagation();
    if (event.defaultPrevented) return;
    if (flow.id) {
      if (event.key === 'Escape') {
        event.preventDefault();
        flow.tryLeave('escape');
      } else if (event.key === 'Enter') primary(part('dialog'), event);
      return;
    }
    if (event.key === 'Enter' && !event.metaKey && !view.asking) primary(part('dialog'), event, '.ck-numbered__step.is-here .ck-btn:not(:disabled)');
    const pressing = document.activeElement?.closest('button, a[href], input, textarea') ?? null;
    const keys = event.key === 'z' && event.metaKey && !event.shiftKey ? '⌘Z' : event.key === 'Enter' && event.metaKey ? '⌘↵'
      : event.key === 'Enter' && !pressing ? '↵' : event.key === 'Escape' ? 'esc' : '';
    const undo = keys && !view.asking
      ? part('dialog').querySelector(`.ck-dialog__foot [data-cn-keys="${keys}"]:not(:disabled)`) : null;
    if (undo instanceof HTMLElement && !(document.activeElement instanceof HTMLInputElement)) {
      event.preventDefault();
      undo.click();
      return;
    }
    if (event.key === '[' && event.metaKey && opened.pages.length && !view.asking) {
      event.preventDefault();
      turnPage(null);
      return;
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !isSettings(id) && !view.asking) {
      const at = document.activeElement;
      if (at instanceof HTMLInputElement || at?.closest('.ck-fmenu, [role="listbox"], [role="menu"]')) return;
      const rows = [...part('dialog').querySelectorAll('.ck-dialog__body :is(.ck-srow__hit, .ck-srow__end button, .ck-numbered .ck-btn)')]
        .filter(each => each instanceof HTMLElement && !each.matches(':disabled'));
      const index = rows.findIndex(each => each === at || each.contains(at));
      const next = rows[index === -1 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : index + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next instanceof HTMLElement) {
        event.preventDefault();
        next.focus();
        next.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (view.asking) {
      view.asking = '';
      draw();
    } else if (opened.pages.length) turnPage(null);
    else routes().dialog('');
  });

  reports.follow(heard);
  document.addEventListener('click', event => {
    const control = /** @type {Element} */ (event.target).closest?.('button, a[href], [tabindex]');
    if (control instanceof HTMLElement && !container.contains(control)) pressed = control;
  }, { capture: true });
  const grouped = () => report?.connectors
    .some(each => each.id === id && each.members.some(member => member.panel === 'groups')) === true;
  onHomeChange(change => {
    if ((change.people || change.reset) && grouped()) void read();
  }, container);
  host?.follow(next => {
    state = next;
    if (id) draw();
  });
  window.addEventListener('focus', () => {
    if (id) void read();
  });
  /** @type {Set<string>} */
  const dropsDue = new Set();
  /** @type {Set<string>} */
  const dropsTaking = new Set();
  window.addEventListener('lifestream:dropped', async event => {
    const kind = /** @type {CustomEvent<{ kind?: string }>} */ (event).detail?.kind;
    if (!kind) return;
    dropsDue.add(kind);
    if (dropsTaking.has(kind)) return;
    dropsTaking.add(kind);
    try {
      while (dropsDue.delete(kind)) await run(JSON.stringify({ host: { act: 'import', do: 'dropped', kind } }));
    } finally {
      dropsTaking.delete(kind);
    }
  });

  return {
    get id() {
      return id;
    },
    view,
    run,
    said: dialogSaid,
    /** @param {() => void} listener */
    follow(listener) {
      listeners.add(listener);
    },
    /** @param {string} next */
    show(next) {
      if (next === routed) return;
      const { base, pages } = placeOf(next);
      if (id && base === id && !isSettings(next)) {
        routed = next;
        turnTo(pages);
        return;
      }
      routed = next;
      const from = id;
      const turning = isSettings(from) && isSettings(next) && settingsAt(next) !== null;
      if (!from) {
        const active = document.activeElement;
        opener = active instanceof HTMLElement && active !== document.body ? active : pressed;
      }
      id = base;
      opening += 1;
      scrolls = [];
      opened = { ...OPENED, pages, kept: new Set() };
      dates.clear();
      view.asking = '';
      container.hidden = !id;
      inert(id !== '');
      if (id) void read();
      focusing = id !== '' && !turning;
      draw();
      if (id) return;
      const row = [...document.querySelectorAll(`[data-cn-open="${CSS.escape(from)}"]`)]
        .find(each => each instanceof HTMLElement && each.offsetParent !== null);
      const same = opener && !opener.isConnected ? [...opener.attributes].find(each => each.name.startsWith('data-')) : null;
      const again = same ? [...document.querySelectorAll(`[${same.name}="${CSS.escape(same.value)}"]`)]
        .find(each => each instanceof HTMLElement && each.offsetParent !== null) : null;
      const back = row instanceof HTMLElement ? row
        : opener?.isConnected ? opener : again instanceof HTMLElement ? again : null;
      back?.focus();
      opener = null;
    },
    /** @param {string} flowId */
    flow(flowId) {
      if (!flowId) {
        if (!flow.id) return true;
        flow.close();
        const from = under;
        under = null;
        draw();
        const dialog = part('dialog').querySelector('.ck-dialog');
        if (dialog && from) {
          arrive(dialog, from.said);
          checkPanelTravel(dialog, from.here);
        }
        const next = /** @type {HTMLElement | null} */ (part('dialog').querySelector('.ck-chk.is-here .ck-btn')
          ?? part('dialog').querySelector('[data-cn-close]'));
        next?.focus();
        const account = then;
        then = '';
        const connector = report?.connectors.find(each => each.id === account);
        const signIn = connector ? signInOf(connector, state) ?? formDo(connector, state) : null;
        if (signIn) void run(JSON.stringify(signIn));
        return true;
      }
      if (!host || !id) return false;
      const asked = wanted;
      wanted = { then: '', make: false };
      const dialog = part('dialog').querySelector('.ck-dialog');
      under = dialog ? { here: checkPanelHere(dialog), said: arrivals(dialog) } : null;
      view.asking = '';
      const account = flowId === 'vault' ? asked.then : '';
      flow.open(/** @type {import('../flows/model.js').FlowId} */ (flowId), { then: asked.then, make: asked.make,
        onward: account ? () => {
          then = account;
          routes().flow('');
        } : null });
      focusFirst(part('dialog'));
      return true;
    },
    leaves: () => leavesBack(flow),
  };
}

/** @typedef {ReturnType<typeof streamDialogs>} StreamDialogs */
