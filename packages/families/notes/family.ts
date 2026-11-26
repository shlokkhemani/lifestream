import {
  daysOf, digest, GONE, isObject, textHead,
  type DaySettings, type ExtractRow, type Instant, type Json, type Meeting as MeetingRead, type Note as NoteRead, type NotesAdapter, type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { factId, OPS, type Change, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type Extracted, type Family, type FamilyInput, type Given, type RecordRead, type RecordText, type Touched } from "../family.js";
import { count, recordRead, recordText } from "../shared/text.js";

export const NOTES_FAMILY = "notes";
export const LINE_PEOPLE = 6;
export const LINE_CHARS = 1000;
const MARKER = /^\s*(?:\[[x ]\]|-|\d+\.)(?: |$)/u;

export interface Note {
  [member: string]: Json;
  source: string;
  key: string;
  title: string;
  locked: boolean;
  trashed: boolean;
  start_ms: number;
  end_ms: number | null;
  excerpt: string;
  words: number;
}

export interface Meeting {
  [member: string]: Json;
  product: string;
  source: string;
  key: string;
  title: string;
  people: string[];
  start_ms: number;
  end_ms: number | null;
}

interface Read {
  source: string;
  read: NoteRead | MeetingRead;
  time: Instant | undefined;
}

export function notesFamily(given: readonly Given<NotesAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each.adapter]));
  const adapterOf = (source: SourceRow | undefined, kind: string): NotesAdapter | undefined => {
    const adapter = source === undefined ? undefined : byProduct.get(source.product);
    return adapter?.kinds.includes(kind) === true ? adapter : undefined;
  };
  const inputs: FamilyInput[] = given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" }));

  return {
    name: NOTES_FAMILY,
    type: "notes",
    code: "3",
    inputs,

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const source = view.source(change.record.source);
        return adapterOf(source, change.record.kind) === undefined ? [] : [{ unit: `${source!.product}:${source!.account}/${change.record.key}` }];
      });
    },

    extract(unit: string, view: View): Extracted | null {
      const parsed = parseUnit(unit);
      const adapter = parsed === null ? undefined : byProduct.get(parsed.product);
      if (parsed === null || adapter === undefined) return null;
      const copies = view.sources({ product: [parsed.product] }).filter((source) => source.account === parsed.account).flatMap((source): Read[] => {
        return adapter.kinds.flatMap((kind) => {
          const head = view.head({ source: source.id, kind, key: parsed.key });
          const version = head === undefined || head.version === GONE ? undefined : view.version(head.version);
          const read = version === undefined ? null : adapter.note({ source, version });
          return read === null ? [] : [{ source: source.id, read, time: version!.time }];
        });
      }).filter((copy) => copy.time !== undefined);
      const shown = copies.sort((left, right) => (adapter.copies === "edited-last" ? edited(right.time!) - edited(left.time!) : 0) || compare(left.source, right.source))[0];
      if (shown === undefined) return null;
      const time = shown.time!;
      if (shown.read.shape === "meeting") {
        const meeting: Meeting = {
          product: parsed.product, source: shown.source, key: parsed.key, title: shown.read.title, people: [...shown.read.people], start_ms: time.start_ms, end_ms: time.end_ms ?? null,
        };
        return { content: meeting, start_ms: meeting.start_ms, end_ms: meeting.end_ms, reading: digest(meeting) };
      }
      if (shown.read.marked) return null;
      const note = noteOf(shown.source, parsed.key, shown.read, time);
      return { content: note, start_ms: note.start_ms, end_ms: note.end_ms, reading: digest(note) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (isMeeting(extract.content)) return daysOf(at(extract.content.start_ms), settings);
      const note = extract.content as Note;
      return [...new Set([note.start_ms, note.end_ms].flatMap((time) => (time === null ? [] : daysOf(at(time), settings))))].sort();
    },

    text: {
      version: "2",
      kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))].sort(),
      of(record, version, _files, view): RecordText | null {
        const source = view.source(record.source);
        const read = adapterOf(source, record.kind)?.note({ source: source!, version }) ?? null;
        if (read === null) return null;
        if (read.shape === "meeting") return recordText({ title: read.title, text: read.words.join("\n\n"), who: read.emails });
        return read.marked ? null : recordText({ title: read.title, text: read.text });
      },
    },

    read: {
      of(record, version, _files, view): RecordRead | null {
        const source = view.source(record.source);
        const read = adapterOf(source, record.kind)?.note({ source: source!, version }) ?? null;
        if (read === null) return null;
        if (read.shape === "meeting") return recordRead({ title: read.title, text: read.words.join("\n\n"), who: read.emails });
        return read.marked ? null : recordRead({ title: read.title, text: read.text });
      },
    },

    day(input: DayInput): DayProjection {
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const extract of input.extracts) {
        const kind = kindOf(extract.unit);
        if (isMeeting(extract.content)) {
          const meeting = extract.content;
          if (!daysOf(at(meeting.start_ms), input.settings).includes(input.day)) continue;
          const record = { source: meeting.source, kind, key: meeting.key };
          const line = lines.push({ family: NOTES_FAMILY, unit: extract.unit, units: [extract.unit], start_ms: meeting.start_ms, end_ms: meeting.end_ms, text: meetingLine(meeting), record }) - 1;
          facts.push({
            of: "meetings", id: factId("meetings", extract.unit), time_ms: meeting.start_ms, start_ms: meeting.start_ms, end_ms: meeting.end_ms ?? meeting.start_ms,
            keys: { title: meeting.title }, measures: meeting.end_ms === null ? {} : { minutes: (meeting.end_ms - meeting.start_ms) / 60_000 },
            who: [], from: { units: [extract.unit], record, alone: true }, lines: [line],
          });
          continue;
        }
        const note = extract.content as Note;
        const on = (time: number) => daysOf(at(time), input.settings).includes(input.day);
        const line = (start_ms: number, end_ms: number | null, verb: string, withWords: boolean): DayLine => ({
          family: NOTES_FAMILY, unit: extract.unit, units: [extract.unit], start_ms, end_ms, text: noteText(note, verb, withWords), record: { source: note.source, kind, key: note.key },
        });
        if (note.end_ms === null) lines.push(...(on(note.start_ms) ? [line(note.start_ms, null, "written", true)] : []));
        else if (on(note.start_ms) && on(note.end_ms)) lines.push(line(note.start_ms, note.end_ms, "written", true));
        else lines.push(...(on(note.start_ms) ? [line(note.start_ms, null, "created", false)] : []), ...(on(note.end_ms) ? [line(note.end_ms, null, "edited", true)] : []));
      }
      return { lines, facts };
    },
    collections: NOTES_COLLECTIONS,
  };

  function kindOf(unit: string): string {
    const product = parseUnit(unit)?.product;
    return (product === undefined ? undefined : byProduct.get(product)?.kinds[0]) ?? "note";
  }
}

export const NOTES_COLLECTIONS: Readonly<Record<string, Collection>> = {
  meetings: {
    keys: ["title"],
    measures: { minutes: { unit: "min", ops: OPS, time: "start", split: "whole", readings: ["events.minutes", "callaudio.minutes"], from: "derived" } },
  },
};

function noteText(note: Note, verb: string, withWords: boolean): string {
  let text = `Note “${note.title}” ${verb}`;
  if (note.locked) text += ", locked";
  if (note.trashed) text += ", in Recently Deleted";
  if (withWords && note.excerpt !== "") text += `: ${note.excerpt}${note.excerpt.endsWith("…") ? ` (${count(note.words)} words)` : ""}`;
  return text;
}

function noteOf(source: string, key: string, read: NoteRead, time: Instant): Note {
  const lines = read.text.split("\n");
  const first = lines.findIndex((line) => unmarked(line) !== "");
  const titled = first >= 0 && (unmarked(lines[first]!) === read.title || lines[first]!.trim() === read.title);
  const rest = titled ? lines.slice(first + 1) : lines;
  const after = rest.map((line) => line.trimEnd()).join("\n").replace(/^\n+|\n+$/gu, "");
  const cut = textHead(after, LINE_CHARS);
  return {
    source, key, title: read.title, locked: read.locked, trashed: read.trashed, start_ms: time.start_ms, end_ms: time.end_ms ?? null,
    excerpt: cut.length < after.length ? `${cut.trimEnd()}…` : after,
    words: lines.flatMap((line) => unmarked(line).split(/\s+/u)).filter((word) => word !== "").length,
  };
}

function unmarked(line: string): string {
  return line.replace(MARKER, "").trim();
}

function edited(time: Instant): number {
  return time.end_ms ?? time.start_ms;
}

function at(time: number): Instant {
  return { start_ms: time, precision: "ms" };
}

function isMeeting(content: Json): content is Meeting {
  return isObject(content) && typeof content.product === "string";
}

function parseUnit(unit: string): { product: string; account: string; key: string } | null {
  const colon = unit.indexOf(":");
  const slash = unit.indexOf("/", colon + 1);
  return colon <= 0 || slash < 0 ? null : { product: unit.slice(0, colon), account: unit.slice(colon + 1, slash), key: unit.slice(slash + 1) };
}

function meetingLine(meeting: Meeting): string {
  let text = `Meeting “${meeting.title}”`;
  const named = meeting.people.slice(0, LINE_PEOPLE);
  const more = meeting.people.length - named.length;
  if (named.length > 0) text += ` with ${more > 0 ? `${named.join(", ")} and ${more} more` : named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`}`;
  if (meeting.end_ms !== null) text += `, ${length(Math.round((meeting.end_ms - meeting.start_ms) / 60_000))}`;
  return text;
}

function length(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
