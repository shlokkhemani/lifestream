// @ts-check
/** @import { ModelConnection, ModelFile, ModelUse } from '../../pages.js' */
/** @import { Models } from '../../lib/model-menu.js' */
/** @import { Flow, ModelItem } from '../flows/model.js' */
/** @import { HostAct } from '../../lib/host.js' */
/** @import { DetailPart, Menu, Opened, PanelRow } from './dialog.js' */
/** @import { Act, Do } from './words.js' */
import { foundPanels, modelChoices, panelOf, rowOf } from './dialog.js';
import { thingKey } from './pending.js';
import { panelPart, part } from './settings-pages.js';

export const MODEL_FIELDS = { key: 'openrouter', url: 'address.url' };

export const SUBSCRIPTIONS = /** @type {ModelItem[]} */ (['claude', 'chatgpt']);

export const MORE_PAGE = 'more:';

/** @param {HostAct} act @returns {Do} */
const asking = act => ({ host: act });

/**
 * @param {Opened} opened
 * @param {string} key
 */
const typed = (opened, key) => opened.fields?.[key] ?? '';

/**
 * @param {Opened} opened
 * @returns {HostAct | null}
 */
export function keyAct(opened) {
  const key = typed(opened, MODEL_FIELDS.key).trim();
  return key ? { act: 'seal', secret: 'openrouter', value: key } : null;
}

/**
 * @param {Opened} opened
 * @returns {HostAct | null}
 */
export function addressAct(opened) {
  const url = typed(opened, MODEL_FIELDS.url).trim();
  return url ? { act: 'models', do: 'address', url } : null;
}

/**
 * @param {ModelUse['use']} use
 * @param {string} model
 * @returns {HostAct}
 */
const defaultAct = (use, model) => ({ act: 'models', do: 'default', use, model });

/**
 * @param {Models} models
 * @param {ModelUse['use']} use
 * @returns {ModelUse | null}
 */
export const useOf = (models, use) => models.uses.find(each => each.use === use) ?? null;

/**
 * @param {ModelUse} use
 * @returns {Menu}
 */
function pickerOf(use) {
  return { id: `settings.use.${use.use}`, busy: thingKey({ kind: 'default', of: use.use }), label: use.label, words: use.words, find: '', date: null,
    choices: modelChoices(use.menu, value => asking(defaultAct(use.use, value)), { page: `${MORE_PAGE}${use.use}` }) };
}

/**
 * @param {Opened} opened
 * @returns {{ use: ModelUse['use'] } | null}
 */
export function usesFinding(opened) {
  const page = opened.pages.at(-1) ?? '';
  return page.startsWith(MORE_PAGE) ? { use: /** @type {ModelUse['use']} */ (page.slice(MORE_PAGE.length)) } : null;
}

/**
 * @param {Models | null} models
 * @param {Opened} opened
 * @param {boolean} acts
 * @returns {{ title: string, parts: DetailPart[] } | null}
 */
export function morePage(models, opened, acts) {
  const asked = usesFinding(opened);
  const use = asked && models ? useOf(models, asked.use) : null;
  if (!asked || !use) return null;
  return { title: use.menu.more.words, parts: foundPanels(opened.found ?? null, opened.typed, value => acts ? asking(defaultAct(use.use, value)) : null).map(panelPart) };
}

/**
 * @param {ModelUse} use
 * @param {boolean} acts
 * @returns {PanelRow | null}
 */
function thinkingRow(use, acts) {
  const { thinking, value } = use;
  if (!thinking || value === null) return null;
  if (!acts) return rowOf(thinking.label, { inset: true, end: { words: thinking.words } });
  return rowOf(thinking.label, { inset: true, end: { menu: { id: `settings.use.${use.use}.thinking`,
    busy: thingKey({ kind: 'default', of: use.use }), label: thinking.label, words: thinking.words, find: '', date: null,
    choices: thinking.levels.map(level => ({ words: level.name, note: '', chosen: level.chosen, default: level.suggested,
      do: asking({ act: 'models', do: 'default', use: use.use, model: value, thinking: level.value }) })) } } });
}

/**
 * @param {{ models: Models | null, failed: boolean, acts: boolean }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function defaultsParts({ models, failed, acts }) {
  if (!models) return { parts: [], reading: !failed };
  const acting = acts && !failed;
  const rows = models.uses.flatMap(use => {
    const row = rowOf(use.label, { line: use.line ?? '', working: use.working, end: acting ? { menu: pickerOf(use) } : { words: use.words } });
    const thinking = thinkingRow(use, acting);
    return thinking ? [row, thinking] : [row];
  });
  return { parts: [part({ rows })], reading: false };
}

/**
 * @param {string} unit
 * @param {ModelFile} file
 * @param {boolean} acts
 * @returns {PanelRow}
 */
export function fileRow(unit, file, acts) {
  const shown = acts ? file.acts.map(each => /** @type {Act} */ ({ label: each.words, variant: each.act === 'fetch' ? 'secondary' : 'plain',
    do: asking({ act: 'models', do: 'file', runner: unit, id: file.id, to: each.act === 'fetch' ? 'fetch' : 'remove' }) })) : [];
  const done = file.words !== null;
  return rowOf(file.name, { line: file.line, working: file.working, dim: !file.fits,
    end: shown.length ? { words: file.words ?? '', done, acts: shown } : done ? { words: file.words ?? '', done } : null });
}

/**
 * @param {NonNullable<Extract<ModelConnection, { kind: 'runner' }>['run']>} on
 * @param {boolean} acts
 * @param {HostAct} act
 * @returns {PanelRow}
 */
const switchRow = (on, acts, act) => rowOf(on.label, { line: on.line ?? '',
  end: acts ? { toggle: { on: on.on, label: on.label, do: asking(act) } } : { words: on.on ? 'On' : 'Off' } });

/**
 * @param {Extract<ModelConnection, { kind: 'runner' }>} runner
 * @param {boolean} acts
 * @returns {DetailPart[]}
 */
function runnerParts(runner, acts) {
  const { unit, run, battery } = runner;
  if (runner.none) return [part({ label: runner.place, rows: [rowOf(runner.none)] })];
  const rows = [
    ...run ? [switchRow(run, acts, { act: 'models', do: 'runner', runner: unit, to: run.on ? 'pause' : 'resume' })] : [],
    ...battery ? [switchRow(battery, acts, { act: 'models', do: 'battery', runner: unit, to: battery.on ? 'spend' : 'save' })] : [],
    ...runner.files.map(file => fileRow(unit, file, acts)),
  ];
  const from = [...new Set(runner.found.map(each => each.from))];
  return [part({ label: runner.place, line: runner.line ?? '', rows }), ...from.map(place => part({ label: place,
    rows: runner.found.filter(each => each.from === place).map(each => rowOf(each.name, { end: { words: each.size } })) }))];
}

/**
 * @param {Models} models
 * @param {Flow | null} flow
 * @param {boolean} acts
 * @param {Opened} opened
 * @returns {DetailPart[]}
 */
function accountsOf(models, flow, acts, opened) {
  const plans = flow ? [/** @type {DetailPart} */ ({ label: models.accounts, lines: [], panel: null, acts: [], flow })] : [];
  const rows = models.connections.flatMap(connection => {
    if (connection.kind === 'plan' && !flow) return [rowOf(connection.name, { line: connection.line ?? '', end: { words: connection.words, done: connection.signed } })];
    if (connection.kind !== 'key') return [];
    if (connection.held) {
      return [rowOf(connection.name, { line: connection.line ?? '', end: { words: connection.words ?? '', done: true,
        acts: acts ? [{ label: connection.key.remove, variant: 'plain', do: asking({ act: 'seal', secret: 'openrouter', value: null }) }] : [] } })];
    }
    const key = typed(opened, MODEL_FIELDS.key);
    return [rowOf(connection.name, { line: connection.line ?? '',
      end: acts ? { field: { key: MODEL_FIELDS.key, label: connection.key.label, kind: 'secret', value: key, placeholder: connection.key.placeholder },
        acts: [{ label: connection.key.add, variant: 'secondary', disabled: !key.trim(), do: { save: 'openrouter' } }] } : null })];
  });
  if (!rows.length) return plans;
  return plans.length ? plans.map(each => ({ ...each, panel: panelOf({ rows }) })) : [part({ label: models.accounts, rows })];
}

/**
 * @param {Models} models
 * @param {boolean} acts
 * @returns {DetailPart[]}
 */
function serverOf(models, acts) {
  const server = models.connections.find(each => each.kind === 'address');
  if (!server) return [];
  const { words } = server;
  const row = server.url
    ? rowOf(server.url, { line: words.about, only: server.line ?? '',
      end: acts ? { acts: [{ label: words.remove, variant: 'plain', do: asking({ act: 'models', do: 'address', none: true }) }] } : null })
    : rowOf(words.about, { end: acts ? { acts: [{ label: words.add, variant: 'secondary', do: { page: 'address' } }] } : null });
  return [part({ label: server.label, rows: [row] })];
}

/**
 * @param {{ models: Models | null, failed: boolean, subscriptions: Flow | null, acts: boolean, opened: Opened }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function providersParts({ models, failed, subscriptions, acts, opened }) {
  if (!models) {
    const plans = subscriptions ? [/** @type {DetailPart} */ ({ label: '', lines: [], panel: null, acts: [], flow: subscriptions })] : [];
    return { parts: plans, reading: !failed };
  }
  const acting = acts && !failed;
  const runners = models.connections.flatMap(each => each.kind === 'runner' ? runnerParts(each, acting) : []);
  return { parts: [...accountsOf(models, subscriptions, acting, opened), ...runners, ...serverOf(models, acting)], reading: false };
}

/**
 * @param {Models | null} models
 * @param {Opened} opened
 * @returns {DetailPart | null}
 */
export function addressPage(models, opened) {
  const server = models?.connections.find(each => each.kind === 'address');
  if (!server) return null;
  const { words } = server;
  return part({ label: server.label, line: words.about,
    acts: [{ label: words.save, variant: 'primary', disabled: addressAct(opened) === null, do: { save: 'address' } }],
    rows: [rowOf(words.field, { end: { field: { key: MODEL_FIELDS.url, label: words.field, kind: 'text', value: typed(opened, MODEL_FIELDS.url),
      placeholder: words.placeholder } } })] });
}
