import { civilDay, dayBounds, type Counts, type DaySettings, type Json, type Level } from "@lifestreamprotocol/core";
import type { Conn } from "./ledger.js";

export const OUTBOUND_WHAT = ["ask", "read", "text", "link", "lookup", "feedback"] as const;
export type OutboundWhat = (typeof OUTBOUND_WHAT)[number];

export type OutboundRef = { source: string; kind: string; key: string } | { day: string };

export interface NewOutbound {
  at_ms: number;
  receiver: string;
  route: string | null;
  by: string | null;
  what: OutboundWhat;
  tool: string | null;
  level: Level;
  counts: Counts;
  chars: number;
  pictures: number;
  detector?: string | null;
  key: string | null;
  attempt: number | null;
  refs?: readonly OutboundRef[];
  call?: string | null;
}

export type OutboundAbout = "chat-voice";

const CHAT_VOICE = { family: "ai", prompt: "ask-voice" } as const;

export interface OutboundRow extends Omit<NewOutbound, "refs" | "detector" | "call"> {
  detector: string | null;
  seq: number;
  day: string;
  refs: number;
  about?: OutboundAbout;
}

export interface OutboundTotal {
  receiver: string;
  day: string;
  items: number;
  hidden: number;
  counts: Counts;
  rows: Partial<Record<OutboundWhat, number>>;
}

export interface OutboundList {
  rows: OutboundRow[];
  more: boolean;
  totals: OutboundTotal[];
}

export interface SentTo {
  receiver: string;
  days: string[];
  what: OutboundWhat[];
}

export interface OutboundLog {
  write(row: NewOutbound): number;
  once(row: NewOutbound & { key: string }): number;
  lookups(by: string, since_ms: number): number;
  list(query: { from: string; to: string; receiver?: string; before?: number; day: DaySettings }): OutboundList;
  row(seq: number, day: DaySettings): (Omit<OutboundRow, "refs"> & { refs: OutboundRef[]; sent: { body: string; pictures: Json[] } | null }) | undefined;
  carried(record: { source: string; kind: string; key: string }, day: DaySettings): OutboundRow[];
  asked(item: { family: string; item: string }, day: DaySettings): OutboundRow[];
  sentOf(thing: { records: readonly { source: string; kind: string; key: string }[]; items: readonly string[]; days: readonly string[] }, day: DaySettings): SentTo[];
}

const DAY_TEXT = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;

export const LIST_ROWS = 500;

const COLUMNS = "seq, at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt";

export function outboundOver(conn: Conn): {
  log: OutboundLog;
  insert(row: NewOutbound): number;
  forgetKeys(keys: Iterable<string>): void;
  forgetRecords(records: readonly { source: string; kind: string; key: string }[]): void;
} {
  const { sql, write } = conn;
  const insert = sql("INSERT INTO outbound (at_ms, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertRef = sql("INSERT INTO outbound_refs (outbound, source, kind, key, day) VALUES (?, ?, ?, ?, ?)");
  const insertCall = sql("INSERT INTO outbound_calls (outbound, call) SELECT ?, seq FROM calls WHERE id = ?");
  const refsOf = sql<{ source: string | null; kind: string | null; key: string | null; day: string | null }>("SELECT source, kind, key, day FROM outbound_refs WHERE outbound = ? ORDER BY rowid");
  const refCount = sql<{ n: number }>("SELECT count(*) AS n FROM outbound_refs WHERE outbound = ?");
  const bySeq = sql<Record<string, unknown>>(`SELECT ${COLUMNS} FROM outbound WHERE seq = ?`);
  const inRange = sql<Record<string, unknown>>(`SELECT ${COLUMNS} FROM outbound WHERE at_ms >= @from AND at_ms < @to AND (@receiver IS NULL OR receiver = @receiver) ORDER BY seq DESC`);
  const page = sql<Record<string, unknown>>(`SELECT ${COLUMNS} FROM outbound WHERE at_ms >= @from AND at_ms < @to AND (@receiver IS NULL OR receiver = @receiver) AND seq < @before ORDER BY seq DESC LIMIT @limit`);
  const lookupsBy = sql<{ n: number }>("SELECT count(*) AS n FROM outbound WHERE at_ms >= ? AND what = 'lookup' AND by = ?");
  const nullKey = sql("UPDATE outbound SET key = NULL WHERE key = ?");
  const keyed = sql<{ seq: number }>("SELECT seq FROM outbound WHERE key = ? ORDER BY seq LIMIT 1");
  const dropRefs = sql("DELETE FROM outbound_refs WHERE source = ? AND kind = ? AND key = ?");
  const bodyOf = sql<{ body: string }>("SELECT body FROM requests WHERE key = ?");
  const copyOf = sql<{ body: string; pictures: string }>("SELECT s.body, s.pictures FROM attempt_copies c JOIN sent_copies s ON s.id = c.copy WHERE c.attempt = ? AND s.body IS NOT NULL");
  type Found = { seq: number; at_ms: number; receiver: string; what: OutboundWhat };
  const byRecord = sql<Found>("SELECT o.seq, o.at_ms, o.receiver, o.what FROM outbound_refs r JOIN outbound o ON o.seq = r.outbound WHERE r.source = ? AND r.kind = ? AND r.key = ?");
  const byDay = sql<Found>("SELECT o.seq, o.at_ms, o.receiver, o.what FROM outbound_refs r JOIN outbound o ON o.seq = r.outbound WHERE r.day = ?");
  const carriedBy = sql<Record<string, unknown>>(`SELECT ${COLUMNS} FROM outbound WHERE seq IN (SELECT outbound FROM outbound_refs WHERE source = ? AND kind = ? AND key = ?) ORDER BY seq DESC LIMIT ?`);
  const askedFor = sql<Record<string, unknown>>(`SELECT ${COLUMNS} FROM outbound WHERE what = 'ask' AND key IN (SELECT key FROM requests WHERE family = ? AND unit = ?) ORDER BY seq DESC LIMIT ?`);
  const byItem = sql<Found>("SELECT o.seq, o.at_ms, o.receiver, o.what FROM requests q JOIN outbound o ON o.key = q.key WHERE q.unit = ?");
  const chatVoice = sql<{ one: number }>("SELECT 1 AS one FROM requests WHERE key = ? AND family = ? AND prompt = ?");

  const insertRow = (row: NewOutbound): number => {
    if (!OUTBOUND_WHAT.includes(row.what)) throw new TypeError(`${JSON.stringify(row.what)} is no outbound row's what`);
    const seq = Number(insert.run(row.at_ms, row.receiver, row.route, row.by, row.what, row.tool, levelText(row.level), JSON.stringify(row.counts), row.chars, row.pictures, row.detector ?? null, row.key, row.attempt).lastInsertRowid);
    for (const ref of row.refs ?? []) {
      if ("day" in ref) insertRef.run(seq, null, null, null, ref.day);
      else insertRef.run(seq, ref.source, ref.kind, ref.key, null);
    }
    if (row.call !== undefined && row.call !== null && insertCall.run(seq, row.call).changes === 0) throw new TypeError(`${JSON.stringify(row.call)} is no call of the ledger`);
    return seq;
  };

  const rowOf = (row: Record<string, unknown>, day: DaySettings) => ({
    seq: Number(row.seq), at_ms: Number(row.at_ms), day: civilDay(Number(row.at_ms), day), receiver: String(row.receiver),
    route: nullable(row.route), by: nullable(row.by), what: row.what as OutboundWhat, tool: nullable(row.tool), level: levelOf(String(row.level)),
    counts: JSON.parse(String(row.counts)) as Counts, chars: Number(row.chars), pictures: Number(row.pictures), detector: nullable(row.detector), key: nullable(row.key),
    attempt: row.attempt === null ? null : Number(row.attempt),
  });

  const listed = (row: Record<string, unknown>, day: DaySettings): OutboundRow => {
    const read = rowOf(row, day);
    return { ...read, refs: refCount.get(read.seq)!.n, ...aboutOf(read) };
  };
  const aboutOf = (read: { what: OutboundWhat; key: string | null }): { about?: OutboundAbout } =>
    read.what === "ask" && read.key !== null && chatVoice.get(read.key, CHAT_VOICE.family, CHAT_VOICE.prompt) !== undefined ? { about: "chat-voice" } : {};

  const log: OutboundLog = {
    write: (row) => write(() => insertRow(row)),

    once: (row) => write(() => keyed.get(row.key)?.seq ?? insertRow(row)),

    lookups: (by, since_ms) => lookupsBy.get(since_ms, by)!.n,

    list({ from, to, receiver, before, day }) {
      for (const each of [from, to]) if (!DAY_TEXT.test(each)) throw new RangeError(`a day is YYYY-MM-DD, not ${JSON.stringify(each)}`);
      if (from > to) throw new RangeError(`the range runs from ${from} to ${to}: its first day is after its last`);
      const range = { from: dayBounds(from, day).start_ms, to: dayBounds(to, day).end_ms, receiver: receiver ?? null };
      const answered = page.all({ ...range, before: before ?? Number.MAX_SAFE_INTEGER, limit: LIST_ROWS + 1 });
      const rows = answered.slice(0, LIST_ROWS).map((row) => listed(row, day));
      const totals = new Map<string, OutboundTotal & { requests: Set<string> }>();
      for (const row of inRange.iterate(range)) {
        const read = rowOf(row, day);
        const at = `${read.day}\u0000${read.receiver}`;
        let total = totals.get(at);
        if (total === undefined) {
          total = { receiver: read.receiver, day: read.day, items: 0, hidden: 0, counts: {}, rows: {}, requests: new Set() };
          totals.set(at, total);
        }
        total.rows[read.what] = (total.rows[read.what] ?? 0) + 1;
        if (read.what !== "ask" || read.key === null) total.items += 1;
        else if (!total.requests.has(read.key)) {
          total.requests.add(read.key);
          total.items += 1;
        }
        if (read.what === "lookup") continue;
        for (const [type, count] of Object.entries(read.counts) as [keyof Counts, number][]) {
          total.counts[type] = (total.counts[type] ?? 0) + count;
          total.hidden += count;
        }
      }
      return {
        rows, more: answered.length > LIST_ROWS,
        totals: [...totals.values()].map(({ requests: _, ...total }) => total).sort((left, right) => right.day.localeCompare(left.day) || left.receiver.localeCompare(right.receiver)),
      };
    },

    row(seq, day) {
      const row = bySeq.get(seq);
      if (row === undefined) return undefined;
      const refs = refsOf.all(seq).map((ref): OutboundRef => (ref.day !== null ? { day: ref.day } : { source: ref.source!, kind: ref.kind!, key: ref.key! }));
      const plain = rowOf(row, day);
      const read = { ...plain, ...aboutOf(plain) };
      if (read.what !== "ask" || read.key === null) return { ...read, refs, sent: null };
      if (read.level === "none") {
        const body = bodyOf.get(read.key)?.body;
        return { ...read, refs, sent: body === undefined ? null : { body, pictures: [] } };
      }
      const copy = read.attempt === null ? undefined : copyOf.get(read.attempt);
      return { ...read, refs, sent: copy === undefined ? null : { body: copy.body, pictures: JSON.parse(copy.pictures) as Json[] } };
    },

    carried(record, day) {
      return carriedBy.all(record.source, record.kind, record.key, LIST_ROWS).map((row) => listed(row, day));
    },

    asked({ family, item }, day) {
      return askedFor.all(family, item, LIST_ROWS).map((row) => listed(row, day));
    },

    sentOf({ records, items, days }, day) {
      const rows = new Map<number, { at_ms: number; receiver: string; what: OutboundWhat }>();
      const take = (found: Found[]) => {
        for (const { seq, ...row } of found) rows.set(seq, row);
      };
      for (const record of records) take(byRecord.all(record.source, record.kind, record.key));
      for (const each of days) take(byDay.all(each));
      for (const item of new Set(items)) take(byItem.all(item));
      const receivers = new Map<string, { days: Set<string>; what: Set<OutboundWhat> }>();
      for (const row of rows.values()) {
        const to = receivers.get(row.receiver) ?? { days: new Set(), what: new Set() };
        to.days.add(civilDay(row.at_ms, day));
        to.what.add(row.what);
        receivers.set(row.receiver, to);
      }
      return [...receivers].sort(([left], [right]) => left.localeCompare(right)).map(([receiver, to]) => ({
        receiver, days: [...to.days].sort(), what: OUTBOUND_WHAT.filter((what) => to.what.has(what)),
      }));
    },
  };

  return {
    log,
    insert: insertRow,
    forgetKeys(keys) {
      for (const key of keys) nullKey.run(key);
    },
    forgetRecords(records) {
      for (const record of records) dropRefs.run(record.source, record.kind, record.key);
    },
  };
}

function levelText(level: Level): string {
  return typeof level === "string" ? level : JSON.stringify(level);
}

function levelOf(text: string): Level {
  return text.startsWith("[") ? JSON.parse(text) as Level : text as Level;
}

function nullable(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
