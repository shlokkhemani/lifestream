import {
  daysOf, digest, GONE, handleId, handleOf, phoneOfJid,
  type CallsAdapter, type DaySettings, type ExtractRow, type Json, type MessagesAdapter, type RecordRef, type Version, type View,
} from "@lifestreamprotocol/core";
import { factId, OPS, type Change, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type Extracted, type Family, type FamilyInput, type Given, type Labels, type Touched } from "../family.js";
import { chatTitle, joined, nameId, nameParty, printed, type Named, type Party, type Printed, type Printable } from "../shared/cast.js";
import { labelInputs, type Books } from "../shared/labels.js";
import { networksOf, resolveChat, type Networks } from "../messages/networks.js";
import { chooseReplicas } from "../shared/replicas.js";
import { recordRead, recordText } from "../shared/text.js";

export const CALLS_FAMILY = "calls";

export interface Call {
  source: string;
  service: string;
  direction: "incoming" | "outgoing";
  outcome: "connected" | "missed" | "not-connected";
  start_ms: number;
  end_ms: number | null;
  parties: Party[];
  group?: string;
}

export interface CallsSettings extends Books {
  readonly messages: readonly Given<MessagesAdapter>[];
}

export function callsFamily(settings: CallsSettings): (given: readonly Given<CallsAdapter>[]) => Family {
  return (given) => callsOver(settings, given);
}

function callsOver(settings: CallsSettings, given: readonly Given<CallsAdapter>[]): Family {
  const networks = networksOf(settings.messages);
  const byNetwork = new Map(given.map((each) => [each.adapter.network ?? each.product, each]));
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const reading = callsReading(given);
  const inputs: FamilyInput[] = [
    ...given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    ...labelInputs(settings),
  ];
  const readCall = (record: RecordRef, version: Version, view: View) => {
    const row = view.source(record.source);
    const fed = row === undefined ? undefined : byProduct.get(row.product);
    const call = row === undefined || fed === undefined ? null : callOf(record.source, fed.adapter.call({ source: row, version }));
    if (call === null) return null;
    const ids = call.parties.map((party) => party.id);
    const shown = call.parties.find((party) => party.provider !== undefined && party.provider !== null)?.provider;
    return { call, services: fed!.adapter.services, ids, title: shown ?? (ids.length > 0 ? ids.join(", ") : call.group) };
  };
  return {
    name: CALLS_FAMILY,
    adapters: given,
    borrowed: { messages: settings.messages },
    type: "calls",
    code: `3:${digest(Object.fromEntries([...byNetwork].map(([network, each]) => [network, each.adapter.services])))}`,
    inputs,

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const unit = reading.unitOf(view, change.record);
        return unit === null ? [] : [{ unit }];
      });
    },

    extract(unit: string, view: View): Extracted | null {
      const call = reading.call(view, unit);
      if (call === null) return null;
      return { content: call as unknown as Json, start_ms: call.start_ms, end_ms: call.end_ms ?? call.start_ms, reading: digest(call as unknown as Json) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (extract.start_ms === null) return [];
      return daysOf({ start_ms: extract.start_ms, end_ms: (extract.end_ms ?? extract.start_ms) + 1, precision: "ms" }, settings);
    },

    day(input: DayInput): DayProjection {
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const extract of input.extracts) {
        const call = extract.content as unknown as Call;
        const colon = extract.unit.indexOf(":");
        const services = byNetwork.get(extract.unit.slice(0, colon))?.adapter.services ?? {};
        const record = callRecord(extract.unit, call);
        const line = lines.push({
          family: CALLS_FAMILY, unit: extract.unit, units: [extract.unit], start_ms: call.start_ms, end_ms: call.end_ms,
          ...callWords(call, services, input.labels),
          record,
        }) - 1;
        facts.push(callFact(extract.unit, call, record, line, callChat(networks, extract.unit.slice(0, colon), call, input.labels)));
      }
      return { lines, facts };
    },
    collections: CALLS_COLLECTIONS,

    text: {
      version: "1",
      kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))],
      of(record, version, _files, view) {
        const got = readCall(record, version, view);
        return got === null ? null : recordText({ title: got.title, who: got.ids });
      },
    },

    read: {
      of(record, version, _files, view) {
        const got = readCall(record, version, view);
        if (got === null) return null;
        const text = callLine(got.call, got.services, got.call.parties.map((party) => phoneOfJid(party.id) ?? party.id), got.call.group).text;
        if (got.call.direction === "outgoing") return recordRead({ title: got.title, text, from: null, to: got.ids });
        return got.ids.length === 1 ? recordRead({ title: got.title, text, from: got.ids[0]! }) : recordRead({ title: got.title, text, who: got.ids });
      },
    },
  };
}

export interface CallReading {
  readonly products: readonly string[];
  readonly kinds: readonly string[];
  unitOf(view: View, record: RecordRef): string | null;
  call(view: View, unit: string): Call | null;
  overlapping(view: View, start_ms: number, end_ms: number): { unit: string; call: Call }[];
}

export function callsReading(given: readonly Given<CallsAdapter>[]): CallReading {
  const byNetwork = new Map(given.map((each) => [each.adapter.network ?? each.product, each]));
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const unitOf = (view: View, record: RecordRef): string | null => {
    const row = view.source(record.source);
    const fed = row === undefined ? undefined : byProduct.get(row.product);
    return fed === undefined || !fed.adapter.kinds.includes(record.kind) ? null : `${fed.adapter.network ?? fed.product}:${record.key}`;
  };
  const call = (view: View, unit: string): Call | null => {
    const colon = unit.indexOf(":");
    const fed = byNetwork.get(unit.slice(0, colon));
    if (fed === undefined) return null;
    const key = unit.slice(colon + 1);
    const replicas = view.sources({ product: [fed.product] }).flatMap((source) => fed.adapter.kinds.flatMap((kind) => {
      const head = view.head({ source: source.id, kind, key });
      const version = head === undefined || head.version === GONE ? undefined : view.version(head.version);
      const read = version === undefined ? null : callOf(source.id, fed.adapter.call({ source, version }));
      return read === null ? [] : [read];
    }));
    return chooseReplicas(replicas, { same: () => unit, id: (each) => each.source })[0]?.chosen ?? null;
  };
  return {
    products: given.map((each) => each.product),
    kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))].sort(),
    unitOf,
    call,
    overlapping(view, start_ms, end_ms) {
      const units = new Set<string>();
      for (const source of view.sources({ product: given.map((each) => each.product) })) {
        for (const kind of byProduct.get(source.product)!.adapter.kinds) {
          for (const head of view.heads(source.id, kind, { start_ms, end_ms })) {
            const unit = unitOf(view, { source: source.id, kind, key: head.key });
            if (unit !== null) units.add(unit);
          }
        }
      }
      return [...units].sort().flatMap((unit) => {
        const read = call(view, unit);
        return read === null ? [] : [{ unit, call: read }];
      });
    },
  };
}

export function callRecord(unit: string, call: Call): RecordRef {
  return { source: call.source, kind: "call", key: unit.slice(unit.indexOf(":") + 1) };
}

export function callHandles(call: Pick<Call, "parties">): string[] {
  return [...new Set(call.parties.map((party) => {
    const handle = handleOf(party.id, party.network);
    return handle === null ? party.id : handleId(handle);
  }))].sort();
}

export function partyName(party: Party, labels: Labels): Named {
  return party.kind === "jid" ? nameId(party.id, labels, "jid") : nameParty(party, labels);
}

export const CALLS_COLLECTIONS: Readonly<Record<string, Collection>> = {
  calls: {
    keys: ["service", "direction", "outcome", "group", "chat"],
    measures: { minutes: { unit: "min", ops: OPS, time: "start", split: "clock", readings: ["callaudio.minutes"], from: "derived" } },
  },
};

export function callChat(networks: Networks, network: string, call: Pick<Call, "group" | "parties">, labels: Labels): string | undefined {
  const adapter = networks.of(network);
  if (adapter === undefined) return undefined;
  const [party, ...more] = call.parties;
  const alone = party !== undefined && more.length === 0 && !adapter.group(party.id) ? adapter.members(party.id) : [];
  const id = call.group ?? (alone.length === 1 && alone[0]!.id === party!.id ? party!.id : undefined);
  return id === undefined ? undefined : `${network}:${resolveChat(networks, network, id, labels)}`;
}

function callFact(unit: string, call: Call, record: { source: string; kind: string; key: string }, line: number, chat: string | undefined): DayFact {
  const role = call.direction === "outgoing" ? "receiver" : "sender";
  const handles = callHandles(call);
  return {
    of: "calls", id: factId("calls", unit), time_ms: call.start_ms, start_ms: call.start_ms, end_ms: call.end_ms ?? call.start_ms,
    keys: {
      service: call.service, direction: call.direction, outcome: call.outcome,
      ...(call.group === undefined ? {} : { group: call.group }), ...(chat === undefined ? {} : { chat }),
    },
    measures: call.end_ms === null ? {} : { minutes: (call.end_ms - call.start_ms) / 60_000 },
    who: handles.map((handle) => ({ handle, role })), from: { units: [unit], record, alone: true }, lines: [line],
  };
}

function callOf(source: string, said: ReturnType<CallsAdapter["call"]>): Call | null {
  return said === null ? null : { source, ...said };
}

function callWords(call: Call, services: Readonly<Record<string, string>>, labels: Labels): Printed {
  const names = call.parties.map((party) => partyName(party, labels));
  const group = call.group === undefined ? undefined : chatTitle({ id: call.group, group: true, name: labels.provider?.(call.group)?.name ?? null }, names);
  return callLine(call, services, names, group);
}

function callLine(call: Call, services: Readonly<Record<string, string>>, parties: readonly Printable[], group?: Printable): Printed {
  const where: Printable = group === undefined ? "" : printed` in ${group}`;
  const who: Printable | null = parties.length > 0 ? joined(parties, ", ") : group === undefined ? "an unknown number" : null;
  const party = (preposition: string) => printed`${who === null ? "" : printed` ${preposition} ${who}`}${where}`;
  const service = services[call.service] ?? "Call";
  const outgoing = call.direction === "outgoing";
  if (call.outcome === "missed") return printed`Missed ${service.startsWith("Phone") ? "phone call" : service}${party("from")}`;
  if (call.outcome === "not-connected") return printed`${service}${party(outgoing ? "to" : "from")}, ${outgoing ? "no answer" : "not answered"}`;
  const seconds = call.end_ms === null ? null : Math.round((call.end_ms - call.start_ms) / 1000);
  return printed`${service}${party("with")}, ${outgoing ? "the user called" : "they called"}, ${seconds === null ? "answered" : length(seconds)}`;
}

function length(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
