// @ts-check
/** @import { HostAct, HostReply } from '../../lib/host.js' */
/** @import { StreamsReport } from '../../types.js' */
/** @import { ModelConnection, ModelUseId } from '../../pages.js' */
/** @import { Models } from '../../lib/model-menu.js' */
import { settingKey } from './view.js';

export const OFF = 'none';

/** @typedef {{ report: StreamsReport | null, models: Models | null, hiding: string | null }} Reads */

/** @typedef {{ kind: 'file', runner: string, id: string } | { kind: 'pause', runner: string } | { kind: 'battery', runner: string } | { kind: 'default', of: ModelUseId } | { kind: 'address' } | { kind: 'openrouter' }} Thing */

/** @typedef {{ key: string, source: 'report', connector: string, member: string, before: StreamsReport | null, landed: string | null }} Settling */

/** @typedef {Settling | { key: string, source: 'models', thing: Thing, was: string, sent: string }} Pending */

/** @param {unknown} value */
const canonical = value => JSON.stringify(value, (_key, each) => each && typeof each === 'object' && !Array.isArray(each)
  ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => a.localeCompare(b))) : each) ?? 'null';

/**
 * @param {HostAct} act
 * @returns {{ thing: Thing, sent: string } | null}
 */
function thingOf(act) {
  if (act.act === 'models') {
    if (act.do === 'default') return { thing: { kind: 'default', of: act.use }, sent: canonical(act.model === OFF ? null : act.model) };
    if (act.do === 'file') return { thing: { kind: 'file', runner: act.runner, id: act.id }, sent: canonical(act.to === 'fetch' ? 'fetching' : 'absent') };
    if (act.do === 'runner') return { thing: { kind: 'pause', runner: act.runner }, sent: canonical(act.to === 'pause') };
    if (act.do === 'battery') return { thing: { kind: 'battery', runner: act.runner }, sent: canonical(act.to === 'save') };
    return { thing: { kind: 'address' }, sent: canonical('none' in act ? null : act.url) };
  }
  if (act.act === 'seal' && 'secret' in act && act.secret === 'openrouter') return { thing: { kind: 'openrouter' }, sent: canonical(act.value !== null) };
  return null;
}

/**
 * @param {HostAct} act
 * @returns {string | null}
 */
export function keyOf(act) {
  if (act.act === 'setting') return settingKey(act.connector, act.member);
  if (act.act === 'home-setting') return homeSettingKey('settings' in act ? Object.keys(act.settings).sort().join('+') : act.key);
  if (act.act === 'upload') return `upload:${act.connector}`;
  const changed = thingOf(act);
  return changed ? thingKey(changed.thing) : null;
}

/**
 * @param {HostAct} act
 * @param {string | null} hiding
 */
const isHidingFile = (act, hiding) => act.act === 'models' && act.do === 'file' && hiding !== null && act.id === hiding;

/**
 * @param {HostAct} act
 * @param {string | null} hiding
 */
export const movesPrivacy = (act, hiding) => (act.act === 'home-setting'
  && ('settings' in act ? Object.keys(act.settings) : [act.key]).some(key => key.startsWith('privacy.'))) || isHidingFile(act, hiding)
  || (act.act === 'models' && act.do === 'default' && act.use === 'hiding');

/** @param {HostAct} act */
export const movesMeaning = act => (act.act === 'home-setting' && 'settings' in act
  && Object.keys(act.settings).some(key => key.startsWith('search.meaning'))) || (act.act === 'models' && act.do === 'default' && act.use === 'search');

/** @param {string} key */
export function homeSettingKey(key) { return `home-setting:${key}`; }

/** @param {Thing} thing */
export const thingKey = thing => JSON.stringify(thing);

/**
 * @param {HostAct} act
 * @param {{ connector: string, member: string } | null} [holds]
 */
export const actKey = (act, holds = null) => holds ? settingKey(holds.connector, holds.member)
  : keyOf(act) ?? JSON.stringify(act);

/**
 * @param {Thing} thing
 * @param {Reads} reads
 * @returns {string | undefined}
 */
function valueAt(thing, { models }) {
  if (!models) return undefined;
  const { connections } = models;
  if (thing.kind === 'openrouter') return canonical(connections.some(each => each.kind === 'key' && each.held));
  if (thing.kind === 'address') return canonical(connections.find(each => each.kind === 'address')?.url ?? null);
  if (thing.kind === 'default') return canonical(models.uses.find(each => each.use === thing.of)?.value ?? null);
  const held = connections.find(/** @returns {each is Extract<ModelConnection, { kind: 'runner' }>} */ each => each.kind === 'runner'
    && each.unit === thing.runner);
  if (thing.kind === 'pause') return canonical(held?.paused ?? false);
  if (thing.kind === 'battery') return canonical(held?.battery?.on ?? null);
  return canonical(held && (held.paused || held.line === null) ? held.files.find(each => each.id === thing.id)?.state ?? 'absent' : 'away');
}

/** @param {StreamsReport | null} report @param {string} connector @param {string} member */
const valueOf = (report, connector, member) =>
  report?.connectors.find(each => each.id === connector)?.members.find(each => each.key === member)?.value ?? null;

/**
 * @param {Pending} pending
 * @param {HostReply} reply
 * @returns {Pending}
 */
export const landedOf = (pending, reply) => pending.source === 'report' && reply.landed
  ? { ...pending, landed: canonical(reply.landed.value) } : pending;

/**
 * @param {HostAct} act
 * @param {Reads} reads
 * @param {{ connector: string, member: string } | null} [holds]
 * @returns {Pending | null}
 */
export function pendingOf(act, reads, holds = null) {
  const key = actKey(act, holds);
  const held = holds ?? (act.act === 'setting' ? act : null);
  if (held) return { key, source: 'report', connector: held.connector, member: held.member, before: reads.report, landed: null };
  const changed = isHidingFile(act, reads.hiding) ? null : thingOf(act);
  if (!changed) return null;
  return { key, source: 'models', thing: changed.thing, was: valueAt(changed.thing, reads) ?? 'null', sent: changed.sent };
}

/**
 * @param {Pending} pending
 * @param {Reads} reads
 */
export function settled(pending, reads) {
  if (pending.source === 'report') {
    return reads.report !== null && (pending.landed === null ? reads.report !== pending.before
      : canonical(valueOf(reads.report, pending.connector, pending.member)) === pending.landed);
  }
  const now = valueAt(pending.thing, reads);
  return now !== undefined && (now === pending.sent || now !== pending.was);
}
