// @ts-check
/** @import { ModelConnection, ModelFile, ModelFileAct, Models, ModelUse } from '../../pages.js' */
/** @import { Flow, ModelItem } from '../flows/model.js' */
/** @import { HostAct } from '../../lib/host.js' */
/** @import { DetailPart, Menu, Opened, PanelRow } from './dialog.js' */
/** @import { Act, Do } from './words.js' */
import { foundRows, modelChoices, rowOf } from './dialog.js';
import { thingKey } from './pending.js';
import { part } from './settings-pages.js';

export const MODEL_FIELDS = { key: 'openrouter', url: 'address.url' };

export const SUBSCRIPTIONS = /** @type {ModelItem[]} */ (['chatgpt', 'claude']);

export const MORE_PAGE = 'more:';

export const WORDS = {
  accounts: 'Accounts',
  uses: 'Uses',
  address: 'Custom address',
  addressLine: 'Any server that speaks the OpenAI API, such as Ollama or LM Studio. It lists its own models.',
  run: 'Turn off to hold their work until you turn it back on.',
  none: 'No models on this machine yet.',
  thinking: 'Thinking',
  thinkingLine: 'How long Chat’s model thinks before it answers.',
  key: 'Pay per call with your own key.',
};

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
  const found = foundRows(opened.found ?? null, value => acts ? asking(defaultAct(use.use, value)) : null);
  return { title: use.menu.more.words, parts: [
    part({ rows: found.rows, note: found.note, add: { placeholder: found.placeholder, typed: opened.typed, finds: [], lit: 0, enter: null, end: null } }),
    ...found.local ? [part({ label: found.local.label, rows: found.local.rows })] : [],
  ] };
}

/**
 * @param {ModelUse} use
 * @param {boolean} acts
 * @returns {PanelRow | null}
 */
function thinkingRow(use, acts) {
  const { thinking, value } = use;
  if (!thinking || value === null) return null;
  if (!acts) return rowOf(WORDS.thinking, { inset: true, line: WORDS.thinkingLine, end: { words: thinking.words } });
  return rowOf(WORDS.thinking, { inset: true, line: WORDS.thinkingLine, end: { menu: { id: `settings.use.${use.use}.thinking`,
    busy: thingKey({ kind: 'default', of: use.use }), label: WORDS.thinking, words: thinking.words, find: '', date: null,
    choices: thinking.levels.map(level => ({ words: level.name, note: '', chosen: level.chosen, default: level.suggested,
      do: asking({ act: 'models', do: 'default', use: use.use, model: value, thinking: level.value }) })) } } });
}

/**
 * @param {Models} models
 * @param {boolean} acts
 * @returns {DetailPart}
 */
function usesOf(models, acts) {
  const rows = models.uses.flatMap(use => {
    const row = rowOf(use.label, { line: use.line ?? '', end: acts ? { menu: pickerOf(use) } : { words: use.words } });
    const thinking = thinkingRow(use, acts);
    return thinking ? [row, thinking] : [row];
  });
  return part({ label: WORDS.uses, rows });
}

/** @type {Record<ModelFileAct, (file: ModelFile) => { label: string, to: 'fetch' | 'remove', look: Partial<Act> }>} */
const FILE_ACTS = {
  fetch: file => ({ label: file.state === 'failed' ? 'Try again' : 'Download', to: 'fetch', look: {} }),
  remove: () => ({ label: 'Remove', to: 'remove', look: { variant: 'plain' } }),
  cancel: () => ({ label: 'Cancel', to: 'remove', look: { variant: 'plain' } }),
};

/**
 * @param {string} unit
 * @param {ModelFile} file
 * @param {boolean} acts
 * @returns {PanelRow}
 */
export function fileRow(unit, file, acts) {
  const ready = file.state === 'ready';
  const shown = acts ? file.acts.map(each => FILE_ACTS[each](file)).map(({ label, to, look }) => /** @type {Act} */ ({ label,
    variant: 'secondary', ...look, do: asking({ act: 'models', do: 'file', runner: unit, id: file.id, to }) })) : [];
  const line = [file.size, file.about].filter(Boolean).join(' · ');
  return rowOf(file.name, { line, only: file.line ?? '', dim: !file.fits,
    end: shown.length ? { words: ready ? 'Downloaded' : '', done: ready, acts: shown } : ready ? { words: 'Downloaded', done: true } : null });
}

/**
 * @param {Extract<ModelConnection, { kind: 'runner' }>} runner
 * @param {boolean} acts
 * @returns {DetailPart[]}
 */
function runnerParts(runner, acts) {
  const { unit } = runner;
  const away = runner.line !== null && !runner.paused;
  const on = !runner.paused;
  const held = !away && (runner.paused || runner.files.some(file => file.state === 'ready'));
  const run = held ? [rowOf('Run models', { line: on ? WORDS.run : runner.line ?? '',
    end: acts ? { toggle: { on, label: 'Run models', do: asking({ act: 'models', do: 'runner', runner: unit, to: on ? 'pause' : 'resume' }) } }
      : { words: on ? 'On' : 'Off' } })] : [];
  const { battery } = runner;
  const saving = !away && battery ? [rowOf('Save battery', { line: battery.line,
    end: acts ? { toggle: { on: battery.on, label: 'Save battery', do: asking({ act: 'models', do: 'battery', runner: unit,
      to: battery.on ? 'spend' : 'save' }) } } : { words: battery.on ? 'On' : 'Off' } })] : [];
  const files = runner.files.map(file => fileRow(unit, file, acts && !away));
  const own = !files.length && !run.length ? part({ label: runner.place, rows: [rowOf(runner.line ?? WORDS.none)] })
    : part({ label: runner.place, line: away ? runner.line ?? '' : '', rows: [...run, ...saving, ...files] });
  const from = [...new Set(runner.found.map(each => each.from))];
  return [own, ...from.map(place => part({ label: place,
    rows: runner.found.filter(each => each.from === place).map(each => rowOf(each.name, { end: { words: each.size } })) }))];
}

/**
 * @param {ModelConnection[]} connections
 * @param {Flow | null} flow
 * @param {boolean} acts
 * @param {Opened} opened
 * @returns {DetailPart[]}
 */
function accountsOf(connections, flow, acts, opened) {
  const plans = flow ? [/** @type {DetailPart} */ ({ label: WORDS.accounts, lines: [], panel: null, acts: [], flow })] : [];
  const rows = connections.flatMap(connection => {
    if (connection.kind === 'plan' && !flow) {
      return [rowOf(connection.name, { line: connection.line ?? '', end: { words: connection.signed ? 'Signed in' : 'Not signed in',
        done: connection.signed } })];
    }
    if (connection.kind !== 'key') return [];
    const key = typed(opened, MODEL_FIELDS.key);
    if (connection.held) {
      return [rowOf(connection.name, { line: connection.line ?? WORDS.key, end: { words: 'Connected', done: true,
        acts: acts ? [{ label: 'Remove', variant: 'plain', do: asking({ act: 'seal', secret: 'openrouter', value: null }) }] : [] } })];
    }
    return [rowOf(connection.name, { line: connection.line ?? WORDS.key,
      end: acts ? { field: { key: MODEL_FIELDS.key, label: `${connection.name} key`, kind: 'secret', value: key, placeholder: 'sk-or-…' },
        acts: [{ label: 'Save', variant: 'secondary', disabled: !key.trim(), do: { save: 'openrouter' } }] } : { words: 'Not set' } })];
  });
  return rows.length ? [...plans, part({ label: plans.length ? '' : WORDS.accounts, rows })] : plans;
}

/**
 * @param {ModelConnection[]} connections
 * @param {boolean} acts
 * @returns {DetailPart[]}
 */
function addressOf(connections, acts) {
  const address = connections.find(each => each.kind === 'address');
  if (!address) return [];
  const row = address.url
    ? rowOf(address.url, { line: WORDS.addressLine, only: address.line ?? '',
      end: acts ? { acts: [{ label: 'Remove', variant: 'plain', do: asking({ act: 'models', do: 'address', none: true }) }] } : { words: 'Set' } })
    : rowOf(WORDS.address, { line: WORDS.addressLine, end: { words: 'Not set',
      acts: acts ? [{ label: 'Add address', variant: 'secondary', do: { page: 'address' } }] : [] } });
  return [part({ label: WORDS.address, rows: [row] })];
}

/**
 * @param {{ models: Models | null, failed: boolean, subscriptions: Flow | null, acts: boolean, opened: Opened }} read
 * @returns {{ parts: DetailPart[], reading: boolean }}
 */
export function modelsParts({ models, failed, subscriptions, acts, opened }) {
  if (!models) {
    const plans = subscriptions ? [/** @type {DetailPart} */ ({ label: WORDS.accounts, lines: [], panel: null, acts: [], flow: subscriptions })] : [];
    return { parts: plans, reading: !failed };
  }
  const acting = acts && !failed;
  const { connections } = models;
  const runners = connections.flatMap(each => each.kind === 'runner' ? runnerParts(each, acting) : []);
  return { parts: [...runners, ...accountsOf(connections, subscriptions, acting, opened), ...addressOf(connections, acting),
    usesOf(models, acting)], reading: false };
}

/**
 * @param {Opened} opened
 * @returns {DetailPart}
 */
export function addressPage(opened) {
  return part({ label: WORDS.address, line: WORDS.addressLine,
    acts: [{ label: 'Save', variant: 'primary', disabled: addressAct(opened) === null, do: { save: 'address' } }],
    rows: [rowOf('Address', { end: { field: { key: MODEL_FIELDS.url, label: 'Address', kind: 'text', value: typed(opened, MODEL_FIELDS.url),
      placeholder: 'http://127.0.0.1:11434/v1' } } })] });
}
